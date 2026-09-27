import { useSyncExternalStore } from "react";
import type { ReactorStatus } from "@reactor-team/js-sdk";
import type { Environment } from "../game/run-state";
import type { PreparedLandscape } from "./landscape";
import { recordPrompt, type PromptChannel, type PromptReason } from "./prompt-journal";
import type { WorldView } from "./prompts";

/**
 * The seam between the interface and the Orbis world.
 *
 * The world layer is loaded lazily so the first paint stays cheap, and it is mounted once at the
 * app level so one Reactor session survives the whole visit: the menu previews a world, a run
 * continues in that same stream, and going back to the menu keeps it alive. Because the layer
 * arrives after the interface, the interface talks to it through this bus instead of React
 * context — nothing remounts when the world shows up, and nothing breaks if it never does.
 *
 * The bus also owns the two things that outlive a single surface: which world and which landscape
 * are selected (the menu sets them, the run and the layer read them), and the session state Orbis
 * reports about itself. Both live here rather than in component state because the run and the menu
 * are separate mounts of the same world.
 *
 * `import type` is erased at build time, so this module stays free of the Reactor runtime.
 */

export type OrbisVideoState = "off" | "waiting" | "streaming";

/** `idle` means the world layer itself has not loaded yet. */
export type WorldStatus = ReactorStatus | "idle";

/**
 * What Orbis says about the session, published straight from its `state` snapshot.
 *
 * Read rather than assumed: every one of these is a precondition for a command, and the SDK answers
 * an unmet precondition with a `command_error` broadcast instead of throwing. Pausing an already
 * paused session and resuming one that is not paused both look like a broken world in the console
 * while being nothing of the sort, so the commands are gated on this instead.
 */
export type WorldSessionState = {
  /** True once `start` has been accepted. Stays true while paused; cleared by `reset`. */
  started: boolean;
  /** The chunk loop is producing frames — `started and not paused`. */
  running: boolean;
  paused: boolean;
  /** Index of the last completed chunk; 0 before the first one, and back to 0 on `reset`. */
  chunk: number;
  /** True once the session holds a starting image — a landscape the player supplied. */
  hasImage: boolean;
  resolution?: string;
  availableResolutions: string[];
  /**
   * Whether this run generates sound, and the caption conditioning it.
   *
   * Published because the sound is the one part of the world no headless check can hear: the picture
   * can be measured off the frames, but "is the audio channel live and is it being steered" is only
   * answerable from the model's own report of what it is generating.
   */
  audioEnabled: boolean;
  audioPrompt: string | null;
};

const NO_SESSION: WorldSessionState = {
  started: false,
  running: false,
  paused: false,
  chunk: 0,
  hasImage: false,
  availableResolutions: [],
  audioEnabled: false,
  audioPrompt: null,
};

export type WorldSnapshot = {
  status: WorldStatus;
  videoState: OrbisVideoState;
  /** The world currently being generated. */
  world?: Environment;
  error?: string;
  sessionId?: string;
  /** True while a run is on screen: the world keeps sound and must not be recycled. */
  runActive: boolean;
  /** True while the player has paused the run, which pauses generation with it. */
  pauseRequested: boolean;
  /**
   * True while a supplied landscape is being pinned into the session.
   *
   * Pinning is a rebuild — `reset`, then the image, then `start` — and it is the one thing that must
   * not happen underneath a run: a reset is a hard cut, and one landing in the middle of the dive
   * would throw away the launch shot the transition had just asked for. So the intent is published
   * from the moment the player picks a picture, and the menu holds the run until it is done.
   */
  pinning: boolean;
  /** What Orbis reports about the session as it stands. */
  session: WorldSessionState;
  /** The picture this world is being grown from, or null when Orbis invents the landscape. */
  landscape: PreparedLandscape | null;
};

const EMPTY: WorldSnapshot = {
  status: "idle",
  videoState: "off",
  runActive: false,
  pauseRequested: false,
  pinning: false,
  session: NO_SESSION,
  landscape: null,
};

let snapshot: WorldSnapshot = EMPTY;
const listeners = new Set<() => void>();

export function getWorldSnapshot(): WorldSnapshot {
  return snapshot;
}

