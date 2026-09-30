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
import { environmentLook } from "./world-look";
import { apronField, apronHeight, sampleApron, type ApronField, type ApronSample } from "./apron";
import {
  AUTHORED_METRICS,
  buildRoadsideProps,
  propMaterial,
  type PropId,
  type PropKind,
  type PropMetrics,
} from "./roadside-props";
import { roadsideModels, type RoadsideModel } from "./roadside-models";
import { createPosterArt, planRoadside, roadsideSink, roadsideTaper, roadsideZ } from "./roadside";
import { worldFrameCanvas, worldFrameRevision } from "../orbis/world-frame";
import { useWorldTone, type WorldTone } from "../orbis/world-palette";
import { useWorldAlign } from "../orbis/world-align";

const RunnerCharacter = lazy(() => import("./RunnerCharacter"));

const PLAYER_Z = 3;

/**
 * The road is a long strip that dissolves into local ground with distance; the Orbis world stays
 * visible as the distant vista above that terrain. The road scrolls at the same speed as the
 * obstacles and coins, so the runner reads as moving through the world rather than sliding over a
 * static floor.
 */
const ROAD_WIDTH = 10.5;
/**
 * The marked road is a ribbon over a wider game-owned terrain surface.
 *
 * 56 m is seven whole 8 m tiles, so the dash pattern closes on the far edge rather than being cut
 * mid-tile, and the ribbon now reaches about 8 m further toward the horizon than the 46 m it
 * replaced — road the runner can see ahead of them instead of the end of a strip. The fade is a
 * proportion of this length, so the extra metres lengthen the blend with the world rather than
 * moving it.
 */
const ROAD_LENGTH = 56;
const ROAD_NEAR_Z = 16;
const ROAD_CENTER_Z = ROAD_NEAR_Z - ROAD_LENGTH / 2;
const ROAD_TILE_WORLD = 8;
const ROAD_TILES = ROAD_LENGTH / ROAD_TILE_WORLD;

/**
 * The local ground: a low, gently rolling apron that reaches back under the camera and dissolves
 * into the generated vista well before the horizon.
 *
 * It is deliberately short and shallow. Fading it linearly in world depth put almost all of the fade
 * into the handful of screen rows just under the horizon — across 350 m the blend covered well under
 * 1% of the frame — so the apron met the video as a hard seam and read as a flat slab laid over it
 * instead of ground the runner is moving across. The depths below instead place the fade where the
 * eye sees it: solid under the runner, half gone by mid-frame, and clear of the generated landscape
 * by the time the horizon band arrives. The banks are kept under 2 m for the same reason — anything
 * taller rises into frame at the horizon and walls the world off.
 */
const TERRAIN_WIDTH = 360;
const TERRAIN_NEAR_Z = 16;
const TERRAIN_LENGTH = 90;
const TERRAIN_SEGMENTS_X = 144;
const TERRAIN_SEGMENTS_Z = 90;
/** Depth over which the apron dissolves: solid under the runner, gone before the horizon band. */
const TERRAIN_FADE_START = 0.26;
const TERRAIN_FADE_END = 0.78;
const TERRAIN_ROAD_SHOULDER = ROAD_WIDTH / 2 + 0.25;

/**
 * The ground for one world.
 *
 * Built from the road's own shoulder, in one place, because two callers need it: the apron mesh, and
 * the props standing on it. Two calls still describe the same ground — the field is a value, and this
 * is the only place the shoulder it is built from comes from.
 */
function worldApron(environment: Environment): ApronField {
  return apronField(environment, TERRAIN_ROAD_SHOULDER);
}
/**
 * What the apron is made of, per world.
 *
 * One pattern for all three was the first version, and it read as one material for all three: the
 * same mottling at the same scale under a dune, a paving slab and a forest floor. The ground of each
 * world differs in two ways that can be drawn — how large one tile of it is in world metres, and how
 * hard that tile is inked — so those are the numbers here rather than a single pair of constants.
 */
