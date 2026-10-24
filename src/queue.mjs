// Queue manager: owns every task, enforces concurrency, persists state.
//
// Concurrency has three limits:
//   * how many downloads may run at once across every queue group
//     (maxConcurrentDownloads — always the total gate);
//   * how many may run at once inside one queue group
//     (config.queues[].concurrent; a group the config does not list
//     follows the global limit, so the default single group "default"
//     behaves exactly like the pre-group scheduler);
//   * how many connections one download may open (maxConnections).
// The scheduler below only ever promotes tasks while a slot is free, so a
// paused or errored task can never hold a slot.

import fsp from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";

import { paths, ensureDirs } from "./paths.mjs";
import { STATUS, TERMINAL, ACTIVE, makeTask, serializeTask, taskView, canTransition } from "./task.mjs";

export class QueueManager extends EventEmitter {
  /** @param {{ config:any }} opts */
  constructor({ config }) {
    super();
    this.config = config;
    this.tasks = new Map();
    this.order = [];             // task ids, newest first for display
    this.running = new Map();    // id -> runner handle
    this._saveTimer = null;
    this._pumping = false;
    this.pausedAll = false;
    /**
     * Task ids this process last saw on disk: what load() read, or what the
     * last successful save() wrote. null = never established (load did not
     * run, or the file was unreadable); an empty Set = disk known empty.
     * The empty-save guard in save() compares the live disk file against
     * this snapshot to tell "user cleared the queue" (every disk id is one
     * we loaded/wrote, then watched leave through remove()) from "someone
     * else wrote tasks we never saw" (the 2026-10-24 two-daemon incident,
     * where a shutdown save turned a 7-record queue.json into an empty one).
     */
    this._knownDiskIds = null;
  }

  // ------------------------------------------------------------------ load

  async load() {
    await ensureDirs();
    try {
      const raw = JSON.parse(await fsp.readFile(paths.queue, "utf8"));
      for (const rec of raw.tasks ?? []) {
        // Anything that was mid-flight when we died becomes resumable.
        const status = ACTIVE.has(rec.status) || rec.status === STATUS.CONNECTING
          ? STATUS.PAUSED
          : rec.status;
        const t = makeTask({ ...rec, status });
        // The byte count in queue.json is only as fresh as the last debounced
        // save, so after a hard kill it understates what is on disk — usually
        // to zero. The per-segment journal is written as the transfer proceeds
        // and is the authoritative record, so it is preferred whenever the task
        // is still resumable. Without this the user saw "0 bytes" for a
        // download that was almost finished.
        if (status === STATUS.PAUSED || status === STATUS.ERROR) {
          const fromDisk = await resolveDiskProgress(t);
          if (fromDisk !== null && fromDisk > (t.downloadedBytes ?? 0)) {
            t.downloadedBytes = fromDisk;
          }
        }
        this.tasks.set(t.id, t);
      }
      this.order = Array.isArray(raw.order) ? raw.order.filter((id) => this.tasks.has(id)) : [];
      for (const id of this.tasks.keys()) if (!this.order.includes(id)) this.order.push(id);
      // Everything we just adopted is now "what we know is on disk" — see
      // save()'s empty-save guard for why this snapshot matters.
      this._knownDiskIds = new Set(this.tasks.keys());
    } catch (err) {
      if (err.code !== "ENOENT") this.emit("warn", `queue unreadable (${err.message}); starting empty`);
      else this._knownDiskIds = new Set();   // no file: the disk queue is known empty
      // An unreadable file leaves the snapshot null ("unknown"): a later
      // empty save must then be refused if a readable non-empty file has
      // appeared, because we cannot claim to have cleared what we never read.
    }
    this.emit("loaded", this.list());
    return this;
  }

