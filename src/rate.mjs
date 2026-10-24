// Token-bucket bandwidth limiter.
//
// One instance is shared by every worker of ONE download. That is the whole
// point: a per-connection limiter multiplies the cap by the connection count,
// so a user who asks for 2 MB/s gets 16 MB/s on eight connections. Sharing the
// bucket makes the number on the CLI the number on the wire.
//
// The bucket also has to be safe when a single read is larger than one
// second's allowance. `tokens` is capped at `rate` (that is the burst), so a
// chunk of 1 MiB under a 64 KiB/s limit can never be satisfied by waiting for
// a refill — the old loop spun forever in that case. take() spends a request
// in portions no larger than the bucket can ever hold.

import { sleep } from "./util.mjs";

/**
 * Longest a throttled waiter sleeps before re-reading its rate.
 *
 * A waiter that slept for the whole remaining transfer would not notice the
 * limit being raised or cleared until it woke, so a schedule window ending
 * would appear to hang. Re-checking a few times a second is free.
 */
const MAX_SLEEP_MS = 100;

export class RateLimiter {
  /** @param {number} bytesPerSecond 0 or less means unlimited */
  constructor(bytesPerSecond = 0) {
    this.rate = Number(bytesPerSecond) > 0 ? Number(bytesPerSecond) : 0;
    // Start with one second's worth of credit: a transfer should not sit idle
    // for a full second before its first byte on a fast link.
    this.tokens = this.rate;
    this.last = Date.now();
  }

  get limited() {
    return this.rate > 0;
  }

  /** Change the cap at runtime (schedules, settings changes). 0 = unlimited. */
  setRate(bytesPerSecond) {
    const rate = Number(bytesPerSecond) > 0 ? Number(bytesPerSecond) : 0;
    this.rate = rate;
    if (this.tokens > rate) this.tokens = rate;
    this.last = Date.now();
    return this.rate;
  }

  /**
   * Block until `want` bytes may be sent.
   *
   * Called from inside a read loop, before the bytes are consumed, so the wait
   * pushes back on the socket instead of letting the whole response pile up in
   * memory first.
   *
   * @param {number} want bytes about to be transferred
   * @param {AbortSignal} [signal]
   */
  async take(want, signal) {
    if (!(want > 0)) return;
    let left = want;
    while (left > 0) {
      // The rate is re-read on every pass: it can be raised, lowered or cleared
      // while this call is waiting, and a stale `portion` of 0 would loop
      // forever without consuming anything.
      const rate = this.rate;
      if (!rate) return;                       // unlimited now: let the bytes through
      const portion = Math.min(left, rate);    // no wait may exceed the burst
      await this.#spend(portion, signal);
      left -= portion;
    }
  }

  async #spend(want, signal) {
    for (;;) {
      if (signal?.aborted) throw new Error("aborted");
      // The rate can be lifted while a waiter is asleep (a schedule window
      // ending, the user changing Settings). Lifting it must release the
      // waiter: with rate 0 the bucket never fills, so waiting would be a
      // livelock. Unlimited means "go now".
      if (!this.rate) return;
      const now = Date.now();
      this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
      this.last = now;
      if (this.tokens >= want) {
        this.tokens -= want;
        return;
      }
      // Sleep just long enough for the bucket to reach the amount needed, but
      // never so long that a rate change goes unnoticed for long.
      const needMs = ((want - this.tokens) / this.rate) * 1000;
      await sleep(Math.min(Math.max(5, needMs), MAX_SLEEP_MS), signal);
    }
  }
}

/**
 * Several buckets that all have to allow a byte before it may be read.
 *
 * This is how a global cap (a scheduled bandwidth window) and a per-task cap
 * coexist: the schedule is ONE bucket shared by every running task, so two
 * concurrent downloads move the window's rate in total rather than that rate
 * each. The per-task bucket is separate, so one task cannot spend another's
 * allowance.
 */
export class ChainLimiter {
  /** @param {RateLimiter[]} limits members; unlimited members are effectively skipped */
  constructor(limits = []) {
    this.members = limits.filter(Boolean);
  }

  get limited() {
    return this.members.some((m) => m.limited);
  }

  /** The tightest non-zero member rate, or 0 when nothing limits. */
  get rate() {
    const rates = this.members.map((m) => m.rate).filter((r) => r > 0);
    return rates.length ? Math.min(...rates) : 0;
  }

  async take(want, signal) {
    for (const member of this.members) {
      if (member.rate > 0) await member.take(want, signal);
    }
  }
}

export default RateLimiter;
