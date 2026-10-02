export type Environment = "desert" | "city" | "forest";

/**
 * How many hits a run survives.
 *
 * The run had no end at all: a collision cost a stumble, a reset combo and a short recovery, and the
 * player carried on forever. That made the world's own escalation (`dangerLevel`, which is exactly
 * this number as a fraction) decorative — the game could promise a breaking point it never reached.
 * Three is the smallest number that still lets a run *be* a run: one hit teaches, two warn, the third
 * ends it, and a shield (see the power-ups) buys the mistake back.
 */
export const MAX_DAMAGE = 3;

/**
 * True when the run has taken all the hits its *terms* allow.
 *
 * The limit is a parameter rather than the constant because a run contract can lower it — a run taken
 * under "Glass cannon" ends on the first hit — and the end of a run has to be decided by the deal the
 * player actually took, not by the default one.
 */
export function isRunOver(state: RunState, hits: number = MAX_DAMAGE): boolean {
  return state.damage >= hits;
}

export type PlayerStyle =
  | "reckless"
  | "precise"
  | "aggressive"
  | "explorer";

/**
 * A run as the simulation sees it.
 *
 * One caveat for anything reading this outside the frame loop: `shield` in here is the *pickup*, not
 * the last line of defence — a hit is taken against the shield before `damage` moves, so a run with
 * a shield up reads as undamaged until the shield breaks.
 */
export type RunState = {
  environment: Environment;
  distance: number;
  speed: number;
  score: number;
  combo: number;
  coins: number;
  stumbles: number;
  nearMisses: number;
  jumps: number;
  slides: number;
  damage: number;
  dangerLevel: number;
  playerStyle: PlayerStyle;
  currentEvent?: string;
  /**
   * The world's own weather, as the HUD reads it: the card's hazard arriving, here, and how hard.
   *
   * It lives in the run state rather than beside it because it *is* run state: the storm takes the
   * picture, the blackout takes the light, the fog takes the planning distance, and all three are
   * decided per frame from the same distance and difficulty every other rule reads. The HUD is fed
   * from this by the same five-a-second progress tick that feeds the counters.
   */
  hazard: { kind: HazardKind; name: string; phase: HazardPhase; intensity: number };
  /**
   * How well the run is being played as opposed to how far it has got: 0..1, built by near misses and
   * by threading the gaps between them, spent by time and wiped by a hit.
   *
   * `distance` and `score` measure *how long* someone has survived; this measures *how* — and it is
   * the one number the whole game is built around (the world's posture, the near-miss chain, the
   * difficulty ramp), so it is the one the skill ceiling should pay.
   */
  flow: number;
  /** Gaps threaded this run: the perfect near miss, counted for the record and the card. */
  threads: number;
  /** True while a shield pickup is up: the next hit is spent on it instead of on `damage`. */
  shield: boolean;
  /** Seconds left on each active pickup, so the HUD and the sim read the same clock. */
  magnet: number;
  doubleTokens: number;
};

/**
 * The three ways a world turns on a run, and whether it is here yet.
 *
 * The kinds are the shared vocabulary between the schedule (`hazards.ts`), the run state the HUD
 * reads, and the prompts that ask the world to *look* like it: one word per condition. Only two of
 * them take anything from the run — the blackout takes the light, the fog takes the planning distance;
 * the storm is the picture's hazard and leaves the driving alone (see the note in `hazards.ts`).
 */
export type HazardKind = "storm" | "blackout" | "fog";
export type HazardPhase = "calm" | "warning" | "active";

export type WorldEvent =
  | { type: "run_started"; environment: Environment }
  /**
   * The terms this run was taken under, acknowledged once the dive has landed.
   *
   * Sent after the launch window rather than at the line because that window drops events on purpose —
   * the dive owns the opening seconds — and the world's answer to a deal is part of how the run opens,
   * so it belongs at the moment the run settles onto its own terms rather than underneath the dive.
   */
  | { type: "contract_taken"; contract: string }
  | { type: "hazard_started"; hazard: string }
  /**
   * The run has gone ahead of the best one this world has seen — the ghost's line, overtaken.
   *
   * Carries how far, in metres, because that is the number the player is racing: the best run's own
   * distance at this many seconds in, subtracted from the distance this run has now covered.
   */
  | { type: "ghost_passed"; ahead: number }
  | { type: "near_miss"; obstacle?: string }
  | { type: "combo_milestone"; combo: number }
  /**
   * A hit, with the hits the run has left *under its own terms*.
   *
   * The count is carried rather than derived, because a contract can lower the limit: under "Glass
   * cannon" the only hit a run takes is its last one, and a feed that reported `MAX_DAMAGE - damage`
   * would tell a player who has just lost the run that they have two lives left.
   */
  | { type: "damage_taken"; amount: number; left: number }
  | { type: "speed_milestone"; speed: number }
  | { type: "distance_milestone"; distance: number }
  /** An obstacle passed in one adjacent lane with another in the other: the run threaded a gap. */
  | { type: "perfect_gap"; threads: number }
  | { type: "powerup_collected"; powerup: string }
  /** A pickup used itself up — the shield is the one that does, by taking a hit. */
  | { type: "powerup_spent"; powerup: string }
  /** The run crossed a quarter of its reward curve: tokens pay more from here, and the world answers. */
  | { type: "value_tier"; tier: number; value: number }
  | { type: "world_event"; event: string }
  | { type: "run_ended"; score: number };

/**
 * The events the player caused by their own play, which must not be lost to the world's chatter.
 *
 * The director keeps exactly one event in its pending slot, and a routine event is allowed to
 * overwrite a routine one there (`OrbisDirector.trigger`) — correct for the churn, because a near
 * miss every second and a milestone every fifty metres are the newest thing worth spending an ask on.
 * It ate the pickups, though: a pickup fires once and says nothing else for a while, a near miss
 * arrives a moment later, and the world was asked about the near miss. Measured before this: one
 * pickup answer in ninety-nine feed entries, across a session that collected dozens of pickups.
 * A hit is here for the same reason — a run only has three, and one that never reached the world
 * would be a third of the game's cause and effect missing.
 *
 * Deliberately not every milestone: distance, speed and combo milestones are the chatter, and
 * promoting them would let them displace each other instead.
 */
export const isPlayEvent = (event: WorldEvent): boolean =>
  event.type === "contract_taken" ||
  event.type === "ghost_passed" ||
  event.type === "perfect_gap" ||
  event.type === "powerup_collected" ||
  event.type === "powerup_spent" ||
  event.type === "damage_taken" ||
  event.type === "hazard_started" ||
  event.type === "value_tier";

export const initialRunState = (environment: Environment): RunState => ({
  environment,
  hazard: { kind: "storm", name: "", phase: "calm", intensity: 0 },
  flow: 0,
  threads: 0,
  distance: 0,
  speed: 0,
  score: 0,
  combo: 0,
  coins: 0,
  stumbles: 0,
  nearMisses: 0,
  jumps: 0,
  slides: 0,
  damage: 0,
  dangerLevel: 0,
  playerStyle: "explorer",
  shield: false,
  magnet: 0,
  doubleTokens: 0,
});