type TerrainDetail = {
  /**
   * World metres one tile of the apron's mottling spans before it repeats.
   *
   * This is also its scroll rate, and the apron is the largest surface under the runner, so a fixed
   * pattern there reads as a sheet being slid over the world however fast the ribbon moves: the road
   * and the obstacles travel and the ground they are on does not. It scrolls a whole tile per the
   * metres the run has covered, exactly as the ribbon does, so the two surfaces carry the same ground
   * speed rather than drifting into each other — which is why a smaller tile here means finer detail
   * and not slower ground.
   */
  tile: number;
  /**
   * How hard the apron's mottling is inked, as a multiplier on the alphas it is drawn with.
   *
   * The pattern went in at a tenth of an alpha, which measures out at about 1.5 luma of variation
   * across the apron: at the angle that ground is seen from that is a flat tint, so the surface read
   * as a sheet and, once it started scrolling, had nothing visible to scroll. This is the number to
   * move to make the ground plainer or busier; at 1 the apron is the near-flat tint it used to be.
   *
   * It multiplies a *drawing*, so it saturates: the grain's alphas run 0.05-0.21 and past about 4 the
   * whole range is clamped to the 0.6 ceiling, which flattens the variation between one speck and the
   * next instead of busying the ground. A busier ground therefore has to come from more marks.
   */
  ink: number;
  /** Broad blotches per tile: the low-frequency variation that reads as uneven ground at a distance. */
  blotches: number;
  /** Speckles per tile: the grain the eye sees at the scale the apron is actually looked at. */
  specks: number;
};

/**
 * The desert is the one that was measured, so it is the baseline the other two are set against rather
 * than a guess: 26 broad blotches and 2400 specks at `ink: 4` measure out at 3.8 mean |luma| of
 * variation across the apron with 22% of it moving between frames, which is what stopped the ground
 * reading as a sheet (see the README). Its tile is the largest of the three because wind-blown sand
 * is smooth — the variation is broad and soft, and a finer tile would put grain on a dune.
 *
 * A darker ground measures out at *less* luma for the same ink, and the city and the forest are both
 * far darker than the desert — partly in their colours, mostly in how they are lit — so both are
 * inked slightly harder than it is. That is the whole of the compensation the pattern can make: past
 * the ceiling above, ink stops buying contrast, and the rest has to come from more marks.
 *
 * The tiles are kept within a couple of metres of the desert's rather than taken as fine as each
 * material could be. Finer is what a hard surface wants — paving and asphalt is many small edges, not
 * broad patches — but the apron is seen at a distance and grain is the first thing the mip chain
 * eats: a tile fine enough to read as paving on a slab is at a mip level where the ground has been
 * averaged back into the colour it was meant to vary. What extra busyness the city gets therefore
 * comes from marks — 20 blotches and 3200 specks a tile against the desert's 26 and 2400 — and the
 * forest floor, litter and moss, clumpier than paving and coarser than sand, keeps the most broad
 * blotches of the three at 34.
 *
 * These are chosen from what the materials are and what survives being looked at, not fitted to a
 * number. Fitting was tried: the obvious metric, how much the shoulder band varies within one frame
 * relative to its own mean, cannot carry it, because the terrain grade adapts to the frames and the
 * roadside puts different pieces under the camera every run — the *unchanged* desert's own band moved
 * by 38% between two runs of identical code.
 */
const TERRAIN_DETAIL: Record<Environment, TerrainDetail> = {
  desert: { tile: 14, ink: 4, blotches: 26, specks: 2400 },
  city: { tile: 11, ink: 4.2, blotches: 20, specks: 3200 },
  forest: { tile: 12, ink: 4.2, blotches: 34, specks: 3000 },
};

/**
 * A smooth, static height field keeps the playable corridor level while shaping terrain at its sides.
 *
 * The geometry itself does not travel — only the surface detail on it does (see the pattern below).
 * The fade that dissolves the apron is anchored to these depths, so sliding the mesh would drag the
 * blended end of the ground up into frame; scrolling the mottling over a fixed height field is what
 * shows the miles passing, and the banks have no along-Z features at their scale to give the
 * stillness away.
 */
