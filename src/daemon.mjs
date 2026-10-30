// The daemon: wires config, queue, downloader, scheduler and API into one
// long-lived process, and writes the runtime file clients use to find it.

import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { paths, ensureDirs } from "./paths.mjs";
import { Config } from "./config.mjs";
import { QueueManager } from "./queue.mjs";
import { Downloader } from "./downloader.mjs";
import { Scheduler } from "./scheduler.mjs";
import { Logger } from "./logger.mjs";
import { ClipboardWatcher } from "./clipboard.mjs";
import { CaptureProxy } from "./proxy.mjs";
import { CertificateAuthority } from "./ca.mjs";
import { isExcepted } from "./rules.mjs";
import { ApiServer } from "./api.mjs";
import { UrlHistory } from "./history.mjs";
import { reconcileOrphans } from "./ytdlp.mjs";
import { ACTIVE } from "./task.mjs";
import { VERSION } from "./version.mjs";

/**
 * queueId values whose adds are held for confirmation while `askBeforeAdd`
 * is on. Manual adds (CLI, GUI, plain API calls without a source queueId)
 * are never held.
 */
export const ASK_QUEUE_IDS = new Set(["extension", "clipboard"]);

/**
 * 回环地址判定(第10项,剪贴板来源专用):localhost、127.0.0.0/8、::1。
 *
 * 只看 host、不看 scheme;解析失败一律不算回环。刻意不做成"按地址一刀切":
 * 本地 dev server、容器产物走回环是下载器的正当用法,只有剪贴板这个
 * 无差别来源才按回环过滤(挂起路径与 manual/API 来源不拦)。
 */
