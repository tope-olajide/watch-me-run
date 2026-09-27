import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Environment, RunState, WorldEvent } from "./run-state";
import { initialRunState } from "./run-state";
import type { CharacterId } from "./character-catalog";
import {
  buildPattern,
  coinValueAt,
  difficultyAt,
  environmentPace,
  LANES,
  LANE_COUNT,
  patternGap,
  pickShape,
  speedAt,
  topSpeed,
  type CoinSpawn,
  type Shape,
  type ObstacleKind,
  type ObstacleSpawn,
} from "./pattern-field";
import { roadGrade } from "./road-grade";
import { useWorldTone, type WorldTone } from "../orbis/world-palette";
import { useWorldAlign } from "../orbis/world-align";

const RunnerCharacter = lazy(() => import("./RunnerCharacter"));

const PLAYER_Z = 3;

/**
 * The road is a long strip that dissolves with distance, so the generated Orbis world
 * becomes the horizon instead of being hidden behind a wall of terrain. It scrolls at the
 * same speed as the obstacles and coins, which is what makes the runner read as moving
 * *inside* the generated shot rather than sliding over a static floor.
 */
const ROAD_WIDTH = 10.5;
/** The ground is a short ribbon, not a floor: past about 20 m the generated world is the terrain. */
const ROAD_LENGTH = 46;
const ROAD_NEAR_Z = 16;
const ROAD_CENTER_Z = ROAD_NEAR_Z - ROAD_LENGTH / 2;
const ROAD_TILE_WORLD = 8;
const ROAD_TILES = ROAD_LENGTH / ROAD_TILE_WORLD;

/** Camera widens as the run accelerates so the horizon pushes out with the speed. */
const BASE_FOV = 46;
const MAX_FOV = 58;

/** The camera rig, as the canvas is created: a fixed height looking slightly down at a fixed point. */
const CAMERA_POSITION: [number, number, number] = [0, 3.4, 11.5];
const CAMERA_TARGET: [number, number, number] = [0, 1.5, -22];

/**
 * Where the game's own horizon sits, as a fraction down the frame.
 *
 * The ground plane vanishes at the camera's eye level, so the horizon lies one pitch angle above the
 * camera's forward direction; against a vertical half-field of view that is where it lands on screen.
 * At the base field of view this is 43.3% down the frame and 44.9% at the widest, and the road ribbon
 * dissolves into the generated world at about 50% — so the 44-50% band is the only place the two
 * layers meet. Published as `--game-horizon` for the vertical lock, which has to know the line the
 * generated horizon may not cross.
 */
function gameHorizon(fov: number): number {
  const drop = CAMERA_POSITION[1] - CAMERA_TARGET[1];
  const ahead = CAMERA_POSITION[2] - CAMERA_TARGET[2];
  const pitch = Math.atan2(drop, ahead);
  const ndc = Math.tan(pitch) / Math.tan((fov / 2) * (Math.PI / 180));
  return (1 - ndc) / 2;
}

/**
 * A run begins with the momentum of the dive that started it: a surge that decays into the normal
 * ramp. It is deliberately part of the speed itself rather than a cosmetic effect, so the world's
 * scale, the camera's field of view, the road scroll, and the approaching obstacles all read as
 * one launch — and nothing about the runner's controls changes.
 */
const LAUNCH_BOOST = 3.6;
const LAUNCH_SECONDS = 1.8;

/** Content is generated this far ahead, with a difficulty-scaled gap between patterns. */
const SPAWN_HORIZON = 80;
const CULL_Z = 16;

const JUMP_MS = 650;
const SLIDE_MS = 800;
const STUMBLE_MS = 900;

type PlayerAnimation = "run" | "jump" | "slide" | "stumble";

