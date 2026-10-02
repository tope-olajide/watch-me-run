import type { Environment, HazardKind, HazardPhase } from "./run-state";

/**
 * The world's own weather.
 *
 * Every world already *promised* one: the menu card sells the desert as *Sandstorm*, the city as
 * *Blackout*, the forest as *Fog*, and the HUD's pressure meter is named for it. Nothing in the run
 * ever did it. The hazard is that promise made playable: it arrives on a rhythm, it is announced
 * before it lands, it gets worse as the run gets harder, and each world's attacks a different channel
 * — the desert attacks where you *are*, the city attacks what you can *see*, the forest attacks how
 * far ahead you can *plan*. That difference is the reason to play a second world rather than a second
 * pace.
 *
 * The schedule is measured in metres of run rather than seconds, for the same reason the pickups are:
 * a slow world and a fast one should meet the same weather for the same run, and a paused run must not
 * burn through a storm behind a pause screen.
 */

export type HazardState = {
  kind: HazardKind;
  /** The world's own name for it: the first hazard the menu card advertises. */
  name: string;
  phase: HazardPhase;
  /**
   * How hard it is being felt right now, 0..1: what the scrim, the dimming and the fog are driven by,
   * and what the world is asked about when it arrives.
   */
  intensity: number;
  /** Metres into the active window (0 while warning or calm), which the shove's rhythm runs on. */
  since: number;
  /** Which cycle this is, so two hazards in a row do not shove the same way twice. */
  index: number;
};

type HazardRecipe = { kind: HazardKind; name: string };

/**
 * One hazard per world, and it is the one the card already named.
 *
 * The names are duplicated from `worlds.ts` rather than imported, deliberately: that list is *marketing*
 * — "Sandstorm, Ruins" — and this is the mechanic. A world that renamed its card hazard should get a
 * compile error in the place that decides what the storm does, not silently inherit a new name.
 */
const RECIPES: Record<Environment, HazardRecipe> = {
  desert: { kind: "shove", name: "Sandstorm" },
  city: { kind: "blackout", name: "Blackout" },
  forest: { kind: "fog", name: "Fog" },
};

/** The first hazard waits for the run to have an identity of its own. */
const FIRST_METRES = 240;
/** The warning band: the HUD names it, the sky changes, nothing hurts yet. */
const WARNING_METRES = 60;
/** How long it lasts at the line, in metres. */
const ACTIVE_METRES = 150;
/** From the start of one warning to the start of the next. */
const SPACING_METRES = 600;
/** How much harder the run makes it: tighter spacing, longer storms. */
const SPACING_SLOPE = 140;
const ACTIVE_SLOPE = 60;
/** Never let the quiet between two hazards disappear: a world that is always storming is wallpaper. */
const QUIET_FLOOR = 90;
/**
 * Metres between one shove and the next, inside a sandstorm.
 *
 * The first cut took a lane every 36 m — four or five gusts in one storm, close enough together that
 * the run was being steered by the weather more than by the player, and close enough (measured in
 * play) to read as the game moving the runner rather than as wind. 54 m is a gust every three to six
 * seconds: the storm still owns the lane rhythm, and there is room between gusts for the run to answer
 * the last one before the next wind-up starts.
 */
export const WIND_METRES = 54;

/**
 * How far before a gust lands its wind-up starts.
 *
 * Every gust is shown before it takes the lane: from this distance the streaks are up, the HUD names
 * it, and the direction on screen is the lane the gust will actually take. 18 m is over a second at
 * the fastest world's top speed and over two at the opening pace — the same decision window the grab
 * rules are keyed to (`ESCAPE_DISTANCE` is 16 m) — so what the storm is about to do is a thing the
 * player had time to read rather than a lane that changed itself.
 */
export const WIND_LEAD_METRES = 18;

const CALM: HazardState = { kind: "shove", name: "", phase: "calm", intensity: 0, since: 0, index: 0 };

/**
 * Where the weather is at this distance.
 *
 * `intensity` is continuous across every join — warning lifts to 0.35, the active window starts at
 * 0.35 and swells to 1 and back down to 0.35, and the quiet is 0 — so the picture never snaps at a
 * phase change. A weather front that switched on would read as a bug in the lighting rather than as
 * the world turning on the run.
 */
export function hazardAt(
  environment: Environment,
  distance: number,
  difficulty: number,
  /** False under the "Fair weather" contract: the world keeps its weather to itself, for a price. */
  enabled = true,
): HazardState {
  const recipe = RECIPES[environment];
  if (!enabled) return { ...CALM, ...recipe };
  const active = ACTIVE_METRES + difficulty * ACTIVE_SLOPE;
  const spacing = Math.max(
    WARNING_METRES + active + QUIET_FLOOR,
    SPACING_METRES - difficulty * SPACING_SLOPE,
  );

  if (distance < FIRST_METRES) return { ...CALM, ...recipe };

  const into = (distance - FIRST_METRES) % spacing;
  const index = Math.floor((distance - FIRST_METRES) / spacing);

  if (into < WARNING_METRES) {
    return {
      ...recipe,
      phase: "warning",
      intensity: 0.15 + (into / WARNING_METRES) * 0.2,
      since: 0,
      index,
    };
  }

  if (into < WARNING_METRES + active) {
    const since = into - WARNING_METRES;
    return {
      ...recipe,
      phase: "active",
      intensity: 0.35 + 0.65 * Math.sin((since / active) * Math.PI),
      since,
      index,
    };
  }

  return { ...CALM, ...recipe, index };
}

