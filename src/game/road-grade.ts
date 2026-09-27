import type { Environment } from "./run-state";
import type { WorldTone } from "../orbis/world-palette";

/**
 * Per-world grade for the road ribbon.
 *
 * The ribbon is WebGL and the world around it is generated video, so the ribbon is graded into that
 * video's tonal range — specifically the tone of its *lower* region, which is the generated ground
 * the ribbon replaces. Matching the whole-frame average instead would grade the ground against the
 * sky, which is how a road ends up reading as a dark sheet laid over a bright world.
 *
 * The maths is a closed loop rather than an offset: the ribbon's own rendered level is known per
 * world (`ribbonAtUnity`, calibrated from the images in tools/frame-report.mjs), so the grade is
 * the ratio that lands it on the measured ground tone. `min`/`max` are the limits of that ratio —
 * enough travel to follow a world from noon to blackout, not so much that a world loses its look.
 */

export type RoadGrade = {
  /** Material colour multiplier for the ribbon: a brightness ratio with the world's colour in it. */
  color: [number, number, number];
  /** The brightness ratio on its own, published for diagnostics. */
  scale: number;
  /** True when the numbers came from a live measurement rather than the world's preset. */
  measured: boolean;
};

type WorldGrade = {
  /**
   * Tone of the generated ground in this world, in the sampler's units, used until frames are
   * measured. Only matters in local world mode — a live world overrides it within a second.
   */
  ground: number;
  /** Tone this world's ribbon renders at per unit of material brightness: its calibration. */
  ribbonAtUnity: number;
  /** Tone the ribbon aims for relative to the generated ground. 1 means "the ground's own tone". */
  ratio: number;
  /** How far the grade may travel before the world stops looking like itself. */
  min: number;
  max: number;
  /** How much of the world's colour the ribbon takes on. */
  tintPull: number;
};

/**
 * Calibrated against captured frames rather than guessed: `tools/orbis-probe.mjs` writes a frame of
 * the ribbon alone on black and a frame of the generated world at the same instant, and
 * `tools/frame-report.mjs --region 0.35,0.70,0.65,0.92` reads both. In the desert the ribbon
 * rendered 20.8 luma at a material multiplier of 0.434, so it contributes 50 luma per unit — while
 * the generated ground it crosses sat at 32.5. That is the road reading a third darker than the
 * terrain, which is what these numbers correct: the grade that lands the ribbon on the measured
 * ground tone is `ground / 50`, and at a ground of 37 that is 0.74 rather than 0.43.
 *
 * The other worlds' ribbon levels follow from their road textures and lighting relative to the
 * desert's (city is the darkest texture at ~0.44x, forest ~0.57x), and their presets from the
 * palettes in the prompts. Desert values are measured; the rest are derived, and the live sampler
 * corrects them at runtime.
 *
 * Since the distance haze went in, the sampler reads the ground band just under the horizon (where
 * the ribbon fades into the world) rather than the lower third (now haze). These presets were
 * measured on the old band, so they are only rough fallbacks for local mode; the live measurement
 * is what the road is actually graded against.
 */
const worldGrades: Record<Environment, WorldGrade> = {
  desert: { ground: 53, ribbonAtUnity: 50, ratio: 1, min: 0.25, max: 2, tintPull: 0.4 },
  city: { ground: 34, ribbonAtUnity: 22, ratio: 1, min: 0.25, max: 2.2, tintPull: 0.5 },
  forest: { ground: 46, ribbonAtUnity: 29, ratio: 1, min: 0.25, max: 2.1, tintPull: 0.45 },
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function roadGrade(environment: Environment, tone: WorldTone): RoadGrade {
  const world = worldGrades[environment];
  const measured = tone.live && tone.ground > 0;
  const ground = measured ? Math.max(4, tone.ground) : world.ground;
  const scale = clamp((ground * world.ratio) / world.ribbonAtUnity, world.min, world.max);

  // The colour lean is normalised to the same brightness, so tinting never doubles as exposure.
  const pull = measured ? world.tintPull : 0;
  const lean = tone.tint.map((channel) => 1 + (channel - 1) * pull);
  const peak = Math.max(lean[0], lean[1], lean[2], 0.0001);

  return {
    color: [
      clamp((lean[0] / peak) * scale, 0, 2),
      clamp((lean[1] / peak) * scale, 0, 2),
      clamp((lean[2] / peak) * scale, 0, 2),
    ],
    scale,
    measured,
  };
}