type RunnerSceneProps = {
  environment: Environment;
  characterId: CharacterId;
  paused: boolean;
  onWorldEvent: (state: RunState, event: WorldEvent) => void;
  /** Throttled run-state feed for HUD readouts, so distance and speed move smoothly. */
  onProgress?: (state: RunState) => void;
  /**
   * Fired on every token with what it actually paid. Deliberately separate from `onWorldEvent`: a
   * coin is not a world event, and routing it through the director would let a pickup steer the
   * generated world.
   */
  onToken?: (value: number) => void;
};

/** Content in flight: a spawn from the field, plus the identity this scene gives it. */
type Obstacle = ObstacleSpawn & { id: number };
type Coin = CoinSpawn & { id: number };

type EnvironmentLook = {
  ambient: string;
  key: string;
  contrast: number;
  base: string;
  grain: string;
  line: string;
  edge: string;
  block: string;
  blockAccent: string;
  gate: string;
  wall: string;
  coin: string;
  coinGlow: string;
};

const environmentLook: Record<Environment, EnvironmentLook> = {
  desert: {
    ambient: "#e6a86f",
    key: "#ffd9a0",
    contrast: 0.9,
    base: "#7d4629",
    grain: "#96603d",
    line: "#ffd489",
    edge: "#edb072",
    block: "#c98a5a",
    blockAccent: "#7d4a2c",
    gate: "#e0b070",
    wall: "#b1743f",
    coin: "#ffd777",
    coinGlow: "#ff9f45",
  },
  city: {
    ambient: "#2b4d78",
    key: "#9fd8ff",
    contrast: 1,
    base: "#182533",
    grain: "#283c4e",
    line: "#51e4ff",
    edge: "#2f7fa8",
    block: "#2b3440",
    blockAccent: "#51e4ff",
    gate: "#51e4ff",
    wall: "#39424f",
    coin: "#8ff2ff",
    coinGlow: "#1fa8d8",
  },
  forest: {
    ambient: "#3d7f6b",
    key: "#c9ffd6",
    contrast: 0.9,
    base: "#173429",
    grain: "#244835",
    line: "#9af29d",
    edge: "#3f7a55",
    block: "#6b4a2f",
    blockAccent: "#3f6b45",
    gate: "#5d8f5a",
    wall: "#4a5a4f",
    coin: "#b6ff9e",
    coinGlow: "#4fd07a",
  },
};

function canvasContext(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");
  return { canvas, context };
}

/** Tiling road surface: material grain, dashed lane separators, and worn outer edges. */
function createRoadPattern(environment: Environment): THREE.CanvasTexture {
  const look = environmentLook[environment];
  const width = 512;
  const height = 256;
  const { canvas, context } = canvasContext(width, height);
  const toTextureX = (worldX: number) => ((worldX + ROAD_WIDTH / 2) / ROAD_WIDTH) * width;

  context.fillStyle = look.base;
  context.fillRect(0, 0, width, height);

  for (let speck = 0; speck < 1500; speck += 1) {
    context.fillStyle = Math.random() > 0.5 ? look.grain : look.base;
    context.globalAlpha = 0.05 + Math.random() * 0.13;
    context.fillRect(
      Math.random() * width,
      Math.random() * height,
      2 + Math.random() * 6,
      1 + Math.random() * 3,
    );
  }
  context.globalAlpha = 1;

  // Two dashed separators mark the three playable lanes.
  context.fillStyle = look.line;
  for (const laneX of [-1.2, 1.2]) {
    for (let dash = 0; dash < 2; dash += 1) {
      context.globalAlpha = 0.72;
      context.fillRect(toTextureX(laneX) - 2, dash * (height / 2) + 10, 4, height / 2 - 26);
    }
  }

  context.fillStyle = look.edge;
  context.globalAlpha = 0.42;
  context.fillRect(toTextureX(-4.7) - 3, 0, 6, height);
  context.fillRect(toTextureX(4.7) - 3, 0, 6, height);
  context.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, ROAD_TILES);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Alpha ramp for the road: solid under the runner, dissolving with distance and toward the
 * edges so the Orbis video supplies the terrain, weather, and horizon.
 */
