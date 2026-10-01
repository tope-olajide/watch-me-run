
import { isPlayEvent, type RunState, type WorldEvent } from "../game/run-state";
import { audioEventPrompt, audioPrompt, eventPrompt, openingPrompt, type WorldView } from "./prompts";

/**
 * What a prompt was answering.
 *
 * The event and the run state it was read from, handed back with the send so the interface can say
 * *why* the world changed rather than only that it did. It travels through the director because the
 * director is what decides whether an ask is actually spent — an event held for a chunk and replaced
 * by a newer one never reached the world, and reporting it as a cause would be a lie about what the
 * player is looking at.
 */
export type PromptCause = {
  event: WorldEvent;
  state: RunState;
  chunk: number;
  /**
   * True when this ask is going out mid-chunk on the priority deadline rather than at a boundary.
   *
   * The deadline is the one sanctioned way a chunk's slot is spent twice: the ask that was already
   * sent in this slot is overwritten before the model reads it, because the priority event it is
   * making way for may not be dropped. The journal carries the flag so the audited runs can tell that
   * deliberate trade-off from a gate that failed.
   */
  deadline?: boolean;
};

export type PromptSender = (prompt: string, cause?: PromptCause) => Promise<void>;

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
 * How many asks may wait for a slot.
 *
 * Two is the number a run produces by coincidence: one play event arriving while another waits out a
 * chunk. A run's opening can legitimately produce three — the deal's acknowledgement, a hit and a
 * pickup, all while the chunk that read the dive prompt is still the current one — and then the cap
 * evicts the oldest ask. That is deliberately still a drop rather than a larger queue, because a
 * queue that grows is a world that has stopped producing slots and every entry in it is stale; the
 * one ask worth surviving the cap, the deal, is simply asked again (see `RunExperience`).
 */
const PENDING_LIMIT = 2;

/**
 * How long an ask that may not be dropped waits for a chunk boundary before it goes out anyway.
 *
 * A chunk boundary is where the world reads a prompt, so an ask held by the chunk normally waits for
 * one — free, because a prompt sent mid-chunk would be read at the same boundary anyway. The
 * exception is an ask that is never repeated: measured in the forest, the deal was asked once the
 * dive was over, the chunk that read the dive prompt stayed the current chunk for the rest of the
 * run, and the run ended with the ask still queued — `reset` cleared it and the world never said
 * what the run was taken under. Three seconds is longer than the quiet window plus the cooldown, so
 * a world that is producing boundaries never reaches this; one that has stopped gets the ask
 * mid-chunk, where it is still the newest prompt in force when the next chunk reads one, because
 * the hold keeps every other ask behind it.
 */
