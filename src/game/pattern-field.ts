import type { Environment } from "./run-state";

/**
 * The content field: what the runner meets and what it collects.
 *
 * Kept free of three.js and React on purpose. The rules here decide whether a run is fair — how far
 * apart hazards arrive, which trick each one asks for, where the coins sit — so they are the part
 * worth simulating: `tools/run-audit.mjs` imports this module and measures thousands of metres of
 * it, rather than those rules living inside the scene component where they can only be eyeballed.
 */

export const LANES = [-2.4, 0, 2.4] as const;
export const LANE_COUNT = LANES.length;

export type ObstacleKind = "block" | "gate" | "wall";

export type ObstacleSpawn = { lane: number; z: number; kind: ObstacleKind; passed: boolean };
export type CoinSpawn = { lane: number; z: number; y: number; collected: boolean };

/**
 * The three things a run can pick up, and the three verbs they carry.
 *
 * A run already has one verb (dodge) with three shapes; the pickups each add a different one rather
 * than a bigger number: `shield` survives a mistake, `magnet` collects what you did not drive through,
 * `double` makes what you did collect worth more. They are also the only pickups that are not a reward
 * for a move — a coin pays for reading a pattern, a pickup changes what the next pattern costs.
 */
export type PowerupKind = "shield" | "magnet" | "double";

export type PowerupSpawn = {
  lane: number;
  z: number;
  kind: PowerupKind;
  collected: boolean;
};

/** Every pickup, for the audit and for the spawner's own choice. */
export const POWERUP_KINDS: PowerupKind[] = ["shield", "magnet", "double"];

export type Pattern = {
  obstacles: ObstacleSpawn[];
  coins: CoinSpawn[];
  powerups: PowerupSpawn[];
  /** Distance the pattern occupies, including the space after its last piece. */
  span: number;
  /** Which shape produced this chunk. Carried so the audit can attribute tight windows to it. */
  shape: Shape;
  /**
   * Whether this chunk guarantees the runner has to do something. See `isDemanding`.
   */
  demanding: boolean;
  /** Empty distance between the last piece here and the end of the pattern. */
  tail: number;
  /**
   * Where this chunk's last row most plausibly leaves the runner, when the chunk can tell at all.
   *
   * A claim about the player made from the chunk's own geometry: a `pair` leaves exactly one lane, a
   * block or a gate is passed in place, and a chunk that can be survived without moving has nothing to
   * say. Nothing consumes it — it was built to steer the next chunk's `pair` and that steered the run
   * *worse* (see the audit report), so it is kept as a claim the harness measures rather than as an
   * input, and the measurement is 40%: the content does not know where the runner is.
   */
  heldLane?: number;
};

/**
 * Which tricks each world asks for, and how tightly its content is spaced.
 *
 * `gapScale` is the distance half of a world's identity and it trades against its speed on purpose:
 * the desert runs fastest and leaves the most room, the city runs slowest and crowds the most, so the
 * two arrive at similar windows in *time* from opposite directions. The forest sits between them and
 * spends its difference on the length of its ramp instead.
 */
export const environmentRecipe: Record<Environment, { kinds: ObstacleKind[]; gapScale: number }> = {
  desert: { kinds: ["block", "block", "gate", "wall"], gapScale: 1.08 },
  city: { kinds: ["gate", "block", "wall", "gate"], gapScale: 0.78 },
  forest: { kinds: ["block", "gate", "block", "wall"], gapScale: 0.96 },
};

/**
 * What the player is assumed to be able to do. The content's own safety margin is stricter than the
 * `tools/run-audit.mjs` model on purpose, so the content passes for a slower player than the model's.
 */
export const REACTION_S = 0.35;
export const LANE_CHANGE_S = 0.5;
export const ESCAPE_S = REACTION_S + LANE_CHANGE_S + 0.1;

export type EnvironmentPace = {
  /** Speed at the start line. */
  baseSpeed: number;
  /** Speed the ramp adds by the end of it. */
  speedGain: number;
  /** Distance over which the ramp completes. */
  speedRampMeters: number;
  /** Distance at which this world's content peaks. */
  difficultyMeters: number;
};

