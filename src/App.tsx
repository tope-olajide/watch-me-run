import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import MenuExperience from "./MenuExperience";
import WorldLoader from "./WorldLoader";
import type { CharacterId } from "./game/character-catalog";
import { characterCatalog } from "./game/character-catalog";
import type { Environment } from "./game/run-state";
import { worldById } from "./game/worlds";
import { launchPrompt, openingPrompt } from "./orbis/prompts";
import { world } from "./orbis/world-bus";

const RunExperience = lazy(() => import("./RunExperience"));
const WorldLayer = lazy(() => import("./orbis/WorldLayer"));

/**
 * The dive: the interface leaves, the live frames push in, and the runner arrives inside the chunks
 * that were already on their way. By the time it plays the world is armed, because `WorldLoader` has
 * asked for it and waited — so this is the part of starting a run that is a *transition* rather than a
 * wait. The CSS animations that draw it are keyed off `html[data-entering]` and share this duration.
 */
const ENTER_MS = 1450;
/** Reduced motion gets the arrival, not the ride. */
const ENTER_MS_REDUCED = 220;
/**
 * Leaving mirrors arriving: the run pulls back out of the world while the menu reassembles, and the
 * world is asked for its wide establishing shot again so the menu returns to the same view it left.
 */
const EXIT_MS = 950;
const EXIT_MS_REDUCED = 160;

