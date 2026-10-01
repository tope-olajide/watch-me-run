import { useSyncExternalStore } from "react";
import musicUrl from "../../sounds/bgm.mp3?url";
import coinUrl from "../../sounds/koiroylers-get-coin-351945.mp3?url";

/**
 * The game's own sound: a track the whole visit shares, and a pickup effect that fires the moment a
 * token is taken.
 *
 * ## It is the game's layer, not the world's
 *
 * Orbis generates a soundtrack with the picture and the world layer plays it — the generated audio is
 * wanted everywhere, and a run takes it (`src/orbis/WorldLayer.tsx`). These two files are therefore
 * the *game's* sound sitting on top of a world that is already making noise, and that is exactly what
 * the settings control: what the player turns down with the sound panel is the music and the pickup,
 * and the world's generated audio is left where it was. Folding the two together would mean a player
 * who only wanted the music quieter losing the world they came for.
 *
 * ## One track, from the first click
 *
 * A browser will not start audio without a gesture, and the menu deliberately asks Orbis for nothing
 * — so by the time a run begins the mouse click on Start is 20-40 s of loading screen behind it and no
 * longer counts as one. The track is armed on the first interaction anywhere in the page instead
 * (`installAudioUnlock`) and never stopped after that: the menu, the dive and the run are one
 * continuous soundtrack, rather than a track that starts late, or starts again over itself.
 *
 * ## Levels are kept in `localStorage`
 *
 * Muted and the volume are the player's, not the visit's: both persist under `watchme-run:sound` and
 * are validated on read, so a hand-edited or stale value cannot open the page at 400% volume. Reading
 * and writing are wrapped — a blocked store means the settings simply do not persist.
 *
 * ## Every change of level is a fade
 *
 * A music bed that starts at full level, or that snaps to silence when the mute switch is pressed, is
 * heard as an edit rather than as a setting. So the element is never *set* to a level: it is moved to
 * one — slowly on the way in (it has to arrive under the player rather than on top of them) and
 * quickly for mute, unmute and the slider, where a long ramp would read as the control being broken.
 * The pickup is deliberately not faded: it is a one-shot a few hundred milliseconds long, and its
 * level is decided when it is played.
 */

export type SoundSettings = {
  muted: boolean;
  volume: number;
};

const STORAGE_KEY = "watchme-run:sound";
const DEFAULT_SETTINGS: SoundSettings = { muted: false, volume: 0.6 };

/**
 * The mix.
 *
 * The track beds under the pickup rather than competing with it, which is why it carries the lower
 * gain: a run takes tokens by the dozen, and a sound effect that is *supposed* to be noticed has to
 * sit above a bed that is not.
 */
const MUSIC_GAIN = 0.45;
const COIN_GAIN = 0.75;

/**
 * The fades.
 *
 * The one on the way in is long because the track is arriving under a player who is reading the menu;
 * the one on a change is short because it is *answering* a control they just touched — long enough
 * that the mute is not a click, short enough that the slider still feels connected to the finger.
 */
const MUSIC_FADE_IN_MS = 1600;
const MUSIC_FADE_MS = 320;

/**
 * How many pickup voices overlap.
 *
 * One element restarted per pickup would cut the previous one short, and a run can take two tokens
 * inside a second — a pair of coins and a fast lane change is routine. Four is past the point where
 * another voice changes anything anyone can hear.
 */
const COIN_VOICES = 4;

