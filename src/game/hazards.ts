import type { Environment, HazardKind, HazardPhase } from "./run-state";

/**
 * The world's own weather.
 *
 * Every world already *promised* one: the menu card sells the desert as *Sandstorm*, the city as
 * *Blackout*, the forest as *Fog*, and the HUD's pressure meter is named for it. The hazard is that
 * promise made playable: it arrives on a rhythm, it is announced before it lands, and it gets worse as
 * the run gets harder. The city and the forest take a rule away — the light, the planning distance —
 * and the desert takes none: its storm is the one hazard that is a condition of the *picture*, the
 * scrim, the haze and the horizon, with the road playing on unchanged underneath it.
 *
 * That was not always so. The desert's storm used to take a lane: a gust every so many metres moved
 * the runner one lane sideways, direction alternating, every gust checked against the road first so it
 * could not shove them into an obstacle. It was reported twice as a bug — a run that moves with no key
 * behind it reads as the game playing itself, and the telegraph built for it (streaks, a HUD line, an
 * 18 m wind-up) only made the movement better announced, never explained. A hazard may take the light
 * or the distance; it may not take the wheel. So the lane shove, its fairness check and its whole
 * wind-up are gone, and what remains is the weather the world was already drawing.
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
  /** Which cycle this is, so each hazard is announced once and counted per run. */
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
  desert: { kind: "storm", name: "Sandstorm" },
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

const CALM: HazardState = { kind: "storm", name: "", phase: "calm", intensity: 0, index: 0 };

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
      index,
    };
  }

  if (into < WARNING_METRES + active) {
    const since = into - WARNING_METRES;
    return {
      ...recipe,
      phase: "active",
      intensity: 0.35 + 0.65 * Math.sin((since / active) * Math.PI),
      index,
    };
  }

  return { ...CALM, ...recipe, index };
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
 * far layer — its storm takes everything from the picture and nothing from the run. Near is held well
 * past the runner in both cases: fogging the character the player is steering would make the hazard a
 * smudge on the screen rather than a condition of the world.
 */
export function hazardFog(hazard: HazardState, difficulty: number): { near: number; far: number } {
  if (hazard.kind === "fog") {
    return {
      near: 700 - 686 * hazard.intensity,
      far: 1200 - (1200 - (44 - difficulty * 10)) * hazard.intensity,
    };
  }
  if (hazard.kind === "storm") {
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