export function isLoopbackUrl(url) {
  let host = "";
  try {
    // WHATWG URL 对 IPv6 的 hostname 保留方括号("[::1]"),剥掉再比。
    host = new URL(String(url || "")).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch { return false; }
  if (host === "localhost" || host === "::1") return true;
  return /^127(\.\d+){3}$/.test(host);
}

/**
 * How long the identity probe (P-19) waits for the recorded holder's
 * /api/status. The probe goes to loopback and answers in milliseconds when
 * the holder is alive; three seconds therefore only runs out on a holder
 * whose event loop is wedged — which is precisely the state in which
 * taking the root over is the recovery, not the hazard.
 */
const LOCK_PROBE_TIMEOUT_MS = 3000;

/**
 * Single writer per data root.
 *
 * Two daemons sharing one root split-brain the queue: each holds its own
 * in-memory task list and queue.json is last-writer-wins, so a click served
 * by one daemon is invisible to the GUI watching the other (observed
 * 2026-10-24: a stale second daemon completed a download the desktop window
 * never showed, and its pre-fix memory rewrote credentials back to disk).
 * The lock file is created exclusively before listen(); a starter whose
 * holder is still alive stands down, and a dead holder's lock is broken so
 * crash recovery keeps working.
 *
 * Lock file shape: { pid, port, token, startedAt }. It is written in two
 * steps, because the lock must exist before listen() (two daemons must not
 * race for the port) while port/token only exist after it: the exclusive
 * create writes { pid, startedAt }, and stampLockIdentity() adds the
 * holder's port and token once the API answers. Those two fields are the
 * identity credentials a later starter probes (see holderStillOurs).
 *
 * P-19 (pid reuse): "the pid is alive" is not identity. Operating systems
 * recycle pids aggressively, so a crashed daemon's lock can name a pid that
 * now belongs to an unrelated process; kill(pid, 0) then succeeds and the
 * starter used to refuse to boot until a human deleted daemon.lock. Plan A
 * (compare the holder's process start time against /proc/<pid>/stat field
 * 22) is provable on Linux but has no zero-dependency equivalent on Windows
 * (Node exposes no process creation time; shelling out to wmic is a
 * dependency and a fragile one), so this is plan B: after the pid reads
 * alive, one GET /api/status to the recorded port with the recorded token.
 * Only a service that knows the token the lock itself carries — i.e. the
 * daemon that wrote the lock — can answer 200 with a downloadx status body,
 * on every platform, with nothing but the built-in fetch.
 */
async function acquireRootLock() {
  const lockPath = path.join(paths.root, "daemon.lock");
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle;
    try {
      handle = await fsp.open(lockPath, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let holder = null;
      try { holder = JSON.parse(await fsp.readFile(lockPath, "utf8")); } catch { /* torn file */ }
      const holderPid = holder?.pid ?? null;
      let alive = false;
      if (holderPid) {
        try { process.kill(holderPid, 0); alive = true; }
        catch (e) { alive = e.code === "EPERM"; }
      }
      // P-19: a live pid proves only that the number has an owner, not that
      // the owner is our daemon. Probe the recorded identity before letting
      // the pid alone block startup.
      if (alive && !(await holderStillOurs(holder))) alive = false;
      if (alive) {
        const err = new Error(
          "another downloadx daemon (pid " + holderPid + ") already owns this data root (" +
          paths.root + ") and confirmed its identity via /api/status; " +
          "stop that daemon, or delete daemon.lock there to force takeover"
        );
        err.code = "DAEMON_PEER_OWNER";
        throw err;
      }
      // Stale lock from a crashed daemon (or a pid the OS handed to an
      // unrelated process): break it and retry the create.
      await fsp.rm(lockPath, { force: true }).catch(() => {});
      continue;
    }
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
    await handle.close();
    return lockPath;
  }
  const err = new Error("could not acquire the daemon lock at " + lockPath);
  err.code = "DAEMON_LOCK_BUSY";
  throw err;
}

/**
 * Identity probe for a lock's holder (P-19, plan B).
 *
 * A lock written before this change (or in the window between the exclusive
 * create and stampLockIdentity) carries only { pid, startedAt }: no
 * credentials to probe, so the starter falls back to the pre-P-19 rule —
 * a live pid is yielded to. That window is exactly "a holder is starting
 * up right now", where yielding is the correct behaviour anyway, and an
 * old-format leftover keeps its manual-delete escape hatch.
 *
 * For a lock with port+token: one GET /api/status to loopback with the
 * token from the lock. The token is 24 random bytes only the writing daemon
 * ever held (lock file, runtime.json, its own memory), so a 200 that speaks
 * downloadx is proof the process behind the pid is still the holder. A
 * reused pid's process cannot know the token; nothing on that port does.
 *
 * "version matches" is read as: the body carries a non-empty version string,
 * i.e. it is a downloadx /api/status answering. Deliberately NOT strict
 * equality with this binary's VERSION: an older daemon still legitimately
 * owns the root during an upgrade, and breaking a live holder's lock would
 * re-create the exact split-brain this lock exists to prevent — the
 * identity question (is it our daemon?) is what the probe answers, not the
 * build question (is it my build?).
 *
 * Any transport failure, non-200, unparsable body or missing version means
 * the holder is gone: resolved as false, and the caller treats the lock as
 * stale. The probe never throws.
 *
 * @returns {Promise<boolean>} true when the holder is (still) ours and live.
 */
async function holderStillOurs(holder) {
  if (!holder || !Number.isInteger(holder.port) || !holder.token) return true; // legacy/unstamped: yield on pid alone
  try {
    const res = await fetch(`http://127.0.0.1:${holder.port}/api/status`, {
      headers: { "x-downloadx-token": String(holder.token) },
      signal: AbortSignal.timeout(LOCK_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return typeof body?.version === "string" && body.version.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Add this daemon's port and token to the lock it holds (P-19).
 *
 * Called right after listen(): the exclusive create could not know them,
 * and every later starter needs both to run the identity probe. Written
 * temp-then-rename so a concurrent reader sees either the complete old
 * record or the complete new one, never a torn half of either. If the lock
 * cannot be read back (deleted out from under us), nothing is written —
 * recreating the file would fabricate a lock nobody won exclusively.
 */
async function stampLockIdentity(lockPath, { port, token }) {
  let base = {};
  try { base = JSON.parse(await fsp.readFile(lockPath, "utf8")); } catch { return; }
  const tmp = lockPath + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify({ ...base, pid: process.pid, port, token }), "utf8");
  await fsp.rename(tmp, lockPath);
}

/**
 * Pending approvals: the "ask before add" holding pen.
 *
 * Adds that arrive without the user watching a download manager — a browser
 * extension click, a URL copied to the clipboard — are held here until the
 * user says yes (POST /api/pending/:id/approve, optionally overriding
 * dir/filename/category) or no (POST /api/pending/:id/reject).
 *
 * Timeout policy: after `askBeforeAddTimeoutMs` (default 5 minutes) the entry
 * is queued to the DEFAULT directory on its own. The alternative — dropping
 * an unapproved entry — would silently discard a link the user actually
 * acted on (copied it, clicked it), and a download nobody wanted costs a few
 * bytes while a silently dropped one costs the user's trust. Better to
 * download something unconfirmed than to lose what was clicked.
 *
 * The table is deliberately memory-only (the task sheet allows this): an
 * approval is worthless after a daemon restart because the moment has
 * passed, and on orderly shutdown the entries are flushed into the queue
 * (same default-directory fallback) so nothing is lost to a restart either.
 * A hard kill still loses whatever was waiting — which is why every state
 * change (held / approved / rejected / timeout / flush / superseded /
 * failure) writes one daemon log line: a link that disappears must never
 * also disappear from the log (P-1, 2026-10-24).
 */
export class PendingManager {
  /**
   * @param {{ config:any, queue:any, log?:any }} deps
   */
  constructor({ config, queue, log = null } = {}) {
    this.config = config;
    this.queue = queue;
    this.log = log;
    /** pendingId -> record, insertion ordered. */
    this.items = new Map();
    /** pendingId -> armed timeout. */
    this.timers = new Map();
    /**
     * SSE publisher, wired by the daemon once the ApiServer exists:
     * (type, payload) => void. Kept as a field (not a constructor dep)
     * because the API is created after this manager.
     */
    this.onPush = null;
  }

  /** Is asking before adding enabled right now? (live config read) */
  get enabled() {
    return this.config ? this.config.get("askBeforeAdd") !== false : true;
  }

  /** How long an entry may wait, ms. Falls back to the 5-minute default. */
  get timeoutMs() {
    const n = Number(this.config?.get("askBeforeAddTimeoutMs"));
    return Number.isFinite(n) && n >= 1000 ? n : 5 * 60 * 1000;
  }

  #push(type, payload) {
    try { this.onPush?.(type, payload); } catch { /* a dead SSE client must not break the gate */ }
  }

  /** Public view of one record; carries no credentials. */
  view(rec) {
    return {
      id: rec.id,
      url: rec.url,
      filename: rec.filename,
      dir: rec.dir,
      category: rec.category,
      kind: rec.kind,
      queueId: rec.queueId,
      tags: [...rec.tags],
      createdAt: rec.createdAt,
      expiresAt: rec.expiresAt,
    };
  }

  list() { return [...this.items.values()].map((r) => this.view(r)); }

  get(id) { return this.items.get(id) ?? null; }

  /**
   * Hold a new add. A URL already pending is not held twice: the caller gets
   * the existing record with `duplicate: true`, so a repeated clipboard copy
   * or extension click cannot stack confirmations for one download.
   *
   * Every state change of the pen is logged (P-1, 2026-10-24: an entry once
   * vanished between "held" and everywhere else with zero log lines, leaving
   * nothing to diagnose; now creation and each exit path leave one line, so
   * a post-mortem always shows how far an entry got).
   * @returns {{ id:string, duplicate:boolean }}
   */
  add(input) {
    const url = String(input?.url ?? "").trim();
    if (!url) throw new Error("url is required");
    for (const rec of this.items.values()) {
      if (rec.url === url) return { id: rec.id, duplicate: true };
    }
    const now = Date.now();
    const rec = {
      id: randomUUID(),
      url,
      filename: input.filename ?? null,
      dir: input.dir ?? null,
      category: input.category ?? null,
      kind: input.kind ?? null,
      // Page context the extension captured; kept so an approved task
      // authenticates exactly as the manual add would have.
      headers: input.headers || {},
      referer: input.referer ?? null,
      cookies: input.cookies ?? null,
      queueId: input.queueId ?? "default",
      tags: [...(input.tags || [])],
      meta: { ...(input.meta || {}) },
      createdAt: now,
      expiresAt: now + this.timeoutMs,
    };
    this.items.set(rec.id, rec);
    this.#arm(rec);
    this.log?.info(`pending: held ${rec.url} (source ${rec.queueId}, id ${rec.id.slice(0, 8)})`);
    this.#push("pending_added", this.view(rec));
    return { id: rec.id, duplicate: false };
  }

  #arm(rec) {
    const timer = setTimeout(() => {
      this.timers.delete(rec.id);
      // The timeout fallback queues to the default directory: same reasoning
      // as the class comment — an unconfirmed download beats a dropped one.
      // `superseded` covers the rare case where the URL is already live when
      // the timer fires (the entry is dropped with a WARN, never silently).
      try {
        this.#resolve(rec.id, { action: "timeout", forceDefaultDir: true, removeOnConflict: true });
      } catch (err) {
        // queue.add failed (#resolve already WARNed): keep the entry in the
        // pen and re-arm, so the next timeout tick retries instead of the
        // throw escaping into an uncaught exception that kills the daemon.
        if (this.items.has(rec.id)) this.#arm(this.items.get(rec.id));
      }
    }, Math.max(1000, this.timeoutMs));
    timer.unref?.();
    this.timers.set(rec.id, timer);
  }

  #disarm(id) {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  /** Credentials never leave through a view, but they do reach the task. */
  #taskInput(rec, { dir, filename, category, forceDefaultDir = false } = {}) {
    const pick = (v) => (typeof v === "string" && v.trim() ? v : undefined);
    return {
      url: rec.url,
      filename: pick(filename) ?? rec.filename,
      // forceDefaultDir is the timeout/shutdown fallback: no directory the
      // user never confirmed, let the engine place the file in defaultDir.
      dir: forceDefaultDir ? null : (pick(dir) ?? rec.dir),
      category: pick(category) ?? rec.category,
      kind: rec.kind || undefined,
      headers: rec.headers,
      referer: rec.referer,
      cookies: rec.cookies,
      queueId: rec.queueId,
      tags: [...rec.tags],
      meta: { ...rec.meta },
    };
  }

  /**
   * Take an entry out of the pen and queue it via the queue's own add()
   * path, so history, persistence and scheduling behave exactly as for any
   * other add. Shared by approve (user overrides), the timeout fallback and
   * the shutdown flush.
   *
   * Ordering and logging are the P-1 contract: the entry is removed only
   * AFTER queue.add succeeds (a failure keeps it retryable instead of
   * evaporating), and every exit — queued, superseded, or failed — leaves
   * one log line, so no entry can leave the pen silently.
   *
   * @returns {{kind:"not_found"}|{kind:"conflict", existingTaskId:string}|{kind:"queued", task:object}}
   */
  #resolve(id, { action, dir, filename, category, forceDefaultDir = false, removeOnConflict = false } = {}) {
    const rec = this.items.get(id);
    if (!rec) return { kind: "not_found" };
    // Same-URL in-flight guard, same statuses the API route and the extension
    // host use: approving a URL that is already downloading must not start a
    // second transfer of it.
    const live = this.#liveTaskFor(rec.url);
    if (live) {
      if (removeOnConflict) {
        this.items.delete(id);
        this.#disarm(id);
        this.log?.warn(`pending: ${RESOLVE_LABEL[action] ?? action} superseded by live task ${live.id.slice(0, 8)}, dropped ${rec.url}`);
        this.#push("pending_resolved", { id, action: "superseded", url: rec.url, taskId: live.id });
      }
      return { kind: "conflict", existingTaskId: live.id };
    }
    // Queue first, remove after: on a queue.add failure the entry stays in
    // the pen (WARN on the log, caller may retry) — the entry must not be
    // deleted ahead of a queue.add that never happened.
    let task;
    try {
      task = this.queue.add(this.#taskInput(rec, { dir, filename, category, forceDefaultDir }));
    } catch (err) {
      this.log?.warn(`pending: ${RESOLVE_LABEL[action] ?? action} failed for ${rec.url}: ${err.message} (entry kept)`);
      throw err;
    }
    this.items.delete(id);
    this.#disarm(id);
    this.#push("pending_resolved", { id, action, url: rec.url, taskId: task.id });
    this.log?.info(`pending: ${RESOLVE_LABEL[action] ?? action} -> queued ${rec.url} (task ${task.id.slice(0, 8)})`);
    return { kind: "queued", task };
  }

  /** queue.add is synchronous, so this is too. */
  approve(id, overrides = {}) {
    return this.#resolve(id, { action: "approved", ...overrides });
  }

  /** Forget an entry without queuing anything. @returns {boolean} */
  reject(id) {
    const rec = this.items.get(id);
    if (!rec) return false;
    this.items.delete(id);
    this.#disarm(id);
    this.log?.info(`pending: rejected ${rec.url}`);
    this.#push("pending_resolved", { id, action: "rejected", url: rec.url });
    return true;
  }

  #liveTaskFor(url) {
    for (const t of this.queue.tasks.values()) {
      if (t.url === url && ACTIVE_LIVE.has(t.status)) return t;
    }
    return null;
  }

  /**
   * Shutdown fallback: every entry still waiting goes into the queue now
   * (default directory, like the timeout). Restarting the daemon must not be
   * a way to silently lose links the user acted on.
   *
   * A failing entry must not take the others with it, and must not be lost
   * silently either: #resolve keeps it in the pen and WARNs with its URL, so
   * the shutdown log always explains a link that did not make it into the
   * queue (P-1: the generic one-line "pending flush" error named nothing and
   * the failed entry was already gone from the table).
   */
  flushToQueue() {
    const out = [];
    for (const id of [...this.items.keys()]) {
      try {
        const r = this.#resolve(id, { action: "flush", forceDefaultDir: true, removeOnConflict: true });
        if (r.kind === "queued") out.push(r.task);
      } catch { /* already WARNed per entry in #resolve; keep flushing the rest */ }
    }
    return out;
  }

  /** Drop every timer without resolving anything (test teardown). */
  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

/**
 * Statuses that make a URL "already in progress". Deliberately the same set
 * the API route and the extension host (LIVE_TASK_STATUSES in
 * extension/host.mjs) use: error and complete are not live, because a failed
 * or finished download is a legitimate reason to add the URL again.
 */
const ACTIVE_LIVE = new Set(["queued", "connecting", "downloading", "paused"]);

/** Log labels for #resolve actions (the wire `action` stays machine-facing). */
const RESOLVE_LABEL = { approved: "approved", timeout: "timeout", flush: "shutdown flush" };

/** Canary cadence: one probe per half hour of daemon life. */
const CANARY_INTERVAL_MS = 30 * 60 * 1000;

/**
 * How long stop() waits between pausing everything and the terminal
 * queue.saveNow(): one full save-debounce window (scheduleSave's 400ms in
 * queue.mjs) plus abort-propagation slack, so no straggler debounced save
 * can land after the daemon's final write. See stop() for the full race.
 */
const STOP_SAVE_QUIESCE_MS = 500;

/** The filesystem ops one probe uses (injectable so tests never touch a real volume). */
const CANARY_FS = {
  mkdir: (dir) => fsp.mkdir(dir, { recursive: true }),
  open: (p) => fsp.open(p, "wx"),
  rm: (p, opts) => fsp.rm(p, opts),
};

/** "12604s" -> "3.5h"; keeps the flip line human-readable next to the raw number. */
function humanUptime(seconds) {
  if (seconds >= 5400) return (seconds / 3600).toFixed(1) + "h";
  if (seconds >= 90) return (seconds / 60).toFixed(1) + "m";
  return Math.round(seconds) + "s";
}

/**
 * EPERM canary: a tiny write probe into the default download directory, the
 * forensic tripwire for the unsolved "long-lived daemon silently loses write
 * access to its download volume" disease.
 *
 * Two recordings (施工记录-20261024.md): 附记七 (2026-10-24 18:1x —
 * EPERM mkdir 'E:\Downloads\video\...downloadx', every other process writing
 * the same volume fine, only the running daemon poisoned) and the 批-3 closeout
 * (2026-10-25 — pid 3432, 3.5h uptime, same pattern, restart healed). Both
 * were diagnosed AFTER the fact: nobody knows when the poison began, which is
 * exactly the datum the next recurrence needs. This canary takes one reading
 * every 30 minutes (and one at start) so the flip is caught in the act.
 *
 * One probe: mkdir the default dir (recursive, idempotent — and the syscall
 * the poisoned daemons failed on), create a NEW file in it with an exclusive
 * 'wx' open, write a <1KB JSON payload, close, delete. Nothing else is touched
 * and nothing is left behind.
 *
 * Reporting is edge-triggered: one WARN line when OK turns into failure (with
 * code / syscall / path / errno / uptime / task count / live handle count),
 * one INFO line when write recovers, silence while a state holds. A poison
 * that never lifts costs two lines in the rotating log, timestamped to the
 * half hour it began.
 *
 * Containment is total: the interval is unref'd, every step is wrapped,
 * probeNow() resolves (never rejects) with a plain result object, and nothing
 * in the download path awaits or observes the canary. A canary that cannot
 * even log still stays silent.
 */
export class EpermCanary {
  /** Guards against a manual probe overlapping a timer tick. */
  #inFlight = false;

  /**
   * @param {{ config:any, queue?:any, log?:any, intervalMs?:number, io?:object }} deps
   *   config: live-read for defaultDir each probe (a config change moves the
   *   watch at the next tick). queue/log may be null. io overrides the
   *   filesystem ops for tests: { mkdir(dir,opts), open(path) -> handle,
   *   rm(path,opts) } with handle = { writeFile(data), close() }.
   */
  constructor({ config, queue = null, log = null, intervalMs = CANARY_INTERVAL_MS, io = null } = {}) {
    this.config = config;
    this.queue = queue;
    this.log = log;
    const n = Number(intervalMs);
    this.intervalMs = Number.isFinite(n) && n >= 1000 ? n : CANARY_INTERVAL_MS;
    this.io = io ?? CANARY_FS;
    this.timer = null;
    /** "unknown" until the first probe completes, then "ok" | "fail". */
    this.state = "unknown";
    /** Completed probes (a skipped tick is not a probe). */
    this.probes = 0;
    /** ISO time of the last OK probe; null before the first. */
    this.lastOkAt = null;
    /** ISO time of the first failure of the current failing run. */
    this.firstFailAt = null;
    /** Consecutive failed probes in the current failing run. */
    this.failRun = 0;
    /** The last result object, also what probeNow() resolves with. */
    this.lastResult = null;
  }

  get started() { return this.timer !== null; }

  /** Arm the unref'd interval and take the first reading at once. */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try { this.probeNow(); } catch { /* a tick must never throw */ }
    }, this.intervalMs);
    this.timer.unref?.();
    // One line per boot so a post-mortem reading the log knows the tripwire
    // existed at all — and when it was last re-armed (a heal-by-restart).
    try {
      this.log?.info?.("eperm-canary: armed, first reading now, then every " + humanUptime(this.intervalMs / 1000));
    } catch { /* never */ }
    // First reading immediately: a daemon restarted to heal a poisoned
    // predecessor proves within its first seconds that the fresh process
    // writes — and a daemon that is poisoned from birth is caught at boot.
    try { this.probeNow(); } catch { /* same containment */ }
  }

  /** Disarm the interval (daemon stop / test teardown). */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The directory the probe watches, read live; null when none is configured. */
  #probeDir() {
    try {
      const dir = this.config?.get?.("defaultDir");
      return typeof dir === "string" && dir.trim() ? dir : null;
    } catch {
      return null;
    }
  }

  #tasks() {
    try {
      const tasks = this.queue?.tasks;
      if (!(tasks instanceof Map)) return { total: null, active: null };
      let total = 0;
      let active = 0;
      for (const t of tasks.values()) {
        total++;
        if (t && ACTIVE.has(t.status)) active++;
      }
      return { total, active };
    } catch {
      return { total: null, active: null };
    }
  }

  #handles() {
    try { return process._getActiveHandles?.().length ?? null; } catch { return null; }
  }

  /**
   * Take one reading. Always resolves, never throws; the worst a fully broken
   * canary can do is write a log line.
   * @returns {Promise<{ran:boolean, ok?:boolean, flipped?:boolean, skipped?:string,
   *   code?:string|null, syscall?:string|null, path?:string|null, probePath?:string|null,
   *   dir?:string|null, probe?:number, at?:string}>}
   */
  async probeNow() {
    if (this.#inFlight) return this.lastResult;
    this.#inFlight = true;
    try {
      const dir = this.#probeDir();
      if (!dir) {
        // No default directory configured: nothing to watch. Not an error and
        // not a state change — the canary stands down until the config grows
        // a defaultDir, and no filesystem op happens at all.
        this.lastResult = { ran: false, skipped: "defaultDir", at: new Date().toISOString() };
        return this.lastResult;
      }
      const probe = this.probes + 1;
      const probePath = path.join(dir, ".downloadx-eperm-canary-" + randomUUID().slice(0, 8) + ".tmp");
      let err = null;
      try {
        // The create-on-volume path a real transfer uses: ensure the target
        // directory (the syscall the poisoned daemons failed on), then create
        // a NEW entry in it with an exclusive open.
        await this.io.mkdir(dir, { recursive: true });
        const payload = JSON.stringify({
          canary: "downloadx-eperm",
          pid: process.pid,
          probe,
          at: new Date().toISOString(),
        }) + "\n";
        const handle = await this.io.open(probePath);
        try { await handle.writeFile(payload, "utf8"); } finally { await handle.close(); }
        try { await this.io.rm(probePath, { force: true }); }
        catch (rmErr) {
          // The write is the signal; a probe file we cannot delete is only
          // litter. One WARN per occurrence (at most ~48/day) and never a
          // state flip on it.
          this.log?.warn?.("eperm-canary: probe file not removable (" +
            ((rmErr && (rmErr.code || rmErr.message)) || "unknown") + "): " + probePath);
        }
      } catch (e) {
        err = e ?? new Error("unknown probe failure");
      }
      const ok = !err;
      const prev = this.state;
      const prevFirstFailAt = this.firstFailAt;
      const prevFailRun = this.failRun;
      this.probes = probe;
      this.state = ok ? "ok" : "fail";
      if (ok) {
        this.lastOkAt = new Date().toISOString();
        this.firstFailAt = null;
        this.failRun = 0;
      } else {
        if (this.failRun === 0) this.firstFailAt = new Date().toISOString();
        this.failRun++;
      }
      // Edge-triggered reporting: ok only logs when it ends a failing run;
      // a failure logs when it is not the continuation of one — including a
      // very first probe that already fails (a daemon born poisoned is the
      // single most interesting reading of all).
      const flipped = ok ? prev === "fail" : prev !== "fail";
      if (flipped) {
        this.#logFlip({ ok, prev, err, dir, probePath, probe, prevFirstFailAt, prevFailRun });
      }
      this.lastResult = {
        ran: true,
        ok,
        flipped,
        code: err?.code ?? null,
        syscall: err?.syscall ?? null,
        path: err?.path ?? probePath,
        probePath,
        dir,
        probe,
        at: new Date().toISOString(),
      };
      return this.lastResult;
    } finally {
      this.#inFlight = false;
    }
  }

  /** One log line per state transition; logging itself must never throw. */
  #logFlip({ ok, prev, err, dir, probePath, probe, prevFirstFailAt, prevFailRun }) {
    try {
      const up = process.uptime();
      const t = this.#tasks();
      const ctx =
        "uptime=" + up.toFixed(0) + "s (" + humanUptime(up) + ")" +
        " tasks=" + (t.total ?? "?") +
        " active=" + (t.active ?? "?") +
        " activeHandles=" + (this.#handles() ?? "?") +
        " pid=" + process.pid +
        " probe=#" + probe;
      if (ok) {
        const since = prevFirstFailAt
          ? " after failing since " + prevFirstFailAt + " (" + prevFailRun + " probes)"
          : "";
        this.log?.info?.("eperm-canary: write recovered on " + dir + since + " — " + ctx);
      } else {
        this.log?.warn?.(
          "eperm-canary: WRITE LOST on " + dir + " — " +
          "code=" + ((err && err.code) || "?") +
          " syscall=" + ((err && err.syscall) || "?") +
          " errno=" + ((err && err.errno !== undefined && err.errno !== null) ? err.errno : "?") +
          " path=" + ((err && err.path) || probePath) +
          (prev === "unknown" ? " firstProbe=true" : "") +
          " lastOk=" + (this.lastOkAt || "never") +
          " — " + ctx,
        );
      }
    } catch { /* the tripwire must never trip the daemon */ }
  }
}

