import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { CharacterId } from "./game/character-catalog";
import { characterCatalog } from "./game/character-catalog";
import type { Environment } from "./game/run-state";
import { worlds } from "./game/worlds";
import { LandscapeError, landscapeNote, prepareLandscape } from "./orbis/landscape";
import { menuWorldLabel, useWorld, world, worldTone } from "./orbis/world-bus";

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
  const character = characterCatalog.find((item) => item.id === characterId);
  const selected = worlds.find((item) => item.id === environment) ?? worlds[0];
  const tone = worldTone(worldState);

  /**
   * The menu stages a choice and asks Orbis for nothing.
   *
   * It used to start generating the moment it mounted, so that by the time the player pressed Start
   * there was a world behind them to dive into. That world was billed for as long as it was ready —
   * frames generated for a menu, at whatever rate the chunk loop was set to — and the landscape the
   * player picked rebuilt the session while they were still looking at the menu. Both now belong to
   * the run: pressing Start opens the loading screen, and the world is asked for there (`WorldLoader`
   * requests it, the world layer arms it, and the run begins when it is armed).
   *
   * What the menu still does is publish which world *will* be asked for, because the local backdrop
   * behind it is that world's tint.
   */
  useEffect(() => {
    world.select(environment);
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
          {menuWorldLabel(worldState)}
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
            <span className="heading-note">Generated when you start</span>
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
              <span className="heading-note">{landscape ? "Pinned when you start" : "Optional"}</span>
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
                its sky. It is pinned into the world when you start, not here.
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
            disabled={entering}
            type="button"
          >
            <span>{`Start ${landscape ? `${landscape.label} run` : `${selected.label} run`}`}</span>
            <b>→</b>
          </button>
          <p className="menu-controls">← → lanes · ↑ jump · ↓ slide · space pause</p>
          {worldState.error && <p className="menu-note">World link: {worldState.error}</p>}
          {/* The scenery packs are CC-BY-4.0, which asks for the author to be credited where the work
              is shown. This is that credit, in the one screen every run starts from. */}
          <p className="menu-credits">
            Scenery packs (CC-BY-4.0):{" "}
            <a
              href="https://sketchfab.com/3d-models/low-poly-trees-flowers-and-grass-442904f26b87407d98871b50b49c4169"
              target="_blank"
              rel="noreferrer"
            >
              trees
            </a>{" "}
            by Márcio Meireles,{" "}
            <a
              href="https://sketchfab.com/3d-models/desert-rock-fixed-pack-00c4468f1bca48509d7d2bd66b564cbc"
              target="_blank"
              rel="noreferrer"
            >
              rocks
            </a>{" "}
            by Erroratten,{" "}
            <a
              href="https://sketchfab.com/3d-models/lowpoly-city-street-pack-buildings-stylized-8e1ba8a437c4460eaaa643953eaf79d0"
              target="_blank"
              rel="noreferrer"
            >
              city
            </a>{" "}
            by haykel-shaba.
          </p>
        </div>
      </section>
    </main>
  );
}
