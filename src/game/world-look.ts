import type { Environment } from "./run-state";

/**
 * What each world looks like, in the one place that decides it.
 *
 * The road, the obstacles, the coins and the apron are all drawn from this, and now the roadside is
 * too — which is why it lives in its own module rather than inside the scene. A second palette beside
 * the first would be a second answer to "what colour is the desert", and the two would drift: the
 * roadside would keep whatever the scene looked like the day it was written.
 *
 * These are the *materials* of the place — what its ground, its structures, its scenery and its
 * signage are made of. What the place looks like on its own terms is the generated world; these
 * colours only exist so the game-owned geometry can sit in front of it without arguing.
 */
export type EnvironmentLook = {
  ambient: string;
  key: string;
  contrast: number;
  base: string;
  grain: string;
  line: string;
  edge: string;
  block: string;
  blockAccent: string;
  gate: string;
  wall: string;
  coin: string;
  coinGlow: string;
  /**
   * What the roadside props are made of, added when the roadside stopped being boxes.
   *
   * A prop carries its colours in its own geometry (see `roadside-props`), so what it needs from the
   * palette is the identity of a *material* — what stone looks like here, what wood looks like here —
   * rather than the colour of a surface at a particular angle. These four are the ones the road's own
   * palette did not have: everything else a prop is built from was already an answer to a question
   * this module had been asked, and a second answer beside the first is what this file exists to
   * prevent.
   */
  stone: string;
  trunk: string;
  foliage: string;
  flora: string;
};

export const environmentLook: Record<Environment, EnvironmentLook> = {
  desert: {
    ambient: "#e6a86f",
    key: "#ffd9a0",
    contrast: 0.9,
    base: "#7d4629",
    grain: "#96603d",
    line: "#ffd489",
    edge: "#edb072",
    block: "#c98a5a",
    blockAccent: "#7d4a2c",
    gate: "#e0b070",
    wall: "#b1743f",
    coin: "#ffd777",
    coinGlow: "#ff9f45",
    stone: "#b08a5e",
    trunk: "#8a6743",
    foliage: "#7d8f52",
    flora: "#4f7a4a",
  },
  city: {
    ambient: "#2b4d78",
    key: "#9fd8ff",
    contrast: 1,
    base: "#182533",
    grain: "#283c4e",
    line: "#51e4ff",
    edge: "#2f7fa8",
    block: "#2b3440",
    blockAccent: "#51e4ff",
    gate: "#51e4ff",
    wall: "#39424f",
    coin: "#8ff2ff",
    coinGlow: "#1fa8d8",
    stone: "#3f4854",
    trunk: "#3d4652",
    foliage: "#4d6b59",
    flora: "#3f6b55",
  },
  forest: {
    ambient: "#3d7f6b",
    key: "#c9ffd6",
    contrast: 0.9,
    base: "#173429",
    grain: "#244835",
    line: "#9af29d",
    edge: "#3f7a55",
    block: "#6b4a2f",
    blockAccent: "#3f6b45",
    gate: "#5d8f5a",
    wall: "#4a5a4f",
    coin: "#b6ff9e",
    coinGlow: "#4fd07a",
    stone: "#5c655b",
    trunk: "#5a4030",
    foliage: "#2c5c43",
    flora: "#3f7a4e",
  },
};