function createRoadFade(): THREE.CanvasTexture {
  const width = 128;
  const height = 512;
  const { canvas, context } = canvasContext(width, height);
  const image = context.createImageData(width, height);

  // The ribbon is solid under the runner and dissolves within about 20 m, so everything
  // beyond it is genuinely the generated world rather than a surface laid over it.
  const distanceAlpha = (v: number) => {
    if (v <= 0.15) return 1;
    if (v <= 0.4) return 1 - ((v - 0.15) / 0.25) * 0.55;
    if (v <= 0.65) return 0.45 - ((v - 0.4) / 0.25) * 0.33;
    if (v <= 0.85) return 0.12 - ((v - 0.65) / 0.2) * 0.12;
    return 0;
  };

  for (let y = 0; y < height; y += 1) {
    // Textures flip vertically: the canvas top row is v = 1, the far end of the road.
    const v = 1 - y / (height - 1);
    const alongRoad = distanceAlpha(v);
    for (let x = 0; x < width; x += 1) {
      const lateral = Math.abs(x / (width - 1) - 0.5);
      const acrossRoad = lateral <= 0.33 ? 1 : lateral <= 0.48 ? 1 - ((lateral - 0.33) / 0.15) * 0.8 : 0.2;
      const alpha = Math.max(0, Math.min(1, alongRoad * acrossRoad));
      const index = (y * width + x) * 4;
      image.data[index] = 255;
      image.data[index + 1] = Math.round(alpha * 255);
      image.data[index + 2] = 255;
      image.data[index + 3] = 255;
    }
  }

  context.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

let contactShadow: THREE.CanvasTexture | null = null;

/** Soft blob under the runner so the character is planted on the road. */
function contactShadowTexture(): THREE.CanvasTexture {
  if (contactShadow) return contactShadow;
  const size = 128;
  const { canvas, context } = canvasContext(size, size);
  const gradient = context.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(0,0,0,0.72)");
  gradient.addColorStop(0.5, "rgba(0,0,0,0.34)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  contactShadow = new THREE.CanvasTexture(canvas);
  return contactShadow;
}


/* ------------------------------------------------------------------------- presentation */

/**
 * The generated video is a separate DOM layer, so the runner's motion is projected onto it
 * through CSS variables: `--run-speed` scales and pushes the world, `--world-x` adds a small
 * parallax when changing lanes, and `--hit` flashes the frame on impact.
 */
let lastPublish = -1;

function publishWorldMotion(
  environment: Environment,
  speed: number,
  lateral: number,
  hit: number,
  now: number,
  force = false,
) {
  if (!force && now - lastPublish < 0.15) return;
  lastPublish = now;
  const root = document.documentElement;
  // Normalised against this world's own range: the same `--run-speed` means "flat out for here", so
  // the camera, the world's scale, and the road scroll all read the same in a slow world as a fast
  // one instead of quietly telling city players they are crawling.
  const pace = environmentPace[environment];
  const span = topSpeed(environment) - pace.baseSpeed;
  root.style.setProperty("--run-speed", (Math.min(1, Math.max(0, (speed - pace.baseSpeed) / span))).toFixed(3));
  root.style.setProperty("--world-x", lateral.toFixed(3));
  root.style.setProperty("--hit", hit.toFixed(2));
}

/**
 * Subscribes to the world tone itself so a change re-renders the road only, not the whole runner.
 */
function World({ environment, speedRef }: { environment: Environment; speedRef: { current: number } }) {
  const tone: WorldTone = useWorldTone();
  const look = environmentLook[environment];
  const pattern = useMemo(() => createRoadPattern(environment), [environment]);
  const fade = useMemo(() => createRoadFade(), []);
  const grade = useMemo(() => roadGrade(environment, tone), [environment, tone]);

  useEffect(() => () => pattern.dispose(), [pattern]);
  useEffect(() => () => fade.dispose(), [fade]);
  // Published so the grade can be inspected from the console or a screenshot tool.
  useEffect(() => {
    document.documentElement.style.setProperty("--road-grade", grade.scale.toFixed(3));
    document.documentElement.style.setProperty("--road-grade-source", grade.measured ? "frames" : "preset");
  }, [grade]);

  useFrame((_, delta) => {
    pattern.offset.y += (speedRef.current * delta) / ROAD_TILE_WORLD;
  });

  return (
    <>
      {/* Lighting is lifted so the road sits in the same brightness range as the generated
          world instead of reading as a dark sheet laid over it. */}
      <ambientLight intensity={1.45} color={look.ambient} />
      <directionalLight
        castShadow
        position={[5, 11, 9]}
        intensity={2.1 * look.contrast}
        color={look.key}
        shadow-mapSize={[1024, 1024]}
      />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, ROAD_CENTER_Z]} receiveShadow>
        <planeGeometry args={[ROAD_WIDTH, ROAD_LENGTH]} />
        <meshStandardMaterial
          map={pattern}
          alphaMap={fade}
          color={grade.color}
          transparent
          roughness={0.92}
          metalness={0.04}
        />
      </mesh>
    </>
  );
}

