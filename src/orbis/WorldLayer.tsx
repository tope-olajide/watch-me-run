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
 * gameplay — the runner is fully playable in local world mode if Orbis never connects.
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
 * The account allows one concurrent Orbis session per model, and a session that was closed by a
 * killed tab or a reload holds its slot for a while. A fast second visit therefore has to wait,
 * so this retries for a couple of minutes with the reason on screen rather than giving up — the
 * game is playable in local world mode the whole time.
 */
const BUSY_RETRY_DELAY_MS = 8_000;
const BUSY_MAX_ATTEMPTS = 15;
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

/** A session that outlives its usefulness holds the account's only slot. Release idle ones. */
const IDLE_SESSION_CAP_MS = 25 * 60_000;

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
 * as "broken world" is both ugly and wrong: the run keeps playing in local world mode and the link
 * comes back by itself. Transport symptoms get the reconnecting copy; real errors keep their text.
 */
const TRANSPORT_PATTERN = /disconnect|transport|websocket|peer connection|fetch failed|network/i;
const RECONNECTING_MESSAGE = "World link interrupted — reconnecting";
/**
 * The same symptom on a link that never came up. Nothing is retrying this one, so it must not claim
 * to be reconnecting — the run continues in local world mode and the retry button is the way back.
 */
const UNREACHABLE_MESSAGE = "Couldn't reach the Orbis world — the run plays in local world mode";

