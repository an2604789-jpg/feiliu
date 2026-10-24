// P1 regression: POST /api/tasks/:id/cancel must exist and must mean "discard".
//
// The defect this guards against: the only task actions the HTTP API knew were
// start / pause / resume / retry / move, so a POST .../cancel fell through to
// the default branch and answered 405 "unsupported POST cancel". A client that
// wanted to give up on a download had no way to do it: pause keeps the journal
// on purpose (a resume continues from it), and DELETE only drops the task row.
//
// The behaviour asserted here:
//   (a) cancel answers 2xx with JSON, never 405;
//   (b) the task stops occupying a concurrency slot;
//   (c) the transfer's intermediate state is gone:
//       "<target>.downloadx/" (segment journal) and "<target>.downloadx-part"
//       (the staged assembly file);
//   (d) no file was published at the final path;
//   (e) pause/resume is untouched: a paused transfer still resumes and the
//       resumed bytes hash to exactly what the origin served;
//   (f) a finished download is never destroyed by cancel (409, file kept);
//   (g) cancel of an unknown id answers the same 404 as every other task route,
//       so a second cancel of the same id is a deliberate 404, not a crash.
//
// Everything runs against a local origin and an isolated DOWNLOADX_HOME, so no
// public network, no user Downloads, no %APPDATA%\downloadx.
//
// Usage: node test/p1-cancel.mjs

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
const ROOT = path.resolve(HERE, "..");

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const suite = new Suite("cancel");
  const NL = String.fromCharCode(10);
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-p1-cancel-"));
  const out = path.join(home, "out");
  await fsp.mkdir(out, { recursive: true });
  process.env.DOWNLOADX_HOME = home;

  const origin = await startOrigin();
  const { Config } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { Downloader } = await import("../src/downloader.mjs");
  const { ApiServer } = await import("../src/api.mjs");

  // One connection and one slot: the throttle fixture then trickles at a
  // predictable rate and "occupies a slot" is an unambiguous number.
  const config = new Config(path.join(home, "config.json"));
  await config.load();
  await config.set({
    defaultDir: out,
    categorizeByType: false,
    maxConnections: 1,
    maxConcurrentDownloads: 1,
    segmentBytes: 262144,
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

  // /throttle/<size>/<chunk>/<delayMs>: ranged, rate-limited, stable ETag.
  const SLOW_SIZE = 8 * 1024 * 1024;      // ~5 s at 32 KiB / 20 ms
  const SLOW_URL = origin.origin + "/throttle/" + SLOW_SIZE + "/32768/20";
  const resumeSize = 4 * 1024 * 1024;     // ~2.5 s
  const resumeUrl = origin.origin + "/throttle/" + resumeSize + "/32768/20";

  /** Resolved output paths, straight from the downloader's own event. */
  const resolvedTargets = new Map();
  downloader.on("resolved", (p) => { if (p && p.taskId && p.target) resolvedTargets.set(p.taskId, p.target); });

  const stats = async () => (await call("GET", "/api/queue")).json;
  const taskById = async (id) => (await call("GET", "/api/tasks/" + id)).json.task ?? null;

  const waitInFlight = async (id, filename) => {
    const expected = path.join(out, filename);
    await waitFor(() => resolvedTargets.has(id), { what: "the downloader to resolve a target" });
    const target = resolvedTargets.get(id);
    assert.equal(target, expected, "resolved target must be the requested file");
    // Both intermediate artefacts must be on disk before the cancel means
    // anything: the journal (progress record) and the staged assembly file.
    await waitFor(() => fs.existsSync(target + ".downloadx") && fs.existsSync(target + ".downloadx-part"),
      { what: "the segment journal and the staged file to appear" });
    await waitFor(async () => {
      const t = await taskById(id);
      return t && t.downloadedBytes > 0;
    }, { what: "bytes to be recorded for the task" });
    return target;
  };

  // Declared outside the try so the summary at the end can print the real
  // response body even when a later test fails.
  let cancelledId = null;
  let cancelBody = null;

  try {
    // ---------------------------------------------------------------- cancel
    suite.group("POST /api/tasks/:id/cancel");

    await suite.test("cancel in flight answers 200 JSON (not 405) and empties the intermediate state", async () => {
      const added = await call("POST", "/api/tasks", { url: SLOW_URL, filename: "cancel-me.bin" });
      assert.equal(added.status, 201);
      const id = added.json.task.id;
      cancelledId = id;

      const before = await waitInFlight(id, "cancel-me.bin");
      const beforeStats = await stats();
      assert.equal(beforeStats.active, 1, "the transfer must be occupying the only slot");

      const r = await call("POST", "/api/tasks/" + id + "/cancel");
      assert.notEqual(r.status, 405, "cancel must not be an unsupported action");
      assert.equal(r.status, 200, "expected 200, got " + r.status + " " + JSON.stringify(r.json));
      cancelBody = r.json;
      assert.equal(r.json.ok, true);
      assert.equal(r.json.cancelled, true);
      assert.equal(r.json.removed, true);
      assert.equal(r.json.id, id);
      assert.equal(r.json.target, before);

      // (c) intermediate state gone, both artefacts.
      assert.equal(fs.existsSync(before + ".downloadx"), false, "the segment journal must be removed");
      assert.equal(fs.existsSync(before + ".downloadx-part"), false, "the staged file must be removed");
      // And the response says so, so a client can prove what was discarded.
      assert.ok(r.json.discarded.includes(before + ".downloadx"), "response must list the removed journal");
      assert.ok(r.json.discarded.includes(before + ".downloadx-part"), "response must list the removed staged file");
      // (d) nothing was published at the final path.
      assert.equal(fs.existsSync(before), false, "a cancelled transfer must not leave a final file");
    });

    await suite.test("cancel frees the concurrency slot and removes the task", async () => {
      const s = await stats();
      assert.equal(s.active, 0, "the cancelled transfer must not keep the slot");
      assert.equal(s.total, 0, "the cancelled task must leave the queue");
      assert.equal(queue.running.size, 0, "no runner may be left registered");
      const list = (await call("GET", "/api/tasks")).json.tasks;
      assert.equal(list.length, 0);
      assert.equal((await call("GET", "/api/tasks/" + cancelledId)).status, 404);
    });

    await suite.test("a second cancel of the same id is a 404, like any other task route", async () => {
      const again = await call("POST", "/api/tasks/" + cancelledId + "/cancel");
      assert.equal(again.status, 404);
      assert.equal(again.json.error, "no such task");
    });

    // ------------------------------------------------------- pause / resume
    suite.group("pause and resume are unaffected");

    let completedId = null;
    let completedPath = null;
    await suite.test("a paused transfer keeps its journal and resumes to the exact bytes", async () => {
      const added = await call("POST", "/api/tasks", { url: resumeUrl, filename: "resume-me.bin" });
      assert.equal(added.status, 201);
      const id = added.json.task.id;
      completedId = id;

      const target = await waitInFlight(id, "resume-me.bin");
      completedPath = target;

      assert.equal((await call("POST", "/api/tasks/" + id + "/pause")).status, 200);
      const paused = await waitFor(async () => {
        const t = await taskById(id);
        return t && t.status === "paused" ? t : false;
      }, { what: "the task to report paused" });
      assert.equal(paused.status, "paused");

      // Pause must KEEP the transfer state; this is what makes it not a cancel.
      assert.equal(fs.existsSync(target + ".downloadx"), true, "pause must keep the segment journal");
      assert.equal(fs.existsSync(target + ".downloadx-part"), true, "pause must keep the staged file");
      assert.equal(fs.existsSync(target), false, "a paused transfer has not published anything");

      assert.equal((await call("POST", "/api/tasks/" + id + "/resume")).status, 200);
      const done = await waitFor(async () => {
        const t = await taskById(id);
        if (!t) return false;
        if (t.status === "error") throw new Error("resume failed: " + t.error);
        return t.status === "complete" ? t : false;
      }, { timeoutMs: 60000, what: "the resumed transfer to complete" });

      assert.equal(fs.existsSync(target), true, "the resumed transfer must publish its file");
      const body = await fsp.readFile(target);
      assert.equal(body.length, resumeSize, "resumed file size");
      assert.equal(sha256(body), sha256(payloadFor(resumeSize)), "resumed bytes must equal what the origin served");
      assert.equal(done.downloadedBytes, resumeSize);
      // The journal is cleaned up by a successful transfer, not by us.
      assert.equal(fs.existsSync(target + ".downloadx"), false, "a completed transfer cleans its own journal");
    });

    suite.group("cancel refuses to destroy a finished download");

    await suite.test("cancel of a complete task answers 409 and keeps the file", async () => {
      const before = await taskById(completedId);
      assert.equal(before.status, "complete");
      const sha = sha256(await fsp.readFile(completedPath));
      const r = await call("POST", "/api/tasks/" + completedId + "/cancel");
      assert.equal(r.status, 409, "expected 409, got " + r.status + " " + JSON.stringify(r.json));
      assert.equal(r.json.ok, false);
      assert.equal(r.json.cancelled, false);
      assert.equal(fs.existsSync(completedPath), true, "the finished file must survive a cancel attempt");
      assert.equal(sha256(await fsp.readFile(completedPath)), sha, "the finished file must be byte-identical");
      const still = await taskById(completedId);
      assert.ok(still, "a refused cancel must not remove the task");
      assert.equal(still.status, "complete");
    });

    suite.group("cancel cleans media scratch too");

    const hlsUrl = origin.origin + "/hls/media.m3u8?count=16";

    await suite.test("an HLS task added without a kind leaves no .parts/ and no journal", async () => {
      const added = await call("POST", "/api/tasks", { url: hlsUrl, filename: "auto.ts", speedLimit: 131072 });
      assert.equal(added.status, 201);
      const id = added.json.task.id;
      // No explicit kind on purpose: the downloader has to detect HLS from the
      // URL, and this is the case that used to keep kind="http" and then clean
      // the wrong family of scratch paths.
      assert.equal(added.json.task.kind, "http", "a task without a kind starts as http");

      const target = await waitFor(() => resolvedTargets.get(id), { what: "the HLS target to be resolved" });
      assert.equal(target, path.join(out, "auto.ts"));
      await waitFor(() => fs.existsSync(target + ".parts"), { what: "the HLS segment scratch to appear" });
      // The detected protocol must be on the task itself, not only in a local.
      const inFlight = await waitFor(async () => {
        const t = await taskById(id);
        return t && t.kind === "hls" && t.status !== "complete" ? t : false;
      }, { what: "the task to report kind=hls while running" });
      assert.equal(inFlight.kind, "hls");

      const watch = [target + ".parts", target + ".downloadx", target + ".downloadx-part", target + ".partial"];
      const existedBefore = new Set(watch.filter((p) => fs.existsSync(p)));
      assert.equal(existedBefore.has(target + ".parts"), true, "the scratch must exist before the cancel");

      const r = await call("POST", "/api/tasks/" + id + "/cancel");
      assert.equal(r.status, 200, "expected 200, got " + r.status + " " + JSON.stringify(r.json));
      assert.equal(r.json.kind, "hls", "cancel must clean up as HLS, not as plain http");
      // (i) media scratch and journal are gone.
      assert.equal(fs.existsSync(target + ".parts"), false, "the HLS segment scratch must be removed");
      assert.equal(fs.existsSync(target + ".downloadx"), false, "the transfer journal must be removed");
      assert.equal(fs.existsSync(target + ".downloadx-part"), false, "the staged file must be removed");
      assert.equal(fs.existsSync(target), false, "a cancelled HLS transfer must not publish a file");
      // Nothing is reported that was not there: every discarded path existed.
      assert.ok(r.json.discarded.length > 0, "at least the scratch must be reported");
      for (const p of r.json.discarded) {
        assert.ok(existedBefore.has(p), "discarded path must have existed before the cancel: " + p);
      }
      assert.ok(r.json.discarded.includes(target + ".parts"), "the .parts directory must be reported");
    });

    await suite.test("under rename the HLS output actually used is the one cleaned", async () => {
      const taken = path.join(out, "taken.ts");
      const sentinel = Buffer.from("pre-existing user file that must not be touched");
      await fsp.writeFile(taken, sentinel);

      const created = await call("POST", "/api/tasks", { url: hlsUrl, filename: "taken.ts", speedLimit: 131072 });
      assert.equal(created.status, 201);
      const id = created.json.task.id;

      // The collision policy renames, so the transfer's real output is not
      // dir+filename. Cancel has to act on the resolved name.
      const target = await waitFor(() => {
        const t = resolvedTargets.get(id);
        return t && t !== taken ? t : false;
      }, { what: "the renamed HLS target to be resolved" });
      assert.notEqual(target, taken, "the rename policy must pick another name");
      await waitFor(() => fs.existsSync(target + ".parts"), { what: "the renamed transfer to start writing" });

      const watch = [target + ".parts", target + ".audioparts", target + ".audio.ts",
        target + ".downloadx", target + ".downloadx-part", target + ".partial"];
      const existedBefore = new Set(watch.filter((p) => fs.existsSync(p)));

      const r = await call("POST", "/api/tasks/" + id + "/cancel");
      assert.equal(r.status, 200, "expected 200, got " + r.status + " " + JSON.stringify(r.json));
      assert.equal(r.json.target, target, "cancel must use the resolved name, not dir+filename");
      for (const p of r.json.discarded) {
        assert.ok(existedBefore.has(p), "reported path must have existed before the cancel: " + p);
      }
      assert.equal(fs.existsSync(target + ".parts"), false, "the renamed transfer's scratch must be removed");
      assert.equal(fs.existsSync(target), false, "the renamed output must never be published");
      // The user's own file is untouched, and no renamed leftovers remain.
      assert.equal((await fsp.readFile(taken)).equals(sentinel), true, "the pre-existing file must be untouched");
      const leftovers = fs.readdirSync(out).filter((n) => n.startsWith("taken") && n !== "taken.ts");
      assert.equal(leftovers.length, 0, "no leftover artefacts for the renamed transfer: " + leftovers.join(", "));
    });

    await suite.test("unknown ids and unknown actions keep their old answers", async () => {
      const unknown = await call("POST", "/api/tasks/does-not-exist/cancel");
      assert.equal(unknown.status, 404);
      assert.equal(unknown.json.error, "no such task");
      // The cancel branch must not have widened the 405 default for other verbs.
      const added = await call("POST", "/api/tasks", { url: SLOW_URL, filename: "verb-check.bin" });
      const id = added.json.task.id;
      const put = await call("PUT", "/api/tasks/" + id + "/start");
      assert.equal(put.status, 405);
      const bogus = await call("POST", "/api/tasks/" + id + "/explode");
      assert.equal(bogus.status, 405);
      // Leave the queue as we found it.
      await call("POST", "/api/tasks/" + id + "/cancel");
    });
  } finally {
    await api.close().catch(() => {});
    await new Promise((r) => { try { origin.server.closeAllConnections?.(); } catch { /* none */ } origin.close().then(r); setTimeout(r, 1500); });
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  process.stdout.write("  cancel response: " + JSON.stringify(cancelBody) + NL + NL);
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("p1-cancel crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
