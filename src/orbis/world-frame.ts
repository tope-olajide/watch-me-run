/**
 * The live world, held still.
 *
 * Orbis produces video and audio and nothing else, so the only way the *game's* geometry can carry
 * anything Orbis made is to read pixels out of the stream the SDK is already playing. This module
 * does exactly that: it samples the session's own `<video>` into a small canvas at about one frame a
 * second, and hands that canvas to whoever wants a picture of the world.
 *
 * That is the whole idea behind the roadside's lit panels (see `src/game/roadside`): the buildings are
 * ours, the picture on their camera-facing face is a frame of the world the player is steering, so the
 * roadside changes as the world morphs and as the director steers it. It is the most direct answer to
 * "can Orbis be used for the scenery" — not by generating the scenery, which it cannot do, but by
 * generating what the scenery is wearing.
 *
 * ## Why a polled sample, and why a small one
 *
 * There is no frame callback to subscribe to: `requestVideoFrameCallback` is on the element the SDK
 * owns, not on anything this layer is given, and the element is replaced underneath us when the
 * provider rebuilds it. So the sampler is a timer, and it checks for a usable picture each time —
 * `readyState` and a non-zero width, which together are "there are decoded frames on this element".
 *
 * The canvas is 320x180 and deliberately not the stream's own resolution. A panel is seen at 20-40 m
 * at speed, so 320x180 is more detail than can possibly be read, and it keeps the copy at about
 * 60 kB a second instead of 8 MB. The upload is a single texSubImage2D a second, which is nothing
 * next to the video that is already being composited.
 *
 * ## The last frame is kept
 *
 * A dropped link clears the sampler but not the canvas: the panels go on showing the last thing the
 * world was, for as long as it takes to come back. Swapping to the fallback art the instant a
 * reconnection starts would flicker the roadside from "the world" to "a pattern" and back, which is
 * more visible than a slightly stale poster ever is.
 */

const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 180;

/**
 * How often the world is sampled.
 *
 * Under a second would be spending frames to show the same static landscape twice; a landscape that
 * changes at Orbis's chunk rate does not need sampling to keep up with it, and the panels are not the
 * main event anyway. Slow enough to be free, fast enough that a morph shows up while it is happening.
 */
const SAMPLE_MS = 900;

let canvas: HTMLCanvasElement | null = null;
let context: CanvasRenderingContext2D | null = null;
let video: HTMLVideoElement | null = null;
let timer = 0;
/** Bumped on every sample that drew, so a consumer can tell a fresh frame from a repeated one. */
let revision = 0;
/** Set when the picture can never be read (a cross-origin source would taint the canvas). */
let unreachable = false;

function raster(): HTMLCanvasElement {
  if (canvas) return canvas;
  const created = document.createElement("canvas");
  created.width = FRAME_WIDTH;
  created.height = FRAME_HEIGHT;
  canvas = created;
  context = created.getContext("2d");
  return created;
}

function sample(): void {
  timer = window.setTimeout(sample, SAMPLE_MS);
  const source = video;
  if (unreachable || !source || source.readyState < 2 || source.videoWidth === 0) return;
  // Creates the canvas on the first usable frame, which is also where `context` comes from.
  raster();
  if (!context) return;

  try {
    context.drawImage(source, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
  } catch (cause) {
    unreachable = true;
    console.warn("[orbis] the live world cannot be sampled into a panel", cause);
    return;
  }

  if (revision === 0) {
    // The taint check, done once, on the first picture. Drawing a stream that belongs to this page
    // keeps the canvas origin-clean, so this cannot throw today — but a tainted canvas fails much
    // later and much worse, inside the WebGL upload, once a frame, for the rest of the visit. One
    // pixel read is the cheapest possible way to find out before that happens.
    try {
      context.getImageData(0, 0, 1, 1);
    } catch {
      unreachable = true;
      canvas = null;
      context = null;
      console.warn("[orbis] the world stream cannot be read from this page — panels use the fallback art");
      return;
    }
  }

  revision += 1;
}

/**
 * Point the sampler at the session's video element, or at nothing.
 *
 * Called by the world layer from the same watcher that already finds the element, so there is one
 * answer to "where is the world being played" rather than two watchers that can disagree about it.
 */
export function attachWorldVideo(next: HTMLVideoElement | null): void {
  if (next === video) return;
  video = next;
  if (!next) {
    window.clearTimeout(timer);
    timer = 0;
    return;
  }
  if (!timer) sample();
}

/** The newest sampled frame of the world, or null if there has never been one. */
export function worldFrameCanvas(): HTMLCanvasElement | null {
  return revision > 0 ? canvas : null;
}

/** Counts samples that actually drew. A consumer uploads the canvas only when this changes. */
export function worldFrameRevision(): number {
  return revision;
}

declare global {
  interface Window {
    /** Development-only readout: whether the panels have a live world to show, and how fresh. */
    __orbisFrame?: () => { revision: number; width: number; height: number };
  }
}

if (import.meta.env.DEV) {
  window.__orbisFrame = () => ({
    revision,
    width: revision > 0 ? FRAME_WIDTH : 0,
    height: revision > 0 ? FRAME_HEIGHT : 0,
  });
}