export class Daemon {
  constructor({ port = 0, host = "127.0.0.1" } = {}) {
    this.port = port;
    this.host = host;
    this.started = false;
  }

  async init() {
    await ensureDirs();
    this.log = new Logger();
    this.config = new Config();
    await this.config.load();

    this.queue = new QueueManager({ config: this.config });
    await this.queue.load();

    // 第3项配套的启动钩子:上一轮 detached 的 yt-dlp/ffmpeg 子进程不再随
    // daemon 崩溃被带走,这里按任务里记录的 pid 探活清理一次(只动"记录了
    // pid 且任务非运行态"的条目),再把清掉的字段落盘。放在 Downloader/API
    // 起来之前,新任务还没机会派生新的外部进程。
    try {
      const orphanReport = await reconcileOrphans(this.queue.tasks.values());
      if (orphanReport.probed > 0) {
        this.log.info("启动孤儿清理: 探测 " + orphanReport.probed + " 个记录的 pid, 结束 " +
          orphanReport.killed.length + " 个, 清理字段 " + orphanReport.cleared.length + " 条");
        await this.queue.saveNow().catch((err) => this.log.warn("孤儿清理落盘失败: " + err.message));
      }
    } catch (err) {
      this.log.warn("孤儿清理失败: " + ((err && err.message) || err));
    }

    // URL history is loaded before the API starts so the first request already
    // sees the previous session's entries.
    this.history = new UrlHistory();
    await this.history.load();
    // Every URL that enters the queue is recorded, whatever put it there: the
    // API, the clipboard, a capture, a schedule or a grab.
    this.queue.on("added", (task) => {
      if (task && task.url) {
        try { this.history.record(task.url, { filename: task.filename, dir: task.dir, source: task.queueId || "queue" }); }
        catch (err) { this.log.warn("history: " + err.message); }
      }
    });

    this.downloader = new Downloader({ config: this.config, queue: this.queue });
    this.scheduler = new Scheduler({ queue: this.queue, config: this.config, log: this.log });
    await this.#loadSchedules();

    // The ask-before-add holding pen exists before the API so the first
    // request can already see it; its SSE publisher is wired once the API
    // exists, a line below.
    this.pending = new PendingManager({ config: this.config, queue: this.queue, log: this.log });

    // EPERM canary (附记七 / 批-3 closeout forensics): one tiny write probe
    // into the default download directory every 30 minutes, first reading at
    // once, so the next "long-lived daemon loses write access" recurrence is
    // caught at its first moment with a full record (code/syscall/path/errno/
    // uptime/tasks) instead of being discovered by a failed download hours
    // later. Pure observer: unref'd timer, total failure containment, and
    // nothing in the download path awaits it.
    this.canary = new EpermCanary({ config: this.config, queue: this.queue, log: this.log });
    this.canary.start();

    this.api = new ApiServer({
      queue: this.queue,
      config: this.config,
      downloader: this.downloader,
      scheduler: this.scheduler,
      log: this.log,
      history: this.history,
      pending: this.pending,
    }).startRunner();
    this.pending.onPush = (type, payload) => this.api.pushEvent(type, payload);

    // A Windows console-less process cannot rely on SIGINT, so an explicit
    // API request is the dependable way to ask the daemon to stop.
    this.api.onShutdownRequest = () => { this.requestStop("api"); };

    // Clipboard monitoring: a copied URL becomes a queued task, unless the
    // host is on the exception list or the setting is off.
    this.clipboard = new ClipboardWatcher({ config: this.config });
    this.clipboard.on("url", (url) => {
      try {
        if (isExcepted(url, [], this.config.get("exceptions"))) return;
        const existing = [...this.queue.tasks.values()].some((t) => t.url === url);
        if (existing) return;
        // With ask-before-add on, a copied URL waits for confirmation rather
        // than entering the queue unseen (see PendingManager). The config is
        // read here, live, so toggling the setting takes effect at once.
        const queueId = "clipboard";
        if (this.pending.enabled) {
          this.pending.add({ url, queueId, tags: ["clipboard"] });
          this.log.info("clipboard: pending approval for " + url);
        } else if (queueId === "clipboard" && isLoopbackUrl(url)) {
          // 第10项:剪贴板桥曾把回环地址(http://127.0.0.1:8045/…)灌进
          // 队列、全部 401。只过滤 clipboard 这个无差别来源,且只在"未挂起"
          // 分支拦——挂起路径(pending)有人审,manual/API 来源的回环是
          // 本地服务的正当用法,都不在这里碰。
          this.log.info("剪贴板回环地址已跳过: " + url);
        } else {
          this.queue.add({ url, queueId, tags: ["clipboard"] });
          this.log.info("clipboard: queued " + url);
        }
      } catch (err) {
        this.log.warn("clipboard: " + err.message);
      }
    });
    // P-25 guard: when the desktop shell's in-process clipboard bridge is on,
    // do NOT start the PowerShell-polling watcher. The bridge (desktop/main.mjs
    // → electron.clipboard.readText()) replaces a PowerShell derivation that
    // inevitably fails under the 0xC0000142 lineage — every powershell.exe
    // spawned from this daemon's ancestry dies in GUI initialisation before
    // Get-Clipboard ever runs (附记十二/十八; same lineage as the explorer.exe
    // note in desktop/main.mjs). The flag is PATCHed into config.json by the
    // desktop shell before/while the bridge runs, so reading it here at init
    // is reliable; with the bridge off this behaves exactly as before. The
    // watcher object is still constructed so stop() stays a no-op-safe call.
    if (this.config.get("clipboardBridge") === true) {
      this.log.info("clipboard: PowerShell watcher not started (desktop in-process bridge active)");
    } else {
      this.clipboard.start();
    }

    // The capture proxy does what a kernel filter driver would: it sees traffic
    // from any application pointed at it, with no signing requirement. Off by
    // default because it changes how traffic flows.
    this.ca = new CertificateAuthority();
    this.proxy = new CaptureProxy({
      port: this.config.get("captureProxy").port,
      mode: this.config.get("captureProxy").mode,
      config: this.config,
      // Pass the CA itself: #mitmConnect awaits ca.leafFor(host) so a first
      // contact with an unseen host issues and persists its leaf instead of
      // 502ing on the read-only fast path (P-15; the read-only shim kept MITM
      // broken in production until batch-6's acceptor caught it).
      ca: this.ca,
    });
    this.proxy.on("capture", (entry) => {
      this.log.info("capture: " + entry.filename + " (" + entry.reason + ")");
      const cp = this.config.get("captureProxy");
      if (cp.autoQueue && entry.confidence === cp.autoQueueConfidence) {
        try {
          const already = [...this.queue.tasks.values()].some((t) => t.url === entry.url);
          if (!already) {
            this.queue.add({ url: entry.url, filename: entry.filename, queueId: "captured", tags: ["captured"] });
            this.log.info("capture: auto-queued " + entry.filename);
          }
        } catch (err) { this.log.warn("capture auto-queue: " + err.message); }
      }
    });
    this.api.proxy = this.proxy;
    this.api.ca = this.ca;
    if (this.config.get("captureProxy").enabled) {
      this.proxy.start().then(
        (info) => this.log.info("capture proxy on " + info.host + ":" + info.port + " (" + info.mode + ")"),
        (err) => this.log.warn("capture proxy failed to start: " + err.message),
      );
    }

    this.queue.on("warn", (m) => this.log.warn(m));
    this.downloader.on("retry", ({ taskId, segment, attempt, delay, error }) =>
      this.log.warn("[" + taskId.slice(0, 8) + "] retry seg " + segment + " #" + attempt + " in " + delay + "ms: " + error));
    this.downloader.on("downgrade", ({ taskId, message }) =>
      this.log.warn("[" + taskId.slice(0, 8) + "] " + message));

    return this;
  }