/**
 * How each world runs: the shape of its speed ramp and how soon its content peaks.
 *
 * The three worlds are the same mechanics at different tempos rather than the same run repainted,
 * and the trade runs opposite ways on purpose. The desert is the fastest and the emptiest — long,
 * open, quick. The city is the slowest and the densest: its gaps are already 0.86 of the others' and
 * its content peaks soonest, so it is crowded almost from the start. The forest ramps slowest and
 * holds its top speed back, so a forest run keeps tightening for longer.
 */
export const environmentPace: Record<Environment, EnvironmentPace> = {
  desert: { baseSpeed: 8.6, speedGain: 8.4, speedRampMeters: 320, difficultyMeters: 820 },
  city: { baseSpeed: 7.4, speedGain: 6.6, speedRampMeters: 260, difficultyMeters: 520 },
  forest: { baseSpeed: 7.8, speedGain: 7.4, speedRampMeters: 520, difficultyMeters: 700 },
};

/** Speed at a distance into the run, including the ramp. */
export function speedAt(environment: Environment, distance: number): number {
  const pace = environmentPace[environment];
  return pace.baseSpeed + Math.min(distance / pace.speedRampMeters, 1) * pace.speedGain;
}

/** Top speed a world reaches. */
export function topSpeed(environment: Environment): number {
  const pace = environmentPace[environment];
  return pace.baseSpeed + pace.speedGain;
}

/**
 * The fastest any world runs. Rules that must hold at every speed — the coin escape distance — are
 * keyed to this rather than to one world's pace.
 */
export const FASTEST_SPEED = Math.max(
  ...Object.values(environmentPace).map((pace) => pace.baseSpeed + pace.speedGain),
);

/**
 * The escape window in metres, taken at the fastest speed any world reaches rather than at the world
 * in hand, so it stays generous in all three: 17 m/s × 0.95 s ≈ 16 m, roughly one obstacle spacing.
 */
export const ESCAPE_DISTANCE = FASTEST_SPEED * ESCAPE_S;

/**
 * The empty road a run opens on, in metres, measured from the runner to the first hazard row.
 *
 * The field used to open with its first chunk already inside the runner's reaction window: the
 * nearest row could be nine metres away, which at the launch's pace is under a second, and a `pair`
 * or a wall sitting there asks for a lane change the player has not been given the time to read —
 * the first thing a run taught was that it could not be played. The first chunk is laid this far
 * past the line instead, so the opening stretch is empty by construction rather than by luck.
 *
 * One number covers both ways a run can start: a fresh run and "Run again" are the same remount of
 * the simulation, so the clearance is applied at every line.
 *
 * Three escape windows rather than two: at two, the first row was met 3.3–3.8 s in, which still
 * played as the content arriving on top of the player. At three, the first row is met 5.0 s into a
 * desert run and 5.6–5.8 s into a forest or city one — simulated at 60 Hz against `speedAt` plus the
 * `LAUNCH_BOOST` decay in `src/game/RunnerScene.tsx`, which is the speed model the run itself uses.
 * Metres rather than seconds because the surge makes the opening the fastest stretch of the run, so
 * the clearance is bought at that pace rather than at cruise.
 */
export const START_CLEARANCE = ESCAPE_DISTANCE * 3;

/** Difficulty at a distance into the run: 0 at the line, 1 once that world's content peaks. */
export function difficultyAt(environment: Environment, distance: number): number {
  return Math.min(1, distance / environmentPace[environment].difficultyMeters);
}

/** What a token is worth at the start line. */
export const COIN_VALUE_BASE = 25;
/**
 * How much more a token is worth once a world's difficulty peaks. Three times the opening value, so
 * the back half of a run pays clearly better rather than marginally.
 */
export const COIN_VALUE_PEAK_MULTIPLIER = 3;

/**
 * What one token pays at a distance into the run.
 *
 * Coin *density* is deliberately flat — the audit measures 11–15 tokens per 100 m in every band, from
 * the line to 1400 m — so without this the reward per metre would not rise at all while the speed and
 * the obstacle mix do. That left no reason to take a risk later: the content asked for more at 800 m
 * than at 100 m and paid exactly the same. Scaling the value with difficulty gives the curve a reward
 * side, so depth is worth reaching and a risky line late is worth taking.
 *
 * It is a multiplier rather than a bigger number of coins so the *fairness* work stays untouched:
 * `tools/run-audit.mjs` measures coin placement, and placement is unchanged.
 */
export function coinMultiplierAt(environment: Environment, distance: number): number {
  return 1 + (COIN_VALUE_PEAK_MULTIPLIER - 1) * difficultyAt(environment, distance);
}

