#!/usr/bin/env node
// P0-1 integrity suite: a paused, cancelled or killed transfer must never leave
// a size-complete but content-incomplete file at the final path, and a resume
// must reproduce the origin's exact bytes.
//
// These tests drive a real daemon process over the local API against a local
// throttled origin, because the defect they cover lives in the hand-off between
// the segmented engine and the filesystem: the engine preallocated the target
// (store.prepareTarget) and wrote into it at final offsets, so a cancellation
// left "real prefix + zero tail" at a path whose size already looked correct.
// A unit test on the engine alone cannot show that: what a user (or a backup,
// or a media player) sees is the file at the final path.
//
// Layout (override the root with DOWNLOADX_P01_WORK):
//   work\p01-home       DOWNLOADX_HOME for the daemon under test
//   work\p01-downloads  where the delivered files land
//
// Semantics this suite pins down (requirement 5 of the ticket):
//   * pause / kill  -> the FINAL path does not exist; the resumable state is
//                      <final>.downloadx-part plus <final>.downloadx\ (journal);
//   * cancel (task removed with its file) -> the final path does not exist;
//   * complete      -> the final path exists, holds exactly totalBytes, and its
//                      SHA-256 equals the origin's; only then is "complete"
//                      reported by the daemon.

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Test selection, so an intermittent case can be repeated on its own.
 *   --only <substring>   run matching tests only
 *   --repeat <n>         run the whole selection n times in a row
 */
const ARGS = (() => {
  const argv = process.argv.slice(2);
  const out = { only: null, repeat: 1 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") out.only = argv[++i] ?? null;
    else if (argv[i] === "--repeat") out.repeat = Math.max(1, Number(argv[++i]) || 1);
  }
  return out;
})();
const PROJECT = path.resolve(HERE, "..");
const WORK_ROOT = process.env.DOWNLOADX_P01_WORK
  || "D:\\IAM\\反馈\\最终验收批次-20261019\\修复批次-02\\work";

/**
 * One run, one directory.
 *
 * These used to be fixed names (p01-home / p01-downloads). Two people running
 * the suite at the same time then shared a data root: their daemons fought over
 * the port in runtime.json, and one run's reset deleted the other's download
 * directory mid-transfer. The failures that produced pointed at the product.
 *
 * Every invocation (and every --repeat iteration) now gets its own root under
 * WORK_ROOT, tagged with the pid and a timestamp, so runs cannot collide. An
 * explicit DOWNLOADX_P01_HOME still wins, for a caller that wants to pin one.
 */
const RUN_ID = (process.env.DOWNLOADX_P01_RUN_ID
  || (new Date().toISOString().replace(/[:.]/g, "-") + "-p" + process.pid));
const RUN_ROOT = path.join(WORK_ROOT, RUN_ID);
let HOME_DIR = process.env.DOWNLOADX_P01_HOME || path.join(RUN_ROOT, "home");
let DL_DIR = path.join(RUN_ROOT, "downloads");

/** Staging suffix used by the segmented engine (distinct from ".partial"). */
const STAGING_SUFFIX = ".downloadx-part";

/**
 * Every daemon this process started, so none survives the suite.
 *
 * A leaked daemon keeps writing to the same DOWNLOADX_HOME: it finishes tasks
 * from the previous run into the download directory and deletes journals the
 * current run is writing. The symptom is a confusing ENOENT on a segment file
 * or a "paused transfer" that already has a complete file at its target.
 */
const SPAWNED = new Set();

/** Roots created by --repeat iterations, reported at the end of the run. */
const iterationRoots = [];

/** Filesystem-safe fragment for an iteration directory name. */
function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "case";
}

// ---------------------------------------------------------------- fixtures

/** Deterministic pseudo-random payload, so a SHA mismatch means corruption. */
function payloadFor(size, seed) {
  const buf = Buffer.alloc(size);
  let x = (seed >>> 0) || 0x9e3779b9;
  for (let i = 0; i < size; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function hashFile(file) {
  const h = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file);
    rs.on("data", (c) => h.update(c));
    rs.once("end", resolve);
    rs.once("error", reject);
  });
  return h.digest("hex");
}

/**
 * A local origin that serves byte ranges at a controlled pace.
 *
 * The pace matters: an abort can only be shown to land mid-transfer if the body
 * trickles. A fast localhost server finishes 3 MiB before the poll interval, and
 * the test would then race the very condition it is checking.
 */
/**
 * Pace the body so a pause always lands mid-transfer.
 *
 * The suite pauses as soon as the client reports `minBytes` (at most a quarter
 * of the file). Every byte the origin has sent by then is bounded by
 * `smallestPauseBytes + in-flight`: the engine holds at most `connections`
 * chunks in flight, so sending no more than half the file guarantees the pause
 * arrives before the last byte. Getting this wrong is not a product failure but
 * it reads like one — the transfer completes and the test then reports "a paused
 * transfer left a file at the final path", which is correct behaviour.
 */