const PRIORITY_WAIT_MS = 3200;

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
  /**
   * The asks waiting for a slot, oldest first.
   *
   * This was one slot, and one slot could only ever hold the *newest* moment: a routine event
   * replaced a routine event, and — once play events were protected from the chatter — two play events
   * still fought over it. Measured in the desert: the sandstorm arrived, a hit landed while it was
   * waiting out the cooldown, the hit took the slot, and the storm the player was visibly being pushed
   * by was never answered at all. Now a play event is never overwritten by anything and the queue
   * drains one per slot (one prompt per chunk, unchanged); only routine updates still replace each
   * other, because a distance milestone from four seconds ago is not news.
   */
  private pending: { state: RunState; event: WorldEvent; priority: boolean; at: number }[] = [];
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
   * @param options.priority A milestone rather than a routine update, when the caller knows better
   * than `isPlayEvent`. A play event is never overwritten; a routine one is, by the next routine one,
   * because the newest distance milestone is the only one worth spending an ask on.
   */
  public async trigger(
    state: RunState,
    event: WorldEvent,
    options?: { priority?: boolean },
  ): Promise<void> {
    if (event.type === "run_ended") return;
    if (this.now() < this.quietUntil) return;

    // What the player did outranks what the world was already saying: see `isPlayEvent` for the
    // measurement that put this here. An explicit `priority` still wins, so a caller can promote
    // something this predicate does not know about.
    const priority = options?.priority ?? isPlayEvent(event);
    const hold = this.hold();
    // A play event that is already waiting claims the *next* slot, so routine traffic arriving behind
    // it waits its turn instead of spending the slot itself. Without this the newest near miss keeps
    // sending — there is always another one — and the storm waits for a quiet moment that never
    // comes. Measured before this: the sandstorm arrived at 302 m and the world answered it at 396 m,
    // and in the city and the forest the run was over before the answer ever went out.
    const claimed = this.pending.some((entry) => entry.priority);
    if (hold || claimed) {
      this.enqueue(state, event, priority);
      // Waiting is free while the chunk is held — the boundary releases it — but a priority ask is
      // the one that may not be dropped, so it arms its own deadline (see `PRIORITY_WAIT_MS`).
      this.scheduleFlush();
      return;
    }

    await this.emit(state, event);
  }

  /**
   * Waiting for a slot, without losing anything the player did.
   *
   * A play event joins the queue and is never removed for anything else that arrives. A routine update
   * takes the place of the routine update already in the queue — it is a description of where the run
   * is, and the older description is worse by definition — or waits its turn if there is none.
   */
  private enqueue(state: RunState, event: WorldEvent, priority: boolean): void {
    const at = this.now();
    if (!priority) {
      const routine = this.pending.findIndex((entry) => !entry.priority);
      if (routine >= 0) {
        this.pending[routine] = { state, event, priority, at: this.pending[routine].at };
        return;
      }
    } else {
      // The same ask already waiting is replaced by the newest state of it rather than queued twice:
      // an event asked for again until it lands (the deal — see `RunExperience`) must not fill the
      // queue with copies of itself and push a play event out of the slot to say the same thing.
      // Its clock is kept, not restarted: the deadline measures how long the world has gone without
      // saying it, not how long ago the newest copy of the question was asked.
      const same = this.pending.findIndex((entry) => entry.priority && entry.event.type === event.type);
      if (same >= 0) {
        this.pending[same] = { state, event, priority, at: this.pending[same].at };
        return;
      }
    }
    this.pending.push({ state, event, priority, at });
    // A bound on the wait, not on the delivery: the drain is one per chunk or cooldown, which is a
    // second or two, so anything still here is a world that has stopped producing slots — and a play
    // event from a run that has ended is worse than no ask at all.
    if (this.pending.length > PENDING_LIMIT) this.pending.shift();
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
    if (this.hold()) return;
    const next = this.next();
    if (!next) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    void this.emit(next.state, next.event);
  }

  /**
   * The ask for the next slot: what the player did outranks what the world was already saying.
   *
   * The queue is otherwise first-in-first-out, which is right for descriptions of where the run is —
   * but a routine event that slipped in a moment before the storm should not get the storm's slot.
   */
  private next(): { state: RunState; event: WorldEvent; priority: boolean } | undefined {
    const at = this.pending.findIndex((entry) => entry.priority);
    const index = at >= 0 ? at : 0;
    const entry = this.pending[index];
    if (entry) this.pending.splice(index, 1);
    return entry;
  }

  public reset(): void {
    this.lastPrompt = "";
    this.lastAudio = "";
    this.lastSentAt = -Infinity;
    this.quietUntil = -Infinity;
    this.sentInChunk = -1;
    this.pending = [];
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
    const cooldown = Math.max(0, this.cooldownMs - (this.now() - this.lastSentAt));
    const priority = this.pending.find((entry) => entry.priority);
    const deadline = priority ? Math.max(0, priority.at + PRIORITY_WAIT_MS - this.now()) : Infinity;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const hold = this.hold();
      if (hold === "chunk") {
        // The boundary releases the queue, so the timer must not spin waiting for it — unless the
        // priority ask has waited out its deadline, which is the one ask allowed to go out
        // mid-chunk. Until then the timer sleeps exactly as long as that deadline needs.
        const waiting = this.pending.find((entry) => entry.priority);
        if (!waiting) return;
        if (this.now() - waiting.at < PRIORITY_WAIT_MS) {
          this.scheduleFlush();
          return;
        }
      } else if (hold === "cooldown") {
        this.scheduleFlush();
        return;
      }
      const next = this.next();
      if (!next) return;
      // The override case — the timer slept past the chunk boundary because this ask has waited out
      // its deadline — is marked so an audit can tell it from a boundary send.
      void this.emit(next.state, next.event, hold === "chunk");
      // More than one ask waiting: the rest belong to the next slot, which the timer can wait for.
      if (this.pending.length) this.scheduleFlush();
    }, Math.min(cooldown, deadline));
  }

  /** One event, on both channels: the picture and the sound it makes. */
  private async emit(state: RunState, event: WorldEvent, deadline = false): Promise<void> {
    const view: WorldView = { environment: state.environment, custom: this.custom() };
    await this.deliver(eventPrompt(state, event, view), audioEventPrompt(state, event, view), {
      event,
      state,
      // The slot this ask is spent in, so the journal records the same chunk the gate above keys on
      // rather than whatever the session snapshot happened to say at the send.
      chunk: this.chunk,
      deadline,
    });
  }

  private async deliver(prompt: string, audio: string, cause?: PromptCause): Promise<void> {
    // The two channels are deduped separately: a run can legitimately hold the same sound bed while
    // the picture moves on, and re-sending an unchanged caption is a command spent on nothing. Only
    // the picture carries the cause — the sound never spends an ask of its own, so it never has one to
    // report.
    await Promise.all([
      this.sendOnce(prompt, "video", cause),
      this.sendOnce(audio, "audio"),
    ]);
  }

  private async sendOnce(prompt: string, track: "video" | "audio", cause?: PromptCause): Promise<void> {
    const send = track === "audio" ? this.sendAudio : this.sendPrompt;
    if (!send) return;
    if (prompt === (track === "audio" ? this.lastAudio : this.lastPrompt)) return;

    // The slot is claimed *before* the send, not after it. `hold()` is the gate that spends a chunk's
    // one ask, and a gate that closes only when the promise resolves is one two events in the same
    // frame both pass: the runner can fire a near miss and a pickup in one update, and both asks
    // would go out labelled with the same chunk — the first overwritten before the model read it.
    // Claiming synchronously makes the second wait for the next boundary, which is what it is for.
    const previousChunk = this.sentInChunk;
    const previousAt = this.lastSentAt;
    // The cooldown follows the picture, not the sound: the sound rides along with a visual prompt and
    // never spends an ask of its own.
    if (track === "video") {
      this.lastSentAt = this.now();
      this.sentInChunk = this.chunk;
    }

    try {
      await send(prompt, cause);
      if (track === "audio") this.lastAudio = prompt;
      else this.lastPrompt = prompt;
    } catch {
      // Orbis is an enhancement layer. Gameplay must continue if a prompt fails — and a failed ask
      // did not spend the chunk it claimed, so the slot goes back for the next event to use.
      if (track === "video") {
        this.lastSentAt = previousAt;
        this.sentInChunk = previousChunk;
      }
    }
  }
}
