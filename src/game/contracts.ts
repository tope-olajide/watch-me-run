import { bankTokens, readBank, spendTokens } from "./bank";
import { MAX_DAMAGE } from "./run-state";

/**
 * The terms of a run, agreed before the line.
 *
 * The game had one choice worth making before a run — which world — and one way to play it. A contract
 * is the other half of that decision: the same world, a different deal, taken *before* the run rather
 * than adapted to during it. That is what makes it a decision instead of an upgrade: every contract
 * takes something away.
 *
 * Three of the four bend the reward and the risk against each other (fewer hits for richer coins and a
 * faster meter), and the fourth is the relief valve — the world's own weather called off, paid for with
 * a slower meter and slightly cheaper coins. None of them touch the *record*: the record is a score in
 * a world, and the terms a player chose are visible on the card, in the header and in the feed. A score
 * banked under a contract is still a score.
 *
 * The contract is deliberately a *rule*, not a sticker: the payoff is folded into the numbers the run
 * already computes (the token value, the flow gain, the hazard schedule), so nothing about the terms can
 * drift from what the run actually does.
 */
export type Contract = {
  id: string;
  /** What the terms are called, on the chip and in the header. */
  name: string;
  /** The deal in one line, for the picker. */
  rule: string;
  /** What the HUD and the feed say the run is being played under. */
  terms: string;
  /** Hits the run survives. */
  hits: number;
  /** What a token pays, on top of the world's own curve. */
  tokenScale: number;
  /** What a near miss or a threaded gap adds to the flow meter. */
  flowScale: number;
  /** Whether the world's own weather runs at all. */
  hazards: boolean;
  /**
   * Banked tokens it takes to play this deal at all. Zero for the deal everyone starts with.
   *
   * This is what the tokens a run collects are *for*: the deal that pays the most is the deal that
   * survives the least, so the bank is fed by exactly the runs the record punishes. Prices are set
   * against a run's real yield — a good forest run banks a few hundred tokens, a Glass cannon run a few
   * hundred more, and the last deal costs about four good runs rather than a grind.
   */
  cost: number;
};

export const CONTRACTS: Contract[] = [
  {
    id: "standard",
    name: "Standard",
    rule: "Three hits, the weather as it comes, nothing bent either way.",
    terms: "3 hits · hazards on",
    hits: MAX_DAMAGE,
    tokenScale: 1,
    flowScale: 1,
    hazards: true,
    cost: 0,
  },
  {
    id: "close",
    name: "Close quarters",
    rule: "Two hits, but near misses build the meter half again as fast and tokens pay 30% more.",
    terms: "2 hits · flow ×1.5 · tokens ×1.3",
    hits: 2,
    tokenScale: 1.3,
    flowScale: 1.5,
    hazards: true,
    cost: 500,
  },
  {
    id: "glass",
    name: "Glass cannon",
    rule: "One hit ends it. Tokens pay 60% more and the meter fills a little faster.",
    terms: "1 hit · flow ×1.2 · tokens ×1.6",
    hits: 1,
    tokenScale: 1.6,
    flowScale: 1.2,
    hazards: true,
    cost: 1200,
  },
  {
    id: "fair",
    name: "Fair weather",
    rule: "The world keeps its weather to itself. The meter fills slower and tokens pay 10% less.",
    terms: "3 hits · no hazards · flow ×0.75",
    hits: MAX_DAMAGE,
    tokenScale: 0.9,
    flowScale: 0.75,
    hazards: false,
    cost: 400,
  },
];

export const DEFAULT_CONTRACT = CONTRACTS[0];

export function contractById(id: string | undefined): Contract {
  return CONTRACTS.find((contract) => contract.id === id) ?? DEFAULT_CONTRACT;
}

/**
 * The chosen terms, remembered like the world choice — the decision outlives the visit, because a
 * player who has settled on one deal should not have to re-take it on every run.
 */
const STORAGE_KEY = "watchme-run:contract";

export function readContract(): Contract {
  try {
    return contractById(window.localStorage.getItem(STORAGE_KEY) ?? undefined);
  } catch {
    return DEFAULT_CONTRACT;
  }
}

export function rememberContract(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* a blocked store costs the player the memory, not the run */
  }
}

/**
 * The deals the player has paid for, held beside the choice rather than inside it.
 *
 * The free deal is unlocked by definition rather than by storage: a store that has never been written
 * still has to leave the player something to play, and "Standard, locked" is not a game.
 */
const UNLOCKED_KEY = "watchme-run:deals";

export function readUnlockedDeals(): string[] {
  try {
    const raw = window.localStorage.getItem(UNLOCKED_KEY);
    const stored = raw ? (JSON.parse(raw) as unknown) : [];
    const ids = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
    return ["standard", ...ids.filter((id) => id !== "standard")];
  } catch {
    return ["standard"];
  }
}

export function isDealUnlocked(id: string): boolean {
  const contract = contractById(id);
  return contract.cost === 0 || readUnlockedDeals().includes(contract.id);
}

/**
 * Buys a deal with banked tokens.
 *
 * Two writes that have to agree: the bank pays and the deal is remembered. Paying first and failing to
 * remember would take the tokens and leave the deal locked, so the remembering comes after the payment
 * and reports exactly what happened — `ok: false` with the reason, and the balance either way so the
 * menu can say what the player can now afford.
 */
export function unlockDeal(id: string): { ok: boolean; cost: number; balance: number; why?: string } {
  const contract = contractById(id);
  if (contract.cost === 0) return { ok: true, cost: 0, balance: readBank() };
  if (readUnlockedDeals().includes(contract.id)) return { ok: true, cost: 0, balance: readBank() };
  const paid = spendTokens(contract.cost);
  if (!paid.ok) return { ok: false, cost: contract.cost, balance: paid.balance, why: "not enough tokens" };
  try {
    window.localStorage.setItem(
      UNLOCKED_KEY,
      JSON.stringify([...readUnlockedDeals(), contract.id]),
    );
  } catch {
    return { ok: false, cost: 0, balance: bankTokens(contract.cost), why: "the deal could not be remembered" };
  }
  return { ok: true, cost: contract.cost, balance: paid.balance };
}
