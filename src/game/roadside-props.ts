import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Environment } from "./run-state";
import { environmentLook, type EnvironmentLook } from "./world-look";

/**
 * The shapes the roadside is built out of.
 *
 * The first roadside was one box: every mass was the same unit cube scaled to a different size, and
 * the only thing that said "desert" rather than "city" was the colour it was multiplied by. That is
 * cheap — two draw calls for the whole roadside whatever a world lines it with — and it was wrong in
 * a way that is obvious once the run is fast enough to matter: a cube reads as a cube. At 30 m/s
 * there is no time to resolve a silhouette out of a box, so the eye gets "crates" and stops, and the
 * roadside reads as a fence of them rather than as the edge of a place.
 *
 * So each world has its own props now — adobe houses and mesas, conifers and fallen logs, apartment
 * blocks, street lights and rooftop signs — and they are built here. What is *kept* from the box
 * version is the reason it was built that way: the roadside must not become a scene graph. Each kind
 * is authored out of primitives, its parts merged into a single geometry with a colour baked per
 * part, and the whole kind drawn as one `InstancedMesh`. A world's roadside is therefore five or six
 * draw calls instead of two, which is still a number nobody has to think about, and no per-piece
 * objects, no materials per prop, and nothing that reacts to the runner being where it is.
 *
 * ## Why the colours live in the geometry
 *
 * A merged kind is one mesh with one material, so a conifer whose trunk and canopy are different
 * colours cannot be two materials — the trunk has to carry its own colour *in* the geometry. Hence
 * the colour attribute: each part paints itself from the world's palette (see `world-look`) and the
 * merge carries the lot. The instance tint multiplies on top of that, which is what keeps a row of
 * identical conifers from looking stamped: one geometry, sixty different shades of it.
 *
 * The primitive shapes are deliberately coarse — cones and icosahedra rather than smooth solids — and
 * the material is flat-shaded, because the low-poly read *is* the look: visible facets, hard normals,
 * and a silhouette that survives one frame at speed.
 *
 * ## Authored at natural size, scaled uniformly
 *
 * Every kind is modelled at a real size in metres with its base at y = 0, so an instance's scale is a
 * single number and a prop stays the shape it was drawn as. Scaling a tree non-uniformly to get a
 * taller one of the same kind is how a conifer becomes a spike, and the point of the row is that all
 * of them are conifers.
 */

/**
 * The kinds of prop the roadside can stand beside the road.
 *
 * Named for what they are, not for the world they appear in: `rock` is used by the desert and the
 * forest both, and gets the grey of wet moss in one and warm sandstone in the other from the palette
 * rather than from a second geometry. A few of them carry a lit panel — see `panelAnchor`.
 */
export type PropKind =
  | "rock"
  | "house"
  | "cactus"
  | "butte"
  | "sign"
  | "conifer"
  | "broadleaf"
  | "log"
  | "stump"
  | "marker"
  | "block"
  | "tower"
  | "lamp"
  | "crate"
  | "billboard"
  | "rooftop";

/**
 * Where a panel sits on a piece, in that piece's own metres, and how big it is.
 *
 * Measured on the geometry at its authored size, so the layout can scale all four by the piece's
 * scale and the panel lands on the face whatever size the piece is. `z` is a couple of centimetres in
 * front of the surface the panel is on: shared with it, the two fight for the same depth buffer.
 *
 * Every panel is 16:9, which is the shape of the frame of the generated world that goes on it — the
 * picture is sampled out of Orbis's own stream, so a panel of another aspect would either letterbox
 * or stretch it.
 *
 * Not every kind has one: a panel needs a surface behind it that reads as its backing, and only these
 * kinds have one — a board, a billboard frame, a rooftop frame, or the wing of the adobe house.
 */
export type PanelAnchor = { x: number; y: number; z: number; width: number; height: number };

const PANEL_ANCHORS: Partial<Record<PropId, PanelAnchor>> = {
  house: { x: 0.6, y: 0.26, z: 0.4, width: 0.4, height: 0.225 },
  sign: { x: 0, y: 1.3, z: 0.045, width: 0.92, height: 0.5175 },
  marker: { x: 0, y: 0.98, z: 0.04, width: 0.4, height: 0.225 },
  billboard: { x: 0, y: 1.33, z: 0.05, width: 0.96, height: 0.54 },
  rooftop: { x: 0, y: 1.47, z: 0.045, width: 0.8, height: 0.45 },
};

