import type { Environment } from "./run-state";
import { environmentLook } from "./world-look";

/**
 * What stands beside the road.
 *
 * The game's own ground runs out at the apron's banks, and everything past that has been the
 * generated world on its own — a distant landscape with nothing in the space between it and the road.
 * That space is where speed is actually read: the eye judges pace by what passes *closely*, and with
 * only the road ribbon scrolling, the run reads as a treadmill in front of a painted backdrop.
 *
 * So the roadside is scenery the run moves past: blocks of it on both sides, scrolling at the road's
 * own speed and recycling far ahead of the runner. It is deliberately built out of boxes — one unit
 * cube, scaled per piece — because that is the shape that survives being seen for a fraction of a
 * second at 30 m/s, and because a box has an honest front face for a lit panel to sit on (see
 * `RoadsidePoster`).
 *
 * ## Not free-standing: it belongs to the game, not to Orbis
 *
 * Orbis produces video and audio; it cannot produce geometry. Everything here is ours. What Orbis
 * contributes is the *picture* on the panels, and that is the interesting part: `src/orbis/world-frame`
 * samples the live generated world out of its own stream, and the panels show it. The roadside ends up
 * surfaced with the world the player is steering — a poster of the place you are running through,
 * changing as the place changes.
 *
 * ## The layout is data, and the scroll is not
 *
 * Nothing here knows about frames. A plan is a list of boxes at fixed offsets in a repeating cycle of
 * Z; the scene wraps those offsets by the distance travelled every frame (see the `Roadside`
 * component). That is what makes recycling invisible: no spawning, no culling list, no React state
 * churn — a piece that leaves the far end of the cycle has already reappeared behind the runner, and
 * the seam is 75 m away inside the far taper.
 *
 * The plan is seeded per world rather than random per run, so a world is the same place every time
 * it is visited. Variety between runs is what the content field is for; the desert skyline being
 * different every run would just make the world feel unreliable.
 */

/**
 * The band of Z the roadside occupies, and the length of one cycle of it.
 *
 * `NEAR` sits just behind the camera, so a piece is out of frame before it wraps; `FAR` is as far as
 * the apron is still solid enough to stand a building on. Anything beyond it would be a box floating
 * over a transparent ground, which is the one error the eye catches immediately at speed.
 */
export const ROADSIDE_NEAR_Z = 17;
export const ROADSIDE_FAR_Z = -58;
export const ROADSIDE_CYCLE = ROADSIDE_NEAR_Z - ROADSIDE_FAR_Z;

/**
 * Depth over which a piece shrinks away at the far end, in metres from `ROADSIDE_FAR_Z`.
 *
 * A recycle has to be hidden, and the far end is where there is nothing to hide it behind: at 75 m
 * the apron's alpha is nearly gone and the world's own haze is thin. So a piece is scaled down into
 * its own footprint as it approaches the end of the cycle and is a speck well before it wraps —
 * it *sinks* rather than pops, and the seam is never a visible event.
 */
const ROADSIDE_TAPER_Z = -46;

/**
 * Where a piece's base sits.
 *
 * The apron rises into banks either side of the road (up to 1.8 m at the outer rows), so a base at
 * y=0 would leave the outer pieces hovering. Rather than duplicate the bank's height field — a second
 * copy of that formula is a second thing to keep in step — the base is set low enough to bury the
 * foot of every piece in the bank it stands on. Sunk is invisible; floating is not.
 */
export const ROADSIDE_BASE_Y = 0.45;

export type RoadsideMass = {
  /** Centre of the box across the road. Always on the far side of `inner`. */
  x: number;
  /** Offset into the cycle, not a world Z: the scene wraps it by distance travelled. */
  offset: number;
  baseY: number;
  width: number;
  height: number;
  depth: number;
  color: string;
};

export type RoadsidePoster = {
  /** Centre of the panel, which is always the camera-facing face of a mass. */
  x: number;
  offset: number;
  /** Centre height at full size, and the base it is lifted from — see the taper in the scene. */
  y: number;
  baseY: number;
  width: number;
  height: number;
  color: string;
};

export type RoadsidePlan = {
  masses: RoadsideMass[];
  posters: RoadsidePoster[];
};

/**
 * How far through the cycle a piece at world Z is, from 0 (vanished) to 1 (full size).
 *
 * Exported because the taper is the one piece of the layout the scene has to apply per frame, and a
 * second copy of it in the renderer is exactly the kind of duplicate that drifts.
 */
export function roadsideTaper(z: number): number {
  const span = ROADSIDE_TAPER_Z - ROADSIDE_FAR_Z;
  const through = (z - ROADSIDE_FAR_Z) / span;
  return through <= 0 ? 0 : through >= 1 ? 1 : through;
}