/** What one token pays at a distance into the run, in points. */
export function coinValueAt(environment: Environment, distance: number): number {
  return Math.round(COIN_VALUE_BASE * coinMultiplierAt(environment, distance));
}

/**
 * Whether a pattern guarantees the runner has to do something.
 *
 * A wall cannot be passed in place, and a row that blocks two lanes leaves only one. Everything else
 * can be survived by standing still in a lane nobody blocked — which is what the audit counts as a
 * free row, and where the run's dead air comes from. This is an intrinsic property of the content,
 * decided when it is built, because the alternative (asking whether the *player* was threatened)
 * depends on a lane the generator does not know.
 */
function isDemanding(obstacles: readonly ObstacleSpawn[]): boolean {
  if (obstacles.some((obstacle) => obstacle.kind === "wall")) return true;
  const perRow = new Map<number, number>();
  for (const obstacle of obstacles) perRow.set(obstacle.z, (perRow.get(obstacle.z) ?? 0) + 1);
  return [...perRow.values()].some((count) => count >= 2);
}

/**
 * How much closer the next pattern may come after one that asked for nothing. The audit measures the
 * result: time between rows that actually demand a move.
 */
const SOFT_GAP_SCALE = 0.62;
/**
 * The floor under a soft gap: one lane change at the fastest speed any world reaches, so a pacing
 * change can never turn into a row a lane change does not fit inside.
 */
const SOFT_GAP_FLOOR = Math.max(9, FASTEST_SPEED * LANE_CHANGE_S);

/**
 * How many lanes a row can ask the runner to cross at once.
 *
 * One, for every row that holds a single obstacle: a lane is only ever walled off by a `wall`, so a
 * row with one obstacle in it can never take the runner's own lane *and* the lane next to it, and
 * the nearest lane that is still open is always one step away. Two lanes can only be closed at once
 * by a row with two obstacles in it, which is `pair` and nothing else.
 *
 * `tools/run-audit.mjs` reports the shape behind every two-lane read, and this has to keep matching
 * what it finds.
 */
const LANES_A_TWO_LANE_ROW_TAKES = 2;

/**
 * The lead-in a chunk that can ask for two lane changes needs.
 *
 * Every other floor in this file is built to one lane change (`ESCAPE_S`), and the full gap is sized
 * to land on it. A row that can ask for two was held to that same single-change floor, so a player
 * standing at the far end of it was being asked to read the row and cross two lanes in the time the
 * content gives for one. The audit's model is looser about what a lane change costs and calls those
 * rows legal; the content's own cost is stricter, and it is the one the rest of this file is built
 * to, so the floor is the content's cost of the crossing rather than the model's.
 *
 * With `pair` capped at one wall nothing can ask for two any more, so this floor should never bind.
 * It is kept because the *reason* the rows were unfair is a property of the floor, not of the shape:
 * any future row that can close two lanes gets the right lead-in by existing, and the harness reports
 * the two-lane rows it finds, so a regression shows up as a number rather than as a lost run.
 */
const TWO_LANE_LEAD_IN = FASTEST_SPEED * (REACTION_S + LANES_A_TWO_LANE_ROW_TAKES * LANE_CHANGE_S);

/**
 * Whether a chunk of this shape can close two lanes at once. Only `pair` ever could, and it is built
 * with at most one wall now, so **nothing does**. This is kept as a guard rather than deleted: it is
 * the invariant that a future two-obstacle shape has to satisfy, and `tools/run-audit.mjs` reports the
 * two-lane rows it finds, so the guard being unnecessary is a measurement rather than an assumption.
 */
function canAskTwoLaneChanges(shape: Shape): boolean {
  return shape === "pair";
}

/**
 * Distance allowed between one pattern's end and the next pattern's content.
 *
 * A pattern that asked for nothing can be followed more closely: the runner was already in a free
 * lane with nothing to read, so the wait for the next decision is dead air. A pattern that did ask
 * for something keeps the full gap, so a real decision is still followed by breathing room.
 *
 * Two clauses then hold the gap open from *below*, and both are measured from the end of the pattern
 * just placed (`previous.tail`), because the window the player actually gets is that empty space plus
 * this gap:
 *
 *   - a pattern's coins must not end up inside the escape window of the next pattern's first hazard,
 *     which is what stops the pacing change from turning into a trap;
 *   - a chunk that can ask for two lane changes gets the lead-in those two changes cost, which is
 *     longer than the one-change floor everything else is built to.
 *
 * The second is why `next` exists at all: the gap after a chunk is decided before the following one
 * is built, so the caller has to say which shape is coming.
 */
