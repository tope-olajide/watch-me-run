import { useEffect } from "react";
import { GAME_HORIZON, findSkyline, sampleRowBrightness } from "./skyline";

/**
 * The vertical lock: measures the generated video's horizon and moves the video so that horizon
 * never falls below the game's own.
 *
 * The generated world is the landscape and the game's road is a 46 m ribbon that fades into it, so
 * the two layers only actually meet in one narrow band: the game camera's horizon sits about 44% down
 * the frame and the ribbon dissolves at about 50%. Below the generated video's own horizon the video
 * is terrain the road continues into; above it, the video is sky. When the generated horizon sits
 * *below* that band, the video fills it with sky, the road's far end hangs in open air, and the
 * player reads it as running in the sky.
 *
 * The prompts ask for the horizon in the upper third, but a prompt is a request. This measures the
 * real frames and keeps the promise.
 *
 * ## How the horizon is found
 *
 * As the sharpest *darkening* step between adjacent rows of the frame. Live captures from all three
 * worlds show the same shape: a bright atmosphere band peaking just above a hard cliff, with the
 * darker ground below it. In each capture the largest single downward step is that cliff, by 1.6x to
 * 3.0x over the next largest step — desert 52% (step 56 luma), city 38% (52), forest 31% (44).
 *
 * A movement-based measure was tried first and thrown away. Over a pair of raw frames the desert's
 * *sky* changes more than its ground, because these prompts deliberately put heat haze, glare and
 * streaming sand up there, so "the ground is what moves" is simply false for this world.
 *
 * ## Why it only ever moves one way
 *
 * The failure is directional: the artefact is sky *under* the road, and it appears when the generated
 * horizon drops. So the lock will only ever raise the generated horizon. A horizon already at or
 * above the game's line is left exactly where it is, and a shift that is no longer needed is given
 * back slowly. A misread measurement can therefore never push the horizon down and cause the very
 * thing the lock exists to prevent.
 *
 * ## What it costs
 *
 * Moving the video needs material to move into, so the video is rendered slightly larger than its
 * frame (`--world-overscan` in src/styles.css). Scaling about the centre is the one thing this layer
 * does that also nudges the horizon — by half a percent at most, well inside the margin.
 */

const SAMPLE_INTERVAL_MS = 1_200;

/**
 * How many measurements the decision is taken over, as a median.
 *
 * Two separate problems, one fix. A raw measurement can only land on a row, so it is quantised — to
 * 3% of the frame at 32 rows, which is what made the lock flap: a horizon reading 0.469 one sample
 * and 0.500 the next sat either side of the deadband, so the shift relaxed and re-tightened and the
 * world slid up and down. And a single frame can simply be misread: in a live city run one sample
 * found a "horizon" at 0.563 among neighbours at 0.438, which an average would have carried into the
 * world as a 7% lurch. A median refuses both: it only moves once two of the last three measurements
 * agree, and at 48 rows it moves in 2% steps rather than 3%.
 */
const WINDOW = 3;
/** Within this of the game's line — or above it — counts as holding it. */
const DEADBAND = 0.025;
/** Share of the outstanding correction applied per sample; the CSS transition eases the rest. */
const APPLY = 0.5;
/**
 * How fast an unneeded shift is given back once the horizon is safe again. Deliberately much slower
 * than `APPLY`: a correction is expensive to earn and should not be handed back on one reading, and
 * the horizon sitting above the line for a moment is the safe state, not an emergency.
 */
const RELAX = 0.15;
/** Ceiling on that give-back, so even a clearly-safe reading still eases the shift home. */
const MAX_RELAX = 0.55;

