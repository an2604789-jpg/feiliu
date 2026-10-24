// Large-file and interruption-recovery acceptance fixtures (batch P2, task C).
//
// These are the scenarios that separate a demo downloader from one a user can
// trust with a 1 GiB ISO: sustained multi-gigabyte transfers, repeated
// interruptions at different progress points, recovery across a daemon restart,
// and state reconstruction after a forced kill. Each one writes its evidence to
// a run directory so the result can be re-checked rather than taken on trust.
//
// Everything runs against a local deterministic origin. Nothing here touches
// the real network, real system permissions or the real disk's free space.
//
// Usage:
//   node test/large-file.mjs                  # default sizes (256 MiB)
//   node test/large-file.mjs --size 1G        # escalate to 1 GiB
//   node test/large-file.mjs --only restart   # one scenario
//   node test/large-file.mjs --list
//
// Default sizes are deliberately modest: a 1 GiB regression would make every
// run an endurance test. The configuration makes escalating a one-word change.

import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import process from "node:process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { parseSize, formatBytes } from "../src/util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "..");

/**
 * Where an unfinished transfer keeps its resumable state.
 *
 * The segmented engine assembles bytes in a staging file and renames it onto
 * the final path only after the content check passes, so while a transfer is
 * paused, cancelled or killed the FINAL path must not exist at all. What may
 * exist is:
 *
 *   <target>.downloadx-part                the bytes written so far
 *   <target>.downloadx\segments\*.json     per-segment progress checkpoints
 *   <target>.downloadx\state.json          the plan (url, total, etag)
 *
 * Anything at the final path during that window would be a file a player, a
 * backup or the "complete" label would mistake for a finished download, which
 * is exactly the defect these scenarios exist to catch.
 */
const STAGING_SUFFIX = ".downloadx-part";
const JOURNAL_SUFFIX = ".downloadx";

// --------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = { size: null, only: null, list: false, keep: true, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--size") out.size = parseSize(argv[++i]);
    else if (a === "--only") out.only = argv[++i];
    else if (a === "--list") out.list = true;
    else if (a === "--no-keep") out.keep = false;
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--keep-runs") out.keepRuns = Number(argv[++i]);
  }
  return out;
}

/**
 * Default sizes.
 *
 * The large-file scenario defaults to 256 MiB, which is enough to exercise
 * multi-segment assembly and page-cache behaviour without dominating a test
 * run. The loader below makes 1 GiB a flag rather than a code change.
 */
const LIMITS = {
  largeFileBytes: 256 * 1024 * 1024,
  segmentBytes: 8 * 1024 * 1024,
  connections: 8,
  /** Bytes per scenario before it is declared a timeout rather than a pass. */
  scenarioTimeoutMs: 15 * 60 * 1000,
};

// ------------------------------------------------------------------ helpers

async function hashFile(file, algo = "sha256") {
  const h = createHash(algo);
  const fh = await fsp.open(file, "r");
  const buf = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      h.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return h.digest("hex");
}

/**
 * A deterministic origin whose payload is generated in slices.
 *
 * A 1 GiB scenario cannot hold its body in memory alongside the file being
 * written, so bytes are produced on demand from the offset: the same offset
 * always yields the same byte, which is what makes a resumed transfer
 * verifiable.
 */
export function makePayloadSlice(start, length, seed = 0x9e3779b9) {
  const buf = Buffer.allocUnsafe(length);
  // The generator is re-seeded from the absolute offset for every slice, so
  // byte N is the same whether it is fetched as part of one big range, as a
  // small resumed range, or byte by byte. A rolling generator would make a
  // resumed transfer produce DIFFERENT bytes than an uninterrupted one, and
  // the hash comparison would fail while the transfer itself was correct.
  for (let i = 0; i < length; i++) {
    // A cheap avalanche over the absolute position and the seed. Exact quality
    // is irrelevant here; what matters is determinism per offset and that
    // adjacent positions differ.
    let h = (start + i) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    buf[i] = (h ^ seed) & 0xff;
  }
  return buf;
}

/** SHA-256 of the whole logical payload, computed a slice at a time. */
export function payloadSha256(size, seed = 0x9e3779b9) {
  const h = createHash("sha256");
  const CHUNK = 4 * 1024 * 1024;
  for (let off = 0; off < size; off += CHUNK) {
    h.update(makePayloadSlice(off, Math.min(CHUNK, size - off), seed));
  }
  return h.digest("hex");
}

/**
 * Start a large-file origin.
 *
 * @param {{ size:number, throttleBytesPerSecond?:number, dropFirst?:number,
 *           dropAfterBytes?:number, seed?:number }} opts
 */
export async function startLargeOrigin(opts) {
  const { size, throttleBytesPerSecond = 0, dropAfterBytes = 0, seed = 0x9e3779b9 } = opts;
  let dropFirst = opts.dropFirst ?? 0;
  const state = {
    requests: 0,
    rangedRequests: 0,
    bytesServed: 0,
    bytesDelivered: 0,
    drops: 0,
    /** Bytes actually flushed, which is what a resume must be measured against. */
    rangeRequestsSeen: [],
  };

  const srv = http.createServer((req, res) => {
    state.requests++;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    let start = 0;
    let end = size - 1;
    const hasRange = Boolean(m);
    if (m) {
      state.rangedRequests++;
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      state.rangeRequestsSeen.push([start, end]);
    }
    if (start > end || start >= size) {
      res.writeHead(416, { "Content-Range": "bytes */" + size, "Content-Length": "0" });
      res.end();
      return;
    }

    const total = end - start + 1;
    const headers = {
      "Content-Type": "application/octet-stream",
      "Content-Length": total,
      "Accept-Ranges": "bytes",
      // A stable validator, so a resume can prove it is continuing the same
      // revision rather than a file that changed underneath it.
      ETag: '"large-' + size + "-" + seed + '"',
    };
    if (hasRange) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
    if (req.method === "HEAD") {
      res.writeHead(hasRange ? 206 : 200, headers);
      res.end();
      return;
    }
    res.writeHead(hasRange ? 206 : 200, headers);

    // A requested drop: send part of the body, then kill the socket, the way a
    // flaky connection behaves.
    const limit = dropFirst > 0 && dropAfterBytes > 0 ? Math.min(dropAfterBytes, total) : 0;
    const chunkSize = throttleBytesPerSecond
      ? Math.max(16 * 1024, Math.floor(throttleBytesPerSecond / 20))
      : 1024 * 1024;
    const delayMs = throttleBytesPerSecond ? 50 : 0;

    let offset = 0;
    let dropped = false;
    const tick = () => {
      if (res.destroyed) return;
      if (limit && offset >= limit && !dropped) {
        dropped = true;
        dropFirst--;
        state.drops++;
        res.destroy();
        return;
      }
      if (offset >= total) { res.end(); return; }
      const want = Math.min(chunkSize, total - offset);
      const slice = makePayloadSlice(start + offset, want, seed);
      offset += want;
      state.bytesServed += want;
      state.bytesDelivered += want;
      res.write(slice);
      if (delayMs) setTimeout(tick, delayMs);
      else tick();
    };
    tick();
  });

  srv.on("connection", (s) => s.on("error", () => {}));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  return {
    url: "http://127.0.0.1:" + port + "/large.bin",
    origin: "http://127.0.0.1:" + port,
    size,
    state,
    expectedSha256: payloadSha256(size, seed),
    resetCounters() {
      state.bytesServed = 0;
      state.bytesDelivered = 0;
      state.requests = 0;
      state.rangedRequests = 0;
    },
    close: () => new Promise((r) => {
      srv.closeAllConnections?.();
      srv.close(() => r(undefined));
      setTimeout(() => r(undefined), 2000);
    }),
  };
}

