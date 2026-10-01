import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import RunnerScene, { type RunTerms } from "./game/RunnerScene";
import SoundSettings from "./game/SoundSettings";
import { playCoin } from "./game/audio";
import { coinMultiplierAt, coinValueAt, difficultyAt, environmentPace } from "./game/pattern-field";
import type { CharacterId } from "./game/character-catalog";
import type { Environment, HazardKind, RunState, WorldEvent } from "./game/run-state";
import { CONTRACTS, readContract, readUnlockedDeals, rememberContract, type Contract } from "./game/contracts";
import { bestFor, fileRun, type BestRun, type RunSummary } from "./game/records";
import { bankTokens, readBank } from "./game/bank";
import { worldById } from "./game/worlds";
import { OrbisDirector, RUN_QUIET_MS } from "./orbis/orbis-director";
import { describeAnswer } from "./game/world-answers";
import { launchPrompt } from "./orbis/prompts";
import { subscribeChunks, useWorld, world, worldLabel, worldTone } from "./orbis/world-bus";

/**
 * How many answers the feed keeps.
 *
 * Three, because the card is a corner of a screen that is mostly game: enough to see that the world is
 * answering *repeatedly* rather than once, and few enough that nothing is ever pushed off the bottom
 * while the player is still reading it.
 */
const FEED_LENGTH = 3;

/**
 * How often the deal is asked for again until the world has answered it.
 *
 * The ask is made once the dive is over, but it can only be spent at a slot the world will actually
 * read, and a run that takes a hit and a pickup while the opening chunk is still the one already
 * spoken for pushes the announcement out of the queue (see the director's `enqueue`). A deal that is
 * answered a few seconds late is still the deal; one that is never answered is the failure.
 */
const TERMS_RETRY_MS = 2200;

/** One answered ask: what the run did, what the world did about it, and the prompt that was sent. */
type FeedEntry = {
  key: number;
  line: string;
  detail: string;
  prompt: string;
};

type RunExperienceProps = {
  environment: Environment;
  characterId: CharacterId;
  onExit: () => void;
  /** True while the exit transition is playing: the run is leaving, not playing. */
  leaving?: boolean;
};

/**
 * What each hazard is doing to the run, in the shortest words that are still true.
 *
 * A hazard name alone is a weather report, and the player has two seconds to act on it. The "here"
 * line is the *rule* the weather is imposing for as long as it lasts — which is the one thing the
 * badge, the picture and the run all need to agree about.
 */
const HAZARD_VERBS: Record<HazardKind, { here: string; does: string }> = {
  shove: { here: "it moves you", does: "The storm pushes the runner a lane sideways — steer back" },
  blackout: { here: "lights out", does: "The city's power fails and the lane markings go dark" },
  fog: { here: "the world closes in", does: "The fog takes the distance: you can see less far ahead" },
};

/**
 * The deal on the table.
 *
 * The run had one decision worth making before the line — which world — and one way to play it. The
 * contract is the other half of that decision, and it belongs on the surfaces where the player is
 * already stopped (a pause, and the card a run ends on) rather than floating over a live run, because
 * taking a deal *starts a new run*: the terms are what the simulation is mounted with, so changing
 * them mid-run would either change nothing or change it under the player's feet. The head says so
 * outright, and every chip carries its own rule, so nothing here is a hidden modifier.
 */