type Phase =
  | { kind: "menu"; returning?: boolean }
  /**
   * Between the menu and the dive: the world is being asked for and Orbis is being waited for.
   *
   * The menu asks for nothing (see `src/MenuExperience`), so this is where a session is created, a
   * landscape is pinned and generation is started — with `src/WorldLoader` on screen naming each step.
   * `at` is the Start press in `performance.now()`, so the loading screen can be held for a moment
   * even when the world is already warm without ever being held for longer than the player waited.
   */
  | { kind: "loading"; environment: Environment; characterId: CharacterId; at: number }
  | { kind: "entering"; environment: Environment; characterId: CharacterId }
  | { kind: "run"; environment: Environment; characterId: CharacterId }
  | { kind: "exiting"; environment: Environment; characterId: CharacterId };

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "menu" });
  const loading = phase.kind === "loading" ? phase : undefined;
  const entering = phase.kind === "entering" ? phase : undefined;
  const exiting = phase.kind === "exiting" ? phase : undefined;
  const running = phase.kind === "run" || phase.kind === "exiting" ? phase : undefined;

  const beginRun = useCallback((environment: Environment, characterId: CharacterId) => {
    setPhase((current) =>
      current.kind === "menu"
        ? { kind: "loading", environment, characterId, at: performance.now() }
        : current,
    );
  }, []);

  /**
   * The loading screen's verdict: the world is armed, or waiting any longer is worse than playing.
   *
   * Its own verdict rather than a condition here because it is the only surface that can see what
   * Orbis is doing — connecting, generating, pinning a landscape — and the difference between "worth
   * another second" and "never coming" is exactly what it is watching.
   */
  const worldReady = useCallback(() => {
    setPhase((current) =>
      current.kind === "loading"
        ? { kind: "entering", environment: current.environment, characterId: current.characterId }
        : current,
    );
  }, []);

  // Which surface owns the screen, published for the stylesheet. The world layer stays dark while the
  // menu is up: the menu is local now, and a world left warm behind it (see the grace window in
  // `WorldLayer`) would otherwise be visible through the menu's own scrim.
  useEffect(() => {
    document.documentElement.dataset.surface = phase.kind;
  }, [phase.kind]);

  const beginExit = useCallback(() => {
    // Synchronously, before any state: the run's prompt channel is closed at the click, so nothing
    // it had queued can land on the menu's wide shot during the exit transition.
    world.setRunActive(false);
    // The pause went with the run: the menu's world must be moving, not held on the last frame the
    // pause caught.
    world.setPaused(false);
    setPhase((current) =>
      current.kind === "run"
        ? { kind: "exiting", environment: current.environment, characterId: current.characterId }
        : current,
    );
  }, []);

  // The run's chunk is small, but a lazy load landing mid-dive would show a loading screen, so it
  // is warmed while the player is still reading the menu.
  useEffect(() => {
    const timer = window.setTimeout(() => void import("./RunExperience"), 800);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!entering) return;

    // The world is already live: keep it, take its sound, and ask it for a forward dive so the
    // chunks arriving next belong to the run rather than to the menu's establishing wide.
    world.showWorld(entering.environment);
    world.setRunActive(true);
    world.sendPrompt(launchPrompt(world.view(entering.environment)), { reason: "launch" });

    const timer = window.setTimeout(
      () => setPhase({ kind: "run", environment: entering.environment, characterId: entering.characterId }),
      prefersReducedMotion() ? ENTER_MS_REDUCED : ENTER_MS,
    );
    return () => window.clearTimeout(timer);
  }, [entering]);

  useEffect(() => {
    if (!exiting) return;

    // The world outlives the run: hand it back to the menu's wide shot and let it be muted and
    // recyclable again while the interface reassembles.
    world.setRunActive(false);
    world.sendPrompt(openingPrompt(world.view(exiting.environment)), { reason: "exit-opening" });

    const timer = window.setTimeout(
      () => setPhase({ kind: "menu", returning: true }),
      prefersReducedMotion() ? EXIT_MS_REDUCED : EXIT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [exiting]);

  // The dive animation owns the world layer's transform while it runs; hand it back afterwards so
  // the run's own speed-driven scale takes over.
  useEffect(() => {
    if (!entering) {
      delete document.documentElement.dataset.entering;
      return;
    }
    document.documentElement.dataset.entering = "true";
    return () => {
      delete document.documentElement.dataset.entering;
    };
  }, [entering]);

  // Same hand-over for the way out: the flag outlives the run's own shell so the pull-back plays.
  useEffect(() => {
    if (!exiting) {
      delete document.documentElement.dataset.exiting;
      return;
    }
    document.documentElement.dataset.exiting = "true";
    return () => {
      delete document.documentElement.dataset.exiting;
    };
  }, [exiting]);

  return (
    <>
      {/*
        The generated world lives above the interface, below everything else, and is mounted once
        for the whole visit: the menu generates a world, a run continues inside that same stream,
        and coming back does not cut it.

        Lazy because the Reactor SDK is a chunk of its own, and the fallback is nothing on purpose:
        the interface behind it already draws the local backdrop, which is exactly what a session
        that has not connected yet leaves on screen.
      */}
      <Suspense fallback={null}>
        <WorldLayer />
      </Suspense>

      {/*
        The wait for the world, on top of the menu it was started from: the menu behind is already
        the local backdrop, and leaving it in place means the loading screen dissolves into the same
        interface the player was reading rather than into a blank frame.
      */}
      {loading && (
        <WorldLoader
          environment={loading.environment}
          characterId={loading.characterId}
          startedAt={loading.at}
          onReady={worldReady}
        />
      )}

      {running ? (
        <Suspense fallback={<div className="app-loading">Preparing your world...</div>}>
          <RunExperience
            environment={running.environment}
            characterId={running.characterId}
            leaving={phase.kind === "exiting"}
            onExit={beginExit}
          />
        </Suspense>
      ) : (
        <MenuExperience
          entering={Boolean(entering)}
          returning={phase.kind === "menu" && Boolean(phase.returning)}
          onStart={beginRun}
        />
      )}

      {entering && <EntranceVeil environment={entering.environment} characterId={entering.characterId} />}
    </>
  );
}

/**
 * The dive itself: a flash, the world's own streaks, and the world's name slamming in — then a
 * single beat of that world's atmosphere, painted over the live frames as the interface leaves.
 *
 * The weather layer is decoration and the copy is flavour: nothing here asks the player to do
 * anything, and the whole veil is `aria-hidden`.
 */
function EntranceVeil({ environment, characterId }: { environment: Environment; characterId: CharacterId }) {
  const selected = worldById(environment);
  const character = characterCatalog.find((item) => item.id === characterId);

  return (
    <div className="enter-veil" data-world={environment} data-weather={selected.intro.weather} aria-hidden="true">
      <span className="enter-weather" />
      <span className="enter-card">
        <strong>{selected.label}</strong>
        <span className="enter-sub">
          {character?.label ?? "Runner"} · entering the world
        </span>
        <em className="enter-line">{selected.intro.line}</em>
        <span className="enter-ambience">{selected.intro.ambience.join(" · ")}</span>
      </span>
    </div>
  );
}