/** The middle value, averaging the two middles when the window is even. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A number out of a CSS custom property, with the unit taken off. */
function styleNumber(element: Element, property: string, fallback: number): number {
  const raw = getComputedStyle(element).getPropertyValue(property).trim();
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The scale an element is currently composited at, read from the matrix the browser computed rather
 * than from a copy of the CSS that produced it. Both layers above the video scale it — the run's
 * `--run-speed` push-in on `.world-video` and the world layer's idle breath — and the shift solves
 * against whatever they are doing at that moment.
 */
function scaleOf(element: Element | null): number {
  if (!element) return 1;
  const transform = getComputedStyle(element).transform;
  if (!transform || transform === "none") return 1;
  const scale = Number.parseFloat(transform.slice(transform.indexOf("(") + 1));
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/**
 * The generated horizon as a fraction from the top of the video frame, or undefined when this frame
 * has no skyline clear enough to act on.
 *
 * The rule itself lives in `skyline.ts`, because the landscape preparation has to agree with it: a
 * picture the preparation placed on the game's line must be one the lock also reads as being on it.
 * What is measured here is the video band specifically — a generated frame whose "horizon" sits past
 * 60% is a frame the correction cannot rescue anyway.
 */
function detectHorizon(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
): { horizon: number; step: number; contrast: number } | undefined {
  const rows = sampleRowBrightness(video, canvas);
  if (!rows) return undefined;
  return findSkyline(rows);
}

/**
 * Starts measuring the generated horizon for as long as a run is on screen, and puts the video back
 * where it found it when the run ends.
 *
 * The shift is published as `--world-y` (a percentage), which `.world-video video` applies. The
 * measurement and the target are published too, so a headless run can read what the lock saw.
 */
export function useWorldAlign(): void {
  useEffect(() => {
    const root = document.documentElement;
    const canvas = document.createElement("canvas");
    let timer = 0;
    let shift = 0;
    let samples = 0;
    // Named `history`, not `window`: inside the sample loop a local of that name shadows the global
    // one, and the loop is built on `window.setTimeout`.
    const history: number[] = [];

    /**
     * The measurement is cleared when the run ends but the shift is not.
     *
     * Dropping the shift would animate the world down by as much as 8% while the run is pulling out
     * of it — a lurch during the one transition that is supposed to read as smooth. It is also the
     * wrong semantic: the shift is where this generated world's horizon currently sits, and the menu
     * is still showing that same world. The next run re-measures within a couple of samples, and the
     * relaxed rate below is proportional to how safe the horizon is, so a shift carried into a world
     * that never needed it is gone within a few seconds rather than lingering.
     */
    const clear = () => {
      root.style.removeProperty("--world-horizon");
      root.style.removeProperty("--world-horizon-window");
      root.style.removeProperty("--world-horizon-samples");
      root.style.removeProperty("--world-align-step");
      root.style.removeProperty("--world-align-contrast");
    };

    const sample = () => {
      const video = document.querySelector<HTMLVideoElement>(".world-layer video");
      if (!video || video.readyState < 2 || !video.videoWidth) {
        // No frames yet (a cold start, a renegotiation). Hold the last shift rather than dropping
        // the lock: whatever the world is doing, the road is still where it was.
        timer = window.setTimeout(sample, SAMPLE_INTERVAL_MS);
        return;
      }

      const found = detectHorizon(video, canvas);
      // Counted before the gate, so the published numbers can tell "no frames arrived" (no sample
      // count) from "frames arrived and no skyline was clear enough" (a count, but no horizon).
      samples += 1;
      root.style.setProperty("--world-horizon-samples", String(samples));
      if (!found) {
        timer = window.setTimeout(sample, SAMPLE_INTERVAL_MS);
        return;
      }

      const overscan = styleNumber(root, "--world-overscan", 1);
      // The video can only move as far as the overscan gave it material for.
      //
      // The ceiling is deliberately not sized to the worst case anyone has seen. The largest shift a
      // *real* skyline has needed is 6.9% (the desert's 52% against the game's 44.9%), so 8.5% has
      // headroom over the genuine need, and 17% of overscan is the visual price of that room. Sizing
      // it to the 20%+ some measurements have asked for would mean a 1.4x zoom bought on the strength
      // of measurements the gates now refuse — and a wrong measurement would then be able to move the
      // world by 20%. Past the ceiling the lock still helps: an out-of-reach skyline is raised by the
      // full 8.5% rather than left alone.
      const maxShift = Math.max(0, (overscan - 1) / 2);
      const target = styleNumber(root, "--game-horizon", GAME_HORIZON);

      // Where the measured row sits in the element *before* any transform. `object-fit: cover`
      // centres the generated frame, so on a viewport wider than the video it is cropped vertically
      // and the row moves up with it — the shift has to be solved against the row's real position,
      // not against the fraction it happens to sit at inside the file.
      const boxWidth = video.clientWidth;
      const boxHeight = video.clientHeight;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!boxWidth || !boxHeight || !width || !height) {
        timer = window.setTimeout(sample, SAMPLE_INTERVAL_MS);
        return;
      }
      const cover = Math.max(boxWidth / width, boxHeight / height);
      const rendered = height * cover;
      // Where the generated frame starts inside the element, as a fraction of its height. On a
      // viewport wider than the video, `object-fit: cover` crops it vertically and this goes negative.
      const contentTop = (boxHeight - rendered) / 2 / boxHeight;

      // Everything the layers above already scale by, so the solve matches what will be composited.
      const wrapper = video.closest(".world-video");
      const compositeScale = scaleOf(wrapper) * scaleOf(document.querySelector(".world-layer"));

      history.push(found.horizon);
      if (history.length > WINDOW) history.shift();
      const settled = median(history);

      // `target` is a floor, not a set-point: the frame is only shifted when the generated horizon
      // has fallen below the game's line, which is the one direction that breaks the composite.
      const margin = target + DEADBAND - settled;
      const safe = margin >= 0;
      // Solved from the same value the decision is made on. Solving from the newest row instead made
      // the two disagree: two frames with a low horizon would set the window, one frame with a high
      // horizon would size the correction, and the shift drifted back up while the window still said
      // the horizon was down.
      const row = contentTop + (settled * rendered) / boxHeight;
      const wanted = (target - 0.5) / compositeScale - (row - 0.5) * overscan;
      const goal = safe ? 0 : Math.max(-maxShift, wanted);
      // A horizon well above the line is clearly not going to need this shift, so it comes back
      // quickly; one sitting on the boundary comes back slowly, which is what stops the lock
      // relaxing and re-tightening on alternate samples.
      const relax = Math.min(MAX_RELAX, RELAX + margin * 4);
      shift = safe ? shift * (1 - relax) : shift + (goal - shift) * APPLY;
      shift = Math.max(-maxShift, Math.min(0, shift));

      // Published rather than logged: a sample every 1.2 s would bury the console, and a headless run
      // reads these straight off the document (see the alignment block in tools/orbis-probe.mjs).
      root.style.setProperty("--world-y", `${(shift * 100).toFixed(3)}%`);
      root.style.setProperty("--world-horizon", found.horizon.toFixed(4));
      root.style.setProperty("--world-horizon-window", settled.toFixed(4));
      root.style.setProperty("--world-align-step", found.step.toFixed(1));
      root.style.setProperty("--world-align-contrast", found.contrast.toFixed(2));

      timer = window.setTimeout(sample, SAMPLE_INTERVAL_MS);
    };

    sample();
    return () => {
      window.clearTimeout(timer);
      clear();
    };
  }, []);
}
