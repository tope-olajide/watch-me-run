import type { Environment } from "./run-state";

/**
 * The atmosphere each world brings to the launch. This is the beat of world before the run starts:
 * one line and a small readout over live generated frames, plus the weather the dive draws over
 * them. It is flavour, never instruction — nothing here tells the player what to press.
 */
export type WorldIntro = {
  /** One atmospheric line, held for a beat as the interface leaves. */
  line: string;
  /** Ambient readout, two short world-specific readings. */
  ambience: readonly [string, string];
  /** Which weather the entrance paints over the live world. */
  weather: "heat" | "rain" | "pollen";
};

/** The three worlds. Shared by the menu, the entrance transition, and the run header. */
export type World = {
  id: Environment;
  label: string;
  tagline: string;
  index: string;
  hazards: string[];
  intro: WorldIntro;
};

export const worlds: World[] = [
  {
    id: "desert",
    label: "The Dunes",
    tagline: "Wake the storm",
    index: "01",
    hazards: ["Sandstorm", "Ruins"],
    intro: {
      line: "Heat lifts off the ridge",
      ambience: ["43°C", "storm rising"],
      weather: "heat",
    },
  },
  {
    id: "city",
    label: "Neon Pursuit",
    tagline: "Outrun the blackout",
    index: "02",
    hazards: ["Blackout", "Traffic"],
    intro: {
      line: "Rain sheets through the neon",
      ambience: ["grid dark", "asphalt wet"],
      weather: "rain",
    },
  },
  {
    id: "forest",
    label: "The Forest",
    tagline: "Make it watch back",
    index: "03",
    hazards: ["Fog", "Old growth"],
    intro: {
      line: "The canopy leans in",
      ambience: ["fog thick", "pollen drift"],
      weather: "pollen",
    },
  },
];

export function worldById(id: Environment): World {
  return worlds.find((world) => world.id === id) ?? worlds[0];
}
