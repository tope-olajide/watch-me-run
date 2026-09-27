/**
 * Finding the horizon line in a picture.
 *
 * One rule, used in two places that need to agree about it: the runtime lock, which measures the
 * generated video and moves it so its horizon cannot fall below the game's, and the landscape
 * preparation, which measures a picture the player uploaded and crops it so its horizon lands on the
 * game's line before the world is ever generated from it.
 *
 * They have to share more than a number. "Where the horizon is" is a judgement, and a picture that
 * one of them calls a horizon and the other does not would leave the two disagreeing about the same
 * frame — the lock shifting up a horizon the preparation had already placed.
 *
 * ## The rule
 *
 * The horizon is the sharpest *darkening* step between adjacent rows. Live captures of all three
 * generated worlds show the same shape — a bright atmosphere band peaking just above a hard cliff,
 * with the darker ground below — and in each capture the largest single downward step is that cliff,
 * by 1.6x to 3.0x over the next largest step (desert 52% step 56, city 38% step 52, forest 31% step
 * 44, all on the 48-row grid below).
 *
 * Upward steps are ignored. A horizon is sky going dark into ground; a bright edge underneath
 * something dark is a silhouette or a road marking, not a skyline.
 *
 * A movement-based measure was tried first and thrown away: over a pair of raw frames the desert's
 * *sky* changes more than its ground does, because these prompts deliberately put heat haze, glare
 * and streaming sand up there, so "the ground is what moves" is simply false for these worlds.
 */

/**
 * 48 rows and 48 columns: the grid every threshold below was measured on.
 *
 * The resolution is part of the contract, not an implementation detail — it is what a step size is
 * measured *in*. Two adjacent rows of 48 straddle half the source of two adjacent rows of 32, so the
 * same cliff reads about 1.5x smaller here, and the gates below only mean what they say on this grid.
 */
export const SKYLINE_ROWS = 48;
export const SKYLINE_COLUMNS = 48;

/**
 * A step below this is texture, not a skyline — the gate that carries the search.
 *
 * Set by auditing every capture on hand, eight live profiles each measured for brightness and for how
 * much each row changed between two frames. Sorting them by step size splits them in two with nothing
 * in between:
 *
 *   real skylines      desert 52% step 56 · city 38% step 52 · forest 31% step 44
 *   not skylines       city 60% step 18 · city 56% step 25 · desert 65% step 26
 *                      desert 48% step 36 · forest 44% step 38
 *
 * The second group are all the same shape: a broad decline across three adjacent rows (60/63/69%,
 * 50/54/56%, 44/46/48%) rather than one cliff, in one case in a frame that barely changes at all
 * between frames (peak change 1.5 luma). One of them drove the correction to its ceiling and held it
 * there for a whole run.
 *
 * Note what does *not* separate them: contrast against the runner-up. The weak group reaches 2.50
 * while a real skyline sits at 1.57, so contrast alone would wave the worst case through.
 */
export const SKYLINE_MIN_STEP = 42;

/** Secondary floor: a real skyline still has to win its own frame by this much (measured 1.57-2.95). */
export const SKYLINE_MIN_CONTRAST = 1.5;

/**
 * Where a skyline is looked for.
 *
 * In the live video: every real horizon measured across the three worlds sat between 31% and 52%,
 * and the prompts ask for the upper third, so the band is that range plus margin. The lower bound is
 * deliberate about the far end — past ~60% a shift cannot bring the horizon near the game's line
 * anyway (the correction ceiling is 8.5% of the frame, so a 60% skyline lands at 51.5%, still below),
 * so refusing there costs little and it is where the doubtful measurements live.
 *
 * In an uploaded picture the horizon can honestly be anywhere, which is the whole point of preparing
 * it, so that search uses `PICTURE_BAND` instead.
 */
export const VIDEO_BAND = { top: 0.1, bottom: 0.6 } as const;
/** An uploaded picture is not our world: its horizon may sit low in frame, and that is exactly the
 * case worth re-placing rather than refusing. */
export const PICTURE_BAND = { top: 0.05, bottom: 0.95 } as const;

export type Skyline = {
  /** Index of the last bright row, on the `SKYLINE_ROWS` grid. */
  row: number;
  /** Where the horizon falls in the frame, as a fraction from the top. */
  horizon: number;
  /** The luma drop across that row, in the 0-255 the sampler works in. */
  step: number;
  /** How many times larger that drop is than the next largest, or Infinity when it is the only one. */
  contrast: number;
};

/**
 * Per-row mean brightness of a source, sampled on the shared grid.
 *
 * The source is scaled to `SKYLINE_COLUMNS` x `SKYLINE_ROWS` first, so the row means describe the
 * whole frame rather than a strip of it — a horizon is a property of the picture, not of one column.
 */
export function sampleRowBrightness(
  source: CanvasImageSource,
  raster: HTMLCanvasElement,
  rows = SKYLINE_ROWS,
): number[] | undefined {
  const context = raster.getContext("2d", { willReadFrequently: true });
  if (!context) return undefined;

  raster.width = SKYLINE_COLUMNS;
  raster.height = rows;
  context.clearRect(0, 0, SKYLINE_COLUMNS, rows);
  context.drawImage(source, 0, 0, SKYLINE_COLUMNS, rows);
  const { data } = context.getImageData(0, 0, SKYLINE_COLUMNS, rows);

  const brightness: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    let sum = 0;
    for (let column = 0; column < SKYLINE_COLUMNS; column += 1) {
      const index = (row * SKYLINE_COLUMNS + column) * 4;
      sum += 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
    }
    brightness.push(sum / SKYLINE_COLUMNS);
  }
  return brightness;
}

/** The skyline in a row profile, or undefined when nothing in the band is clear enough to act on. */
export function findSkyline(
  brightness: number[],
  band: { top: number; bottom: number } = VIDEO_BAND,
): Skyline | undefined {
  const rows = brightness.length;
  if (rows < 4) return undefined;

  let bestRow = -1;
  let bestStep = 0;
  let secondStep = 0;
  const from = Math.max(0, Math.round(band.top * rows));
  const to = Math.min(rows - 2, Math.round(band.bottom * rows) - 1);
  for (let row = from; row <= to; row += 1) {
    const step = brightness[row] - brightness[row + 1];
    if (step <= 0) continue;
    if (step > bestStep) {
      secondStep = bestStep;
      bestStep = step;
      bestRow = row;
    } else if (step > secondStep) {
      secondStep = step;
    }
  }

  if (bestRow < 0 || bestStep < SKYLINE_MIN_STEP) return undefined;
  if (secondStep > 0 && bestStep < secondStep * SKYLINE_MIN_CONTRAST) return undefined;

  return {
    row: bestRow,
    horizon: (bestRow + 1) / rows,
    step: bestStep,
    contrast: secondStep > 0 ? bestStep / secondStep : Infinity,
  };
}

/**
 * The game camera's horizon, as a fraction from the top of the frame.
 *
 * The camera is a fixed rig — y=3.4, aimed about 3.25 degrees down — so the ground plane's horizon
 * projects to 43.3% at the base field of view and 44.9% at the widest. This is the line an uploaded
 * landscape's horizon is placed on, and the floor the runtime lock holds the generated one above.
 */
export const GAME_HORIZON = 0.44;
