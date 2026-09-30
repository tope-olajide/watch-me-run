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

/**
 * Which world the player last chose, remembered so the menu opens on it next time.
 *
 * The menu asks the same question every visit, and the answer is usually the same as last time — so
 * the card that was picked stays picked, and the picture they uploaded comes back with the world it
 * was chosen for (see `landscape-store`, which restores the file this id belongs to).
 *
 * A store that cannot be read — private browsing, storage disabled — is not an error here: no
 * remembered answer means the first world, which is what the menu did before this existed. That is
 * also why the read is validated against the catalog rather than trusted: a stale or hand-edited key
 * must not put the game into a world that does not exist.
 */
const WORLD_CHOICE_KEY = "watchme-run:world";

export function readWorldChoice(): Environment | undefined {
  try {
    const stored = window.localStorage.getItem(WORLD_CHOICE_KEY);
    return worlds.some((world) => world.id === stored) ? (stored as Environment) : undefined;
  } catch {
    return undefined;
  }
}

export function rememberWorldChoice(id: Environment): void {
  try {
    window.localStorage.setItem(WORLD_CHOICE_KEY, id);
  } catch {
    // Nothing to do and nothing worth saying: the choice simply is not kept.
  }
}
