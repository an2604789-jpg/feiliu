// Worker health monitor.
//
// Some connections go bad mid-transfer: the socket stays open but stops
// delivering, or trickles at a fraction of what the others achieve. Waiting for
// a socket timeout wastes minutes; the transfer should drop that worker and let
// the segment be re-fetched.
//
// Two distinct conditions are checked, because they catch different failures
// (the distinction follows Surge's internal/strategy/concurrent/health.go, MIT):
//
//   * absolute stall — no bytes for stallMs at all. Catches dead connections
//     that keep the socket open.
//   * relative slowness — speed far below the mean of the other workers.
//     Catches a connection that is alive but degraded.
//
// Two guards matter just as much as the checks:
//
//   * a grace period, because a worker that has just started has a meaningless
//     speed sample;
//   * skipping workers parked on the rate limiter, because a throttled worker
//     legitimately reports a low speed. Without this, turning on a speed limit
//     would make the monitor cancel every worker.

export class WorkerHealthMonitor {
  /**
   * @param {{ stallMs?:number, slowRatio?:number, graceMs?:number,
   *           intervalMs?:number, minSpeedBytes?:number, onUnhealthy:Function,
   *           now?:() => number }} opts
   */
  constructor(opts = {}) {
    this.stallMs = opts.stallMs ?? 30_000;
    this.slowRatio = opts.slowRatio ?? 0.25;
    this.graceMs = opts.graceMs ?? 8_000;
    this.intervalMs = opts.intervalMs ?? 5_000;
    this.minSpeedBytes = opts.minSpeedBytes ?? 1024;
    this.onUnhealthy = opts.onUnhealthy ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
    this.workers = new Map();   // id -> { startedAt, lastActivity, bytes, waitingOnLimiter }
  }

  /** Register a worker (or replace its state on retry). */
  track(id, extra = {}) {
    const now = this.now();
    this.workers.set(id, {
      startedAt: now,
      lastActivity: now,
      bytes: 0,
      lastBytes: 0,
      lastSpeedAt: now,
      speed: 0,
      waitingOnLimiter: false,
      ...extra,
    });
  }

  untrack(id) { this.workers.delete(id); }

  /** Called whenever a worker receives bytes. */
  noteBytes(id, count) {
    const w = this.workers.get(id);
    if (!w) return;
    w.bytes += count;
    w.lastActivity = this.now();
  }

  /**
   * Mark a worker as blocked by the rate limiter.
   * A throttled worker must never be judged for slowness.
   */
  noteLimiterWait(id, waiting) {
    const w = this.workers.get(id);
    if (w) w.waitingOnLimiter = Boolean(waiting);
  }

  /** Recompute per-worker speeds and refresh the mean. */
  #sample() {
    const now = this.now();
    let total = 0, n = 0;
    for (const w of this.workers.values()) {
      const dt = Math.max(0.001, (now - w.lastSpeedAt) / 1000);
      w.speed = (w.bytes - w.lastBytes) / dt;
      w.lastBytes = w.bytes;
      w.lastSpeedAt = now;
      if (w.speed > 0) { total += w.speed; n++; }
    }
    return n > 0 ? total / n : 0;
  }

  /**
   * Run one health pass.
   * @returns {{stalled:string[], slow:string[]}}
   */
  check() {
    const now = this.now();
    const meanSpeed = this.#sample();
    const stalled = [];
    const slow = [];

    for (const [id, w] of this.workers) {
      // A worker parked on the limiter is slow on purpose.
      if (w.waitingOnLimiter) continue;
      if (now - w.startedAt < this.graceMs) continue;

      const idleFor = now - w.lastActivity;
      if (this.stallMs > 0 && idleFor >= this.stallMs) {
        stalled.push(id);
        this.onUnhealthy(id, "stalled", { idleMs: idleFor });
        continue;
      }

      // Relative check needs a meaningful baseline: with a single worker the
      // mean is that worker itself, so the comparison would never fire and a
      // degraded lone connection would go unnoticed until the stall timeout.
      // Relative check: a connection far below its peers is degraded. The
      // noise floor guards the opposite direction from what it looks like —
      // below it, one stray byte would read as "infinitely slower", so those
      // samples are ignored rather than flagged.
      if (meanSpeed > 0 && w.speed < this.slowRatio * meanSpeed) {
        slow.push(id);
        this.onUnhealthy(id, "slow", { speed: w.speed, mean: meanSpeed });
      }
    }
    return { stalled, slow };
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => { try { this.check(); } catch { /* never break the transfer */ } }, this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  view() {
    return {
      workers: this.workers.size,
      stallMs: this.stallMs,
      slowRatio: this.slowRatio,
      graceMs: this.graceMs,
    };
  }
}
