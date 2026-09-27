export type Environment = "desert" | "city" | "forest";

export type PlayerStyle =
  | "reckless"
  | "precise"
  | "aggressive"
  | "explorer";

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
};

export type WorldEvent =
  | { type: "run_started"; environment: Environment }
  | { type: "near_miss"; obstacle?: string }
  | { type: "combo_milestone"; combo: number }
  | { type: "damage_taken"; amount: number }
  | { type: "speed_milestone"; speed: number }
  | { type: "distance_milestone"; distance: number }
  | { type: "powerup_collected"; powerup: string }
  /** The run crossed a quarter of its reward curve: tokens pay more from here, and the world answers. */
  | { type: "value_tier"; tier: number; value: number }
  | { type: "world_event"; event: string }
  | { type: "run_ended"; score: number };

export const initialRunState = (environment: Environment): RunState => ({
  environment,
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
});