/** Per-world obstacle silhouettes: slabs, logs, ruin beams, neon signs, boulders, containers. */
function ObstacleShape({ environment, kind }: { environment: Environment; kind: ObstacleKind }) {
  const look = environmentLook[environment];

  if (kind === "gate") {
    return (
      <group>
        <mesh position={[0, 1.32, 0]} castShadow>
          {environment === "city" ? (
            <boxGeometry args={[1.9, 0.34, 0.42]} />
          ) : (
            <boxGeometry args={[1.7, 0.42, 0.7]} />
          )}
          <meshStandardMaterial
            color={look.gate}
            emissive={look.gate}
            emissiveIntensity={environment === "city" ? 0.9 : 0.35}
            roughness={0.6}
          />
        </mesh>
        {environment !== "city" && (
          <>
            <mesh position={[-0.72, 0.66, 0]} castShadow>
              <boxGeometry args={[0.22, 1.32, 0.36]} />
              <meshStandardMaterial color={look.wall} roughness={0.85} />
            </mesh>
            <mesh position={[0.72, 0.66, 0]} castShadow>
              <boxGeometry args={[0.22, 1.32, 0.36]} />
              <meshStandardMaterial color={look.wall} roughness={0.85} />
            </mesh>
          </>
        )}
      </group>
    );
  }

  if (kind === "wall") {
    if (environment === "forest") {
      return (
        <mesh position={[0, 1.1, 0]} castShadow>
          <icosahedronGeometry args={[1, 0]} />
          <meshStandardMaterial color={look.wall} roughness={0.95} flatShading />
        </mesh>
      );
    }
    return (
      <mesh position={[0, 1.25, 0]} castShadow>
        <boxGeometry args={environment === "desert" ? [0.95, 2.5, 0.75] : [1.45, 2.4, 0.95]} />
        <meshStandardMaterial color={look.wall} roughness={0.75} metalness={environment === "city" ? 0.35 : 0.05} />
      </mesh>
    );
  }

  // Jumpable obstacle.
  if (environment === "forest") {
    return (
      <mesh position={[0, 0.42, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.42, 0.42, 1.9, 12]} />
        <meshStandardMaterial color={look.block} roughness={0.92} />
      </mesh>
    );
  }

  return (
    <group>
      <mesh position={[0, 0.44, 0]} castShadow>
        <boxGeometry args={[1.3, 0.88, 0.9]} />
        <meshStandardMaterial color={look.block} roughness={0.8} metalness={environment === "city" ? 0.3 : 0.05} />
      </mesh>
      <mesh position={[0, 0.92, 0]}>
        <boxGeometry args={[1.34, 0.1, 0.94]} />
        <meshStandardMaterial
          color={look.blockAccent}
          emissive={look.blockAccent}
          emissiveIntensity={environment === "city" ? 0.8 : 0.2}
        />
      </mesh>
    </group>
  );
}

