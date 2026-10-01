import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Environment, RunState, WorldEvent } from "./run-state";
import { initialRunState, isRunOver, MAX_DAMAGE } from "./run-state";
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
  type PowerupKind,
  type PowerupSpawn,
  type Shape,
  type ObstacleKind,
  type ObstacleSpawn,
} from "./pattern-field";
import { roadGrade } from "./road-grade";
import { ghostAhead, ghostAt, LINE_METRES, type RunSummary } from "./records";
import { hazardAt, hazardFog, hazardLight, publishHazard, readHazard, shovesFor, windFor } from "./hazards";
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
 * 96 m is twelve whole 8 m tiles, so the dash pattern closes on the far edge rather than being cut
 * mid-tile. It used to be 56 m — seven tiles — and was cut down from 46 m before that, on the
 * reasoning that more length was always more road; what that missed is that the ribbon's own fade,
 * not the plane's edge, is what the eye reads as "the end of it". At 56 m the fade gave full opacity
 * for the first 8 m and was gone by 32 m, so the road dissolved less than two seconds ahead of the
 * runner and the world past it belonged to the apron. The fade now holds full opacity for the first
 * 40 m and is gone by 83 m (see `createRoadFade`), against a ribbon twice as long so the far edge is
 * well inside the transparent tail: a fade that ends exactly at the edge of a plane shows the very
 * seam it exists to hide.
 */
const ROAD_LENGTH = 96;
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
 *
 * It was 90 m, going transparent 54 m out, and that was the ceiling on how far ahead the scenery
 * could stand: a prop past the point where the apron had faded was a prop floating over the video,
 * and the eye catches that at speed. Carrying the same fade — solid under the runner, half gone by
 * mid-frame, clear before the horizon band — out to a 120 m apron puts the transparent end at about
 * 92 m, which is what the roadside's own far taper now wraps inside. The fade band still covers
 * roughly a tenth of the frame, so it is a blend rather than a line; it simply starts and finishes
 * further up, because the screen compresses hard near the horizon and ten metres of ground there are
 * worth barely one row of pixels.
 */
const TERRAIN_WIDTH = 360;
const TERRAIN_NEAR_Z = 16;
const TERRAIN_LENGTH = 120;
const TERRAIN_SEGMENTS_X = 144;
const TERRAIN_SEGMENTS_Z = 96;
/** Depth over which the apron dissolves: solid under the runner, gone before the horizon band. */
const TERRAIN_FADE_START = 0.28;
const TERRAIN_FADE_END = 0.9;
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

/* ---- pickups ---------------------------------------------------------------------------------
 * The three verbs, and how often they arrive. Spaced by distance travelled rather than by chunk, so
 * a slow world and a fast one offer the same number of pickups per metre of run — which is what makes
 * them feel like part of the world rather than part of the pacing.
 */
/** Metres of run between one pickup and the next. Roughly one every fifteen seconds at cruise. */
const POWERUP_SPACING = 165;
/** How high a pickup floats: the coin line, so it is taken at a run and never asks for a jump. */
const POWERUP_Y = 1.05;
/** A shield sits until it is spent; the other two are clocks. */
const MAGNET_SECONDS = 9;
const DOUBLE_SECONDS = 11;
/** How far ahead the magnet reaches, in metres of road. */
const MAGNET_RANGE = 14;
/**
 * The look of each pickup: one silhouette and one colour per verb, so what it is can be read at
 * speed. The colours are deliberately outside the coin palette — a pickup is not currency, and the
 * one thing it must never be mistaken for is another coin.
 */
const POWERUP_STYLE: Record<PowerupKind, { color: string; glow: string }> = {
  shield: { color: "#e6f7ff", glow: "#5fd0ff" },
  magnet: { color: "#ffe4f7", glow: "#ff5fd0" },
  double: { color: "#fff4cf", glow: "#ffc44a" },
};

/* ---- the skill ceiling --------------------------------------------------------------------------
 * A run could always be *long*, and the only way to be good at it was to survive. These are the two
 * things that make it possible to be *good*: a flow value that near misses and threaded gaps build
 * and a hit wipes, and the one moment the game slows down for — a gap taken between two obstacles in
 * the adjacent lanes at once.
 */
/**
 * What a near miss adds to flow, and what threading a gap adds.
 *
 * The numbers are set so that *breaking even* is a rhythm: a near miss every five seconds exactly
 * offsets the drain, so a player who is merely close to things holds a steady meter, and the only way
 * up is to be close to things more often or to thread the gaps. The first values measured this way
 * were wrong in a way worth recording — 0.1 a near miss against 0.045 a second of drain left the
 * meter pinned near 0.13 after seventeen near misses, which is a ceiling nobody can reach and a
 * keyboard-smash away from the reward being reserved for the probe.
 */
const FLOW_NEAR = 0.15;
const FLOW_THREAD = 0.34;
/** Flow lost per second of clean running: a full meter is worth about half a minute of not trying. */
const FLOW_DECAY = 0.03;
/** How close two obstacles in opposite side lanes have to be to count as one gap. */
const GAP_METRES = 4;
/**
 * The threading moment: how long the world holds its breath, how slowly it does it, and how much road
 * has to pass before it may do it again.
 *
 * The cooldown is not decoration. A player who learns to *farm* the middle — the pair shape leaves the
 * middle open one time in three, and a run that only ever sits there threads them one after another —
 * would otherwise spend a fifth of the run in slow motion, which stops being a moment. The thread
 * itself still counts and still pays while the clock is on cooldown; only the flourish waits.
 */
const SLOWMO_SECONDS = 0.42;
const SLOWMO_SCALE = 0.45;
const SLOWMO_COOLDOWN_METRES = 90;

type PlayerAnimation = "run" | "jump" | "slide" | "stumble";

