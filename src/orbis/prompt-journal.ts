import type { Environment } from "../game/run-state";

/**
 * Every prompt this app asks the model for, recorded at the moment it is asked rather than when the
 * round-trip finishes.
 *
 * Both halves of that distinction were learned the hard way. Console scraping attributed a prompt to
 * whichever world's window happened to be open when the log line arrived, because browser log
 * delivery lags the send; and journaling on completion made a legitimate final run event look like
 * the run was still steering the world after Exit, because its network round-trip simply resolved
 * after the click. So: `at` is the request, `ok` is the outcome, and `reason` says why it was sent.
 */
export type PromptChannel = "app" | "run";

export type PromptReason =
  /** The menu's establishing wide shot, and the world morph that keeps it current. */
  | "world-morph"
  /** The forward dive into the run: the first chunks of a run belong to this prompt. */
  | "launch"
  /** Coming back out of a run, the world is returned to its wide shot. */
  | "exit-opening"
  /** One meaningful gameplay event. The only channel a run owns. */
  | "run-event"
  /** The sound channel: a world's bed, or its bed bent towards an event. */
  | "world-audio";

export type PromptRecord = {
  at: number;
  channel: PromptChannel;
  reason: PromptReason;
  environment: Environment | undefined;
  status: string;
  prompt: string;
  /**
   * Which channel of the model this prompt is for. Orbis generates sound and picture together but
   * conditions them separately, and a journal that mixed the two would make a one-sentence caption
   * look like a truncated scene prompt.
   */
  track?: "video" | "audio";
  /**
   * The chunk of the world that was current when this was asked.
   *
   * Orbis reads one prompt per chunk — the one in force when the chunk starts — so a second ask
   * inside the same chunk is overwritten before the model ever sees it. Recording the chunk is what
   * makes that checkable from a run rather than from the design.
   */
  chunk?: number;
  /**
   * True when the ask went out mid-chunk on the priority deadline rather than at a boundary.
   *
   * The deadline is the one sanctioned way two asks land in one chunk: the earlier one is
   * overwritten before the model reads it, in exchange for a play event that may not be dropped. An
   * audit that counts asks per chunk needs to tell that trade-off from a gate that failed.
   */
  deadline?: boolean;
  /** Set once the model has accepted it. */
  ok?: boolean;
  /** Set when it was never sent, and why. */
  dropped?: string;
  error?: string;
};

const MAX_RECORDS = 120;

declare global {
  interface Window {
    __orbisPrompts?: PromptRecord[];
  }
}

function journal(): PromptRecord[] | undefined {
  if (!import.meta.env.DEV) return undefined;
  return (window.__orbisPrompts ??= []);
}

export function recordPrompt(record: Omit<PromptRecord, "at">): PromptRecord | undefined {
  const entries = journal();
  if (!entries) return undefined;

  const entry: PromptRecord = { at: Date.now(), ...record };
  entries.push(entry);
  if (entries.length > MAX_RECORDS) entries.splice(0, entries.length - MAX_RECORDS);
  return entry;
}

export function settlePrompt(entry: PromptRecord | undefined, outcome: { ok: true } | { error: string }): void {
  if (!entry) return;
  if ("ok" in outcome) {
    entry.ok = true;
    return;
  }
  entry.error = outcome.error;
}
