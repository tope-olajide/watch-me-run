import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { CharacterId } from "./game/character-catalog";
import { characterCatalog } from "./game/character-catalog";
import SoundSettings from "./game/SoundSettings";
import type { Environment } from "./game/run-state";
import { readRecords } from "./game/records";
import { readWorldChoice, rememberWorldChoice, worlds } from "./game/worlds";
import {
  CONTRACTS,
  readContract,
  readUnlockedDeals,
  rememberContract,
  unlockDeal,
  type Contract,
} from "./game/contracts";
import { readBank } from "./game/bank";
import { LandscapeError, landscapeNote, prepareLandscape } from "./orbis/landscape";
import { clearLandscapeFile, loadLandscapeFile, saveLandscapeFile } from "./orbis/landscape-store";
import { menuWorldLabel, useWorld, world, worldTone } from "./orbis/world-bus";

/**
 * The deals on the table, and the bank that unlocks them.
 *
 * The picker inside a run can only *choose* a deal, because a run is the wrong place to be making a
 * purchase: the player is mid-decision, the card is already up, and a price with a balance under it
 * would turn a run into a shop. So the buying lives here, on the screen every run starts from — and it
 * is the reason a run's tokens mean anything after the card: the deals that pay the most are the ones
 * that have to be unlocked, and the only way to get them is to run for them.
 */