/** Backoff for recovering a session that dropped on its own, while a world is still wanted. */
const RECONNECT_BASE_MS = 2_500;
const RECONNECT_MAX_ATTEMPTS = 6;

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

  const { runActive, pauseRequested } = useWorld();
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

  const startWorld = useCallback(async (next: WorldRequest) => {
    setRequest(next);
    updateWorld({ world: next.environment });

    // A session that exists is steered, never reconnected: `connect()` throws "Already connected or
    // connecting" for any status but `disconnected`, which used to surface as a broken world just
    // for asking for a world while the transport was still negotiating.
    if (statusRef.current !== "disconnected" || connecting.current) return;

    connecting.current = true;
    resetReactorToken();
    try {
      await sdk.current.connect();
    } catch (cause) {
      console.error("[orbis] connect failed", cause);
      const text = errorText(cause);

      if (/already connected/i.test(text)) return;

      if (BUSY_PATTERN.test(text) && busyAttempts.current < BUSY_MAX_ATTEMPTS) {
        busyAttempts.current += 1;
        setError(`${BUSY_MESSAGE} (${busyAttempts.current}/${BUSY_MAX_ATTEMPTS})`);
        retryTimer.current = window.setTimeout(() => void startWorld(next), BUSY_RETRY_DELAY_MS);
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
      retry: () =>
        void handlers.current.startWorld(requestRef.current ?? { environment: "desert", landscape: null }),
    });
    if (queued) void handlers.current.startWorld(queued);
    return () => {
      unregisterWorldCommands();
      window.clearTimeout(retryTimer.current);
      window.clearTimeout(waitTimer.current);
      window.clearTimeout(reconnectTimer.current);
      window.clearTimeout(restTimer.current);
      window.clearTimeout(pauseRetryTimer.current);
    };
  }, []);

  useEffect(() => {
    updateWorld({ status, sessionId });
    if (status === "ready") {
      everReady.current = true;
      // A recovered link earns a fresh budget of recovery attempts.
      reconnectAttempts.current = 0;
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
  // still wanted, and a run in progress must not finish in local world mode because of a blip. The
  // backoff is bounded, and a link that comes back resets the budget.
  useEffect(() => {
    if (status !== "disconnected" || !request || !everReady.current) return;
    if (reconnectAttempts.current >= RECONNECT_MAX_ATTEMPTS) return;

    const wait = RECONNECT_BASE_MS * 2 ** reconnectAttempts.current;
    reconnectTimer.current = window.setTimeout(() => {
      reconnectAttempts.current += 1;
      console.info(`[orbis] recovering a dropped session (attempt ${reconnectAttempts.current})`);
      if (requestRef.current) void handlers.current.startWorld(requestRef.current);
    }, wait);
    return () => window.clearTimeout(reconnectTimer.current);
  }, [request, status]);

  /**
   * Arm and start the session for the requested world and landscape.
   *
   * A landscape the player supplied is not a prompt — it is a *condition* of the session. Orbis pins
   * a starting image before `start` and inherits it through every later chunk, and only `reset`
   * clears one, so changing the landscape (in either direction, supplied or generated) is a rebuilt
   * world rather than a morph. A change of *world* on the same landscape stays what it always was: a
   * prompt swap the model blends into at the next chunk boundary.
   *
   * The teardown is sequenced against the model's own snapshot rather than against a flag of our own,
   * because the two can disagree for a moment after every command — and a `start` issued in that
   * window is answered by "Already generating.", which is exactly the console noise that made the
   * early version of this layer look broken.
   */
  useEffect(() => {
    if (status !== "ready" || !request || runActive) return;

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

    // Timed because pinning a landscape is the one thing in this layer a player has to wait for: it
    // is a rebuild, not a morph, and the menu holds the run until it is done. Knowing which step
    // costs the seconds is the difference between a fix and a guess.
    const armStartedAt = Date.now();

    void (async () => {
      generation.current = "starting";
      let pinTook = 0;
      try {
        // 1. A new landscape needs the previous conditions cleared. `reset` is the only thing that
        //    clears a starting image, and it must happen before anything is re-armed.
        if (armed && appliedState.landscape !== landscapeKey) {
          const resetAt = Date.now();
          await sdk.current.reset();
          applied.current = {};
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
          pinTook += Date.now() - resetAt;
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
            pinTook += Date.now() - imageAt;
          }

        }

        // 4. The conditions themselves: what it sounds like, and what it is. Sent on both paths — a
        //    world change on the same landscape is a prompt swap the model blends into, and a freshly
        //    armed session is being told them for the first time.
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
          console.info("[orbis] generation started");
        }

        applied.current = {
          armed: true,
          environment: request.environment,
          landscape: landscapeKey,
        };
        busyAttempts.current = 0;
      } catch (cause) {
        console.warn("[orbis] could not steer the world", cause);
      } finally {
        if (pinTook) {
          console.info(
            `[orbis] pinned the landscape in ${pinTook}ms, world armed in ${Date.now() - armStartedAt}ms`,
          );
        }
        generation.current = "idle";
        // The world is armed for the selected landscape, so a run may start. Cleared here rather
        // than after the await so a failed pin does not hold the menu forever — the world would be
        // the generated one, which is the honest outcome of an image that would not pin.
        updateWorld({ pinning: false });
      }
    })();
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
    return () => window.clearTimeout(timer);
  }, [publishVideoState, status, videoTrack]);

  // Report a diagnosis instead of hanging silently when the session never readies.
  useEffect(() => {
    if (status === "ready" || !request || everReady.current) return;
    waitTimer.current = window.setTimeout(() => {
      setError("Orbis never became ready. Check the browser console for the [orbis] status log.");
    }, READY_TIMEOUT_MS);
    return () => window.clearTimeout(waitTimer.current);
  }, [request, status]);

  // Reliability: one concurrent session per account means ours must never be orphaned, and an
  // idle one must not sit on the slot forever. Runs pin it; the menu recycles it.
  useEffect(() => {
    const endSession = () => {
      void sdk.current.disconnect().catch(() => undefined);
    };
    window.addEventListener("pagehide", endSession);
    return () => window.removeEventListener("pagehide", endSession);
  }, []);

  useEffect(() => {
    if (status !== "ready" || runActive) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        console.info("[orbis] recycling an idle session");
        await sdk.current.disconnect().catch(() => undefined);
        applied.current = {};
        generation.current = "idle";
        if (requestRef.current) await handlers.current.startWorld(requestRef.current);
      })();
    }, IDLE_SESSION_CAP_MS);
    return () => window.clearTimeout(timer);
  }, [runActive, status]);

  const world = request?.environment ?? "desert";

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