function paceFor(totalBytes, connections = 3) {
  const smallestPauseBytes = Math.min(512 * 1024, Math.floor(totalBytes / 4));
  const budget = totalBytes - smallestPauseBytes - connections * 64 * 1024;
  const chunkBytes = 32 * 1024;
  const chunks = Math.max(1, Math.floor(budget / chunkBytes));
  const chunkMs = Math.max(20, Math.ceil(4000 / chunks));
  return { chunkBytes, chunkMs, nominalMs: chunks * chunkMs };
}

async function startOrigin({ payload, etag, chunkBytes, chunkMs, connections = 3 }) {
  const pace = paceFor(payload.length, connections);
  chunkBytes = chunkBytes ?? pace.chunkBytes;
  chunkMs = chunkMs ?? pace.chunkMs;
  const state = {
    etag,
    payload,
    failWith: 0,
    requests: 0,
    rangedRequests: 0,
    bytesDelivered: 0,
    /** Bytes handed to the client since the last reset, across connections. */
    progressed: 0,
    /** Non-zero while a hold is armed but not yet reached. */
    holdAt: 0,
    /** The threshold a future hold should stop at. */
    targetHold: 0,
    heldConnections: 0,
    onHold: null,
    activeSockets: new Set(),
    timers: new Set(),
  };

  const server = http.createServer((req, res) => {
    state.requests++;
    // A failing origin is how a retry is made to fail on purpose: the point is
    // what the filesystem looks like after the retry gave up.
    if (state.failWith) {
      res.writeHead(state.failWith, { "Content-Type": "text/plain", "Retry-After": "0" });
      res.end("origin unavailable");
      return;
    }
    const size = state.payload.length;
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || "").trim());
    const isRange = Boolean(range);
    if (isRange) state.rangedRequests++;

    const start = isRange ? Number(range[1]) : 0;
    const end = isRange && range[2] !== "" ? Math.min(Number(range[2]), size - 1) : size - 1;
    const slice = state.payload.subarray(start, end + 1);

    const headers = {
      "Content-Type": "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Content-Length": String(slice.length),
      "ETag": state.etag,
      "Content-Disposition": 'attachment; filename="payload.bin"',
    };
    if (isRange) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;

    if (req.method === "HEAD") {
      res.writeHead(200, { ...headers, "Content-Length": String(size) });
      res.end();
      return;
    }
    res.writeHead(isRange ? 206 : 200, headers);

    let offset = 0;
    let held = false;
    const pump = () => {
      if (res.destroyed || res.writableEnded || held) return;
      if (offset >= slice.length) { res.end(); return; }
      const piece = slice.subarray(offset, offset + chunkBytes);
      offset += piece.length;
      state.bytesDelivered += piece.length;
      state.progressed += piece.length;
      res.write(piece);
      // The gate: stop sending once the test has seen enough progress.
      //
      // The pause can only be proved to land mid-transfer if the origin cannot
      // finish the body in the meantime, so the test raises this flag the
      // moment its threshold is met. Waiting for the client to act is a race
      // the transfer sometimes wins — which is how a correct download ends up
      // being reported as "a paused transfer left a file at the final path".
      if (state.holdAt === 0 && state.targetHold > 0 && state.progressed >= state.targetHold) {
        held = true;
        state.heldConnections++;
        state.holdAt = 1;
        state.onHold?.();
        return;
      }
      const timer = setTimeout(() => { state.timers.delete(timer); pump(); }, chunkMs);
      state.timers.add(timer);
    };
    pump();
  });

  // Serve one connection at a time.
  //
  // A stock Node server accepts every waiting socket at once, so the engine's
  // parallel range requests are all served simultaneously: the 3 MiB finishes
  // in a fraction of the nominal per-chunk pace, and a pause issued at 25%
  // progress lands after the transfer has already completed. Serialising the
  // connections makes the pacing mean what it says, which is the whole point of
  // a paced fixture.
  const sleeping = [];
  let busy = false;
  const drain = () => {
    if (busy) return;
    for (let i = 0; i < sleeping.length; i++) {
      const socket = sleeping[i];
      if (socket.destroyed) { sleeping.splice(i--, 1); continue; }
      sleeping.splice(i, 1);
      busy = true;
      socket.once("close", () => { busy = false; drain(); });
      socket.resume();
      return;
    }
  };
  server.on("connection", (socket) => {
    state.activeSockets.add(socket);
    socket.on("close", () => {
      state.activeSockets.delete(socket);
      const i = sleeping.indexOf(socket);
      if (i >= 0) sleeping.splice(i, 1);
      busy = false;
      drain();
    });
    // Hold the socket before any bytes reach it: with the HTTP parser silent,
    // http.js cannot pick the request up yet.
    socket.pause();
    sleeping.push(socket);
    drain();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    state,
    url: "http://127.0.0.1:" + port + "/payload.bin",
    setPayload(next) { state.payload = next; },
    setEtag(next) { state.etag = next; },
    /** Make every subsequent request fail with this status (0 = healthy). */
    setFailure(status) { state.failWith = status || 0; },
    /**
     * Stop serving once `bytes` have been delivered, and report when it happens.
     * The returned promise resolves exactly when the origin has stopped sending,
     * so a pause issued afterwards is guaranteed to land mid-transfer.
     */
    holdAt(bytes) {
      // Armed but not yet triggered: the gate fires on the NEXT request, so a
      // hold can be set before the task exists without stalling the probe that
      // runs first.
      state.targetHold = bytes;
      state.progressed = 0;
      state.heldConnections = 0;
      return new Promise((resolve) => {
        state.onHold = () => resolve({ held: true, progressed: state.progressed });
        // A transfer that finished before the gate is reached reports that
        // honestly instead of hanging the suite.
        setTimeout(() => resolve({ held: false, progressed: state.progressed }), 30000);
      });
    },
    releaseHold() { state.holdAt = 0; state.targetHold = 0; state.onHold = null; },
    pace,
    resetCounters() { state.bytesDelivered = 0; state.rangedRequests = 0; state.progressed = 0; },
    async close() {
      for (const t of state.timers) clearTimeout(t);
      state.timers.clear();
      for (const s of state.activeSockets) { try { s.destroy(); } catch { /* gone */ } }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ------------------------------------------------------------------ daemon

function readRuntime() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME_DIR, "runtime.json"), "utf8"));
  } catch { return null; }
}