type RunnerSceneProps = {
  environment: Environment;
  characterId: CharacterId;
  paused: boolean;
  onWorldEvent: (state: RunState, event: WorldEvent) => void;
  /**
   * Throttled run-state feed for HUD readouts, so distance and speed move smoothly. The ghost rides
   * along because it is read from the same frame as the distance it is compared against.
   */
  onProgress?: (state: RunState, ghost: { lane: number; ahead: number } | null) => void;
  /**
   * Fired on every token with what it actually paid. Deliberately separate from `onWorldEvent`: a
   * coin is not a world event, and routing it through the director would let a pickup steer the
   * generated world.
   */
  onToken?: (value: number) => void;
  /**
   * Fired once, on the hit that ends the run.
   *
   * The run used to have no end: `damage` accumulated and `dangerLevel` rose, and nothing ever acted
   * on either. This is the moment the game admits the run is over — the interface puts a card up, and
   * the simulation winds down behind it. The state handed over is the run's last frame, so the card
   * reports the score the simulation actually finished with rather than one the HUD happened to have.
   */
  /**
   * `line` is where the run went, as flat `distance, lane, score, time` quads every `LINE_METRES` —
   * the record's ghost is read from it, so a run that sets a best also leaves a line to race.
   */
  onRunEnd?: (state: RunState, line: number[]) => void;
  /**
   * Which attempt of this world is being run. Changing it remounts the simulation — that is the
   * restart: every ref the run owns (state, obstacles, coins, timers) is re-initialised together, and
   * the canvas, the world layer and the session are untouched, so "run again" is instant instead of a
   * trip back through the loading screen.
   */
  attempt?: number;
  /**
   * The terms the run was taken under: how many hits it survives, what a token pays, what a near miss
   * adds, and whether the world's weather runs at all.
   *
   * Passed in rather than read from the contract module inside the simulation, because the simulation is
   * a pure-ish object with props: a run's terms are decided by the interface before the line, and a
   * second read of the store down here could disagree with the card the player was shown.
   */
  terms?: RunTerms;
  /**
   * The best run this world has, when it has one: the ghost's source.
   *
   * Passed in rather than read from the store down here, for the same reason the terms are: the run is
   * a pure-ish simulation with props, and a second read of `localStorage` inside it could disagree
   * with the number the menu is showing.
   */
  ghost?: RunSummary | null;
};

/** The part of a contract the simulation actually runs on. */
export type RunTerms = {
  name: string;
  hits: number;
  tokenScale: number;
  flowScale: number;
  hazards: boolean;
};

/** Content in flight: a spawn from the field, plus the identity this scene gives it. */
type Obstacle = ObstacleSpawn & { id: number };
/**
 * A coin, plus the sideways offset a magnet moves it by.
 *
 * `x` is an offset from the coin's lane rather than a position, because the lane is what every other
 * rule in the run reads — the audit, the placement, the collection — and a coin that has been pulled
 * by a magnet is still a coin in the lane it was placed in.
 */
type Coin = CoinSpawn & { id: number; x?: number };
type Powerup = PowerupSpawn & { id: number };

/**
 * Which lane a world-space x is standing in.
 *
 * Published for the development readout rather than used by the run: the ghost's own numbers say where
 * the best line *was*, and this is the one number that says where the mark on the road actually is — a
 * marker drawn in the wrong lane, or never drawn at all, would leave every other reading correct.
 */
