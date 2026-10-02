import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactorConnectOptions } from "@reactor-team/js-sdk";
import {
  ViskoOrbisStableMainVideoView,
  ViskoOrbisStableProvider,
  useViskoOrbisStable,
  useViskoOrbisStableMessage,
  useViskoOrbisStableTrack,
  type ViskoOrbisStableMessage,
  type ViskoOrbisStableStateMessage,
} from "@reactor-models/visko-orbis-stable";
import { audioPrompt, openingPrompt, type WorldView } from "./prompts";
import { recordPrompt, settlePrompt, type PromptReason } from "./prompt-journal";
import { getReactorToken, resetReactorToken } from "./token";
import { attachWorldVideo } from "./world-frame";
import {
  publishChunk,
  registerWorldCommands,
  unregisterWorldCommands,
  updateWorld,
  useWorld,
  type OrbisVideoState,
  type WorldRequest,
  type WorldSessionState,
} from "./world-bus";

/**
 * The Orbis world layer, loaded lazily and mounted once for the whole app.
 *
 * It owns the only Reactor session, the only `<video>`, and the only prompt channel, so the
 * generated world is continuous: the menu shows a world being generated, a run continues inside
 * that same stream, and returning to the menu does not cut it. Everything here is invisible to
 * gameplay — the runner is fully playable over the local backdrop if Orbis never connects.
 *
 * Three rules keep this component stable, and all three were learned the hard way:
 *   1. The provider hands back new callback identities on every render, so every effect and every
 *      bus command reaches the SDK through a ref instead of depending on those functions.
 *   2. Orbis is steered once per session, not once per render — restarts are rejected with
 *      "Already generating." and turn a working world into console noise.
 *   3. The model's own `state` snapshot is the source of truth for what the session will accept. A
 *      command whose precondition is unmet is answered with a `command_error` broadcast rather than
 *      a throw, so pausing an already-paused session looks like a broken world while being nothing
 *      of the sort.
 */

/** Stable identity matters: the provider disposes its Reactor if any connect option changes. */
const CONNECT_OPTIONS: ReactorConnectOptions = { autoConnect: false, maxAttempts: 2 };

/** How long we wait for the session to reach `ready` before reporting a diagnosis. */
const READY_TIMEOUT_MS = 40_000;

/**
 * How long the two retry loops below keep asking before the world is left on the local backdrop.
 *
 * The server, not this file, decides how long a session that was never released can hold the
 * account's only slot: a lease lasts at most `MAX_SESSION_DURATION_SECONDS` (20 minutes — see
 * server/reactor-token.ts), and a session whose termination failed — a reload while the network was
 * down, say — holds its slot until that lease runs out. A retry budget shorter than the lease turns
 * one dropped connection into a dead world until the player reloads *again*, which is exactly what a
 * live session did: fifteen attempts at eight seconds is two minutes, and every 429 that kept
 * arriving after that was the leaked slot answering a question nobody was asking any more.
 *
 * So both loops poll at their own cadence for the two minutes an ordinary release takes, then slowly,
 * a minute at a time, for longer than any lease can last. The long tail costs one token request and
 * one refused session create a minute, and buys a world that comes back by itself when the slot
 * frees instead of one that never does.
 */
const SLOW_RETRY_DELAY_MS = 60_000;
/** 22 slow attempts, so the slow tail alone outlasts the 20-minute lease with room to spare. */
const SLOW_RETRY_ATTEMPTS = 22;

/**
 * The account allows one concurrent Orbis session per model, and a session that was closed by a
 * killed tab or a reload holds its slot for a while. A fast second visit therefore has to wait,
 * so this retries with the reason on screen rather than giving up — the game is playable in local
 * world mode the whole time.
 */
const BUSY_RETRY_DELAY_MS = 8_000;
/** The fast phase: the ordinary case is a slot still being released by the tab that just closed. */
const BUSY_FAST_ATTEMPTS = 15;
const BUSY_PATTERN = /429|quota_exceeded|concurrent_sessions|session limit/i;
const BUSY_MESSAGE = "Orbis is still releasing the previous world (one session at a time)";

/**
 * How long an arming pass waits before trying again after being turned away by one in flight.
 *
 * Short, because what it is waiting for is usually a session start that is already seconds old; the
 * retry is cheap (two refs compared) and wrong guesses are harmless, since a pass that finds the
 * world already armed returns without doing anything.
 */
const ARM_RETRY_MS = 1_500;

/**
 * How many times an arming pass may retry when it is the one thing keeping a live run out of local
 * world mode.
 *
 * The pass is normally driven by the status changing, and a run does not change it: a `start` that
 * fails on a link that is still up would leave nothing to re-run this effect at all, and the run
 * would finish over the local backdrop with the world reachable the whole time — the same bug the mid-run
 * re-arm exists to fix, one failure deeper. Four is chosen against the alternative, an unbounded loop
 * against a model that is failing on purpose.
 */
const REARM_ATTEMPTS = 4;

/**
 * How long a session may stay open with no run on screen.
 *
 * The menu is local, so an open session in the menu is one nobody is watching: it is billed whenever
 * it is ready, and it holds the account's single slot. This is a grace window rather than an eviction
 * — a player who finishes a run and starts another *in the same world* inside it finds the world still
 * warm and the loading screen over in well under a second, while one who wanders off is not paying for
 * a menu. Another world is a rebuild rather than a reuse, and pays its own few seconds (see the arming
 * effect): the grace is worth most where the session already holds what the run is about to ask for.
 *
 * Sixty seconds is a compromise the cost model does not settle by itself: the value of the window is a
 * restart that skips the loading screen, and a cold start measured on this stack has run from twenty
 * to forty seconds, so anything much shorter than the grace is cheaper than it. What bounds it from
 * above is that a menu left open is a menu the player is not watching.
 *
 * What changed when the menu went local is the *other* half of the idle path: it used to release the
 * session and immediately ask for a replacement, which would now be connecting a world for a surface
 * that deliberately has none (see the recycle effect below).
 */
const IDLE_SESSION_CAP_MS = 60_000;

/**
 * How long the chunk loop rests after each chunk of frames.
 *
 * While a session is started, Orbis produces continuously — a chunk of frames every 1.5-2 s,
 * forever — and every chunk is spend. `pause` is the only lever the model exposes for what a session
 * costs (there is no rate or clip-length command), so the loop is duty-cycled: one chunk, this long
 * a pause, then the next. It is visually free here because of what the generated world is now: a
 * distant landscape drifting slowly behind the game, which does not need frames at full rate to
 * stay alive. At 3 s of rest per chunk the world evolves at roughly two-fifths of its old rate and
 * a session costs roughly two-fifths of what it did.
 */