function readSettings(): SoundSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const stored = JSON.parse(raw) as Partial<SoundSettings>;
    return {
      muted: stored.muted === true,
      volume:
        typeof stored.volume === "number" && Number.isFinite(stored.volume)
          ? Math.min(1, Math.max(0, stored.volume))
          : DEFAULT_SETTINGS.volume,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let settings = readSettings();
const listeners = new Set<() => void>();

function snapshot(): SoundSettings {
  return settings;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The settings, for the interface. The snapshot keeps its identity until something changes. */
export function useSoundSettings(): SoundSettings {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function publish(next: SoundSettings): void {
  settings = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A blocked store costs the player their preference next visit, and nothing else.
  }
  mix();
  for (const listener of listeners) listener();
}

export function setMuted(muted: boolean): void {
  publish({ ...settings, muted });
}

export function setVolume(volume: number): void {
  publish({ ...settings, volume: Math.min(1, Math.max(0, volume)) });
}

/* ---- the elements ---------------------------------------------------------------------------- */

let music: HTMLAudioElement | undefined;
let voices: HTMLAudioElement[] = [];
let nextVoice = 0;

/** A level, from the shared setting and one layer's own gain. */
function level(gain: number): number {
  return settings.muted ? 0 : Math.min(1, Math.max(0, settings.volume * gain));
}

/** One element's level, set directly — the pickup voices, which are one-shots and never fade. */
function applyGain(element: HTMLAudioElement, gain: number): void {
  element.volume = level(gain);
}

/** Everything the settings own, re-levelled. Called on every change. */
function mix(): void {
  rampMusic(MUSIC_FADE_MS);
  for (const voice of voices) applyGain(voice, COIN_GAIN);
}

let fadeFrame = 0;

function cancelFade(): void {
  if (!fadeFrame) return;
  window.cancelAnimationFrame(fadeFrame);
  fadeFrame = 0;
}

/**
 * Moves the music to the level the settings ask for, over `duration`.
 *
 * Driven from `requestAnimationFrame` rather than a timer because what is being changed is an
 * `HTMLMediaElement.volume`: stepping it per frame ties the fade to the tab's own clock, so a
 * backgrounded tab stops fading instead of racing to the end of a timer and being there already when
 * the player comes back. A ramp already running is abandoned rather than queued — the newest request
 * is the level the player wants, and the ones they dragged past are owed nothing. That also means a
 * fade-in interrupted by a mute fades out from wherever it had got to, which is the whole point.
 */
function rampMusic(duration: number): void {
  if (!music) return;
  cancelFade();

  const target = level(MUSIC_GAIN);
  const from = music.volume;
  if (duration <= 0 || Math.abs(target - from) < 0.002) {
    music.volume = target;
    return;
  }

  const started = window.performance.now();
  const step = (now: number) => {
    if (!music) {
      fadeFrame = 0;
      return;
    }
    // Clamped at both ends, and the lower end is not theoretical: an animation frame's timestamp is the
    // frame's own start time, which can *precede* the `performance.now()` that scheduled this fade, so
    // the first callback can compute a progress a hair below zero. On the way up from silence that is a
    // negative volume, which `HTMLMediaElement.volume` refuses with an `IndexSizeError` — the one fade
    // that starts at exactly zero is unmute, so the exception landed on the control the player had just
    // pressed. Caught by `tools/flow-probe.mjs`, of all things, which treats a console exception as a
    // fault.
    const progress = Math.min(1, Math.max(0, (now - started) / duration));
    music.volume = Math.min(1, Math.max(0, from + (target - from) * progress));
    fadeFrame = progress < 1 ? window.requestAnimationFrame(step) : 0;
  };
  fadeFrame = window.requestAnimationFrame(step);
}

/** The pickup voices, created on first use and then kept: a token can arrive at any moment. */
function ensureVoices(): HTMLAudioElement[] {
  if (!voices.length) {
    voices = Array.from({ length: COIN_VOICES }, () => {
      const element = new Audio(coinUrl);
      element.preload = "auto";
      applyGain(element, COIN_GAIN);
      return element;
    });
  }
  return voices;
}

function createMusic(): HTMLAudioElement {
  const element = new Audio(musicUrl);
  element.loop = true;
  element.preload = "auto";
  // Silent until `startMusic` has been allowed to play, and then ramped up from here.
  element.volume = 0;
  return element;
}

/**
 * Starts the track, or does nothing when it is already playing.
 *
 * Rejects when the browser refuses the play, and the caller is expected to treat that as "not yet"
 * rather than as a failure — see `installAudioUnlock`. Muting does not stop it: a muted player still
 * gets the soundtrack the moment they unmute, with no second gesture, and the fade below means they
 * get it arriving rather than switching on.
 */
export function startMusic(): Promise<void> {
  music ??= createMusic();
  if (!music.paused) return Promise.resolve();
  // Silent before the play: a rejected play must not leave the bed at level, and the ramp below is
  // what puts it there once the browser has actually accepted it.
  music.volume = 0;
  return music.play().then(() => {
    rampMusic(MUSIC_FADE_IN_MS);
  });
}

/**
 * Only for a surface that genuinely owns the sound being over; nothing in the game calls it today.
 *
 * No fade: the track belongs to the visit rather than to a run, so a run that ends does not stop it,
 * and a caller that really does want it gone wants it gone now.
 */
export function stopMusic(): void {
  cancelFade();
  music?.pause();
}

let unlockInstalled = false;

/**
 * Arms the track on the first interaction anywhere in the page.
 *
 * The listener is removed once the music has actually started, so a page that never gets a gesture
 * costs nothing. It is deliberately *not* removed on a refusal — an autoplay policy that rejects this
 * click may accept the next one, and the difference between the two is the difference between a
 * soundtrack and silence.
 */
export function installAudioUnlock(): void {
  if (unlockInstalled || typeof window === "undefined") return;
  unlockInstalled = true;

  const events = ["pointerdown", "keydown"] as const;
  const attempt = () => {
    // The pickup is warmed with the track. It is a 99 KB file next to a 3.7 MB one, and the only
    // alternative is the first token of the first run arriving while the browser is still fetching
    // it — which is the one pickup of the run a player is guaranteed to notice.
    ensureVoices();
    void startMusic().then(
      () => {
        for (const event of events) window.removeEventListener(event, attempt);
      },
      () => undefined,
    );
  };
  for (const event of events) window.addEventListener(event, attempt);
}

/**
 * One token taken.
 *
 * Silent while muted or at zero volume, so a muted player is not paying for a decode per pickup.
 */
export function playCoin(): void {
  if (settings.muted || settings.volume <= 0) return;
  const pool = ensureVoices();

  const voice = pool[nextVoice];
  nextVoice = (nextVoice + 1) % pool.length;
  applyGain(voice, COIN_GAIN);
  try {
    voice.currentTime = 0;
  } catch {
    // Seeking before metadata arrives throws in some browsers; the voice plays from the top anyway.
  }
  void voice.play().catch(() => undefined);
}

/* ---- published for the probes ----------------------------------------------------------------
 * What the settings are, and what the sound is doing about them: `volume` is the mixed level on the
 * actual element rather than the setting, because "the slider moved" and "the element got quieter"
 * are different claims (see `tools/frame-report.mjs` for the same reasoning about the visuals).
 */
type SoundReport = {
  settings: SoundSettings;
  music: {
    started: boolean;
    paused: boolean;
    /** The level at this instant, which during a fade is the ramp in progress rather than the target. */
    volume: number;
    target: number;
    loop: boolean;
    /** The file that actually loaded, and how long it says it is: the encode, verified from the page. */
    source: string;
    duration: number;
  } | null;
  coinVoices: number;
  coinGain: number;
  musicGain: number;
};

if (typeof window !== "undefined") {
  (window as unknown as { __sound?: () => SoundReport }).__sound = () => ({
    settings: { ...settings },
    music: music
      ? {
          started: true,
          paused: music.paused,
          volume: music.volume,
          target: level(MUSIC_GAIN),
          loop: music.loop,
          source: music.currentSrc.split("/").pop() ?? "",
          duration: Number.isFinite(music.duration) ? music.duration : 0,
        }
      : null,
    coinVoices: voices.length,
    coinGain: COIN_GAIN,
    musicGain: MUSIC_GAIN,
  });
}
