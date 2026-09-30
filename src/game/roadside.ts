import type { Environment } from "./run-state";
import { environmentLook } from "./world-look";
import { panelAnchor, type PropId, type PropMetrics } from "./roadside-props";

/**
 * What stands beside the road.
 *
 * The game's own ground runs out at the apron's banks, and everything past that is the generated
 * world on its own — a distant landscape with nothing in the space between it and the road. That
 * space is where speed is actually read: the eye judges pace by what passes *closely*, and with only
 * the road ribbon scrolling, the run reads as a treadmill in front of a painted backdrop.
 *
 * So the roadside is scenery the run moves past: props on both sides, scrolling at the road's own
 * speed and recycling far ahead of the runner. It is built from the shapes in `roadside-props` — an
 * adobe house and mesas in the desert, conifers and fallen logs in the forest, apartment blocks,
 * street lights and lit signs in the city — because a box scaled to a different size still reads as a
 * box, and at 30 m/s that is all the eye has time to get.
 *
 * ## Not free-standing: it belongs to the game, not to Orbis
 *
 * Orbis produces video and audio; it cannot produce geometry. Everything here is ours. What Orbis
 * contributes is the *picture* on the panels, and that is the interesting part: `src/orbis/world-frame`
 * samples the live generated world out of its own stream, and the panels show it. A billboard in the
 * city ends up showing the city the player is steering through, changing as the place changes.
 *
 * ## The layout is data, and the scroll is not
 *
 * Nothing here knows about frames. A plan is a list of props at fixed offsets in a repeating cycle of
 * Z; the scene wraps those offsets by the distance travelled every frame (see the `Roadside`
 * component). That is what makes recycling invisible: no spawning, no culling list, no React state
 * churn — a piece that leaves the far end of the cycle has already reappeared behind the runner, and
 * the seam is 105 m away inside the far taper.
 *
 * The plan is seeded per world rather than random per run, so a world is the same place every time it
 * is visited. Variety between runs is what the content field is for; the desert skyline being
 * different every run would just make the world feel unreliable.
 */

/**
 * The band of Z the roadside occupies, and the length of one cycle of it.
 *
 * `NEAR` sits just behind the camera, so a piece is out of frame before it wraps; `FAR` is as far as
 * the apron is still solid enough to stand something on. Anything beyond it would be a prop floating
 * over a transparent ground, which is the one error the eye catches immediately at speed.
 *
 * The cycle was 75 m, ending 58 m ahead of the origin, and 58 m turns out to be inside the part of
 * the road the eye is still reading: a piece arrived at that distance at full size and finished
 * growing while it was still near the middle of the frame, which is what made the scenery look like
 * it was appearing out of nowhere rather than standing there all along. It is now 105 m, ending 88 m
 * out, and the apron's own fade has been carried out to meet it (see the terrain constants in the
 * scene) so the far end of the cycle stands on ground that is still faintly there.
 */
export const ROADSIDE_NEAR_Z = 17;
export const ROADSIDE_FAR_Z = -88;
export const ROADSIDE_CYCLE = ROADSIDE_NEAR_Z - ROADSIDE_FAR_Z;

/**
 * Depth over which a piece shrinks away at the far end, in metres from `ROADSIDE_FAR_Z`.
 *
 * A recycle has to be hidden, and the far end is where there is nothing to hide it behind: at 105 m
 * the apron's alpha is nearly gone and the world's own haze is thin. So a piece is scaled down into
 * its own footprint as it approaches the end of the cycle and is a speck well before it wraps — it
 * *sinks* rather than pops, and the seam is never a visible event.
 *
 * Widened with the cycle: 24 m of growth instead of 12 m, so a piece reaches its full size far enough
 * ahead that the eye has long since accepted it as part of the landscape. The scale is still a cheat —
 * the piece is the right size at the wrong distance — but the distances at which it is applied are now
 * all beyond the point where anything about a prop's size can be read.
 */
const ROADSIDE_TAPER_Z = -64;

/**
 * How far into its own height a piece is set into the ground.
 *
 * The apron's height is a field, but the mesh drawn from it is 2.5 m across per quad: a piece resting
 * exactly on the field's value at its own centre is a piece hovering over, or buried in, the facet it
 * is actually standing on. A little depth absorbs the difference — and a boulder or an adobe with its
 * foot in the ground is what both of them look like anyway.
 */
