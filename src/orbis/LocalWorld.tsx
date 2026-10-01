import { useEffect, useRef } from "react";
import { publishChunk, useWorld } from "./world-bus";

/**
 * The world layer's stand-in while Orbis is paused for testing (see `orbis-switch.ts`).
 *
 * It draws exactly what a session that never connects would draw — the local backdrop under the
 * interface — and publishes the model's cadence as a metronome, so the run's director schedules and
 * releases asks exactly as it does against a live world. It holds no SDK, opens no session and sends
 * nothing: every prompt a test run builds is dropped at the world bus instead.
 *
 * This file exists only for the switch. When `ORBIS_DISABLED` goes back to `false`, the real
 * `WorldLayer` mounts again and this component is not rendered.
 */

/**
 * One chunk of frames every two seconds, which is the cadence the run's director is written against
 * (a live chunk is 1.5–2 s apart; the layer's 3 s rest between chunks is a cost optimisation with no
 * meaning locally). The director spends at most one ask per chunk boundary, so without this tick the
 * routine asks would queue for a boundary that never comes and the world-answers feed would stall —
 * the gameplay would still play, but the thing being tested would not be the thing that ships.
 */
const LOCAL_CHUNK_MS = 2_000;

export default function LocalWorld() {
  const { world, runActive } = useWorld();
  const index = useRef(0);

  useEffect(() => {
    // Only while a run is on screen: the menu is local in both modes, and a tick per two seconds
    // through it would re-render menu surfaces for a cadence nothing in the menu consumes.
    if (!runActive) return;
    index.current = 0;
    const timer = window.setInterval(() => {
      index.current += 1;
      publishChunk({ index: index.current, at: Date.now() });
    }, LOCAL_CHUNK_MS);
    return () => window.clearInterval(timer);
  }, [runActive]);

  return <div className="world-local" data-world={world ?? "desert"} aria-hidden="true" />;
}