  /** Debounced persistence: a busy queue must not rewrite the file per byte. */
  scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save().catch((err) => this.emit("warn", `queue save failed: ${err.message}`));
    }, 400);
    this._saveTimer.unref?.();
  }

  async save() {
    await ensureDirs();
    // Empty-save guard (2026-10-24 incident, batch-2): a graceful stop whose
    // process held no tasks once wrote an empty list over a queue.json with
    // seven records — the other daemon's work, gone silently. The singleton
    // lock removes the known cause, but any writer this process did not see
    // must still not be clobbered: with nothing in memory there is nothing
    // to lose by skipping the write, while the disk copy may be the user's
    // only record. The one legal way to an empty memory over a non-empty
    // disk is this process's own remove()/clearCompleted() (the only paths
    // that delete from `tasks`), and those leave the disk ids inside
    // _knownDiskIds — so ids we never loaded or wrote mean "not ours".
    if (this.tasks.size === 0) {
      const clobber = await this.#diskTasksNotOurs();
      if (clobber) {
        this.emit("warn",
          `queue save refused: memory holds no tasks but queue.json holds ${clobber.onDisk}` +
          ` (${clobber.unknown} never loaded or written by this process); keeping the disk copy`);
        return;
      }
    }
    const data = {
      version: 1,
      savedAt: new Date().toISOString(),
      order: this.order,
      tasks: [...this.tasks.values()].map(serializeTask),
    };
    const tmp = `${paths.queue}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fsp.rename(tmp, paths.queue);
    // What we just published is what we now know is on disk.
    this._knownDiskIds = new Set(this.tasks.keys());
  }

  /**
   * Would an empty save destroy tasks on disk? Reads queue.json as it is now
   * and compares its task ids against the ids this process last loaded or
   * wrote. Returns null when the disk has nothing provably at stake (no
   * file, unparseable body, or zero tasks): an unparseable file establishes
   * no task count, so it does not trip the guard — load()'s "queue
   * unreadable" warning is the visible trace for that case.
   *
   * @returns {Promise<{onDisk:number, unknown:number}|null>}
   */
  async #diskTasksNotOurs() {
    let raw;
    try { raw = JSON.parse(await fsp.readFile(paths.queue, "utf8")); }
    catch { return null; }
    const ids = Array.isArray(raw.tasks) ? raw.tasks.map((t) => t && t.id).filter(Boolean) : [];
    if (ids.length === 0) return null;
    const known = this._knownDiskIds;
    // A snapshot we never established means none of these ids are ours.
    if (!known) return { onDisk: ids.length, unknown: ids.length };
    const unknown = ids.filter((id) => !known.has(id)).length;
    return unknown > 0 ? { onDisk: ids.length, unknown } : null;
  }

  async saveNow() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    await this.save();
  }

  // ----------------------------------------------------------------- CRUD

  add(input) {
    const t = makeTask(input);
    this.tasks.set(t.id, t);
    this.order.unshift(t.id);
    this.emit("added", taskView(t));
    this.scheduleSave();
    this.pump();
    return t;
  }

  get(id) { return this.tasks.get(id) ?? null; }
  view(id) { const t = this.get(id); return t ? taskView(t) : null; }

  list(filter = {}) {
    let out = this.order.map((id) => this.tasks.get(id)).filter(Boolean);
    if (filter.status) {
      const want = Array.isArray(filter.status) ? new Set(filter.status) : new Set([filter.status]);
      out = out.filter((t) => want.has(t.status));
    }
    if (filter.queueId) out = out.filter((t) => t.queueId === filter.queueId);
    if (filter.active) out = out.filter((t) => ACTIVE.has(t.status));
    if (filter.limit) out = out.slice(0, filter.limit);
    return out.map(taskView);
  }

  /** Transition with validation; emits on change and schedules a save. */
  setStatus(id, status, extra = {}) {
    const t = this.get(id);
    if (!t) return null;
    if (t.status !== status && !canTransition(t.status, status)) {
      this.emit("warn", `refusing transition ${t.status} -> ${status} for ${t.filename ?? t.id}`);
      return null;
    }
    t.status = status;
    t.updatedAt = Date.now();
    Object.assign(t, extra);
    if (status === STATUS.DOWNLOADING && !t.startedAt) t.startedAt = Date.now();
    if (TERMINAL.has(status)) { t.finishedAt = Date.now(); t.speed = 0; }
    this.emit("updated", taskView(t));
    this.scheduleSave();
    return t;
  }

  // Fields a PATCH may change. Everything else a client sends is ignored, so
  // PATCH /api/tasks/:id can no longer rewrite id/status/url/downloadedBytes
  // and friends (review P1: update() used to Object.assign the body verbatim).
  // The list is what the add route accepts as user-editable intent plus the
  // credential fields, so a redirected task can be re-authenticated by hand.
  static PATCHABLE = new Set([
    "filename", "dir", "category", "connections", "speedLimit", "priority",
    "queueId", "referer", "cookies", "headers", "username", "password",
    "meta", "tags",
  ]);

  update(id, patch) {
    const t = this.get(id);
    if (!t) return null;
    const safe = {};
    for (const key of Object.keys(patch ?? {})) {
      if (QueueManager.PATCHABLE.has(key)) safe[key] = patch[key];
    }
    Object.assign(t, safe, { updatedAt: Date.now() });
    this.emit("updated", taskView(t));
    this.scheduleSave();
    return t;
  }

  /**
   * Internal state writes: progress bookkeeping, settle, retry bookkeeping.
   *
   * Unlike update() this accepts every field, because the runner legitimately
   * sets status/downloadedBytes/error/attempts as a task settles. It exists so
   * update() can stay strict for client input: the two entry points answer two
   * different questions — "what may the user change" and "what did the
   * transfer just observe".
   */
  apply(id, patch) {
    const t = this.get(id);
    if (!t) return null;
    Object.assign(t, patch, { updatedAt: Date.now() });
    this.emit("updated", taskView(t));
    this.scheduleSave();
    return t;
  }

  remove(id, { deleteFile = false } = {}) {
    const t = this.get(id);
    if (!t) return false;
    this.stop(id);
    this.tasks.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (deleteFile && t.dir && t.filename) {
      fsp.rm(path.join(t.dir, t.filename), { force: true }).catch(() => {});
    }
    this.emit("removed", { id });
    this.scheduleSave();
    this.pump();
    return true;
  }

  clearCompleted() {
    const done = [...this.tasks.values()].filter((t) => t.status === STATUS.COMPLETE).map((t) => t.id);
    for (const id of done) this.remove(id);
    return done.length;
  }

  // ------------------------------------------------------------- control

  start(id) {
    const t = this.get(id);
    if (!t) return null;
    if (TERMINAL.has(t.status)) return t;

    // Starting a task that is already running must be a no-op.
    //
    // Without this guard an explicit start demoted a live transfer back to
    // QUEUED and pumped again. The second runner then found the target name
    // taken by the first runner's staging file and followed the rename policy,
    // so one URL ended up on disk as b.bin, b (2).bin and b (3).bin. Two
    // repeated POST /api/tasks/:id/start calls were enough to reproduce it.
    //
    // The status is the durable judge and the runner map is only corroboration,
    // because the two answer different questions. `running` is per process: it
    // is empty after a restart, so it cannot be trusted alone. Status is
    // persisted, but load() rewrites anything that was mid-flight to PAUSED
    // (see above), so a task restored as DOWNLOADING without a runner cannot
    // happen -- and an ACTIVE status in this process means a runner was started
    // for it. Checking both covers the window between a status change and the
    // runner registering itself.
    if (ACTIVE.has(t.status) || this.running.has(id)) return t;

    // Already waiting for a slot: there is nothing to restart, but an explicit
    // start still means "run this one", so a queue-wide pause must be lifted or
    // a task added while pausedAll was set would sit queued forever.
    if (t.status === STATUS.QUEUED) {
      this.pausedAll = false;
      this.pump();
      return t;
    }

    const next = this.setStatus(id, STATUS.QUEUED);
    // An explicit start on one task means that task, so a previous "pause all"
    // must not silently hold it back. Other tasks stay paused: this only
    // re-enables the scheduler, and pump() promotes queued tasks alone.
    this.pausedAll = false;
    // The pump is what actually promotes a queued task into a running one. It
    // used to be reached only from add/remove/reorder/settle, so asking a
    // paused or failed task to start left it queued until some unrelated event
    // happened to pump the queue. From the GUI that looked like Resume and
    // Retry doing nothing at all.
    this.pump();
    return next;
  }

  pause(id) {
    const t = this.get(id);
    if (!t) return null;
    this.stop(id);
    return this.setStatus(id, STATUS.PAUSED);
  }

  /** Abort the in-flight runner, if any; the transfer state stays on disk. */
  stop(id) {
    const h = this.running.get(id);
    if (h) {
      try { h.controller.abort(); } catch { /* already gone */ }
      this.running.delete(id);
    }
  }

  pauseAll() {
    this.pausedAll = true;
    for (const t of [...this.tasks.values()]) {
      if (ACTIVE.has(t.status) || t.status === STATUS.QUEUED) this.pause(t.id);
    }
    return true;
  }

  resumeAll() {
    this.pausedAll = false;
    for (const t of [...this.tasks.values()]) {
      if (t.status === STATUS.PAUSED || t.status === STATUS.ERROR) this.start(t.id);
    }
    this.pump();
    return true;
  }

  /** Move a task within the display order (priority is derived from it). */
  reorder(id, toIndex) {
    const from = this.order.indexOf(id);
    if (from < 0) return false;
    const clamped = Math.max(0, Math.min(this.order.length - 1, toIndex));
    this.order.splice(from, 1);
    this.order.splice(clamped, 0, id);
    this.order.forEach((tid, i) => {
      const t = this.tasks.get(tid);
      if (t) t.priority = -i;   // earlier in the list = higher priority
    });
    this.emit("reordered", this.order.slice());
    this.scheduleSave();
    this.pump();
    return true;
  }

  // ------------------------------------------------------------ scheduler

  /** How many downloads may run right now. */
  get capacity() {
    return Math.max(1, Number(this.config.get("maxConcurrentDownloads")) || 1);
  }

  /**
   * Concurrent-transfer cap for one queueId group (batch-4 W2). A group that
   * config.queues does not list has no cap of its own: it follows the global
   * capacity — which is what makes the default configuration (one "default"
   * group whose concurrent is 32, at or above any legal global value) equal
   * to the old behaviour for every queueId. The value is re-clamped
   * defensively because config may have been hand-edited on disk between
   * sanitizations.
   */
  groupLimit(queueId) {
    const groups = this.config.get("queues");
    if (Array.isArray(groups)) {
      for (const g of groups) {
        if (g && g.id === queueId) {
          const n = Number(g.concurrent);
          if (Number.isFinite(n) && n >= 1) return Math.min(32, Math.trunc(n));
          return this.capacity;   // unparseable cap: fall back to the global gate
        }
      }
    }
    return this.capacity;
  }

  get activeCount() {
    return [...this.tasks.values()].filter((t) => ACTIVE.has(t.status)).length;
  }

  /**
   * Promote queued tasks while slots are free.
   * Called after every state change; never re-entrant.
   *
   * Two gates must both pass for a promotion: the global one
   * (maxConcurrentDownloads over every group) and the promoted task's group
   * cap (config.queues[].concurrent, or the global limit for an unlisted
   * group). A group whose cap is spent is skipped, not fatal — candidates
   * from other groups still get their slots in the same pass, which is the
   * point of having groups.
   */
  pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      if (this.pausedAll) return;
      let free = this.capacity - this.activeCount;
      if (free <= 0) return;

      // Group caps are read per pump, so config.set({queues: ...}) takes
      // effect on the next scheduler pass without a restart. In-flight counts
      // come from task status, so a promotion below reserves its group slot
      // the moment setStatus lands — two pumps cannot both claim it.
      const limits = new Map();
      const inFlight = new Map();
      for (const t of this.tasks.values()) {
        if (!ACTIVE.has(t.status)) continue;
        const qid = t.queueId ?? "default";
        inFlight.set(qid, (inFlight.get(qid) ?? 0) + 1);
      }

      const candidates = this.order
        .map((id) => this.tasks.get(id))
        .filter((t) => t && t.status === STATUS.QUEUED)
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

      for (const t of candidates) {
        if (free <= 0) break;
        const qid = t.queueId ?? "default";
        if (!limits.has(qid)) limits.set(qid, this.groupLimit(qid));
        // This group's cap is spent; other groups may still have room.
        if ((inFlight.get(qid) ?? 0) >= limits.get(qid)) continue;
        // Reserve the slot immediately so two pumps cannot both claim it.
        this.setStatus(t.id, STATUS.CONNECTING);
        inFlight.set(qid, (inFlight.get(qid) ?? 0) + 1);
        free--;
        this.emit("run", t.id);
      }
    } finally {
      this._pumping = false;
    }
  }

  /** Called by the runner when a task settles, to free its slot. */
  notifySettled(id) {
    this.running.delete(id);
    this.pump();
  }

  registerRunner(id, handle) {
    this.running.set(id, handle);
  }

  get stats() {
    const by = {};
    for (const t of this.tasks.values()) by[t.status] = (by[t.status] ?? 0) + 1;
    return {
      total: this.tasks.size,
      byStatus: by,
      active: this.activeCount,
      capacity: this.capacity,
      queued: by[STATUS.QUEUED] ?? 0,
      complete: by[STATUS.COMPLETE] ?? 0,
      error: by[STATUS.ERROR] ?? 0,
      paused: by[STATUS.PAUSED] ?? 0,
      totalSpeed: [...this.tasks.values()].reduce((a, t) => a + (ACTIVE.has(t.status) ? t.speed || 0 : 0), 0),
    };
  }
}

/**
 * How many bytes of this task are really on disk, from its segment journal.
 *
 * Returns null when there is no journal to read, which is not an error: a task
 * that never started has none. The journal is written as the transfer proceeds,
 * so it stays accurate across a crash in a way that the queue file cannot.
 *
 * @param {object} task
 * @returns {Promise<number|null>}
 */
export async function resolveDiskProgress(task) {
  if (!task.dir || !task.filename) return null;
  const segmentDir = path.join(task.dir, task.filename + ".downloadx", "segments");
  let names = [];
  try { names = await fsp.readdir(segmentDir); }
  catch { return null; }
  let recorded = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(await fsp.readFile(path.join(segmentDir, name), "utf8"));
      if (typeof rec.downloaded === "number") recorded += rec.downloaded;
    } catch { /* a torn record is not counted */ }
  }
  return recorded;
}