export function patternGap(
  environment: Environment,
  difficulty: number,
  previous?: Pick<Pattern, "demanding" | "tail">,
  next?: Shape,
): number {
  const eased = 24 + (13 - 24) * Math.min(1, Math.max(0, difficulty));
  const full = eased * environmentRecipe[environment].gapScale;
  const soft = Math.max(SOFT_GAP_FLOOR, full * SOFT_GAP_SCALE);
  const wanted = previous && !previous.demanding ? soft : full;
  if (!previous) return wanted;
  const floor = next && canAskTwoLaneChanges(next) ? TWO_LANE_LEAD_IN : ESCAPE_DISTANCE;
  return Math.max(wanted, floor - previous.tail);
}

/** Walls are the only unavoidable obstacle, so they arrive later and stay rarer. */
export const WALL_FROM_DIFFICULTY = 0.18;

/** Turns in a slalom. */
const TURNS = 3;
/**
 * Distance between a slalom's turns.
 *
 * At 11 m this was the tightest read in the game — 0.65 s at the desert's top speed, against the
 * 0.5 s a lane change costs by the model's own reckoning, which leaves a player who reacts late
 * nothing at all. 16 m makes it ~0.94 s at that speed and over a second in the slower worlds, which
 * is still a weave and no longer a twitch.
 */
const SLALOM_STEP = 16;

/**
 * Distance between a gauntlet's three demands (jump, then slide, then dodge) and between a tunnel's
 * gate and the obstacle after it.
 *
 * The same floor as the slalom: a row arriving 12 m after the one before it is 0.70 s at the desert's
 * top speed, which is only 0.2 s of margin over a lane change. Widening the slalom alone would have
 * moved the tightest read here rather than removing it.
 */
const GAUNTLET_STEP = 15;
const TUNNEL_STEP = 16;

/** Which tricks each world asks for, and how tightly its content is spaced. */
export type Shape = "single" | "pair" | "slalom" | "tunnel" | "gauntlet" | "arc";

/**
 * The shape mix at each stage of a run, with repetition as the weight.
 *
 * A `slalom` is three rows and a `gauntlet` three more, so one slot of either is worth three slots of
 * a `single` in *rows* — which is the measure that matters, because the audit counts decision rows.
 * Weighting by repetition makes that easy to get wrong by eye, so the row each shape contributes is
 * spelled out in the comment beside it, and `tools/run-audit.mjs` reports the share that results.
 *
 * `slalom` is deliberately the lightest of the multi-row shapes: its turns used to be 11 m apart,
 * which at the desert's top speed is a 0.65 s read — the tightest thing in the game — so it is both
 * wider now (see `SLALOM_STEP`) and rarer. `single` still opens a run because a lone obstacle is how
 * the game introduces its first jump; it is only a lone obstacle in a lane nobody blocked that asks
 * for nothing, and the late mix leans on `pair` (which leaves one lane) and `gauntlet` (which always
 * carries a wall) to keep the run making decisions.
 */
export const SHAPES_EARLY: Shape[] = [
  "single", // 1 row
  "single",
  "single",
  "tunnel", // 1 row
  "tunnel",
  "arc", // 1 row
];
export const SHAPES_FULL: Shape[] = [
  "single", // 1 row
  "single",
  "pair", // 1 row
  "pair",
  "pair",
  "tunnel", // 1 row
  "tunnel",
  "gauntlet", // 3 rows
  "gauntlet",
  "arc", // 1 row
  "slalom", // 3 rows
];
export const SHAPES_LATE: Shape[] = [
  "pair", // 1 row
  "pair",
  "pair",
  "pair",
  "pair",
  "pair",
  "pair",
  "gauntlet", // 3 rows
  "gauntlet",
  "gauntlet",
  "tunnel", // 1 row
  "arc", // 1 row
  "slalom", // 3 rows
  "single", // 1 row
];
const LATE_FROM_DIFFICULTY = 0.5;

/** The shape mix in force at a difficulty. */
export function shapeMix(difficulty: number): Shape[] {
  return difficulty < WALL_FROM_DIFFICULTY
    ? SHAPES_EARLY
    : difficulty < LATE_FROM_DIFFICULTY
      ? SHAPES_FULL
      : SHAPES_LATE;
}

