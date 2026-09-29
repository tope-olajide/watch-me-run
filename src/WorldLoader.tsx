import { useEffect, useRef, useState } from "react";
import type { CharacterId } from "./game/character-catalog";
import { characterCatalog } from "./game/character-catalog";
import type { Environment } from "./game/run-state";
import { worldById } from "./game/worlds";
import { useWorld, world, type WorldSnapshot } from "./orbis/world-bus";

/**
 * The screen between pressing Start and running.
 *
 * The menu deliberately asks Orbis for nothing (see `src/MenuExperience`), so this is where the world
 * is actually requested and where the wait for it lives. It is not decoration: a cold session can take
 * tens of seconds — a token, a connection, a landscape `reset`, an image upload, a pin, and enough
 * of a chunk to have a first frame on screen — and the alternative to showing that wait was showing
 * it as a disabled button on the menu, which told the player nothing about what they were waiting for.
 *
 * So it names the step it is on. Every one of the four is a real state Orbis reports about itself (see
 * `WorldSessionState`), not a timer pretending to be progress: `connecting`, then generating, then
 * `pinning` — which is the only step that can take a while by itself, because a landscape is a
 * rebuild rather than a prompt — and finally the start, and the first frames it produces. The elapsed
 * count is there for the same reason: a slow step should look slow rather than look broken, and a
 * player who knows it has been nine seconds can decide to wait.
 *
 * ## It can give up, and that is a feature
 *
 * The runner is playable in local world mode, and the whole design of the world layer assumes Orbis
 * may never arrive. A loading screen that waits forever would break exactly that promise — so past
 * `LOADING_FALLBACK_MS` the run starts anyway, on the local backdrop, and the loader says so. The
 * world keeps being retried underneath (the recovery effect in `WorldLayer`), so a late arrival still
 * lands mid-run.
 */
export type WorldLoaderProps = {
  environment: Environment;
  characterId: CharacterId;
  /** `performance.now()` at the click, so the minimum display time is measured from the Start press. */
  startedAt: number;
  onReady: () => void;
};

/**
 * How long a run waits for Orbis before it starts anyway.
 *
 * Set from what a cold session actually costs, not from what it ought to: a live measured start —
 * token, session create, transport, a starting image, the conditions, the delivery tier, `start`, and
 * enough of a chunk for the model to report itself running — has taken over thirty seconds, and the
 * world layer's own readiness diagnosis allows a session forty seconds to reach `ready` before it even
 * begins arming. A budget below that turns a slow world into a local-world run that then has to be
 * steered by a director with nothing to steer.
 */
const LOADING_FALLBACK_MS = 55_000;

/**
 * The shorter budget once Orbis has reported a problem.
 *
 * A busy account, a refused session, a rejected key: each is a thing waiting does not fix, and the
 * recovery is on the world layer's minute-long retry clocks rather than on this screen. So the player
 * is handed a playable run as soon as it is clear that Orbis is not the holdup, and the world joins
 * from behind the run when its retry lands (see the recovery effect in `WorldLayer`). The clock is
 * restarted from the moment the error arrived, so a slow-but-healthy start is never cut short by it.
 */
const LOADING_ERROR_FALLBACK_MS = 20_000;

/** The shortest the screen is shown: a warm world must not flash it for two frames. */
const LOADING_MIN_MS = 900;

/**
 * How long the hand-over waits for the first frames once generation is running.
 *
 * `started` is the model's word for its loop being on, and that is not the same thing as a picture: a
 * cold desert start handed the run over with `video: waiting`, and the first frames landed after the
 * player was already on screen. So the frames are waited for — but only this long, because the promise
 * this screen has to keep is that a run always starts. A session that generates and never paints
 * (autoplay blocked, a transport that stalled after the start) opens the run on the local backdrop
 * instead, which is the same honest fallback as the timeout below, with Orbis still trying underneath
 * it. Eight seconds is generous against what a chunk costs — chunks are 1.5-2 s apart — and short
 * enough that the worst case is a wait rather than a stall.
 */
const LOADING_FRAMES_MS = 8_000;

/** The four things a run waits for, in the order they happen. */
const STAGES = [
  "Waking the world engine",
  "Generating your world",
  "Pinning your landscape",
  "Arming the run",
] as const;

/** Which step the session is on, from what Orbis reports. `STAGES.length` means every step is done. */
function stageIndex(state: WorldSnapshot, framesGivenUp: boolean): number {
  if (state.pinning) return 2;
  if (state.status === "ready") {
    if (!state.session.started) return 3;
    // The last step has two halves — the start, and the frames it produces arriving on screen — and by
    // this point the second is the one being waited for.
    return state.videoState === "streaming" || framesGivenUp ? STAGES.length : 3;
  }
  if (state.status === "waiting") return 1;
  return 0;
}

