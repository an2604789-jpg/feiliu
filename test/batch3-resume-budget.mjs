// Batch-3 regression: aria2-style resume-failure budget for the segmented
// HTTP engine (src/downloader.mjs RESUME_FAILURE_BUDGET, src/store.mjs
// resume-failures.json inside the segment journal).
//
// The defect this guards against: a task whose journal exists but cannot be
// continued — a source that refuses or corrupts continuation ranges (the
// 2026-10-24 P-5 GitHub-release 401 was exactly this shape), or a bad disk
// that keeps losing the same segment — fails, is retried, RESUMES the same
// journal, and fails again at the same offset, for ever. Nothing in that loop
// ever discards the journal, so the task can never finish.
//
// The behaviour asserted here:
//   (a) the FIRST failure of a task with no journal is a fresh attempt and is
//       not counted (the queue's ordinary retry semantics still own it);
//   (b) failures of attempts that DID continue an existing journal are
//       counted in <target>.downloadx/resume-failures.json (1, then 2) and the
//       journal is kept, so the count is observable between retries;
//   (c) a resume that succeeds clears the count ("恢复成功即清零") — one
//       counted failure is forgiven as soon as the next resume carries the
//       transfer to completion;
//   (d) the THIRD consecutive failure trips the budget: exactly one daemon
//       log line (the "downgrade" channel daemon.mjs already forwards to its
//       log), the whole journal is discarded, and the whole file is taken
//       again in one stream from byte zero — against an origin hostile to
//       continuation ranges this is the only strategy that can succeed, and
//       the task COMPLETES on that same retry, byte-exact;
//   (e) a normal pause -> resume (no failures involved) is untouched: the
//       resumed bytes hash to exactly what the origin served and no counter
//       file ever appears;
//   (f) a stale-journal reset caused by an ETag change is NOT a resume
//       failure: the engine's own "different revision" discard path runs, the
//       transfer restarts from zero and completes, and no budget line is
//       written.
//
// Everything runs against local origins and an isolated DOWNLOADX_HOME, so no
// public network, no user Downloads, no %APPDATA%\downloadx, and nothing ever
// touches D:/IAM/downloadx-data.
//
// Usage: node test/batch3-resume-budget.mjs

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";
import { startOrigin, payloadFor } from "./origin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Poll until fn() is true, or fail with the caller's message. */
async function waitFor(fn, { timeoutMs = 30000, everyMs = 50, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Deterministic, non-trivial body of a given size. */
function patternBody(size, seed) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = ((i * 131 + seed) & 0xff);
  return b;
}

/**
 * Origin whose /deep401 route is hostile to continuation ranges the way the
 * real-world P-5 failure was (objects.githubusercontent.com answering 401 to
 * signed continuation ranges): a request without a Range header, or a Range
 * that starts at byte 0, is served honestly; a Range that continues past byte
 * 0 is refused with 401 — non-retryable, so the engine fails fast and, crucial
 * for the budget scenario, WITHOUT discarding the journal.
 *
 * The refusal is delayed slightly so the first attempt deterministically
 * records progress for segment 0 before segment 1's failure ends the attempt:
 * without the delay, which worker's result lands first is a race, and whether
 * attempt 1 leaves any progress at all would not be deterministic.
 *
 * `refuseContinuation` can be toggled mid-run to prove the forgiveness
 * semantics (a later resume that succeeds clears the count).
 *
 * `/flip/<size>` serves one of two revisions (distinct bytes, distinct ETags)
 * at a trickle, so a test can pause mid-transfer, flip the revision and watch
 * the engine's own stale-detection reset — which must NOT consume the budget.
 */
function startHostileOrigin() {
  const DEEP_SIZE = 3 * 1024 * 1024;          // 2 segments at segmentBytes=1MiB
  const FLIP_SIZE = 4 * 1024 * 1024;
  const REFUSE_DELAY_MS = 300;
  const deepBody = patternBody(DEEP_SIZE, 7);
  const deepEtag = '"deep-v1"';
  const flipBodies = { 1: patternBody(FLIP_SIZE, 1), 2: patternBody(FLIP_SIZE, 5) };
  const flipEtags = { 1: '"flip-r1"', 2: '"flip-r2"' };
  const state = { refuseContinuation: true, flipRev: 1 };
  /** Every ranged/no-range request, in order: {kind, start, end, at}. */
  const reqLog = [];

  const server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://localhost").pathname;

    if (p.startsWith("/deep401/")) {
      const size = deepBody.length;
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
      const base = {
        "Content-Type": "application/octet-stream",
        "Accept-Ranges": "bytes",
        "ETag": deepEtag,
      };
      if (req.method === "HEAD" || !m) {
        reqLog.push({ kind: "norange", start: 0, end: size - 1, at: Date.now() });
        res.writeHead(200, { ...base, "Content-Length": size });
        res.end(req.method === "HEAD" ? undefined : deepBody);
        return;
      }
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start === 0) {
        // Byte 0 is always served honestly: a fresh whole-file stream from the
        // start must be able to succeed even while continuations are refused.
        reqLog.push({ kind: "served", start, end, at: Date.now() });
        const slice = deepBody.subarray(start, end + 1);
        res.writeHead(206, {
          ...base,
          "Content-Range": "bytes " + start + "-" + end + "/" + size,
          "Content-Length": slice.length,
        });
        res.end(slice);
        return;
      }
      if (state.refuseContinuation) {
        // Delayed so the worker holding segment 0 records its progress first
        // (see the doc comment); then the hard, non-retryable refusal.
        reqLog.push({ kind: "refused", start, end, at: Date.now() });
        const body = "continuation range refused";
        setTimeout(() => {
          res.writeHead(401, { "Content-Type": "text/plain", "Content-Length": body.length });
          res.end(body);
        }, REFUSE_DELAY_MS);
        return;
      }
      reqLog.push({ kind: "served", start, end, at: Date.now() });
      const slice = deepBody.subarray(start, end + 1);
      res.writeHead(206, {
        ...base,
        "Content-Range": "bytes " + start + "-" + end + "/" + size,
        "Content-Length": slice.length,
      });
      res.end(slice);
      return;
    }

    if (p.startsWith("/flip/")) {
      const body = flipBodies[state.flipRev];
      const size = body.length;
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
      const base = {
        "Content-Type": "application/octet-stream",
        "Accept-Ranges": "bytes",
        "ETag": flipEtags[state.flipRev],
      };
      if (req.method === "HEAD" || !m) {
        res.writeHead(200, { ...base, "Content-Length": size });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      const slice = body.subarray(start, end + 1);
      res.writeHead(206, {
        ...base,
        "Content-Range": "bytes " + start + "-" + end + "/" + size,
        "Content-Length": slice.length,
      });
      // Trickle so the test can pause the task mid-transfer.
      let i = 0;
      const tick = () => {
        if (i >= slice.length) { res.end(); return; }
        if (res.destroyed) return;
        res.write(slice.subarray(i, i + 32 * 1024));
        i += 32 * 1024;
        setTimeout(tick, 6);
      };
      tick();
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  server.on("connection", (socket) => socket.on("error", () => { /* refused clients reset */ }));
  server.on("clientError", (err, socket) => { try { socket.destroy(); } catch { /* gone */ } });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        origin: "http://127.0.0.1:" + server.address().port,
        reqLog,
        deepBody,
        deepSize: DEEP_SIZE,
        flipBody: (rev) => flipBodies[rev],
        setRefuseContinuation: (v) => { state.refuseContinuation = v; },
        setFlipRev: (v) => { state.flipRev = v; },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function main() {
  const suite = new Suite("resume-budget");
  const NL = String.fromCharCode(10);
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + (r.ms > 400 ? "  (" + r.ms + "ms)" : "") + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b3-resume-"));
  const out = path.join(home, "out");
  await fsp.mkdir(out, { recursive: true });
  process.env.DOWNLOADX_HOME = home;

  const origin = await startOrigin();             // honest origin: /throttle
  const hostile = await startHostileOrigin();     // resume-hostile fixtures
  const { Config } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { Downloader } = await import("../src/downloader.mjs");
  const { ApiServer } = await import("../src/api.mjs");

  // Two connections so a fresh attempt plans 2 segments: segment 0 (from byte
  // 0) succeeds while segment 1 (a continuation range) is refused. The budget
  // scenarios need exactly that shape.
  const config = new Config(path.join(home, "config.json"));
  await config.load();
  await config.set({
    defaultDir: out,
    categorizeByType: false,
    maxConnections: 2,
    maxConcurrentDownloads: 1,
    segmentBytes: 1024 * 1024,
    maxRetries: 2,
    retryBaseMs: 50,
    overwriteExisting: "rename",
    proxy: "",
    proxyMode: "none",
  });
  const queue = new QueueManager({ config });
  await queue.load();
  const downloader = new Downloader({ config, queue });
  const api = new ApiServer({
    queue, config, downloader,
    log: { info() {}, warn() {}, error() {}, tail: () => [] },
  }).startRunner();
  const listening = await api.listen({ port: 0 });

  const call = async (method, route, body) => {
    const headers = { "x-downloadx-token": listening.token };
    if (body) headers["content-type"] = "application/json";
    const res = await fetch("http://127.0.0.1:" + listening.port + route, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  };

  // The daemon-log line, as daemon.mjs actually wires it (daemon.mjs forwards
  // the downloader's "downgrade" events to this.log.warn — the one channel a
  // budget-exhaustion event has to the daemon log without daemon.mjs changes).
  const daemonLines = [];
  downloader.on("downgrade", ({ taskId, message }) =>
    daemonLines.push("[" + taskId.slice(0, 8) + "] " + message));
  const budgetLines = () => daemonLines.filter((l) => /resume budget exhausted/.test(l));

  /** Engine log lines (the stale-detection reset announces itself here). */
  const engineLogs = [];
  downloader.on("log", (e) => { if (e && e.message) engineLogs.push(e.message); });

  /** Resolved output paths, straight from the downloader's own event. */
  const resolvedTargets = new Map();
  downloader.on("resolved", (p) => { if (p && p.taskId && p.target) resolvedTargets.set(p.taskId, p.target); });

  const taskById = async (id) => (await call("GET", "/api/tasks/" + id)).json.task ?? null;
  const targetOf = async (id, filename) => {
    await waitFor(() => resolvedTargets.has(id), { what: "the downloader to resolve a target" });
    const target = resolvedTargets.get(id);
    assert.equal(target, path.join(out, filename), "resolved target must be the requested file");
    return target;
  };
  const waitError = async (id, what) => waitFor(async () => {
    const t = await taskById(id);
    return t && t.status === "error" ? t : false;
  }, { what });
  const waitComplete = async (id, what) => waitFor(async () => {
    const t = await taskById(id);
    if (!t) return false;
    if (t.status === "error") throw new Error((what || "transfer") + " failed: " + t.error);
    return t.status === "complete" ? t : false;
  }, { timeoutMs: 60000, what });

  const failuresFile = (target) => path.join(target + ".downloadx", "resume-failures.json");
  const readFailures = async (target) => {
    try { return JSON.parse(await fsp.readFile(failuresFile(target), "utf8")); }
    catch { return null; }
  };

  const DEEP_URL = hostile.origin + "/deep401/" + hostile.deepSize;
  const deepSha = sha256(hostile.deepBody);

  try {
    // -------------------------------------------------- fresh failure: free
    suite.group("budget counts only attempts that continued a journal");

    let budgetId = null;
    await suite.test("the first failure has no journal to resume and is not counted", async () => {
      const added = await call("POST", "/api/tasks", { url: DEEP_URL, filename: "budget.bin" });
      assert.equal(added.status, 201);
      budgetId = added.json.task.id;

      const target = await targetOf(budgetId, "budget.bin");
      const t = await waitError(budgetId, "the hostile-source task to fail");
      // The failure must be the origin's refusal, not something else.
      assert.match(t.error, /401/, "the task error must be the origin's 401");
      // The journal from this attempt stays (that is what the next retries
      // will keep resuming), but no failure was counted: nothing was resumed.
      assert.equal((await fsp.stat(target + ".downloadx/state.json")).isFile(), true,
        "the segment journal must survive the failure");
      assert.equal(await readFailures(target), null,
        "a fresh attempt that fails must not create a resume-failure record");
    });

    await suite.test("two counted resume failures are recorded (1, then 2) and the journal stays", async () => {
      const target = resolvedTargets.get(budgetId);
      for (const expected of [1, 2]) {
        assert.equal((await call("POST", "/api/tasks/" + budgetId + "/retry")).status, 200);
        await waitError(budgetId, "retry #" + expected + " to fail against the hostile source");
        const rec = await readFailures(target);
        assert.ok(rec, "the resume-failure record must exist after counted failure " + expected);
        assert.equal(rec.failures, expected, "consecutive failure count");
        assert.ok(typeof rec.lastError === "string" && /401/.test(rec.lastError),
          "the record must keep the real last error");
        assert.equal((await fsp.stat(target + ".downloadx/state.json")).isFile(), true,
          "the journal is kept so the next retry resumes it");
      }
      assert.equal(budgetLines().length, 0, "the budget must not trip before N=3");
    });

    await suite.test("a resume that succeeds clears the count (one failure is forgiven)", async () => {
      // A different task on the same hostile origin: fail once (counted), then
      // let the origin serve continuations again and watch the resume succeed.
      const added = await call("POST", "/api/tasks", { url: DEEP_URL, filename: "forgive.bin" });
      const id = added.json.task.id;
      const target = await targetOf(id, "forgive.bin");
      await waitError(id, "the fresh attempt to fail");
      assert.equal(await readFailures(target), null, "fresh failure: not counted");
      assert.equal((await call("POST", "/api/tasks/" + id + "/retry")).status, 200);
      await waitError(id, "the first resume to fail");
      assert.equal((await readFailures(target) || {}).failures, 1, "counted failure 1");

      hostile.setRefuseContinuation(false);
      try {
        assert.equal((await call("POST", "/api/tasks/" + id + "/retry")).status, 200);
        const done = await waitComplete(id, "the forgiven resume to complete");
        assert.equal(done.downloadedBytes, hostile.deepSize);
        const body = await fsp.readFile(target);
        assert.equal(sha256(body), deepSha, "the resumed file must be byte-exact");
        // Success cleared the budget and cleaned the whole journal with it.
        assert.equal(await readFailures(target), null, "a successful resume clears the count");
        assert.equal(fs.existsSync(target + ".downloadx"), false, "journal cleaned by success");
      } finally {
        hostile.setRefuseContinuation(true);
      }
      assert.equal(budgetLines().length, 0, "still no budget line: success reset the count");
    });

    // ------------------------------------------------------- the budget trip
    suite.group("the third consecutive resume failure restarts the whole file");

    await suite.test("N=3 discards the journal, logs one daemon line, and the task completes", async () => {
      const target = resolvedTargets.get(budgetId);
      const linesBefore = budgetLines().length;

      // Counter sits at 2: this retry's resume failure is the third strike.
      assert.equal((await call("POST", "/api/tasks/" + budgetId + "/retry")).status, 200);
      const done = await waitComplete(budgetId, "the budget-exhausted restart to complete");
      assert.equal(done.error, null);

      // Exactly one daemon-log line for the exhaustion event, shaped the way
      // daemon.mjs writes it, naming the count.
      const lines = budgetLines();
      assert.equal(lines.length, linesBefore + 1,
        "the budget trip must add exactly one daemon log line");
      assert.match(lines[lines.length - 1], /^\[.{8}\] resume failed 3x in a row .*resume budget exhausted/,
        "the line must carry the task prefix and the count");

      // The whole file came back in one stream from byte zero: the origin
      // served a 0..size-1 range request (the restart), and refused at least
      // three continuation ranges on the way (the three counted failures).
      const whole = hostile.reqLog.filter((r) => r.kind === "served" && r.start === 0 && r.end === hostile.deepSize - 1);
      assert.ok(whole.length >= 1, "the restart must fetch the whole file from byte 0");
      const refused = hostile.reqLog.filter((r) => r.kind === "refused").length;
      assert.ok(refused >= 3, "three counted failures imply at least three refused continuations");

      // The product is byte-exact and no journal artefact survives.
      const body = await fsp.readFile(target);
      assert.equal(body.length, hostile.deepSize, "final file size");
      assert.equal(sha256(body), deepSha, "the restarted file must be byte-exact");
      assert.equal(fs.existsSync(target + ".downloadx"), false, "journal discarded by the trip");
      assert.equal(fs.existsSync(target + ".downloadx-part"), false, "staging discarded by the trip");
      assert.equal(await readFailures(target), null, "the count went with the journal");
    });

    // ------------------------------------------- pause/resume is unaffected
    suite.group("a normal pause -> resume is untouched");

    await suite.test("a paused transfer resumes to the exact bytes, with no counter involved", async () => {
      const resumeSize = 4 * 1024 * 1024;
      const url = origin.origin + "/throttle/" + resumeSize + "/32768/20";
      const added = await call("POST", "/api/tasks", { url, filename: "resume-ok.bin" });
      const id = added.json.task.id;
      const target = await targetOf(id, "resume-ok.bin");

      await waitFor(() => fs.existsSync(target + ".downloadx") && fs.existsSync(target + ".downloadx-part"),
        { what: "the journal and staged file to appear" });
      await waitFor(async () => {
        const t = await taskById(id);
        return t && t.downloadedBytes > 0;
      }, { what: "bytes to be recorded for the task" });
      assert.equal((await call("POST", "/api/tasks/" + id + "/pause")).status, 200);
      await waitFor(async () => {
        const t = await taskById(id);
        return t && t.status === "paused" ? t : false;
      }, { what: "the task to report paused" });

      // Pause keeps the journal (this is what makes it not a cancel) and has
      // never created a failure record: nothing has failed.
      assert.equal(fs.existsSync(target + ".downloadx"), true, "pause keeps the journal");
      assert.equal(await readFailures(target), null, "no failure record without a failure");

      const linesBefore = budgetLines().length;
      assert.equal((await call("POST", "/api/tasks/" + id + "/resume")).status, 200);
      const done = await waitComplete(id, "the resumed transfer to complete");
      const body = await fsp.readFile(target);
      assert.equal(body.length, resumeSize, "resumed file size");
      assert.equal(sha256(body), sha256(payloadFor(resumeSize)), "resumed bytes must equal what the origin served");
      assert.equal(done.downloadedBytes, resumeSize);
      assert.equal(fs.existsSync(target + ".downloadx"), false, "success cleans the journal");
      assert.equal(budgetLines().length, linesBefore, "a healthy resume never trips the budget");
    });

    // ------------------------------------- ETag-change reset is not a failure
    suite.group("a stale (ETag change) reset does not consume the budget");

    await suite.test("a revision change resets via the engine's own stale path and never counts", async () => {
      const url = hostile.origin + "/flip/" + (4 * 1024 * 1024);
      const added = await call("POST", "/api/tasks", { url, filename: "flip.bin" });
      const id = added.json.task.id;
      const target = await targetOf(id, "flip.bin");

      await waitFor(() => fs.existsSync(target + ".downloadx") && fs.existsSync(target + ".downloadx-part"),
        { what: "the journal and staged file to appear" });
      await waitFor(async () => {
        const t = await taskById(id);
        return t && t.downloadedBytes > 0;
      }, { what: "bytes to be recorded for the task" });
      assert.equal((await call("POST", "/api/tasks/" + id + "/pause")).status, 200);
      await waitFor(async () => {
        const t = await taskById(id);
        return t && t.status === "paused" ? t : false;
      }, { what: "the task to report paused" });
      assert.equal(await readFailures(target), null, "no failure record: the pause is not a failure");

      // The origin's content changes revision under the paused journal.
      hostile.setFlipRev(2);
      const linesBefore = budgetLines().length;
      const logsBefore = engineLogs.length;

      assert.equal((await call("POST", "/api/tasks/" + id + "/resume")).status, 200);
      const done = await waitComplete(id, "the transfer after the revision change to complete");
      assert.equal(done.error, null);

      // The reset came from the engine's own stale detection, not the budget.
      assert.ok(
        engineLogs.slice(logsBefore).some((m) => /different revision/.test(m)),
        "the engine's stale-detection discard must have run",
      );
      assert.equal(budgetLines().length, linesBefore, "an ETag-change reset must not trip the budget");
      assert.equal(fs.existsSync(target + ".downloadx"), false, "journal cleaned by success");

      const body = await fsp.readFile(target);
      assert.equal(sha256(body), sha256(hostile.flipBody(2)),
        "the file must be exactly the new revision's bytes");
    });

    // ------------------------------------------------------------- summary
    await suite.test("exactly one budget line was written across the whole run", async () => {
      assert.equal(budgetLines().length, 1, "one exhaustion event happened, so one line");
    });
  } finally {
    await api.close().catch(() => {});
    for (const srv of [origin, hostile]) {
      await new Promise((r) => {
        try { srv.server.closeAllConnections?.(); } catch { /* none */ }
        srv.close().then(r);
        setTimeout(r, 1500);
      });
    }
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch3-resume-budget crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