function ContractPicker({
  current,
  unlocked,
  bank,
  onTake,
}: {
  current: Contract;
  unlocked: string[];
  bank: number;
  onTake: (deal: Contract) => void;
}) {
  return (
    <div className="contract-picker">
      <div className="contract-picker-head">
        <span className="eyebrow">Terms</span>
        <small>
          taking a deal starts a new run{bank > 0 ? ` · ${bank} tokens banked` : ""}
        </small>
      </div>
      <div className="contract-chips">
        {CONTRACTS.map((deal) => {
          // A deal the bank has not paid for is shown, shut, with its price on it: the picker is where a
          // player finds out that the harder deals exist at all, and a locked chip that explained itself
          // only as an error would be a dead end rather than a target. Unlocking happens in the menu.
          const locked = deal.cost > 0 && !unlocked.includes(deal.id);
          return (
            <button
              key={deal.id}
              type="button"
              className="contract-chip"
              data-contract={deal.id}
              data-selected={deal.id === current.id ? "true" : "false"}
              data-locked={locked ? "true" : "false"}
              aria-pressed={deal.id === current.id}
              disabled={locked}
              title={locked ? `${deal.name} is locked: ${deal.cost} banked tokens, unlocked in the menu` : deal.rule}
              onClick={() => onTake(deal)}
            >
              <b>{deal.name}</b>
              <small>{locked ? `${deal.cost} tokens · locked` : deal.terms}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function RunExperience({ environment, characterId, onExit, leaving = false }: RunExperienceProps) {
  /**
   * Why the world just changed — the last few answers, newest first.
   *
   * This used to be the prompt itself: a paragraph of prose addressed to a video model, which is
   * evidence rather than explanation. The feed carries what the run did and what the world did about
   * it, and keeps the prompt in the entry for anyone who wants to read the ask itself.
   */
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const feedKey = useRef(0);
  const [distance, setDistance] = useState(0);
  const [score, setScore] = useState(0);

  const [coins, setCoins] = useState(0);
  const [paused, setPaused] = useState(false);
  /**
   * The run's vitals, mirrored out of the simulation for the HUD.
   *
   * `damage` was tracked by the simulation from the beginning and shown to nobody: the game counted
   * the hits that were about to end a run that could not end. Same for `combo`, which was deciding
   * the world's posture (`playerStyle`) while being invisible — the one number that makes the Orbis
   * loop legible was the one number not on screen.
   */
  const [damage, setDamage] = useState(0);
  const [combo, setCombo] = useState(0);
  const [danger, setDanger] = useState(0);
  /**
   * The pickups that are still running.
   *
   * Shown rather than only felt, because each one changes the rules in a way that reads as a fault
   * when it is silent: coins bending into the lane look like a placement bug unless the HUD says the
   * run asked for them, tokens paying double look like the multiplier drifted, and a shield is
   * invisible until it saves you — the one pickup that has to be on screen for the whole time it is up.
   */
  const [shield, setShield] = useState(false);
  const [magnet, setMagnet] = useState(0);
  const [doubled, setDoubled] = useState(0);
  /** How well the run is being played, 0..1, and the gaps it has threaded. */
  const [flow, setFlow] = useState(0);
  const [threads, setThreads] = useState(0);
  /**
   * The world's own weather, mirrored out of the run state.
   *
   * It is read here for two things the simulation cannot draw: the badge that names what is coming —
   * the menu sold the world on that word, and a hazard that arrives unnamed is just the lighting
   * changing — and the verb beside it, because "Sandstorm" says the weather and not what it is about
   * to do to the player.
   */
  const [weather, setWeather] = useState<RunState["hazard"]>({
    kind: "shove",
    name: "",
    phase: "calm",
    intensity: 0,
  });
  const [attempt, setAttempt] = useState(0);
  /**
   * The terms this run was taken under.
   *
   * Read from the store on mount so the deal outlives the visit — a player who settled on "Glass
   * cannon" should not have to re-take it every time they come back — and held in state because the
   * simulation is mounted with it: the chip in the HUD and the numbers the run pays come from the
   * same object, so the card the player was shown and the run they got cannot disagree.
   */
  const [contract, setContract] = useState<Contract>(() => readContract());
  /**
   * Set when the run ends: what it scored, whether that beat the record, and what it paid into the bank.
   *
   * The banked numbers ride on the card rather than being read from the store when it renders, because
   * the card is a *receipt*: it says what this run did, and a balance re-read a second later could show
   * a number this run did not produce.
   */
  const [result, setResult] = useState<
    {
      summary: RunSummary;
      improved: boolean;
      best: BestRun;
      previous?: BestRun;
      paid: number;
      banked: number;
    } | null
  >(null);
  /**
   * The best run this world has, held in state so the ghost mark, the HUD race and the card all read
   * one object: the simulation is handed this, and a second read of the store could disagree with what
   * the world was actually asked to draw.
   */
  const [best, setBest] = useState<BestRun | undefined>(() => bestFor(environment));
  /**
   * The deals the bank has paid for. Read once per visit, because the only place a deal can be bought is
   * the menu, and the menu and the run are never on screen together.
   */
  const [unlocked] = useState<string[]>(() => readUnlockedDeals());
  /** Tokens banked by finished runs. Shown here because a run is where they are earned. */
  const [bank, setBank] = useState(() => readBank());
  /**
   * The ghost, as the run itself is reading it: the lane the best line held at this metre, and how
   * many metres ahead of the best run at the same second this run is.
   */
  const [ghost, setGhost] = useState<{ lane: number; ahead: number } | null>(null);
  /** Mirrors `result` for the reads that must not wait for a render: the key handler and steering. */
  const finished = useRef(false);
  finished.current = result !== null;
  const worldState = useWorld();
  const tone = worldTone(worldState);
  const landscape = worldState.landscape;
  const selected = worldById(environment);
  /**
   * The hazard the pressure meter is named for.
   *
   * It is the world's first advertised hazard — Sandstorm, Blackout, Fog — taken from the same catalog
   * the menu sells the world with. That is deliberate: the meter is the world's own escalation, and
   * naming it with the word the player was promised is the cheapest way to keep the promise
   * connected to the thing they can see moving.
   */
  const hazard = selected.hazards[0] ?? "Pressure";
  // What a token is worth right now, shown beside the count: the reward curve is only a curve if the
  // player can see it climbing.
  const tokenMultiplier = coinMultiplierAt(environment, distance);
  /**
   * The simulation's copy of the deal.
   *
   * Trimmed to the four things the run actually plays by rather than passed whole, so the simulation
   * cannot start reading a contract field the interface never showed anyone. It is memoised on the
   * contract because a new object identity would re-mount-adjacent: `RunnerScene` reads it in render,
   * so handing it a fresh object every render is a new set of terms every frame.
   */
  const terms = useMemo<RunTerms>(
    () => ({
      name: contract.name,
      hits: contract.hits,
      tokenScale: contract.tokenScale,
      flowScale: contract.flowScale,
      hazards: contract.hazards,
    }),
    [contract],
  );

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
  /** Set the moment the world answers the deal, which is when the asking may stop. */
  const termsAnswered = useRef(false);

  useEffect(() => {
    if (!lastToken) return;
    const timer = window.setTimeout(() => setLastToken(null), 1200);
    return () => window.clearTimeout(timer);
  }, [lastToken]);

  const onToken = useCallback((value: number) => {
    tokenKey.current += 1;
    setLastToken({ value, key: tokenKey.current });
    // The pickup is heard as it is collected, on the same callback that scores it: one event, one
    // place, so the sound cannot drift from the token that paid.
    playCoin();
  }, []);

  // A run continues the world the loading screen armed, and pins it: while a run is on screen the
  // session keeps sound and is never recycled. Leaving hands the world back rather than ending it, so
  // a next run inside the grace window starts inside the same stream instead of a cold session.
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
        sendPrompt: async (prompt, cause) => {
          // Only a cause makes a feed entry. The menu's opening shot and the launch are asks this
          // surface did not make in answer to anything the player did, and a feed that reported them
          // would be claiming credit for the world's own weather.
          if (cause) {
            if (cause.event.type === "contract_taken") termsAnswered.current = true;
            feedKey.current += 1;
            const answer = describeAnswer(cause.event, cause.state);
            setFeed((entries) =>
              [{ key: feedKey.current, ...answer, prompt }, ...entries].slice(0, FEED_LENGTH),
            );
          }
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

  // Leaving is not playing, and neither is finished: the run shell is still on screen for the exit
  // transition and for the end card, and the simulation keeps ticking behind both, so an event fired
  // now would land on top of the menu's establishing shot or steer a world nobody is running in.
  const steering = useRef(!leaving);
  steering.current = !leaving && !finished.current;
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

  /* ---- the terms, acknowledged once the dive is over -------------------------------------------
     The deal is the one thing about a run that is true from its first frame: how many hits it has,
     what a token pays, whether the world may turn its weather on it. The director drops every ask for
     `RUN_QUIET_MS` after a run takes the world — the dive owns the opening seconds, and an ask
     delivered under it would overwrite the shot the run just paid for — so "what are you playing
     under" is asked on *this* clock, once that window is behind us.

     Timed here rather than from the simulation for a measured reason: the director's clock is the wall
     clock and the simulation's is made of frame deltas, and in a slow frame the deltas can carry the
     run past its own threshold before that many seconds have actually passed. Announced from the
     simulation, the terms arrived inside the window that discards them — zero `TERMS` lines across
     four runs, one per deal — which is exactly the failure the drop rule was written to avoid for     the chatter, applied to the one event where it is wrong: a near miss delivered late is a lie about
     the moment, and a deal delivered late is still the deal.

     Which is why it is asked *repeatedly*: one ask can still be lost after the quiet window, measured
     in the Fair-weather run — the opening chunk is the one the dive prompt was read in, so the deal
     waits for the next boundary, and by then a hit and a pickup had arrived and the three-ask cap
     pushed the oldest ask out. The queue drops it without a word (`shift`), so a single ask is a
     coin toss; asking again until the feed shows the world answered it costs nothing, because an ask
     still matching the last prompt sent is discarded by the director's own dedupe. */
  useEffect(() => {
    termsAnswered.current = false;
    if (leaving) return;
    const ask = () => {
      const state = latestState.current;
      if (!state || !steering.current || termsAnswered.current) return;
      void director.trigger(
        { ...state, currentEvent: "contract_taken" },
        { type: "contract_taken", contract: contract.name },
        { priority: true },
      );
    };
    const first = window.setTimeout(ask, RUN_QUIET_MS + 500);
    const retry = window.setInterval(ask, TERMS_RETRY_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(retry);
    };
  }, [attempt, contract, director, leaving]);

  // A director event that missed its cooldown waits up to 1.8 s to flush. Left running, that timer
  // outlives the run and steers the world after the run is gone — the next world's launch prompt
  // would arrive and then be overwritten by an event from the run that already ended.
  useEffect(() => () => director.reset(), [director]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      event.preventDefault();
      // Pausing a finished run would put a pause over a card that is already a stop: the player
      // presses Space on the card expecting to start again, so it does nothing instead of lying.
      if (finished.current) return;
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

  // The DOM side of the pause, for the same reason as the scene clock: the video's slow breathe and
  // the screen-space weather are CSS animations, and a paused run with them still moving reads as a
  // stutter rather than a stop. One attribute on the root and the stylesheet freezes them all.
  useEffect(() => {
    const root = document.documentElement;
    if (paused) root.dataset.paused = "true";
    else delete root.dataset.paused;
    return () => {
      delete root.dataset.paused;
    };
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

  const onProgress = useCallback(
    (state: RunState, nextGhost: { lane: number; ahead: number } | null) => {
    latestState.current = state;
    setGhost(nextGhost);
    setDistance(state.distance);
    setScore(state.score);

    setCoins(state.coins);
    setDamage(state.damage);
    setCombo(state.combo);
    setDanger(state.dangerLevel);
    setShield(state.shield);
    setMagnet(state.magnet);
    setDoubled(state.doubleTokens);
    setWeather({ ...state.hazard });
    setFlow(state.flow);
    setThreads(state.threads);
  }, []);

  /**
   * The end of a run: the record is filed, the card goes up, and the world is let go.
   *
   * Reading the score off the simulation's own last state rather than off the HUD matters — the HUD
   * is throttled to five updates a second, and a run that ends between two of them would file a score
   * the player never earned.
   */
  const onRunEnd = useCallback(
    (state: RunState, line: number[]) => {
      const summary: RunSummary = {
        score: Math.round(state.score),
        distance: Math.floor(state.distance),
        tokens: state.coins,
        threads: state.threads,
        line,
      };
      const filed = fileRun(environment, summary);
      // The run pays into the bank whether or not it beat anything: the tokens are the currency, the
      // record is the target, and tying the two together would make a bad run worthless twice over.
      const banked = bankTokens(summary.tokens);
      setBank(banked);
      setBest(filed.best);
      setResult({
        summary,
        improved: filed.improved,
        best: filed.best,
        previous: filed.previous,
        paid: summary.tokens,
        banked,
      });
      setGhost(null);
      // The vitals land with the card rather than on the next progress tick: the pips and the pressure
      // meter are how the player reads *why* the run ended, and they are 200 ms behind otherwise.
      setDamage(state.damage);
      setCombo(state.combo);
      setDanger(state.dangerLevel);
      setFlow(state.flow);
      setThreads(state.threads);
      setShield(state.shield);
      setMagnet(state.magnet);
      setDoubled(state.doubleTokens);
      setPaused(false);
      // Nothing a finished run had queued may steer the world after it: the same reason the exit
      // transition stops the director, arriving one beat earlier.
      director.reset();
    },
    [director, environment],
  );

  /**
   * A new run without leaving the world.
   *
   * The simulation is remounted (`attempt`) rather than reloaded, and nothing about the session
   * changes: the world keeps streaming through the card, the same warm session is reused, and the
   * player is running again in a few hundred milliseconds instead of waiting out a loading screen.
   */
  const runAgain = useCallback(() => {
    setResult(null);
    setPaused(false);
    setDistance(0);
    setScore(0);
    setCoins(0);
    setDamage(0);
    setCombo(0);
    setDanger(0);
    setShield(false);
    setMagnet(0);
    setDoubled(0);
    setWeather({ kind: "shove", name: "", phase: "calm", intensity: 0 });
    setFlow(0);
    setThreads(0);
    setLastToken(null);
    setBeat(null);
    // A new run starts with nothing answered: the feed the last run earned is not this run's.
    setFeed([]);
    crossedTier.current = 0;
    latestState.current = null;
    setAttempt((value) => value + 1);
    // The new run asks for the same opening dive the first one got, so the chunks that land next
    // belong to this run rather than to the one that just ended.
    world.sendPrompt(launchPrompt(world.view(environment)), { channel: "run", reason: "launch" });
    director.markRunStart();
  }, [director, environment]);

  /**
   * Taking a deal: remembered, then a new run under it.
   *
   * The shop and the run have to be the same object, so this is deliberately not a "modifier" — it
   * hands the terms to the simulation (through the mounted props) and starts over, exactly as pressing
   * "run again" would. Nothing is sticky: a player can take a deal, run it, and take the standard one
   * back from the same card, and the run they get is decided entirely by what is on the chip.
   */
  const takeContract = useCallback(
    (deal: Contract) => {
      // A locked deal cannot be taken even if the chip is reached past its `disabled` state: the price
      // is paid in the menu, and the run must not be able to hand out a deal nobody bought.
      if (deal.cost > 0 && !unlocked.includes(deal.id)) return;
      if (deal.id !== contract.id) rememberContract(deal.id);
      setContract(deal);
      runAgain();
    },
    [contract.id, runAgain, unlocked],
  );

  const exitRun = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onExit();
  }, [onExit]);

  return (
    <main className={`app-shell environment-${environment}`}>
      <section className="game-stage">
        {/*
          The weather, over everything the run draws.

          It has to be a screen-space scrim rather than a fog in the 3D layer, because the generated
          world is a DOM video *behind* the canvas: the blackout, the sand and the fog are conditions
          of the whole place, and a treatment that covered only the road would be a game effect
          happening in front of a sunny world. The strength and the kind come from the simulation
          through `:root` (`--weather`, `data-hazard`), so this element is inert — it draws nothing on
          its own and has nothing to keep in sync.
        */}
        <div className="hazard-layer" aria-hidden="true" />
        <RunnerScene
          environment={environment}
          characterId={characterId}
          paused={paused}
          attempt={attempt}
          terms={terms}
          ghost={best ?? null}
          onWorldEvent={onWorldEvent}
          onProgress={onProgress}
          onToken={onToken}
          onRunEnd={onRunEnd}
        />
        {paused && !result && (
          <div className="pause-overlay">
            <span className="eyebrow">RUN PAUSED</span>
            <strong>Press SPACE to continue</strong>
            <small>
              {worldState.session.paused ? "The world is paused with you" : "Pausing the world…"}
            </small>
            {/* The pause is where a player notices the sound and wants it down, so the controls sit
                with the pause rather than a screen away. The track keeps playing behind this: it is
                the game's, not the world's, so it costs nothing and stopping it would make a pause
                sound like the game had ended. */}
            <SoundSettings />
            {/* A pause is one of the two places a deal can be taken: the player is stopped, the
                decision is cheap to read, and taking it restarts the run they were already willing
                to interrupt. */}
            <ContractPicker current={contract} unlocked={unlocked} bank={bank} onTake={takeContract} />
          </div>
        )}

        {/*
          The end of the run.

          It exists because the run finally has a way to end: three hits, and this is what the player
          gets instead of an endless lane that could never be lost. Score, distance and tokens are the
          run's own last frame; the record line is the reason to press Run again rather than Exit, and
          "run again" is instant because the world behind this card never stopped.
        */}
        {result && (
          <div className="run-over" role="dialog" aria-label="Run finished">
            <div className="run-over-card" data-improved={result.improved ? "true" : "false"}>
              <span className="eyebrow">{selected.label} · run finished</span>
              <strong className="run-over-title">
                {result.improved ? "NEW BEST" : "RUN OVER"}
              </strong>

              <div className="run-over-stats">
                <div><small>SCORE</small><strong>{result.summary.score.toLocaleString()}</strong></div>
                <div><small>DISTANCE</small><strong>{result.summary.distance}m</strong></div>
                <div><small>TOKENS</small><strong>{result.summary.tokens}</strong></div>
                <div><small>GAPS</small><strong>{result.summary.threads}</strong></div>
              </div>

              <p className="run-over-record">
                {result.improved
                  ? `Beat ${result.previous?.score.toLocaleString() ?? "your first run"} — the best here is now ${result.best.score.toLocaleString()}`
                  : `Best here is ${result.best.score.toLocaleString()} over ${result.best.distance}m`}
              </p>
              {/* What the run paid into the bank, which is the other half of what a run is for: the
                  tokens buy the harder deals, so a run that sets no record can still be the run that
                  unlocked Glass cannon. */}
              <p className="run-over-bank" data-paid={result.paid}>
                <span>BANK +{result.paid}</span>
                <small>{result.banked} tokens banked</small>
              </p>

              {/* The card is where a run is most likely to want different terms — the deal a player
                  wants is usually the one they did not take — so the picker sits above the actions:
                  taking a deal is a run-again with different numbers, and the score just filed stays
                  filed. */}
              <ContractPicker current={contract} unlocked={unlocked} bank={bank} onTake={takeContract} />

              <div className="run-over-actions">
                <button className="run-again" type="button" onClick={runAgain}>
                  <span>Run again</span>
                  <b>⟲</b>
                </button>
                <button className="quiet-button" type="button" onClick={exitRun}>
                  Exit to menu
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      {/*
        The run's chrome is one exit and the numbers that decide the run — see the stylesheet's play
        screen block. The title and the world-director status used to sit up here, and both were the
        game talking about itself while the player was busy.
      */}
      <header className="run-header">
        <button className="quiet-button" onClick={exitRun} type="button">
          ← Exit
        </button>
      </header>

      <div className="run-hud" data-damage={damage}>
        {/*
          The vitals, above the numbers: what the run has left, what it has earned, and how hard the
          world is pressing. They are the three things the simulation was already computing and the
          HUD was not showing — hits (`damage`), the chain (`combo`), and the pressure that used to be
          a number nothing read (`dangerLevel`).
        */}
        <div className="run-vitals">
          <span className="hud-hits" title={`${Math.max(0, contract.hits - damage)} of ${contract.hits} hits left`}>
            {Array.from({ length: contract.hits }, (_, index) => (
              <i key={index} className="hud-pip" data-spent={index < damage ? "true" : "false"} />
            ))}
          </span>
          {/* The terms this run is being played under. It sits beside the pips because that is what
              the pips *are*: the deal says how many there are, what a token pays and whether the
              world brings its weather, and a player who took Glass cannon should be able to see the
              one pip they are running on rather than infer it from the count. */}
          <span className="hud-contract" data-contract={contract.id} title={contract.rule}>
            <b>{contract.name}</b>
            <small>{contract.terms}</small>
          </span>
          <span
            className="hud-combo"
            data-chaining={combo >= 3 ? "true" : "false"}
            data-milestone={combo >= 12 ? "true" : "false"}
            title="Near misses and pickups chain the combo; a hit breaks it"
          >
            <b>×{combo}</b>
            <small>combo</small>
          </span>
          {/* The pressure is the run's own damage, read back as what the world is doing about it:
              the bar is filled by `dangerLevel` and named for this world's advertised hazard. */}
          <span className="hud-pressure" data-level={danger.toFixed(2)} title={`${hazard} pressure`}>
            <small>{hazard}</small>
            <span className="hud-pressure-track">
              <span className="hud-pressure-fill" style={{ width: `${Math.round(danger * 100)}%` }} />
            </span>
          </span>
          {/* The world's own weather, named while it is coming and kept while it is here. It sits
              with the pressure meter because it *is* the pressure: the meter says how hard the world
              is leaning on the run, and this says what it is leaning with. */}
          {weather.phase !== "calm" && (
            <span className="hud-hazard" data-phase={weather.phase} title={HAZARD_VERBS[weather.kind].does}>
              <b>{weather.name}</b>
              <small>{weather.phase === "warning" ? "incoming" : HAZARD_VERBS[weather.kind].here}</small>
            </span>
          )}
          {/* Nothing is reserved for the pickups: the row only grows when a run has one running, so a
              run without them looks exactly as it did before they existed. */}
          {/*
            Flow, the run's *form*: built by near misses and threaded gaps, drained by clean running
            and wiped by a hit. It is the only meter on screen whose number is what the ground pays
            (see the trickle in the simulation), so it reads as a rate rather than as a score — at
            full flow the road alone is worth two and a half times what coasting is, and the label
            says so rather than leaving the player to infer it.
          */}          {/*
            The ghost race: how far ahead or behind the best run in this world this run is, compared at
            the same number of seconds in. It is the one readout that makes an old record mean something
            during a run rather than only after it — the mark on the road says *where* the best line went,
            this says whether the player is beating it. Deliberately absent until a run has actually
            started moving, and absent entirely when there is no best to race.
          */}
          {ghost && distance > 30 && !result && (
            <span
              className="hud-ghost"
              data-ahead={ghost.ahead >= 0 ? "true" : "false"}
              title={`Your best run here, at this many seconds in: you are ${Math.abs(Math.round(ghost.ahead))} m ${ghost.ahead >= 0 ? "ahead of" : "behind"} it`}
            >
              <small>best</small>
              <b>{ghost.ahead >= 0 ? "+" : "−"}{Math.abs(Math.round(ghost.ahead))}m</b>
            </span>
          )}
          <span className="hud-flow" data-flow={flow >= 0.6 ? "true" : "false"} title={`Near misses and threaded gaps build flow; a hit wipes it. At full flow the ground pays ×${(1 + flow * 1.5).toFixed(1)}`}>
            <small>flow</small>
            <span className="hud-flow-track">
              <span className="hud-flow-fill" style={{ width: `${Math.round(flow * 100)}%` }} />
            </span>
            <b>×{(1 + flow * 1.5).toFixed(1)}</b>
            {/* The count of the moves the meter is made of: a bar says how well the run is going, a
                number says how many gaps it has been through to get there. */}
            {threads > 0 && (
              <em className="hud-threads" title={`${threads} gap${threads === 1 ? "" : "s"} threaded between two obstacles`}>
                {threads}⌷
              </em>
            )}
          </span>
          {(shield || magnet > 0 || doubled > 0) && (
            <span className="hud-pickups">
              {shield && (
                <i className="hud-pickup" data-kind="shield" title="Shield up: the next hit is spent on it">
                  shield
                </i>
              )}
              {magnet > 0 && (
                <i className="hud-pickup" data-kind="magnet" title="Coins are being pulled into your lane">
                  magnet {Math.ceil(magnet)}s
                </i>
              )}
              {doubled > 0 && (
                <i className="hud-pickup" data-kind="double" title="Tokens are paying double">
                  ×2 {Math.ceil(doubled)}s
                </i>
              )}
            </span>
          )}
        </div>

        {/*
          The numbers, in the order they matter: what the run has scored, what it has collected, and
          how far it has gone. Speed and the world's name used to ride along here; neither changes a
          decision the player makes, and the world's name is on the card at the end.
        */}
        <div className="run-cells">
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
        <div><small>DISTANCE</small><strong>{Math.floor(distance)}m</strong></div>
        {/* The world still sets the pacing, the obstacles and the road, so it stays on the label line
            and out of the player's view (see the stylesheet) — the place they ran in is the run-over
            card's business, and their own picture's name when they brought one. */}
        <div className="hud-world" title={landscape ? `Running in ${landscape.label}` : undefined}>
          <small>{landscape ? `WORLD ${environment}` : "WORLD"}</small>
          <strong>{landscape ? landscape.label : environment}</strong>
        </div>
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

      <aside className="director-card" data-answers={feed.length}>
        <span className="eyebrow">The world answers</span>
        {feed.length === 0 ? (
          <p className="director-idle">Nothing to answer yet — play, and it reacts.</p>
        ) : (
          <ul className="director-feed">
            {feed.map((entry) => (
              <li key={entry.key}>
                <b>{entry.line}</b>
                <span>{entry.detail}</span>
                {/* The ask itself, kept as the evidence behind the line above it. */}
                <em>{entry.prompt}</em>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </main>
  );
}