declare global {
  interface Window {
    /**
     * The live world snapshot, in development only.
     *
     * The state this publishes — what Orbis says about the session, what landscape is pinned, whether
     * the world is paused — exists nowhere in the DOM in any readable form, and a probe that scraped
     * it out of console lines would be reading a lagging copy of it. Same reasoning as
     * `window.__orbisPrompts`: publish the value, read the value.
     */
    __orbisWorld?: () => WorldSnapshot;
  }
}

if (import.meta.env.DEV) window.__orbisWorld = getWorldSnapshot;

export function subscribeWorld(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function updateWorld(patch: Partial<WorldSnapshot>): void {
  // Keys present in the patch are intentional — `{ error: undefined }` clears an error.
  const changed = (Object.keys(patch) as (keyof WorldSnapshot)[]).some(
    (key) => patch[key] !== snapshot[key],
  );
  if (!changed) return;

  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

/** The snapshot as React state, so any surface can render world status without the SDK. */
export function useWorld(): WorldSnapshot {
  return useSyncExternalStore(subscribeWorld, getWorldSnapshot, getWorldSnapshot);
}

/** One place for the status copy the menu and the run both show. */
export function worldLabel(snapshot: WorldSnapshot): string {
  if (snapshot.error) return "Local world mode";
  switch (snapshot.status) {
    case "idle":
      return "Loading world engine";
    case "connecting":
      return "Waking the world engine";
    case "waiting":
      return "Generating first frames";
    case "ready":
      return snapshot.videoState === "streaming"
        ? "Live world streaming"
        : "Generating first frames";
    default:
      return "Local world mode";
  }
}

/** Chip modifier so a surface can style live / local / warming states differently. */
export function worldTone(snapshot: WorldSnapshot): "live" | "warming" | "local" {
  if (snapshot.error) return "local";
  if (snapshot.status === "ready" && snapshot.videoState === "streaming") return "live";
  if (snapshot.status === "idle" || snapshot.status === "disconnected") return "local";
  return "warming";
}

export type WorldRequest = {
  environment: Environment;
  restart?: boolean;
  /**
   * The starting frame for this world, or null for a world Orbis invents. Part of the request rather
   * than a separate command because it is a *condition* of the session: it can only be pinned before
   * `start`, and only `reset` clears one — so changing it is a different world, not a new prompt.
   */
  landscape: PreparedLandscape | null;
};

/** True once the world layer is mounted and listening. */
export function isWorldLayerReady(): boolean {
  return commands !== null;
}

export type PromptMeta = { channel?: PromptChannel; reason?: PromptReason };

type WorldCommands = {
  showWorld: (request: WorldRequest) => void;
  sendPrompt: (prompt: string, entry?: ReturnType<typeof recordPrompt>) => void;
  sendAudio: (prompt: string, entry?: ReturnType<typeof recordPrompt>) => void;
  retry: () => void;
};

let commands: WorldCommands | null = null;
let pending: WorldRequest | null = null;
/** The world the interface has asked for. Set synchronously so a view can be built from it. */
let selected: Environment = "desert";
let landscape: PreparedLandscape | null = null;

/**
 * The layer registers itself when its chunk loads and unregisters when it goes away. Requests
 * made before that are held rather than dropped, so the menu can ask for a world immediately.
 *
 * Unregistering is deliberately silent: notifying here would re-render the surfaces that asked
 * for the world, and a surface that re-renders can re-register, which is how an update loop
 * starts.
 */
export function registerWorldCommands(next: WorldCommands): WorldRequest | null {
  commands = next;
  const queued = pending;
  pending = null;
  return queued;
}

export function unregisterWorldCommands(): void {
  commands = null;
}

/* ---- the world's real cadence ------------------------------------------------------------------
 *
 * `chunk_complete` is the one message that says how the world actually moves: one chunk of frames
 * finished, and the next prompt will be read at the top of the next one. A director working on
 * wall-clock cooldowns alone is always guessing where that boundary is, and a prompt sent just after
 * one has to wait a whole chunk to take effect. Publishing the boundary lets the run spend its asks
 * where they land.
 */
export type ChunkTick = { index: number; at: number };
const chunkListeners = new Set<(tick: ChunkTick) => void>();

export function publishChunk(tick: ChunkTick): void {
  // The session's chunk index is folded in here, from the message that carries it, rather than
  // waiting for the `state` that follows — one ask is spent per chunk, so "which chunk is this" has
  // to be the same answer for the director that gates on it and for the journal that records it.
  if (snapshot.session.chunk !== tick.index) {
    updateWorld({ session: { ...snapshot.session, chunk: tick.index } });
  }
  for (const listener of chunkListeners) listener(tick);
}

export function subscribeChunks(listener: (tick: ChunkTick) => void): () => void {
  chunkListeners.add(listener);
  return () => {
    chunkListeners.delete(listener);
  };
}

export const world = {
  /** Morphs the live world into this environment, connecting if there is no session yet. */
  showWorld(environment: Environment, options?: { restart?: boolean }): void {
    selected = environment;
    const request: WorldRequest = {
      environment,
      restart: options?.restart,
      landscape,
    };
    if (commands) {
      commands.showWorld(request);
      return;
    }
    pending = request;
  },
  /**
   * Selects the picture the world is grown from, for the selected world, and asks for that world
   * again so the layer pins it.
   *
   * Passing null goes back to a world Orbis invents. Either way this replaces the landscape for the
   * whole visit rather than for a run: the player picked it as their landscape, and a run that
   * silently went back to a generated desert would be the feature quietly not working.
   */
  selectLandscape(next: PreparedLandscape | null): void {
    landscape = next;
    // Set before the request goes out, not when the layer starts working: the layer's effect runs a
    // render later, and the menu has to be holding the run already when that render lands.
    updateWorld({ landscape: next, pinning: true });
    if (commands) commands.showWorld({ environment: selected, landscape: next });
    else pending = { environment: selected, landscape: next };
  },
  /** The prompt view for a world: which environment, and whether the landscape is the player's. */
  view(environment: Environment = selected): WorldView {
    return { environment, custom: landscape !== null };
  },
  /**
   * Two prompt channels. `app` prompts come from the menu and the transitions, which own the world
   * around a run; `run` prompts come from the run's director, one per meaningful gameplay event.
   *
   * A run prompt is only sent while a run is on screen. The gate lives here, at the send, because
   * `leaving` reaches the run a render after the click while the director's 1.8 s flush timer only
   * needs that window to fire a distance event over the menu's establishing shot. The exit handler
   * therefore clears `runActive` synchronously, and this flag is what silences an ending run.
   */
  sendPrompt(prompt: string, meta: PromptMeta = {}): void {
    const channel = meta.channel ?? "app";
    // Recorded before anything else so the journal always shows what was asked for, even when the
    // ask never leaves the page — and the reason is recorded with it, so intent is checkable.
    const entry = recordPrompt({
      channel,
      reason: meta.reason ?? "world-morph",
      environment: snapshot.world,
      status: snapshot.status,
      prompt,
      chunk: snapshot.session.chunk,
    });

    if (channel === "run" && !snapshot.runActive) {
      if (entry) entry.dropped = "that run is over";
      if (import.meta.env.DEV) console.info("[orbis] dropped a run prompt: that run is over");
      return;
    }

    if (!commands) {
      if (entry) entry.dropped = "world layer not loaded yet";
      return;
    }

    commands.sendPrompt(prompt, entry);
  },
  /**
   * The sound channel, gated exactly like the visual one: it is played over the run, so a caption
   * from a run that has ended must not land on the menu's world either.
   */
  sendAudio(prompt: string, meta: PromptMeta = {}): void {
    const channel = meta.channel ?? "app";
    const entry = recordPrompt({
      channel,
      reason: meta.reason ?? "world-audio",
      environment: snapshot.world,
      status: snapshot.status,
      prompt,
      track: "audio",
      chunk: snapshot.session.chunk,
    });

    if (channel === "run" && !snapshot.runActive) {
      if (entry) entry.dropped = "that run is over";
      return;
    }
    if (!commands) {
      if (entry) entry.dropped = "world layer not loaded yet";
      return;
    }
    commands.sendAudio(prompt, entry);
  },
  /**
   * The player's pause, which pauses generation as well as the run.
   *
   * Frames stop streaming on `main_video` while paused, which is both what a paused world should look
   * like and what stops a paused session from spending the account's compute on chunks nobody is
   * watching. The wanted state is published, not commanded: the layer reconciles it against what
   * Orbis reports, because `pause` on an already-paused session is a `command_error`.
   */
  setPaused(pauseRequested: boolean): void {
    updateWorld({ pauseRequested });
  },
  retry(): void {
    commands?.retry();
  },
  /** Runs take the sound and pin the session; the menu leaves it muted and recyclable. */
  setRunActive(runActive: boolean): void {
    updateWorld({ runActive });
  },
};