const CHUNK_REST_MS = 3_000;

/** How long a lost pause/resume command waits before it is tried again. */
const PAUSE_RETRY_MS = 2_000;

/**
 * How long a failed session release waits before it asks again, and how many times it asks.
 *
 * The retry is worth more than the wait is long: a release that failed leaves the session holding the
 * account's only slot for the rest of its lease (`MAX_SESSION_DURATION_SECONDS` — see
 * server/reactor-token.ts), and the usual reason a release fails is a network blip that is over
 * seconds later. Five attempts at 4 s, doubling, cover about two minutes; anything past that is the
 * connect loops' job, since they carry the same debt into every retry (see `releaseOwed`).
 */
const RELEASE_RETRY_MS = 4_000;
const RELEASE_MAX_ATTEMPTS = 5;

/**
 * Ceiling on how long a pause/resume command may take.
 *
 * `pause` resolves only once the model's handler has finished — after the current chunk — so a
 * second or two is normal. A promise that *never* settles is the failure that matters: without this
 * ceiling it wedges the reconciler's in-flight guard and every later pause (the duty cycle's and the
 * player's) silently does nothing while chunks keep being paid for. A timed-out command is treated
 * as a failed one and retried, which is safe: if the original eventually lands, the retry's pass
 * finds the state already right and does nothing.
 */
const PAUSE_COMMAND_TIMEOUT_MS = 10_000;

/** How long arming waits for the deployment's offered resolutions before starting without them. */
const RESOLUTION_WAIT_MS = 5_000;

/**
 * How long a rebuilt world is given to produce its first chunk before the run is handed over anyway.
 *
 * Matches the loading screen's own patience with a start that generates but does not paint
 * (`LOADING_FRAMES_MS` in `src/WorldLoader.tsx`): the frames are the point of waiting, and a world
 * that will not paint must not hold the run.
 */
const REBUILD_FRAMES_MS = 8_000;

/**
 * A lossless in-page trace of the pause reconciler, development only.
 *
 * The console is not evidence: the CDP console stream drops lines under load (an arming log and
 * every pause line can vanish while the prompt lines beside them survive), and the question this
 * trace answers — did the rest turn into a real pause, and did the command settle — is exactly the
 * question a dropped line would answer wrong. Entries are recorded in an array and read from a
 * probe via `window.__orbisTrace`, same reasoning as `window.__orbisWorld`. Bounded: it must not
 * grow with session length.
 */
type Trace = { at: number; what: string; detail?: string };
const TRACE_LIMIT = 400;
const traceLog: Trace[] = [];
function trace(what: string, detail?: unknown): void {
  traceLog.push({
    at: Date.now(),
    what,
    detail: typeof detail === "string" ? detail : JSON.stringify(detail ?? null),
  });
  if (traceLog.length > TRACE_LIMIT) traceLog.splice(0, traceLog.length - TRACE_LIMIT);
}
if (import.meta.env.DEV) {
  (window as unknown as { __orbisTrace?: Trace[] }).__orbisTrace = traceLog;
}

/**
 * A dropped transport is a recoverable event, not a diagnosis. When `set_prompt` fails because the
 * peer connection went away the SDK reports the raw command failure, and handing that to the player
 * as "broken world" is both ugly and wrong: the run keeps playing over the local backdrop and the link
 * comes back by itself. Transport symptoms get the reconnecting copy; real errors keep their text.
 */
const TRANSPORT_PATTERN = /disconnect|transport|websocket|peer connection|fetch failed|network/i;
const RECONNECTING_MESSAGE = "World link interrupted — reconnecting";
/**
 * The same symptom on a link that never came up. Nothing is retrying this one, so it must not claim
 * to be reconnecting — the run continues over the local backdrop and the retry button is the way back.
 */
const UNREACHABLE_MESSAGE = "Couldn't reach the Orbis world — the run plays over the local backdrop";

/**
 * Backoff for recovering a session that dropped on its own, while a world is still wanted.
 *
 * The fast phase is the doubling above; past it the recovery keeps asking slowly (see
 * SLOW_RETRY_ATTEMPTS), because what it is usually waiting for by then is not the connection but the
 * account's single session slot, held by the session that just dropped until its lease expires.
 */
const RECONNECT_BASE_MS = 2_500;
const RECONNECT_FAST_ATTEMPTS = 6;

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

/**
 * The delivery tier to ask for.
 *
 * `main_video` is upscaler-delivered, so the tier changes what a session costs to produce far more
 * than it changes what the player sees: the generated canvas is the same and the upscale happens on
 * the way out. 1080p is therefore the default on every device — the generated world is the game's
 * distant backdrop, hazed at the bottom and half covered by the WebGL layer, and 2k buys nothing a
 * player can see there while it keeps costing. 4k is offered by the deployment and not taken.
 */
function wantedResolution(available: string[]): string | undefined {
  if (!available.length) return undefined;
  return available.includes("1080p") ? "1080p" : available[0];
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "Unknown Orbis error";
}

/**
 * Whether a failure is the transport rather than the account.
 *
 * The SDK classifies its own failures — `ReactorError.code`, and a request that never got a reply is
 * `NETWORK_ERROR` — so the code answers this question where the failure is one the SDK raised. The
 * message patterns cover the ones the binding reports as plain text instead, e.g. `http transport
 * error: jwt resolver rejected: fetch failed`.
 */
function isTransportFailure(cause: unknown): boolean {
  return (
    (cause as { code?: unknown }).code === "NETWORK_ERROR" || TRANSPORT_PATTERN.test(errorText(cause))
  );
}

/**
 * The copy a failure deserves, for both ways a failure reaches this layer: a rejected `connect()` and
 * a `lastError` published by the provider.
 *
 * A transport symptom is never shown raw. The SDK reports them as its own diagnosis —
 * `http transport error: jwt resolver rejected: fetch failed` — which reads to a player as a broken
 * game rather than a link that is on its way back. Whether it is on its way back depends on where it
 * happened: a session that was once live is being retried by the recovery effect below, while a
 * session that never readied has nothing retrying it at all. Calling that second one a reconnect
 * would be a lie, and the honest difference is the only reason this takes a flag.
 *
 * Real errors keep their own text in both cases: they are the ones worth reading.
 */
function failureMessage(message: string, wasLive: boolean): string {
  if (!TRANSPORT_PATTERN.test(message)) return message;
  return wasLive ? RECONNECTING_MESSAGE : UNREACHABLE_MESSAGE;
}

