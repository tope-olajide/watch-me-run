import { useEffect, useRef, useState } from "react";
import type { CharacterId } from "./game/character-catalog";
import { characterCatalog } from "./game/character-catalog";
import type { Environment } from "./game/run-state";
import { roadsideModels } from "./game/roadside-models";
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
 * `pinning` — which is the only step that can take a while by itself, because both a landscape and a
 * change of world are a rebuild rather than a prompt the running session blends into — and finally the
 * start, and the first frames it produces. The elapsed count is there for the same reason: a slow step
 * should look slow rather than look broken, and a player who knows it has been nine seconds can decide
 * to wait.
 *
 * ## It can give up, and that is a feature
 *
 * The runner is playable over the local backdrop, and the whole design of the world layer assumes Orbis
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
 *
 * A rebuild is the exception. While one is in flight (`pinning`) the link is *meant* to restart — a
 * `reset` ends the old session and a new one is brought up — so an interruption there is the build's
 * own noise rather than a diagnosis, and cutting the wait short hands the run the world the player
 * just replaced, which is exactly the failure this screen exists to prevent. A rebuild that genuinely
 * fails is still bounded by the full budget, and the world layer is retrying underneath it.
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
function stageLine(state: WorldSnapshot, stage: number, label: string): string {
  if (state.error) return state.error;
  switch (stage) {
    case 0:
      return "Connecting to Orbis and reserving a session";
    case 1:
      return "Orbis is generating the world live — its first frames are on the way";
    case 2:
      return state.landscape
        ? `Placing ${state.landscape.label} on the horizon line and growing the world from it`
        : `Starting the world over so your run opens in ${label}`;
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
  const failed = Boolean(state.error) && !state.pinning;
  /** Set once the hand-off has been made, so a re-render cannot report it twice. */
  const reported = useRef(false);
  /** When generation first reported itself running, which is when the wait for frames is measured from. */
  const generationAt = useRef<number | null>(null);
  /** Set when the frames never arrived and the wait for them was given up on. */
  const [framesGaveUp, setFramesGaveUp] = useState(false);
  /** True once the runner's model is in the loader cache, or once trying has been given up on. */
  const [characterLoaded, setCharacterLoaded] = useState(false);
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

  /**
   * The scenery, fetched while the world is being armed.
   *
   * A world's props are a megabyte or two of models, and they are needed the moment the run starts.
   * This screen is twenty to forty seconds of waiting on Orbis anyway, so the fetch belongs here: it
   * overlaps the arming, and the roadside is drawn on the run's first frame instead of arriving a
   * second into it. The load is cached by pack, so a second run in the same world is already loaded.
   */
  useEffect(() => {
    void roadsideModels(environment);
  }, [environment]);

  /**
   * The runner, loaded while Orbis is being waited for — and waited for in turn.
   *
   * The runner is a lazy chunk whose model is a couple of megabytes, rendered in the run behind a
   * suspense boundary. Without this the run's first frame either waits on the fetch or shows the
   * boundary's fallback, and that fallback used to be a capsule: the delivery shape the collision is
   * built around, on screen for as long as the model took to arrive, in a game that has no capsule
   * in it. The boundary's fallback is empty now, which removes the stand-in but not the gap — so the
   * model is not merely started here, it is waited for, and `armed` below will not hand the run over
   * until the runner is in hand.
   *
   * The wait is bounded by the same budgets as everything else on this screen: a model that will not
   * load fails into `characterLoaded` rather than holding the run, because a run that always starts is
   * the promise this screen exists to keep.
   */
  useEffect(() => {
    let cancelled = false;
    setCharacterLoaded(false);
    void import("./game/RunnerCharacter")
      .then((module) => module.preloadCharacter(characterId))
      .then(
        () => { if (!cancelled) setCharacterLoaded(true); },
        // A failed fetch is not a reason to keep the player here: the run opens, and the world layer's
        // own recovery is what is allowed to retry things.
        () => { if (!cancelled) setCharacterLoaded(true); },
      );
    return () => {
      cancelled = true;
    };
  }, [characterId]);

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
  // still being rebuilt into it, and its first frames are on their way to the screen. The wait is
  // measured from the Start press rather than from this mount, so a second run inside the grace window
  // — same world, same landscape — is instant instead of paying the minimum twice.
  const armed =
    state.status === "ready" &&
    state.session.started &&
    !state.pinning &&
    (streaming || framesGaveUp) &&
    characterLoaded;

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
  // The third step is a rebuild, and which rebuild it is decides what to call it: a staged picture
  // makes it a pin, and anything else at that step is the world being started over for the world the
  // player chose. Read off the staged landscape rather than off an event, so the step a player is
  // looking at is named by the state they are looking at it in.
  const stages = state.landscape
    ? STAGES
    : [STAGES[0], STAGES[1], "Rebuilding your world", STAGES[3]];

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
        <p className="loader-line">{timedOut && !armed ? "Orbis is taking longer than usual — starting on the local backdrop. The world will join when it can." : stageLine(state, stage, selected.label)}</p>

        <ol className="loader-stages">
          {stages.map((label, index) => (
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
          <span>{`${state.session.resolution ?? "1080p"} · ${live ? "streaming" : "priming"}`}</span>
        </div>

        {character && (
          <p className="loader-runner">
            {/* The one part of the wait the player can check for themselves is the runner, so it is
                named honestly: warming until its model is actually in hand, and ready after that.
                "is ready" used to be a claim this screen had nothing to back. */}
            {characterLoaded
              ? `${character.label} is ready · ${selected.intro.line.toLowerCase()}`
              : `Warming up ${character.label} · ${selected.intro.line.toLowerCase()}`}
          </p>
        )}
      </div>
    </main>
  );
}