/**
 * Picks the next chunk's shape.
 *
 * Exported because the shape has to be known *before* the chunk is placed: the gap the previous
 * chunk leaves is sized by the lead-in this one will need, and that gap is what decides where this
 * one lands. `buildPattern` takes the shape back so the two can never disagree about it.
 */
export function pickShape(difficulty: number): Shape {
  const shapes = shapeMix(difficulty);
  return shapes[Math.floor(Math.random() * shapes.length)];
}

const randomLane = () => Math.floor(Math.random() * LANE_COUNT);
const otherLane = (lane: number) => (lane + 1 + Math.floor(Math.random() * (LANE_COUNT - 1))) % LANE_COUNT;

/**
 * A kind that is not a wall, for the two places where a wall would be the wrong answer: before walls
 * are introduced at all, and for a row that already carries one (see the `pair` shape).
 */
function kindWithoutWall(environment: Environment): ObstacleKind {
  const withoutWalls = environmentRecipe[environment].kinds.filter((kind) => kind !== "wall");
  return withoutWalls[Math.floor(Math.random() * withoutWalls.length)];
}

export function kindFor(environment: Environment, difficulty: number): ObstacleKind {
  const kinds = environmentRecipe[environment].kinds;
  if (difficulty < WALL_FROM_DIFFICULTY && kinds.includes("wall")) {
    return kindWithoutWall(environment);
  }
  return kinds[Math.floor(Math.random() * kinds.length)];
}

export function coinLine(lane: number, startZ: number, count: number, y = 1.05): CoinSpawn[] {
  return Array.from({ length: count }, (_, index) => ({
    lane,
    z: startZ - index * 2.6,
    y,
    collected: false,
  }));
}

export function coinArc(lane: number, z: number): CoinSpawn[] {
  return Array.from({ length: 5 }, (_, index) => {
    const t = index / 4;
    return { lane, z: z + 1.4 - t * 2.8, y: 1.05 + Math.sin(t * Math.PI) * 1.15, collected: false };
  });
}

const COIN_SPACING = 2.6;

/**
 * Which lanes a coin line may sit in.
 *
 * Only a **wall** disqualifies its lane: it is the one obstacle that cannot be passed in place, so
 * coins sitting where a wall will arrive are a lure — the player takes them and then has less than
 * an escape window to get out. A block or a gate is passable, so a coin line beside one is exactly
 * what we want: it pays for the jump or the slide the obstacle already asked for.
 *
 * The window is symmetric around the coins, which covers both failure modes the audit measures: a
 * wall arriving just after the coins (the trap) and a wall arriving just before them (coins that
 * cannot be reached at all).
 */
function coinLanes(
  hazards: readonly ObstacleSpawn[],
  startZ: number,
  length: number,
): number[] {
  const nearest = startZ + ESCAPE_DISTANCE;
  const furthest = startZ - length - ESCAPE_DISTANCE;
  return Array.from({ length: LANE_COUNT }, (_, lane) => lane).filter((lane) =>
    hazards.every(
      (hazard) =>
        hazard.lane !== lane ||
        hazard.kind !== "wall" ||
        hazard.z > nearest ||
        hazard.z < furthest,
    ),
  );
}

/**
 * Picks the lane for a coin line, preferring the lane the required move leads into and falling back
 * to any lane no wall will cross. Returns undefined when every lane is spoken for, in which case the
 * pattern simply carries no coins rather than carrying a trap.
 */
function pickCoinLane(
  hazards: readonly ObstacleSpawn[],
  startZ: number,
  length: number,
  preferred?: number,
): number | undefined {
  const lanes = coinLanes(hazards, startZ, length);
  if (lanes.length === 0) return undefined;
  if (preferred !== undefined && lanes.includes(preferred)) return preferred;
  return lanes[Math.floor(Math.random() * lanes.length)];
}