/** Where a piece carries a panel, if it is a kind that can. The packs' models never can. */
export function panelAnchor(id: PropId): PanelAnchor | undefined {
  return PANEL_ANCHORS[id];
}

/** A palette entry, so a part's colour is the world's answer to "what is this made of". */
type Paint = keyof EnvironmentLook;

/**
 * One primitive in a prop, in the prop's own metres.
 *
 * `size` is read per form and is deliberately positional rather than one tuple per form: it keeps
 * the shape table readable as a table.
 * - `box`: `[width, height, depth]`
 * - `cylinder`: `[radiusTop, radiusBottom, height, sides]`
 * - `cone`: `[radius, height, sides]`
 * - `rock`: `[radius, across, up]` — an icosahedron, squashed and stretched
 */
type Part = {
  form: "box" | "cylinder" | "cone" | "rock";
  size: number[];
  at?: [number, number, number];
  /** Radians, applied about the part's own centre after its size and before its position. */
  turn?: [number, number, number];
  paint: Paint;
  /**
   * Multiplier on the palette colour, in linear space.
   *
   * Two jobs: how the same material reads on a face that would be in shadow at this angle, and how a
   * small piece of the same stuff — a cut end, a doorway — reads against the mass around it. Anything
   * below 0.7 stops reading as the material and starts reading as a hole, which is what the doorway
   * on the adobe house is for.
   */
  shade?: number;
};

/**
 * The window openings on a city block, as shallow boxes standing just proud of each face.
 *
 * Sunk into the wall they would be invisible, so they sit a couple of centimetres out and read as lit
 * panes. Bright colour, no lights: at the distance a block is passed, a lit window is a few pixels
 * and what the eye wants is the *pattern* of them, which is why there are six a level on three faces
 * rather than an emissive material on the whole box.
 */
function windows(levels: number[], halfX: number, halfZ: number, width: number, height: number): Part[] {
  const parts: Part[] = [];
  for (const y of levels) {
    for (const side of [-1, 1]) {
      // The two long side faces, which is what the runner sees as a block goes past.
      parts.push({ form: "box", size: [0.07, height, width], at: [side * halfX, y, halfZ * 0.45], paint: "line", shade: 0.92 });
      parts.push({ form: "box", size: [0.07, height, width], at: [side * halfX, y, -halfZ * 0.45], paint: "line", shade: 0.92 });
      // And the front, which is what it sees while the block is still ahead.
      parts.push({ form: "box", size: [width, height, 0.07], at: [side * halfX * 0.42, y, halfZ], paint: "line", shade: 0.86 });
    }
  }
  return parts;
}

