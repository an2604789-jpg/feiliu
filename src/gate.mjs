// Adaptive concurrency gate.
//
// A fixed connection count is a guess. Servers push back when a client opens
// too many at once — 429, 503, or a silent throttle — and a downloader that
// keeps its count fixed either wastes bandwidth on a fast origin or keeps
// getting throttled on a strict one.
//
// The algorithm here (adapted from the design used by Surge's
// internal/strategy/concurrent/concurrency_gate.go, MIT) is:
//
//   * on a throttle, halve the cap (rounding up, never below 1);
//   * within one cooldown episode, further throttles do NOT halve again, so a
//     burst of 429s cannot collapse the transfer to a single connection;
//   * recover by adding one connection per healthy window, not by jumping back;
//   * never recover before the cooldown the server implied has elapsed.
//
// It is transport-agnostic: the engine calls noteThrottle() when it sees a
// throttle-class response and noteSuccess() when a segment completes cleanly.

export const DEFAULT_RECOVERY_MS = 15_000;

export class AdaptiveConcurrencyGate {
  /**
   * @param {{ max:number, min?:number, enabled?:boolean, recoveryMs?:number,
   *           now?:() => number }} opts
   */
  constructor(opts = {}) {
    this.max = Math.max(1, Math.floor(opts.max ?? 8));
    this.min = Math.max(1, Math.floor(opts.min ?? 1));
    this.cap = this.max;
    this.enabled = opts.enabled !== false;
    this.recoveryMs = Math.max(1000, opts.recoveryMs ?? DEFAULT_RECOVERY_MS);
    this.now = opts.now ?? (() => Date.now());

    this.throttled = false;
    this.hasThrottled = false;
    this.cooldownUntil = 0;
    this.lastThrottle = 0;
    this.nextIncrease = 0;
    this.episodes = 0;
    this.listeners = [];
    /** Workers currently in flight under this gate. */
    this.admitted = 0;
  }

  on(fn) { this.listeners.push(fn); return this; }
  #emit(event) { for (const fn of this.listeners) fn(event); }

  get current() { return this.cap; }

  /** Slots still available right now. */
  get free() { return Math.max(0, this.cap - this.admitted); }


  /**
   * Wait until the current cap allows another worker in.
   *
   * Admission lives here rather than in the engine because the cap and the
   * number of admitted workers must change together: a throttle halves the
   * cap, and the workers that no longer fit must be held back.
   *
   * @returns {Promise<boolean>} false when the caller should stop waiting
   */
  async acquire(signal, shouldAbort) {
    for (;;) {
      if (signal?.aborted) return false;
      if (shouldAbort && shouldAbort()) return false;
      if (this.admitted < this.cap) {
        this.admitted++;
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
      // Re-check immediately after the wait: a caller may have signalled that
      // the whole attempt is being abandoned, and a blocked worker must not
      // keep a transfer alive after that.
      if (shouldAbort && shouldAbort()) return false;
    }
  }

  /** Release one admitted slot. Safe to call unconditionally. */
  release() {
    if (this.admitted > 0) this.admitted--;
  }
  /**
   * Record a throttle-class response (429/503/connection reset by policy).
   * @param {number} [cooldownMs] how long the server implied we should wait
   * @returns {{oldCap:number,newCap:number,newEpisode:boolean}}
   */
  noteThrottle(cooldownMs = 0) {
    const now = this.now();
    const oldCap = this.cap;

    // A throttle inside the current cooldown extends the episode but must not
    // halve the cap again: several connections can be rejected in the same
    // instant, and reacting to each one individually would collapse the
    // transfer far below what the server actually wants.
    //
    // The cooldown window must exist even when the server sends no Retry-After
    // header. Leaving it at zero makes every response its own episode, so a
    // burst of 429s halves the cap once per response and collapses the transfer
    // to a single connection. The recovery window is the natural default: it is
    // the same period the cap would need before growing again.
    const window = cooldownMs > 0 ? cooldownMs : this.recoveryMs;
    const newEpisode = this.cooldownUntil === 0 || now >= this.cooldownUntil;

    if (newEpisode) {
      this.episodes++;
      if (this.enabled) {
        this.cap = Math.max(this.min, Math.ceil(this.cap / 2));
      }
    }

    this.throttled = true;
    this.hasThrottled = true;
    this.lastThrottle = now;
    this.cooldownUntil = Math.max(this.cooldownUntil, now + window);
    this.nextIncrease = Math.max(this.lastThrottle + this.recoveryMs, this.cooldownUntil);

    if (this.cap !== oldCap) {
      this.#emit({ type: "cap", oldCap, newCap: this.cap, newEpisode });
    } else if (newEpisode) {
      this.#emit({ type: "throttle", oldCap, newCap: this.cap, newEpisode });
    }
    return { oldCap, newCap: this.cap, newEpisode };
  }

  /**
   * Advance recovery if a healthy window has elapsed.
   * @returns {{oldCap:number,newCap:number,recovered:boolean}}
   */
  noteSuccess() {
    const now = this.now();
    if (!this.throttled || now < this.nextIncrease) {
      return { oldCap: this.cap, newCap: this.cap, recovered: false };
    }
    const oldCap = this.cap;
    if (this.enabled && this.cap < this.max) {
      this.cap++;
      this.nextIncrease = now + this.recoveryMs;
    }
    // The episode is over once the cap is back at the ceiling.
    if (!this.enabled || this.cap >= this.max) {
      this.throttled = false;
      this.cooldownUntil = 0;
      this.lastThrottle = 0;
      this.nextIncrease = 0;
      this.#emit({ type: "recovered", oldCap, newCap: this.cap });
      return { oldCap, newCap: this.cap, recovered: true };
    }
    if (this.cap !== oldCap) {
      this.#emit({ type: "cap", oldCap, newCap: this.cap, newEpisode: false });
    }
    return { oldCap, newCap: this.cap, recovered: false };
  }

  /** Snapshot for status reporting. */
  view() {
    return {
      cap: this.cap,
      max: this.max,
      min: this.min,
      enabled: this.enabled,
      throttled: this.throttled,
      episodes: this.episodes,
      admitted: this.admitted,
      cooldownUntil: this.cooldownUntil || null,
    };
  }
}

/** Is this HTTP status one the server uses to push back? */
export function isThrottleStatus(status) {
  return status === 429 || status === 503 || status === 509;
}
