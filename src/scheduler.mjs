// Scheduler: time-based rules that start/stop the queue.
//
// Supports:
//   * one-shot and daily schedules ("start queue at 02:00");
//   * bandwidth windows (slow down during work hours);
//   * stop conditions (complete, or a wall-clock cutoff).

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

const DAY_MS = 86_400_000;

/** "HH:MM" -> minutes since midnight, or null. */
export function parseClock(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Next Date at "HH:MM" local time, strictly after `from`. */
export function nextOccurrence(clock, from = new Date()) {
  const minutes = parseClock(clock);
  if (minutes === null) return null;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  if (d.getTime() <= from.getTime()) d.setTime(d.getTime() + DAY_MS);
  return d;
}

/** Is `now` inside [start, end)? Handles windows that cross midnight. */
export function inWindow(now, startClock, endClock) {
  const s = parseClock(startClock), e = parseClock(endClock);
  if (s === null || e === null) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e);
}

export class Scheduler extends EventEmitter {
  constructor({ queue, config, log }) {
    super();
    this.queue = queue;
    this.config = config;
    this.log = log;
    this.schedules = [];
    this.timer = null;
    this.lastRun = new Map();
  }


  /**
   * The speed limit that should currently apply, or null.
   *
   * A schedule can declare a bandwidth window: a rate plus an end time.
   * The field existed but was never read, so a windowed schedule only
   * started the queue and never throttled it.
   */
  activeSpeedLimit(now = new Date()) {
    for (const s of this.schedules) {
      if (!s.enabled || s.speedLimit === null || !s.at || !s.endAt) continue;
      if (s.days && !s.days.includes(now.getDay())) continue;
      if (inWindow(now, s.at, s.endAt)) return { limit: Number(s.speedLimit) || 0, schedule: s.name };
    }
    return null;
  }

  /**
   * Push the active window's limit into the running downloader.
   *
   * Only the downloader-wide bucket is touched. Every transfer — plain HTTP,
   * HLS and DASH — checks that bucket in addition to its own, so one call here
   * reaches downloads that are already running, not just future ones, and the
   * window's rate is a total across concurrent tasks rather than a per-task
   * allowance.
   *
   * Precedence (also stated in the README): a schedule window sets the
   * downloader-wide cap; a task's own `speedLimit` (the CLI `--limit`) applies
   * on top of it, so the effective rate is the tighter of the two. Leaving the
   * window restores the downloader-wide cap to 0 (unlimited).
   */
  applySpeedLimit(downloader, now = new Date()) {
    if (!downloader) return null;
    const active = this.activeSpeedLimit(now);
    const limit = active ? active.limit : 0;
    // setRate() rather than a bare assignment: it also clamps the bucket and
    // releases anyone currently waiting, so raising or clearing the limit is
    // noticed immediately instead of at the next refill.
    const bucket = downloader.limiter;
    if (bucket) {
      if (typeof bucket.setRate === "function") bucket.setRate(limit);
      else bucket.rate = limit;
    }
    if (this.lastAppliedLimit !== limit) {
      this.lastAppliedLimit = limit;
      this.emit("speed-limit", { limit, schedule: active ? active.schedule : null });
      this.log?.info(limit > 0
        ? "speed limit " + limit + " B/s active (" + active.schedule + ")"
        : "speed limit cleared");
    }
    return limit;
  }
  list() { return this.schedules.map((s) => ({ ...s, next: this.nextFor(s)?.toISOString() ?? null })); }

  nextFor(schedule) {
    if (!schedule.enabled || !schedule.at) return null;
    // A schedule that has never run has no last-run time; the old `?? 0`
    // anchored on the epoch and listed "1970-01-01" as next. Show no time
    // until it has actually fired once (the GUI renders the empty value).
    const last = this.lastRun.get(schedule.id);
    if (!last) return null;
    return nextOccurrence(schedule.at, new Date(last));
  }

  add(input) {
    const s = {
      id: input.id || randomUUID(),
      name: input.name || "schedule",
      at: input.at ?? null,                 // "HH:MM" local
      action: input.action || "resume",     // resume | pause | clear-completed
      speedLimit: input.speedLimit ?? null, // applied when this window is active
      endAt: input.endAt ?? null,           // optional stop clock
      days: input.days ?? null,             // [0..6], null = every day
      enabled: input.enabled ?? true,
      url: input.url ?? null,               // optional: add this URL instead
      createdAt: Date.now(),
    };
    if (s.at && parseClock(s.at) === null) throw new Error(`invalid time "${s.at}", expected HH:MM`);
    this.schedules.push(s);
    this.emit("change", this.list());
    return s;
  }

  remove(id) {
    const before = this.schedules.length;
    this.schedules = this.schedules.filter((s) => s.id !== id);
    const removed = this.schedules.length !== before;
    if (removed) this.emit("change", this.list());
    return removed;
  }

  view() {
    return {
      schedules: this.list(),
      activeWindow: this.currentWindowName(),
    };
  }

  currentWindowName() {
    const now = new Date();
    for (const s of this.schedules) {
      if (!s.enabled || !s.endAt) continue;
      if (inWindow(now, s.at, s.endAt)) return s.name;
    }
    return null;
  }

  start() {
    // Poll once a minute: schedules are minute-granular, and a short poll is
    // far easier to reason about than long sleeps that drift across DST.
    this.timer = setInterval(() => this.tick(), 30_000);
    this.timer.unref?.();
    this.tick();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Fire any schedule whose time has arrived. Exposed for tests. */
  tick(now = new Date()) {
    const fired = [];
    // Windows change on a minute boundary too, so re-evaluate them here.
    this.onTick && this.onTick(now);
    for (const s of this.schedules) {
      if (!s.enabled || !s.at) continue;
      if (s.days && !s.days.includes(now.getDay())) continue;
      const target = parseClock(s.at);
      const cur = now.getHours() * 60 + now.getMinutes();
      if (cur !== target) continue;
      const last = this.lastRun.get(s.id) ?? 0;
      if (now.getTime() - last < 60_000) continue;   // once per minute max
      this.lastRun.set(s.id, now.getTime());
      this.#execute(s);
      fired.push(s.id);
    }
    return fired;
  }

  #execute(s) {
    this.log?.info(`schedule "${s.name}" fired: ${s.action}`);
    this.emit("fired", s);
    try {
      if (s.url) {
        this.queue.add({ url: s.url, queueId: "scheduled" });
        return;
      }
      switch (s.action) {
        case "resume": this.queue.resumeAll(); break;
        case "pause": this.queue.pauseAll(); break;
        case "clear-completed": this.queue.clearCompleted(); break;
        default: this.log?.warn(`unknown schedule action "${s.action}"`);
      }
    } catch (err) {
      this.log?.error(`schedule "${s.name}" failed: ${err.message}`);
    }
  }

  toJSON() {
    return { schedules: this.schedules, lastRun: [...this.lastRun.entries()] };
  }

  loadFrom(data) {
    this.schedules = Array.isArray(data?.schedules) ? data.schedules : [];
    this.lastRun = new Map(data?.lastRun ?? []);
    return this;
  }
}