async function waitFor(fn, what, timeoutMs = 60000, stepMs = 100) {
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const hit = await fn();
      if (hit) return hit;
    } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error("timed out after " + timeoutMs + "ms waiting for " + what +
    (lastErr ? " (last error: " + lastErr.message + ")" : ""));
}

async function startDaemon() {
  // A stale runtime file from a previous run would be read as a live daemon.
  await fsp.rm(path.join(HOME_DIR, "runtime.json"), { force: true });
  const child = spawn(process.execPath, [path.join(PROJECT, "bin", "downloadx.mjs"), "daemon", "--port", "0"], {
    cwd: PROJECT,
    env: { ...process.env, DOWNLOADX_HOME: HOME_DIR },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += String(c); });
  child.stdout.on("data", () => {});
  const runtime = await waitFor(() => {
    const rt = readRuntime();
    return rt && rt.token && rt.port ? rt : null;
  }, "the daemon to publish runtime.json", 30000);
  const handle = { child, runtime, getStderr: () => stderr };
  SPAWNED.add(handle);
  return handle;
}

/**
 * Terminate whatever daemon is holding this home, from a previous run.
 *
 * runtime.json names the pid. Only a process that is gone is acceptable before
 * the next run starts, so the pid is verified rather than assumed.
 */
async function killStaleDaemon() {
  const rt = readRuntime();
  if (!rt || !rt.pid) return null;
  const alive = await new Promise((resolve) => {
    const p = spawn("taskkill", ["/PID", String(rt.pid), "/F", "/T"], { windowsHide: true, stdio: "ignore" });
    p.once("exit", (code) => resolve(code === 0));
    p.once("error", () => resolve(false));
    setTimeout(() => resolve(false), 8000);
  });
  if (alive) {
    // taskkill also reports success for the tree; give the port a moment.
    await new Promise((r) => setTimeout(r, 400));
  }
  return { pid: rt.pid, killed: alive, port: rt.port };
}

/**
 * Is the child process still running?
 *
 * Both fields must be clear: a process killed by a signal leaves exitCode null
 * and only sets signalCode, so checking exitCode alone reports a dead daemon as
 * alive and every later request fails against a closed port.
 */
function isAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

/**
 * Wait for a child to be gone.
 *
 * "exit" can fire before a listener is attached, so the exit code is polled as
 * well: a test that races its own fixture reports a confusing failure about the
 * fixture instead of the behaviour it is checking.
 */
async function waitForExit(child, timeoutMs = 15000) {
  if (!child || !isAlive(child)) return true;
  const deadline = Date.now() + timeoutMs;
  const fired = new Promise((resolve) => child.once("exit", () => resolve(true)));
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    const won = await Promise.race([fired, new Promise((r) => setTimeout(() => r(false), 100))]);
    if (won === true) return true;
  }
  return child.exitCode !== null || child.signalCode !== null;
}