const SHAPES: Record<PropKind, Part[]> = {
  /**
   * Two boulders, one tucked against the other: a desert floor is scattered stones, not single
   * monuments, and a cluster reads as ground at the distance the far rows are seen from. Squashed
   * icosahedra rather than spheres, because a sphere at this size is a ball.
   */
  rock: [
    { form: "rock", size: [0.5, 1.2, 0.68], at: [0, 0.34, 0], turn: [0, 0.4, 0], paint: "stone" },
    { form: "rock", size: [0.3, 1.05, 0.72], at: [0.5, 0.21, 0.24], turn: [0, 1.1, 0], paint: "stone", shade: 0.84 },
  ],

  /** A flat-roofed adobe with a wing, a parapet, a doorway and two lit windows on the road face. */
  house: [
    { form: "box", size: [1.0, 0.62, 0.78], at: [0, 0.31, 0], paint: "block" },
    { form: "box", size: [1.07, 0.07, 0.85], at: [0, 0.655, 0], paint: "blockAccent" },
    { form: "box", size: [0.46, 0.4, 0.56], at: [0.6, 0.2, 0.08], paint: "base" },
    { form: "box", size: [0.52, 0.06, 0.62], at: [0.6, 0.43, 0.08], paint: "blockAccent" },
    { form: "box", size: [0.16, 0.3, 0.06], at: [-0.3, 0.15, 0.4], paint: "blockAccent", shade: 0.42 },
    { form: "box", size: [0.11, 0.11, 0.06], at: [0.0, 0.36, 0.4], paint: "line", shade: 0.86 },
    { form: "box", size: [0.11, 0.11, 0.06], at: [0.24, 0.36, 0.4], paint: "line", shade: 0.86 },
  ],

  /** A saguaro: a ribbed trunk with two arms at different heights, which is what says "cactus". */
  cactus: [
    { form: "cylinder", size: [0.2, 0.24, 1.9, 6], at: [0, 0.95, 0], paint: "flora" },
    { form: "cylinder", size: [0.13, 0.13, 0.42, 6], at: [-0.33, 1.02, 0], turn: [0, 0, Math.PI / 2], paint: "flora", shade: 0.9 },
    { form: "cylinder", size: [0.12, 0.12, 0.6, 6], at: [-0.54, 1.32, 0], paint: "flora", shade: 0.95 },
    { form: "cylinder", size: [0.13, 0.13, 0.38, 6], at: [0.33, 0.78, 0], turn: [0, 0, Math.PI / 2], paint: "flora", shade: 0.9 },
    { form: "cylinder", size: [0.12, 0.12, 0.5, 6], at: [0.54, 1.03, 0], paint: "flora", shade: 0.95 },
    { form: "cone", size: [0.2, 0.16, 6], at: [0, 1.98, 0], paint: "flora", shade: 1.06 },
  ],

  /** A mesa: a talus cone, a six-sided column, a flat cap, and one fallen block at its foot. */
  butte: [
    { form: "cone", size: [1.0, 0.32, 6], at: [0, 0.16, 0], paint: "grain" },
    { form: "cylinder", size: [0.3, 0.48, 0.86, 6], at: [0, 0.72, 0], paint: "stone" },
    { form: "cylinder", size: [0.33, 0.31, 0.1, 6], at: [0, 1.2, 0], paint: "stone", shade: 1.09 },
    { form: "box", size: [0.42, 0.5, 0.3], at: [0.5, 0.42, 0.12], turn: [0, 0.6, 0], paint: "stone", shade: 0.85 },
  ],

  /** A board on two posts, which is the desert's panel: a small sign at the shoulder. */
  sign: [
    { form: "box", size: [0.07, 1.0, 0.07], at: [-0.42, 0.5, 0], paint: "trunk" },
    { form: "box", size: [0.07, 1.0, 0.07], at: [0.42, 0.5, 0], paint: "trunk" },
    { form: "box", size: [1.0, 0.6, 0.07], at: [0, 1.3, 0], paint: "blockAccent" },
    { form: "box", size: [1.08, 0.08, 0.12], at: [0, 0.95, 0], paint: "blockAccent", shade: 0.8 },
  ],

  /** A conifer: a short trunk under three stacked cones that narrow as they climb. */
  conifer: [
    { form: "cylinder", size: [0.055, 0.09, 0.36, 5], at: [0, 0.18, 0], paint: "trunk" },
    { form: "cone", size: [0.3, 0.42, 7], at: [0, 0.42, 0], paint: "foliage" },
    { form: "cone", size: [0.235, 0.38, 7], at: [0, 0.63, 0], paint: "foliage", shade: 0.9 },
    { form: "cone", size: [0.155, 0.34, 7], at: [0, 0.83, 0], paint: "foliage", shade: 1.07 },
  ],

  /** A broadleaf: the same trunk under a lumpy crown of three overlapping icosahedra. */
  broadleaf: [
    { form: "cylinder", size: [0.05, 0.09, 0.44, 5], at: [0, 0.22, 0], paint: "trunk" },
    { form: "rock", size: [0.3, 1.15, 0.95], at: [0, 0.63, 0], turn: [0, 0.3, 0], paint: "foliage" },
    { form: "rock", size: [0.21, 1.0, 1.0], at: [0.19, 0.53, 0.07], turn: [0, 1.2, 0], paint: "foliage", shade: 0.86 },
    { form: "rock", size: [0.18, 1.0, 1.0], at: [-0.17, 0.72, -0.06], turn: [0.3, 2.1, 0], paint: "foliage", shade: 1.1 },
  ],

  /** A fallen log across the shoulder, with its cut end showing and one dead branch lifting off it. */
  log: [
    { form: "cylinder", size: [0.08, 0.09, 1.0, 7], at: [0, 0.09, 0], turn: [0, 0, Math.PI / 2], paint: "trunk" },
    { form: "cylinder", size: [0.085, 0.085, 0.03, 7], at: [0.5, 0.09, 0], turn: [0, 0, Math.PI / 2], paint: "blockAccent" },
    { form: "cylinder", size: [0.035, 0.045, 0.4, 5], at: [-0.22, 0.26, 0.04], turn: [0.5, 0, -0.7], paint: "trunk", shade: 0.86 },
  ],

  /** A sawn stump with the cut face left bright and a root running out of it. */
  stump: [
    { form: "cylinder", size: [0.16, 0.22, 0.26, 7], at: [0, 0.13, 0], paint: "trunk" },
    { form: "cylinder", size: [0.145, 0.145, 0.03, 7], at: [0, 0.27, 0], paint: "blockAccent" },
    { form: "box", size: [0.34, 0.07, 0.1], at: [0.2, 0.035, 0.05], turn: [0, 0.4, 0], paint: "trunk", shade: 0.85 },
  ],

  /** A trail marker: a post with a small board, moss on the cap. */
  marker: [
    { form: "box", size: [0.09, 0.9, 0.09], at: [0, 0.45, 0], paint: "trunk" },
    { form: "box", size: [0.46, 0.3, 0.06], at: [0, 0.98, 0], paint: "wall" },
    { form: "box", size: [0.12, 0.06, 0.11], at: [0, 1.16, 0], paint: "foliage", shade: 0.8 },
  ],

  /** An apartment block: a roof lip, a stairwell and an AC unit over three lit levels. */
  block: [
    { form: "box", size: [1.0, 1.0, 0.78], at: [0, 0.5, 0], paint: "block" },
    { form: "box", size: [1.06, 0.05, 0.84], at: [0, 1.025, 0], paint: "wall" },
    { form: "box", size: [0.26, 0.14, 0.22], at: [-0.26, 1.12, 0], paint: "wall" },
    { form: "box", size: [0.2, 0.1, 0.18], at: [0.3, 1.1, 0.16], paint: "edge", shade: 0.9 },
    ...windows([0.14, 0.38, 0.62], 0.5, 0.39, 0.17, 0.08),
  ],

  /**
   * The far skyline: three boxes stepping in as they climb, an antenna, a beacon on top, and a few
   * lit bands. Out at this distance a window is a pixel, so the bands are long and few.
   */
  tower: [
    { form: "box", size: [0.9, 0.5, 0.7], at: [0, 0.25, 0], paint: "base" },
    { form: "box", size: [0.66, 0.4, 0.54], at: [0, 0.7, 0], paint: "base" },
    { form: "box", size: [0.42, 0.34, 0.36], at: [0, 1.07, 0], paint: "base" },
    { form: "box", size: [0.05, 0.22, 0.05], at: [0, 1.35, 0], paint: "wall" },
    { form: "box", size: [0.08, 0.08, 0.08], at: [0, 1.48, 0], paint: "gate" },
    { form: "box", size: [0.07, 0.34, 0.24], at: [0.45, 0.16, 0], paint: "line", shade: 0.9 },
    { form: "box", size: [0.07, 0.3, 0.24], at: [-0.45, 0.62, 0], paint: "line", shade: 0.9 },
    { form: "box", size: [0.34, 0.07, 0.03], at: [0, 0.86, 0.27], paint: "line", shade: 0.9 },
  ],

  /** A street light, arm reaching for the road: the closest thing to the camera in the city. */
  lamp: [
    { form: "cylinder", size: [0.045, 0.06, 0.96, 6], at: [0, 0.48, 0], paint: "wall" },
    { form: "cylinder", size: [0.09, 0.11, 0.08, 6], at: [0, 0.04, 0], paint: "edge", shade: 0.85 },
    { form: "box", size: [0.3, 0.05, 0.05], at: [0.15, 0.96, 0], paint: "wall" },
    { form: "box", size: [0.17, 0.07, 0.12], at: [0.3, 0.93, 0], paint: "line" },
  ],

  /** Cargo waiting to be moved: two crates on a pallet, with a third balanced on top. */
  crate: [
    { form: "box", size: [0.6, 0.06, 0.55], at: [0, 0.03, 0], paint: "blockAccent" },
    { form: "box", size: [0.55, 0.48, 0.5], at: [0, 0.3, 0], paint: "block" },
    { form: "box", size: [0.4, 0.36, 0.4], at: [0.42, 0.24, 0.06], paint: "wall" },
    { form: "box", size: [0.34, 0.3, 0.32], at: [0.04, 0.69, 0], turn: [0, 0.22, 0], paint: "block", shade: 1.12 },
  ],

  /** A ground-level billboard on two legs, angled a little off the road so it is not a flat panel. */
  billboard: [
    { form: "box", size: [0.1, 1.0, 0.1], at: [-0.38, 0.5, 0], paint: "wall" },
    { form: "box", size: [0.1, 1.0, 0.1], at: [0.38, 0.5, 0], paint: "wall" },
    { form: "box", size: [0.95, 0.06, 0.1], at: [0, 1.02, 0], paint: "wall", shade: 0.85 },
    { form: "box", size: [1.02, 0.62, 0.09], at: [0, 1.33, 0], paint: "edge", shade: 0.75 },
  ],

  /** A block low enough for the sign above it to be the thing that reads, with a sign on the roof. */
  rooftop: [
    { form: "box", size: [1.0, 0.72, 0.8], at: [0, 0.36, 0], paint: "block" },
    { form: "box", size: [0.36, 0.08, 0.3], at: [0, 0.76, 0], paint: "wall" },
    { form: "box", size: [0.06, 0.5, 0.06], at: [-0.32, 0.97, 0], paint: "wall" },
    { form: "box", size: [0.06, 0.5, 0.06], at: [0.32, 0.97, 0], paint: "wall" },
    { form: "box", size: [0.86, 0.5, 0.07], at: [0, 1.47, 0], paint: "edge", shade: 0.75 },
    { form: "box", size: [0.06, 0.07, 0.18], at: [0.0, 1.19, 0.06], paint: "line", shade: 0.9 },
  ],
};

