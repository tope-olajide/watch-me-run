// Playthrough audit for the run loop: simulates the real content field (`src/game/pattern-field.ts`)
// through the real speed ramp and difficulty curve, then measures what a player is actually asked
// to do — reaction windows, forced lane changes, coin reachability, and how the pressure builds.
//
//   node tools/run-audit.mjs [runs] [metres]
//
// The field is bundled with esbuild (already a Vite dependency) so the audit exercises the same
// code the game does, not a copy of it.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const temp = join(root, "node_modules", ".cache", "run-audit");
const bundlePath = join(temp, "field.mjs");

mkdirSync(temp, { recursive: true });
await build({
  entryPoints: [join(root, "src", "game", "pattern-field.ts")],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "neutral",
});

const field = await import(`file://${bundlePath.replace(/\\/g, "/")}`);

/* ------------------------------------------------------------------ game constants */

/** Mirrors src/game/RunnerScene.tsx: these are gameplay facts, not tuning knobs. */
const SPAWN_HORIZON = 80;
const PLAYER_Z = 3;
const FRONTIER_START = -6;
// The pace and difficulty curves now come from the field itself rather than being copied here: each
// world has its own speed ramp, and a duplicate would silently measure the wrong game.
const { speedAt, difficultyAt, topSpeed, environmentPace } = field;
/** How long the runner is committed to a move, and how long a lane change costs. */
const JUMP_S = 0.65;
const SLIDE_S = 0.8;
const LANE_CHANGE_S = 0.28;
/** Read-and-react floor: below this, a hazard is asking for reflex, not attention. */
const REACTION_S = 0.22;
const FAIR_WINDOW_S = 0.35;
/** Coins above this are only collected airborne, so they need a jump. */
const AIRBORNE_COIN_Y = 1.7;

const runs = Number(process.argv[2] ?? 200);
const metres = Number(process.argv[3] ?? 1500);
const environments = ["desert", "city", "forest"];

/* ------------------------------------------------------------------ simulation */

/**
 * One run: spawn patterns exactly as the scene does, move every piece toward the player at the
 * run's speed, and record when each piece passes and what it asked for.
 *
 * Speeds are sampled from the same ramp the scene uses, so the windows measured here are the
 * windows the player gets: at 8 m/s a 24 m gap is three seconds, at 16 m/s it is one and a half.
 */
function simulate(environment) {
  let distance = 0;
  let time = 0;
  let frontier = FRONTIER_START;
  const inFlight = [];
  const events = [];
  const coins = [];
  const speeds = [];
  const dt = 1 / 60;
  let patternsSeen = 0;
  let softPatterns = 0;

  // The shape of the chunk about to be placed, held across frames exactly as the scene holds it: a
  // shape picked inside a frame and used only to size the gap would be discarded before the chunk it
  // was picked for is built.
  let upcoming = field.pickShape(difficultyAt(environment, 0));
  // Names each chunk so a row can be traced back to the chunk that produced it, which is what makes
  // "where did this chunk say it left the runner" checkable against where the route actually is.
  let patternId = 0;
  while (distance < metres) {
    const difficulty = difficultyAt(environment, distance);
    const speed = speedAt(environment, distance);
    const step = speed * dt;
    distance += step;
    time += dt;
    frontier += step;
    speeds.push(speed);

    while (frontier > -SPAWN_HORIZON) {
      const pattern = field.buildPattern(environment, difficulty, frontier, upcoming);
      patternId += 1;
      const trace = { shape: pattern.shape, hint: pattern.heldLane, patternId };
      for (const obstacle of pattern.obstacles) {
        inFlight.push({ ...obstacle, ...trace, remaining: PLAYER_Z - obstacle.z });
      }
      for (const coin of pattern.coins) {
        inFlight.push({ ...coin, ...trace, kind: "coin", remaining: PLAYER_Z - coin.z });
      }
      patternsSeen += 1;
      if (!pattern.demanding) softPatterns += 1;
      upcoming = field.pickShape(difficulty);
      frontier -= pattern.span + field.patternGap(environment, difficulty, pattern, upcoming);
    }

    for (let index = inFlight.length - 1; index >= 0; index -= 1) {
      const piece = inFlight[index];
      piece.remaining -= step;
      if (piece.remaining > 0) continue;
      inFlight.splice(index, 1);
      const record = {
        lane: piece.lane,
        y: piece.y ?? 0,
        shape: piece.shape,
        // Carried through so a row can be traced back to the chunk that built it, and to what that
        // chunk claimed about where it left the runner.
        hint: piece.hint,
        patternId: piece.patternId,
        time,
        distance,
        z: piece.z,
        speed,
      };
      if (piece.kind === "coin") coins.push(record);
      else events.push({ ...record, kind: piece.kind });
    }
  }

  return {
    events,
    coins,
    patternsSeen,
    softPatterns,
    averageSpeed: speeds.reduce((sum, value) => sum + value, 0) / speeds.length,
  };
}