function createTerrainGeometry(environment: Environment): THREE.BufferGeometry {
  const look = environmentLook[environment];
  const rowSize = TERRAIN_SEGMENTS_X + 1;
  const vertexCount = rowSize * (TERRAIN_SEGMENTS_Z + 1);
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint16Array(TERRAIN_SEGMENTS_X * TERRAIN_SEGMENTS_Z * 6);
  const groundColor = new THREE.Color(look.base);
  const bankColor = new THREE.Color(look.grain);
  const color = new THREE.Color();
  // The same field the roadside stands on, so the two cannot end up describing different grounds.
  const field = worldApron(environment);
  const sample: ApronSample = { height: 0, lateral: 0, undulation: 0 };

  for (let row = 0; row <= TERRAIN_SEGMENTS_Z; row += 1) {
    const depth = row / TERRAIN_SEGMENTS_Z;
    const z = TERRAIN_NEAR_Z - depth * TERRAIN_LENGTH;

    for (let column = 0; column <= TERRAIN_SEGMENTS_X; column += 1) {
      const across = column / TERRAIN_SEGMENTS_X;
      const x = (across - 0.5) * TERRAIN_WIDTH;
      const { height, lateral, undulation } = sampleApron(field, x, z, sample);
      const vertex = row * rowSize + column;
      const positionIndex = vertex * 3;
      const uvIndex = vertex * 2;

      positions[positionIndex] = x;
      positions[positionIndex + 1] = height;
      positions[positionIndex + 2] = z;
      uvs[uvIndex] = across;
      uvs[uvIndex + 1] = depth;

      const tint = Math.min(0.42, 0.08 + lateral * 0.25 + Math.max(0, undulation) * 0.04);
      color.copy(groundColor).lerp(bankColor, tint);
      colors[positionIndex] = color.r;
      colors[positionIndex + 1] = color.g;
      colors[positionIndex + 2] = color.b;
    }
  }

  let index = 0;
  for (let row = 0; row < TERRAIN_SEGMENTS_Z; row += 1) {
    for (let column = 0; column < TERRAIN_SEGMENTS_X; column += 1) {
      const a = row * rowSize + column;
      const b = a + 1;
      const c = a + rowSize;
      const d = c + 1;
      indices[index++] = a;
      indices[index++] = b;
      indices[index++] = c;
      indices[index++] = b;
      indices[index++] = d;
      indices[index++] = c;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Detail for the apron: soft mottling at two scales, drawn in grey so it multiplies the per-vertex
 * world colour rather than replacing it. Without it the apron is a single flat tint, which is what
 * made it read as a sheet laid over the world rather than as ground.
 *
 * Drawn per world (see TERRAIN_DETAIL), so the ground under a dune is not the ground under a paving
 * slab: the same two scales of mottling, at this world's tile size and pressed this hard.
 */
function createTerrainPattern(environment: Environment): THREE.CanvasTexture {
  const detail = TERRAIN_DETAIL[environment];
  const size = 256;
  const { canvas, context } = canvasContext(size, size);
  // The alphas below are the drawing's, turned up by this world's ink and capped so no setting can
  // put hard blotches on the ground.
  const ink = (alpha: number) => Math.min(0.6, alpha * detail.ink);
  const blotchInk = ink(0.1);

  context.fillStyle = "#c4c4c4";
  context.fillRect(0, 0, size, size);

  // Broad blotches first: the low-frequency variation that reads as uneven ground at a distance.
  for (let blotch = 0; blotch < detail.blotches; blotch += 1) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const radius = 18 + Math.random() * 46;
    const shade = Math.random() > 0.5 ? 255 : 140;
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(${shade},${shade},${shade},${blotchInk})`);
    gradient.addColorStop(1, `rgba(${shade},${shade},${shade},0)`);
    context.fillStyle = gradient;
    context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  // Then grain, at the scale the apron is actually seen at.
  for (let speck = 0; speck < detail.specks; speck += 1) {
    const shade = Math.random() > 0.5 ? 255 : 120;
    context.fillStyle = `rgba(${shade},${shade},${shade},${ink(0.05 + Math.random() * 0.16)})`;
    context.fillRect(
      Math.random() * size,
      Math.random() * size,
      1 + Math.random() * 4,
      1 + Math.random() * 3,
    );
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(TERRAIN_WIDTH / detail.tile, TERRAIN_LENGTH / detail.tile);
  texture.anisotropy = 4;
  return texture;
}

/**
 * Alpha ramp for the apron: opaque under the runner, transparent once the generated landscape should
 * be showing through, and eased across the band in between so the two layers meet without a line.
 */
function createTerrainFade(): THREE.CanvasTexture {
  const width = 2;
  const height = 256;
  const { canvas, context } = canvasContext(width, height);
  const image = context.createImageData(width, height);

  for (let y = 0; y < height; y += 1) {
    // Canvas textures flip vertically: the top row is v = 1, the far end of the terrain.
    const depth = 1 - y / (height - 1);
    const progress = THREE.MathUtils.clamp(
      (depth - TERRAIN_FADE_START) / (TERRAIN_FADE_END - TERRAIN_FADE_START),
      0,
      1,
    );
    const eased = progress * progress * (3 - 2 * progress);
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      image.data[offset] = 255;
      image.data[offset + 1] = Math.round((1 - eased) * 255);
      image.data[offset + 2] = 255;
      image.data[offset + 3] = 255;
    }
  }

  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/** Camera widens as the run accelerates so the horizon pushes out with the speed. */
const BASE_FOV = 46;
const MAX_FOV = 58;

/** The camera rig, as the canvas is created: a fixed height looking slightly down at a fixed point. */
const CAMERA_POSITION: [number, number, number] = [0, 3.4, 11.5];
const CAMERA_TARGET: [number, number, number] = [0, 1.5, -22];
/**
 * How much of a lane change the camera takes with the runner, 0 being the old fixed rig and 1 a
 * camera welded to the runner's shoulder.
 *
 * A lane change is 2.4 m of sideways travel, and the camera was pinned to the middle of the road, so
 * all of it showed up as the runner sliding across a frame whose ground never moved: the character
 * crossed a quarter of the screen while the world under it stayed put, which is what makes the
 * movement read as unreal. Moving the camera takes half of the travel out of the runner's screen
 * position and gives it to the ground instead — the camera slides one way, the road, apron, and
 * obstacles hold still in world space, so they sweep the other way across the frame, and the two
 * halves still add up to exactly the runner's real 2.4 m of step.
 *
 * The ground is translated, not re-aimed: the camera keeps the rig's fixed orientation, so this is a
 * lateral pan with the perspective shear a real step has (near ground swings wide, far ground barely
 * moves) rather than a rotation. At 0 the runner skates over a frozen world again; at 1 the runner is
 * pinned to the centre of the frame and only the world reads the lane change.
 */
const CAMERA_LATERAL_FOLLOW = 0.5;

/**
 * Where the game's own horizon sits, as a fraction down the frame.
 *
 * The ground plane vanishes at the camera's eye level, so the horizon lies one pitch angle above the
 * camera's forward direction; against a vertical half-field of view that is where it lands on screen.
 * At the base field of view this is 43.3% down the frame and 44.9% at the widest. The local apron
 * dissolves below this line rather than reaching it, so the band belongs to the generated landscape.
 * Published as `--game-horizon` for the vertical lock, which keeps the generated horizon above it.
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
 * Alpha ramp for the road: solid under the runner, then blending into the local terrain with
 * distance and toward the edges.
 */
function createRoadFade(): THREE.CanvasTexture {
  const width = 128;
  const height = 512;
  const { canvas, context } = canvasContext(width, height);
  const image = context.createImageData(width, height);

  // The ribbon is solid under the runner and dissolves beyond it so the terrain apron reads through.
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
 * Subscribes to the world tone so the road can be graded without re-rendering the runner.
 */
function World({ environment, speedRef }: { environment: Environment; speedRef: { current: number } }) {
  const tone: WorldTone = useWorldTone();
  const look = environmentLook[environment];
  const pattern = useMemo(() => createRoadPattern(environment), [environment]);
  const fade = useMemo(() => createRoadFade(), []);
  const terrain = useMemo(() => createTerrainGeometry(environment), [environment]);
  const terrainDetail = TERRAIN_DETAIL[environment];
  const terrainPattern = useMemo(() => createTerrainPattern(environment), [environment]);
  const terrainFade = useMemo(() => createTerrainFade(), []);
  const grade = useMemo(() => roadGrade(environment, tone), [environment, tone]);
  // The apron is a second surface over the same generated world, so it is graded from the same
  // measurement as the ribbon. Grey, not tinted: its per-vertex colours are already this world's, and
  // a hue on top of them would be this module disagreeing with `environmentLook` about the world.
  const terrainColor = useMemo<[number, number, number]>(
    () => [grade.terrain, grade.terrain, grade.terrain],
    [grade.terrain],
  );

  useEffect(() => () => pattern.dispose(), [pattern]);
  useEffect(() => () => fade.dispose(), [fade]);
  useEffect(() => () => terrain.dispose(), [terrain]);
  useEffect(() => () => terrainPattern.dispose(), [terrainPattern]);
  useEffect(() => () => terrainFade.dispose(), [terrainFade]);
  // Published so the grade can be inspected from the console or a screenshot tool.
  useEffect(() => {
    document.documentElement.style.setProperty("--road-grade", grade.scale.toFixed(3));
    document.documentElement.style.setProperty("--road-grade-source", grade.measured ? "frames" : "preset");
    document.documentElement.style.setProperty("--terrain-grade", grade.terrain.toFixed(3));
    // What this world's apron was actually drawn with: the mottling is generated per environment, so
    // "which tile did the city get" is a question only the applying code can answer.
    document.documentElement.style.setProperty("--terrain-tile", String(terrainDetail.tile));
    document.documentElement.style.setProperty("--terrain-ink", String(terrainDetail.ink));
  }, [grade, terrainDetail]);

  useFrame((_, delta) => {
    // Each surface is scrolled one tile per `speed * delta` metres, divided by the world size of its
    // own tile, so the two carry the same ground speed despite repeating at different scales.
    pattern.offset.y += (speedRef.current * delta) / ROAD_TILE_WORLD;
    // Only the colour map scrolls. The alpha map is the depth fade and stays where the world put it,
    // which is what lets the apron be redrawn under the runner without the fade leaving its depth.
    terrainPattern.offset.y += (speedRef.current * delta) / terrainDetail.tile;
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
      <mesh geometry={terrain} renderOrder={0} receiveShadow>
        <meshStandardMaterial
          map={terrainPattern}
          alphaMap={terrainFade}
          color={terrainColor}
          transparent
          depthWrite={false}
          vertexColors
          roughness={0.98}
          metalness={0}
        />
      </mesh>
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

/**
 * The roadside: the props that line the run, and the lit panels on them.
 *
 * One instanced mesh per prop kind, plus one for the panels — five to seven draw calls for a whole
 * world's scenery, whatever it decides to put beside the road, because a kind that appears twice in
 * a plan is still one geometry and one material. The layout is fixed (see `planRoadside`); this
 * component only moves it. Each piece lives at a fixed offset in a repeating cycle of Z, and the
 * cycle is wrapped by the distance travelled, so a piece leaving the far end has already reappeared
 * behind the runner: nothing spawns, nothing is culled, and no React state changes per frame.
 *
 * Two things about a prop are decided here rather than in the plan, because they are properties of the
 * ground rather than of the layout. One is where the ground *is*: every piece is put on the apron's
 * own height field (`src/game/apron`) — the same one the terrain mesh is built from — so nothing
 * hovers over the surface it is standing on, even where the banks climb to their full height. The
 * other is depth: a piece is set a small fraction of its own height into the ground, which is what
 * keeps a boulder or a kerb from reading as balanced on a point.
 *
 * The panels are the interesting half. Their picture is a frame of the live generated world, sampled
 * out of the SDK's own video by `src/orbis/world-frame`, so the roadside wears the place the player
 * is running through and a change of world repaints it. Until there is a world to show — the opening
 * seconds, a run in local world mode — they carry `createPosterArt`'s abstract panel for that world,
 * because a lit panel with nothing on it is a black rectangle.
 */
function Roadside({ environment, speedRef }: { environment: Environment; speedRef: { current: number } }) {
  const apron = useMemo(() => worldApron(environment), [environment]);
  const propPaint = useMemo(() => propMaterial(environment), [environment]);
  const art = useMemo(() => createPosterArt(environment), [environment]);
  // `null` until the world's packs have been read, which is what the plan waits for: a prop's size is
  // measured off its geometry, and a plan cannot be laid out around a prop whose size is not known yet.
  const [models, setModels] = useState<RoadsideModel[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setModels(null);
    roadsideModels(environment).then((loaded) => {
      if (!cancelled) setModels(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [environment]);

  /**
   * Everything this world can stand beside the road: what it bought, and what the game draws itself.
   *
   * One map for both, because the layout asks one question of a prop — how much ground does it take
   * up — and both answer it the same way. A world whose packs did not load simply has fewer entries,
   * and its rows fall back to the shapes they were drawn with (see `planRoadside`).
   */
  const catalog = useMemo(() => {
    const metrics = new Map<PropId, PropMetrics>(Object.entries(AUTHORED_METRICS));
    for (const model of models ?? []) metrics.set(model.id, model.metrics);
    return metrics;
  }, [models]);

  const plan = useMemo(() => planRoadside(environment, catalog), [environment, catalog]);

  // Only the hand-built kinds this plan actually uses: nothing is built that no run will draw.
  const authored = useMemo(
    () =>
      buildRoadsideProps(
        environment,
        [...plan.props.keys()].filter((id) => id in AUTHORED_METRICS) as PropKind[],
      ),
    [environment, plan],
  );

  /** What to draw for every prop in the plan: a hand-built kind is one part, a model may be several. */
  const drawable = useMemo(() => {
    const parts = new Map<PropId, { geometry: THREE.BufferGeometry; material: THREE.Material }[]>();
    for (const id of plan.props.keys()) {
      const built = authored.get(id);
      if (built) parts.set(id, [{ geometry: built, material: propPaint }]);
      else {
        const model = (models ?? []).find((entry) => entry.id === id);
        if (model) parts.set(id, model.parts);
      }
    }
    return parts;
  }, [plan, authored, models, propPaint]);
  const fallback = useMemo(() => {
    const texture = new THREE.CanvasTexture(art);
    texture.colorSpace = THREE.SRGBColorSpace;
    // The middle band of the frame rather than the whole 16:9 picture: a panel is wider than it is
    // tall, and the part of a generated world worth putting on one is the horizon it holds, which
    // sits there.
    texture.repeat.set(1, 0.82);
    texture.offset.set(0, 0.09);
    return texture;
  }, [art]);
  const panelMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: fallback,
        transparent: true,
        opacity: 0.96,
        depthWrite: false,
        // Panels are signage: they should read as lit even in a world lit like the desert.
        toneMapped: false,
      }),
    [fallback],
  );
  const panelGeometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  const group = useRef<THREE.Group>(null);
  // One prop can be several meshes — a tree is a trunk and a canopy — and they all carry the same
  // instances, so a prop is a list of meshes here rather than one.
  const meshes = useRef(new Map<PropId, THREE.InstancedMesh[]>());
  const panels = useRef<THREE.InstancedMesh>(null);
  const scratch = useRef(new THREE.Matrix4());
  const sized = useRef(new THREE.Vector3());
  const tint = useRef(new THREE.Color());
  const travel = useRef(0);
  const live = useRef<THREE.CanvasTexture | undefined>(undefined);
  const liveRevision = useRef(-1);
  const holdMesh = useCallback((id: PropId, part: number, mesh: THREE.InstancedMesh | null) => {
    const parts = meshes.current.get(id) ?? [];
    if (mesh) parts[part] = mesh;
    else parts.length = part;
    meshes.current.set(id, parts);
  }, []);

  useEffect(() => () => panelGeometry.dispose(), [panelGeometry]);
  useEffect(() => () => propPaint.dispose(), [propPaint]);
  useEffect(() => () => fallback.dispose(), [fallback]);
  // Only the hand-built geometry is ours to free. The packs' geometry and materials are page-lifetime
  // assets shared by every world that stands on them (see `roadside-models`), so disposing them with
  // a world would leave the next world drawing freed buffers.
  useEffect(() => () => authored.forEach((geometry) => geometry.dispose()), [authored]);
  useEffect(
    () => () => {
      live.current?.dispose();
      panelMaterial.dispose();
    },
    [panelMaterial],
  );

  // Per-piece colour, set once per layout: the matrices move every frame, the palette does not.
  useEffect(() => {
    for (const [id, instances] of plan.props) {
      for (const mesh of meshes.current.get(id) ?? []) {
        instances.forEach((prop, index) => mesh.setColorAt(index, tint.current.set(prop.color)));
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
  }, [plan, drawable]);

  useEffect(() => {
    const mesh = panels.current;
    if (!mesh) return;
    plan.panels.forEach((panel, index) => mesh.setColorAt(index, tint.current.set(panel.color)));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [plan]);

  // Development-only readout. The pieces exist in the scene and nowhere in the DOM, so "how much of it
  // is there, and has the scroll actually reached the ground" is not a question a screenshot can
  // answer. Same reasoning as `window.__orbisWorld`.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const all = [...plan.props.values()].flat();
    (window as unknown as { __roadside?: () => unknown }).__roadside = () => ({
      pieces: all.length,
      kinds: plan.props.size,
      byKind: Object.fromEntries([...plan.props].map(([id, instances]) => [id, instances.length])),
      // Whether this run is standing on the bought packs or on the shapes they fall back to, and what
      // the layout is drawn with either way.
      models: models?.length ?? 0,
      panels: plan.panels.length,
      travel: Math.round(travel.current * 10) / 10,
      near: all.length
        ? Math.max(...all.map((prop) => roadsideZ(prop.offset, travel.current))).toFixed(1)
        : null,
      far: all.length
        ? Math.min(...all.map((prop) => roadsideZ(prop.offset, travel.current))).toFixed(1)
        : null,
      // Where the shoulder is standing, which is the one thing about the ground a screenshot of a
      // prop cannot tell you: a piece can look planted and still be a metre off.
      shoulder: apronHeight(apron, 8, 0).toFixed(2),
      visible: group.current?.visible ?? null,
      panelSource: worldFrameRevision() > 0 ? "live" : "fallback",
    });
  }, [plan, apron, models]);

  // Development-only switch, for the question `window.__roadside` cannot answer: how much of the
  // frame is the roadside? "The pieces exist" and "the pieces are in the picture" are different
  // claims, and in a dark world — where scenery and the ground behind it are both nearly black — a
  // count of instances says nothing about whether any of them are being drawn. Hiding the group and
  // differencing two frames settles it, and it is the same reasoning as `window.__orbisDrop`.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __roadsideVisible?: (visible: boolean) => boolean }).__roadsideVisible = (
      visible: boolean,
    ) => {
      if (!group.current) return false;
      group.current.visible = visible;
      return group.current.visible;
    };
    return () => {
      delete (window as unknown as { __roadsideVisible?: unknown }).__roadsideVisible;
    };
  }, []);

  useFrame((_, delta) => {
    // The road's own distance, so the roadside and the ribbon are the same ground moving.
    travel.current += speedRef.current * delta;
    const matrix = scratch.current;

    for (const [id, instances] of plan.props) {
      const parts = meshes.current.get(id);
      const metrics = catalog.get(id);
      if (!parts || parts.length === 0 || !metrics) continue;

      instances.forEach((prop, index) => {
        const z = roadsideZ(prop.offset, travel.current);
        const taper = Math.max(0.001, roadsideTaper(z));
        const scale = prop.scale * taper;
        // On the ground the apron actually has here, then set into it by a fraction of the piece's
        // own height, so nothing hovers over the facet it is standing on.
        const ground = apronHeight(apron, prop.x, z) - roadsideSink(metrics.height * scale);
        matrix.makeRotationY(prop.yaw);
        matrix.scale(sized.current.set(scale, scale, scale));
        matrix.setPosition(prop.x, ground, z);
        // Every part of a prop is the same prop, so they all get the same matrix: a tree's canopy
        // cannot drift from its trunk.
        for (const mesh of parts) mesh.setMatrixAt(index, matrix);
      });
      for (const mesh of parts) mesh.instanceMatrix.needsUpdate = true;
    }

    const panelMesh = panels.current;
    if (panelMesh) {
      plan.panels.forEach((panel, index) => {
        const z = roadsideZ(panel.offset, travel.current);
        const taper = Math.max(0.001, roadsideTaper(z));
        const ground = apronHeight(apron, panel.x, z) - panel.sink * taper;
        matrix.makeScale(panel.width * taper, panel.height * taper, 1);
        // Lifted from the piece's base rather than from the panel's own centre, so it stays where it
        // was put on the face as that piece shrinks into the far taper.
        matrix.setPosition(panel.x, ground + panel.y * taper, z + panel.z * taper);
        panelMesh.setMatrixAt(index, matrix);
      });
      panelMesh.instanceMatrix.needsUpdate = true;
    }

    // The world's own picture, when there is one. Sampled elsewhere: the element it comes from
    // belongs to the SDK's surface, and this runs inside the render loop.
    const frame = worldFrameCanvas();
    if (!frame) return;
    let texture = live.current;
    if (!texture) {
      texture = new THREE.CanvasTexture(frame);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.repeat.copy(fallback.repeat);
      texture.offset.copy(fallback.offset);
      live.current = texture;
      panelMaterial.map = texture;
    }
    const revision = worldFrameRevision();
    if (revision !== liveRevision.current) {
      liveRevision.current = revision;
      texture.needsUpdate = true;
    }
  });

  return (
    <group ref={group}>
      {[...plan.props].map(([id, instances]) =>
        (drawable.get(id) ?? []).map((part, index) => (
          <instancedMesh
            key={`roadside-${id}-${index}-${environment}`}
            ref={(mesh) => holdMesh(id, index, mesh)}
            args={[part.geometry, part.material, instances.length]}
            frustumCulled={false}
          />
        )),
      )}
      {plan.panels.length > 0 && (
        <instancedMesh
          key={`roadside-panels-${environment}`}
          ref={panels}
          args={[panelGeometry, panelMaterial, plan.panels.length]}
          frustumCulled={false}
        />
      )}
    </group>
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
  /** Sideways travel in metres, damped: the source of both the world's parallax and the camera pan. */
  const stride = useRef(0);
  /** `stride` in the units the DOM layer is told to parallax by: -1, 0, or 1 at the lane centres. */
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
    // run accelerates, and the video layer scales with the same value. The lateral travel is damped
    // on the same curve the runner's own lane change is, so the body, the camera, and the ground it
    // is stepping across all leave the old lane together and settle together.
    stride.current = THREE.MathUtils.damp(stride.current, LANES[lane] ?? 0, 8, delta);
    lateral.current = stride.current / Math.abs(LANES[0]);
    impact.current = Math.max(0, impact.current - delta * 2.2);

    // Half of the step is the runner crossing the frame and half is the ground sweeping under it; see
    // `CAMERA_LATERAL_FOLLOW`. The rig is not re-aimed, so the ground shears with real perspective.
    const cameraX = stride.current * CAMERA_LATERAL_FOLLOW;
    if (impact.current > 0.01) {
      camera.position.set(
        cameraX + Math.sin(clock.elapsedTime * 48) * impact.current * 0.07,
        3.4 - impact.current * 0.3,
        11.5 + impact.current * 0.25,
      );
    } else {
      camera.position.set(cameraX, 3.4, 11.5);
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
      <Roadside environment={environment} speedRef={speedRef} />
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