/** Builds one part's geometry, in the prop's own space, with nothing coloured yet. */
function buildPart(part: Part): THREE.BufferGeometry {
  let geometry: THREE.BufferGeometry;
  switch (part.form) {
    case "box": {
      const [width, height, depth] = part.size;
      geometry = new THREE.BoxGeometry(width, height, depth);
      break;
    }
    case "cylinder": {
      const [top, bottom, height, sides] = part.size;
      geometry = new THREE.CylinderGeometry(top, bottom, height, sides);
      break;
    }
    case "cone": {
      const [radius, height, sides] = part.size;
      geometry = new THREE.ConeGeometry(radius, height, sides);
      break;
    }
    case "rock": {
      const [radius, across, up] = part.size;
      geometry = new THREE.IcosahedronGeometry(radius, 0);
      geometry.scale(across, up, across);
      break;
    }
  }
  if (part.turn) geometry.rotateX(part.turn[0]).rotateY(part.turn[1]).rotateZ(part.turn[2]);
  if (part.at) geometry.translate(part.at[0], part.at[1], part.at[2]);
  return geometry;
}

/**
 * Writes a part's colour into its vertices.
 *
 * Straight from the world's palette, then shaded — in linear space, which is the space the shader
 * multiplies a vertex colour in, so the shade factors here mean the same thing the instance tints do.
 */
