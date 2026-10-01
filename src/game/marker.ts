import { useSyncExternalStore } from "react";

/**
 * The best-line mark: the ring and the light on the road where the best run held its lane.
 *
 * The record is drawn twice, and the two drawings are for different people. The HUD carries the
 * *race* — metres ahead or behind the best run at the same second — which is a number you can win or
 * lose. The road carries the *line*: a mark standing in the lane the best run was in at the metre the
 * player is at now, which is a thing to aim at. The line is a memory of a run rather than a piece of
 * the world, and it is **off by default**: help a player should ask for, not something they have to
 * work out how to ignore, and on a first visit there is no best run for it to point at anyway.
 *
 * Kept in `localStorage` under `watchme-run:marker`, validated on read like every other preference in
 * the game — a blocked or hand-edited store costs the player a mark, not a run.
 */
const STORAGE_KEY = "watchme-run:marker";

let cached: boolean | null = null;
const listeners = new Set<() => void>();

function read(): boolean {
  if (cached !== null) return cached;
  try {
    cached = window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    cached = false;
  }
  return cached;
}

/** The preference as the simulation reads it, without a subscription (the frame loop's side). */
export function markerEnabled(): boolean {
  return read();
}

export function setMarkerEnabled(next: boolean): void {
  cached = next;
  try {
    if (next) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // A blocked store means the choice lasts the visit, which is still the choice.
  }
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useMarkerEnabled(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
