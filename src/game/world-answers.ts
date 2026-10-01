import type { RunState, WorldEvent } from "./run-state";

/**
 * Why the world just changed, in the player's terms.
 *
 * The interface already knew this and did not say it: `RunExperience` showed the *prompt* — a
 * paragraph of prose written for a video model, three lines of clipped monospace in a corner — while
 * the thing that actually happened was a near miss, a milestone, or a hit. The causal chain the whole
 * game is built on ("it answers how you play") was therefore only legible to someone who had read the
 * prompts module.
 *
 * So each answer is described twice: the line is what the *run* did, and the detail is what the
 * *world* is doing about it. Neither one names a world, because all three share the code and the
 * flavour belongs to the prompts. The full prompt still travels with the entry — it is the evidence,
 * and a curious player can read it in the entry's title.
 */

export type WorldAnswer = {
  /** What the run did. Short: it is a line in a feed, not a sentence. */
  line: string;
  /** What the world is doing about it. */
  detail: string;
};

/**
 * A pickup's line says what it *does*, not just its name.
 *
 * The feed is three entries deep and lives in the corner of a run; "MAGNET" alone is a word the
 * player has no time to look up, where "MAGNET · COINS PULL" is the rule, arriving at the moment it
 * starts being true. Each pickup is described twice because being collected and being spent are two
 * different moments — a shield going up is a promise and a shield breaking is the promise being kept,
 * and one label reused for both would read "SHIELD UP SPENT".
 */
const POWERUP_LABELS: Record<string, { collected: string; spent: string; detail: string }> = {
  shield: { collected: "SHIELD UP", spent: "SHIELD SPENT", detail: "the next hit is spent on it" },
  magnet: { collected: "MAGNET · COINS PULL", spent: "MAGNET SPENT", detail: "coins bend toward your lane" },
  double: { collected: "DOUBLE · TOKENS ×2", spent: "DOUBLE SPENT", detail: "tokens pay twice" },
};

export function describeAnswer(event: WorldEvent, state: RunState): WorldAnswer {
  switch (event.type) {
    case "near_miss":
      return {
        line: state.combo > 1 ? `NEAR MISS ×${state.combo}` : "NEAR MISS",
        // The chain is the pressure: near misses are what pushes the world's posture (`playerStyle`)
        // past "clean", so the count is the cause of the lean, not decoration on it.
        detail: state.combo >= 12 ? "the world leans in hard" : "the world leans in",
      };
    case "combo_milestone":
      return { line: `CHAIN ×${event.combo}`, detail: "the world answers the pace" };
    case "damage_taken":
      return {
        line: `HIT · ${event.left} LEFT`,
        detail: "the world closes in",
      };
    case "speed_milestone":
      return { line: `${Math.round(event.speed)} M/S`, detail: "the world stretches out" };
    case "distance_milestone":
      return { line: `${Math.round(event.distance)} M`, detail: "the world opens up ahead" };
    case "value_tier":
      return {
        line: `VALUE UP · ${event.value} PTS`,
        detail: `the world lights up — tokens pay more (tier ${event.tier} of 4)`,
      };
    case "powerup_collected": {
      const pickup = POWERUP_LABELS[event.powerup];
      return { line: pickup?.collected ?? "PICKUP", detail: pickup?.detail ?? "the world takes note" };
    }
    case "perfect_gap":
      return {
        line: `GAP ×${event.threads}`,
        detail: "the world holds its breath",
      };
    case "hazard_started":
      return { line: event.hazard.toUpperCase(), detail: "the world turns on the run" };
    /**
     * The terms, as the world's first answer to the run.
     *
     * A deal is the one thing the player decides *before* the line and cannot see running afterwards
     * except in the numbers it bends, so the feed says the name back at the moment the run settles
     * onto it: the contract is the world agreeing, not a modifier the game applied silently.
     */
    case "contract_taken":
      return { line: `TERMS · ${event.contract.toUpperCase()}`, detail: "the world agrees to the deal" };
    /**
     * The best line, beaten — the run's own record overtaken while it is still going.
     *
     * It carries the metres because that is the race, and the feed says what it was racing against:
     * a best run is otherwise a number on a card at the end, and this is the only moment it becomes
     * something to run past.
     */
    case "ghost_passed":
      return { line: "BEST LINE BEATEN", detail: `${event.ahead} m up on your best run` };
    case "powerup_spent":
      return {
        line: POWERUP_LABELS[event.powerup]?.spent ?? "PICKUP SPENT",
        detail: "it took the hit for you",
      };
    case "run_started":
      return { line: "RUN", detail: "the world wakes" };
    default:
      return { line: "WORLD", detail: "the world changes" };
  }
}
