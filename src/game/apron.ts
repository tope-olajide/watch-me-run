import { MathUtils } from "three";
import type { Environment } from "./run-state";

/**
 * The height of the local ground, in one place.
 *
 * The apron is the game's own surface under the road — a low, gently rolling plate that reaches back
 * under the camera and dissolves into the generated vista. It has a shape, and until now that shape
 * was written out only inside the code that builds its mesh, which was fine while the apron was the
 * only thing that touched it. It is not any more: the roadside scenery stands on this ground, so a
 * second copy of the formula beside the first would put the props at a different height than the
 * surface they are standing on, and the two would drift the moment either was tuned. A tree floating
 * a metre over the ground it is supposed to be rooted in is the sort of thing an eye catches at once
 * at 30 m/s, and it is exactly what "the props are not working" would come back as.
 *
 * So the field lives here and both callers read it. The numbers themselves are the apron mesh's:
 * see `createTerrainGeometry` for what they are for.
 */

/** The apron's colour when its banks are flat, and where its plumb level sits. */
export const APRON_GROUND_Y = -0.12;

/** Depth over which the ground climbs from the shoulder to the top of its banks. */
export const APRON_BANK_WIDTH = 12;

/** The banks' floor and their flat height, before undulation. Kept under 2 m — see the scene. */
const APRON_MIN_BANK = 0.3;
const APRON_BANK_BASE = 0.9;

/**
 * Where each world's ground is in its own slow roll.
 *
 * The undulation is only ever seen in the sideways direction — the apron is a static height field and
 * what travels over it is the surface detail, not the mesh — so one number per world is enough to
 * keep the three from sharing a shape. Desert is smooth wind-blown ground, the city is built on
 * graded land, and the forest floor is the roughest of the three.
 */
const APRON_PHASE: Record<Environment, number> = { desert: 0.4, city: 2.1, forest: 4.2 };

export type ApronField = {
  /** The plumb level of the flat ground between the banks. */
  ground: number;
  /** How far from the road centre the banks start climbing: the road's own half-width, plus margin. */
  shoulder: number;
  /** Depth over which they finish climbing. */
  bank: number;
  phase: number;
};

/**
 * The ground for one world.
 *
 * `shoulder` is passed in rather than derived here because it belongs to the road: the apron climbs
 * out of the ribbon's own edge, so the road's width is the thing that decides it, and `ROAD_WIDTH`
 * lives with the ribbon's geometry. The road width was 10.5 m at the time of writing, giving the 5.5
 * this is called with.
 */
export function apronField(environment: Environment, shoulder: number): ApronField {
  return {
    ground: APRON_GROUND_Y,
    shoulder,
    bank: APRON_BANK_WIDTH,
    phase: APRON_PHASE[environment],
  };
}

/** How far up the banks a point is: 0 in the road corridor, 1 once they have finished climbing. */
export function apronLateral(field: ApronField, x: number): number {
  return MathUtils.smoothstep(Math.abs(x), field.shoulder, field.shoulder + field.bank);
}

/**
 * The along-Z roll of the ground, which is where the banks' height actually varies.
 *
 * Two waves at different lengths, so the ground does not read as one sine — the shorter one at about
 * 84 m and the longer at about 150 m. Sampled in `|x|` as well as `z`, so the two sides are not
 * mirror images of each other.
 */
export function apronUndulation(field: ApronField, x: number, z: number): number {
  return (
    Math.sin(Math.abs(x) * 0.075 + z * 0.05 + field.phase) * 0.5 +
    Math.cos(Math.abs(x) * 0.035 - z * 0.075 + field.phase * 1.7) * 0.35
  );
}

/** How tall the banks are at a point, undulation included. */
export function apronBank(field: ApronField, x: number, z: number): number {
  return bankFrom(apronUndulation(field, x, z));
}

/** The one place the banks' floor and flat height are applied to a roll. */
function bankFrom(undulation: number): number {
  return Math.max(APRON_MIN_BANK, APRON_BANK_BASE + undulation);
}

/** The ground's own height at a point. This is what a prop's base is put on. */
export function apronHeight(field: ApronField, x: number, z: number): number {
  return field.ground + apronLateral(field, x) * bankFrom(apronUndulation(field, x, z));
}

export type ApronSample = { height: number; lateral: number; undulation: number };

/**
 * The height and the two terms behind it, for callers that need the terms too.
 *
 * The apron mesh tints its vertices by how far up the banks they are, so it needs `lateral` and
 * `undulation` beside the height. Passing a scratch object in keeps a per-vertex build from
 * allocating one per vertex.
 */
export function sampleApron(
  field: ApronField,
  x: number,
  z: number,
  out: ApronSample = { height: 0, lateral: 0, undulation: 0 },
): ApronSample {
  out.lateral = apronLateral(field, x);
  out.undulation = apronUndulation(field, x, z);
  out.height = field.ground + out.lateral * bankFrom(out.undulation);
  return out;
}
