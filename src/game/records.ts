import type { Environment } from "./run-state";

/**
 * The best run the player has had in each world.
 *
 * Kept per world rather than as one number, because the three worlds are not comparable: they have
 * different paces, different obstacle recipes and — the part that decides it — different token curves
 * (`environmentPace[world].difficultyMeters`). A single global best would be the desert's by
 * construction and would quietly tell a player their forest runs do not count.
 *
 * It is the whole point of giving the run an end. Without a fail state a score is a receipt; with one
 * it is a target, and the target has to survive the tab being closed.
 *
 * `localStorage`, not IndexedDB: this is three small records, not a picture. Everything is validated
 * on read and written best-effort, so a blocked or hand-edited store costs the player a target rather
 * than a working game.
 */

/**
 * How often a run writes down where it was: one sample every 20 m.
 *
 * Every 20 m is the resolution a *line* needs and no more: at the forest's 14 m/s a sample is about
 * 1.4 s of running, which is finer than a lane change (the fastest thing the line can describe) and
 * coarse enough that a 2 km run is 100 samples. Stored as flat quads rather than objects because
 * `localStorage` is strings either way and the flat form is a third of the size.
 */
export const LINE_METRES = 20;

/** The most line a record may carry: 5 km, which is past anything the three worlds allow. */
const LINE_LIMIT = 1000;

export type RunSummary = {
  /** Gaps threaded between two obstacles: the run's best *moves*, kept with its best numbers. */
  threads: number;
  score: number;
  distance: number;
  tokens: number;
  /**
   * Where the run actually went, as flat quads of `distance, lane, score, time` every `LINE_METRES`.
   *
   * The numbers alone cannot describe a run to run *against*: a best of 1,800 m says what happened,
   * not how. The line is what makes the ghost possible — the lane the best run held at the metre the
   * player is at now, and the distance it had reached at the same second.
   */
  line: number[];
};

/** One read of a best line: the lane it held at a distance, and the run's score by then. */
export type GhostSample = { lane: number; score: number };

export type BestRun = RunSummary & {
  /** When it was set, in `Date.now()` terms, so a record can say how old it is. */
  at: number;
};

const STORAGE_KEY = "watchme-run:records";

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * A stored line, read back as quads — or as nothing.
 *
 * A line is all-or-nothing on purpose: half a line would put the ghost in lanes the best run never
 * held, and a ghost that lies about the line is worse than no ghost at all. A record with no line (any
 * record written before the ghost existed) is an ordinary best with nothing to run against.
 */
function line(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 8 || value.length % 4 !== 0) return [];
  const flat = value.slice(0, LINE_LIMIT).map((entry) => (Number.isFinite(entry) ? Number(entry) : NaN));
  if (flat.some((entry) => Number.isNaN(entry))) return [];
  return flat;
}

function record(value: unknown): BestRun | undefined {
  if (!value || typeof value !== "object") return undefined;
  const stored = value as Partial<BestRun>;
  // A record with no score is not a record: it is a half-written entry, and reporting it as a best
  // would make the first run of a fresh visit look like it beat something.
  if (!finite(stored.score)) return undefined;
  return {
    score: finite(stored.score),
    distance: finite(stored.distance),
    tokens: finite(stored.tokens),
    // Records written before gaps were counted read as none: a missing field is an old record, not a
    // broken one, and inventing a number for it would be inventing a best.
    threads: finite(stored.threads),
    line: line(stored.line),
    at: finite(stored.at),
  };
}

export function readRecords(): Partial<Record<Environment, BestRun>> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const stored = JSON.parse(raw) as Record<string, unknown>;
    return {
      desert: record(stored.desert),
      city: record(stored.city),
      forest: record(stored.forest),
    };
  } catch {
    return {};
  }
}

/** The best for one world, for the menu and the run-end card. */
export function bestFor(environment: Environment): BestRun | undefined {
  return readRecords()[environment];
}

/**
 * The lane the best line held at a distance, and the score the best run had by then.
 *
 * The sample at or before the distance wins rather than an interpolation between the two: a lane is
 * not a number that can be averaged — halfway between the middle and the left lane is the edge of
 * another obstacle — so the ghost holds the lane the best run actually held, and steps when it steps.
 * Past the end of the line there is nothing to say, and the ghost goes quiet rather than guessing.
 */
export function ghostAt(best: RunSummary | undefined, distance: number): GhostSample | undefined {
  const flat = best?.line;
  if (!flat || flat.length < 4 || distance < flat[0]) return undefined;
  let index = 0;
  for (let at = 4; at < flat.length; at += 4) {
    if (flat[at] > distance) break;
    index = at;
  }
  if (index + 3 >= flat.length) return undefined;
  return { lane: flat[index + 1], score: flat[index + 2] };
}

/**
 * How far ahead of the best run this one is, in metres, at the same number of seconds in.
 *
 * This is the ghost race rather than the ghost line: the best run reached a distance by an elapsed
 * time, and the answer is how much further this run has got by that same time. Positive is ahead.
 * Read from the same quads, walking the line's times, so `ghost_at` and `ghost_ahead` can never
 * disagree about where the best run was.
 */
export function ghostAhead(best: RunSummary | undefined, distance: number, time: number): number | undefined {
  const flat = best?.line;
  if (!flat || flat.length < 8) return undefined;
  const last = flat.length - 4;
  // Past the end of the line: the best run was over by now, so a run still going is ahead of it.
  if (time >= flat[last + 3]) return distance - flat[last];
  let index = 0;
  for (let at = 4; at < flat.length; at += 4) {
    if (flat[at + 3] > time) break;
    index = at;
  }
  if (index + 3 >= flat.length) return distance - flat[last];
  const metre = flat[index];
  const seconds = flat[index + 3];
  const nextMetre = flat[index + 4] ?? metre;
  const nextSeconds = flat[index + 7] ?? seconds;
  const span = nextSeconds - seconds;
  const reached = span > 0 ? metre + ((nextMetre - metre) * (time - seconds)) / span : metre;
  return distance - reached;
}

/**
 * Files a finished run and answers whether it beat the one before it.
 *
 * Returns the record that now stands either way, because the run-end card shows both numbers: the
 * score just achieved and the one to beat. `improved` is false for the first run of a world too — a
 * first run sets the record, it does not beat one, and saying "new best" over the only score on the
 * board is exactly the kind of small lie that makes the number meaningless.
 */
export function fileRun(
  environment: Environment,
  summary: RunSummary,
): { best: BestRun; previous?: BestRun; improved: boolean } {
  const previous = readRecords()[environment];
  const improved = Boolean(previous && summary.score > previous.score);
  if (previous && !improved) return { best: previous, previous, improved };

  const next: BestRun = {
    score: summary.score,
    distance: summary.distance,
    tokens: summary.tokens,
    threads: summary.threads,
    line: summary.line.slice(0, LINE_LIMIT),
    at: Date.now(),
  };
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...readRecords(), [environment]: next }),
    );
  } catch {
    // A blocked store means the run is not remembered; the run itself is unaffected.
  }
  // `previous` travels with the record because the card reports both numbers: the score just filed and
  // the one it took the record from.
  return { best: next, previous, improved };
}
