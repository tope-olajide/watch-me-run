import { useSyncExternalStore } from "react";

/**
 * The tone of the generated world, measured from the live video.
 *
 * The runner's ground is drawn in WebGL while the world behind it is a video, so the two only read
 * as one place if the ground is graded into the world's tonal range. Measuring the real frames —
 * instead of trusting a per-world preset — means the ribbon follows whatever Orbis actually
 * produces: a bright noon on the dunes, a blacked-out neon city, a foggy forest.
 *
 * Kept free of Reactor imports: it only ever looks at the `<video>` the world layer puts on screen.
 */

export type WorldTone = {
  /** True once a live frame has actually been measured. */
  live: boolean;
  /** Mean luma of the generated frames, 0-255. */
  luma: number;
  /**
   * Mean luma of the generated ground just under the horizon — the visible terrain the ribbon's far
   * end dissolves into. This is the number the road is graded against: matching the whole-frame
   * average would put the ribbon in the range of the sky, and matching the bottom of the frame would
   * grade it against the distance haze that now covers the near ground.
   */
  ground: number;
  /** Mean colour of the generated frames, normalised so the brightest channel is 1. */
  tint: [number, number, number];
};

const NEUTRAL: WorldTone = { live: false, luma: 128, ground: 128, tint: [1, 1, 1] };
const SAMPLE_WIDTH = 32;
/**
 * 36 rows rather than 18: the ground band below is narrow, and at 18 rows the whole frame is 5.6%
 * per row, so the band would jump a whole row at a time as the horizon drifts through it.
 */
const SAMPLE_HEIGHT = 36;
/**
 * The ground band when no horizon has been measured (the menu, a stalled lock): the visible terrain
 * just under the game's line, where the ribbon's far end fades into the world. It used to be the
 * lower third, but the lower band is now the distance haze (the ramp on `.world-video` in
 * src/styles.css) — the tone the ribbon must belong to is the terrain at the meeting line, not
 * ground the player can no longer see.
 */
const GROUND_TOP = 0.46;
const GROUND_BOTTOM = 0.6;
/**
 * Where the ground band sits relative to a *measured* horizon (frame fractions).
 *
 * Anchored rather than fixed, and that matters more than it looks. A fixed band near the horizon
 * straddles the skyline step half the time: as the lock shifts the video — or the model drifts — the
 * band alternates between sky-edge and ground, the measured tone swings by multiples, and
 * `--road-grade` flapped between 0.69 and its 2.0 clamp inside a single run. A band that starts
 * just under wherever the horizon actually is (published by the vertical lock as
 * `--world-horizon-window`, a raw fraction of the video frame) measures ground every time.
 */
const GROUND_BELOW_HORIZON = 0.02;
const GROUND_BAND_HEIGHT = 0.12;
/** Median window for the ground reading: one misread frame must not move the road's grade. */
const GROUND_SMOOTHING = 5;
const SAMPLE_INTERVAL_MS = 1200;
/** A measurement has to move this much to be worth re-rendering the runner for. */
const LUMA_EPSILON = 2.5;
const TINT_EPSILON = 0.02;
/** The world's colour is applied at half strength: a lean, never a filter. */
const TINT_STRENGTH = 0.5;

let tone: WorldTone = NEUTRAL;
let timer = 0;
let canvas: HTMLCanvasElement | undefined;
/** The last few ground readings, kept for the median. */
const groundHistory: number[] = [];

/** The ground band in sample rows: under the measured horizon when there is one, fixed otherwise. */
function groundBand(): { top: number; rows: number } {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--world-horizon-window")
    .trim();
  const horizon = Number.parseFloat(raw);
  const measured = Number.isFinite(horizon);
  const top = measured ? Math.min(Math.max(horizon + GROUND_BELOW_HORIZON, 0.2), 0.8) : GROUND_TOP;
  const bottom = measured ? Math.min(top + GROUND_BAND_HEIGHT, 0.96) : GROUND_BOTTOM;
  const first = Math.round(top * SAMPLE_HEIGHT);
  const last = Math.round(bottom * SAMPLE_HEIGHT);
  return { top: first, rows: Math.max(1, last - first) };
}

function smoothedGround(value: number): number {
  groundHistory.push(value);
  if (groundHistory.length > GROUND_SMOOTHING) groundHistory.shift();
  const sorted = [...groundHistory].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}