/**
 * Builds one chunk of content at `startZ`. Each world favours different tricks, and the mix
 * hardens as the run goes on: single obstacles become pairs, gaps tighten, and gauntlets
 * start asking for a jump, a slide, and a dodge in quick succession.
 *
 * The obstacles of a shape come first and the coins come after, because a coin is placed in a lane
 * the move *leaves the runner in* and that can only be decided once the hazards are known. The
 * reward is shaped by the move as well: an arc for a jump, a low line for a slide, a line in the
 * destination lane for a dodge. A lane no coin may use is simply left empty — a pattern with fewer
 * coins is better than one with a trap.
 *
 * One invariant lives outside this function: a pattern ends at least an escape window before the
 * next pattern's first obstacle (`span` plus `patternGap`), so a wall in the following chunk cannot
 * trap the coins at the end of this one. `tools/run-audit.mjs` measures the whole run and would
 * report it if a tuning change ever broke that.
 */
export function buildPattern(
  environment: Environment,
  difficulty: number,
  startZ: number,
  /** The shape to build. Defaults to a fresh pick, so a caller that does not care can ignore it. */
  shape: Shape = pickShape(difficulty),
  /**
   * Whether this chunk carries a pickup. Asked for by the run rather than rolled here: the spacing
   * between pickups is a property of the run (metres travelled), and a chunk does not know where in
   * the run it is being laid.
   */
  wantsPowerup = false,
): Pattern {
  const obstacles: ObstacleSpawn[] = [];
  const coins: CoinSpawn[] = [];
  const powerups: PowerupSpawn[] = [];
  let heldLane: number | undefined;
  let span = 24;

  /** A ground line in the safest available lane, preferring the one the move reaches. */
  const place = (preferred: number | undefined, z: number, count: number, y = 1.05) => {
    const lane = pickCoinLane(obstacles, z, (count - 1) * COIN_SPACING, preferred);
    if (lane !== undefined) coins.push(...coinLine(lane, z, count, y));
  };

  /** A jump arc, which stays in the lane of the block it clears. */
  const placeArc = (lane: number, z: number) => {
    if (coinLanes(obstacles, z + 1.4, 2.8).includes(lane)) coins.push(...coinArc(lane, z));
  };

  if (shape === "single") {
    const lane = randomLane();
    const kind = kindFor(environment, difficulty);
    obstacles.push({ lane, z: startZ, kind, passed: false });
    if (kind === "block") placeArc(lane, startZ);
    else if (kind === "gate") place(lane, startZ - 1.2, 4, 0.9);
    else place(otherLane(lane), startZ - 3, 4);
    // A block or a gate is passed in place, so the runner is still in that lane. A wall sends them
    // somewhere else, and the chunk has no business claiming to know where.
    if (kind !== "wall") heldLane = lane;
    span = 22;
  }

  if (shape === "pair") {
    const free = randomLane();
    // At most one wall per row. A wall is the only obstacle that cannot be passed in place, so a row
    // that walls off *two* lanes leaves exactly one, and a runner at the far end of it needs two lane
    // changes at once — the tightest read the game can ask for. One wall is enough to keep the row
    // unavoidable: the runner is still standing in one of the two blocked lanes two times in three.
    //
    // The other way to kill the two-lane read is to prefer the *middle* as the open lane, and it
    // costs more than it looks: a pair that opens the middle asks a runner already there for nothing
    // at all, and the harness's route holds the middle by default — so the decisions this shape exists
    // for would quietly disappear, which is exactly the dead air the field has already paid to close.
    let walls = 0;
    for (let lane = 0; lane < LANE_COUNT; lane += 1) {
      if (lane === free) continue;
      let kind = kindFor(environment, difficulty);
      if (kind === "wall" && walls === 1) kind = kindWithoutWall(environment);
      if (kind === "wall") walls += 1;
      obstacles.push({ lane, z: startZ, kind, passed: false });
    }
    // The reward sits in the one lane the pair leaves open.
    place(free, startZ - 3.4, 4);
    // The runner ends up in the lane the row left open; there is only one.
    heldLane = free;
    span = 24;
  }

  if (shape === "slalom") {
    const turn: number[] = [];
    let lane = randomLane();
    for (let step = 0; step < TURNS; step += 1) {
      turn.push(lane);
      obstacles.push({
        lane,
        z: startZ - step * SLALOM_STEP,
        kind: kindFor(environment, difficulty),
        passed: false,
      });
      lane = lane === 0 ? LANE_COUNT - 1 : lane - 1;
    }
    for (let step = 0; step < TURNS; step += 1) {
      // A slalom leaves one lane open across *two* turns: the one the next obstacle is not in. Coins
      // sit there, so they pay for reading the slalom correctly and never for arriving in a lane
      // that is about to close. If that lane is unavailable the lane check decides instead.
      const hold = Array.from({ length: LANE_COUNT }, (_, lane) => lane).find(
        (lane) => lane !== turn[step] && lane !== turn[step + 1],
      );
      place(hold ?? otherLane(turn[step]), startZ - step * SLALOM_STEP - 4, 3);
    }
    // Covers the coins past the last turn plus the tail the shape had before, so widening the turns
    // does not move the gap floor the next chunk is held to.
    span = (TURNS - 1) * SLALOM_STEP + 4 + 2 * COIN_SPACING + 6.8;
  }

  if (shape === "tunnel") {
    const lane = randomLane();
    obstacles.push({ lane, z: startZ, kind: "gate", passed: false });
    if (difficulty > 0.3) {
      obstacles.push({
        lane: otherLane(lane),
        z: startZ - TUNNEL_STEP,
        kind: kindFor(environment, difficulty),
        passed: false,
      });
    }
    // Rewards for sliding: the payoff sits under the bar, in the lane the gate already asks for.
    place(lane, startZ - 1.2, 4, 0.9);
    // The gate is slid under in place and the obstacle past it sits in another lane, so the runner is
    // most likely still in the gate's lane.
    heldLane = lane;
    span = difficulty > 0.3 ? 28 : 18;
  }

  if (shape === "gauntlet") {
    const jumpLane = randomLane();
    const slideLane = otherLane(jumpLane);
    const wallLane = otherLane(slideLane);
    obstacles.push({ lane: jumpLane, z: startZ, kind: "block", passed: false });
    obstacles.push({ lane: slideLane, z: startZ - GAUNTLET_STEP, kind: "gate", passed: false });
    obstacles.push({ lane: wallLane, z: startZ - 2 * GAUNTLET_STEP, kind: "wall", passed: false });
    // One reward per move, in the lane that move leaves the runner in.
    placeArc(jumpLane, startZ);
    place(slideLane, startZ - GAUNTLET_STEP - 1.2, 3, 0.9);
    place(otherLane(wallLane), startZ - 2 * GAUNTLET_STEP - 2, 3);
    // Same tail as the other multi-row shapes, so the gap floor after it is unchanged.
    span = 2 * GAUNTLET_STEP + 2 + 2 * COIN_SPACING + 6.8;
  }

  if (shape === "arc") {
    const lane = randomLane();
    obstacles.push({ lane, z: startZ, kind: "block", passed: false });
    placeArc(lane, startZ);
    heldLane = lane;
    span = 22;
  }

  /**
   * The pickup, if this chunk carries one.
   *
   * Placed after the shape is built, so it can be put in a lane the shape leaves clear, and at the
   * end of the chunk rather than in the middle of it: a reward that has to be taken *while* reading
   * a pattern is a second decision layered on the first, and the first one is the game. Preferring
   * `heldLane` means the pickup is usually the lane the move already sent the runner to, so taking it
   * costs nothing — it is a gift for playing well, not a dare.
   *
   * Four metres before the pattern's end: inside this chunk's own territory, so it can never land on
   * the next chunk's first obstacle, no matter how tight `patternGap` gets.
   */
  if (wantsPowerup) {
    const z = startZ - span + 4;
    const lane = pickCoinLane(obstacles, z, 0, heldLane);
    if (lane !== undefined) {
      const kind = POWERUP_KINDS[Math.floor(Math.random() * POWERUP_KINDS.length)];
      powerups.push({ lane, z, kind, collected: false });
    }
  }

  // The empty space inside the pattern, measured from its last piece rather than assumed: the gap
  // that follows is allowed to close to just outside the escape window of *these* coins.
  const lastPiece = Math.min(
    ...obstacles.map((obstacle) => obstacle.z),
    ...coins.map((coin) => coin.z),
    ...powerups.map((powerup) => powerup.z),
  );
  const tail = Number.isFinite(lastPiece) ? Math.max(0, lastPiece - (startZ - span)) : span;

  return {
    obstacles,
    coins,
    powerups,
    span,
    shape,
    demanding: isDemanding(obstacles),
    tail,
    heldLane,
  };
}

/**
 * The move each obstacle asks for, in the lane it sits in: a jump-over, a slide-under, or a lane
 * change (which is the only way past a wall).
 */
export const requiredMove: Record<ObstacleKind, "jump" | "slide" | "dodge"> = {
  block: "jump",
  gate: "slide",
  wall: "dodge",
};