const ROADSIDE_SINK = 0.08;

const TAU = Math.PI * 2;

/** One piece of scenery, at a fixed offset in the cycle. */
export type RoadsideProp = {
  /** Which prop this is — a hand-built kind, or a model out of one of the packs. */
  id: PropId;
  /** Centre across the road. Always on the far side of its row's clearance. */
  x: number;
  /** Offset into the cycle, not a world Z: the scene wraps it by distance travelled. */
  offset: number;
  /** One number, because the shapes are authored at natural size with their bases at zero. */
  scale: number;
  /** Radians about the vertical, through the piece's base. */
  yaw: number;
  /** Per-instance tint, multiplied into the colours baked into the geometry. */
  color: string;
};

/**
 * A lit panel, and where it sits.
 *
 * Everything is already in metres for the piece it belongs to — its offset into the cycle, how high
 * above the piece's base its centre is, how far in front of the piece's own centre it stands, and its
 * size — so the scene only has to follow one piece's transform rather than compose a second one.
 */
export type RoadsidePanel = {
  x: number;
  offset: number;
  y: number;
  z: number;
  width: number;
  height: number;
  /** How deep the piece it is mounted on is set into the ground, so the panel sinks with it. */
  sink: number;
  color: string;
};

export type RoadsidePlan = {
  /**
   * The pieces, per kind — one list per kind because that is how they are drawn: one geometry, one
   * material, one instanced mesh, whatever a world decides to put beside the road.
   */
  props: Map<PropId, RoadsideProp[]>;
  panels: RoadsidePanel[];
};

type Range = readonly [number, number];

/**
 * One row of pieces down one side.
 *
 * `inner` is a clearance, not a position: the nearest *edge* of any prop in the row is held this far
 * from the road centre, so a bigger prop moves outwards instead of reaching across the shoulder. That
 * makes the road's clearance a property of the row rather than a consequence of the sizes the shapes
 * happen to have been given, which is what keeps the scenery from ever standing in a lane. The
 * clearance is measured off the geometry rather than declared here, so moving an arm on the cactus
 * moves the clearance with it.
 */
type Row = {
  /**
   * What this row can be built from, in order of preference.
   *
   * A row drawn from models bought for the world names them; a row that is the game's own furniture
   * names the one shape it has always been. Where a row names both, the first group with anything
   * available is the one used — which is what a world falls back on when a pack does not load, rather
   * than starting a run with nothing on that side of the road.
   */
  variants: PropId[];
  /** Used only when nothing in `variants` is available. */
  fallback?: PropId[];
  /**
   * The clearance this row's pieces are held to, in metres from the road centre.
   *
   * A property of the row rather than of the prop, so the roadside can be retuned by moving one
   * number: widening the shoulder, or standing the buildings back, is this and nothing else.
   */
  inner: number;
  /** Metres between pieces along Z. */
  spacing: number;
  scale: Range;
  /** Enough offset that two rows on the same side never line up into a wall. */
  stagger?: number;
  /** Extra jitter on top of the piece's own footprint, so a row is not a ruled line. */
  margin?: number;
  /** Chance a piece is dropped, thinning a row without disturbing its rhythm. */
  skip?: number;
  /** A few smaller pieces tucked around the main one, so a scatter reads as ground. */
  cluster?: { extra: Range; spread: number; scale: Range };
  /** Per-instance tints. Never darker than about 0.85: a tint is variation, not a second palette. */
  tints: string[];
  /** Chance a piece carries a lit panel. Only does anything on the kinds with a panel anchor. */
  panel?: number;
  /**
   * Which way the pieces face. Unset is straight down the road — what signage and buildings want.
   * `scatter` is a random yaw, for stones and trees; `inward` turns the piece's long arm toward the
   * road, which is what puts the city's street lights over the shoulder on both sides.
   */
  facing?: "scatter" | "inward";
};

/**
 * The trees the forest is built from, in the order a row prefers them.
 *
 * Listed here rather than inside each row because two rows stand them at different sizes, and a
 * forest whose near trees and far trees came from different lists would look like two places.
 */
const TREES = [
  "tree-stylized-04-green",
  "tree-stylized-01",
  "tree-stylized-05-autumn-brown",
  "tree-stylized-03-autumn-yellow",
  "tree-stylized-02-dry",
];

type Recipe = {
  rows: Row[];
  /** Panel tints. The picture on them is the live world; this is the coat of light over it. */
  panelColors: string[];
  seed: number;
};