function DealsRow({
  current,
  unlocked,
  bank,
  onPick,
  onUnlock,
}: {
  current: Contract;
  unlocked: string[];
  bank: number;
  onPick: (deal: Contract) => void;
  onUnlock: (deal: Contract) => void;
}) {
  return (
    <div className="menu-deals" role="group" aria-label="Terms">
      <span className="menu-deals-label">
        Terms · <b>{bank}</b> tokens banked
      </span>
      <div className="menu-deal-cards">
        {CONTRACTS.map((deal) => {
          const locked = deal.cost > 0 && !unlocked.includes(deal.id);
          return (
            <div key={deal.id} className="menu-deal" data-deal={deal.id} data-locked={locked ? "true" : "false"}>
              <button
                type="button"
                className="menu-deal-pick"
                data-selected={deal.id === current.id ? "true" : "false"}
                disabled={locked}
                title={deal.rule}
                onClick={() => onPick(deal)}
              >
                <b>{deal.name}</b>
                <small>{locked ? `${deal.cost} tokens to unlock` : deal.terms}</small>
              </button>
              {locked && (
                <button
                  type="button"
                  className="menu-deal-unlock"
                  disabled={bank < deal.cost}
                  title={
                    bank < deal.cost
                      ? `Needs ${deal.cost - bank} more banked tokens`
                      : `Pay ${deal.cost} banked tokens`
                  }
                  onClick={() => onUnlock(deal)}
                >
                  unlock · {deal.cost}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const CharacterPreview = lazy(() => import("./game/CharacterPreview"));

type MenuExperienceProps = {
  onStart: (environment: Environment, characterId: CharacterId) => void;
  /** True while the world dive plays: the menu is on its way out and takes no input. */
  entering?: boolean;
  /** True when the menu is arriving back from a run, which plays its own entrance. */
  returning?: boolean;
};

export default function MenuExperience({ onStart, entering = false, returning = false }: MenuExperienceProps) {
  // The world the player chose last visit, when there is one: the menu opens on the place they left.
  const [environment, setEnvironment] = useState<Environment>(() => readWorldChoice() ?? "desert");
  const [characterId, setCharacterId] = useState<CharacterId>("amy");
  const [preparing, setPreparing] = useState(false);
  const [uploadError, setUploadError] = useState<string>();
  /**
   * The best run in each world, read once when the menu mounts.
   *
   * Read here rather than after a run because the menu is remounted on the way back from one (`App`
   * swaps the surfaces), so a fresh mount is exactly when the records can have changed.
   */
  const [records] = useState(() => readRecords());
  /**
   * The deal and the bank, read the same way and for the same reason as the records: the menu is
   * remounted on the way back from a run, so a fresh mount is when both can have changed.
   */
  const [contract, setContract] = useState<Contract>(() => readContract());
  const [unlocked, setUnlocked] = useState<string[]>(() => readUnlockedDeals());
  const [bank, setBank] = useState(() => readBank());
  const [dealNote, setDealNote] = useState<string>();
  /**
   * The instructions, on demand.
   *
   * The menu used to carry the controls as a line under the Start button and the game's premise as a
   * paragraph beside the title. Both are the game explaining itself to someone who has already
   * decided to play, and both pushed the controls a player actually needs — Start, and the sound —
   * down the page. They live behind one button now.
   */
  const [helpOpen, setHelpOpen] = useState(false);
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
    rememberWorldChoice(environment);
  }, [environment]);

  useEffect(() => {
    if (!helpOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHelpOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [helpOpen]);

  /**
   * Choosing a deal, and buying one.
   *
   * A purchase is reported in the same place the choice is made rather than in an alert: the balance
   * moves under the label, the chip stops saying "locked", and a refusal says what it needs instead of
   * failing silently. Buying also *takes* the deal — a player who has just paid for Glass cannon has
   * already decided to run it.
   */
  const pickDeal = useCallback(
    (deal: Contract) => {
      if (deal.cost > 0 && !unlocked.includes(deal.id)) return;
      setContract(deal);
      rememberContract(deal.id);
      setDealNote(undefined);
    },
    [unlocked],
  );

  const buyDeal = useCallback((deal: Contract) => {
    const bought = unlockDeal(deal.id);
    if (!bought.ok) {
      setDealNote(`${deal.name} costs ${deal.cost} banked tokens — this run has not paid for it yet.`);
      return;
    }
    setBank(bought.balance);
    setUnlocked(readUnlockedDeals());
    setContract(deal);
    rememberContract(deal.id);
    setDealNote(`${deal.name} unlocked — ${bought.cost} tokens spent. It is what you will run.`);
  }, []);

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
      // Kept for the next visit, not waited for: the menu is already showing the prepared picture.
      void saveLandscapeFile(file);
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
    // Removed here means removed: a picture the player deleted must not reappear on the next visit.
    void clearLandscapeFile();
  }, []);

  /**
   * The picture from the last visit, prepared again on mount.
   *
   * It is stored as the file the player chose (see `landscape-store`) and run back through the same
   * preparation as a fresh upload, so the restored landscape is the identical object — same crop,
   * same measured horizon, same seed, same preview — rather than a cached copy that could drift from
   * what the code produces now. Until it lands the block reads as empty, which is honest: there is
   * nothing to show yet, and the drop control is still there if they would rather pick something
   * else.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const file = await loadLandscapeFile();
      if (!file || cancelled) return;
      setPreparing(true);
      try {
        const restored = await prepareLandscape(file);
        if (!cancelled) world.selectLandscape(restored);
      } catch {
        // A file the browser can no longer decode is not worth keeping, and not worth an error:
        // the player simply has no landscape, exactly as if they had never uploaded one.
        await clearLandscapeFile();
      } finally {
        if (!cancelled) setPreparing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
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

      {/*
        One bar, everything a player needs before a run: the name, the world's state, the sound, and
        the instructions. The controls used to be a line at the bottom of the page and the sound a
        panel under it, which meant neither was on screen until the player scrolled — see
        `.start-dock` for the other half of that fix.
      */}
      <header className="menu-topbar">
        <span className="menu-wordmark">
          Watch<span>.</span>Me<span>.</span>Run
        </span>
        <div className="menu-tools">
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
          <SoundSettings compact />
          <button className="menu-help" type="button" onClick={() => setHelpOpen(true)}>
            How to play
          </button>
        </div>
      </header>

      <section className="menu-layout">
        {/* The world, and the terms under it: both are decisions about the same run. */}
        <div className="menu-column menu-column-worlds">
          <span className="menu-label">World</span>
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
                {/* A run that can be lost is worth a target, and the target has to be on the card the
                    player picks rather than behind a menu: this is the whole point of the record. */}
                {records[item.id] && (
                  <span className="world-best">
                    Best {records[item.id]?.score.toLocaleString()} · {records[item.id]?.distance}m
                  </span>
                )}
              </span>
              <span className="world-arrow">↗</span>
            </button>
          ))}
          <DealsRow current={contract} unlocked={unlocked} bank={bank} onPick={pickDeal} onUnlock={buyDeal} />
          {dealNote && <p className="menu-note">{dealNote}</p>}
        </div>

        {/* The runner, on the stage they are picked from. The frame takes whatever height the row has
            left, which is what keeps the whole menu on one screen. */}
        <div className="menu-stage">
          <div className="stage-frame">
            <Suspense fallback={<div className="stage-loading">Loading runner…</div>}>
              <CharacterPreview characterId={characterId} />
            </Suspense>
            <span className="stage-world">{selected.label}</span>
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

        {/* The picture, when the player has one: the same kind of choice as the world, one column
            over. The long explanation of what happens to an uploaded horizon lives in the
            instructions now. */}
        <div className="menu-column menu-column-picture">
          <span className="menu-label">Your picture</span>
          <div className="landscape-block" data-state={preparing ? "preparing" : landscape ? "ready" : "empty"}>
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
                <span>{preparing ? "Measuring your picture…" : "Run in your own picture"}</span>
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
          </div>

          {uploadError && <p className="menu-note">{uploadError}</p>}
          {worldState.error && <p className="menu-note">World link: {worldState.error}</p>}
        </div>
      </section>

      {/* The run starts here, and it is on screen no matter how tall the columns above it grow. */}
      <div className="start-dock">
        <span className="start-summary">
          {selected.label} · {character?.label ?? "Runner"}
          {landscape ? ` · ${landscape.label}` : ""}
        </span>
        <button
          className="start-button"
          onClick={() => onStart(environment, characterId)}
          disabled={entering}
          type="button"
        >
          <span>START RUN</span>
          <b>→</b>
        </button>
      </div>

      {helpOpen && (
        <div
          className="menu-modal"
          role="dialog"
          aria-modal="true"
          aria-label="How to play"
          onClick={() => setHelpOpen(false)}
        >
          <div className="menu-modal-card" onClick={(event) => event.stopPropagation()}>
            <header className="menu-modal-head">
              <span className="menu-label">How to play</span>
              <button
                className="menu-modal-close"
                type="button"
                onClick={() => setHelpOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </header>
            <div className="menu-modal-body">
              <section>
                <h3>Controls</h3>
                <p>
                  <b>←</b> <b>→</b> or <b>A</b> <b>D</b> — change lane · <b>↑</b> or <b>W</b> — jump ·{" "}
                  <b>↓</b> or <b>S</b> — slide · <b>Space</b> — pause
                </p>
              </section>
              <section>
                <h3>The run</h3>
                <p>
                  Run as far as you can. Your deal gives you a few hits — three, unless you took harder
                  terms — and a hit costs one. When they are gone the run is over.
                </p>
              </section>
              <section>
                <h3>Score</h3>
                <p>
                  Distance pays, and so does danger: near misses and gaps threaded between two obstacles
                  pay far more and build flow. Tokens pay points and bank up to unlock the harder deals.
                </p>
              </section>
              <section>
                <h3>Weather</h3>
                <p>
                  Every world brings its own: the desert sends a sandstorm that shoves you a lane, the
                  city blacks out, the forest closes in with fog.
                </p>
              </section>
              <section>
                <h3>Your picture</h3>
                <p>
                  Upload an image and run inside it. Its horizon is placed on the game's, so you run on
                  its ground under its sky.
                </p>
              </section>
            </div>
            {/* The scenery packs are CC-BY-4.0, which asks for the author to be credited where the work
                is shown. This is that credit, on the screen every run starts from. */}
            <footer className="menu-credits">
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
            </footer>
          </div>
        </div>
      )}
    </main>
  );
}