function laneAtX(x: number): number {
  const lanes: readonly number[] = LANES;
  let nearest = 0;
  for (let index = 1; index < lanes.length; index += 1) {
    if (Math.abs(lanes[index] - x) < Math.abs(lanes[nearest] - x)) nearest = index;
  }
  return nearest;
}

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
  //
  // The breakpoints are fractions of `ROAD_LENGTH`, and they moved with it rather than staying put: at
  // the old 56 m the same shape dissolved the ribbon 8 m out and finished it at 32 m, which put the
  // end of the road inside the part of the frame the runner is still reading. On a 96 m ribbon these
  // hold full opacity for 40 m and are gone by 83 m, so the ribbon now runs out around the same place
  // the apron's own fade begins to tell (see `TERRAIN_FADE_*`) instead of being a short mat with the
  // world visible past it. The last stop is deliberately short and shallow: the tail has to be under
  // the apron's alpha, or the road would finish as a visible band across the generated world.
  const distanceAlpha = (v: number) => {
    if (v <= 0.42) return 1;
    if (v <= 0.6) return 1 - ((v - 0.42) / 0.18) * 0.55;
    if (v <= 0.74) return 0.45 - ((v - 0.6) / 0.14) * 0.33;
    if (v <= 0.86) return 0.12 - ((v - 0.74) / 0.12) * 0.12;
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

  /**
   * The grade the road and the apron were drawn with, before any weather got to them.
   *
   * Held in a ref because the blackout writes the material's colour every frame, and the grade is the
   * thing it has to be written *from*: multiplying the live colour by the light factor again and again
   * would darken the road by the frame rate rather than by the hazard. The effect below re-reads it
   * whenever the world's measured tone moves.
   */
  const baseRoad = useRef(new THREE.Color().setRGB(...grade.color));
  const baseTerrain = useRef(new THREE.Color().setRGB(grade.terrain, grade.terrain, grade.terrain));
  const roadMaterial = useRef<THREE.MeshStandardMaterial>(null);
  const terrainMaterial = useRef<THREE.MeshStandardMaterial>(null);
  useEffect(() => {
    baseRoad.current.setRGB(...grade.color);
    baseTerrain.current.setRGB(grade.terrain, grade.terrain, grade.terrain);
  }, [grade]);

  useFrame((_, delta) => {
    // Each surface is scrolled one tile per `speed * delta` metres, divided by the world size of its
    // own tile, so the two carry the same ground speed despite repeating at different scales.
    pattern.offset.y += (speedRef.current * delta) / ROAD_TILE_WORLD;
    // Only the colour map scrolls. The alpha map is the depth fade and stays where the world put it,
    // which is what lets the apron be redrawn under the runner without the fade leaving its depth.
    terrainPattern.offset.y += (speedRef.current * delta) / terrainDetail.tile;

    /* The blackout, which is the one hazard that hurts the run by taking light rather than ground.
       The road's own lane markings are painted into the colour map, so dimming the material dims the
       only thing on the ground that says where the lanes are: the cost is exactly the information
       the world was giving away for free. It stops at 0.3 rather than at black on purpose — a road
       nobody can read is not a hazard, it is a dead run, and the hazard has to be answerable. */
    const hazard = readHazard();
    const light = hazard.kind === "blackout" ? hazardLight(hazard.intensity) : 1;
    if (roadMaterial.current) roadMaterial.current.color.copy(baseRoad.current).multiplyScalar(light);
    if (terrainMaterial.current) terrainMaterial.current.color.copy(baseTerrain.current).multiplyScalar(light);
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
          ref={terrainMaterial}
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
          ref={roadMaterial}
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

    // A blackout is a city going dark, and the signage is what a city *is*: the panels carry a frame
    // of the live world (`world-frame`), and dimming them is what makes the hazard visible on the
    // scenery the run is passing rather than only in the sky ahead.
    const hazard = readHazard();
    panelMaterial.color.setScalar(hazard.kind === "blackout" ? hazardLight(hazard.intensity) : 1);

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
    // The mountain a run can only go around. The desert's is a standing remnant — a weathered
    // eight-sided column with a chipped cap and a block fallen at its foot — because a tall flat
    // rectangle standing in the sand reads as a bug in the world rather than as part of it. The
    // city's is a lit barrier: a dark panel between two neon strips on a plinth, which is the same
    // silhouette the road already expects with something to look at in it.
    if (environment === "desert") {
      return (
        <group>
          <mesh position={[0, 1.15, 0]} castShadow>
            <cylinderGeometry args={[0.36, 0.5, 2.3, 8]} />
            <meshStandardMaterial color={look.stone} roughness={0.95} flatShading />
          </mesh>
          <mesh position={[0.08, 2.34, 0.04]} rotation={[0.06, 0.5, -0.12]} castShadow>
            <boxGeometry args={[0.78, 0.22, 0.72]} />
            <meshStandardMaterial color={look.wall} roughness={0.9} flatShading />
          </mesh>
          <mesh position={[-0.52, 0.16, 0.2]} rotation={[0, 0.7, 0.08]} castShadow>
            <boxGeometry args={[0.5, 0.32, 0.44]} />
            <meshStandardMaterial color={look.wall} roughness={0.95} flatShading />
          </mesh>
        </group>
      );
    }
    return (
      <group>
        <mesh position={[0, 1.34, 0]} castShadow>
          <boxGeometry args={[1.45, 2.2, 0.42]} />
          <meshStandardMaterial color={look.wall} roughness={0.42} metalness={0.5} />
        </mesh>
        {[-1, 1].map((side) => (
          <mesh key={side} position={[side * 0.62, 1.34, 0.23]}>
            <boxGeometry args={[0.09, 2.05, 0.03]} />
            <meshStandardMaterial
              color={look.blockAccent}
              emissive={look.blockAccent}
              emissiveIntensity={1.15}
              roughness={0.3}
            />
          </mesh>
        ))}
        <mesh position={[0, 2.52, 0]}>
          <boxGeometry args={[1.5, 0.09, 0.46]} />
          <meshStandardMaterial color={look.blockAccent} emissive={look.blockAccent} emissiveIntensity={0.9} roughness={0.3} />
        </mesh>
        <mesh position={[0, 0.08, 0]} castShadow>
          <boxGeometry args={[1.6, 0.16, 0.7]} />
          <meshStandardMaterial color={look.block} roughness={0.6} metalness={0.35} />
        </mesh>
      </group>
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
      {/* The city's jumpable gets one lit bar on its face: the same object the lane already reads as
          a crouched obstacle, with the light the avenue is made of on it. */}
      {environment === "city" && (
        <mesh position={[0, 0.42, 0.47]}>
          <boxGeometry args={[0.72, 0.16, 0.03]} />
          <meshStandardMaterial color={look.coin} emissive={look.coinGlow} emissiveIntensity={0.9} roughness={0.3} />
        </mesh>
      )}
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
    // The magnet's offset lives here rather than in the render, because the coin's position is
    // already being written every frame and a pulled coin is only a lane plus an offset.
    group.current.position.x = LANES[coin.lane] + (coin.x ?? 0);
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

/**
 * A pickup in the world.
 *
 * Same contract as a coin — position written every frame from the simulation's copy, hidden rather
 * than unmounted when taken — but with a silhouette per verb instead of one currency shape, because
 * the one thing a pickup must never look like at speed is a coin. Each carries a soft additive shell
 * so it reads as something glowing *above* the road rather than another object lying on it, and the
 * magnet keeps its face to the camera: a horseshoe seen edge-on is a line.
 */
function PowerupPiece({ pickup }: { pickup: Powerup }) {
  const group = useRef<THREE.Group>(null);
  const look = POWERUP_STYLE[pickup.kind];

  useFrame(({ clock }, delta) => {
    if (!group.current) return;
    group.current.visible = !pickup.collected;
    group.current.position.z = pickup.z;
    group.current.position.y = POWERUP_Y + Math.sin(clock.elapsedTime * 2.2 + pickup.id) * 0.1;
    if (pickup.kind === "magnet") group.current.rotation.z += delta * 1.2;
    else group.current.rotation.y += delta * 1.4;
  });

  return (
    <group ref={group} position={[LANES[pickup.lane], POWERUP_Y, pickup.z]}>
      {pickup.kind === "shield" ? (
        <mesh>
          <octahedronGeometry args={[0.34, 0]} />
          <meshStandardMaterial
            color={look.color}
            emissive={look.glow}
            emissiveIntensity={0.9}
            roughness={0.2}
            metalness={0.5}
          />
        </mesh>
      ) : pickup.kind === "magnet" ? (
        <group>
          <mesh>
            <torusGeometry args={[0.26, 0.09, 10, 24, Math.PI]} />
            <meshStandardMaterial
              color={look.color}
              emissive={look.glow}
              emissiveIntensity={0.9}
              roughness={0.25}
              metalness={0.5}
            />
          </mesh>
          {/* The pole tips: the two ends of the horseshoe, in the accent colour, which is what makes
              the shape unmistakably a magnet rather than a broken ring. */}
          {[-1, 1].map((side) => (
            <mesh key={side} position={[side * 0.26, -0.08, 0]}>
              <cylinderGeometry args={[0.09, 0.09, 0.16, 10]} />
              <meshStandardMaterial color={look.glow} emissive={look.glow} emissiveIntensity={0.7} roughness={0.35} />
            </mesh>
          ))}
        </group>
      ) : (
        <group>
          {/* Two of a thing: the only pickup whose meaning is an amount, so it is the only one drawn
              twice. */}
          {[-0.13, 0.13].map((offset) => (
            <mesh key={offset} position={[0, offset, 0]} rotation={[0, 0, Math.PI / 4]}>
              <boxGeometry args={[0.3, 0.3, 0.3]} />
              <meshStandardMaterial
                color={look.color}
                emissive={look.glow}
                emissiveIntensity={0.9}
                roughness={0.25}
                metalness={0.45}
              />
            </mesh>
          ))}
        </group>
      )}
      <mesh scale={1.55}>
        <sphereGeometry args={[0.32, 14, 14]} />
        <meshBasicMaterial
          color={look.glow}
          transparent
          opacity={0.16}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
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
      {/*
        The fallback is empty on purpose. It used to be a capsule — the shape the collision maths
        is built around — and it showed for the frame or two between the run appearing and the
        runner's GLB landing, which is a frame the player should never see the scaffolding in. The
        model is warmed by `preloadCharacter` while the loading screen is up (see `WorldLoader`), so
        this boundary should not suspend at all; if it ever does, the runner is briefly absent
        rather than briefly a cylinder. The collision is the simulation's, not this mesh's.
      */}
      <Suspense fallback={null}>
        <RunnerCharacter characterId={characterId} state={animation} speedRef={speedRef} />
      </Suspense>
    </group>
  );
}

/* ---------------------------------------------------------------------------- simulation */

/** What a run is played under when nobody said otherwise: the standard deal, in one place. */
/**
 * The most line a run may carry, in numbers: 1,000 samples, which is 20 km.
 *
 * A bound rather than a budget: the worlds' speeds are bounded and a run that outlives 20 km of road
 * has long since stopped being a run, so this is the length at which a line is a bug rather than a run.
 */
const LINE_CAP = 4000;

/** What a run is played under when nobody said otherwise: the standard deal, in one place. */
const STANDARD_TERMS: RunTerms = {
  name: "Standard",
  hits: MAX_DAMAGE,
  tokenScale: 1,
  flowScale: 1,
  hazards: true,
};

function RunnerSimulation({
  environment,
  characterId,
  paused,
  onWorldEvent,
  onProgress,
  onToken,
  onRunEnd,
  ghost = null,
  terms = STANDARD_TERMS,
}: RunnerSceneProps) {
  const [lane, setLane] = useState(1);
  const [jumping, setJumping] = useState(false);
  const [sliding, setSliding] = useState(false);
  const [stumbling, setStumbling] = useState(false);
  /**
   * The run is over, and what follows is the wind-down.
   *
   * Two flags rather than one: the ref is what the frame loop reads every frame (it must not wait for
   * a render to know the run is done), and the state is what the render reads for the pose. A single
   * state would let a frame of the old run slip through, and a single ref would leave the runner
   * jogging on the spot through its own defeat.
   */
  const over = useRef(false);
  const [defeated, setDefeated] = useState(false);
  // The simulation is the source of truth and lives in refs: mirroring it through React state
  // every frame is both wasteful and, when it lags, wrong — distance used to advance by a
  // single frame's worth per state update, and obstacles visibly jumped once per second.
  const runState = useRef<RunState>(initialRunState(environment));
  const obstacles = useRef<Obstacle[]>([]);
  const coins = useRef<Coin[]>([]);
  const powerups = useRef<Powerup[]>([]);
  /**
   * This run's line: `distance, lane, score, time` every 20 m, the shape the ghost is read from.
   *
   * Recorded in the simulation because the lane is a simulation fact — nothing outside this file knows
   * which lane the run took at metre 340 except the run itself. It is only handed over when the run
   * ends, and only a run that *sets* a best has its line written to the store (`fileRun`), so a line is
   * always a line the player can be asked to race.
   */
  const line = useRef<number[]>([]);
  /** What the ghost was doing at the metre the run is at, for the HUD and the development readout. */
  const ghostStatus = useRef<{ lane: number; ahead: number } | null>(null);
  /** The run has already been told it is ahead of its best: the answer happens once. */
  const ghostFired = useRef(false);
  /** The marker standing where the best line was, moved rather than re-rendered every frame. */
  const ghostMarker = useRef<THREE.Group | null>(null);
  /** The distance at which the next pickup should appear. Advanced when one is actually laid. */
  const nextPowerupAt = useRef(POWERUP_SPACING);
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
  /** The lane the simulation is actually reading, for the development readout. */
  const laneRef = useRef(1);
  /** Which hazard has already been announced, and how many of its shoves have landed. */
  const announcedHazard = useRef(-1);
  /** How many hazards this run has actually announced, for the development readout. */
  const hazardFired = useRef(0);
  // The run's terms are not announced from here: the director drops every ask for `RUN_QUIET_MS`
  // after a run takes the world, and this file's clock runs on frame deltas, which in a slow frame
  // can outrun the wall clock the director reads. `RunExperience` asks for it instead, on the
  // interface's own clock — see the effect there.
  const shoves = useRef(0);
  /** A gust's leftover push, decaying: what the world layer feels of the storm. */
  const gust = useRef(0);
  const gustDir = useRef<-1 | 1>(-1);
  /** The threading moment: its clock, the camera's pull-in, and the time scale the run runs at. */
  const slowmo = useRef(0);
  const punch = useRef(0);
  const timeScale = useRef(1);
  /** The distance the next threading moment may slow time at. */
  const slowmoReadyAt = useRef(0);
  /** The camera the run is drawn with, for the development readout's dolly reading. */
  const cameraRef = useRef<THREE.Camera | null>(null);
  /** Seconds since this run began, for the launch surge. */
  const launch = useRef(0);
  const [worldVersion, setWorldVersion] = useState(0);
  const timers = useRef<number[]>([]);
  /** The scene clock's reading while a pause holds it — see the pause branch in the frame loop. */
  const heldClock = useRef<number | null>(null);

  /**
   * Writes where the run is: once every `LINE_METRES`, and once more when it ends.
   *
   * The last sample is forced rather than waited for, because the whole reason the line exists is to
   * say where the best run *stopped* — a line that ends 19 m short of the record it belongs to would
   * put the ghost a step behind the number it is named after. A forced sample closer than a couple of
   * metres to the previous one is dropped instead, so "where it stopped" is never two samples stacked
   * on the same metre.
   */
  const recordLine = useCallback((distance: number, time: number, force = false) => {
    const flat = line.current;
    const last = flat.length >= 4 ? flat[flat.length - 4] : -LINE_METRES;
    const gap = distance - last;
    if (force ? gap < 2 : gap < LINE_METRES) return;
    if (flat.length >= LINE_CAP) return;
    flat.push(Math.round(distance), laneRef.current, Math.round(runState.current.score), Math.round(time * 100) / 100);
  }, []);

  const scheduleReset = useCallback((reset: () => void, ms: number) => {
    const timer = window.setTimeout(() => {
      timers.current = timers.current.filter((id) => id !== timer);
      reset();
    }, ms);
    timers.current.push(timer);
  }, []);

  // Development-only readout, for the same reason as `window.__roadside`: the content field near the
  // runner lives in the WebGL scene and nowhere in the DOM, so "which pickup was in which lane, and
  // did the magnet actually bend that coin" is not a question a screenshot can answer. What is
  // reported is the field *in front of* the runner — z below `PLAYER_Z` is the direction the run
  // travels — because a piece two hundred metres up the road is a fact about the generator, and the
  // generator can be read directly in `pattern-field.ts`.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const state = () => runState.current;
    const round = (value: number) => Math.round(value * 10) / 10;
    (window as unknown as { __runfield?: () => unknown }).__runfield = () => ({
      powerups: powerups.current
        .filter((pickup) => pickup.z > PLAYER_Z - 70)
        .map((pickup) => ({
          id: pickup.id,
          kind: pickup.kind,
          lane: pickup.lane,
          z: round(pickup.z),
          collected: pickup.collected,
        })),
      obstacles: obstacles.current
        .filter((obstacle) => !obstacle.passed && obstacle.z > PLAYER_Z - 40)
        .map((obstacle) => ({ lane: obstacle.lane, kind: obstacle.kind, z: round(obstacle.z) })),
      // The coins in front of the runner, with the offset a magnet has moved them by: the pull is a
      // number in the simulation and nothing in the DOM.
      coins: coins.current
        .filter((coin) => !coin.collected && coin.z > PLAYER_Z - 40)
        .map((coin) => ({ lane: coin.lane, x: Math.round((coin.x ?? 0) * 100) / 100, z: round(coin.z) })),
      // The weather and the lane, with the field: what the world is doing to the run, and where the
      // run actually is — the two things a shove moves without a key being pressed.
      hazard: { ...state().hazard },
      hazardFired: hazardFired.current,
      lane: laneRef.current,
      // The skill ceiling, as the simulation is actually running it: the flow value, the gaps it has
      // threaded, the run's own clock (which is the only place a threading moment is visible), and
      // where the camera has been dollied to.
      flow: Math.round(state().flow * 1000) / 1000,
      threads: state().threads,
      speed: Math.round(state().speed * 10) / 10,
      timeScale: Math.round(timeScale.current * 1000) / 1000,
      cameraZ: cameraRef.current ? Math.round(cameraRef.current.position.z * 1000) / 1000 : null,
      shield: state().shield,
      magnet: round(state().magnet),
      doubleTokens: round(state().doubleTokens),
      distance: Math.round(state().distance),
      damage: state().damage,
      tokens: state().coins,
      score: Math.round(state().score),
      // What a token is worth at this distance, from the same function the scoring and the HUD use:
      // the only way to check a doubled token paid double without re-deriving the curve here.
      tokenValue: Math.round(coinValueAt(environment, state().distance) * 100) / 100,
      // The best line, as the run is reading it: the lane the ghost mark is standing in and the metres
      // this run is ahead of (or behind) its best at the same second. Null when there is no best, or
      // the run has gone past the end of the line.
      ghost: ghostStatus.current,
      line: line.current.length / 4,
      // The mark itself — the one thing the ghost's numbers cannot prove: which lane the mesh on the
      // road is actually standing in, and whether it is drawn at all.
      ghostMark: ghostMarker.current
        ? { on: ghostMarker.current.visible, lane: laneAtX(ghostMarker.current.position.x) }
        : null,
    });
    return () => {
      delete (window as unknown as { __runfield?: unknown }).__runfield;
    };
  }, []);

  useEffect(() => () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
    publishWorldMotion(environment, environmentPace[environment].baseSpeed, 0, 0, 0, true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A paused run takes no input: the keys would change the lane behind the pause card and then
      // the run would lurch the moment it resumed.
      if (paused) return;
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
  }, [paused, scheduleReset]);

  useFrame(({ camera, clock, scene }, delta) => {
    if (paused) {
      /* ---- the whole world holds still, not just the run ----
         The scene's animations — the road's scroll, the roadside's drift, the coins' and pickups'
         bob, the runner's cycle and sway, the camera's shake — all read the renderer's clock: `delta`
         for the moving parts, `elapsedTime` for the oscillating ones. Holding the run alone left the
         road and the runner visibly alive behind the pause card, so the clock itself is stopped
         here: every reader of it reads zero, and nothing has to know a pause exists. `Clock.start()`
         resets its own elapsed time, so the reading is kept while the clock is held and put back on
         the way out — the run's line timestamps and the ghost race are measured in this clock and
         have to carry on from where they were. */
      if (clock.running) {
        clock.stop();
        heldClock.current = clock.elapsedTime;
      }
      speedRef.current = 0;
      publishWorldMotion(environment, 0, lateral.current, impact.current, clock.elapsedTime, true);
      return;
    }
    if (!clock.running) {
      clock.start();
      if (heldClock.current !== null) clock.elapsedTime = heldClock.current;
      heldClock.current = null;
    }

    const state = runState.current;
    const difficulty = difficultyAt(environment, state.distance);
    cameraRef.current = camera;

    /* ---- the run's own clock -------------------------------------------------------------------
       A threaded gap is the one moment the game slows down for: a third of a second at 0.45 speed,
       which is *time*, not speed — the run and everything driven by it (the content field, the
       roadside, the token clocks, the distance trickle) slows together, so the moment reads as the
       world holding its breath rather than as the player being punished with less speed. The camera
       dollies in with it and eases back out, which is the camera's whole reaction: no roll, no whip,
       because the frame the generated world is locked to must not move.

       `slowmo` decays in real seconds rather than in game seconds on purpose: scaling the recovery by
       the slow-motion itself would make the effect longest exactly when it is most useful, and it is
       a flourish, not a resource. */
    if (slowmo.current > 0) slowmo.current = Math.max(0, slowmo.current - delta);
    if (punch.current > 0) punch.current = Math.max(0, punch.current - delta * 2.6);
    timeScale.current = THREE.MathUtils.damp(timeScale.current, slowmo.current > 0 ? SLOWMO_SCALE : 1, 9, delta);
    const step = delta * timeScale.current;

    const distance = state.distance + step * state.speed;
    if (stumbleSlow.current > 0) stumbleSlow.current = Math.max(0, stumbleSlow.current - step * 1.1);
    launch.current = Math.min(LAUNCH_SECONDS, launch.current + delta);
    const surge = (1 - launch.current / LAUNCH_SECONDS) ** 1.7 * LAUNCH_BOOST;
    const cruise = speedAt(environment, distance);
    // A finished run winds down rather than stopping dead: the world coasts to a halt under the last
    // stumble, so the defeat reads as the run giving out and not as the simulation being switched
    // off. Everything downstream of this — the roadside, the world layer's parallax, the runner's
    // cycle speed — is driven by `speedRef`, so they all slow together, on their own curves.
    const speed = over.current
      ? THREE.MathUtils.damp(state.speed, 0, 2.4, delta)
      : (cruise + surge) * (1 - stumbleSlow.current * 0.32);
    // The *scaled* speed is what the rest of the game is told: the runner's cycle, the roadside's
    // scroll and the video layer's own motion all take their cue from here, so a threading moment
    // slows the whole world together rather than only the things this file moves itself.
    speedRef.current = speed * timeScale.current;

    state.distance = distance;
    state.speed = speed;
    // The distance trickle stops with the run: a stationary runner must not keep earning. What it
    // pays is what the run is *playing* like: at full flow the ground alone is worth two and a half
    // times what coasting is, which is the skill ceiling made arithmetic rather than a label.
    if (!over.current) state.score += step * (12 + state.flow * 18);
    // One sample of the line every `LINE_METRES`, written from here because the lane and the score are
    // read a frame before they are rendered: a line sampled off the HUD would be 200 ms of lies.
    recordLine(distance, clock.elapsedTime);

    // Flow drains with the metre and is wiped by a hit (see the collision branch); near misses and
    // threaded gaps are what build it. Decay in game seconds, so a slow-motion moment does not also
    // cost flow faster than the run it is slowing.
    state.flow = Math.max(0, state.flow - step * FLOW_DECAY);

    // The pickup clocks. They run in the simulation's own seconds, so a pause stops them with
    // everything else rather than burning a shield's worth of magnet behind a pause screen — and they
    // run on the run's own clock, so a slow-motion moment is not a free eleven seconds of doubled
    // tokens.
    if (state.magnet > 0) state.magnet = Math.max(0, state.magnet - step);
    if (state.doubleTokens > 0) state.doubleTokens = Math.max(0, state.doubleTokens - step);

    /* ---- the world's own weather ---- */
    const hazard = hazardAt(environment, distance, difficulty, terms.hazards);
    publishHazard(hazard);
    state.hazard.kind = hazard.kind;
    state.hazard.name = hazard.name;
    state.hazard.phase = hazard.phase;
    state.hazard.intensity = hazard.intensity;

    // Announced once per hazard, on arrival rather than on the warning: the warning is the
    // interface's to give (the badge and the sky change), and the world's answer is to the storm
    // being *here*. It is a play event, so it cannot be displaced by the milestone chatter.
    if (!over.current && hazard.phase === "active" && hazard.index !== announcedHazard.current) {
      announcedHazard.current = hazard.index;
      shoves.current = 0;
      hazardFired.current += 1;
      onWorldEvent({ ...state, speed }, { type: "hazard_started", hazard: hazard.name });
    }

    // The desert's shove: one whole lane, and the run has to take it back. `shovesFor` counts how
    // many gusts the storm owes by now, so the rhythm is a function of the distance rather than of
    // the frame rate — and a frame that lands two is two lanes, in the right directions.
    if (!over.current && hazard.kind === "shove" && hazard.phase === "active") {
      const due = shovesFor(hazard.since);
      while (shoves.current < due) {
        const wind = windFor(hazard.index, shoves.current);
        shoves.current += 1;
        gust.current = 1;
        gustDir.current = wind;
        setLane((value) => THREE.MathUtils.clamp(value + wind, 0, LANE_COUNT - 1));
      }
    }
    gust.current = Math.max(0, gust.current - delta * 1.6);

    // The forest's fog is the only hazard the WebGL layer cannot borrow from the DOM: the video is
    // behind this canvas, so a screen-space scrim cannot take the distance out of the road and the
    // scenery. It is damped rather than set, so the world closes in and opens out over a second or
    // two instead of switching — the same reason `intensity` is continuous at every phase join.
    const fog = scene.fog as THREE.Fog | null;
    if (fog) {
      const target = hazardFog(hazard, difficulty);
      fog.near = THREE.MathUtils.damp(fog.near, target.near, 2.4, delta);
      fog.far = THREE.MathUtils.damp(fog.far, target.far, 2.4, delta);
    }

    // Keep the generated world and the runner moving together: the camera opens up as the
    // run accelerates, and the video layer scales with the same value. The lateral travel is damped
    // on the same curve the runner's own lane change is, so the body, the camera, and the ground it
    // is stepping across all leave the old lane together and settle together.
    stride.current = THREE.MathUtils.damp(stride.current, LANES[lane] ?? 0, 8, step);
    lateral.current = stride.current / Math.abs(LANES[0]);
    impact.current = Math.max(0, impact.current - delta * 2.2);

    // Half of the step is the runner crossing the frame and half is the ground sweeping under it; see
    // `CAMERA_LATERAL_FOLLOW`. The rig is not re-aimed, so the ground shears with real perspective.
    const cameraX = stride.current * CAMERA_LATERAL_FOLLOW;
    // Two reactions, one dolly: the threaded gap pulls the camera in hard for a moment, and a run in
    // flow sits a little closer the whole time it holds. Both are *position*, never angle — the
    // generated horizon is locked against the field of view, and a dolly changes neither, so the
    // picture the world layer is holding together is untouched.
    const dolly = 11.5 - punch.current * 0.9 - state.flow * 0.35;
    if (impact.current > 0.01) {
      camera.position.set(
        cameraX + Math.sin(clock.elapsedTime * 48) * impact.current * 0.07,
        3.4 - impact.current * 0.3,
        dolly + impact.current * 0.25,
      );
    } else {
      camera.position.set(cameraX, 3.4, dolly);
    }

    publishWorldMotion(
      environment,
      speed * timeScale.current,
      // The gust is folded into the lateral travel the world layer already parallaxes by, so the
      // whole picture leans with the storm while the runner's own ground (the road, the content
      // field) keeps moving straight: the world is being pushed, not the camera.
      lateral.current + gust.current * gustDir.current * 0.18,
      impact.current,
      clock.elapsedTime,
    );

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
    // From here on the world moves on the run's own clock (`step`), which is `delta` except in a
    // threading moment.
    frontier.current += step * speed;
    let spawned = false;
    let guard = 0;
    // The chunk that can ask for two lane changes needs a longer lead-in than the gap alone would
    // give it, and its shape has to be known before it is placed because the gap is what decides
    // where it lands — so it was picked when the gap before it was sized, last frame at the latest.
    if (!upcoming.current) upcoming.current = pickShape(difficulty);
    while (frontier.current > -SPAWN_HORIZON && guard < 8) {
      guard += 1;
      const startZ = frontier.current;
      // A chunk is asked for a pickup when the *distance at which it will be met* has passed the next
      // pickup's distance — not when it is laid, which is a spawn horizon earlier and would put the
      // cadence out by however far ahead the field is built.
      const reachedAt = state.distance + (PLAYER_Z - startZ);
      const wantsPowerup = reachedAt >= nextPowerupAt.current;
      const pattern = buildPattern(
        environment,
        difficulty,
        startZ,
        upcoming.current,
        wantsPowerup,
      );
      if (wantsPowerup) nextPowerupAt.current = reachedAt + POWERUP_SPACING;
      obstacles.current.push(...pattern.obstacles.map((item) => ({ ...item, id: nextId.current++ })));
      coins.current.push(...pattern.coins.map((item) => ({ ...item, id: nextId.current++ })));
      powerups.current.push(...pattern.powerups.map((item) => ({ ...item, id: nextId.current++ })));
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
    laneRef.current = playerLane;

    for (const obstacle of obstacles.current) {
      obstacle.z += step * speed;
      if (obstacle.passed || obstacle.z <= PLAYER_Z) continue;

      obstacle.passed = true;
      const sameLane = obstacle.lane === playerLane;
      const evaded = obstacle.kind === "block" ? jumping : obstacle.kind === "gate" ? sliding : false;
      const adjacent = Math.abs(obstacle.lane - playerLane) === 1;

      if (sameLane && !evaded) {
        // The stumble is the same either way — the runner is hit, visibly — but a shield spends
        // itself instead of the run: no damage, no combo reset, and the pickup's whole job is done in
        // this one branch.
        stumbleSlow.current = 1;
        impact.current = 1;
        setStumbling(true);
        scheduleReset(() => setStumbling(false), STUMBLE_MS);
        publishWorldMotion(environment, speed, lateral.current, 1, clock.elapsedTime, true);

        if (state.shield) {
          state.shield = false;
          onWorldEvent({ ...state, speed }, { type: "powerup_spent", powerup: "shield" });
          continue;
        }

        state.damage += 1;
        state.stumbles += 1;
        state.combo = 0;
        // A hit wipes the flow outright: the meter is the run's *form*, and a hit is the end of it.
        state.flow = 0;
        // The pressure is read against the terms, not the default: a run that took two hits is running
        // hot, and the world should already be leaning on it.
        state.dangerLevel = Math.min(1, state.damage / terms.hits);
        onWorldEvent({ ...state, speed }, {
          type: "damage_taken",
          amount: 1,
          left: Math.max(0, terms.hits - state.damage),
        });

        if (isRunOver(state, terms.hits) && !over.current) {
          over.current = true;
          setDefeated(true);
          recordLine(distance, clock.elapsedTime, true);
          onWorldEvent({ ...state, speed }, { type: "run_ended", score: state.score });
          onRunEnd?.({ ...state, speed }, line.current);
        }
        continue;
      }

      if (sameLane || adjacent) {
        state.nearMisses += 1;
        state.combo += 1;
        /*
         * A near miss in one side lane with another obstacle in the *other* side lane at the same
         * moment is not luck, it is a gap threaded: the run has not merely been close to something,
         * it has chosen the only line through two things at once. It is the one move in a lane-based
         * runner that is a skill rather than a choice, and it is what the slow-motion is for.
         */
        const threaded =
          adjacent &&
          obstacles.current.some(
            (other) =>
              other !== obstacle &&
              Math.abs(other.lane - playerLane) === 1 &&
              other.lane !== obstacle.lane &&
              Math.abs(other.z - obstacle.z) < GAP_METRES,
          );
        if (threaded) {
          state.threads += 1;
          state.flow = Math.min(1, state.flow + FLOW_THREAD * terms.flowScale);
          if (distance >= slowmoReadyAt.current) {
            slowmoReadyAt.current = distance + SLOWMO_COOLDOWN_METRES;
            slowmo.current = SLOWMO_SECONDS;
            punch.current = 1;
          }
          onWorldEvent({ ...state, speed }, { type: "perfect_gap", threads: state.threads });
        } else {
          state.flow = Math.min(1, state.flow + FLOW_NEAR * terms.flowScale);
        }
        onWorldEvent({ ...state, speed }, { type: "near_miss", obstacle: obstacle.kind });
      }
    }

    for (const coin of coins.current) {
      coin.z += step * speed;
      if (coin.collected) continue;
      // Nothing is paid after the run is over. The run coasts to a halt behind its own card, and the
      // road it is coasting over still has coins on it — collected anyway, they would tick the HUD's
      // token count past the number the card filed and the bank paid, which is a mismatch the player
      // can see (measured: a run filed 8 tokens while the HUD went on to 9).
      if (over.current) continue;
      const laneX = LANES[coin.lane];
      // The magnet pulls coins in beside the runner rather than collecting them at a distance: the
      // coin still has to reach them, it just arrives in the lane they are standing in.
      if (state.magnet > 0 && coin.z > PLAYER_Z - MAGNET_RANGE && coin.z < PLAYER_Z + 8) {
        coin.x = THREE.MathUtils.damp(coin.x ?? 0, LANES[playerLane] - laneX, 5, step);
      }
      const offset = laneX + (coin.x ?? 0) - LANES[playerLane];
      const inLane = Math.abs(offset) < 1.1;
      const atPlayer = coin.z > PLAYER_Z - 0.8 && coin.z < PLAYER_Z + 1.4;
      if (!inLane || !atPlayer) continue;
      // High coins are placed on jump arcs, so they have to be caught in the air.
      if (coin.y > 1.7 && !jumping) continue;
      coin.collected = true;
      state.coins += 1;
      state.combo += 1;
      // Tokens pay more the deeper the run goes, so the back half rewards reaching it (see
      // `coinValueAt`). Density is flat on purpose; this is the reward half of the curve. A doubled
      // run doubles what it is paid, here and in the HUD, from the same number.
      const tokenValue =
        coinValueAt(environment, distance) * (state.doubleTokens > 0 ? 2 : 1) * terms.tokenScale;
      state.score += tokenValue;
      onToken?.(tokenValue);
      changed = true;

      const milestone = Math.floor(state.coins / 10);
      if (milestone > lastComboMilestone.current) {
        lastComboMilestone.current = milestone;
        onWorldEvent({ ...state, speed }, { type: "combo_milestone", combo: state.combo });
      }
    }

    for (const pickup of powerups.current) {
      pickup.z += step * speed;
      if (pickup.collected) continue;
      // A pickup taken after the run ended would be a world event for a run that is not running.
      if (over.current) continue;
      // Taken at a run, in the lane it was placed in: a pickup never asks for a move of its own, so
      // there is no jump-or-slide test here the way there is for a high coin.
      if (pickup.lane !== playerLane) continue;
      if (pickup.z <= PLAYER_Z - 0.9 || pickup.z >= PLAYER_Z + 1.6) continue;

      pickup.collected = true;
      if (pickup.kind === "shield") state.shield = true;
      else if (pickup.kind === "magnet") state.magnet = MAGNET_SECONDS;
      else state.doubleTokens = DOUBLE_SECONDS;
      onWorldEvent({ ...state, speed }, { type: "powerup_collected", powerup: pickup.kind });
      changed = true;
    }

    const beforeObstacles = obstacles.current.length;
    const beforeCoins = coins.current.length;
    const beforePowerups = powerups.current.length;
    obstacles.current = obstacles.current.filter((obstacle) => obstacle.z < CULL_Z);
    coins.current = coins.current.filter((coin) => coin.z < CULL_Z);
    powerups.current = powerups.current.filter((pickup) => pickup.z < CULL_Z);
    if (
      obstacles.current.length !== beforeObstacles ||
      coins.current.length !== beforeCoins ||
      powerups.current.length !== beforePowerups
    ) {
      changed = true;
    }
    if (changed) setWorldVersion((version) => version + 1);

    /* ---- the best line, out on the road ----------------------------------------------------------
       The record holds where the best run *was* — its lane at each metre, and the distance it had
       reached at each second — so the ghost is two different things at once, and they answer two
       different questions. The road shows the *line*: a ring and a standing mark in the lane the best
       run held at the metre the player is at now, which is a thing to aim at rather than a rival. The
       HUD carries the *race*: how many metres ahead or behind this run is of the best run at the same
       second, which is the only comparison of two runs that means anything. Neither is invented: both
       read the same quads, so the mark on the road and the number in the HUD cannot disagree. */
    const sample = ghostAt(ghost ?? undefined, distance);
    const ahead = ghostAhead(ghost ?? undefined, distance, clock.elapsedTime);
    ghostStatus.current = sample ? { lane: sample.lane, ahead: ahead ?? 0 } : null;
    const marker = ghostMarker.current;
    if (marker) {
      const shown = Boolean(sample) && !over.current;
      marker.visible = shown;
      if (sample && shown) {
        marker.position.x = THREE.MathUtils.damp(marker.position.x, LANES[sample.lane], 6, delta);
      }
    }
    // Once per run, and once the run is properly under way: the first metres are a launch surge that
    // would beat any line, and a best that is beaten by the dive is not a race the player won.
    if (!ghostFired.current && !over.current && ahead !== undefined && ahead >= 1 && distance > 30) {
      ghostFired.current = true;
      onWorldEvent({ ...state, speed }, { type: "ghost_passed", ahead: Math.round(ahead) });
    }

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
      onProgress?.({ ...state }, ghostStatus.current);
    }

    if (!over.current && Math.floor(distance / 50) > Math.floor(lastEventDistance.current / 50)) {
      lastEventDistance.current = distance;
      onWorldEvent({ ...state }, { type: "distance_milestone", distance });
    }

    if (!over.current && Math.floor(speed) > Math.floor(lastEventSpeed.current)) {
      lastEventSpeed.current = speed;
      if (Math.floor(speed) % 2 === 0) onWorldEvent({ ...state }, { type: "speed_milestone", speed });
    }
  });

  // Defeat holds the stumble pose: the clip plays once and clamps, so this is the run's last frame
  // standing rather than a runner jogging in place behind its own game-over card.
  const animation: PlayerAnimation = defeated
    ? "stumble"
    : stumbling
      ? "stumble"
      : jumping
        ? "jump"
        : sliding
          ? "slide"
          : "run";

  return (
    <>
      <World environment={environment} speedRef={speedRef} />
      <Roadside environment={environment} speedRef={speedRef} />
      <Player lane={lane} characterId={characterId} animation={animation} speedRef={speedRef} />
      {/*
        The best line's mark: a ring on the road in the lane the best run held at this metre, moved
        rather than re-rendered — it is one object, and a React state update per lane change would
        render the whole content field for it. Additive and unlit on purpose: it is a memory of a
        run, not another piece of the world's furniture.

        The ring used to be joined by a soft standing column of light, and that column read as a
        cone-shaped object travelling with the player — which is not what a lane marker should look
        like. The mark is the flat ring that says where the best line was; the race itself is the
        HUD's number.
      */}
      <group ref={ghostMarker} position={[LANES[1], 0, PLAYER_Z]} visible={false}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
          <ringGeometry args={[0.62, 1.02, 28]} />
          <meshBasicMaterial
            color="#8ffbe0"
            transparent
            opacity={0.4}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      </group>
      {/* The name carries the world version so a spawn or cull re-renders the list without
          remounting the pieces that are already in flight. */}
      <group name={`world-${worldVersion}`}>
        {obstacles.current.map((obstacle) => (
          <ObstaclePiece key={obstacle.id} obstacle={obstacle} environment={environment} />
        ))}
        {coins.current.map((coin) => (
          <CoinPiece key={coin.id} coin={coin} environment={environment} />
        ))}
        {powerups.current.map((pickup) => (
          <PowerupPiece key={pickup.id} pickup={pickup} />
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
      onCreated={({ camera, scene }) => {
        camera.lookAt(...CAMERA_TARGET);
        // The fog exists from the first frame, parked past anything the run can see, and the forest's
        // hazard only pulls it in. Adding a fog when the fog arrives would recompile every material it
        // touches — a hitch in the middle of the hazard that is supposed to be a change of visibility,
        // not a stutter. The colour is this world's own ambient light, so the 3D layer fogs towards
        // what the world's air is lit like rather than towards a grey of the game's own.
        scene.fog = new THREE.Fog(new THREE.Color(environmentLook[props.environment].ambient), 700, 1200);
      }}
    >
      {/* Keyed by attempt: the restart is a remount of the simulation, so a new run cannot inherit a
          single thing from the last one — not a coin in flight, not a timer, not the damage taken. */}
      <RunnerSimulation key={props.attempt ?? 0} {...props} />
    </Canvas>
  );
}