function paintPart(geometry: THREE.BufferGeometry, environment: Environment, part: Part): void {
  const colour = new THREE.Color(environmentLook[environment][part.paint]);
  if (part.shade !== undefined) colour.multiplyScalar(part.shade);
  const count = geometry.attributes.position.count;
  const values = new Float32Array(count * 3);
  for (let vertex = 0; vertex < count; vertex += 1) {
    values[vertex * 3] = colour.r;
    values[vertex * 3 + 1] = colour.g;
    values[vertex * 3 + 2] = colour.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(values, 3));
}

/**
 * What a prop is called in a plan.
 *
 * A kind from this module, or the name of a model cooked out of one of the packs in `models/` — the
 * layout does not care which, because both arrive with the same two numbers and the same shape
 * convention (see `PropMetrics`).
 */
export type PropId = string;

/** The geometry a kind has to be drawn with, and how much ground it takes up. */
export type PropMetrics = {
  /** The widest half-extent across the ground, at scale 1: the clearance the layout works from. */
  radius: number;
  /** Its height above its own base, at scale 1. */
  height: number;
};

/**
 * A kind's footprint, measured off the shapes rather than declared beside them.
 *
 * The layout has to know how far from the road a piece has to stand to clear the shoulder, and that
 * is a property of the geometry — but the geometry is built per world and coloured from the palette,
 * while the layout is planned per world and knows nothing about either. Measuring once here means
 * there is no second set of dimensions to keep in step with the shapes: whoever moves an arm on the
 * cactus moves the clearance with it.
 *
 * Measured as the widest extent on *either* horizontal axis, because most pieces are turned by a
 * random yaw and a piece has to clear the road whichever way it ends up facing.
 */