/* ------------------------------------------------------------------ measures */

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const moveFor = { block: "jump", gate: "slide", wall: "dodge" };

/**
 * One moment of content: everything that arrives together, which is one decision, not several.
 * A pair in two lanes is a single choice to take the free lane, so rows — not obstacles — are what
 * the player is actually reacting to.
 */
function toRows(events) {
  const sorted = [...events].sort((a, b) => a.time - b.time);
  const rows = [];
  for (const event of sorted) {
    const current = rows[rows.length - 1];
    if (current && event.time - current.time < 0.06) {
      current.events.push(event);
      continue;
    }
    rows.push({ time: event.time, distance: event.distance, events: [event] });
  }
  return rows;
}

const LANE_IDS = Array.from({ length: field.LANE_COUNT }, (_, index) => index);

/**
 * Walks a run as a competent but human player: hold your lane while it stays safe, move the fewest
 * lanes only when it does not, and take the move each hazard asks for.
 *
 * Only walls force you out of a lane — a block or a gate in *another* lane asks for nothing at all,
 * which is why the planner considers every lane and not just the ones containing hazards. This is
 * the best case by construction: if the best case is tight, the content is unfair.
 */
function route(rows) {
  let lane = 1;
  const steps = [];

  for (const row of rows) {
    const walls = new Set(row.events.filter((event) => event.kind === "wall").map((event) => event.lane));
    const open = LANE_IDS.filter((candidate) => !walls.has(candidate));
    if (open.length === 0) {
      steps.push({ row, lane, travel: 0, trapped: true, move: null, dodge: false, kinds: [] });
      continue;
    }
    const target = open.includes(lane)
      ? lane
      : open.reduce((best, candidate) =>
          Math.abs(candidate - lane) < Math.abs(best - lane) ? candidate : best,
        );
    const kindsHere = row.events.filter((event) => event.lane === target).map((event) => event.kind);
    const needed = kindsHere.includes("block") ? "jump" : kindsHere.includes("gate") ? "slide" : null;
    // A wall only ever asks for a dodge when it is the lane you are standing in.
    const dodging = walls.has(lane);
    steps.push({
      row,
      lane: target,
      travel: Math.abs(target - lane),
      trapped: false,
      move: needed,
      dodge: dodging,
      kinds: kindsHere,
    });
    lane = target;
  }

  for (let index = 1; index < steps.length; index += 1) {
    steps[index].window = steps[index].row.time - steps[index - 1].row.time;
  }
  steps[0].window = null;
  return steps;
}

