/**
 * TEMPORARY ORBIS KILL SWITCH — gameplay testing without spending the account's session credits.
 *
 * ## How to use it
 *
 * We are testing the *gameplay* right now, so `ORBIS_DISABLED` is `true`. To bring the live world
 * back, flip it to `false` and reload — that is the whole change. This flag decides whether
 * `src/orbis/WorldLayer.tsx` is mounted at all; the prompts, the director, the world bus and the
 * layer itself are untouched and come straight back.
 *
 * ## What "disabled" means, exactly
 *
 *   - `WorldLayer` is never rendered, so the Reactor SDK chunk is never even fetched, no session is
 *     created, and no prompt or caption ever leaves the page.
 *   - `src/orbis/LocalWorld.tsx` draws the local backdrop instead, so every surface looks exactly
 *     as it does in local world mode, and it publishes a chunk tick every couple of seconds so the
 *     run's director schedules its asks against the world's real cadence.
 *   - `src/WorldLoader.tsx` skips its wait (there is nothing to wait for) and hands the run over as
 *     soon as the runner is warm.
 *   - Prompts built during a run are still journaled (`window.__orbisPrompts`) and are dropped at
 *     the world bus, so the intent behind each ask stays checkable — nothing just disappears.
 *
 * No line of the Orbis pipeline was changed for this: the switch is a bypass beside it, not a
 * modification of it. `tools/orbis-off-probe.mjs` proves the bypass holds (no session, no SDK, no
 * network) and that the game plays normally across it.
 */
export const ORBIS_DISABLED = true;

/** The status copy every surface shows while the switch is on. */
export const ORBIS_DISABLED_NOTE = "Local world mode · Orbis paused for testing";

if (import.meta.env.DEV && ORBIS_DISABLED) {
  console.info("[orbis] disabled for gameplay testing — no session, no prompts (src/orbis/orbis-switch.ts)");
}
