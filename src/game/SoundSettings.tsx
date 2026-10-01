import { setMuted, setVolume, useSoundSettings } from "./audio";

/**
 * The sound controls: one mute switch and one volume slider, for the two sounds the game owns.
 *
 * It is one component used in two places rather than two controls that agree by convention. The menu
 * and the pause overlay are the same question asked at different moments — "make this quieter" is
 * something a player wants before a run starts and again the second a run gets loud — and two
 * implementations of it would eventually show two different answers. The state itself lives in
 * `./audio`, so the panel is a view of it and not a second copy.
 *
 * The label says what it moves, and what it does not: this is the game's own sound (the music and the
 * pickup). The world's generated soundtrack is Orbis's and is left alone, which is worth stating on
 * the control rather than leaving a player to discover that muting here does not silence the city.
 *
 * `compact` is the menu's top bar: one row, no heading and no hint, because the menu keeps its sound
 * control on screen at all times and a panel that has to be scrolled to is not a control.
 */
export default function SoundSettings({ compact = false }: { compact?: boolean }) {
  const { muted, volume } = useSoundSettings();
  const percent = Math.round(volume * 100);

  if (compact) {
    return (
      <div className="sound-settings sound-compact" data-muted={muted ? "true" : "false"}>
        <button
          className="sound-toggle"
          type="button"
          aria-pressed={muted}
          title={muted ? "Game sound is muted" : "Game sound is on"}
          onClick={() => setMuted(!muted)}
        >
          {muted ? "Sound off" : "Sound on"}
        </button>
        <input
          className="sound-range"
          type="range"
          min={0}
          max={100}
          step={1}
          value={percent}
          onChange={(event) => setVolume(Number(event.target.value) / 100)}
          aria-label="Game sound volume"
        />
        <span className="sound-value" data-muted={muted ? "true" : "false"}>
          {muted ? "—" : `${percent}%`}
        </span>
      </div>
    );
  }

  return (
    <div className="sound-settings" data-muted={muted ? "true" : "false"}>
      <div className="sound-heading">
        <span className="eyebrow">Game sound</span>
        <button
          className="sound-toggle"
          type="button"
          aria-pressed={muted}
          onClick={() => setMuted(!muted)}
        >
          {muted ? "Muted" : "On"}
        </button>
      </div>

      <label className="sound-row">
        <input
          className="sound-range"
          type="range"
          min={0}
          max={100}
          step={1}
          value={percent}
          onChange={(event) => setVolume(Number(event.target.value) / 100)}
          aria-label="Game sound volume"
        />
        <span className="sound-value" data-muted={muted ? "true" : "false"}>
          {muted ? "—" : `${percent}%`}
        </span>
      </label>

      <p className="sound-hint">Music and pickups only — the world's generated soundtrack is not affected.</p>
    </div>
  );
}