/** What the step is doing, in the player's terms rather than the SDK's. */
function stageLine(state: WorldSnapshot, stage: number): string {
  if (state.error) return state.error;
  switch (stage) {
    case 0:
      return "Connecting to Orbis and reserving a session";
    case 1:
      return "Orbis is generating the world live — its first frames are on the way";
    case 2:
      return state.landscape
        ? `Placing ${state.landscape.label} on the horizon line and growing the world from it`
        : "Rebuilding the world from your picture";
    case 3:
      return state.session.started
        ? "The world is generating — waiting for its first frames to reach the screen"
        : "Waking the generation loop and handing it to the run";
    default:
      return "The world is live. Entering";
  }
}

export default function WorldLoader({ environment, characterId, startedAt, onReady }: WorldLoaderProps) {
  const state = useWorld();
  const [timedOut, setTimedOut] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const failed = Boolean(state.error);
  /** Set once the hand-off has been made, so a re-render cannot report it twice. */
  const reported = useRef(false);
  /** When generation first reported itself running, which is when the wait for frames is measured from. */
  const generationAt = useRef<number | null>(null);
  /** Set when the frames never arrived and the wait for them was given up on. */
  const [framesGaveUp, setFramesGaveUp] = useState(false);
  const character = characterCatalog.find((item) => item.id === characterId);
  const selected = worldById(environment);
  /** Whether the world's frames have actually reached the screen, as opposed to being asked for. */
  const streaming = state.videoState === "streaming";

  /**
   * The request itself. This is the first thing in the visit that asks Orbis for a world, which is why
   * it is here rather than in the menu: the request *is* the loading screen's reason to exist.
   */
  useEffect(() => {
    world.showWorld(environment);
  }, [environment]);

  useEffect(() => {
    const budget = failed ? LOADING_ERROR_FALLBACK_MS : LOADING_FALLBACK_MS;
    const timer = window.setTimeout(() => setTimedOut(true), budget);
    return () => window.clearTimeout(timer);
  }, [failed]);

  useEffect(() => {
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (state.session.started && generationAt.current === null) {
      generationAt.current = performance.now();
    }
  }, [state.session.started]);

  /** The frames the start is supposed to produce, bounded — see LOADING_FRAMES_MS. */
  useEffect(() => {
    if (!state.session.started || streaming || framesGaveUp) return;
    const waited = performance.now() - (generationAt.current ?? performance.now());
    const timer = window.setTimeout(
      () => setFramesGaveUp(true),
      Math.max(0, LOADING_FRAMES_MS - waited),
    );
    return () => window.clearTimeout(timer);
  }, [state.session.started, streaming, framesGaveUp]);

  // Armed: the session has a starting image (if one was asked for), generation is running, nothing is
  // still being pinned into it, and its first frames are on their way to the screen. The wait is
  // measured from the Start press rather than from this mount, so a second run inside the grace window
  // is instant instead of paying the minimum twice.
  const armed =
    state.status === "ready" &&
    state.session.started &&
    !state.pinning &&
    (streaming || framesGaveUp);

  useEffect(() => {
    if (reported.current || (!armed && !timedOut)) return;
    const hold = Math.max(0, LOADING_MIN_MS - (performance.now() - startedAt));
    const timer = window.setTimeout(() => {
      if (reported.current) return;
      reported.current = true;
      onReady();
    }, hold);
    return () => window.clearTimeout(timer);
  }, [armed, timedOut, onReady, startedAt]);

  const stage = stageIndex(state, framesGaveUp);
  const live = armed && streaming;

  return (
    <main
      className="world-loader"
      data-world={environment}
      data-stage={stage}
      data-timed-out={timedOut ? "true" : "false"}
      data-armed={armed ? "true" : "false"}
      role="status"
      aria-live="polite"
    >
      <div className="loader-core">
        <span className="eyebrow">Orbis · live world engine</span>
        <h1 className="loader-title">{selected.label}</h1>
        <p className="loader-line">{timedOut && !armed ? "Orbis is taking longer than usual — starting in local world mode. The world will join when it can." : stageLine(state, stage)}</p>

        <ol className="loader-stages">
          {STAGES.map((label, index) => (
            <li
              key={label}
              className={index < stage ? "done" : index === stage ? "active" : "pending"}
            >
              <span className="loader-tick" aria-hidden="true" />
              {label}
            </li>
          ))}
        </ol>

        <div className="loader-track" aria-hidden="true">
          <span className="loader-fill" data-done={stage >= STAGES.length ? "true" : "false"} />
        </div>

        <div className="loader-meta">
          <span>{seconds}s elapsed</span>
          <span>{state.session.resolution ?? "1080p"} · {live ? "streaming" : "priming"}</span>
        </div>

        {character && (
          <p className="loader-runner">
            {character.label} is ready · {selected.intro.line.toLowerCase()}
          </p>
        )}
      </div>
    </main>
  );
}
