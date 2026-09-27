import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import RunnerScene from "./game/RunnerScene";
import { coinMultiplierAt, coinValueAt, difficultyAt, environmentPace } from "./game/pattern-field";
import type { CharacterId } from "./game/character-catalog";
import type { Environment, RunState, WorldEvent } from "./game/run-state";
import { OrbisDirector } from "./orbis/orbis-director";
import { openingPrompt } from "./orbis/prompts";
import { subscribeChunks, useWorld, world, worldLabel, worldTone } from "./orbis/world-bus";

type RunExperienceProps = {
  environment: Environment;
  characterId: CharacterId;
  onExit: () => void;
  /** True while the exit transition is playing: the run is leaving, not playing. */
  leaving?: boolean;
};

export default function RunExperience({ environment, characterId, onExit, leaving = false }: RunExperienceProps) {
  const [lastPrompt, setLastPrompt] = useState(() => openingPrompt(world.view(environment)));
  const [distance, setDistance] = useState(0);
  const [score, setScore] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [coins, setCoins] = useState(0);
  const [paused, setPaused] = useState(false);
  const worldState = useWorld();
  const tone = worldTone(worldState);
  const landscape = worldState.landscape;
  // What a token is worth right now, shown beside the count: the reward curve is only a curve if the
  // player can see it climbing.
  const tokenMultiplier = coinMultiplierAt(environment, distance);

  /* ---- the reward curve, drawn rather than only numbered --------------------------------------
     A `×2.4` label says what a token is worth but not that it is *climbing*, or by how much, or how
     much run is left before it stops. So the readout carries three things: a ramp filling from the
     line to this world's ceiling, tick marks at the quarters where the value steps into a new tier,
     and the points the token that was just picked up actually paid — the last of which is the same
     number the scoring code used, so the readout cannot drift from the score. */
  const ramp = difficultyAt(environment, distance);
  const peakDistance = environmentPace[environment].difficultyMeters;
  const tokenValue = coinValueAt(environment, distance);
  const peakValue = coinValueAt(environment, peakDistance);
  /** Which quarter of the curve has been reached: 0 at the line, 4 at the ceiling. */
  const tier = Math.floor(ramp * 4);
  const [beat, setBeat] = useState<{ tier: number; value: number } | null>(null);
  const [lastToken, setLastToken] = useState<{ value: number; key: number } | null>(null);
  const crossedTier = useRef(0);
  const tokenKey = useRef(0);
  /**
   * The run's state as of its last frame. The tier crossing is decided in the interface's timeline
   * from the distance the HUD is showing, but the world has to be steered with a whole `RunState`, so
   * the frame the simulation most recently published is kept here instead of guessed at.
   */
  const latestState = useRef<RunState | null>(null);

  useEffect(() => {
    if (!lastToken) return;
    const timer = window.setTimeout(() => setLastToken(null), 1200);
    return () => window.clearTimeout(timer);
  }, [lastToken]);

  const onToken = useCallback((value: number) => {
    tokenKey.current += 1;
    setLastToken({ value, key: tokenKey.current });
  }, []);

  // A run continues the world the menu was already generating, and pins it: while a run is on
  // screen the session keeps sound and is never recycled. Leaving hands the world back to the menu
  // instead of ending it, so the next run starts inside the same continuous stream.
  useEffect(() => {
    world.showWorld(environment);
    world.setRunActive(true);
    return () => {
      world.setRunActive(false);
      // A pause belongs to the run that asked for it. The world pauses generation with the game, so
      // leaving without clearing this would hand the menu a world that never moved again.
      world.setPaused(false);
    };
  }, [environment]);

  const director = useMemo(
    () =>
      new OrbisDirector({
        // The `run` channel: the bus drops these the moment the run is no longer active, so an
        // event that fires while the exit transition plays cannot steer the menu's world.
        sendPrompt: async (prompt) => {
          setLastPrompt(prompt);
          world.sendPrompt(prompt, { channel: "run", reason: "run-event" });
        },
        // Orbis generates the sound with the picture, on its own channel. A caption is one sentence
        // where the visual prompt beside it is a paragraph, so the sound costs almost nothing to
        // steer — and the world has been silent for its whole life up to now.
        sendAudio: async (prompt) => {
          world.sendAudio(prompt, { channel: "run", reason: "run-event" });
        },
        custom: () => Boolean(world.view(environment).custom),
      }),
    [environment],
  );

  // The world reads a prompt when it starts a chunk, so a chunk boundary is where an ask belongs.
  // The director's own timer is the fallback; this is the real cadence, straight from the model.
  useEffect(() => subscribeChunks((tick) => director.onChunk(tick.index)), [director]);

  // The entering transition already asked for the run's opening dive, so the director measures its
  // cooldown from there and stays quiet until the dive has landed.
  useEffect(() => {
    director.markRunStart();
  }, [director]);

  // Leaving is not playing. The run shell is still on screen for the exit transition and the
  // simulation keeps running behind it, so an event fired now would land on top of the menu's
  // establishing shot — a finished run steering the world the player has already left.
  const steering = useRef(!leaving);
  steering.current = !leaving;
  useEffect(() => {
    if (!leaving) return;
    director.reset();
  }, [leaving, director]);

  /* ---- the reward curve, as a beat the world can answer ----------------------------------------
     A tier crossing is the moment the curve becomes worth something, so it does two things at once:
     the HUD announces it instead of silently changing a decimal, and the world is asked to answer it.
     Both read the same `crossedTier`, so the label and the visual escalation can never disagree
     about how many steps up the run has gone.

     It sits below the director because it reaches the director directly rather than through
     `onWorldEvent`: that channel carries the run's gameplay events, and a tier crossing is a
     milestone that must not be dropped in favour of a routine distance update. Four of them a run —
     one per quarter — which is a beat the world can act on instead of a churn of numbers. */
  useEffect(() => {
    if (tier <= crossedTier.current) return;
    crossedTier.current = tier;
    const value = coinValueAt(environment, (tier / 4) * peakDistance);
    setBeat({ tier, value });

    const state = latestState.current;
    if (steering.current && state) {
      void director.trigger(
        { ...state, currentEvent: "value_tier" },
        { type: "value_tier", tier, value },
        { priority: true },
      );
    }

    const timer = window.setTimeout(() => setBeat(null), 1800);
    return () => window.clearTimeout(timer);
  }, [tier, environment, peakDistance, director]);

  // A director event that missed its cooldown waits up to 1.8 s to flush. Left running, that timer
  // outlives the run and steers the world after the run is gone — the next world's launch prompt
  // would arrive and then be overwritten by an event from the run that already ended.
  useEffect(() => () => director.reset(), [director]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      event.preventDefault();
      setPaused((value) => !value);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Pausing the game pauses the world with it. It is the same pause, not a second one: a paused
  // session stops producing chunks, so the frame on screen is the frame that was paused, and the
  // account is not paying for a world nobody is looking at.
  useEffect(() => {
    world.setPaused(paused);
  }, [paused]);

  const onWorldEvent = useCallback(
    (state: RunState, event: WorldEvent) => {
      latestState.current = state;
      setDistance(state.distance);
      setScore(state.score);
      setCoins(state.coins);
      if (!steering.current) return;
      void director.trigger(state, event);
    },
    [director],
  );

  const onProgress = useCallback((state: RunState) => {
    latestState.current = state;
    setDistance(state.distance);
    setScore(state.score);
    setSpeed(state.speed);
    setCoins(state.coins);
  }, []);

  const exitRun = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onExit();
  }, [onExit]);

  return (
    <main className={`app-shell environment-${environment}`}>
      <section className="game-stage">
        <RunnerScene
          environment={environment}
          characterId={characterId}
          paused={paused}
          onWorldEvent={onWorldEvent}
          onProgress={onProgress}
          onToken={onToken}
        />
        {paused && (
          <div className="pause-overlay">
            <span className="eyebrow">RUN PAUSED</span>
            <strong>Press SPACE to continue</strong>
            <small>
              {worldState.session.paused ? "The world is paused with you" : "Pausing the world…"}
            </small>
          </div>
        )}
      </section>

      <header className="run-header">
        <button className="quiet-button" onClick={exitRun} type="button">
          ← Exit
        </button>
        <div className="run-title">WATCHME RUN</div>
        <div className="run-status"><span className="status-dot" /> World director active</div>
      </header>

      <div className="run-hud">
        <div><small>DISTANCE</small><strong>{Math.floor(distance)}m</strong></div>
        <div><small>SPEED</small><strong>{speed.toFixed(1)}</strong></div>
        <div><small>SCORE</small><strong>{Math.round(score).toLocaleString()}</strong></div>
        <div>
          <small>TOKENS</small>
          <strong>
            {coins}
            <em className="token-mult">×{tokenMultiplier.toFixed(1)}</em>
            {lastToken && (
              <em className="token-gain" key={lastToken.key}>
                +{lastToken.value}
              </em>
            )}
          </strong>
          <div
            className={`token-ramp${beat ? " is-beat" : ""}`}
            data-ramp={Math.round(ramp * 100)}
            data-tier={tier}
            data-token-value={tokenValue}
            data-peak-value={peakValue}
            title={`Tokens pay ${coinValueAt(environment, 0)} points at the line and ${peakValue} by ${peakDistance} m`}
          >
            <span className="token-ramp-track">
              <span className="token-ramp-fill" style={{ width: `${Math.round(ramp * 100)}%` }} />
              <i className="token-ramp-tick" style={{ left: "25%" }} />
              <i className="token-ramp-tick" style={{ left: "50%" }} />
              <i className="token-ramp-tick" style={{ left: "75%" }} />
            </span>
            <small className="token-ramp-label">
              {beat ? `VALUE UP · ${beat.value} PTS` : `${tokenValue} PTS · MAX ${peakValue}`}
            </small>
          </div>
        </div>
        {/* The world still sets the pacing, the obstacles and the road, so it stays on the label line;
            the value line names the place the player is actually running through, which is their own
            picture when they brought one. */}
        <div title={landscape ? `Running in ${landscape.label}` : undefined}>
          <small>{landscape ? `WORLD ${environment}` : "WORLD"}</small>
          <strong>{landscape ? landscape.label : environment}</strong>
        </div>
      </div>

      <div
        className={`orbis-preview tone-${tone} ${worldState.error ? "is-error" : ""}`}
        data-orbis-status={worldState.status}
        data-orbis-video={worldState.videoState}
        data-orbis-error={worldState.error ?? ""}
      >
        <span className="orbis-pulse" />
        <span className="orbis-label">{worldLabel(worldState)}</span>
        {worldState.error && (
          <>
            <span className="orbis-error-text">{worldState.error}</span>
            <button className="quiet-button" onClick={() => world.retry()} type="button">
              Retry world link
            </button>
          </>
        )}
      </div>

      <aside className="director-card">
        <span className="eyebrow">LIVE WORLD EVENT</span>
        <p>{lastPrompt}</p>
      </aside>
    </main>
  );
}
