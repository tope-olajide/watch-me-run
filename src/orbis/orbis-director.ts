import type { RunState, WorldEvent } from "../game/run-state";
import { audioEventPrompt, audioPrompt, eventPrompt, openingPrompt, type WorldView } from "./prompts";

export type PromptSender = (prompt: string) => Promise<void>;

export type OrbisDirectorOptions = {
  sendPrompt: PromptSender;
  /**
   * The sound channel. Optional: a director without it still steers the picture, which is what the
   * game had before the sound was wired up, and what it falls back to if the deployment has no
   * audio track.
   */
  sendAudio?: PromptSender;
  /** True when the world is grown from a picture the player supplied, so the prompts continue it. */
  custom?: () => boolean;
  cooldownMs?: number;
  now?: () => number;
};

/**
 * The opening seconds of a run belong to the dive: the launch prompt is asking for the camera to
 * push into the world, and a distance event firing under it would overwrite that shot with
 * "traveled 12 meters". Events are dropped, not queued, for this window — a first event delivered
 * late is worse than a first event never delivered.
 */
export const RUN_QUIET_MS = 2400;


/**
 * Converts deterministic runner events into sparse, intentional Orbis updates.
 * The runner remains playable if the sender fails or the stream is unavailable.
 */
export class OrbisDirector {
  private readonly sendPrompt: PromptSender;
  private readonly sendAudio?: PromptSender;
  private readonly custom: () => boolean;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private lastPrompt = "";
  private lastAudio = "";
  private lastSentAt = -Infinity;
  private pending: { state: RunState; event: WorldEvent; priority: boolean } | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private quietUntil = -Infinity;
  /** The chunk the world is on, and the one this director last spent an ask in. */
  private chunk = 0;
  private sentInChunk = -1;

  public constructor(options: OrbisDirectorOptions) {
    this.sendPrompt = options.sendPrompt;
    this.sendAudio = options.sendAudio;
    this.custom = options.custom ?? (() => false);
    this.cooldownMs = options.cooldownMs ?? 1800;
    this.now = options.now ?? Date.now;
  }

  public async start(view: WorldView): Promise<void> {
    await this.deliver(openingPrompt(view), audioPrompt(view));
  }

  /**
   * Called when a run takes over the world. The launch prompt is sent by the entering transition
   * before this runs, so the cooldown is measured from there and the dive window is protected.
   */
  public markRunStart(quietMs = RUN_QUIET_MS): void {
    this.lastSentAt = this.now();
    this.quietUntil = this.now() + quietMs;
  }

  /**
   * @param options.priority A milestone rather than a routine update. Only one event is ever queued,
   * so without this a tier crossing could be replaced by the next distance milestone and never reach
   * the world at all. A priority event claims the slot; a routine one leaves it alone.
   */
  public async trigger(
    state: RunState,
    event: WorldEvent,
    options?: { priority?: boolean },
  ): Promise<void> {
    if (event.type === "run_ended") return;
    if (this.now() < this.quietUntil) return;

    const hold = this.hold();
    if (hold) {
      if (options?.priority || !this.pending?.priority) {
        this.pending = { state, event, priority: options?.priority ?? false };
      }
      // A held chunk is released by the next boundary, so only the cooldown needs a timer.
      if (hold === "cooldown") this.scheduleFlush();
      return;
    }

    await this.emit(state, event);
  }

  public async flush(state: RunState): Promise<void> {
    if (!this.pending || this.hold()) return;

    const pending = this.pending;
    this.pending = null;
    await this.emit(state, pending.event);
  }

  /**
   * A chunk of the world just finished (Orbis's own `chunk_complete`).
   *
   * The world reads its prompt at a chunk boundary, so a prompt sent a moment after one is read at
   * the top of the next chunk, with the whole chunk's lead time ahead of it. When an event has been
   * waiting out the cooldown, this is the moment to hand it over — rather than the wall-clock timer,
   * which fires wherever in a chunk it happens to land.
   */
  public onChunk(index: number): void {
    this.chunk = index;
    if (!this.pending || this.hold()) return;

    const pending = this.pending;
    this.pending = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    void this.emit(pending.state, pending.event);
  }

  public reset(): void {
    this.lastPrompt = "";
    this.lastAudio = "";
    this.lastSentAt = -Infinity;
    this.quietUntil = -Infinity;
    this.sentInChunk = -1;
    this.pending = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  /**
   * Why an ask cannot be spent right now, or null when it can.
   *
   * One prompt is read per chunk — the world takes the prompt in force when it starts a chunk — so an
   * ask sent after this chunk has already taken one is overwritten before the model ever reads it.
   * That is the whole reason the chunk signal is subscribed to, and the rule has no time limit on it
   * on purpose. A long chunk, a paused world, a stalled generation: waiting is free, because a prompt
   * sent then would still only be read at the next boundary, and the newest pending event is the one
   * worth sending when that boundary comes. A cap would buy latency in a world that is not moving any
   * picture, at the price of spending asks on nothing.
   */
  private hold(): "cooldown" | "chunk" | null {
    if (this.now() - this.lastSentAt < this.cooldownMs) return "cooldown";
    if (this.sentInChunk === this.chunk) return "chunk";
    return null;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    const wait = Math.max(0, this.cooldownMs - (this.now() - this.lastSentAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (!this.pending) return;
      const hold = this.hold();
      // Held by the chunk: the boundary releases it, so the timer must not spin waiting.
      if (hold === "chunk") return;
      if (hold === "cooldown") {
        this.scheduleFlush();
        return;
      }
      const pending = this.pending;
      this.pending = null;
      void this.emit(pending.state, pending.event);
    }, wait);
  }

  /** One event, on both channels: the picture and the sound it makes. */
  private async emit(state: RunState, event: WorldEvent): Promise<void> {
    const view: WorldView = { environment: state.environment, custom: this.custom() };
    await this.deliver(eventPrompt(state, event, view), audioEventPrompt(state, event, view));
  }

  private async deliver(prompt: string, audio: string): Promise<void> {
    // The two channels are deduped separately: a run can legitimately hold the same sound bed while
    // the picture moves on, and re-sending an unchanged caption is a command spent on nothing.
    await Promise.all([this.sendOnce(prompt, "video"), this.sendOnce(audio, "audio")]);
  }

  private async sendOnce(prompt: string, track: "video" | "audio"): Promise<void> {
    const send = track === "audio" ? this.sendAudio : this.sendPrompt;
    if (!send) return;
    if (prompt === (track === "audio" ? this.lastAudio : this.lastPrompt)) return;

    try {
      await send(prompt);
      if (track === "audio") this.lastAudio = prompt;
      else this.lastPrompt = prompt;
      // The cooldown follows the picture, not the sound: the sound rides along with a visual prompt
      // and never spends an ask of its own.
      if (track === "video") {
        this.lastSentAt = this.now();
        this.sentInChunk = this.chunk;
      }
    } catch {
      // Orbis is an enhancement layer. Gameplay must continue if a prompt fails.
    }
  }
}