function ObstaclePiece({ obstacle, environment }: { obstacle: Obstacle; environment: Environment }) {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    if (group.current) group.current.position.z = obstacle.z;
  });
  return (
    <group ref={group} position={[LANES[obstacle.lane], 0, obstacle.z]}>
      <ObstacleShape environment={environment} kind={obstacle.kind} />
    </group>
  );
}

function CoinPiece({ coin, environment }: { coin: Coin; environment: Environment }) {
  const group = useRef<THREE.Group>(null);
  const look = environmentLook[environment];

  useFrame(({ clock }, delta) => {
    if (!group.current) return;
    group.current.visible = !coin.collected;
    group.current.position.z = coin.z;
    group.current.position.y = coin.y + Math.sin(clock.elapsedTime * 3 + coin.id) * 0.07;
    group.current.rotation.y += delta * 2.6;
  });

  return (
    <group ref={group} position={[LANES[coin.lane], coin.y, coin.z]}>
      <mesh>
        {environment === "city"
          ? <cylinderGeometry args={[0.26, 0.26, 0.07, 16]} />
          : environment === "forest"
            ? <sphereGeometry args={[0.23, 12, 12]} />
            : <torusGeometry args={[0.26, 0.09, 8, 16]} />}
        <meshStandardMaterial
          color={look.coin}
          emissive={look.coinGlow}
          emissiveIntensity={0.85}
          roughness={0.35}
          metalness={0.4}
        />
      </mesh>
    </group>
  );
}

function Player({
  lane,
  characterId,
  animation,
  speedRef,
}: {
  lane: number;
  characterId: CharacterId;
  animation: PlayerAnimation;
  speedRef: { current: number };
}) {
  const group = useRef<THREE.Group>(null);
  const shadow = useRef<THREE.Mesh>(null);

  useFrame(({ clock }, delta) => {
    if (!group.current) return;
    group.current.position.x = THREE.MathUtils.damp(group.current.position.x, LANES[lane] ?? 0, 12, delta);
    group.current.position.y = THREE.MathUtils.damp(
      group.current.position.y,
      animation === "jump" ? 1.3 : animation === "slide" ? -0.3 : 0,
      14,
      delta,
    );
    group.current.rotation.z = animation === "stumble"
      ? THREE.MathUtils.damp(group.current.rotation.z, 0.22, 9, delta)
      : Math.sin(clock.elapsedTime * 12) * 0.025;

    if (shadow.current) {
      // The blob stays on the road while the character leaves it, and spreads as it lifts.
      const lift = Math.max(0, group.current.position.y);
      shadow.current.position.y = 0.02 - group.current.position.y;
      const material = shadow.current.material as THREE.MeshBasicMaterial;
      material.opacity = THREE.MathUtils.clamp(0.7 - lift * 0.42, 0.1, 0.7);
      shadow.current.scale.setScalar(1 + lift * 0.22);
    }
  });

  return (
    <group ref={group} position={[0, 0, PLAYER_Z]}>
      <mesh ref={shadow} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} renderOrder={1}>
        <planeGeometry args={[1.8, 2.3]} />
        <meshBasicMaterial map={contactShadowTexture()} transparent depthWrite={false} opacity={0.7} />
      </mesh>
      <Suspense fallback={<PlayerPlaceholder animation={animation} />}>
        <RunnerCharacter characterId={characterId} state={animation} speedRef={speedRef} />
      </Suspense>
    </group>
  );
}

function PlayerPlaceholder({ animation }: { animation: PlayerAnimation }) {
  return (
    <mesh
      castShadow
      position={[0, animation === "jump" ? 1.3 : animation === "slide" ? 0.35 : 0.85, 0]}
      scale={[0.55, animation === "slide" ? 0.55 : 1, 0.4]}
    >
      <capsuleGeometry args={[0.38, 0.85, 8, 16]} />
      <meshStandardMaterial color="#f4f0e8" roughness={0.62} />
    </mesh>
  );
}