/** Metrics for one world across many runs. */
function audit(environment) {
  const windowsAll = [];
  const windowsMoving = [];
  const violations = [];
  const coinIssues = [];
  const bandRows = new Map();
  const bandActions = new Map();
  const bandWindows = new Map();
  const bandCoins = new Map();
  const bandCoinPoints = new Map();
  const shapeRows = new Map();
  const shapeWindows = new Map();
  const shapeViolations = new Map();
  const moves = { jump: 0, slide: 0, dodge: 0, none: 0 };
  let rowsTotal = 0;
  let hazardsTotal = 0;
  let coinsTotal = 0;
  let coinsWallBlocked = 0;
  let coinsWallTrap = 0;
  let coinsOnRouteLane = 0;
  let patternsTotal = 0;
  let softPatternTotal = 0;
  let coinsNeedJump = 0;
  let trappedRows = 0;
  let movingRows = 0;
  let movingTwoLanes = 0;
  let twoLaneUnderFloor = 0;
  let twoLaneMinWindow = Infinity;
  let twoLaneMinDistance = Infinity;
  let twoLaneTightest = { window: Infinity, at: 0, from: "?" };
  // How good the content's own claim about the runner's lane is: only the chunk's *last* row can be
  // held against it, because that is the row the claim is about. This is why nothing steers on it —
  // at 40% the claim is barely better informed than a coin flip, and a `pair` steered to open a lane
  // beside it lost pacing (see the audit report: dead air 3.45 -> 3.58/3.70 s).
  let hintClaims = 0;
  let hintHits = 0;
  const twoLaneShapes = new Map();
  let actionRows = 0;
  const deadAir = [];
  let reflexRows = 0;
  let collisions = 0;
  let collisionMin = Infinity;
  let speedSum = 0;

  for (let run = 0; run < runs; run += 1) {
    const { events, coins, patternsSeen: seen, softPatterns: soft, averageSpeed } = simulate(environment);
    speedSum += averageSpeed;
    patternsTotal += seen;
    softPatternTotal += soft;
    const rows = toRows(events);
    const steps = route(rows);
    const actions = [];
    const lastRowOfChunk = new Map();
    steps.forEach((step, index) => {
      const id = step.row.events[0]?.patternId;
      if (id !== undefined) lastRowOfChunk.set(id, index);
    });

    for (const [stepIndex, step] of steps.entries()) {
      const chunk = step.row.events[0];
      if (chunk?.hint !== undefined && lastRowOfChunk.get(chunk.patternId) === stepIndex) {
        hintClaims += 1;
        if (step.lane === chunk.hint) hintHits += 1;
      }
      rowsTotal += 1;
      hazardsTotal += step.row.events.length;
      const band = Math.floor(step.row.distance / 100) * 100;
      bandRows.set(band, (bandRows.get(band) ?? 0) + 1);
      if (step.trapped) trappedRows += 1;
      moves[step.move ?? "none"] += 1;
      if (step.travel > 0) movingRows += 1;
      if (step.travel > 1) movingTwoLanes += 1;
      if (step.dodge) moves.dodge += 1;
      // Only rows that ask for something are decisions; the rest is scenery the runner ignores.
      if (step.move || step.dodge) actionRows += 1;
      if (step.move || step.dodge) {
        bandActions.set(band, (bandActions.get(band) ?? 0) + 1);
        const previousAction = actions[actions.length - 1];
        if (previousAction) deadAir.push(step.row.time - previousAction);
        actions.push(step.row.time);
      }

      // Attribute each row to the shape that produced its hazard, so a tight window can be blamed
      // on `slalom` rather than "the game" in general.
      if (step.row.events[0]) {
        const shape = step.row.events[0].shape;
        shapeRows.set(shape, (shapeRows.get(shape) ?? 0) + 1);
      }

      if (step.window !== null) {
        windowsAll.push(step.window);
        const list = bandWindows.get(band) ?? [];
        list.push(step.window);
        bandWindows.set(band, list);
        const shape = step.row.events[0]?.shape;
        if (shape) {
          const shapeList = shapeWindows.get(shape) ?? [];
          shapeList.push(step.window);
          shapeWindows.set(shape, shapeList);
        }
        if (step.window < FAIR_WINDOW_S) reflexRows += 1;

        // What this row actually demands: read it, then cross the lanes it takes to be safe.
        const needed = REACTION_S + LANE_CHANGE_S * step.travel;
        if (step.window < needed) {
          const detail =
            `window ${step.window.toFixed(2)}s for ${step.travel} lane change(s)` +
            `${step.move ? ` + ${step.move}` : ""} (needs ${needed.toFixed(2)}s)${shape ? ` [${shape}]` : ""}`;
          violations.push({ at: Math.round(step.row.distance), detail, shape });
          if (shape) shapeViolations.set(shape, (shapeViolations.get(shape) ?? 0) + 1);
        }
        if (step.travel > 0) windowsMoving.push(step.window);

        // The rows that read two lanes, which are the tightest thing in the game. They are measured
        // against the *content's* own cost of a lane change rather than this model's cheaper one,
        // because the content is what a slower player is up against.
        if (step.travel > 1) {
          twoLaneShapes.set(shape ?? "?", (twoLaneShapes.get(shape ?? "?") ?? 0) + 1);
          twoLaneMinWindow = Math.min(twoLaneMinWindow, step.window);
          twoLaneMinDistance = Math.min(
            twoLaneMinDistance,
            step.window * speedAt(environment, step.row.distance),
          );
          // Tolerance of one frame: a row that lands exactly on the floor is on it, not under it.
          if (step.window < field.REACTION_S + 2 * field.LANE_CHANGE_S - 0.02) twoLaneUnderFloor += 1;
          if (step.window < twoLaneTightest.window) {
            twoLaneTightest = {
              window: step.window,
              at: Math.round(step.row.distance),
              from: steps[steps.indexOf(step) - 1]?.row.events[0]?.shape ?? "?",
            };
          }
        }

        // The runner is committed to a move clip, so the next *different* move cannot start until
        // the current one ends — a jump then a slide 0.2s later is not physically performable.
        const previous = steps[steps.indexOf(step) - 1];
        if (previous) {
          const commitment = previous.move === "jump" ? JUMP_S : previous.move === "slide" ? SLIDE_S : 0;
          if (commitment > 0 && step.move && step.move !== previous.move && step.window < commitment) {
            collisions += 1;
            collisionMin = Math.min(collisionMin, step.window);
          }
        }
      }
    }

    for (const coin of coins) {
      coinsTotal += 1;
      const band = Math.floor(coin.distance / 100) * 100;
      bandCoins.set(band, (bandCoins.get(band) ?? 0) + 1);
      // What this token is worth where it sits. Density is flat by design, so this is the only part
      // of the coin economy that gets richer with distance.
      const points = field.coinValueAt(environment, coin.distance);
      bandCoinPoints.set(band, (bandCoinPoints.get(band) ?? 0) + points);
      if (coin.y > AIRBORNE_COIN_Y) coinsNeedJump += 1;

    // The walk-away window: a wall arriving inside this of a coin makes taking the coin a trap,
    // and a wall arriving *before* it makes the coin unreachable outright.
    const escape = REACTION_S + LANE_CHANGE_S + 0.1;
    let wallBlocked = false;
    let wallTrap = false;
    for (const wall of events) {
      if (wall.kind !== "wall" || wall.lane !== coin.lane) continue;
      const gap = wall.time - coin.time;
      if (gap < 0 && gap > -escape) wallBlocked = true;
      if (gap >= 0 && gap < escape) wallTrap = true;
    }
    if (wallBlocked) {
      coinsWallBlocked += 1;
      coinIssues.push({
        type: "coin-behind-wall",
        at: Math.round(coin.distance),
        detail: `coin y=${coin.y.toFixed(2)} lane ${coin.lane}, wall already there [${coin.shape}]`,
      });
      continue;
    }
    if (wallTrap) {
      coinsWallTrap += 1;
      coinIssues.push({
        type: "coin-then-wall",
        at: Math.round(coin.distance),
        detail: `coin y=${coin.y.toFixed(2)} lane ${coin.lane}, wall inside the escape window [${coin.shape}]`,
      });
    }

      // Otherwise: is the coin in the lane the route is running at that moment? The route holds a
      // row's lane until the next row, so this carries the lane forward rather than matching the
      // coin to the nearest row — a coin between two rows used to have no row close enough to be
      // matched against, which made this share a measure of coin spacing instead of coin placement.
      // Note on what this share does and does not mean: the route is *one* optimal path, not the
      // only one the player may take, so a coin off it is opt-in rather than out of reach. What
      // makes such a coin fair is already covered by the wall checks above.
      const held = steps.filter((step) => step.row.time <= coin.time).pop();
      if (held && held.lane === coin.lane) coinsOnRouteLane += 1;
    }
  }

  const sorted = [...windowsAll].sort((a, b) => a - b);
  const bands = [...bandRows.keys()].sort((a, b) => a - b).map((band) => ({
    band,
    rows: (bandRows.get(band) ?? 0) / runs,
    actions: (bandActions.get(band) ?? 0) / runs,
    window: mean(bandWindows.get(band) ?? [0]),
    coins: (bandCoins.get(band) ?? 0) / runs,
    coinPoints: (bandCoinPoints.get(band) ?? 0) / runs,
  }));
  // The reward curve, read as points per 100 m from coins: the opening band against the last *full*
  // band. The trailing band is cut off by the end of the run and would read as a collapse in the
  // curve rather than as the run stopping. A flat density times a rising value should show a clear
  // multiple.
  const openingBand = bands[0];
  const deepestBand = [...bands].reverse().find((band) => band.band + 100 <= metres);
  const rewardCurve = {
    atLine: field.coinValueAt(environment, 0),
    atPeak: field.coinValueAt(environment, field.environmentPace[environment].difficultyMeters),
    openingPointsPer100m: openingBand ? openingBand.coinPoints : 0,
    deepestPointsPer100m: deepestBand ? deepestBand.coinPoints : 0,
  };
  const shapes = [...shapeRows.keys()].map((shape) => {
    const windows = [...(shapeWindows.get(shape) ?? [])].sort((a, b) => a - b);
    return {
      shape,
      rowsPerRun: (shapeRows.get(shape) ?? 0) / runs,
      min: windows[0] ?? 0,
      p10: percentile(windows, 0.1),
      median: percentile(windows, 0.5),
      underFair: windows.filter((window) => window < FAIR_WINDOW_S).length,
      violations: shapeViolations.get(shape) ?? 0,
    };
  });

  return {
    environment,
    averageSpeed: speedSum / runs,
    rowsPerRun: rowsTotal / runs,
    rowsPer100m: rowsTotal / runs / (metres / 100),
    hazardsPerRow: hazardsTotal / Math.max(1, rowsTotal),
    coinsPerRun: coinsTotal / runs,
    coinsPer100m: coinsTotal / runs / (metres / 100),
    coinsOnRouteLaneShare: coinsOnRouteLane / Math.max(1, coinsTotal),
    softPatternShare: softPatternTotal / Math.max(1, patternsTotal),
    coinsNeedJumpShare: coinsNeedJump / Math.max(1, coinsTotal),
    coinsWallBlocked,
    coinsWallTrap,
    moves,
    trappedRows,
    movingRows,
    movingTwoLanes,
    hintClaims,
    hintHits,
    twoLaneMinWindow,
    twoLaneMinDistance,
    twoLaneUnderFloor,
    twoLaneTightest,
    twoLaneByShape: [...twoLaneShapes]
      .map(([shape, count]) => ({ shape, perRun: count / runs }))
      .sort((a, b) => b.perRun - a.perRun),
    actionRows,
    actionRowsPer100m: actionRows / runs / (metres / 100),
    deadAir: {
      min: Math.min(...deadAir, Infinity),
      p10: percentile([...deadAir].sort((a, b) => a - b), 0.1),
      median: percentile([...deadAir].sort((a, b) => a - b), 0.5),
    },
    windows: {
      min: sorted[0] ?? 0,
      p10: percentile(sorted, 0.1),
      median: percentile(sorted, 0.5),
      reflexShare: reflexRows / Math.max(1, windowsAll.length),
      movingMin: Math.min(...windowsMoving, Infinity),
      movingMedian: percentile([...windowsMoving].sort((a, b) => a - b), 0.5),
    },
    collisions,
    collisionMin,
    violations,
    coinIssues,
    bands,
    shapes,
    rewardCurve,
  };
}