function commandReason(message: ViskoOrbisStableMessage): string {
  const reason = (message as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : "";
}

/** The model's session snapshot, in the shape the bus publishes. */
function readSession(state: ViskoOrbisStableStateMessage): WorldSessionState {
  return {
    started: state.started,
    running: state.running,
    paused: state.paused,
    chunk: state.current_chunk,
    hasImage: state.has_image,
    resolution: state.resolution,
    availableResolutions: state.available_resolutions ?? [],
    audioEnabled: state.audio_enabled,
    // Only the first clause: the caption is long and the interesting part is whether it is the one
    // this world asked for, not the whole sentence in a status line.
    audioPrompt: state.audio_prompt ? state.audio_prompt.slice(0, 48) : null,
  };
}

function sameSession(a: WorldSessionState, b: WorldSessionState): boolean {
  return (
    a.started === b.started &&
    a.running === b.running &&
    a.paused === b.paused &&
    a.chunk === b.chunk &&
    a.hasImage === b.hasImage &&
    a.resolution === b.resolution &&
    a.availableResolutions.length === b.availableResolutions.length &&
    a.audioEnabled === b.audioEnabled &&
    a.audioPrompt === b.audioPrompt
  );
}

function WorldSession() {
  const reactor = useViskoOrbisStable();
  const { status, sessionId, lastError } = reactor;
  const sdk = useRef(reactor);
  sdk.current = reactor;

  const { runActive, pauseRequested, pinning, world: selectedWorld } = useWorld();
  const [request, setRequest] = useState<WorldRequest>();
  const [error, setError] = useState<string>();
  const [needsSound, setNeedsSound] = useState(false);
  const [hidden, setHidden] = useState(false);
  /** True while the chunk loop is resting between chunks — the duty cycle that slows generation. */
  const [resting, setResting] = useState(false);
  /** Bumped to retry a pause/resume that a transient error swallowed. */
  const [pauseRetry, setPauseRetry] = useState(0);
  const [session, setSession] = useState<WorldSessionState>(NO_SESSION);
  // Local mirror of the published video state: the layer styles itself from it, so a connecting
  // session never paints as a black rectangle over the local world.
  const [videoState, setVideoState] = useState<OrbisVideoState>("off");

  const surface = useRef<HTMLDivElement>(null);
  const statusRef = useRef(status);
  const requestRef = useRef<WorldRequest | undefined>(undefined);
  /** The model's session snapshot, for the async work that cannot wait for a render. */
  const sessionRef = useRef<WorldSessionState>(NO_SESSION);
  /**
   * What this session has already been armed with.
   *
   * Cleared whenever the link leaves `ready`, because everything it records is session state on the
   * model's side: a reconnect hands back a session with no prompt, no image and no running
   * generation, and believing otherwise is how a run would end up inside a world that was never
   * armed. That clearing is also what makes the re-arm after a blip unconditional, without having to
   * know whether the server kept the same session id.
   */
  const applied = useRef<{ armed?: boolean; environment?: string; landscape?: string | null }>({});
  /** Uploaded files are session-scoped, so their refs are cached for as long as this link lives. */
  const uploads = useRef(new Map<string, Awaited<ReturnType<typeof reactor.uploadFile>>>());
  const generation = useRef<"idle" | "starting">("idle");
  /** Bumped to re-run the arming effect when an arm had to be turned away mid-flight. */
  const [armRetry, setArmRetry] = useState(0);
  const busyAttempts = useRef(0);
  const connecting = useRef(false);
  /** Once a session has been ready, a later blip is a renegotiation, not a failure to start. */
  const everReady = useRef(false);
  /** Set when the deployment answers `set_audio_enabled` with a refusal, so it is asked only once. */
  const audioRejected = useRef(false);
  /** Whether `set_audio_enabled` has been answered for the session currently open. */
  const audioArmed = useRef<string | undefined>(undefined);
  const retryTimer = useRef(0);
  const waitTimer = useRef(0);
  const reconnectTimer = useRef(0);
  const restTimer = useRef(0);
  const pauseRetryTimer = useRef(0);
  const reconnectAttempts = useRef(0);
  /** Mid-run re-arms tried on the connection currently open, and their timer — see REARM_ATTEMPTS. */
  const rearmAttempts = useRef(0);
  const rearmTimer = useRef(0);
  /** Chunks completed on the session currently open, counted here for the rebuild's frames wait. */
  const chunkSeq = useRef(0);
  /** A release the account is still owed, and the retries working on it — see `releaseSession`. */
  const releaseOwed = useRef(false);
  const releaseAttempts = useRef(0);
  const releaseTimer = useRef(0);
  const videoTrack = useViskoOrbisStableTrack("main_video");

  statusRef.current = status;
  requestRef.current = request;

  const publishSession = useCallback((next: WorldSessionState) => {
    // Compared before publishing rather than inside `updateWorld`: a `state` arrives after every
    // chunk as well as after every command, and a bus notification per chunk would re-render the
    // menu and the run's HUD for a snapshot that had not actually moved.
    const changed = !sameSession(sessionRef.current, next);
    sessionRef.current = next;
    if (!changed) return;
    setSession(next);
    updateWorld({ session: next });
  }, []);

  const onMessage = useCallback(
    (message: ViskoOrbisStableMessage) => {
      switch (message.type) {
        case "state":
          publishSession(readSession(message));
          return;
        case "chunk_complete": {
          // Counted before it is published: the arming pass waits for this to move when it has
          // rebuilt the world and wants to hand the run over behind real frames of it.
          chunkSeq.current += 1;
          // The world's real cadence, handed to anyone who wants to spend an ask where it lands.
          publishChunk({ index: message.chunk_index, at: Date.now() });
          trace("chunk", `index=${message.chunk_index}`);
          // The duty cycle: the chunk that just landed earns the chunk loop a rest. The pause
          // reconciler below turns the rest into a `pause`, which is the only thing that stops
          // Orbis producing — and spending — while the world idles on screen.
          window.clearTimeout(restTimer.current);
          setResting(true);
          restTimer.current = window.setTimeout(() => {
            trace("rest-off");
            setResting(false);
          }, CHUNK_REST_MS);
          return;
        }
        case "image_accepted":
          console.info(`[orbis] landscape pinned at ${message.width}x${message.height}`);
          return;
        case "command_error": {
          // A rejected `start` while we are starting is the expected answer, not a failure.
          if (/already generating/i.test(commandReason(message))) return;
          if (/audio/i.test(commandReason(message))) {
            // A deployment with no audio track refuses this for good; asking again every session
            // would only fill the console with the same answer.
            audioRejected.current = true;
          }
          console.warn(`[orbis] command_error ${JSON.stringify(message)}`);
          return;
        }
        default:
          return;
      }
    },
    [publishSession],
  );
  useViskoOrbisStableMessage(onMessage);

  const publishVideoState = useCallback((next: OrbisVideoState) => {
    setVideoState(next);
    updateWorld({ videoState: next });
  }, []);

  /**
   * End the session, and keep asking when the asking fails.
   *
   * A release that fails is the expensive kind of failure: the session goes on holding the account's
   * only slot until its lease runs out, and the tab that owns it is usually gone by then. It is also
   * the call most likely to fail *into* a network blip, because ending a session wants a fresh JWT —
   * `jwt resolver rejected: fetch failed` is what a release into a dead network looks like — so the
   * one failure that costs the most is the one a transient cause produces.
   *
   * Asking again later is a real retry rather than a hopeful one: the binding ends the session
   * server-side on every `disconnect()`, and a failed one leaves the wasm client that knows which
   * session to end alive (`Reactor.disconnect()` only frees that client once the release has
   * succeeded), so the next attempt finishes the job the first one started. A link that reaches
   * `ready` cancels the debt instead: it has a session of its own, so whatever the earlier release
   * could not end is gone or not ours to end.
   */
  const releaseSession = useCallback(async (reason: string): Promise<boolean> => {
    const attempt = releaseAttempts.current + 1;
    try {
      await sdk.current.disconnect();
      releaseAttempts.current = 0;
      releaseOwed.current = false;
      trace("release", `${reason} ok (attempt ${attempt})`);
      return true;
    } catch (cause) {
      releaseOwed.current = true;
      trace("release", `${reason} failed (attempt ${attempt}): ${errorText(cause)}`);
      console.warn(`[orbis] could not release the session (${reason})`, cause);
      if (releaseAttempts.current < RELEASE_MAX_ATTEMPTS) {
        const wait = RELEASE_RETRY_MS * 2 ** releaseAttempts.current;
        releaseAttempts.current += 1;
        window.clearTimeout(releaseTimer.current);
        releaseTimer.current = window.setTimeout(() => {
          // A ready session, or a connect already in flight, has taken the debt over: one of them
          // releases before it connects (see `startWorld`), and ending a session underneath a
          // connect that is about to succeed would be worse than leaving the release to them.
          if (statusRef.current !== "disconnected" || connecting.current) return;
          void releaseSession(reason);
        }, wait);
      }
      return false;
    }
  }, []);

  const startWorld = useCallback(async (next: WorldRequest) => {
    setRequest(next);
    updateWorld({ world: next.environment });

    // A request the session is not already holding means the next arming pass is a rebuild: `reset`,
    // the image if there is one, then `start`. Raised here, at the request, because that is where the
    // wait begins — the run's loading screen reads this to say what it is waiting for, and to hold the
    // run until the world it is asked to dive into exists. The arming pass clears it when the rebuild
    // is done, or has honestly failed.
    //
    // Two things rebuild: a picture the session is not holding (either direction — pinning one, or
    // handing the world back to a created landscape after a picture), and a change of *world*, which
    // is a fresh generation rather than a prompt the running session blends into. A cold session
    // without a picture rebuilds nothing: it is being built for the first time, and the loader's own
    // stages cover that wait.
    const stagedLandscape = next.landscape?.id ?? null;
    const heldLandscape = applied.current.landscape ?? null;
    const landscapeRebuild =
      stagedLandscape !== heldLandscape && (stagedLandscape !== null || applied.current.armed === true);
    const worldRebuild =
      applied.current.armed === true && applied.current.environment !== next.environment;
    if (landscapeRebuild || worldRebuild) updateWorld({ pinning: true });

    // A session that exists is steered, never reconnected: `connect()` throws "Already connected or
    // connecting" for any status but `disconnected`, which used to surface as a broken world just
    // for asking for a world while the transport was still negotiating.
    if (statusRef.current !== "disconnected" || connecting.current) return;

    connecting.current = true;
    resetReactorToken();

    // A release the network interrupted is still owed, and paying it *before* asking for a new
    // session is the difference between a world that comes back and a `429 quota_exceeded` that keeps
    // coming back: the session that could not be ended is holding the account's only slot, so the new
    // session cannot be created. Serialized here, inside the same guard as the connect, so a session
    // is never ended underneath a connect that has just succeeded.
    if (releaseOwed.current) await releaseSession("before reconnecting");

    try {
      await sdk.current.connect();
    } catch (cause) {
      console.error("[orbis] connect failed", cause);
      const text = errorText(cause);

      if (/already connected/i.test(text)) return;

      // `connect` tears the previous session down before it creates one, and that teardown wants the
      // same JWT a transport failure just proved unreachable — so a connect that died on the way to
      // the network is also a release that may have died with it. Record the debt for the next
      // attempt to pay; a session that was never live has nothing to release.
      if (everReady.current && isTransportFailure(cause)) releaseOwed.current = true;

      if (
        BUSY_PATTERN.test(text) &&
        busyAttempts.current < BUSY_FAST_ATTEMPTS + SLOW_RETRY_ATTEMPTS
      ) {
        busyAttempts.current += 1;
        // The count is honest for the fast phase and meaningless once the waits are a minute long,
        // so the player is told which one they are in instead of a number that stops rising usefully.
        const slow = busyAttempts.current > BUSY_FAST_ATTEMPTS;
        setError(
          slow
            ? `${BUSY_MESSAGE} (still waiting, one try a minute)`
            : `${BUSY_MESSAGE} (${busyAttempts.current}/${BUSY_FAST_ATTEMPTS})`,
        );
        retryTimer.current = window.setTimeout(
          () => void startWorld(next),
          slow ? SLOW_RETRY_DELAY_MS : BUSY_RETRY_DELAY_MS,
        );
        return;
      }

      // Busy is a wait, not a failure, so it keeps its own copy; everything else is classified.
      setError(BUSY_PATTERN.test(text) ? BUSY_MESSAGE : failureMessage(text, everReady.current));
    } finally {
      connecting.current = false;
    }
  }, []);

  /**
   * One prompt, on one channel, journaled.
   *
   * The two channels fail independently: an audio caption this deployment will not take must not
   * stop the picture from being steered, and neither is a broken world link — the previous shot
   * keeps playing either way, so a rejection is a console warning and never a status change.
   */
  const sendChannel = useCallback(
    async (
      prompt: string,
      track: "video" | "audio",
      entry?: ReturnType<typeof recordPrompt>,
    ): Promise<void> => {
      if (statusRef.current !== "ready") {
        if (entry) entry.dropped = `world link ${statusRef.current}`;
        return;
      }
      try {
        if (track === "audio") await sdk.current.setAudioPrompt({ prompt });
        else await sdk.current.setPrompt({ prompt });
        settlePrompt(entry, { ok: true });
        // Logged with its opening clause so a headless run can prove which world asked for what.
        console.info(`[orbis] ${track} prompt (${prompt.length} chars): ${prompt.slice(0, 240)}...`);
      } catch (cause) {
        settlePrompt(entry, { error: errorText(cause) });
        console.warn(`[orbis] ${track} prompt update failed`, cause);
      }
    },
    [],
  );

  /** The layer's own prompts — the ones it sends rather than the ones the bus asks for. */
  const sendOwn = useCallback(
    async (prompt: string, track: "video" | "audio", reason: PromptReason, environment?: WorldRequest["environment"]) => {
      const entry = recordPrompt({
        channel: "app",
        reason,
        environment,
        status: statusRef.current,
        prompt,
        track,
      });
      await sendChannel(prompt, track, entry);
    },
    [sendChannel],
  );

  // The bus exists before this chunk does, so requests can arrive first and are handed over here.
  // Registration happens exactly once: a re-registering layer would make every surface that talks
  // to the bus re-render, which is a loop waiting to happen.
  const handlers = useRef({ startWorld, sendChannel });
  handlers.current = { startWorld, sendChannel };

  useEffect(() => {
    const queued = registerWorldCommands({
      showWorld: (next) => void handlers.current.startWorld(next),
      sendPrompt: (prompt, entry) => void handlers.current.sendChannel(prompt, "video", entry),
      sendAudio: (prompt, entry) => void handlers.current.sendChannel(prompt, "audio", entry),
      retry: () => {
        // Retry retries something that was asked for. In the menu nothing has been, and starting a
        // session from the chip would be spending one the player never asked for.
        const next = requestRef.current;
        if (next) void handlers.current.startWorld(next);
      },
    });
    if (queued) void handlers.current.startWorld(queued);
    return () => {
      unregisterWorldCommands();
      window.clearTimeout(retryTimer.current);
      window.clearTimeout(waitTimer.current);
      window.clearTimeout(reconnectTimer.current);
      window.clearTimeout(restTimer.current);
      window.clearTimeout(pauseRetryTimer.current);
      window.clearTimeout(releaseTimer.current);
    };
  }, []);

  // Drop the link on purpose, in development.
  //
  // A dropped link is the one failure this layer has that cannot be produced on demand: the network
  // can be taken away from the token route and from every other request, but not from an established
  // WebRTC media path — `Network.emulateNetworkConditions({offline:true})` was measured under a live
  // run and the status stayed `ready`/`streaming` for the whole twenty seconds while the world kept
  // producing frames. So the transition is handed over directly: the SDK told to drop while a run is
  // on screen, which is what the status goes through when the transport really dies. It is the only
  // way to exercise the recovery below without waiting for a real one (see tools/drop-probe.mjs).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const host = window as unknown as { __orbisDrop?: () => void };
    host.__orbisDrop = () => {
      trace("force-drop", "probe released the link under a live run");
      void sdk.current.disconnect().catch(() => undefined);
    };
    return () => {
      delete host.__orbisDrop;
    };
  }, []);

  useEffect(() => {
    updateWorld({ status, sessionId });
    if (status === "ready") {
      everReady.current = true;
      // A recovered link earns a fresh budget of recovery attempts.
      reconnectAttempts.current = 0;
      // And a fresh budget of mid-run re-arms, for the same reason: the count belongs to this
      // connection rather than to the session, so a link that comes back gets the tries a new one does.
      rearmAttempts.current = 0;
      // And settles any release still owed: a ready link has a session of its own, so the session an
      // earlier release could not end is either gone or now ours.
      releaseOwed.current = false;
      releaseAttempts.current = 0;
      window.clearTimeout(releaseTimer.current);
      setError(undefined);
      return;
    }

    publishVideoState("off");
    // A closed session invalidates the prompt, generation and landscape bookkeeping for the next one.
    // Whatever went wrong before, the world is not reachable right now — but a session that has
    // already been live is reconnecting, not failing to start, so the diagnosis below does not apply.
    applied.current = {};
    uploads.current.clear();
    audioArmed.current = undefined;
    generation.current = "idle";
    publishSession(NO_SESSION);
  }, [publishSession, publishVideoState, sessionId, status]);

  useEffect(() => {
    if (error) {
      updateWorld({ error });
      return;
    }
    // A ready session is not broken, whatever the last command error said, and a blip is the status
    // label's story rather than an SDK string aimed at the player.
    if (status === "ready" || !lastError) {
      updateWorld({ error: undefined });
      return;
    }
    updateWorld({ error: failureMessage(lastError.message, everReady.current) });
  }, [error, lastError, status]);

  // A session that dropped on its own is recovered rather than left for the player: the world is
  // still wanted, and a run in progress must not finish over the local backdrop because of a blip. The
  // backoff is bounded — doubling for the fast phase, then a minute at a time past it, so the loop
  // outlives a session lease it may be waiting on — and a link that comes back resets the budget.
  //
  // Gated on a run being on screen as well as on the request, because the request outlives the run:
  // after a run ends the menu is still holding the last request for its grace window, and without
  // this a blip in the menu would have the recovery connect a world for a surface that is deliberately
  // local. The request is what to reconnect *to*; a run is why to reconnect at all.
  //
  // A rebuild is the second reason to reconnect: the loading screen is holding a run for one
  // (`pinning` — see `startWorld`), and a rebuild's own `reset` ends the session it was working on, so
  // a transport that fails to come back on its own leaves the run waiting for a world nothing is
  // rebuilding. During a run this effect is the only retry; during a rebuild it is the only retry too,
  // because the arming effect cannot run until the link is back.
  useEffect(() => {
    if (status !== "disconnected" || !request || (!runActive && !pinning) || !everReady.current) return;
    if (reconnectAttempts.current >= RECONNECT_FAST_ATTEMPTS + SLOW_RETRY_ATTEMPTS) return;

    const wait =
      reconnectAttempts.current < RECONNECT_FAST_ATTEMPTS
        ? RECONNECT_BASE_MS * 2 ** reconnectAttempts.current
        : SLOW_RETRY_DELAY_MS;
    reconnectTimer.current = window.setTimeout(() => {
      reconnectAttempts.current += 1;
      console.info(`[orbis] recovering a dropped session (attempt ${reconnectAttempts.current})`);
      if (requestRef.current) void handlers.current.startWorld(requestRef.current);
    }, wait);
    return () => window.clearTimeout(reconnectTimer.current);
  }, [pinning, request, runActive, status]);

  /**
   * Arm and start the session for the requested world and landscape.
   *
   * Both a landscape the player supplied and a *world* they chose instead of the last one are
   * conditions of the session rather than prompts: an image can only be pinned before `start` and
   * only `reset` clears one, and a session steered into a different world by prompt alone blends over
   * several chunks — measured on a warm session, the frame was still the old world's for the first ten
   * seconds of the new run and only read as the new world at fifteen, by which point the run it was
   * meant to open was already a third over. The player picked a place; the one way to open the run
   * inside it is to rebuild the world, so a change of either one is `reset` and a fresh arm.
   *
   * A run in the same world the session already holds is left exactly as it was: the warm session is
   * reused, nothing is reset, and the next run starts in well under a second (see the grace window in
   * the idle release below).
   *
   * The teardown is sequenced against the model's own snapshot rather than against a flag of our own,
   * because the two can disagree for a moment after every command — and a `start` issued in that
   * window is answered by "Already generating.", which is exactly the console noise that made the
   * early version of this layer look broken.
   */
  useEffect(() => {
    if (status !== "ready" || !request) return;
    // A run on screen is not a reason to steer the world: re-arming is `reset` plus `start`, and a
    // world rebuilt under the player's feet is worse than the one they are already running through.
    // The one exception is a link that came back *during* that run. The request still stands, the run
    // is why it stands, and the arming went with the session that dropped — `applied` is cleared the
    // moment the link leaves `ready`, so an empty `applied` under a live run is exactly "this link has
    // never armed the world being run". Without the exception a recovered link comes back connected
    // and silent: the video re-attaches, generation never restarts, and the run finishes in local
    // world mode while the world was reachable the whole time.
    const recoveredMidRun = runActive && everReady.current && applied.current.armed !== true;
    if (runActive && !recoveredMidRun) return;

    const landscapeKey = request.landscape?.id ?? null;
    const appliedState = applied.current;
    // `armed` rather than a session id: everything this records is state on the model's side, and
    // `applied` is cleared the moment the link leaves `ready`, so "has this link been armed" is the
    // whole question. Session ids are also not reliably present at the instant the status flips.
    const armed = appliedState.armed === true;
    const sameWorld =
      armed &&
      appliedState.environment === request.environment &&
      appliedState.landscape === landscapeKey;
    const running = session.started || generation.current === "starting";
    if (sameWorld && running) return;
    if (generation.current === "starting") {
      // An arm is already in flight — a session still coming up, usually, and a session can take
      // tens of seconds to reach its first frame. The request is not lost (a `state` message re-runs
      // this effect), but leaving it to that is how a landscape pin ended up waiting 36 s for a start
      // it could not see, and how an arm that *failed* would strand the pin entirely: `pinning` would
      // be cleared with the old landscape still in the session. So the retry is explicit.
      const timer = window.setTimeout(() => setArmRetry((value) => value + 1), ARM_RETRY_MS);
      return () => window.clearTimeout(timer);
    }

    const view: WorldView = {
      environment: request.environment,
      custom: request.landscape !== null,
    };

    // Timed because rebuilding is the one thing in this layer a player has to wait for: a change of
    // world or of landscape is a `reset` and a fresh arm rather than a prompt, and the loader holds
    // the run until it is done. Knowing which step costs the seconds is the difference between a fix
    // and a guess.
    const armStartedAt = Date.now();

    void (async () => {
      generation.current = "starting";
      trace(
        "arm",
        `run=${runActive} recovered=${recoveredMidRun} armed=${armed} started=${sessionRef.current.started} world=${request.environment} landscape=${landscapeKey ?? "generated"}`,
      );
      let rebuildTook = 0;
      /** Which condition the rebuild is for, so the console line names the wait the player paid. */
      let rebuiltFor: "world" | "landscape" | null = null;
      try {
        // 1. A different place needs the previous conditions cleared. `reset` is the only thing that
        //    clears a starting image and the only thing that starts generation over, and it must
        //    happen before anything is re-armed.
        const worldChanged = appliedState.environment !== request.environment;
        const landscapeChanged = appliedState.landscape !== landscapeKey;
        const rebuilding = armed && (worldChanged || landscapeChanged);
        if (rebuilding) {
          rebuiltFor = worldChanged ? "world" : "landscape";
          // The world is being rebuilt for a run that is waiting on it, so the rest between chunks is
          // not a saving here: the frames are wanted, and the rebuild's own wait is the shortest one
          // that can produce them.
          window.clearTimeout(restTimer.current);
          setResting(false);
          const resetAt = Date.now();
          await sdk.current.reset();
          applied.current = {};
          trace("rebuild", `for=${rebuiltFor} took=${Date.now() - resetAt}ms`);
          // The mirror is updated here rather than waited for: `reset` has already been answered by
          // the time this resolves, and the arming below has to know the session is empty *now* or
          // it would skip the image and the start. The resolution and the available tiers survive a
          // reset, so those are carried over rather than cleared with the rest.
          publishSession({
            ...sessionRef.current,
            started: false,
            running: false,
            paused: false,
            chunk: 0,
            hasImage: false,
          });
          rebuildTook += Date.now() - resetAt;
        }

        // Read once, after any reset: this is what decides whether the session needs arming at all.
        const arming = !sessionRef.current.started;

        if (arming) {
          // 2. Session-scoped choices, read when `start` fires. They survive `reset`, so they are
          //    sent with the arming rather than on every world change. `setAudioEnabled` goes
          //    first on purpose: its round-trip is also what makes the first `state` arrive (the
          //    one emitted on connect is gone before this layer's listener exists), and that
          //    snapshot carries `available_resolutions` — which the delivery tier below needs.
          if (!audioRejected.current && audioArmed.current !== sessionId) {
            try {
              await sdk.current.setAudioEnabled({ audio_enabled: true });
              audioArmed.current = sessionId;
            } catch {
              audioRejected.current = true;
            }
          }

          // 3. The starting image, and the seed that makes this landscape open the same way twice.
          if (request.landscape) {
            const imageAt = Date.now();
            const cached = uploads.current.get(request.landscape.id);
            const image =
              cached ??
              (await sdk.current.uploadFile(request.landscape.blob, {
                name: `landscape-${request.landscape.id.replace(/[^a-z0-9]+/gi, "-")}.jpg`,
              }));
            uploads.current.set(request.landscape.id, image);
            await sdk.current.setImage({ image });
            await sdk.current.setSeed({ seed: request.landscape.seed });
            rebuildTook += Date.now() - imageAt;
          }

        }

        // 4. The conditions themselves: what it sounds like, and what it is. Sent on both paths — a
        //    freshly armed session is being told them for the first time, and a rebuild sends them
        //    again so the world it is about to start is the world the player chose.
        await sendOwn(audioPrompt(view), "audio", "world-audio", request.environment);
        await sendOwn(openingPrompt(view), "video", "world-morph", request.environment);

        if (arming) {
          // 5. The delivery tier, read after those round-trips and right before `start`, because it
          //    is read *from the offered list in the session's `state`* — and that list is only
          //    known once a command has been answered. Starting without it silently uses the
          //    deployment's default: the command is never sent and nothing says so except the
          //    `resolution` field itself. The bounded wait below is the backstop for a transport
          //    that is slower than the commands above.
          const offerDeadline = Date.now() + RESOLUTION_WAIT_MS;
          while (!sessionRef.current.availableResolutions.length && Date.now() < offerDeadline) {
            await new Promise((resolve) => window.setTimeout(resolve, 100));
          }
          const resolution = wantedResolution(sessionRef.current.availableResolutions);
          trace(
            "resolution",
            `want=${resolution} have=${sessionRef.current.resolution} offered=${JSON.stringify(sessionRef.current.availableResolutions)}`,
          );
          if (resolution && resolution !== sessionRef.current.resolution) {
            await sdk.current.setResolution({ resolution });
            console.info(`[orbis] delivery resolution -> ${resolution}`);
          }
          await sdk.current.start();
          trace("started", `run=${runActive} recovered=${recoveredMidRun}`);
          console.info("[orbis] generation started");

          // 6. A rebuilt world is not armed until it has produced a frame of the world it was rebuilt
          //    into. `reset` blanks the video and a fresh session's first chunk is seconds away, so a
          //    run handed over the moment `start` is answered opens on a black picture — measured on a
          //    warm session switch, the first desert frame arrived about five seconds after the handoff.
          //    The loading screen holds the run while `pinning` is up (and says it is waiting for the
          //    first frames), so waiting here is what puts a world behind the run's opening. Bounded,
          //    because a run must always start.
          if (rebuilding) {
            const chunksBefore = chunkSeq.current;
            const framesDeadline = Date.now() + REBUILD_FRAMES_MS;
            while (chunkSeq.current === chunksBefore && Date.now() < framesDeadline) {
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            trace(
              "rebuild-frames",
              `chunks=${chunkSeq.current - chunksBefore} waited=${Math.min(REBUILD_FRAMES_MS, Date.now() - framesDeadline + REBUILD_FRAMES_MS)}ms`,
            );
          }
        }

        applied.current = {
          armed: true,
          environment: request.environment,
          landscape: landscapeKey,
        };
        busyAttempts.current = 0;
        // The arm landed, so the budget of tries this pass owns is done with.
        rearmAttempts.current = 0;
      } catch (cause) {
        console.warn("[orbis] could not steer the world", cause);
        trace("arm-failed", `${errorText(cause)} run=${runActive} recovered=${recoveredMidRun}`);
        // A run on screen leaves nothing else to re-run this effect — it is keyed on the status and
        // the session's snapshot, and a failed `start` on a link that is still up changes neither — so
        // a recovery that fails here is retried from here or not at all.
        if (recoveredMidRun && rearmAttempts.current < REARM_ATTEMPTS) {
          rearmAttempts.current += 1;
          window.clearTimeout(rearmTimer.current);
          rearmTimer.current = window.setTimeout(() => setArmRetry((value) => value + 1), ARM_RETRY_MS);
        }
      } finally {
        if (rebuildTook) {
          console.info(
            `[orbis] rebuilt the world for the ${rebuiltFor} in ${rebuildTook}ms, armed in ${Date.now() - armStartedAt}ms`,
          );
        }
        generation.current = "idle";
        // The world is armed for the selected world and landscape, so a run may start. Cleared here
        // rather than after the await so a failed pin does not hold the menu forever — the world
        // would be the generated one, which is the honest outcome of an image that would not pin.
        updateWorld({ pinning: false });
      }
    })();
    return () => window.clearTimeout(rearmTimer.current);
  }, [armRetry, request, runActive, sendOwn, session.started, sessionId, status]);

  /**
   * Pause generation when it is not earning anything.
   *
   * Stopping the chunk loop is both what a paused world should look like and the one lever that
   * changes what a session costs while it is open: a paused session produces nothing. Three things
   * ask for it — the player's pause, a hidden tab where nobody is watching the world at all, and the
   * chunk rest that duty-cycles generation down to a fraction of its old rate — and the wanted state
   * is reconciled against what Orbis reports, because `pause` on an already-paused session is a
   * `command_error`, not an idempotent no-op.
   */
  const pauseBusy = useRef(false);
  const wantPaused = hidden || resting || (pauseRequested && runActive);
  /** The intent, traced where it changes. A pause that never reaches the model is invisible
   * otherwise: the game pauses, the world keeps generating, and nothing looks wrong. */
  const lastWantPaused = useRef(false);
  if (lastWantPaused.current !== wantPaused) {
    lastWantPaused.current = wantPaused;
    trace("want", `to=${wantPaused} run=${runActive} player=${pauseRequested} hidden=${hidden} rest=${resting} started=${session.started} paused=${session.paused} status=${status}`);
    console.info(
      `[orbis] pause wanted -> ${wantPaused} (run=${runActive} player=${pauseRequested} hidden=${hidden} rest=${resting})`,
    );
  }

  useEffect(() => {
    if (status !== "ready" || pauseBusy.current) return;
    const shouldBePaused = wantPaused && session.started && !session.paused;
    const shouldBeRunning = !wantPaused && session.paused;
    if (!shouldBePaused && !shouldBeRunning) return;

    pauseBusy.current = true;
    trace("attempt", shouldBePaused ? "pause" : "resume");
    void (async () => {
      console.info(`[orbis] ${shouldBePaused ? "pausing" : "resuming"} generation`);
      try {
        const command = shouldBePaused ? sdk.current.pause() : sdk.current.resume();
        let timedOut = false;
        const reply = await Promise.race([
          command,
          new Promise<undefined>((resolve) =>
            window.setTimeout(() => {
              timedOut = true;
              resolve(undefined);
            }, PAUSE_COMMAND_TIMEOUT_MS),
          ),
        ]);
        if (timedOut) throw new Error("pause/resume command timed out");
        trace("reply", `${shouldBePaused ? "pause" : "resume"}=${JSON.stringify(reply ?? null)}`);
        console.info(`[orbis] ${shouldBePaused ? "pause" : "resume"} answered`, reply ?? "no reply");
      } catch (cause) {
        trace("throw", errorText(cause));
        console.warn("[orbis] could not change the generation state", cause);
        // A command lost to a transient error would otherwise strand the wanted state: a resume
        // that never landed keeps the world paused for good, and the duty-cycled rest would silently
        // stop saving anything. The retry is a bump, like the arming retry above.
        window.clearTimeout(pauseRetryTimer.current);
        pauseRetryTimer.current = window.setTimeout(
          () => setPauseRetry((value) => value + 1),
          PAUSE_RETRY_MS,
        );
      } finally {
        pauseBusy.current = false;
      }
    })();
  }, [pauseRetry, session.paused, session.started, status, wantPaused]);

  // A run must never open on a world resting between chunks: the launch prompt would then be
  // answered only at the next resume. The rest is for the world idling on screen, not for a run.
  useEffect(() => {
    if (!runActive) return;
    trace("rest-clear", "run started");
    window.clearTimeout(restTimer.current);
    setResting(false);
  }, [runActive]);

  // The delivery tier, reconciled whenever the offered list becomes known. `setResolution` is read
  // at `start`, so a tier armed late costs the current run nothing and fixes the next one — and a
  // session whose list arrived after arming would otherwise stay on the deployment's default
  // forever, because every later arm finds generation already started and never asks again.
  useEffect(() => {
    if (status !== "ready" || generation.current !== "idle") return;
    const want = wantedResolution(session.availableResolutions);
    if (!want || want === session.resolution) return;
    trace("resolution-converge", `want=${want} have=${session.resolution}`);
    void sdk.current
      .setResolution({ resolution: want })
      .then(() => console.info(`[orbis] delivery resolution -> ${want} (next start)`))
      .catch((cause) => console.warn("[orbis] could not set the delivery tier", cause));
  }, [session.availableResolutions, session.resolution, status]);

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Watch the real video element: this is the only honest source for "frames are on screen", and
  // it also recovers when the browser blocks autoplay with sound.
  useEffect(() => {
    if (status !== "ready") return;

    let timer = 0;
    let attachedElement: HTMLVideoElement | null = null;
    const inspect = () => {
      const video = surface.current?.querySelector("video");
      if (video) {
        if (video !== attachedElement) {
          attachedElement = video;
          // The same watcher feeds the roadside's panels: one answer to "where is the world being
          // played", rather than a second watcher that can disagree about it (see world-frame.ts).
          attachWorldVideo(video);
          console.info(`[orbis] video element attached (${video.readyState}, muted=${video.muted})`);
        }
        const streaming = video.readyState >= 2 && video.videoWidth > 0;
        publishVideoState(streaming ? "streaming" : "waiting");
        // Sound is applied here rather than through a prop: flipping the view's props makes the
        // SDK rebuild its media element, which blanks the world for the rest of the run.
        //
        // The generated audio is the world's own soundtrack, so it is wanted everywhere — during a
        // run most of all. If the browser refuses to unmute a stream it let autoplay, the element is
        // put back to muted and the button below is offered instead; a blocked unmute must never
        // cost the player the picture.
        if (video.muted && !video.paused) video.muted = false;
        if (video.srcObject && video.paused) {
          void video.play().catch(() => {
            if (!video.muted) {
              video.muted = true;
              setNeedsSound(true);
              void video.play().catch(() => undefined);
            }
          });
        }
      }
      timer = window.setTimeout(inspect, 700);
    };
    inspect();
    return () => {
      window.clearTimeout(timer);
      // Only the sampler stops; the last frame it took is kept, so the panels go on showing the world
      // through a reconnect instead of flickering to the fallback art and back.
      attachWorldVideo(null);
    };
  }, [publishVideoState, status, videoTrack]);

  // Report a diagnosis instead of hanging silently when the session never readies.
  useEffect(() => {
    if (status === "ready" || !request || everReady.current) return;
    waitTimer.current = window.setTimeout(() => {
      setError("Orbis never became ready. Check the browser console for the [orbis] status log.");
    }, READY_TIMEOUT_MS);
    return () => window.clearTimeout(waitTimer.current);
  }, [request, status]);

  // Reliability: one concurrent session per account means ours must never be orphaned, and the menu
  // no longer holds a world at all. Runs pin it; the menu lets it go.
  useEffect(() => {
    const endSession = () => {
      // A release that fails here is the leak that costs the most, because the tab it belongs to is
      // usually gone by the time anyone notices: the retry it schedules only helps a page that comes
      // back from the bfcache, and the debt it records lives no longer than this page does — after
      // that, only the session's lease frees the slot.
      void releaseSession("pagehide");
    };
    window.addEventListener("pagehide", endSession);
    return () => window.removeEventListener("pagehide", endSession);
  }, [releaseSession]);

  useEffect(() => {
    if (status !== "ready" || runActive) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        console.info("[orbis] releasing the session: no run on screen");
        // A failed release is left to its own retry, and the request is deliberately not cleared
        // until it succeeds: the debt is paid by the next connect (see `startWorld`), and clearing the
        // request first would leave that connect with nothing to ask for.
        if (!(await releaseSession("idle menu"))) return;
        applied.current = {};
        generation.current = "idle";
        // The request goes with the session. The menu asks for nothing, so there is nothing to
        // re-arm, and leaving it set would have the recovery effect connect a world the player never
        // asked for — which is the difference between a local menu and an accidental billing.
        setRequest(undefined);
      })();
    }, IDLE_SESSION_CAP_MS);
    return () => window.clearTimeout(timer);
  }, [runActive, status]);

  // The published selection rather than a hardcoded world: the menu asks for nothing, so when there is
  // no request the local backdrop still has to be the tint of the world the player picked.
  const world = request?.environment ?? selectedWorld ?? "desert";

  return (
    <>
      <div className="world-local" data-world={world} aria-hidden="true" />
      <div
        ref={surface}
        className="world-layer"
        data-world={world}
        data-status={status}
        data-video={videoState}
        data-session={sessionId ?? ""}
        data-paused={session.paused ? "true" : "false"}
        data-landscape={request?.landscape ? request.landscape.label : ""}
        aria-label="Live Orbis world"
      >
        {status !== "disconnected" && (
          <ViskoOrbisStableMainVideoView
            className="world-video"
            videoObjectFit="cover"
            audioTrack="main_audio"
            muted
          />
        )}
        {needsSound && (
          <button
            className="orbis-sound"
            type="button"
            onClick={() => {
              const video = surface.current?.querySelector("video");
              if (video) {
                video.muted = false;
                void video.play().catch(() => undefined);
              }
              setNeedsSound(false);
            }}
          >
            Enable world sound
          </button>
        )}
      </div>
    </>
  );
}

export default function WorldLayer() {
  return (
    <ViskoOrbisStableProvider jwtToken={getReactorToken} connectOptions={CONNECT_OPTIONS}>
      <WorldSession />
    </ViskoOrbisStableProvider>
  );
}