/** When the last frame was actually measured, so a brief gap does not reset the grade. */
let measuredAt = -Infinity;
/** A measurement stays usable across short gaps (a stream hiccup, a canvas reattach). */
const LIVE_GRACE_MS = 4000;
const listeners = new Set<() => void>();

export function getWorldTone(): WorldTone {
  return tone;
}

export function useWorldTone(): WorldTone {
  return useSyncExternalStore(subscribeTone, getWorldTone, getWorldTone);
}

function subscribeTone(listener: () => void): () => void {
  listeners.add(listener);
  ensureSampling();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopSampling();
  };
}

function ensureSampling(): void {
  if (timer) return;
  timer = window.setInterval(readVideo, SAMPLE_INTERVAL_MS);
  readVideo();
}

function stopSampling(): void {
  window.clearInterval(timer);
  timer = 0;
}

function publish(next: WorldTone): void {
  const changed =
    next.live !== tone.live ||
    Math.abs(next.luma - tone.luma) > LUMA_EPSILON ||
    Math.abs(next.ground - tone.ground) > LUMA_EPSILON ||
    next.tint.some((channel, index) => Math.abs(channel - tone.tint[index]) > TINT_EPSILON);
  if (!changed) return;

  tone = next;
  if (typeof document !== "undefined") {
    document.documentElement.style.setProperty("--world-luma", tone.luma.toFixed(1));
    document.documentElement.style.setProperty("--world-ground-luma", tone.ground.toFixed(1));
    document.documentElement.style.setProperty("--world-tone", tone.live ? "live" : "preset");
  }
  for (const listener of listeners) listener();
}

/** Reads the average colour of one live frame; a few dozen pixels are plenty. */
function readVideo(): void {
  const video = document.querySelector<HTMLVideoElement>(".world-layer video");
  if (!video || video.readyState < 2 || video.videoWidth === 0) {
    // Keep the last measured value — and keep treating it as live for a moment — so the road does
    // not jump between the world's preset and a measurement every time the stream hiccups.
    publish({
      live: performance.now() - measuredAt < LIVE_GRACE_MS,
      luma: tone.luma,
      ground: tone.ground,
      tint: tone.tint,
    });
    return;
  }

  try {
    canvas ??= document.createElement("canvas");
    canvas.width = SAMPLE_WIDTH;
    canvas.height = SAMPLE_HEIGHT;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;

    const whole = average(video, context, 0, SAMPLE_HEIGHT);
    const band = groundBand();
    const ground = average(video, context, band.top, band.rows);
    if (!whole || !ground) return;

    const peakChannel = Math.max(whole.mean[0], whole.mean[1], whole.mean[2], 1);
    const tint = whole.mean.map(
      (channel) => 1 + (channel / peakChannel - 1) * TINT_STRENGTH,
    ) as [number, number, number];

    measuredAt = performance.now();
    publish({ live: true, luma: whole.luma, ground: smoothedGround(ground.luma), tint });
  } catch (cause) {
    // A tainted canvas would land here; grading simply falls back to the per-world presets.
    console.info("[watchme] generated frames cannot be sampled for grading", cause);
    publish({
      live: performance.now() - measuredAt < LIVE_GRACE_MS,
      luma: tone.luma,
      ground: tone.ground,
      tint: tone.tint,
    });
  }
}

/**
 * Mean colour and luma of one horizontal slice of the live frame. Rows are counted in sample rows,
 * so callers never deal with raw pixel offsets — the slice is taken from the video in proportion.
 */
function average(
  video: HTMLVideoElement,
  context: CanvasRenderingContext2D,
  skipRows: number,
  rowCount: number,
): { mean: [number, number, number]; luma: number } | undefined {
  if (rowCount <= 0) return undefined;
  const sourceY = video.videoHeight * (skipRows / SAMPLE_HEIGHT);
  const sourceHeight = video.videoHeight * (rowCount / SAMPLE_HEIGHT);

  context.clearRect(0, 0, SAMPLE_WIDTH, rowCount);
  context.drawImage(
    video,
    0,
    sourceY,
    video.videoWidth,
    sourceHeight,
    0,
    0,
    SAMPLE_WIDTH,
    rowCount,
  );

  const { data } = context.getImageData(0, 0, SAMPLE_WIDTH, rowCount);
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let index = 0; index < data.length; index += 4) {
    red += data[index];
    green += data[index + 1];
    blue += data[index + 2];
  }
  const pixels = data.length / 4;
  if (!pixels) return undefined;

  const mean: [number, number, number] = [red / pixels, green / pixels, blue / pixels];
  return { mean, luma: 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2] };
}