/* ------------------------------------------------------------------ report */

const report = environments.map(audit);

const seconds = (value) => (Number.isFinite(value) ? value.toFixed(2) : "—");
console.log(`run-loop audit — ${runs} runs of ${metres} m per world\n`);

for (const world of report) {
  console.log(`== ${world.environment} ===============================`);
  const pace = environmentPace[world.environment];
  console.log(
    `pace             ${pace.baseSpeed.toFixed(1)} -> ${topSpeed(world.environment).toFixed(1)} m/s ` +
      `(ramps over ${pace.speedRampMeters} m), content peaks at ${pace.difficultyMeters} m`,
  );
  console.log(`mean speed       ${world.averageSpeed.toFixed(1)} m/s`);
  console.log(`decision rows    ${world.rowsPerRun.toFixed(1)} per run (${world.rowsPer100m.toFixed(1)} per 100 m), ` +
    `${world.hazardsPerRow.toFixed(1)} hazards each`);
  console.log(`actionable rows  ${(world.actionRows / runs).toFixed(1)} per run (${world.actionRowsPer100m.toFixed(1)} per 100 m), ` +
    `dead air between them: min ${seconds(world.deadAir.min)}s p10 ${seconds(world.deadAir.p10)}s median ${seconds(world.deadAir.median)}s`);
  console.log(`coins            ${world.coinsPerRun.toFixed(0)} per run (${world.coinsPer100m.toFixed(1)} per 100 m), ` +
    `${(world.coinsOnRouteLaneShare * 100).toFixed(0)}% in the lane the route runs, ` +
    `${(world.softPatternShare * 100).toFixed(0)}% of chunks ask for nothing, ` +
    `${(world.coinsNeedJumpShare * 100).toFixed(0)}% need a jump`);
  console.log(`token value      ${world.rewardCurve.atLine} pts at the line -> ${world.rewardCurve.atPeak} pts once content peaks; ` +
    `coin points/100 m: ${world.rewardCurve.openingPointsPer100m.toFixed(0)} opening -> ${world.rewardCurve.deepestPointsPer100m.toFixed(0)} deepest`);
  console.log(`moves asked      jump ${world.moves.jump}, slide ${world.moves.slide}, dodge ${world.moves.dodge}, ` +
    `free ${world.moves.none}`);
  console.log(`chunk hint       the content claimed where it left the runner ${world.hintClaims} times and was ` +
    `right ${world.hintHits} of them (${((world.hintHits / Math.max(1, world.hintClaims)) * 100).toFixed(0)}%)`);
  console.log(`time between     min ${seconds(world.windows.min)}s   p10 ${seconds(world.windows.p10)}s   ` +
    `median ${seconds(world.windows.median)}s   (${(world.windows.reflexShare * 100).toFixed(1)}% under ${FAIR_WINDOW_S}s)`);
  console.log(`lane changes     ${(world.movingRows / runs).toFixed(1)} rows need one ` +
    `(${(world.movingTwoLanes / runs).toFixed(2)} need two) per run, ` +
    `min window ${seconds(world.windows.movingMin)}s, median ${seconds(world.windows.movingMedian)}s`);
  console.log(`two-lane rows    ${(world.movingTwoLanes / runs).toFixed(2)} per run ` +
    `[${world.twoLaneByShape.map((entry) => `${entry.shape} ${entry.perRun.toFixed(1)}`).join(", ") || "none"}], ` +
    `min lead-in ${Number.isFinite(world.twoLaneMinDistance) ? world.twoLaneMinDistance.toFixed(1) : "—"} m ` +
    `(${seconds(world.twoLaneMinWindow)}s), ${world.twoLaneUnderFloor} under the content's ` +
    `${(field.REACTION_S + 2 * field.LANE_CHANGE_S).toFixed(2)}s cost of crossing two; tightest ${seconds(world.twoLaneTightest.window)}s ` +
    `at ${world.twoLaneTightest.at}m after a ${world.twoLaneTightest.from}`);
  console.log(`move collisions  ${world.collisions} jump/slide pairs inside the previous clip (min ${seconds(world.collisionMin)}s)`);
  console.log(`trapped rows     ${world.trappedRows} (every lane walled — unavoidable)`);
  console.log(`violations       ${world.violations.length}`);
  for (const issue of world.violations.slice(0, 6)) {
    console.log(`  - at ${issue.at}m: ${issue.detail}`);
  }
  console.log(`coin issues      ${world.coinsWallBlocked} unreachable behind walls, ${world.coinsWallTrap} bait you into a wall`);
  for (const issue of world.coinIssues.slice(0, 3)) {
    console.log(`  - ${issue.type} at ${issue.at}m: ${issue.detail}`);
  }
  console.log(`  shape        rows/run   window min/p10/median   under 0.35s   violations`);
  for (const shape of [...world.shapes].sort((a, b) => a.min - b.min)) {
    console.log(
      `  ${shape.shape.padEnd(10)} ${shape.rowsPerRun.toFixed(1).padStart(8)}   ` +
        `${seconds(shape.min)}/${seconds(shape.p10)}/${seconds(shape.median)}`.padEnd(24) +
        `${String(shape.underFair).padStart(10)}   ${shape.violations}`,
    );
  }
  console.log("  distance  rows/run  actions/run  coins/run  mean window  coin pts/run");
  for (const band of world.bands) {
    console.log(
      `  ${String(band.band).padStart(6)}m  ${band.rows.toFixed(1).padStart(8)}  ` +
        `${band.actions.toFixed(1).padStart(11)}  ${band.coins.toFixed(1).padStart(9)}  ${seconds(band.window)}s` +
        `${band.coinPoints.toFixed(0).padStart(13)}`,
    );
  }
  console.log("");
}