/**
 * Which way the storm is pushing, and whether a shove is due.
 *
 * A shove is one whole lane, not a drift: the road is three lanes wide and the runner's lateral
 * position is a lane, so a continuous push would be a state the simulation does not have (and a
 * runner hanging between two lanes is a collision the player cannot reason about). One lane displaced
 * is a decision the player can answer, and answering it is the hazard: the storm takes a lane, and
 * the run has to take it back before the next obstacle arrives.
 */
export function shovesFor(since: number): number {
  return Math.floor(since / WIND_METRES);
}

/**
 * How far through its wind-up the next gust is: 0 while the wind is quiet, 1 as it lands.
 *
 * `shoves` is how many gusts have already landed, which matters for the one case the schedule alone
 * cannot describe: a gust that found both side lanes occupied is still owed — it holds at full
 * wind-up until the road opens rather than being spent or landing unwarned.
 */
export function gustLead(since: number, shoves: number): number {
  const due = shovesFor(since);
  if (shoves < due) return 1;
  const gap = (due + 1) * WIND_METRES - since;
  return gap >= WIND_LEAD_METRES ? 0 : 1 - gap / WIND_LEAD_METRES;
}

export function windFor(index: number, shove: number): -1 | 1 {
  return (index + shove) % 2 === 0 ? -1 : 1;
}

/** How much light the run has left, 1 in every world but the blacked-out one. */
export function hazardLight(intensity: number): number {
  return 1 - 0.7 * intensity;
}

/**
 * Where the fog sits, near and far, in metres from the camera, for whichever hazard is running.
 *
 * Two of the three are partly a change of *visibility* even though only one of them is called fog: a
 * sandstorm that does not haze the distance is a colour cast, and the far dunes going soft is most of
 * what a storm does to a picture. The forest's closes inside the road's own fade (full at 40 m, gone at
 * 83 m), so the ground the runner is planning on is already dissolving; the desert's only softens the
 * far layer, and the storm is paid for in lanes instead. Near is held well past the runner in both
 * cases: fogging the character the player is steering would make the hazard a smudge on the screen
 * rather than a condition of the world.
 */
export function hazardFog(hazard: HazardState, difficulty: number): { near: number; far: number } {
  if (hazard.kind === "fog") {
    return {
      near: 700 - 686 * hazard.intensity,
      far: 1200 - (1200 - (44 - difficulty * 10)) * hazard.intensity,
    };
  }
  if (hazard.kind === "shove") {
    return { near: 700 - 620 * hazard.intensity, far: 1200 - 1060 * hazard.intensity };
  }
  return { near: 700, far: 1200 };
}

/* ---- what the rest of the app reads ------------------------------------------------------------
 *
 * The simulation is the only thing that knows what the weather is doing, and three consumers need it
 * without a React re-render per frame: the road's own material (which dims), the scene's fog (which
 * closes), and the DOM overlay (which is a screen-space scrim, because the generated world is a DOM
 * video the WebGL fog cannot reach). So the state is published to a module and to `:root`, the same
 * way the camera publishes `--run-speed` and `--hit`.
 */
let current: HazardState = CALM;
let lastPhase = "";
let lastIntensity = -1;

export function readHazard(): HazardState {
  return current;
}

export function publishHazard(state: HazardState): void {
  current = state;
  const root = document.documentElement;
  if (state.phase !== lastPhase) {
    lastPhase = state.phase;
    root.dataset.hazardPhase = state.phase;
    root.dataset.hazard = state.phase === "calm" ? "" : state.kind;
  }
  // Only on a real change: this runs inside the frame loop, and writing a style every frame is a
  // style recalculation every frame for a number that moves by a thousandth.
  // `--weather`, not `--hazard`: the pressure meter already owns `--hazard` as its *colour*, per world
  // (see `.hud-pressure-fill`), and an intensity inheriting into that would be a bar with a number for
  // a background.
  if (Math.abs(state.intensity - lastIntensity) > 0.02) {
    lastIntensity = state.intensity;
    root.style.setProperty("--weather", state.intensity.toFixed(3));
  }
}

/* ---- the gust's wind-up, published the same way -------------------------------------------------
 *
 * The desert's gusts are the one hazard with a rhythm inside the hazard, so they need a channel of
 * their own: the scrim answers "the storm is here", and these two answer "and it is about to take a
 * lane — this one". `--gust` is the lead (0..1, see `gustLead`) and drives the streaks' and the HUD
 * line's opacity; `data-gust-dir` is the lane it will take, which is what the streak sweep reads.
 * Written from the frame loop, so real changes only, for the same reason as `--weather`.
 */
let lastGustLead = -1;

export function publishGust(lead: number, dir: -1 | 1): void {
  if (Math.abs(lead - lastGustLead) < 0.02) return;
  lastGustLead = lead;
  const root = document.documentElement;
  root.style.setProperty("--gust", lead.toFixed(3));
  // Deliberately not cleared when the lead ends: the layers fade out through their own CSS
  // transitions, and a direction that vanished mid-fade would flip the streaks as they leave.
  if (lead > 0) root.dataset.gustDir = dir < 0 ? "left" : "right";
}
