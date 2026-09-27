import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { CharacterId } from "./game/character-catalog";
import { characterCatalog } from "./game/character-catalog";
import type { Environment } from "./game/run-state";
import { worlds } from "./game/worlds";
import { LandscapeError, landscapeNote, prepareLandscape } from "./orbis/landscape";
import { useWorld, world, worldLabel, worldTone } from "./orbis/world-bus";

const CharacterPreview = lazy(() => import("./game/CharacterPreview"));

type MenuExperienceProps = {
  onStart: (environment: Environment, characterId: CharacterId) => void;
  /** True while the world dive plays: the menu is on its way out and takes no input. */
  entering?: boolean;
  /** True when the menu is arriving back from a run, which plays its own entrance. */
  returning?: boolean;
};

export default function MenuExperience({ onStart, entering = false, returning = false }: MenuExperienceProps) {
  const [environment, setEnvironment] = useState<Environment>("desert");
  const [characterId, setCharacterId] = useState<CharacterId>("amy");
  const [preparing, setPreparing] = useState(false);
  const [uploadError, setUploadError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const worldState = useWorld();
  const landscape = worldState.landscape;
  // A picture the player picks becomes the session's starting frame, which Orbis will only take
  // before `start` — so it rebuilds the world. That rebuild must not land under a run, which is why
  // the run waits for it rather than the world being rebuilt around a player already in it.
  const pinning = worldState.pinning;
  const character = characterCatalog.find((item) => item.id === characterId);
  const selected = worlds.find((item) => item.id === environment) ?? worlds[0];
  const tone = worldTone(worldState);
  const generating = worldState.world === environment;

  // The menu is also the world's pre-flight: it starts generating straight away, and every world
  // change morphs the running stream instead of opening a second session. Selecting a landscape
  // asks for the world itself — it is a condition of the session, not a prompt — so it takes the
  // rebuild path in the world layer rather than going through here.
  useEffect(() => {
    world.showWorld(environment);
  }, [environment]);

  /**
   * Preparing a picture is pure canvas work in the page, so the menu can show the player the exact
   * frame that will be sent — and what was measured in it — before anything is uploaded or a session
   * is asked for a single frame. A picture whose horizon cannot be found is still usable; the note
   * beside it says what was done instead of pretending it was measured.
   */
  const pickLandscape = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared so choosing the same file twice fires a change event the second time.
    event.target.value = "";
    if (!file) return;

    setUploadError(undefined);
    setPreparing(true);
    try {
      world.selectLandscape(await prepareLandscape(file));
    } catch (cause) {
      setUploadError(
        cause instanceof LandscapeError ? cause.message : "That image could not be prepared.",
      );
    } finally {
      setPreparing(false);
    }
  }, []);

  const clearLandscape = useCallback(() => {
    world.selectLandscape(null);
    setUploadError(undefined);
  }, []);

  return (
    <main
      className="app-shell menu"
      data-world={environment}
      data-world-tone={tone}
      data-entering={entering ? "true" : undefined}
      data-returning={returning ? "true" : undefined}
    >
      <div className="menu-backdrop" aria-hidden="true">
        <span className="menu-scrim" />
        <span className="menu-dust" />
        <span className="menu-grid" />
      </div>

      <header className="menu-topbar">
        <span className="menu-wordmark">
          WATCHME<span>RUN</span>
        </span>
        <button
          className={`engine-chip engine-${tone}`}
          type="button"
          onClick={() => tone === "local" && world.retry()}
          data-world-status={worldState.status}
          data-world-video={worldState.videoState}
        >
          <span className="engine-dot" />
          {worldLabel(worldState)}
        </button>
      </header>

      <section className="menu-layout">
        <div className="menu-intro">
          <span className="eyebrow">Live world runner / Orbis</span>
          <h1 className="menu-title">
            RUN THE
            <br />
            WORLD INTO
            <br />
            <em>BEING</em><span className="menu-dot">.</span>
          </h1>
          <p className="menu-lede">
            Pick a world and a runner, then go. Orbis generates the world around you while you
            run, and it answers how you play — every near miss, stumble, and sprint changes what
            the world does next.
          </p>
          <ul className="menu-facts">
            <li><b>03</b> Worlds</li>
            <li><b>1080p</b> Generated live</li>
            <li><b>1</b> Continuous shot</li>
          </ul>
        </div>

        <div className="menu-stage">
          <div className="stage-frame">
            <Suspense fallback={<div className="stage-loading">Loading runner…</div>}>
              <CharacterPreview characterId={characterId} />
            </Suspense>
            {tone === "live" && <span className="stage-live">Live world</span>}
            <span className="stage-world">{selected.label}</span>
          </div>
          <div className="stage-caption">
            <strong>{character?.label ?? "Runner"}</strong>
            <small>run · jump · slide · stumble</small>
          </div>
          <div className="runner-rail">
            {characterCatalog.map((item, index) => (
              <button
                key={item.id}
                className={`rail-card ${item.id === characterId ? "selected" : ""}`}
                onClick={() => setCharacterId(item.id)}
                aria-pressed={item.id === characterId}
                type="button"
              >
                <span className="rail-index">0{index + 1}</span>
                <span className="rail-name">{item.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="menu-worlds">
          <div className="section-heading">
            <span className="eyebrow">Choose your world</span>
            <span className="heading-note">{generating ? "Generating behind you" : "Generated as you run"}</span>
          </div>
          {worlds.map((item) => (
            <button
              key={item.id}
              className={`world-card world-${item.id} ${item.id === environment ? "selected" : ""}`}
              onClick={() => setEnvironment(item.id)}
              aria-pressed={item.id === environment}
              type="button"
            >
              <span className="world-index">{item.index}</span>
              <span className="world-copy">
                <strong>{item.label}</strong>
                <small>{item.tagline}</small>
                <span className="world-hazards">
                  {item.hazards.map((hazard) => (
                    <i key={hazard}>{hazard}</i>
                  ))}
                  {item.id === environment && generating && (
                    <i className="is-live">{tone === "live" ? "On screen now" : "Loading…"}</i>
                  )}
                </span>
              </span>
              <span className="world-arrow">↗</span>
            </button>
          ))}
          {/*
            The landscape is optional and sits with the world cards because it is the same kind of
            choice: which place this is. It replaces the world's scenery, not the world — the card
            above it still decides the pacing, the obstacles and the road.
          */}
          <div className="landscape-block" data-state={preparing ? "preparing" : landscape ? "ready" : "empty"}>
            <div className="section-heading">
              <span className="eyebrow">Run in your own picture</span>
              <span className="heading-note">
                {pinning && landscape ? "Pinning into the world…" : landscape ? "Your landscape" : "Optional"}
              </span>
            </div>

            {landscape ? (
              <div
                className="landscape-card"
                data-landscape={landscape.label}
                data-source-horizon={landscape.sourceHorizon?.toFixed(4) ?? ""}
                data-placed={landscape.placed ? "true" : "false"}
                data-seed={landscape.seed}
              >
                <img className="landscape-shot" src={landscape.preview} alt={`Prepared landscape: ${landscape.label}`} />
                <span className="landscape-copy">
                  <strong>{landscape.label}</strong>
                  <small>{landscapeNote(landscape)}</small>
                </span>
                <button
                  className="landscape-clear"
                  onClick={clearLandscape}
                  type="button"
                  aria-label="Remove your landscape"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                className="landscape-drop"
                onClick={() => fileInput.current?.click()}
                disabled={preparing}
                type="button"
              >
                <span className="landscape-icon">{preparing ? "···" : "＋"}</span>
                <span>{preparing ? "Measuring your picture…" : "Upload an image to run inside"}</span>
              </button>
            )}

            <input
              ref={fileInput}
              className="landscape-input"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif"
              onChange={pickLandscape}
              aria-label="Landscape image"
            />

            {landscape ? (
              <p className="landscape-hint">
                Its horizon is placed on the game's horizon line, so you run on its ground and under
                its sky.
              </p>
            ) : (
              <p className="landscape-hint">
                Any photo works. We measure its horizon and put it where the game's ground meets its
                sky. Pictures without people in them work best — the runner should be the only one on
                screen.
              </p>
            )}
            {uploadError && <p className="menu-note">{uploadError}</p>}
          </div>

          <button
            className="start-button"
            onClick={() => onStart(environment, characterId)}
            disabled={entering || pinning}
            data-pinning={pinning ? "true" : "false"}
            type="button"
          >
            <span>
              {pinning
                ? "Pinning your landscape…"
                : `Start ${landscape ? `${landscape.label} run` : `${selected.label} run`}`}
            </span>
            <b>{pinning ? "" : "→"}</b>
          </button>
          <p className="menu-controls">← → lanes · ↑ jump · ↓ slide · space pause</p>
          {worldState.error && <p className="menu-note">World link: {worldState.error}</p>}
        </div>
      </section>
    </main>
  );
}