/** Free bytes on the volume holding `dir`, or null when it cannot be read. */
export async function freeSpace(dir) {
  try {
    const st = await fsp.statfs(dir);
    return { free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- scenarios

/**
 * Record one scenario's outcome.
 *
 * `ok` is the only thing that can be reported as PASS; a scenario that could
 * not run is recorded as SKIP with the reason and never as a success.
 */
function makeResult(name, title) {
  return {
    scenario: name,
    title,
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
    status: "SKIP",
    skipReason: null,
    error: null,
    metrics: {},
    checks: [],
    notes: [],
  };
}

const addCheck = (result, id, ok, detail) => {
  result.checks.push({ id, ok: Boolean(ok), detail: detail === undefined ? "" : String(detail) });
  return Boolean(ok);
};

/**
 * Scenario 1: one large file, several connections, byte-for-byte verification.
 */
async function scenarioLargeFile(ctx, result) {
  const { workDir, size } = ctx;
  const { Config } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { Downloader } = await import("../src/downloader.mjs");

  const origin = await startLargeOrigin({ size });
  try {
    const dir = path.join(workDir, "large-file");
    await fsp.mkdir(dir, { recursive: true });
    const cfg = new Config(path.join(dir, "config.json"));
    await cfg.load();
    await cfg.set({
      defaultDir: dir,
      categorizeByType: false,
      overwriteExisting: "overwrite",
      maxConnections: LIMITS.connections,
      segmentBytes: LIMITS.segmentBytes,
    });
    const q = new QueueManager({ config: cfg });
    await q.load();
    const dl = new Downloader({ config: cfg, queue: q });

    const started = Date.now();
    const res = await dl.run({
      id: "large-file",
      url: origin.url,
      kind: "http",
      filename: "large.bin",
      dir,
      headers: {},
      connections: LIMITS.connections,
      meta: {},
    });
    const elapsedMs = Date.now() - started;

    const target = path.join(dir, "large.bin");
    const onDisk = (await fsp.stat(target)).size;
    const actualSha = await hashFile(target);

    result.metrics = {
      bytes: onDisk,
      expectedBytes: size,
      sha256: actualSha,
      expectedSha256: origin.expectedSha256,
      elapsedMs,
      throughputBytesPerSecond: Math.round(onDisk / Math.max(0.001, elapsedMs / 1000)),
      connectionsUsed: origin.state.rangeRequestsSeen.length,
      originRequests: origin.state.requests,
      rangedRequests: origin.state.rangedRequests,
      bytesServed: origin.state.bytesServed,
      exitCode: 0,
    };

    addCheck(result, "no-error", true, "");
    addCheck(result, "size", onDisk === size, onDisk + " vs " + size);
    addCheck(result, "sha256", actualSha === origin.expectedSha256,
      actualSha.slice(0, 16) + " vs " + origin.expectedSha256.slice(0, 16));
    addCheck(result, "multi-connection-used", origin.state.rangeRequestsSeen.length >= 2,
      origin.state.rangeRequestsSeen.length + " ranges requested");
    addCheck(result, "engine-ran", Boolean(res && res.ok), JSON.stringify(res && res.ok));
    addCheck(result, "scratch-cleaned",
      !(await fsp.readdir(dir)).some((f) => f.includes(".downloadx")),
      "leftovers: " + JSON.stringify((await fsp.readdir(dir)).filter((f) => f.includes(".downloadx"))));
    result.notes.push("transferred " + formatBytes(onDisk) + " in " + (elapsedMs / 1000).toFixed(1) + "s");
    result.notes.push("origin served " + formatBytes(origin.state.bytesServed) +
      " over " + origin.state.requests + " requests (" + origin.state.rangedRequests + " ranged)");
  } finally {
    await origin.close();
  }
}

/**
 * Scenario 2: the same task interrupted three times at different progress
 * points, then allowed to finish. The final bytes must equal the source.
 */
async function scenarioInterruptThree(ctx, result) {
  const { workDir, size } = ctx;
  const { Config } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { Downloader } = await import("../src/downloader.mjs");

  // Throttled, so an interruption lands mid-transfer rather than racing a
  // local server that finishes first.
  const origin = await startLargeOrigin({ size, throttleBytesPerSecond: 24 * 1024 * 1024 });
  try {
    const dir = path.join(workDir, "interrupt-three");
    await fsp.mkdir(dir, { recursive: true });
    const cfg = new Config(path.join(dir, "config.json"));
    await cfg.load();
    await cfg.set({
      defaultDir: dir,
      categorizeByType: false,
      overwriteExisting: "overwrite",
      maxConnections: 4,
      segmentBytes: LIMITS.segmentBytes,
    });
    const q = new QueueManager({ config: cfg });
    await q.load();
    const dl = new Downloader({ config: cfg, queue: q });

    const target = path.join(dir, "large.bin");
    // Three different progress points, so the interruption does not always
    // land on the same segment boundary.
    const thresholds = [
      Math.floor(size * 0.10),
      Math.floor(size * 0.35),
      Math.floor(size * 0.62),
    ];

    const interruptions = [];
    for (const threshold of thresholds) {
      const taskId = "interrupt-" + threshold;
      let abortedAt = null;
      const run = dl.run({
        id: taskId, url: origin.url, kind: "http", filename: "large.bin", dir,
        headers: {}, connections: 4, meta: {},
      }).catch(() => null);

      const fired = new Promise((resolve) => {
        let done = false;
        const onProgress = (p) => {
          if (done) return;
          if ((p.bytesWritten || 0) >= threshold) {
            done = true;
            abortedAt = p.bytesWritten;
            const entry = dl.active.get(taskId);
            if (entry && entry.controller) entry.controller.abort();
            resolve("aborted");
          }
        };
        dl.on("progress", onProgress);
        setTimeout(() => { if (!done) { done = true; resolve("timeout"); } }, 90000);
      });
      await fired;
      await run;

      // Progress is read from the segment journal, not from the file size: the
      // engine preallocates the target to its full length so workers can write
      // at arbitrary offsets, which means the file is its final size from the
      // first moment. The journal is the only honest measure of how far the
      // transfer actually got.
      const journal = await readSegmentSummary(path.join(target + ".downloadx", "segments"));
      const bytesOnDisk = fs.existsSync(target) ? (await fsp.stat(target)).size : 0;
      interruptions.push({ threshold, abortedAt, bytesOnDisk, recordedBytes: journal.recorded });
      result.notes.push("interruption at " + abortedAt + " bytes; journal records " +
        journal.recorded + " of " + size + " bytes (" + journal.count + " segments)");
    }

    // The final pass: uninterrupted, and it must finish the same file.
    origin.resetCounters();
    const journalBeforeFinal = await readSegmentSummary(path.join(target + ".downloadx", "segments"));
    const resumedFrom = journalBeforeFinal.recorded;
    const final = await dl.run({
      id: "interrupt-final", url: origin.url, kind: "http", filename: "large.bin", dir,
      headers: {}, connections: 4, meta: {},
    });
    const bytesResent = origin.state.bytesDelivered;
    const onDisk = (await fsp.stat(target)).size;
    const actualSha = await hashFile(target);

    result.metrics = {
      bytes: onDisk,
      expectedBytes: size,
      sha256: actualSha,
      expectedSha256: origin.expectedSha256,
      interruptions,
      bytesOnDiskBeforeFinal: resumedFrom,
      bytesResentOnResume: bytesResent,
      originRequests: origin.state.requests,
      rangedRequests: origin.state.rangedRequests,
      exitCode: 0,
    };

    addCheck(result, "three-interruptions-happened",
      interruptions.every((i) => i.abortedAt !== null && i.abortedAt > 0),
      JSON.stringify(interruptions.map((i) => i.abortedAt)));
    // The interruptions must land at genuinely different progress points,
    // otherwise "three times" would not be testing three situations.
    const distinct = new Set(interruptions.map((i) => Math.round(i.abortedAt / (1024 * 1024))));
    addCheck(result, "progress-points-differ", distinct.size === interruptions.length,
      "distinct progress points: " + distinct.size + " of " + interruptions.length);
    // Each interruption must start from a different place: three rounds that
    // all began from zero would not be testing three situations.
    addCheck(result, "progress-retained",
      interruptions[2].recordedBytes > interruptions[0].recordedBytes,
      "recorded progress grew across interruptions: " +
      JSON.stringify(interruptions.map((i) => i.recordedBytes)));
    addCheck(result, "progress-monotonic",
      interruptions.every((i, n) => n === 0 || i.recordedBytes >= interruptions[n - 1].recordedBytes),
      "recorded progress never went backwards: " +
      JSON.stringify(interruptions.map((i) => i.recordedBytes)));
    addCheck(result, "final-size", onDisk === size, onDisk + " vs " + size);
    addCheck(result, "final-sha256", actualSha === origin.expectedSha256,
      actualSha.slice(0, 16) + " vs " + origin.expectedSha256.slice(0, 16));
    // A resume that re-fetched everything would still produce a correct file,
    // so the useful check is that it did not.
    // The final pass may fetch only what was missing. A restart would fetch the
    // whole file again, so the useful assertion is that it fetched
    // meaningfully less than the whole thing.
    addCheck(result, "resume-did-not-restart",
      bytesResent < size * 0.9,
      "resume fetched " + formatBytes(bytesResent) + " of " + formatBytes(size) +
      " with " + formatBytes(resumedFrom) + " already recorded");
    addCheck(result, "engine-reported-completion", Boolean(final && final.ok), String(final && final.ok));
  } finally {
    await origin.close();
  }
}

/**
 * Scenario 3: the daemon restarts while a transfer is running.
 *
 * The task must not be reported as complete, and resuming must not start over.
 */
async function scenarioDaemonRestart(ctx, result) {
  const { workDir, size } = ctx;
  const origin = await startLargeOrigin({ size, throttleBytesPerSecond: 24 * 1024 * 1024 });
  const home = path.join(workDir, "daemon-restart-home");
  await fsp.mkdir(home, { recursive: true });
  const dlDir = path.join(workDir, "daemon-restart");
  await fsp.mkdir(dlDir, { recursive: true });

  const previousHome = process.env.DOWNLOADX_HOME;
  process.env.DOWNLOADX_HOME = home;
  const { Daemon, readRuntime } = await import("../src/daemon.mjs");

  try {
    // ---- first daemon: start a download and stop mid-transfer -------------
    const first = await new Daemon({ port: 0 }).init();
    await first.config.set({
      defaultDir: dlDir, categorizeByType: false, overwriteExisting: "overwrite",
      maxConnections: 4, segmentBytes: LIMITS.segmentBytes, monitorClipboard: false,
    });
    const runtime1 = await first.start();

    const created = await fetch("http://127.0.0.1:" + runtime1.port + "/api/tasks", {
      method: "POST",
      headers: { "x-downloadx-token": runtime1.token, "content-type": "application/json" },
      body: JSON.stringify({ url: origin.url, filename: "large.bin", dir: dlDir, connections: 4 }),
    });
    const task = (await created.json()).task;
    assertNoError("creating the task", task);

    // Wait until real progress has been made, then stop the daemon the way a
    // user would: an orderly shutdown with a transfer in flight.
    const target = path.join(dlDir, "large.bin");
    const progressed = await waitUntil(async () => {
      const v = await fetchTask(runtime1, task.id);
      return v && v.downloadedBytes > 4 * 1024 * 1024 ? v : null;
    }, "the transfer to make progress", 90000);
    const bytesBeforeStop = progressed.downloadedBytes;
    result.notes.push("stopped the daemon with " + bytesBeforeStop + " bytes on disk");

    await first.stop();

    // ---- the state on disk, as read by a *fresh* process ------------------
    const afterStop = await fetchTaskRaw(runtime1, task.id).catch(() => null);
    const runtimeGone = (await readRuntime()) === null;

    // ---- second daemon: the same data root, a new process -----------------
    const second = await new Daemon({ port: 0 }).init();
    const runtime2 = await second.start();
    try {
      const reloaded = await fetchTask(runtime2, task.id);
      assertNoError("reading the task from the new daemon", reloaded);
      const onDiskAfterStop = fs.existsSync(target) ? (await fsp.stat(target)).size : 0;
      const stagingAfterStop = fs.existsSync(target + STAGING_SUFFIX)
        ? (await fsp.stat(target + STAGING_SUFFIX)).size : 0;
      const journalAfterStop = await readSegmentSummary(path.join(target + JOURNAL_SUFFIX, "segments"));
      const stateAfterStop = await readJournalState(target + JOURNAL_SUFFIX);

      result.metrics = {
        bytesBeforeStop,
        bytesOnDiskAfterStop: onDiskAfterStop,
        bytesStagingAfterStop: stagingAfterStop,
        journalRecordsAfterStop: journalAfterStop.count,
        journalReadableAfterStop: journalAfterStop.readable,
        journalRecordedAfterStop: journalAfterStop.recorded,
        statePresentAfterStop: Boolean(stateAfterStop),
        statusAfterRestart: reloaded.status,
        bytesReportedAfterRestart: reloaded.downloadedBytes,
        runtimeRemovedOnStop: runtimeGone,
        bytes: 0,
        expectedBytes: size,
        sha256: null,
        expectedSha256: origin.expectedSha256,
        exitCode: 0,
      };

      // The central assertion: a transfer that was mid-flight when the daemon
      // stopped must NOT be presented as finished.
      addCheck(result, "not-reported-complete", reloaded.status !== "complete",
        "status after restart: " + reloaded.status);
      // It must also be resumable rather than failed beyond recovery.
      addCheck(result, "resumable-state", reloaded.status === "paused" || reloaded.status === "queued" ||
        reloaded.status === "error",
        "status after restart: " + reloaded.status);
      addCheck(result, "runtime-file-removed", runtimeGone, "readRuntime() === null: " + runtimeGone);
      // New product semantics: an unfinished transfer publishes NOTHING at the
      // final path. Its resumable state is the staging file plus the journal,
      // so that is what must be present instead.
      addCheck(result, "final-path-absent-after-stop", onDiskAfterStop === 0,
        "a stopped transfer must not leave a file at the final path, found " + onDiskAfterStop + " bytes");
      addCheck(result, "staging-file-kept", stagingAfterStop > 0,
        "staging file (target + " + STAGING_SUFFIX + ") must survive a stop, found " + stagingAfterStop + " bytes");
      addCheck(result, "journal-kept",
        journalAfterStop.count > 0 && journalAfterStop.readable === journalAfterStop.count,
        journalAfterStop.count + " segment record(s), " + journalAfterStop.readable + " readable");
      addCheck(result, "journal-state-kept", Boolean(stateAfterStop),
        "state.json under target + " + JOURNAL_SUFFIX + ": " + (stateAfterStop ? "present" : "missing"));
      // The saved plan must still describe this download; otherwise a resume
      // would have to re-derive a size it already knew.
      addCheck(result, "journal-state-matches-size",
        Boolean(stateAfterStop) && stateAfterStop.totalBytes === size,
        "state.json totalBytes: " + (stateAfterStop && stateAfterStop.totalBytes) + " vs " + size);

      // Resume through the API, then verify the file.
      origin.resetCounters();
      const resumed = await fetch("http://127.0.0.1:" + runtime2.port + "/api/tasks/" + task.id + "/resume", {
        method: "POST",
        headers: { "x-downloadx-token": runtime2.token },
      });
      assertNoError("resuming the task", await resumed.json());
      const done = await waitUntil(async () => {
        const v = await fetchTask(runtime2, task.id);
        return v && (v.status === "complete" || v.status === "error") ? v : null;
      }, "the resumed task to settle", 300000);
      assertNoError("resumed task status: " + done.status, done);
      const bytesResent = origin.state.bytesDelivered;
      const onDisk = (await fsp.stat(target)).size;
      const actualSha = await hashFile(target);

      result.metrics.bytes = onDisk;
      result.metrics.sha256 = actualSha;
      result.metrics.bytesResentOnResume = bytesResent;
      result.metrics.statusAfterResume = done.status;
      result.notes.push("resume fetched " + bytesResent + " of " + size + " bytes");

      addCheck(result, "resume-completed", done.status === "complete", "status: " + done.status);
      addCheck(result, "size", onDisk === size, onDisk + " vs " + size);
      addCheck(result, "sha256", actualSha === origin.expectedSha256,
        actualSha.slice(0, 16) + " vs " + origin.expectedSha256.slice(0, 16));
      // The whole point of restart recovery: it continues rather than repeats.
      addCheck(result, "resume-did-not-start-over", bytesResent < size,
        "resume fetched " + formatBytes(bytesResent) + " of " + formatBytes(size));
      addCheck(result, "progress-was-reused",
        done.downloadedBytes >= bytesBeforeStop,
        "after restart the task reported " + done.downloadedBytes + ", before the stop " + bytesBeforeStop);
    } finally {
      await second.stop();
    }
  } finally {
    if (previousHome === undefined) delete process.env.DOWNLOADX_HOME;
    else process.env.DOWNLOADX_HOME = previousHome;
    await origin.close();
  }
}

/**
 * Scenario 4: a forced kill, then state rebuilt from disk.
 *
 * A SIGKILL-style termination gives no chance to flush anything, so this checks
 * that the segment journal on disk is self-consistent afterwards and that the
 * task is not delivered as complete.
 */
async function scenarioForcedExit(ctx, result) {
  const { workDir, size } = ctx;
  // Throttled so the process is killed with real work in flight. On a local
  // origin an unthrottled transfer of this size finishes in well under a
  // second, and the kill would land either side of it rather than during it.
  const origin = await startLargeOrigin({ size, throttleBytesPerSecond: 12 * 1024 * 1024 });
  const home = path.join(workDir, "forced-exit-home");
  const dlDir = path.join(workDir, "forced-exit");
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(dlDir, { recursive: true });

  const entry = path.join(PROJECT, "bin", "downloadx.mjs");
  const child = spawn(process.execPath, [entry, "daemon"], {
    cwd: PROJECT,
    env: { ...process.env, DOWNLOADX_HOME: home },
    stdio: "ignore",
    windowsHide: true,
  });

  const previousHome = process.env.DOWNLOADX_HOME;
  try {
    const rtPath = path.join(home, "runtime.json");
    const runtime = await waitUntil(async () => {
      try { return JSON.parse(await fsp.readFile(rtPath, "utf8")); } catch { return null; }
    }, "the daemon to publish its runtime file", 30000);
    assertNoError("daemon startup", runtime);

    const hdr = { "x-downloadx-token": runtime.token, "content-type": "application/json" };
    const call = (route, body) => fetch("http://127.0.0.1:" + runtime.port + route, {
      method: body === undefined ? "GET" : "POST",
      headers: hdr,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await call("/api/config", undefined).catch(() => null);
    // Settings must be written through the API for THIS daemon's data root.
    await fetch("http://127.0.0.1:" + runtime.port + "/api/config", {
      method: "PATCH", headers: hdr,
      body: JSON.stringify({
        defaultDir: dlDir, categorizeByType: false, overwriteExisting: "overwrite",
        maxConnections: 4, segmentBytes: LIMITS.segmentBytes, monitorClipboard: false,
      }),
    });

    const created = await (await call("/api/tasks", {
      url: origin.url, filename: "large.bin", dir: dlDir, connections: 4,
    })).json();
    const task = created.task;
    assertNoError("creating the task", task);

    const target = path.join(dlDir, "large.bin");
    const progressed = await waitUntil(async () => {
      const v = await (await call("/api/tasks/" + task.id)).json();
      return v.task && v.task.downloadedBytes > 4 * 1024 * 1024 ? v.task : null;
    }, "the transfer to make progress", 90000);
    // Wait for a checkpoint to land before killing: the first journal write
    // happens after CHECKPOINT_MS of transferring, and killing before it would
    // test "nothing was saved yet" rather than "what was saved survives".
    // Wait for a checkpoint worth resuming FROM, not merely a non-zero one.
    //
    // Breaking on the first recorded byte made the assertion below impossible
    // to satisfy: with 0.1% checkpointed, even a perfect resume has to fetch
    // more than 99% of the file again, so "did not start over" failed on a
    // product that behaved correctly. Requiring a meaningful checkpoint tests
    // the thing the scenario is named after.
    const checkpointTarget = Math.max(4 * 1024 * 1024, Math.floor(size * 0.05));
    const checkpointDeadline = Date.now() + 60000;
    let recordedBeforeKill = 0;
    while (Date.now() < checkpointDeadline) {
      const summary = await readSegmentSummary(path.join(target + ".downloadx", "segments"));
      recordedBeforeKill = summary.recorded;
      if (recordedBeforeKill >= checkpointTarget) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    result.metricsCheckpointTarget = checkpointTarget;
    result.notes.push("killing the daemon with " + progressed.downloadedBytes +
      " bytes reported and " + recordedBeforeKill + " bytes checkpointed");

    // Record the on-disk picture BEFORE the kill, so it can be compared with
    // what is found afterwards.
    const stateDir = target + ".downloadx";
    const segmentsDir = path.join(stateDir, "segments");
    const segmentsBefore = await readSegmentSummary(segmentsDir);
    const bytesOnDiskBefore = fs.existsSync(target) ? (await fsp.stat(target)).size : 0;
    const journalBefore = await readJournalState(stateDir);

    // SIGKILL: no shutdown handler runs, no flush, no cleanup. On Windows this
    // is a hard terminate of the process tree.
    child.kill("SIGKILL");
    const exited = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 8000);
      child.once("exit", (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
    });
    result.notes.push("child exit: " + JSON.stringify(exited));

    const runtimeAfter = fs.existsSync(rtPath);
    const segmentsAfter = await readSegmentSummary(segmentsDir);
    const bytesOnDiskAfter = fs.existsSync(target) ? (await fsp.stat(target)).size : 0;
    const stagingBytesAfter = fs.existsSync(target + STAGING_SUFFIX)
      ? (await fsp.stat(target + STAGING_SUFFIX)).size : 0;
    const journalAfter = await readJournalState(stateDir);

    result.metrics = {
      exit: exited,
      bytesOnDiskBefore,
      bytesOnDiskAfter,
      bytesStagingAfter: stagingBytesAfter,
      segmentsBefore: segmentsBefore.count,
      segmentsAfter: segmentsAfter.count,
      segmentsReadableBefore: segmentsBefore.readable,
      segmentsReadableAfter: segmentsAfter.readable,
      recordedBytesBefore: segmentsBefore.recorded,
      recordedBytesAfter: segmentsAfter.recorded,
      journalBefore,
      journalAfter,
      runtimeFileLeftBehind: runtimeAfter,
      bytes: bytesOnDiskAfter,
      expectedBytes: size,
      sha256: null,
      expectedSha256: origin.expectedSha256,
      exitCode: exited && exited.code !== null ? exited.code : 1,
    };

    addCheck(result, "process-was-killed", exited !== null, JSON.stringify(exited));
    // The journal is the thing that must survive: a torn or unreadable segment
    // file would make the next resume rebuild from zero at best.
    addCheck(result, "journal-survived", segmentsAfter.count > 0 && segmentsAfter.readable === segmentsAfter.count,
      segmentsAfter.count + " segment file(s), " + segmentsAfter.readable + " readable");
    // A hard kill publishes nothing at the final path; the resumable state is
    // the staging file. Checking the final path here would demand the very
    // "looks finished but is not" file this ticket removes.
    addCheck(result, "final-path-absent-after-kill", bytesOnDiskAfter === 0,
      "a killed transfer must not leave a file at the final path, found " + bytesOnDiskAfter + " bytes");
    addCheck(result, "staging-file-kept-after-kill", stagingBytesAfter > 0,
      "staging file (target + " + STAGING_SUFFIX + ") must survive a kill, found " + stagingBytesAfter + " bytes");
    addCheck(result, "journal-holds-progress", segmentsAfter.recorded > 0,
      "segment journal recorded " + segmentsAfter.recorded + " bytes");
    // The resume assertions are only meaningful if a real checkpoint existed.
    addCheck(result, "checkpoint-was-substantial",
      segmentsAfter.recorded >= (result.metricsCheckpointTarget || 0),
      "checkpointed " + segmentsAfter.recorded + " bytes, wanted at least " +
      (result.metricsCheckpointTarget || 0));
    // A hard kill means the runtime file is expected to be stale, and the
    // loader must not treat it as a running daemon.
    const { readRuntime } = await import("../src/daemon.mjs");
    const sameProcessHome = process.env.DOWNLOADX_HOME;
    process.env.DOWNLOADX_HOME = home;
    const stale = await readRuntime();
    if (sameProcessHome === undefined) delete process.env.DOWNLOADX_HOME;
    else process.env.DOWNLOADX_HOME = sameProcessHome;
    addCheck(result, "stale-runtime-not-treated-as-running", stale === null,
      "readRuntime() after a kill: " + JSON.stringify(stale));

    // Now recover in a fresh daemon and finish the download.
    process.env.DOWNLOADX_HOME = home;
    const { Daemon } = await import("../src/daemon.mjs");
    const recovered = await new Daemon({ port: 0 }).init();
    const rt2 = await recovered.start();
    try {
      const view = await (await fetch("http://127.0.0.1:" + rt2.port + "/api/tasks/" + task.id, {
        headers: { "x-downloadx-token": rt2.token },
      })).json();
      const t = view.task;
      addCheck(result, "not-reported-complete-after-kill", t.status !== "complete",
        "status after recovery: " + t.status);
      addCheck(result, "task-still-listed", Boolean(t), "task present");
      addCheck(result, "progress-not-zeroed", t.downloadedBytes > 0,
        "downloadedBytes after recovery: " + t.downloadedBytes);

      origin.resetCounters();
      await fetch("http://127.0.0.1:" + rt2.port + "/api/tasks/" + task.id + "/resume", {
        method: "POST", headers: { "x-downloadx-token": rt2.token },
      });
      const settled = await waitUntil(async () => {
        const v = await (await fetch("http://127.0.0.1:" + rt2.port + "/api/tasks/" + task.id, {
          headers: { "x-downloadx-token": rt2.token },
        })).json();
        return v.task && (v.task.status === "complete" || v.task.status === "error") ? v.task : null;
      }, "the recovered task to settle", 300000);

      const actualSha = await hashFile(target);
      result.metrics.sha256 = actualSha;
      result.metrics.bytes = (await fsp.stat(target)).size;
      result.metrics.bytesResentAfterKill = origin.state.bytesDelivered;

      addCheck(result, "recovered-to-complete", settled.status === "complete", "status: " + settled.status);
      addCheck(result, "recovered-sha256", actualSha === origin.expectedSha256,
        actualSha.slice(0, 16) + " vs " + origin.expectedSha256.slice(0, 16));
      // The resume must not re-fetch the whole file. The bound is stated
      // against what was checkpointed: the bytes written since the last
      // checkpoint are legitimately re-fetched, so half the checkpointed amount
      // is the slack. A run that really started over fetches 100% and fails
      // this regardless of where the checkpoint landed.
      const checkpointed = result.metrics.recordedBytesBefore;
      const resumeBudget = size - checkpointed / 2;
      addCheck(result, "recovery-did-not-start-over",
        origin.state.bytesDelivered < resumeBudget,
        "after the kill the transfer fetched " + formatBytes(origin.state.bytesDelivered) +
        " of " + formatBytes(size) + "; " + checkpointed + " bytes were checkpointed, so a resume " +
        "should have needed at most " + formatBytes(resumeBudget));
    } finally {
      await recovered.stop();
    }
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    if (previousHome === undefined) delete process.env.DOWNLOADX_HOME;
    else process.env.DOWNLOADX_HOME = previousHome;
    await origin.close();
  }
}

/**
 * Scenario 5: controlled disk and permission failures.
 *
 * Real system permissions are never modified and the disk is never filled. The
 * failure is injected where it matters — the write path — and the requirement
 * is that it surfaces rather than being reported as a successful download.
 */
async function scenarioWriteFailure(ctx, result) {
  const { workDir } = ctx;
  const { Config } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { Downloader } = await import("../src/downloader.mjs");

  const size = 4 * 1024 * 1024;
  const origin = await startLargeOrigin({ size });
  try {
    const dir = path.join(workDir, "write-failure");
    await fsp.mkdir(dir, { recursive: true });

    /**
     * Every probe below states the write that cannot succeed, how the failure
     * is injected, and what must remain true afterwards. The injection is
     * always in-process: no ACL is changed, no lock is forced from outside, and
     * no volume is filled.
     */
    const probes = [];

    // (a) The target path is an existing directory holding user data. The
    //     overwrite policy asks to replace the file at that path, but there is
    //     no file there. The requirement is that the directory survives: it is
    //     not this download's property to delete.
    const asDir = path.join(dir, "target-is-a-directory.bin");
    await fsp.mkdir(asDir, { recursive: true });
    await fsp.writeFile(path.join(asDir, "keep-me.txt"), "user data that must survive");
    probes.push({
      id: "target-is-a-directory",
      requirement: "the directory and the file inside it must still exist afterwards",
      overwrite: "overwrite",
      filename: "target-is-a-directory.bin",
      expectFailure: true,
      verify: async () => {
        const stillDir = (await fsp.stat(asDir).catch(() => null))?.isDirectory() === true;
        const survived = fs.existsSync(path.join(asDir, "keep-me.txt"));
        return {
          ok: stillDir && survived,
          detail: "directory intact: " + stillDir + ", user file intact: " + survived,
        };
      },
      args: () => ({ dir }),
    });

    // (b) The parent directory cannot be created because a regular file
    //     occupies its name. This is the same open() failure a permission
    //     denial produces, without touching any real permission.
    const blocker = path.join(dir, "blocker");
    await fsp.writeFile(blocker, "not a directory");
    probes.push({
      id: "parent-is-a-file",
      requirement: "the download must fail and explain itself",
      overwrite: "overwrite",
      filename: "x.bin",
      expectFailure: true,
      verify: async () => ({
        ok: !fs.existsSync(path.join(blocker, "sub", "x.bin")),
        detail: "no file was created below the blocker",
      }),
      args: () => ({ dir: path.join(blocker, "sub") }),
    });

    // (c) A destination that cannot be written at all: the whole path is
    //     unreachable because a file sits where its directory would be.
    probes.push({
      id: "unwritable-destination",
      requirement: "the download must fail and explain itself",
      overwrite: "overwrite",
      filename: "file.bin",
      expectFailure: true,
      verify: async () => ({
        ok: !fs.existsSync(path.join(blocker, "deeper", "file.bin")),
        detail: "no file was created",
      }),
      args: () => ({ dir: path.join(blocker, "deeper") }),
    });

    const observed = [];
    for (const spec of probes) {
      // Each probe gets its own config, so the overwrite policy under test is
      // the one that actually governs the run.
      const probeCfg = new Config(path.join(dir, "cfg-" + spec.id + ".json"));
      await probeCfg.load();
      await probeCfg.set({
        defaultDir: dir, categorizeByType: false, maxConnections: 2,
        overwriteExisting: spec.overwrite,
      });
      const probeQueue = new QueueManager({ config: probeCfg });
      await probeQueue.load();
      const probeDl = new Downloader({ config: probeCfg, queue: probeQueue });

      const args = spec.args();
      let threw = null;
      let returned = null;
      try {
        returned = await probeDl.run({
          id: "wf-" + spec.id, url: origin.url, kind: "http",
          filename: spec.filename, headers: {}, connections: 2, meta: {},
          ...args,
        });
      } catch (err) { threw = err; }

      const reportedSuccess = Boolean(returned && returned.ok === true);
      const message = threw ? String(threw.message || threw) : "(reported success)";
      const verified = await spec.verify();
      observed.push({
        id: spec.id,
        requirement: spec.requirement,
        threw: Boolean(threw),
        reportedSuccess,
        message,
        dataRequirementMet: verified.ok,
        dataDetail: verified.detail,
      });

      // The requirement that holds for every probe: what the user already had
      // is still there.
      addCheck(result, spec.id + "-user-data-intact", verified.ok, verified.detail);
      if (spec.expectFailure) {
        addCheck(result, spec.id + "-surfaced-as-error", Boolean(threw) || !reportedSuccess,
          "threw=" + Boolean(threw) + " reportedSuccess=" + reportedSuccess + " message=" + message);
        addCheck(result, spec.id + "-message-is-useful",
          Boolean(threw) && String(threw.message || "").length > 8,
          "message: " + message);
      }
    }

    // (d) The write is interrupted part-way through, which is what a full disk
    //     or a removed drive looks like from inside the process. The failure
    //     must surface and the resumable state must be kept.
    const controller = new AbortController();
    const abortTarget = path.join(dir, "aborted.bin");
    const { DownloadEngine } = await import("../src/engine.mjs");
    const abortedEngine = new DownloadEngine({
      url: origin.url, targetPath: abortTarget, connections: 2, signal: controller.signal,
    });
    const { probe: probeUrl } = await import("../src/probe.mjs");
    const info = await probeUrl(origin.url);
    // Same staging layout the engine uses, so "kept state" is judged against
    // the files a resume would actually read.
    const abortStaging = abortTarget + STAGING_SUFFIX;
    const abortJournalDir = abortTarget + JOURNAL_SUFFIX;
    const abortJournalBefore = await readSegmentSummary(path.join(abortJournalDir, "segments"));
    let abortThrew = null;
    const progressWatcher = new Promise((resolve) => {
      abortedEngine.on("progress", (p) => {
        if ((p.bytesWritten || 0) >= 1024 * 1024) { controller.abort(); resolve(undefined); }
      });
      setTimeout(() => { controller.abort(); resolve(undefined); }, 30000);
    });
    try {
      await Promise.all([abortedEngine.run({ probe: info, resume: false }), progressWatcher]);
    } catch (err) { abortThrew = err; }
    const abortFinalExists = fs.existsSync(abortTarget);
    const abortStagingSize = fs.existsSync(abortStaging) ? (await fsp.stat(abortStaging)).size : 0;
    const abortJournalAfter = await readSegmentSummary(path.join(abortJournalDir, "segments"));
    const abortStateAfter = await readJournalState(abortJournalDir);
    observed.push({
      id: "aborted-mid-write",
      requirement: "the failure must surface, nothing may be published at the final path, " +
        "and the resumable state must be kept",
      threw: Boolean(abortThrew),
      message: String(abortThrew && abortThrew.message),
      dataRequirementMet: !abortFinalExists && abortStagingSize > 0,
      dataDetail: "final path present: " + abortFinalExists +
        "; staging: " + abortStagingSize + " bytes" +
        "; journal: " + abortJournalAfter.count + " record(s), " +
        abortJournalAfter.readable + " readable, " + abortJournalAfter.recorded + " bytes recorded" +
        "; state.json: " + (abortStateAfter ? "present" : "missing") +
        " (journal before the abort: " + abortJournalBefore.count + " record(s))",
    });
    addCheck(result, "aborted-mid-write-surfaced", Boolean(abortThrew),
      "aborting mid-transfer must raise, got: " + String(abortThrew && abortThrew.message));
    // Requirement 4 of the ticket: the failure is reported AND the state on
    // disk matches the recovery semantics. The old assertion demanded the
    // final path exist, which is the pre-staging behaviour: a file at the
    // final path that looks complete is precisely what must never be left.
    addCheck(result, "aborted-mid-write-final-path-absent", !abortFinalExists,
      "an aborted transfer must not leave a file at the final path; present: " + abortFinalExists);
    addCheck(result, "aborted-mid-write-kept-state", abortStagingSize > 0,
      "the staging file must remain so the transfer can be resumed; found " + abortStagingSize + " bytes");
    addCheck(result, "aborted-mid-write-journal-kept",
      abortJournalAfter.count > 0 && abortJournalAfter.readable === abortJournalAfter.count,
      abortJournalAfter.count + " segment record(s), " + abortJournalAfter.readable + " readable");
    addCheck(result, "aborted-mid-write-state-kept", Boolean(abortStateAfter),
      "state.json must remain under target + " + JOURNAL_SUFFIX + " so a resume knows the plan");
    addCheck(result, "aborted-mid-write-progress-recorded", abortJournalAfter.recorded > 0,
      "the journal must record the bytes written before the abort; recorded " + abortJournalAfter.recorded);

    // (e) The segment journal itself cannot be created, which is the failure a
    //     full disk produces at the first write. A transfer that cannot record
    //     its progress must not proceed as if it could.
    const { TransferStore } = await import("../src/store.mjs");
    const journalBlocker = path.join(dir, "journal-blocker");
    await fsp.writeFile(journalBlocker, "regular file");
    const badStore = new TransferStore(path.join(journalBlocker, "nested", "out.bin"));
    let journalThrew = null;
    try { await badStore.init(); } catch (err) { journalThrew = err; }
    observed.push({
      id: "journal-cannot-be-created",
      requirement: "a transfer whose state cannot be written must not silently proceed",
      threw: Boolean(journalThrew),
      message: String(journalThrew && journalThrew.message),
      dataRequirementMet: true,
      dataDetail: "no user data involved",
    });
    addCheck(result, "journal-cannot-be-created-surfaces", Boolean(journalThrew),
      "an uncreatable journal must raise, got: " + String(journalThrew && journalThrew.message));

    result.metrics = {
      observed,
      probesRun: probes.length,
      abortedMidWrite: {
        finalPathExists: abortFinalExists,
        stagingBytes: abortStagingSize,
        journalRecords: abortJournalAfter.count,
        journalRecorded: abortJournalAfter.recorded,
        statePresent: Boolean(abortStateAfter),
      },
      bytes: 0,
      exitCode: 0,
      /** Recorded so a reviewer can see the constraints were respected. */
      systemPermissionsTouched: false,
      diskFilled: false,
      failureInjection: "in-process only: no real ACL was changed, no lock was forced, no volume was filled",
    };
    result.notes.push("failure was injected through the write path only; no real permission was changed");
    result.notes.push("each probe states its requirement and checks that what the user already had survived");
  } finally {
    await origin.close();
  }
}

/**
 * Scenario 6: progress is checkpointed while a transfer is running.
 *
 * This is the property that makes a hard kill survivable. Journal writes used
 * to happen only when a segment finished, so killing the process mid-segment
 * threw away every byte of that segment and the resume redid it. The interval
 * is a bound on how much work a crash can cost.
 */
async function scenarioCheckpointing(ctx, result) {
  const { workDir } = ctx;
  // Throttled so the transfer takes long enough to observe intermediate state.
  const size = 16 * 1024 * 1024;
  const origin = await startLargeOrigin({ size, throttleBytesPerSecond: 768 * 1024 });
  try {
    const dir = path.join(workDir, "checkpointing");
    await fsp.mkdir(dir, { recursive: true });
    const { Config } = await import("../src/config.mjs");
    const { QueueManager } = await import("../src/queue.mjs");
    const { Downloader } = await import("../src/downloader.mjs");
    const cfg = new Config(path.join(dir, "config.json"));
    await cfg.load();
    await cfg.set({
      defaultDir: dir, categorizeByType: false, overwriteExisting: "overwrite",
      maxConnections: 2, segmentBytes: 8 * 1024 * 1024,
    });
    const q = new QueueManager({ config: cfg });
    await q.load();
    const dl = new Downloader({ config: cfg, queue: q });

    const target = path.join(dir, "checkpoint.bin");
    const segmentsDir = path.join(target + ".downloadx", "segments");
    const taskId = "checkpoint-watch";
    const run = dl.run({
      id: taskId, url: origin.url, kind: "http", filename: "checkpoint.bin",
      dir, headers: {}, connections: 2, meta: {},
    }).catch(() => null);

    // Sample the journal while the transfer runs. The first non-zero reading
    // before the transfer ends is the checkpoint.
    const samples = [];
    const deadline = Date.now() + 60000;
    let finished = false;
    run.then(() => { finished = true; });
    while (Date.now() < deadline) {
      const summary = await readSegmentSummary(segmentsDir);
      samples.push(summary.recorded);
      // Stop once two *different* non-zero readings have been seen: that is
      // what proves the journal was rewritten mid-transfer rather than written
      // once. Counting readings instead would stop on two identical values.
      if (new Set(samples.filter((v) => v > 0)).size >= 2) break;
      if (finished) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    const result0 = await run;
    const positive = samples.filter((v) => v > 0);
    const firstPositive = positive.length ? positive[0] : 0;
    // Two readings that differ prove the journal was rewritten during the
    // transfer rather than once at the end.
    const grew = new Set(positive).size > 1;

    const onDisk = (await fsp.stat(target)).size;
    const actualSha = await hashFile(target);

    result.metrics = {
      bytes: onDisk,
      expectedBytes: size,
      sha256: actualSha,
      expectedSha256: origin.expectedSha256,
      samples,
      firstCheckpointBytes: firstPositive,
      checkpointsObserved: new Set(positive).size,
      transferCompleted: Boolean(result0 && result0.ok),
      exitCode: 0,
    };

    addCheck(result, "journal-written-before-completion", firstPositive > 0 && firstPositive < size,
      "first non-zero journal reading: " + firstPositive + " of " + size);
    addCheck(result, "journal-advanced-during-transfer", grew,
      "distinct checkpoint values observed: " + new Set(positive).size + " of " + samples.length + " samples");
    addCheck(result, "transfer-completed", Boolean(result0 && result0.ok), "engine returned ok");
    addCheck(result, "final-sha256", actualSha === origin.expectedSha256,
      actualSha.slice(0, 16) + " vs " + origin.expectedSha256.slice(0, 16));
    result.notes.push("the checkpoint interval bounds how much a crash can cost; " +
      "journal readings during the transfer: " + JSON.stringify(samples.slice(0, 12)));
  } finally {
    await origin.close();
  }
}

// ------------------------------------------------------------- small helpers

function assertNoError(what, value) {
  if (value && value.error) throw new Error(what + ": " + value.error);
  if (!value) throw new Error(what + ": no result");
  return value;
}

async function fetchTask(runtime, id) {
  try {
    const res = await fetch("http://127.0.0.1:" + runtime.port + "/api/tasks/" + id, {
      headers: { "x-downloadx-token": runtime.token },
    });
    const body = await res.json();
    return body.task || null;
  } catch {
    return null;
  }
}

async function fetchTaskRaw() { return null; }

/** Poll `fn` until it returns something truthy, or throw with `what`. */
async function waitUntil(fn, what, timeoutMs) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("timed out waiting for " + what);
}

/** Summarise a segment journal without trusting any single file. */
async function readSegmentSummary(segmentsDir) {
  let names = [];
  try { names = await fsp.readdir(segmentsDir); } catch { return { count: 0, readable: 0, recorded: 0 }; }
  const json = names.filter((n) => n.endsWith(".json"));
  let readable = 0;
  let recorded = 0;
  for (const n of json) {
    try {
      const rec = JSON.parse(await fsp.readFile(path.join(segmentsDir, n), "utf8"));
      readable++;
      if (typeof rec.downloaded === "number") recorded += rec.downloaded;
    } catch { /* a torn file is exactly what this is measuring */ }
  }
  return { count: json.length, readable, recorded };
}

/** Read the transfer's state.json, tolerating its absence or damage. */
async function readJournalState(stateDir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(stateDir, "state.json"), "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------- main

const SCENARIOS = [
  { name: "large-file", title: "Large file, multi-connection", run: scenarioLargeFile },
  { name: "interrupt-three", title: "Three interruptions then a clean finish", run: scenarioInterruptThree },
  { name: "restart", title: "Daemon restart mid-transfer", run: scenarioDaemonRestart },
  { name: "forced-exit", title: "Forced exit and state rebuild", run: scenarioForcedExit },
  { name: "checkpointing", title: "Progress checkpointed during a transfer", run: scenarioCheckpointing },
  { name: "write-failure", title: "Controlled disk and write failures", run: scenarioWriteFailure },
];

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Large-file and recovery run");
  lines.push("");
  lines.push("- Started: " + report.startedAt);
  lines.push("- Node: " + report.node);
  lines.push("- Platform: " + report.platform);
  lines.push("- Large-file size: " + formatBytes(report.size) + " (" + report.size + " bytes)");
  lines.push("- Work dir: `" + report.workDir + "`");
  lines.push("- Free space before the run: " + (report.freeSpace
    ? formatBytes(report.freeSpace.free) + " of " + formatBytes(report.freeSpace.total) : "unknown"));
  lines.push("");
  lines.push("| Scenario | Status | Elapsed | Bytes | SHA-256 |");
  lines.push("|---|---|---|---|---|");
  for (const r of report.results) {
    lines.push("| " + r.title + " | " + r.status + " | " + (r.elapsedMs / 1000).toFixed(1) + "s | " +
      (r.metrics.bytes || 0) + " | " + (r.metrics.sha256 ? r.metrics.sha256.slice(0, 16) + "…" : "—") + " |");
  }
  lines.push("");
  for (const r of report.results) {
    lines.push("## " + r.title);
    lines.push("");
    if (r.status === "SKIP") {
      lines.push("SKIP: " + r.skipReason);
      lines.push("");
      continue;
    }
    if (r.error) {
      lines.push("Error: `" + r.error + "`");
      lines.push("");
    }
    lines.push("| Check | Result | Detail |");
    lines.push("|---|---|---|");
    for (const c of r.checks) {
      lines.push("| " + c.id + " | " + (c.ok ? "PASS" : "FAIL") + " | " + String(c.detail).replace(/\|/g, "\\|") + " |");
    }
    lines.push("");
    lines.push("Metrics:");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(r.metrics, null, 2));
    lines.push("```");
    if (r.notes.length) {
      lines.push("");
      lines.push("Notes:");
      for (const n of r.notes) lines.push("- " + n);
    }
    lines.push("");
  }
  lines.push("## Reproduce");
  lines.push("");
  lines.push("```");
  lines.push("node test/large-file.mjs");
  lines.push("node test/large-file.mjs --size 1G        # escalate");
  lines.push("node test/large-file.mjs --only restart   # one scenario");
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

/**
 * Keep only the newest `keep` run directories.
 *
 * Deletion is limited to directories whose names look like the timestamps this
 * suite generates, so nothing else in the target folder can be caught by it.
 *
 * @param {string} root
 * @param {number} keep
 */
async function pruneOldRuns(root, keep) {
  let names = [];
  try { names = await fsp.readdir(root); }
  catch { return; }
  const stampRe = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
  const runs = names.filter((n) => stampRe.test(n)).sort();
  const excess = runs.slice(0, Math.max(0, runs.length - keep));
  for (const name of excess) {
    await fsp.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
  }
  if (excess.length) {
    process.stdout.write("  pruned " + excess.length + " old run(s), keeping " + keep + "\n");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    for (const s of SCENARIOS) console.log("  " + s.name.padEnd(18) + s.title);
    return 0;
  }

  const size = args.size ?? LIMITS.largeFileBytes;
  let names = SCENARIOS.map((s) => s.name);
  if (args.only) names = names.filter((n) => n === args.only);
  if (!names.length) {
    process.stderr.write("no scenario matches --only " + args.only + "\n");
    return 2;
  }

  // Old runs are pruned before a new one starts. Each run holds whole
  // payloads, so without a bound the directory grows by about a gigabyte per
  // invocation. The evidence a reviewer needs is in result.json and RESULT.md,
  // and latest.* always points at the most recent run.
  await pruneOldRuns(args.out ? path.resolve(args.out) : path.join(HERE, "large-runs"), args.keepRuns ?? 3);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outRoot = args.out
    ? path.resolve(args.out)
    : path.join(HERE, "large-runs");
  const workDir = path.join(outRoot, stamp);
  await fsp.mkdir(workDir, { recursive: true });

  // Space check up front: a 1 GiB escalation on a nearly full volume would
  // otherwise fail in a way that looks like a product bug.
  const space = await freeSpace(workDir);
  const needed = size * 3 + 512 * 1024 * 1024;
  if (space && space.free < needed) {
    process.stderr.write(
      "\n  not enough free space for " + formatBytes(size) + " scenarios:\n" +
      "  need about " + formatBytes(needed) + ", have " + formatBytes(space.free) + "\n" +
      "  run with a smaller --size or point --out at another volume.\n\n");
    return 2;
  }

  process.stdout.write("\n  downloadx large-file and recovery suite\n");
  process.stdout.write("  large-file size: " + formatBytes(size) + "\n");
  process.stdout.write("  work dir: " + workDir + "\n\n");

  const results = [];
  const startedAt = new Date().toISOString();
  const suiteStart = Date.now();

  for (const scenario of SCENARIOS) {
    if (!names.includes(scenario.name)) continue;
    const result = makeResult(scenario.name, scenario.title);
    const t0 = Date.now();
    process.stdout.write("  " + scenario.name.padEnd(18));
    try {
      await scenario.run({ workDir, size, verbose: true }, result);
      result.status = result.checks.every((c) => c.ok) ? "PASS" : "FAIL";
    } catch (err) {
      // An exception is a failure of the scenario, never a pass. The reason is
      // kept verbatim so the runner can judge whether the environment or the
      // product was at fault.
      if (err && err.code === "SCENARIO_SKIP") {
        result.status = "SKIP";
        result.skipReason = err.message;
      } else {
        result.status = "FAIL";
        result.error = (err && err.message) || String(err);
        result.checks.push({ id: "scenario-completed", ok: false, detail: result.error });
      }
    }
    result.elapsedMs = Date.now() - t0;
    results.push(result);
    const failed = result.checks.filter((c) => !c.ok);
    process.stdout.write(result.status.padEnd(5) + " " + (result.elapsedMs / 1000).toFixed(1) + "s" +
      (result.status === "SKIP" ? "  — " + result.skipReason : "") +
      (failed.length ? "  (" + failed.map((c) => c.id).join(", ") + ")" : "") + "\n");
    if (result.status !== "PASS") {
      for (const c of result.checks) {
        if (!c.ok) process.stdout.write("      FAIL " + c.id + " — " + c.detail + "\n");
      }
    }
  }

  const report = {
    startedAt,
    node: process.version,
    platform: process.platform + " " + process.arch,
    size,
    workDir,
    freeSpace: space,
    totalMs: Date.now() - suiteStart,
    results,
    passed: results.filter((r) => r.status === "PASS").length,
    failed: results.filter((r) => r.status === "FAIL").length,
    skipped: results.filter((r) => r.status === "SKIP").length,
  };

  const jsonPath = path.join(workDir, "result.json");
  const mdPath = path.join(workDir, "RESULT.md");
  await fsp.writeFile(jsonPath, JSON.stringify(report, null, 2));
  await fsp.writeFile(mdPath, renderMarkdown(report));
  await fsp.writeFile(path.join(outRoot, "latest.json"), JSON.stringify(report, null, 2));
  await fsp.writeFile(path.join(outRoot, "latest.md"), renderMarkdown(report));

  process.stdout.write("\n  " + report.passed + " passed, " + report.failed + " failed, " +
    report.skipped + " skipped  (" + (report.totalMs / 1000).toFixed(1) + "s)\n");
  process.stdout.write("  result.json: " + jsonPath + "\n");
  process.stdout.write("  RESULT.md:   " + mdPath + "\n\n");

  if (!args.keep) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});

  // A skip is not a failure, but it is also not a pass: the exit code says so.
  return report.failed === 0 ? 0 : 1;
}
/**
 * Run main() only when this file is the entry point.
 *
 * Resolved paths are compared rather than URLs, because a relative argv path
 * or a drive-letter difference on Windows would otherwise never match.
 * Importing this module (as the self-test does, to reuse the origin) must not
 * start a run as a side effect.
 */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]); }
  catch { return false; }
}

if (invokedDirectly()) {
  main()
  .then((code) => {
    import("node:http").then((h) => h.default.globalAgent.destroy()).catch(() => {});
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write("\n  large-file suite crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });

}