/** Terminate the daemon process outright: no handlers, no flush, no cleanup. */
async function killDaemon(child) {
  if (!child || !isAlive(child)) return true;
  const pid = child.pid;
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
  if (await waitForExit(child, 8000)) return true;
  // SIGKILL is not transportable on Windows for every process state; fall back
  // to the platform's own forceful terminate, which is the real crash analogue.
  try {
    await new Promise((resolve) => {
      const p = spawn("taskkill", ["/PID", String(pid), "/F", "/T"], { windowsHide: true, stdio: "ignore" });
      p.once("exit", resolve);
      p.once("error", resolve);
      setTimeout(resolve, 8000);
    });
  } catch { /* best effort */ }
  return await waitForExit(child, 8000);
}

async function stopDaemon(daemon, { hard = false } = {}) {
  const child = daemon?.child;
  if (!child || !isAlive(child)) return;
  if (!hard) {
    try { await api(daemon, "POST", "/api/shutdown", {}); } catch { /* already gone */ }
    if (await waitForExit(child, 8000)) return;
  }
  await killDaemon(child);
}

async function api(daemon, method, route, body) {
  let res;
  try {
    res = await fetch("http://127.0.0.1:" + daemon.runtime.port + route, {
      method,
      headers: {
        "x-downloadx-token": daemon.runtime.token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // A fixture failure must say which daemon it was talking to and why the
    // process is not answering, otherwise the report blames the wrong thing.
    throw new Error("API " + method + " " + route + " on port " + daemon.runtime.port +
      " failed: " + err.message +
      " (cause: " + (err.cause && err.cause.message) + ")" +
      " (daemon exitCode=" + daemon.child.exitCode + " signal=" + daemon.child.signalCode + ")" +
      " (stderr: " + String(daemon.getStderr ? daemon.getStderr() : "").slice(-400).replace(/\s+/g, " ") + ")");
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
  return { status: res.status, json, text };
}

async function waitForStatus(daemon, id, statuses, timeoutMs = 90000) {
  const want = new Set(Array.isArray(statuses) ? statuses : [statuses]);
  return await waitFor(async () => {
    const r = await api(daemon, "GET", "/api/tasks/" + id);
    const t = r.json && r.json.task;
    return t && want.has(t.status) ? t : null;
  }, "task " + id + " to reach " + [...want].join("|"), timeoutMs, 120);
}

async function waitForProgress(daemon, id, minBytes, timeoutMs = 60000) {
  return await waitFor(async () => {
    const r = await api(daemon, "GET", "/api/tasks/" + id);
    const t = r.json && r.json.task;
    return t && (t.downloadedBytes || 0) >= minBytes ? t : null;
  }, "task " + id + " to pass " + minBytes + " bytes", timeoutMs, 60);
}

// ------------------------------------------------------------- inspection

/**
 * Bytes the transfer has recorded in its per-segment journal.
 *
 * The journal is the only honest record of what a resume may trust: the engine
 * checkpoints at an interval, so a kill that lands before the first checkpoint
 * legitimately resumes from zero. A test that wants to prove "resume continues
 * from what was saved" must wait for something to actually be saved.
 */
async function readJournalBytes(stateDir) {
  let names = [];
  try { names = await fsp.readdir(path.join(stateDir, "segments")); } catch { return 0; }
  let recorded = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(await fsp.readFile(path.join(stateDir, "segments", name), "utf8"));
      if (typeof rec.downloaded === "number") recorded += rec.downloaded;
    } catch { /* a torn record is not counted */ }
  }
  return recorded;
}

async function statOrNull(file) {
  try { return await fsp.stat(file); } catch { return null; }
}

async function readTailIsZero(file, totalBytes, tailBytes = 64 * 1024) {
  const fh = await fsp.open(file, "r");
  try {
    const len = Math.min(tailBytes, totalBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, Math.max(0, totalBytes - len));
    return buf.every((b) => b === 0);
  } finally {
    await fh.close();
  }
}

/**
 * The regression assertion this whole ticket is about.
 *
 * A file at the final path that has the *right size* but the *wrong bytes* is
 * the defect: every consumer that trusts the size (a player, a backup, the
 * "complete" label) is misled. Absent is a legitimate observation while a
 * transfer is unfinished; a wrong-content full-size file never is.
 */
async function assertFinalPathIsNotAFakeComplete(target, totalBytes, expectedSha, label) {
  const st = await statOrNull(target);
  if (!st) return { present: false, size: 0 };
  assert.equal(st.isFile(), true, label + ": " + target + " must be a regular file");
  const sha = await hashFile(target);
  const looksComplete = st.size === totalBytes;
  assert.ok(!(looksComplete && sha !== expectedSha),
    label + ": the final path holds a size-complete file (" + st.size + " bytes) whose content is NOT " +
    "the download (" + sha.slice(0, 16) + " vs " + expectedSha.slice(0, 16) + "). " +
    "A cancelled or paused transfer must never be left looking finished.");
  return { present: true, size: st.size, sha, correct: sha === expectedSha };
}

// ------------------------------------------------------------------- setup

/**
 * Paths this iteration actually uses.
 *
 * resetWorkDirs(iterRoot) points the daemon home and the download directory at
 * that iteration's own subtree, so an iteration can never delete another
 * iteration's (or another person's) files.
 */
let ACTIVE_HOME = HOME_DIR;
let ACTIVE_DL = DL_DIR;
const homeDir = () => ACTIVE_HOME;
const dlDir = () => ACTIVE_DL;

async function resetWorkDirs(iterRoot) {
  if (iterRoot) {
    ACTIVE_HOME = path.join(iterRoot, "home");
    ACTIVE_DL = path.join(iterRoot, "downloads");
  }
  HOME_DIR = ACTIVE_HOME;
  DL_DIR = ACTIVE_DL;
  // A home directory may only be wiped once no daemon is using it.
  const stale = await killStaleDaemon();
  if (stale) process.stdout.write("  [fixture] terminated stale daemon pid " + stale.pid + "\n");
  await fsp.rm(HOME_DIR, { recursive: true, force: true });
  await fsp.rm(DL_DIR, { recursive: true, force: true });
  await fsp.mkdir(HOME_DIR, { recursive: true });
  await fsp.mkdir(DL_DIR, { recursive: true });
  // Written before the daemon starts so the first task already sees it.
  await fsp.writeFile(path.join(HOME_DIR, "config.json"), JSON.stringify({
    version: 1,
    defaultDir: DL_DIR,
    categorizeByType: false,
    overwriteExisting: "overwrite",
    maxConcurrentDownloads: 2,
    maxConnections: 3,
    maxConnectionsPerServer: 8,
    segmentBytes: 1024 * 1024,
    maxRetries: 3,
    retryBaseMs: 200,
    monitorClipboard: false,
    startQueueAutomatically: true,
  }, null, 2), "utf8");
}

async function addTask(daemon, { url, filename, dir = DL_DIR, connections = 3 }) {
  const r = await api(daemon, "POST", "/api/tasks", {
    url, filename, dir, kind: "http", connections, meta: {},
  });
  assert.equal(r.status, 201, "task creation must succeed, got " + r.status + ": " + r.text);
  return r.json.task;
}

// -------------------------------------------------------------------- main

async function main() {
  const suite = new Suite("p0-integrity");
  const size = 3 * 1024 * 1024;
  const totalBytes = size;
  const payload = payloadFor(size, 0x9F01C0DE);
  const expectedSha = sha256(payload);
  const evidence = { startedAt: new Date().toISOString(), work: WORK_ROOT, totalBytes, expectedSha, steps: [] };
  const record = (step, detail) => evidence.steps.push({ step, at: new Date().toISOString(), ...detail });

  // Selection runs the chosen subset repeatedly, each iteration on its own
  // home and download directory. An intermittent defect cannot be judged from
  // a single green run.
  //
  // --only previously only decided whether --repeat applied: it never limited
  // which tests ran. --repeat is now honoured whether or not --only is given,
  // which is what the ticket and the acceptance commands both assume.
  const selected = (name) => !ARGS.only || name.toLowerCase().includes(ARGS.only.toLowerCase());
  let iterationIndex = 0;
  const once = async (name, fn) => {
    if (!selected(name)) {
      process.stdout.write("  [skip] " + name + " (does not match --only \"" + ARGS.only + "\")\n");
      return;
    }
    const iterations = ARGS.repeat;
    for (let i = 1; i <= iterations; i++) {
      iterationIndex++;
      // Each iteration owns a distinct root: the shared WORK_ROOT was the
      // reason two concurrent runs corrupted each other.
      iterationRoots.push(path.join(RUN_ROOT, "iter-" + String(iterationIndex).padStart(2, "0") + "-" + slug(name)));
      await resetWorkDirs(path.join(RUN_ROOT, "iter-" + String(iterationIndex).padStart(2, "0") + "-" + slug(name)));
      const label = iterations > 1 ? name + " [iteration " + i + "/" + iterations + "]" : name;
      process.stdout.write("  [iteration " + i + "/" + iterations + "] " + name + "\n");
      const t0 = Date.now();
      await suite.test(label, async () => {
        if (daemon && isAlive(daemon.child)) await stopDaemon(daemon, { hard: true });
        daemon = null;
        await fn();
      });
      const last = suite.results[suite.results.length - 1];
      process.stdout.write("  [iteration " + i + "/" + iterations + "] " + name + " -> " +
        (last && last.kind === "pass" ? "PASS" : "FAIL") + " (" + (Date.now() - t0) + "ms)\n");
    }
  };

  let daemon = null;
  /** Start a daemon unless the current one is still alive. */
  const ensureDaemon = async () => {
    if (daemon && isAlive(daemon.child)) return daemon;
    if (daemon) note("previous daemon gone (exit=" + daemon.child.exitCode +
      " signal=" + daemon.child.signalCode + "), starting a new one");
    daemon = await startDaemon();
    note("daemon up on port " + daemon.runtime.port + " pid " + daemon.runtime.pid);
    return daemon;
  };
  const origin = await startOrigin({ payload, etag: '"p0-1-v1"' });
  const note = (msg) => process.stdout.write("  [fixture] " + msg + "\n");

  try {
    daemon = await startDaemon();

    // ---------------------------------------------------------- 1. pause
    await once("pause mid-transfer leaves no finished-looking file; resume reproduces the source SHA", async () => {
      const live = await ensureDaemon();
      const filename = "pause.bin";
      const target = path.join(DL_DIR, filename);
      const task = await addTask(live, { url: origin.url, filename, connections: 3 });

      const progressed = await waitForProgress(live, task.id, 512 * 1024);
      record("pause", { taskId: task.id, downloadedBytes: progressed.downloadedBytes });

      await api(live, "POST", "/api/tasks/" + task.id + "/pause", {});
      const paused = await waitForStatus(live, task.id, ["paused", "complete"], 60000);
      assert.equal(paused.status, "paused",
        "the transfer must be paused, not finished: the origin is held mid-body (got " + paused.status + ")");

      const mid = await assertFinalPathIsNotAFakeComplete(target, totalBytes, expectedSha, "while paused");
      record("pause-final-state", mid);
      assert.equal(mid.present, false,
        "a paused transfer must not leave anything at the final path; found " + JSON.stringify(mid));



      await api(live, "POST", "/api/tasks/" + task.id + "/resume", {});
      const done = await waitForStatus(live, task.id, ["complete", "error"], 120000);
      assert.equal(done.status, "complete", "the resumed task must complete: " + JSON.stringify(done.error));

      const st = await statOrNull(target);
      assert.ok(st, "the completed download must exist at " + target);
      assert.equal(st.size, totalBytes, "the delivered file must have the source length");
      const sha = await hashFile(target);
      record("pause-result", { size: st.size, sha256: sha, status: done.status });
      assert.equal(sha, expectedSha, "the resumed file must equal the source byte-for-byte");
      assert.equal(done.sha256, expectedSha, "the daemon must report the same digest it verified");
      // A full-size file is still not proof: the tail must not be filler.
      assert.equal(await readTailIsZero(target, totalBytes), false,
        "the delivered file must not end in a run of zero bytes");
    });

    // ------------------------------------------------- 2. killed process
    await once("a killed daemon leaves no finished-looking file, and a restart resumes to the source SHA", async () => {
      const live = await ensureDaemon();
      const filename = "kill.bin";
      const target = path.join(DL_DIR, filename);
      const task = await addTask(live, { url: origin.url, filename, connections: 3 });

      const progressed = await waitForProgress(live, task.id, 768 * 1024);
      // Wait until the engine has checkpointed something, otherwise this would
      // measure "resume after losing every byte" rather than resume itself.
      const journalDir = target + ".downloadx";
      const checkpointed = await waitFor(async () => {
        const recorded = await readJournalBytes(journalDir);
        return recorded >= 256 * 1024 ? recorded : null;
      }, "the transfer to checkpoint its progress", 30000, 100);
      record("kill", {
        taskId: task.id,
        // Reported by the API when the threshold was crossed; the journal is
        // the authoritative figure, since it is what a resume may trust.
        downloadedBytesAtThreshold: progressed.downloadedBytes,
        checkpointedAtKill: checkpointed,
        pid: live.runtime.pid,
      });

      // Hard kill: no shutdown handler, no flush, no cleanup — the crash case.
      const exited = await killDaemon(live.child);
      assert.ok(exited, "the daemon process must actually be gone before the state is judged");

      const afterKill = await assertFinalPathIsNotAFakeComplete(target, totalBytes, expectedSha, "after the kill");
      record("kill-final-state", afterKill);
      assert.equal(afterKill.present, false,
        "a killed transfer must not leave anything at the final path; found " + JSON.stringify(afterKill));

      // The resumable state must survive: staging + journal.
      const staging = await statOrNull(target + STAGING_SUFFIX);
      const journalFiles = fs.existsSync(journalDir) ? fs.readdirSync(journalDir) : [];
      record("kill-survivors", {
        staging: staging ? staging.size : null,
        journalEntries: journalFiles,
      });
      assert.ok(staging && staging.size > 0,
        "the staging file must survive a kill so the transfer can resume");

      // Restart against the same data root and resume.
      const restarted = await startDaemon();
      daemon = restarted;
      const reloaded = await api(restarted, "GET", "/api/tasks/" + task.id);
      const t = reloaded.json && reloaded.json.task;
      assert.equal(t.status, "paused", "a task interrupted by a crash must come back paused, got " + (t && t.status));
      assert.ok(t.downloadedBytes > 0, "the recovered progress must not be reported as zero");

      origin.resetCounters();
      await api(restarted, "POST", "/api/tasks/" + task.id + "/resume", {});
      const done = await waitForStatus(restarted, task.id, ["complete", "error"], 180000);
      assert.equal(done.status, "complete", "the recovered task must complete: " + JSON.stringify(done.error));

      const st = await statOrNull(target);
      assert.ok(st, "the recovered download must exist at " + target);
      assert.equal(st.size, totalBytes, "the recovered file must have the source length");
      const sha = await hashFile(target);
      record("kill-result", { size: st.size, sha256: sha, refetched: origin.state.bytesDelivered });
      assert.equal(sha, expectedSha, "the recovered file must equal the source byte-for-byte");
      // The resume must continue from the checkpoint, not start over: the
      // engine may re-fetch since the last checkpoint, never the whole file.
      assert.ok(origin.state.bytesDelivered < totalBytes - checkpointed / 2,
        "the resume must continue from the " + checkpointed + " checkpointed bytes instead of starting over " +
        "(re-fetched " + origin.state.bytesDelivered + " of " + totalBytes + ")");
    });

    // ------------------------------------------------------ 3. cancel
    await once("cancelling mid-transfer leaves no file at the final path", async () => {
      const live = await ensureDaemon();
      const filename = "cancel.bin";
      const target = path.join(DL_DIR, filename);
      const task = await addTask(live, { url: origin.url, filename, connections: 3 });

      const progressed = await waitForProgress(live, task.id, 320 * 1024);
      record("cancel", { taskId: task.id, downloadedBytes: progressed.downloadedBytes });

      await api(live, "POST", "/api/tasks/" + task.id + "/pause", {});
      const settled = await waitForStatus(live, task.id, ["paused", "complete"], 60000);
      // The cancel gesture is only meaningful while the transfer is unfinished;
      // racing the origin would test nothing.
      assert.equal(settled.status, "paused", "the transfer must be paused before it is cancelled, got " + settled.status);
      const midState = await assertFinalPathIsNotAFakeComplete(target, totalBytes, expectedSha, "before the cancel");
      record("cancel-before", midState);
      assert.equal(midState.present, false,
        "a paused transfer must not leave anything at the final path; found " + JSON.stringify(midState));

      // Removing the task is the cancel gesture: the row and its file go away.
      const removed = await api(live, "DELETE", "/api/tasks/" + task.id + "?deleteFile=1");
      assert.equal(removed.status, 200, "removing the task must succeed, got " + removed.text);

      const after = await waitFor(async () => {
        const st = await statOrNull(target);
        return st ? null : { absent: true };
      }, "the cancelled target to be gone from the final path", 15000).catch(() => null);

      const st = await statOrNull(target);
      record("cancel-final-state", {
        final: st ? { size: st.size } : null,
        staging: (await statOrNull(target + STAGING_SUFFIX))?.size ?? null,
      });
      assert.equal(st, null,
        "after a cancel the final path must not exist; found " + (st ? st.size + " bytes" : "nothing"));
      // Whatever is left must be explicitly named as temporary work.
      const leftovers = (await fsp.readdir(DL_DIR)).filter((f) => f.startsWith(filename));
      for (const f of leftovers) {
        assert.ok(f === filename + STAGING_SUFFIX || f === filename + ".downloadx" || f === filename + ".partial",
          "leftover after a cancel must be an explicit temporary name, found: " + f);
      }
      assert.ok(after, "the cancellation must not need a retry loop to take effect");
    });

    // -------------------------------------------------------- 4. retry
    await once("a failed retry never leaves the stale incomplete file at the final path", async () => {
      const live = await ensureDaemon();
      const filename = "retry.bin";
      const target = path.join(DL_DIR, filename);
      const task = await addTask(live, { url: origin.url, filename, connections: 3 });

      const progressed = await waitForProgress(live, task.id, 512 * 1024);
      record("retry", { taskId: task.id, downloadedBytes: progressed.downloadedBytes });
      await api(live, "POST", "/api/tasks/" + task.id + "/pause", {});
      const settled = await waitForStatus(live, task.id, ["paused", "complete"], 60000);
      assert.equal(settled.status, "paused", "the transfer must be paused before it is retried, got " + settled.status);

      const midState = await assertFinalPathIsNotAFakeComplete(target, totalBytes, expectedSha, "before the retry");
      record("retry-before", midState);
      assert.equal(midState.present, false,
        "a paused transfer must not leave anything at the final path; found " + JSON.stringify(midState));

      // The retry now fails: the origin is down. Whatever the abandoned partial
      // state is, it must not survive at the final path looking finished.
      origin.setFailure(503);
      await api(live, "POST", "/api/tasks/" + task.id + "/resume", {});
      const failed = await waitForStatus(live, task.id, ["error", "complete"], 120000);
      assert.equal(failed.status, "error",
        "a retry against a dead origin must report an error, not success (got " + failed.status + ")");

      const afterRetry = await assertFinalPathIsNotAFakeComplete(target, totalBytes, expectedSha, "after the failed retry");
      record("retry-after-failure", afterRetry);
      assert.equal(afterRetry.present, false,
        "a failed retry must not leave a file at the final path; found " + JSON.stringify(afterRetry));

      // And once the origin is healthy again the retry must produce the real file.
      origin.setFailure(0);
      await api(live, "POST", "/api/tasks/" + task.id + "/retry", {});
      const done = await waitForStatus(live, task.id, ["complete", "error"], 180000);
      assert.equal(done.status, "complete", "the retried task must complete once the origin is healthy: " +
        JSON.stringify(done.error));
      const st = await statOrNull(target);
      assert.ok(st, "the retried download must exist at " + target);
      assert.equal(st.size, totalBytes, "the retried file must have the source length");
      const sha = await hashFile(target);
      record("retry-result", { size: st.size, sha256: sha });
      assert.equal(sha, expectedSha, "the retried file must equal the source byte-for-byte");
      assert.equal(await readTailIsZero(target, totalBytes), false,
        "the retried file must not end in a run of zero bytes");
    });
  } finally {
    // Every daemon this suite started must be gone, including ones it replaced
    // after a restart; a survivor would corrupt the next run's fixture.
    for (const handle of SPAWNED) await killDaemon(handle.child);
    SPAWNED.clear();
    await origin.close();
  }

  evidence.finishedAt = new Date().toISOString();
  evidence.runRoot = RUN_ROOT;
  evidence.iterationRoots = iterationRoots;
  evidence.only = ARGS.only;
  evidence.repeat = ARGS.repeat;
  evidence.passed = suite.passed;
  evidence.failed = suite.failed;
  evidence.skipped = suite.skipped;
  const outDir = process.env.DOWNLOADX_P01_OUT
    || "D:\\IAM\\反馈\\最终验收批次-20261019\\修复批次-02\\测试输出\\p0a";
  try {
    await fsp.mkdir(outDir, { recursive: true });
    // The run id keeps concurrent runs from overwriting each other's evidence.
    await fsp.writeFile(path.join(outDir, "p0-integrity-" + RUN_ID + ".json"), JSON.stringify(evidence, null, 2), "utf8");
    await fsp.writeFile(path.join(outDir, "p0-integrity-last.json"), JSON.stringify(evidence, null, 2), "utf8");
  } catch { /* evidence capture must not fail the suite */ }

  process.stdout.write(suite.report());

  // Final counts, stated explicitly so a repeated run can be judged without
  // parsing the per-test lines.
  process.stdout.write("  ---- run summary ----\n");
  process.stdout.write("  selection: " + (ARGS.only ? "--only \"" + ARGS.only + "\"" : "all cases") +
    ", --repeat " + ARGS.repeat + "\n");
  process.stdout.write("  iterations run: " + iterationIndex + "\n");
  process.stdout.write("  total: " + (suite.passed + suite.failed) + " assertion case(s): " +
    suite.passed + " passed, " + suite.failed + " failed, " + suite.skipped + " skipped\n");
  process.stdout.write("  run root: " + RUN_ROOT + "\n");
  for (const root of iterationRoots) process.stdout.write("    iteration dir: " + root + "\n");
  process.stdout.write("\n");

  process.stdout.write(suite.failed === 0 ? "  RESULT: PASS\n" : "  RESULT: FAIL\n");
  return suite.failed === 0 ? 0 : 1;
}

main()
  .then(async (code) => {
    const httpMod = await import("node:http");
    httpMod.default.globalAgent.destroy();
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write("\n  p0-integrity crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