/** A cycle offset as a world Z, given how far the run has travelled. Wrapped, never clamped. */
export function roadsideZ(offset: number, travel: number): number {
  const wrapped = (offset + travel) % ROADSIDE_CYCLE;
  return ROADSIDE_FAR_Z + (wrapped < 0 ? wrapped + ROADSIDE_CYCLE : wrapped);
}

type Range = readonly [number, number];

/**
 * One row of pieces down one side.
 *
 * `inner` is a clearance, not a position: the nearest *edge* of any piece in the row is held this far
 * from the road centre, so widening a piece moves it outwards instead of reaching across the
 * shoulder. That makes the road's clearance a property of the row rather than a consequence of the
 * random sizes, which is what keeps the scenery from ever standing in a lane.
 */
type Row = {
  inner: number;
  /** Metres between pieces along Z. */
  spacing: number;
  height: Range;
  width: Range;
  depth: Range;
  colors: string[];
  /** Chance a piece in this row carries a lit panel on its camera-facing side. */
  poster: number;
  /** The panel's size, as a fraction of its piece. */
  posterScale?: readonly [number, number];
  /** Enough offset that two rows on the same side never line up into a wall. */
  stagger: number;
  /** A second box standing on the first — a canopy on a trunk. Its base is `at` up the trunk. */
  stack?: {
    at: number;
    height: Range;
    width: Range;
    depth: Range;
    colors: string[];
  };
};

type Recipe = {
  rows: Row[];
  /** Panel tints. The picture on them is the live world; this is the coat of light over it. */
  posterColors: string[];
  seed: number;
};

const RECIPES: Record<Environment, Recipe> = {
  desert: {
    seed: 1_409,
    posterColors: ["#f0c184", "#ffd489", "#ffb066"],
    rows: [
      // Adobe blocks and fallen walls, close to the shoulder.
      {
        inner: 6.8,
        spacing: 13,
        height: [1.8, 4.2],
        width: [2.6, 5.2],
        depth: [2.2, 4.4],
        colors: ["#8d5533", "#a06a41", "#75432a"],
        poster: 0.45,
        stagger: 0,
      },
      // Standing pillars: the tall ones, so the row has a skyline instead of a fence line.
      {
        inner: 7.8,
        spacing: 21,
        height: [5.4, 8.6],
        width: [1.5, 2.6],
        depth: [1.5, 2.8],
        colors: ["#a8693c", "#c98a5a"],
        poster: 0.25,
        stagger: 7.5,
      },
      // Mesas further out: long, low, and read as the landform rather than as anything built.
      {
        inner: 15,
        spacing: 17,
        height: [2.4, 6.4],
        width: [6, 14],
        depth: [5, 10],
        colors: ["#7d4629", "#96603d", "#6a3b24"],
        poster: 0,
        stagger: 3.4,
      },
    ],
  },
  city: {
    seed: 2_611,
    posterColors: ["#51e4ff", "#8ff2ff", "#2f9fc4"],
    rows: [
      // The near blocks. Tall enough to read as buildings, close enough to pass quickly.
      {
        inner: 6.6,
        spacing: 11,
        height: [4.5, 10.5],
        width: [3.4, 7],
        depth: [3.4, 6.5],
        colors: ["#2b3440", "#39424f", "#22303c"],
        poster: 0.72,
        stagger: 0,
      },
      // The far skyline, doing the depth work behind them.
      {
        inner: 16,
        spacing: 13,
        height: [7, 15],
        width: [5, 11],
        depth: [5, 9],
        colors: ["#182533", "#283c4e", "#2b3440"],
        poster: 0,
        stagger: 5.2,
      },
    ],
  },
  forest: {
    seed: 3_803,
    posterColors: ["#9af29d", "#b6ff9e"],
    rows: [
      // Trunks with a canopy stacked on top: the only row that is two boxes per piece.
      {
        inner: 7.2,
        spacing: 9,
        height: [5.5, 9],
        width: [0.7, 1.2],
        depth: [0.7, 1.2],
        colors: ["#6b4a2f", "#573d27"],
        poster: 0,
        stagger: 0,
        stack: {
          at: 0.5,
          height: [3.2, 5.4],
          width: [4.2, 7.6],
          depth: [4.2, 7.6],
          colors: ["#244835", "#1f5540", "#173429"],
        },
      },
      // The far wall of canopy that the near trunks are read against.
      {
        inner: 17,
        spacing: 20,
        height: [4, 9],
        width: [7, 14],
        depth: [6, 12],
        colors: ["#173429", "#244835"],
        poster: 0,
        stagger: 6,
      },
      // Trail markers: thin panels, mostly panel, so the picture on them can actually be seen.
      {
        inner: 8.4,
        spacing: 34,
        height: [2.2, 3.2],
        width: [2.4, 3.6],
        depth: [0.4, 0.6],
        colors: ["#4a5a4f"],
        poster: 0.9,
        posterScale: [0.86, 0.72],
        stagger: 12,
      },
    ],
  },
};