/* ---------------------------------------------------------------------------- simulation */

function RunnerSimulation({ environment, characterId, paused, onWorldEvent, onProgress, onToken }: RunnerSceneProps) {
  const [lane, setLane] = useState(1);
  const [jumping, setJumping] = useState(false);
  const [sliding, setSliding] = useState(false);
  const [stumbling, setStumbling] = useState(false);
  // The simulation is the source of truth and lives in refs: mirroring it through React state
  // every frame is both wasteful and, when it lags, wrong — distance used to advance by a
  // single frame's worth per state update, and obstacles visibly jumped once per second.
  const runState = useRef<RunState>(initialRunState(environment));
  const obstacles = useRef<Obstacle[]>([]);
  const coins = useRef<Coin[]>([]);
  const frontier = useRef(-6);
  /**
   * The shape of the chunk about to be built, chosen one step early and held until it is built.
   *
   * It has to outlive the frame. A frame usually places one chunk, so a shape picked *inside* the
   * frame and used only to size the gap would be thrown away by the next frame's fresh pick — and
   * the lead-in the gap reserved would then belong to a shape that is never built, which is exactly
   * how a two-lane row ended up with a one-lane lead-in.
   */
  const upcoming = useRef<Shape | undefined>(undefined);
  const nextId = useRef(1);
  const lastEventDistance = useRef(0);
  const lastEventSpeed = useRef(environmentPace[environment].baseSpeed);
  const lastComboMilestone = useRef(0);
  const lastProgress = useRef(-1);
  const speedRef = useRef(environmentPace[environment].baseSpeed);
  const lateral = useRef(0);
  const impact = useRef(0);
  /** Set on impact and decayed over about a second: the runner visibly recovers. */
  const stumbleSlow = useRef(0);
  /** Seconds since this run began, for the launch surge. */
  const launch = useRef(0);
  const [worldVersion, setWorldVersion] = useState(0);
  const timers = useRef<number[]>([]);

  const scheduleReset = useCallback((reset: () => void, ms: number) => {
    const timer = window.setTimeout(() => {
      timers.current = timers.current.filter((id) => id !== timer);
      reset();
    }, ms);
    timers.current.push(timer);
  }, []);

  useEffect(() => () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
    publishWorldMotion(environment, environmentPace[environment].baseSpeed, 0, 0, 0, true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (event.key === "ArrowLeft" || key === "a") {
        setLane((value) => Math.max(0, value - 1));
      }
      if (event.key === "ArrowRight" || key === "d") {
        setLane((value) => Math.min(LANE_COUNT - 1, value + 1));
      }
      if (event.key === "ArrowUp" || key === "w") {
        setJumping(true);
        setSliding(false);
        runState.current.jumps += 1;
        scheduleReset(() => setJumping(false), JUMP_MS);
      }
      if (event.key === "ArrowDown" || key === "s") {
        setSliding(true);
        setJumping(false);
        runState.current.slides += 1;
        scheduleReset(() => setSliding(false), SLIDE_MS);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [scheduleReset]);

  useFrame(({ camera, clock }, delta) => {
    if (paused) {
      speedRef.current = environmentPace[environment].baseSpeed;
      publishWorldMotion(environment, speedRef.current, lateral.current, impact.current, clock.elapsedTime, true);
      return;
    }

    const state = runState.current;
    const difficulty = difficultyAt(environment, state.distance);
    const distance = state.distance + delta * state.speed;
    if (stumbleSlow.current > 0) stumbleSlow.current = Math.max(0, stumbleSlow.current - delta * 1.1);
    launch.current = Math.min(LAUNCH_SECONDS, launch.current + delta);
    const surge = (1 - launch.current / LAUNCH_SECONDS) ** 1.7 * LAUNCH_BOOST;
    const cruise = speedAt(environment, distance);
    const speed = (cruise + surge) * (1 - stumbleSlow.current * 0.32);
    speedRef.current = speed;

    state.distance = distance;
    state.speed = speed;
    state.score += delta * 12;

    // Keep the generated world and the runner moving together: the camera opens up as the
    // run accelerates, and the video layer scales with the same value.
    lateral.current = THREE.MathUtils.damp(lateral.current, (LANES[lane] ?? 0) / 2.4, 8, delta);
    impact.current = Math.max(0, impact.current - delta * 2.2);

    if (impact.current > 0.01) {
      camera.position.set(
        Math.sin(clock.elapsedTime * 48) * impact.current * 0.07,
        3.4 - impact.current * 0.3,
        11.5 + impact.current * 0.25,
      );
    } else {
      camera.position.set(0, 3.4, 11.5);
    }

    publishWorldMotion(environment, speed, lateral.current, impact.current, clock.elapsedTime);

    // The field of view opens against this world's top speed for the same reason the variable does.
    const perspective = camera as THREE.PerspectiveCamera;
    const targetFov = BASE_FOV + Math.min(speed / topSpeed(environment), 1) * (MAX_FOV - BASE_FOV);
    if (Math.abs(perspective.fov - targetFov) > 0.01) {
      perspective.fov = THREE.MathUtils.damp(perspective.fov, targetFov, 2, delta);
      perspective.updateProjectionMatrix();
      // The generated horizon is locked against this line, so it is published whenever it moves.
      document.documentElement.style.setProperty(
        "--game-horizon",
        gameHorizon(perspective.fov).toFixed(4),
      );
    }

    /* ---- spawn and scroll the content field ---- */
    frontier.current += delta * speed;
    let spawned = false;
    let guard = 0;
    // The chunk that can ask for two lane changes needs a longer lead-in than the gap alone would
    // give it, and its shape has to be known before it is placed because the gap is what decides
    // where it lands — so it was picked when the gap before it was sized, last frame at the latest.
    if (!upcoming.current) upcoming.current = pickShape(difficulty);
    while (frontier.current > -SPAWN_HORIZON && guard < 8) {
      guard += 1;
      const pattern = buildPattern(environment, difficulty, frontier.current, upcoming.current);
      obstacles.current.push(...pattern.obstacles.map((item) => ({ ...item, id: nextId.current++ })));
      coins.current.push(...pattern.coins.map((item) => ({ ...item, id: nextId.current++ })));
      // The next shape is picked here rather than on the next pass, so the gap this chunk leaves can
      // be sized by the lead-in that one will need. Only a chunk that can ask for two lane changes
      // pays for it; everything else keeps the pacing gap.
      upcoming.current = pickShape(difficulty);
      // The gap is sized by what the chunk just placed actually asked for: a pattern nobody had to
      // react to is followed more closely, which is what closes the dead air between decisions.
      frontier.current -= pattern.span + patternGap(environment, difficulty, pattern, upcoming.current);
      spawned = true;
    }
    if (spawned) setWorldVersion((version) => version + 1);

    /* ---- move, resolve, and cull ---- */
    let changed = spawned;
    const playerLane = lane;

    for (const obstacle of obstacles.current) {
      obstacle.z += delta * speed;
      if (obstacle.passed || obstacle.z <= PLAYER_Z) continue;

      obstacle.passed = true;
      const sameLane = obstacle.lane === playerLane;
      const evaded = obstacle.kind === "block" ? jumping : obstacle.kind === "gate" ? sliding : false;
      const adjacent = Math.abs(obstacle.lane - playerLane) === 1;

      if (sameLane && !evaded) {
        // Hit: stumble animation, camera shove, and a short recovery where the run slows.
        state.damage += 1;
        state.stumbles += 1;
        state.combo = 0;
        state.dangerLevel = Math.min(1, state.damage / 3);
        stumbleSlow.current = 1;
        impact.current = 1;
        setStumbling(true);
        scheduleReset(() => setStumbling(false), STUMBLE_MS);
        publishWorldMotion(environment, speed, lateral.current, 1, clock.elapsedTime, true);
        onWorldEvent({ ...state, speed }, { type: "damage_taken", amount: 1 });
        continue;
      }

      if (sameLane || adjacent) {
        state.nearMisses += 1;
        state.combo += 1;
        onWorldEvent({ ...state, speed }, { type: "near_miss", obstacle: obstacle.kind });
      }
    }

    for (const coin of coins.current) {
      coin.z += delta * speed;
      if (coin.collected) continue;
      const inLane = coin.lane === playerLane;
      const atPlayer = coin.z > PLAYER_Z - 0.8 && coin.z < PLAYER_Z + 1.4;
      if (!inLane || !atPlayer) continue;
      // High coins are placed on jump arcs, so they have to be caught in the air.
      if (coin.y > 1.7 && !jumping) continue;
      coin.collected = true;
      state.coins += 1;
      state.combo += 1;
      // Tokens pay more the deeper the run goes, so the back half rewards reaching it (see
      // `coinValueAt`). Density is flat on purpose; this is the reward half of the curve.
      const tokenValue = coinValueAt(environment, distance);
      state.score += tokenValue;
      onToken?.(tokenValue);
      changed = true;

      const milestone = Math.floor(state.coins / 10);
      if (milestone > lastComboMilestone.current) {
        lastComboMilestone.current = milestone;
        onWorldEvent({ ...state, speed }, { type: "combo_milestone", combo: state.combo });
      }
    }

    const beforeObstacles = obstacles.current.length;
    const beforeCoins = coins.current.length;
    obstacles.current = obstacles.current.filter((obstacle) => obstacle.z < CULL_Z);
    coins.current = coins.current.filter((coin) => coin.z < CULL_Z);
    if (obstacles.current.length !== beforeObstacles || coins.current.length !== beforeCoins) {
      changed = true;
    }
    if (changed) setWorldVersion((version) => version + 1);

    /* ---- feed the HUD and the Orbis Director ---- */
    state.playerStyle =
      state.dangerLevel > 0.6
        ? "aggressive"
        : state.combo >= 12
          ? "reckless"
          : state.nearMisses >= 6 && state.damage === 0
            ? "precise"
            : "explorer";

    if (clock.elapsedTime - lastProgress.current > 0.2) {
      lastProgress.current = clock.elapsedTime;
      onProgress?.({ ...state });
    }

    if (Math.floor(distance / 50) > Math.floor(lastEventDistance.current / 50)) {
      lastEventDistance.current = distance;
      onWorldEvent({ ...state }, { type: "distance_milestone", distance });
    }

    if (Math.floor(speed) > Math.floor(lastEventSpeed.current)) {
      lastEventSpeed.current = speed;
      if (Math.floor(speed) % 2 === 0) onWorldEvent({ ...state }, { type: "speed_milestone", speed });
    }
  });

  const animation: PlayerAnimation = stumbling ? "stumble" : jumping ? "jump" : sliding ? "slide" : "run";

  return (
    <>
      <World environment={environment} speedRef={speedRef} />
      <Player lane={lane} characterId={characterId} animation={animation} speedRef={speedRef} />
      {/* The name carries the world version so a spawn or cull re-renders the list without
          remounting the pieces that are already in flight. */}
      <group name={`world-${worldVersion}`}>
        {obstacles.current.map((obstacle) => (
          <ObstaclePiece key={obstacle.id} obstacle={obstacle} environment={environment} />
        ))}
        {coins.current.map((coin) => (
          <CoinPiece key={coin.id} coin={coin} environment={environment} />
        ))}
      </group>
    </>
  );
}

export default function RunnerScene(props: RunnerSceneProps) {
  // The generated world is held to this camera's horizon for as long as the run is on screen.
  useWorldAlign();

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      gl={{ alpha: true, antialias: true }}
      camera={{ position: CAMERA_POSITION, fov: BASE_FOV }}
      onCreated={({ camera }) => camera.lookAt(...CAMERA_TARGET)}
    >
      <RunnerSimulation {...props} />
    </Canvas>
  );
}