  async #loadSchedules() {
    try {
      const file = path.join(paths.root, "schedules.json");
      const raw = JSON.parse(await fsp.readFile(file, "utf8"));
      this.scheduler.loadFrom(raw);
    } catch { /* none saved yet */ }
  }

  async #saveSchedules() {
    const target = path.join(paths.root, "schedules.json");
    const tmp = target + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(this.scheduler.toJSON(), null, 2), "utf8");
    await fsp.rename(tmp, target);
  }

  async start() {
    // Refuse to run beside another daemon on the same data root: the queue
    // file is last-writer-wins, so a second writer silently diverges.
    this.lockPath = await acquireRootLock();
    // remoteAccess widens the bind to every interface so LAN MCP clients can
    // reach /mcp; the Host guard relaxes with it and the mandatory token per
    // route is what keeps uninvited guests out (config comment has the caveats).
    if (this.config.get("remoteAccess")) this.host = "0.0.0.0";
    const info = await this.api.listen({ port: this.port, host: this.host });
    this.info = info;
    // P-19: the lock was created before listen() and carries no identity yet;
    // now that the API answers, record port+token so a later starter can
    // probe this daemon instead of trusting the raw pid.
    await stampLockIdentity(this.lockPath, { port: info.port, token: info.token });
    // Scheduled bandwidth windows must reach the live rate limiter.
    this.scheduler.onTick = (now) => this.scheduler.applySpeedLimit(this.downloader, now);
    this.scheduler.on("speed-limit", ({ limit, schedule }) =>
      this.log.info(schedule ? "speed window active: " + schedule + " @ " + limit + " B/s" : "speed window closed"));
    this.scheduler.start();
    this.scheduler.on("change", () => this.#saveSchedules().catch(() => {}));

    const runtime = {
      pid: process.pid,
      port: info.port,
      host: this.host,
      token: info.token,
      url: info.url,
      startedAt: new Date().toISOString(),
      version: VERSION,
    };
    const tmp = paths.runtime + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(runtime, null, 2), "utf8");
    await fsp.rename(tmp, paths.runtime);

    this.started = true;
    this.log.info("daemon listening on " + info.url);
    return runtime;
  }

  /** Ask the run loop to finish; safe to call more than once. */
  requestStop(reason) {
    if (this._stopRequested) return;
    this._stopRequested = true;
    this.log.info("stop requested (" + reason + ")");
    if (this._shutdown) this._shutdown("api");
  }

  async stop() {
    if (!this.started) return;
    this.clipboard?.stop();
    this.canary?.stop();   // the write tripwire dies with the daemon
    // Entries still awaiting approval are memory-only by design, so a
    // restart would otherwise lose them — the silent drop the timeout policy
    // refuses. Queue them to the default directory instead; the pause loop
    // below settles anything that starts, and saveNow persists the rest.
    if (this.pending && this.pending.items.size) {
      try { this.pending.flushToQueue(); }
      catch (err) { this.log.warn("pending flush: " + err.message); }
    }
    this.pending?.dispose();
    if (this.proxy) { try { await this.proxy.stop(); } catch { /* already down */ } }
    this.scheduler.stop();
    for (const t of [...this.queue.tasks.values()]) {
      if (ACTIVE.has(t.status)) this.queue.pause(t.id);
    }
    // The flush above only survives if this saveNow is the LAST write to
    // queue.json. Queue persistence is debounced (scheduleSave, 400ms) and
    // fire-and-forget, so a save armed before this point — by this queue or
    // by any other QueueManager sharing the process — can land AFTER
    // saveNow and overwrite the just-flushed file with a stale task map,
    // last-writer-wins (paths.queue resolves through the live
    // DOWNLOADX_HOME getter, so the straggler writes wherever the env
    // points now). The aborts above also settle asynchronously (runner
    // catch -> apply -> another armed save). Waiting out one debounce
    // window lets every such straggler write land first; saveNow then
    // clears whatever is still armed and persists the final state as the
    // terminal write. Observed live 2026-10-25: batch1-approvals' flushed
    // entry was erased 44ms after saveNow by exactly such a straggler.
    await new Promise((r) => setTimeout(r, STOP_SAVE_QUIESCE_MS));
    await this.queue.saveNow();
    // Let a pending history append land before the process goes away.
    await this.history?.flush?.().catch(() => {});
    await this.#saveSchedules().catch(() => {});
    await this.api.close();
    await fsp.rm(paths.runtime, { force: true });
    if (this.lockPath) await fsp.rm(this.lockPath, { force: true }).catch(() => { /* best effort */ });
    this.started = false;
    this.log.info("daemon stopped");
  }

  /**
   * Run until a signal arrives or an API client asks for a stop, then save
   * state and release the port. Windows does not reliably deliver SIGINT to a
   * detached process, so the API path is the dependable one there.
   */
  async runForever() {
    await new Promise((resolve) => {
      let stopping = false;
      let pending = null;
      /**
       * Keeps the event loop alive for the duration of shutdown.
       *
       * stop() is a chain of awaited filesystem operations. A detached
       * daemon whose sockets have all gone idle has nothing else keeping the
       * loop busy, so once the loop empties Node runs beforeExit and then
       * exits as soon as the current microtask queue drains — abandoning
       * stop() partway. The observable symptoms were a runtime file that was
       * never removed, a leftover schedules.json.tmp, and `stop` reporting a
       * timeout while the process was already gone.
       *
       * A referenced interval guarantees the loop stays non-empty until
       * shutdown finishes, at which point it is cleared.
       */
      const holdOpen = () => {
        const timer = setInterval(() => {}, 1000);
        timer.unref?.();
        // unref alone would not hold the loop; keep a plain reference too.
        const keep = setTimeout(() => {}, 60000);
        return () => { clearInterval(timer); clearTimeout(keep); };
      };
      const shutdown = (reason) => {
        if (stopping) return pending;
        stopping = true;
        process.stderr.write("  stopping (" + reason + ")...\n");
        const release = holdOpen();
        pending = (async () => {
          try { await this.stop(); }
          catch (err) { this.log.warn("shutdown error: " + err.message); }
          finally { release(); }
        })();
        pending.then(resolve, resolve);
        return pending;
      };
      this._shutdown = shutdown;
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
      // Last resort: if the event loop would otherwise stay busy forever.
      process.on("beforeExit", () => { if (!stopping) shutdown("beforeExit"); });
    });
  }
}

/** Read the runtime file, or null when no daemon is running. */
export async function readRuntime() {
  try {
    const raw = JSON.parse(await fsp.readFile(paths.runtime, "utf8"));
    // A stale file from a crashed daemon must not look alive.
    try { process.kill(raw.pid, 0); } catch { return null; }
    return raw;
  } catch {
    return null;
  }
}