/** Small, fast, and seeded: the layout has to be identical every time a world is planned. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * The roadside for a world, in cycle offsets.
 *
 * Both sides are the same recipe with independent jitter, so the road is lined rather than mirrored —
 * a mirrored roadside is visible as a symmetry, and symmetry is the one thing a random landscape never
 * has.
 */
export function planRoadside(environment: Environment): RoadsidePlan {
  const recipe = RECIPES[environment];
  const random = seededRandom(recipe.seed);
  const between = (range: Range) => range[0] + random() * (range[1] - range[0]);
  const pick = (colors: string[]) => colors[Math.min(colors.length - 1, Math.floor(random() * colors.length))];

  const masses: RoadsideMass[] = [];
  const posters: RoadsidePoster[] = [];

  for (const side of [-1, 1]) {
    for (const row of recipe.rows) {
      const count = Math.max(1, Math.round(ROADSIDE_CYCLE / row.spacing));
      for (let index = 0; index < count; index += 1) {
        const jitter = (random() - 0.5) * row.spacing * 0.36;
        const offset = ((index * row.spacing + row.stagger + jitter) % ROADSIDE_CYCLE + ROADSIDE_CYCLE) % ROADSIDE_CYCLE;
        const width = between(row.width);
        const height = between(row.height);
        const depth = between(row.depth);
        // Positioned from the inner clearance outwards, so a wide piece can never reach the shoulder.
        const x = side * (row.inner + width / 2 + random() * 1.4);
        const mass: RoadsideMass = {
          x,
          offset,
          baseY: ROADSIDE_BASE_Y,
          width,
          height,
          depth,
          color: pick(row.colors),
        };
        masses.push(mass);

        if (row.stack && random() < 0.9) {
          masses.push({
            x: x + (random() - 0.5) * 1.2,
            offset: offset + (random() - 0.5) * 1.6,
            baseY: ROADSIDE_BASE_Y + height * row.stack.at,
            width: between(row.stack.width),
            height: between(row.stack.height),
            depth: between(row.stack.depth),
            color: pick(row.stack.colors),
          });
        }

        if (row.poster > 0 && random() < row.poster) {
          const [across, tall] = row.posterScale ?? [0.6, 0.42];
          posters.push({
            x: mass.x,
            // The camera looks toward -Z, so +Z is the face it sees. The panel floats a few
            // centimetres proud of that face rather than sharing it, which is what keeps the two from
            // fighting for the same depth buffer.
            offset: mass.offset + mass.depth / 2 + 0.05,
            y: mass.baseY + mass.height * 0.58,
            baseY: mass.baseY,
            width: mass.width * across,
            height: Math.min(4.5, Math.max(0.8, mass.height * tall)),
            color: pick(recipe.posterColors),
          });
        }
      }
    }
  }

  return { masses, posters };
}

/**
 * The panel's picture when there is no live world to put on it.
 *
 * A lit panel with nothing on it is a black rectangle, and a run in local world mode — or the first
 * seconds of one, before Orbis has produced a frame — would be scattered with them. So each world
 * gets an abstract poster of its own: a lit band, a couple of overprinted blocks, and scan lines, all
 * in the world's palette. It is deliberately not a picture of anything, because it is standing in for
 * a picture of somewhere the player has not been shown yet.
 */
export function createPosterArt(environment: Environment): HTMLCanvasElement {
  const look = environmentLook[environment];
  const width = 192;
  const height = 108;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return canvas;

  const random = seededRandom(RECIPES[environment].seed + 97);
  const ground = environment === "desert" ? "#2a1a12" : environment === "city" ? "#0a1119" : "#0b1a13";
  context.fillStyle = ground;
  context.fillRect(0, 0, width, height);

  context.globalAlpha = 0.5;
  context.fillStyle = look.base;
  context.fillRect(0, height * 0.62, width, height * 0.38);
  context.globalAlpha = 1;

  for (let block = 0; block < 5; block += 1) {
    context.globalAlpha = 0.18 + random() * 0.3;
    context.fillStyle = block % 2 ? look.grain : look.block;
    const blockWidth = 12 + random() * 46;
    context.fillRect(random() * width, 8 + random() * height * 0.5, blockWidth, 6 + random() * 22);
  }
  context.globalAlpha = 1;

  // The lit band, and the horizon it is pretending to be: the one thing that says "sign" at a glance.
  const bandY = height * 0.44;
  const gradient = context.createLinearGradient(0, bandY - 14, 0, bandY + 22);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(0.5, look.line);
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  context.globalAlpha = 0.75;
  context.fillStyle = gradient;
  context.fillRect(0, bandY - 14, width, 36);
  context.globalAlpha = 1;

  context.fillStyle = "#05090b";
  for (let line = 0; line < height; line += 3) context.fillRect(0, line, width, 1);

  context.strokeStyle = look.edge;
  context.lineWidth = 3;
  context.strokeRect(1.5, 1.5, width - 3, height - 3);

  return canvas;
}