const markdown = [
  "# Run loop audit — measured data",
  "",
  `Generated by \`node tools/run-audit.mjs ${runs} ${metres}\`: ${runs} simulated runs of ${metres} m per`,
  "world, driving the real content field, speed ramp, and difficulty curve. A *decision row* is",
  "everything that arrives together — one choice — rather than one obstacle.",
  "",
  "## Headline",
  "",
  "| World | Rows/100m | Actionable/100m | Coins/100m | Median window | Median dead air | Lane-change rows (min) | Two-lane rows | Trapped rows | Required-time violations |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...report.map(
    (world) =>
      `| ${world.environment} | ${world.rowsPer100m.toFixed(1)} | ${world.actionRowsPer100m.toFixed(1)} | ` +
      `${world.coinsPer100m.toFixed(1)} | ${seconds(world.windows.median)}s | ${seconds(world.deadAir.median)}s | ` +
      `${(world.movingRows / runs).toFixed(1)} (${seconds(world.windows.movingMin)}s) | ` +
      `${(world.movingTwoLanes / runs).toFixed(2)} | ` +
      `${world.trappedRows} | ${world.violations.length} |`,
  ),
  "",
  "## Window by pattern shape",
  "",
  "| World | Shape | Rows/run | min | p10 | median | Under 0.35s | Violations |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...report.flatMap((world) =>
    [...world.shapes]
      .sort((a, b) => a.min - b.min)
      .map(
        (shape) =>
          `| ${world.environment} | ${shape.shape} | ${shape.rowsPerRun.toFixed(1)} | ${seconds(shape.min)}s | ` +
          `${seconds(shape.p10)}s | ${seconds(shape.median)}s | ${shape.underFair} | ${shape.violations} |`,
      ),
  ),
  "",
  "## Two-lane rows",
  "",
  "Rows that ask for two lane changes at once. Only a `pair` can produce one: it is the only shape that",
  "puts two obstacles in a single row, and a lane is only ever closed by a `wall`. The lead-in is",
  "reported against the content's own cost of crossing two lanes (`REACTION_S + 2 x LANE_CHANGE_S`),",
  "which is stricter than this model's cost of one.",
  "",
  "| World | Two-lane rows/run | Behind | Min lead-in | Min window | Under the content floor |",
  "| --- | --- | --- | --- | --- | --- |",
  ...report.map(
    (world) =>
      `| ${world.environment} | ${(world.movingTwoLanes / runs).toFixed(2)} | ` +
      `${world.twoLaneByShape.map((entry) => `${entry.shape} ${entry.perRun.toFixed(1)}`).join(", ") || "—"} | ` +
      `${Number.isFinite(world.twoLaneMinDistance) ? `${world.twoLaneMinDistance.toFixed(1)} m` : "—"} | ` +
      `${seconds(world.twoLaneMinWindow)}s | ${world.twoLaneUnderFloor} |`,
  ),
  "",
  "## Pressure by distance",
  "",
  "Rows / actions / mean window per 200 m band.",
  "",
  "| World | 0m | 200m | 400m | 600m | 800m | 1000m | 1200m | 1400m |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...report.map((world) => {
    const row = [0, 200, 400, 600, 800, 1000, 1200, 1400].map((band) => {
      const entry = world.bands.find((item) => item.band === band);
      return entry ? `${entry.rows.toFixed(1)} / ${entry.actions.toFixed(1)} / ${seconds(entry.window)}s` : "—";
    });
    return `| ${world.environment} | ${row.join(" | ")} |`;
  }),
  "",
  "## Reward curve",
  "",
  "What one token pays, and what the tokens in a band pay in total. Density is flat on purpose, so this",
  "is the half of the curve that rises with distance.",
  "",
  "| World | Value at the line | Value at the content peak | Coin points/100 m, first band | last band |",
  "| --- | --- | --- | --- | --- |",
  ...report.map(
    (world) =>
      `| ${world.environment} | ${world.rewardCurve.atLine} | ${world.rewardCurve.atPeak} | ` +
      `${world.rewardCurve.openingPointsPer100m.toFixed(0)} | ${world.rewardCurve.deepestPointsPer100m.toFixed(0)} |`,
  ),
  "",
  "Coin points / run per 200 m band. The 1400 m cell is the last one a 1500 m run fills, and the band",
  "after it is cut short by the run ending — which is why the reward-curve summary above stops at the",
  "last *full* band.",
  "",
  "| World | 0m | 200m | 400m | 600m | 800m | 1000m | 1200m | 1400m |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...report.map((world) => {
    const cells = [0, 200, 400, 600, 800, 1000, 1200, 1400].map((band) => {
      const first = world.bands.find((item) => item.band === band);
      const second = world.bands.find((item) => item.band === band + 100);
      const total = (first?.coinPoints ?? 0) + (second?.coinPoints ?? 0);
      return first ? total.toFixed(0) : "—";
    });
    return `| ${world.environment} | ${cells.join(" | ")} |`;
  }),
  "",
  "## Moves asked for",
  "",
  "| World | jump | slide | dodge | free | Mean speed | Coins needing a jump | Coins on the safe route | Coins behind a wall | Coins that bait a wall |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...report.map(
    (world) =>
      `| ${world.environment} | ${world.moves.jump} | ${world.moves.slide} | ${world.moves.dodge} | ` +
      `${world.moves.none} | ${world.averageSpeed.toFixed(1)} m/s | ` +
      `${(world.coinsNeedJumpShare * 100).toFixed(0)}% | ` +
      `${(world.coinsOnRouteLaneShare * 100).toFixed(0)}% | ${world.coinsWallBlocked} | ${world.coinsWallTrap} |`,
  ),
  "",
  "## Worst violations",
  "",
  ...report.flatMap((world) => [
    `**${world.environment}**`,
    "",
    ...world.violations.slice(0, 8).map((issue) => `- ${issue.at}m: ${issue.detail}`),
    "",
  ]),
].join("\n");

writeFileSync(join(root, "doc", "run-loop-audit-data.md"), markdown);
console.log(`wrote doc/run-loop-audit-data.md`);

rmSync(temp, { recursive: true, force: true });