const RECIPES: Record<Environment, Recipe> = {
  desert: {
    seed: 1_409,
    panelColors: ["#f0c184", "#ffd489", "#ffb066"],
    rows: [
      // Stones at the shoulder: the nearest thing to the runner, and the row that carries the speed.
      {
        variants: ["Rock-10", "Rock-11", "Rock-14", "Rock-15", "Rock-2"],
        fallback: ["rock"],
        inner: 6.4,
        spacing: 8,
        scale: [0.45, 1.6],
        margin: 1.3,
        facing: "scatter",
        cluster: { extra: [1, 2], spread: 1.5, scale: [0.3, 0.8] },
        tints: ["#ffffff", "#f0e2d0", "#e2cfb6"],
      },
      // Boulders past the stones, so the scatter has a size range rather than one grain of rubble.
      {
        variants: ["Rock-9", "Rock-12", "Rock-13", "Rock-3"],
        fallback: ["rock"],
        inner: 9.6,
        spacing: 19,
        scale: [1.4, 3.6],
        stagger: 4,
        margin: 1.7,
        facing: "scatter",
        tints: ["#ffffff", "#eedfca", "#dcc8ac"],
      },
      // Adobe out in the sand. Two a side a cycle, so a house is an event rather than a suburb.
      {
        variants: ["house"],
        inner: 9.2,
        spacing: 38,
        scale: [4.4, 7.2],
        stagger: 11,
        margin: 1.8,
        panel: 0.6,
        tints: ["#ffffff", "#efe0cb", "#f6ecdc"],
      },
      // Cacti standing on their own: tall, thin, and the fastest thing in the world to read.
      {
        variants: ["cactus"],
        inner: 7.2,
        spacing: 19,
        scale: [1.9, 3.1],
        stagger: 5,
        margin: 1.3,
        facing: "scatter",
        tints: ["#ffffff", "#e7f0dd", "#f2e8d6"],
      },
      // Signs at the shoulder, where a board belongs.
      {
        variants: ["sign"],
        inner: 6.6,
        spacing: 30,
        scale: [1.9, 2.8],
        stagger: 16,
        margin: 1.2,
        panel: 0.85,
        tints: ["#ffffff", "#f4e6d2"],
      },
      // Outcrops away out: the landform, rather than anything built. Two of the pack's rocks are as
      // big as a hill, and standing them out here is what the desert gets instead of a skyline.
      {
        variants: ["Rock-1", "Rock-5", "Rock-6", "Rock-7", "Rock-8"],
        fallback: ["butte"],
        inner: 22,
        spacing: 26,
        scale: [5, 12],
        stagger: 6,
        margin: 2.6,
        tints: ["#ffffff", "#eadcc9", "#dcc9b2"],
      },
    ],
  },
  city: {
    seed: 2_611,
    panelColors: ["#51e4ff", "#8ff2ff", "#2f9fc4"],
    rows: [
      // Street lights first: nothing in the city passes closer, and they do the speed.
      {
        variants: ["lamp"],
        inner: 6.2,
        spacing: 11,
        scale: [4.2, 5.2],
        stagger: 4,
        margin: 1.0,
        facing: "inward",
        tints: ["#ffffff", "#eef3f8", "#e2e8ef"],
      },
      // The near blocks: the houses and shopfronts out of the city pack, which are the buildings the
      // player actually passes. Whoever authored them is the one thing here the game did not draw.
      {
        variants: [
          "Cube-045",
          "Cube-047",
          "MUSICSTORE-LOD1-001",
          "MUSICSTORE-LOD1-003",
          "Cube-191",
          "Cube-224",
        ],
        fallback: ["block"],
        inner: 7.4,
        spacing: 12,
        scale: [3.4, 8.6],
        margin: 1.2,
        tints: ["#ffffff", "#e8eef4", "#dbe4ec"],
      },
      // Kerbside clutter: a bin and a bench, at the small end of the pack's street furniture.
      {
        variants: ["Can", "banca-01-004"],
        fallback: ["crate"],
        inner: 6.8,
        spacing: 17,
        scale: [1.3, 2.0],
        stagger: 9,
        margin: 1.0,
        facing: "scatter",
        cluster: { extra: [1, 1], spread: 0.9, scale: [0.8, 1.4] },
        tints: ["#ffffff", "#e9eff5"],
      },
      // A billboard at eye level, big enough to hold a picture of the world it stands in.
      {
        variants: ["billboard"],
        inner: 7.8,
        spacing: 26,
        scale: [3.8, 5.2],
        stagger: 13,
        margin: 1.4,
        panel: 0.95,
        tints: ["#ffffff"],
      },
      // And the same sign again on a roof, above the traffic.
      {
        variants: ["rooftop"],
        inner: 8.4,
        spacing: 34,
        scale: [4.2, 6.4],
        stagger: 5,
        margin: 1.6,
        panel: 0.9,
        tints: ["#ffffff", "#eaf0f6"],
      },
      // The far skyline, doing the depth work behind them. The pack's tall, narrow blocks stand out
      // here; its wide ones are what the near row is for.
      {
        variants: ["Cube-095", "Cube-018", "Cube-028", "Cube-044", "Cube-051"],
        fallback: ["tower"],
        inner: 19,
        spacing: 14,
        scale: [6, 12],
        stagger: 5.2,
        margin: 1.8,
        tints: ["#ffffff", "#dfe7ef", "#cfdae4"],
      },
    ],
  },
  forest: {
    seed: 3_803,
    panelColors: ["#9af29d", "#b6ff9e"],
    rows: [
      // The trees themselves. The densest row of any world, because that is what a forest is.
      {
        variants: TREES,
        fallback: ["conifer"],
        inner: 6.8,
        spacing: 7,
        scale: [4.5, 9],
        margin: 1.4,
        facing: "scatter",
        tints: ["#ffffff", "#eaf3ea", "#dcece0"],
      },
      // A second, taller stand of the same trees further out: the trunks are read against it.
      {
        variants: TREES,
        fallback: ["broadleaf"],
        inner: 13.5,
        spacing: 13,
        scale: [5.5, 11],
        stagger: 4,
        margin: 2,
        facing: "scatter",
        tints: ["#ffffff", "#eef5e8", "#e0eedd"],
      },
      // Stones between them, where the trunks stop.
      {
        variants: ["Rock-11", "Rock-14", "Rock-15", "Rock-9", "Rock-2"],
        fallback: ["rock"],
        inner: 6.5,
        spacing: 13,
        scale: [0.35, 1.1],
        stagger: 3,
        margin: 1.2,
        facing: "scatter",
        cluster: { extra: [1, 2], spread: 1.2, scale: [0.25, 0.7] },
        tints: ["#ffffff", "#e6eae4", "#d6ddd6"],
      },
      // Fallen timber at the shoulder: the closest thing to the runner in this world.
      {
        variants: ["log"],
        inner: 6.9,
        spacing: 21,
        scale: [2.2, 4.2],
        stagger: 8,
        margin: 1.1,
        facing: "scatter",
        tints: ["#ffffff", "#f0e9e0", "#e4dbd0"],
      },
      {
        variants: ["stump"],
        inner: 6.4,
        spacing: 16,
        scale: [1.6, 2.8],
        stagger: 5,
        margin: 1.0,
        facing: "scatter",
        tints: ["#ffffff", "#eee7dd"],
      },
      // Trail markers: thin, mostly panel, so the picture on them can actually be seen.
      {
        variants: ["marker"],
        inner: 7.4,
        spacing: 26,
        scale: [2.2, 3.2],
        stagger: 14,
        margin: 1.1,
        panel: 0.8,
        tints: ["#ffffff", "#eaf2ea"],
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
 * A cycle offset as a world Z, given how far the run has travelled. Wrapped, never clamped.
 *
 * Exported because the scene is the thing that knows how far the run has gone, and the wrapping is
 * the one part of the layout it applies per frame — a second copy of it in the renderer is exactly
 * the kind of duplicate that drifts.
 */
export function roadsideZ(offset: number, travel: number): number {
  const wrapped = (offset + travel) % ROADSIDE_CYCLE;
  return ROADSIDE_FAR_Z + (wrapped < 0 ? wrapped + ROADSIDE_CYCLE : wrapped);
}

/**
 * How much of its size a piece at world Z has, from 0 (vanished) to 1 (full size).
 *
 * The scene applies this per frame, so it lives here with the layout for the same reason `roadsideZ`
 * does: the taper is a property of the cycle, not of the renderer.
 */
export function roadsideTaper(z: number): number {
  const span = ROADSIDE_TAPER_Z - ROADSIDE_FAR_Z;
  const through = (z - ROADSIDE_FAR_Z) / span;
  return through <= 0 ? 0 : through >= 1 ? 1 : through;
}

/** How deep a piece of this height is set into the ground. Proportional, so a piece shrinking into the
 * far taper meets the ground exactly rather than hovering over it. */
export function roadsideSink(height: number): number {
  return height * ROADSIDE_SINK;
}

/**
 * The roadside for a world, in cycle offsets.
 *
 * Both sides are the same recipe with independent jitter, so the road is lined rather than mirrored —
 * a mirrored roadside is visible as a symmetry, and symmetry is the one thing a random landscape never
 * has.
 */
export function planRoadside(
  environment: Environment,
  available: ReadonlyMap<PropId, PropMetrics>,
): RoadsidePlan {
  const recipe = RECIPES[environment];
  const random = seededRandom(recipe.seed);
  const between = (range: Range) => range[0] + random() * (range[1] - range[0]);
  const pick = (colors: string[]) => colors[Math.min(colors.length - 1, Math.floor(random() * colors.length))];
  const wrap = (offset: number) => ((offset % ROADSIDE_CYCLE) + ROADSIDE_CYCLE) % ROADSIDE_CYCLE;

  const props: RoadsidePlan["props"] = new Map();
  const panels: RoadsidePanel[] = [];
  const place = (prop: RoadsideProp) => {
    const list = props.get(prop.id);
    if (list) list.push(prop);
    else props.set(prop.id, [prop]);
  };

  for (const side of [-1, 1]) {
    for (const row of recipe.rows) {
      // What this row can be built from: the models it prefers, or the shapes it falls back to when a
      // world's packs did not load. A row with neither is simply not laid out.
      const preferred = row.variants.filter((id) => available.has(id));
      const pool = preferred.length > 0 ? preferred : (row.fallback ?? []).filter((id) => available.has(id));
      if (pool.length === 0) continue;

      const count = Math.max(1, Math.round(ROADSIDE_CYCLE / row.spacing));

      for (let index = 0; index < count; index += 1) {
        if (row.skip !== undefined && random() < row.skip) continue;

        // One variant per piece, so a row of boulders is a scatter of shapes rather than the same
        // rock repeated — the seeded draw keeps it the same scatter every time the world is planned.
        const id = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
        const metrics = available.get(id);
        if (!metrics) continue;

        const jitter = (random() - 0.5) * row.spacing * 0.4;
        const offset = wrap(index * row.spacing + (row.stagger ?? 0) + jitter);
        const scale = between(row.scale);
        // Positioned from the inner clearance outwards, so even the widest piece can never reach the
        // shoulder, however the shapes are later redrawn.
        const x = side * (row.inner + scale * metrics.radius + random() * (row.margin ?? 1.2));
        const yaw =
          row.facing === "scatter"
            ? random() * TAU
            : row.facing === "inward"
              ? // Mirrored, so the arm reaches the road from whichever side it stands on.
                (side > 0 ? Math.PI : 0)
              : 0;

        place({ id, x, offset, scale, yaw, color: pick(row.tints) });

        if (row.cluster) {
          const extra = Math.round(between(row.cluster.extra));
          for (let piece = 0; piece < extra; piece += 1) {
            const nearby = between(row.cluster.scale);
            place({
              id,
              // Outwards only, and never closer than the cluster piece's own footprint.
              x: x + side * (nearby * metrics.radius + random() * row.cluster.spread),
              offset: wrap(offset + (random() - 0.5) * row.cluster.spread * 2),
              scale: nearby,
              yaw: random() * TAU,
              color: pick(row.tints),
            });
          }
        }

        // Panels only ever go on a piece standing square to the road: a panel on a turned piece would
        // face away from the runner, and the picture on it is the point of it. Only the game's own
        // frames carry a panel, so a row of bought rocks can never be asked for one.
        const anchor = panelAnchor(id);
        if (anchor && row.panel !== undefined && yaw === 0 && random() < row.panel) {
          panels.push({
            x: x + anchor.x * scale,
            offset,
            y: anchor.y * scale,
            z: anchor.z * scale,
            width: anchor.width * scale,
            height: anchor.height * scale,
            sink: roadsideSink(metrics.height * scale),
            color: pick(recipe.panelColors),
          });
        }
      }
    }
  }

  return { props, panels };
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