function measure(kind: PropKind): PropMetrics {
  let radius = 0;
  let top = -Infinity;
  // The lowest vertex, not the authored ground plane: the built geometry is grounded on its own
  // floor, and a shape whose parts do not quite reach y = 0 — a boulder cluster whose lowest facet
  // sits a couple of centimetres up — is a couple of centimetres shorter than its parts suggest.
  let bottom = Infinity;
  for (const part of SHAPES[kind]) {
    const geometry = buildPart(part);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (box) {
      radius = Math.max(radius, Math.abs(box.min.x), box.max.x, Math.abs(box.min.z), box.max.z);
      top = Math.max(top, box.max.y);
      bottom = Math.min(bottom, box.min.y);
    }
    geometry.dispose();
  }
  return { radius, height: top - bottom };
}

/**
 * Every hand-built kind's footprint, measured once: it is a property of the shape, not of the world.
 *
 * The model props out of the packs are measured the same way, off their own geometry, when they load
 * (`roadside-models`); the two sets go into one map and the layout works from that.
 */
export const AUTHORED_METRICS = Object.fromEntries(
  (Object.keys(SHAPES) as PropKind[]).map((kind) => [kind, measure(kind)]),
) as Record<PropKind, PropMetrics>;

/**
 * The kinds asked for, built and coloured for one world.
 *
 * Geometries belong to the caller to dispose: they are built with the plan that uses them and freed
 * when it is replaced, which is what keeps a world change from leaving three worlds' worth of props
 * behind — and what makes this safe to call twice under React's development double-mount.
 */
export function buildRoadsideProps(
  environment: Environment,
  kinds: PropKind[],
): Map<PropId, THREE.BufferGeometry> {
  const built = new Map<PropId, THREE.BufferGeometry>();
  for (const kind of kinds) {
    const parts: THREE.BufferGeometry[] = SHAPES[kind].map((part) => {
      const source = buildPart(part);
      paintPart(source, environment, part);
      // Every kind is merged from primitives that do not agree about indexing — an icosahedron has
      // none and a box does — so they are all flattened to plain triangle lists first. It also gives
      // each triangle its own vertices, which is what the flat shading wants anyway.
      const flat = source.index ? source.toNonIndexed() : source;
      if (flat !== source) source.dispose();
      return flat;
    });

    const merged = mergeGeometries(parts, false);
    parts.forEach((part) => part.dispose());
    // Authored with its base at y = 0, so an instance's scale and the ground it is put on are both
    // measured from the same place.
    merged.computeBoundingBox();
    if (merged.boundingBox) merged.translate(0, -merged.boundingBox.min.y, 0);
    merged.computeBoundingSphere();
    built.set(kind, merged);
  }
  return built;
}

/**
 * What the props are lit like, per world.
 *
 * Flat-shaded and mostly rough, because a facet that catches the key light is the whole low-poly
 * read; the city is the exception, since glass and steel beside a wet road answer the light instead.
 */
export function propMaterial(environment: Environment): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: environment === "city" ? 0.66 : 0.95,
    metalness: environment === "city" ? 0.26 : 0.02,
  });
}
