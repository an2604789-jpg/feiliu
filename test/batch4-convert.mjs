// Batch-4 regression: preset-only format conversion via external ffmpeg.
//
// Covers the W3 acceptance (src/convert.mjs + the kind "convert" routing in
// src/downloader.mjs):
//   (a) the preset table is fixed and self-describing: exactly
//       mp4/h265/mp3/gif, no parameter surface anywhere;
//   (b) a convert task end-to-end: queued -> routed to runConvert (NOT the
//       download path) -> ffmpeg spawned with the preset's literal args and
//       -progress pipe:1 -> percent frames parsed and marked "约" (the
//       fluent-ffmpeg lesson: the percentage is an estimate) -> artefact
//       landed via 临时名 -> rename onto the policy-resolved path -> sha256
//       recorded; the duration denominator falls back to ffmpeg's own stderr
//       banner when ffprobe cannot be derived;
//   (c) the rename policy applies to conversions like to any other task, and
//       the pre-existing file is untouched;
//   (d) the SOURCE file is never moved, deleted or modified — every arm
//       re-asserts it byte-for-byte;
//   (e) cancel kills the WHOLE ffmpeg process tree (taskkill /T semantics):
//       the hung ffmpeg AND its grandchild are gone, the temp .partial is
//       discarded, nothing is published;
//   (f) a run with no progress output invents no percentage (honest nulls);
//   (g) an ffmpeg that exits at startup fails the task with the exit code
//       and the stderr tail in the error; retry re-runs it as a conversion;
//   (h) a missing ffmpeg fails the task with the human-readable message
//       (never an empty error);
//   (i) unknown preset / missing source fail with human words, not crashes;
//   (j) real-ffmpeg smoke (only where a real ffmpeg is on PATH): every
//       preset's literal args actually convert a generated sample, and the
//       output is verified with ffprobe — a skip when ffmpeg is absent is
//       honest, not a failure.
//
// The hermetic arms never touch a real ffmpeg: config.ffmpegPath points at
// test/fixtures/fake-ffmpeg.mjs (this machine DOES have a real ffmpeg on
// PATH, so the missing-binary arm must not rely on ambient absence — it uses
// an explicit nonexistent path, which is the deterministic contract). No
// aria2c is involved; the magnet suite (test/batch4-magnet.mjs) is the
// regression for that path and is run separately.
//
// Everything runs in an isolated DOWNLOADX_HOME (temp dir), no public
// network, no user Downloads, no D:/IAM/downloadx-data, and the process
// exits clean.
//
// Usage: node test/batch4-convert.mjs

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FAKE_FFMPEG = path.join(HERE, "fixtures", "fake-ffmpeg.mjs");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** The exact deterministic body the fake ffmpeg writes in "ok" mode. */
function fakeBody() {
  const chunk = Buffer.from("downloadx fake ffmpeg payload" + String.fromCharCode(10), "utf8");
  const parts = [];
  for (let i = 0; i < 2048; i++) parts.push(chunk);
  return Buffer.concat(parts); // 30 * 2048 = 61440 bytes
}

/** A deterministic "media" source: the engine must treat it as opaque. */
function sourceBody(tag) {
  return Buffer.from("downloadx convert source " + tag + String.fromCharCode(10).repeat(64), "utf8");
}

async function waitFor(fn, { timeoutMs = 30000, everyMs = 50, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** process.kill(pid, 0) throws when the pid is gone; false while it lives. */
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** execFile as a promise (real-ffmpeg smoke arm only). */
function runTool(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); return; }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function main() {
  const suite = new Suite("batch4-convert");
  const NL = String.fromCharCode(10);
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else if (r.kind === "skip") process.stdout.write("    SKIP  " + r.text + "  - " + r.reason + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b4-convert-"));
  const sources = path.join(home, "sources");
  await fsp.mkdir(sources, { recursive: true });
  process.env.DOWNLOADX_HOME = home;

  const { PRESETS, presetFor, parseProgressLine, bannerDuration, convertOutputName } =
    await import("../src/convert.mjs");
  const { findFfmpeg } = await import("../src/merge.mjs");
  const { Config } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { Downloader } = await import("../src/downloader.mjs");
  const { ApiServer } = await import("../src/api.mjs");

  const config = new Config(path.join(home, "config.json"));
  await config.load();
  await config.set({
    categorizeByType: false,
    overwriteExisting: "rename",
    maxConcurrentDownloads: 1,
    proxy: "",
    proxyMode: "none",
    ffmpegPath: FAKE_FFMPEG,
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
  const taskById = async (id) => (await call("GET", "/api/tasks/" + id)).json.task ?? null;

  /** Downloader events, captured per task id for progress assertions. */
  const progressFrames = new Map();   // taskId -> [{...}]
  const resolvedTargets = new Map();  // taskId -> target
  downloader.on("progress", (p) => {
    if (!p || !p.taskId) return;
    if (!progressFrames.has(p.taskId)) progressFrames.set(p.taskId, []);
    progressFrames.get(p.taskId).push(p);
  });
  downloader.on("resolved", (p) => { if (p && p.taskId && p.target) resolvedTargets.set(p.taskId, p.target); });

  /** Set the fake's mode/files for one arm; returns a cleanup fn. */
  const armEnv = ({ mode = "ok", argsFile = null, pidFile = null } = {}) => {
    process.env.DOWNLOADX_FAKE_FFMPEG_MODE = mode;
    if (argsFile) process.env.DOWNLOADX_FAKE_FFMPEG_ARGSFILE = argsFile;
    else delete process.env.DOWNLOADX_FAKE_FFMPEG_ARGSFILE;
    if (pidFile) process.env.DOWNLOADX_FAKE_FFMPEG_PIDFILE = pidFile;
    else delete process.env.DOWNLOADX_FAKE_FFMPEG_PIDFILE;
    return () => {
      delete process.env.DOWNLOADX_FAKE_FFMPEG_MODE;
      delete process.env.DOWNLOADX_FAKE_FFMPEG_ARGSFILE;
      delete process.env.DOWNLOADX_FAKE_FFMPEG_PIDFILE;
    };
  };

  /** Enqueue one conversion; the url is a label (the intent rides in meta). */
  const addConvert = async (sourcePath, preset, extra = {}) => {
    const added = await call("POST", "/api/tasks", {
      url: "convert:" + sourcePath,
      kind: "convert",
      meta: { sourcePath, preset },
      ...extra,
    });
    assert.equal(added.status, 201, "add must be accepted: " + JSON.stringify(added.json));
    assert.equal(added.json.task.kind, "convert", "the task must enter the queue as kind convert");
    return added.json.task.id;
  };

  const waitComplete = async (id, timeoutMs = 60000) => waitFor(async () => {
    const t = await taskById(id);
    if (!t) return false;
    if (t.status === "error") throw new Error("task failed: " + t.error);
    return t.status === "complete" ? t : false;
  }, { timeoutMs, what: "the convert task to complete" });

  const waitError = async (id, timeoutMs = 60000) => waitFor(async () => {
    const t = await taskById(id);
    return t && t.status === "error" ? t : false;
  }, { timeoutMs, what: "the convert task to fail" });

  /** The source must still be there, byte-for-byte (checked in every arm). */
  const assertSourceIntact = async (file, original) => {
    const now = await fsp.readFile(file);
    assert.equal(now.equals(original), true, "the source file must be untouched: " + file);
  };

  try {
    // -------------------------------------------------------- preset table
    suite.group("preset table: fixed, self-describing, no parameter surface");

    await suite.test("exactly four presets, each label/ext/args, unknown names refused", async () => {
      assert.deepEqual(Object.keys(PRESETS).sort(), ["gif", "h265", "mp3", "mp4"]);
      for (const [name, p] of Object.entries(PRESETS)) {
        assert.ok(p.label && p.label.length > 0, name + " needs a human label");
        assert.match(p.ext, /^[a-z0-9]{2,4}$/, name + " needs an output extension");
        assert.ok(Array.isArray(p.args) && p.args.length > 0, name + " needs literal args");
        for (const a of p.args) assert.equal(typeof a, "string", name + " args are literals");
      }
      // The one conversion the names promise: each preset's ext matches its
      // container (H.265 rides in MP4, MP3 strips the video, GIF is GIF).
      assert.equal(PRESETS.h265.ext, "mp4");
      assert.equal(PRESETS.mp3.args.includes("-vn"), true, "mp3 must drop the video track");
      assert.equal(presetFor("mp4").label, PRESETS.mp4.label);
      assert.equal(presetFor(" no-such "), null, "unknown presets are refused, never guessed");
      assert.equal(presetFor(""), null);
      assert.equal(convertOutputName("C:/media/clip.mkv", PRESETS.mp3), "clip.mp3");
      assert.equal(convertOutputName("clip", PRESETS.gif), "clip.gif");
    });

    await suite.test("progress/banner parsing: keys honest, durations from the banner", async () => {
      assert.deepEqual(parseProgressLine("out_time_us=1500000"), { key: "out_time_us", value: "1500000" });
      assert.deepEqual(parseProgressLine("frame=38"), { key: "frame", value: "38" });
      assert.equal(parseProgressLine("garbage line"), null);
      assert.equal(parseProgressLine(""), null);
      // 00:00:06.00 -> 6 s; the first Duration in the text wins (the input's).
      assert.equal(bannerDuration("Input #0, from 'x':\n  Duration: 00:00:06.00, start: 0.000000"), 6);
      assert.equal(bannerDuration("  Duration: 01:02:03.500"), 3600 + 2 * 60 + 3.5);
      assert.equal(bannerDuration("no banner here"), null);
    });

    // ------------------------------------------- end to end with the fake
    suite.group("convert task end to end (fake ffmpeg, ok mode)");

    const SRC_OK = path.join(sources, "clip.mkv");
    const SRC_OK_BODY = sourceBody("ok");
    await fsp.writeFile(SRC_OK, SRC_OK_BODY);

    await suite.test("queued -> runConvert -> progress(约) -> 临时名->rename -> sha256", async () => {
      const argsFile = path.join(home, "args-ok.json");
      const cleanup = armEnv({ mode: "ok", argsFile });
      const id = await addConvert(SRC_OK, "mp4");

      const task = await waitComplete(id);
      assert.equal(task.kind, "convert", "the task must run (and report) as convert");
      // Output beside the source, named source-stem + preset ext.
      const target = resolvedTargets.get(id);
      assert.equal(target, path.join(sources, "clip.mp4"),
        "a conversion lands beside its source, named after the preset's ext");
      assert.equal(task.filename, "clip.mp4");

      const body = fakeBody();
      const landed = await fsp.readFile(target);
      assert.equal(landed.equals(body), true, "the landed file must be the fixture body");
      assert.equal(task.sha256, sha256(body), "recorded sha256 must match the landed bytes");
      assert.equal(task.downloadedBytes, body.length, "settled bytes are the real output size");

      // Progress: percent frames are ESTIMATES and say so; the final frame is
      // exact (the hashed, landed byte count).
      const frames = progressFrames.get(id) || [];
      assert.ok(frames.length >= 2, "several progress frames expected, got " + frames.length);
      const running = frames.filter((f) => typeof f.percent === "number" && f.percent < 100);
      assert.ok(running.length >= 1, "at least one intermediate percentage frame");
      for (const f of running) {
        assert.equal(f.approx, true, "intermediate percent frames must be marked approximate");
        assert.match(f.percentNote, /^约 \d+%$/, "percent note must read 约 N%");
      }
      const final = frames.filter((f) => f.percent === 100);
      assert.ok(final.length >= 1, "a final exact 100% frame must be emitted");

      // The delegation actually spoke ffmpeg's CLI: literal preset args,
      // -progress on stdout, -y for the temp, output = the temp name.
      const argv = JSON.parse(await fsp.readFile(argsFile, "utf8"));
      assert.ok(argv.includes("-progress") && argv.includes("pipe:1"));
      assert.ok(argv.includes("-y"));
      assert.ok(argv.includes("-i") && argv[argv.indexOf("-i") + 1] === SRC_OK);
      for (const frag of ["libx264", "veryfast", "23", "aac", "128k", "+faststart"]) {
        assert.ok(argv.includes(frag), "preset literal " + frag + " must be passed: " + JSON.stringify(argv));
      }
      assert.ok(argv.includes("-f") && argv.includes("mp4"),
        "the muxer must be named explicitly (the temp extension gives none)");
      assert.equal(argv[argv.length - 1], target + ".partial",
        "ffmpeg writes the temp name; the engine renames it onto the target");

      // The temp is gone (renamed away), nothing else was left beside the pair.
      assert.equal(fs.existsSync(target + ".partial"), false, "the temp must be renamed away");
      const leftovers = fs.readdirSync(sources).filter((n) => n.startsWith("clip") && n !== "clip.mkv" && n !== "clip.mp4");
      assert.equal(leftovers.length, 0, "no leftover artefacts: " + leftovers.join(", "));
      await assertSourceIntact(SRC_OK, SRC_OK_BODY);
      cleanup();
    });

    await suite.test("duration denominator falls back to ffmpeg's own banner (no ffprobe)", async () => {
      // Whitebox: call the engine directly so the returned meta is inspectable.
      // probeDuration cannot derive an ffprobe path from a .mjs path, so the
      // denominator must come from the banner the fake prints on stderr.
      const cleanup = armEnv({ mode: "ok" });
      const src2 = path.join(sources, "clip2.mkv");
      const src2Body = sourceBody("banner");
      await fsp.writeFile(src2, src2Body);
      const { runConvert } = await import("../src/convert.mjs");
      const controller = new AbortController();
      const frames = [];
      const out = await runConvert({
        downloader,
        task: { id: "whitebox-banner", url: "convert:" + src2, kind: "convert",
                meta: { sourcePath: src2, preset: "mp3" } },
        controller,
        progressCb: (p) => frames.push(p),
      });
      assert.equal(out.ok, true);
      assert.equal(out.target, path.join(sources, "clip2.mp3"));
      assert.equal(out.meta.preset, "mp3");
      assert.equal(out.meta.presetLabel, PRESETS.mp3.label);
      assert.equal(out.meta.engine, "ffmpeg");
      assert.equal(out.meta.sourcePath, src2);
      assert.equal(out.meta.sourceBytes, src2Body.length);
      assert.equal(out.meta.durationSec, 6, "6 s from the banner");
      assert.equal(out.meta.durationSource, "banner", "ffprobe is not derivable from a .mjs path");
      assert.equal(out.meta.approx, true);
      assert.equal((await fsp.readFile(out.target)).equals(fakeBody()), true);
      assert.ok(frames.some((f) => f.percent === 25 && f.approx === true), "25% of 6 s parsed from the block");
      await assertSourceIntact(src2, src2Body);
      cleanup();
    });

    await suite.test("rename policy applies: a taken name lands beside, user file untouched", async () => {
      const src = path.join(sources, "dup.mkv");
      const srcBody = sourceBody("dup");
      await fsp.writeFile(src, srcBody);
      // The output "dup.mp4" already exists: the conversion must not touch it.
      const taken = path.join(sources, "dup.mp4");
      const sentinel = Buffer.from("pre-existing user file, must not be touched");
      await fsp.writeFile(taken, sentinel);
      const cleanup = armEnv({ mode: "ok" });
      const id = await addConvert(src, "mp4");
      const task = await waitComplete(id);
      const target = resolvedTargets.get(id);
      assert.equal(target, path.join(sources, "dup (2).mp4"),
        "the rename policy must pick the (2) spelling");
      assert.equal(task.filename, "dup (2).mp4");
      assert.equal((await fsp.readFile(target)).equals(fakeBody()), true, "the renamed artefact holds the bytes");
      assert.equal((await fsp.readFile(taken)).equals(sentinel), true, "user's file untouched");
      await assertSourceIntact(src, srcBody);
      cleanup();
    });

    await suite.test("output === source is refused before any spawn (overwrite policy too)", async () => {
      // sample.mp4 converted with the mp4 preset would name itself; only the
      // rename policy would save it, so the identity guard must fire first.
      const src = path.join(sources, "self.mp4");
      const srcBody = sourceBody("self");
      await fsp.writeFile(src, srcBody);
      const prevPolicy = config.get("overwriteExisting");
      await config.set({ overwriteExisting: "overwrite" });
      const cleanup = armEnv({ mode: "ok" });
      try {
        const id = await addConvert(src, "mp4");
        const task = await waitError(id);
        assert.match(task.error, /同一个文件/, "the same-file guard must explain itself");
        await assertSourceIntact(src, srcBody);
      } finally {
        await config.set({ overwriteExisting: prevPolicy });
        cleanup();
      }
    });

    // ------------------------------------------------------------- cancel
    suite.group("cancel kills the whole ffmpeg tree");

    await suite.test("hung ffmpeg + grandchild die, temp discarded, source intact", async () => {
      const src = path.join(sources, "hang.mkv");
      const srcBody = sourceBody("hang");
      await fsp.writeFile(src, srcBody);
      const pidFile = path.join(home, "hang-pids.json");
      const cleanup = armEnv({ mode: "hang", pidFile });
      const id = await addConvert(src, "h265");

      const target = await waitFor(() => resolvedTargets.get(id),
        { what: "the convert target to be resolved" });
      const pids = await waitFor(async () => {
        try { return JSON.parse(await fsp.readFile(pidFile, "utf8")); } catch { return false; }
      }, { what: "the fake to record its pids" });
      assert.ok(pidAlive(pids.pid), "the fake ffmpeg must be alive before the cancel");
      assert.ok(pidAlive(pids.childPid), "the grandchild must be alive before the cancel");
      // The hung fake wrote a half output: the cancel has real work to do.
      await waitFor(() => fs.existsSync(target + ".partial"),
        { what: "the half-written temp to appear" });

      const r = await call("POST", "/api/tasks/" + id + "/cancel");
      assert.equal(r.status, 200, "expected 200, got " + r.status + " " + JSON.stringify(r.json));
      assert.equal(r.json.ok, true);
      assert.equal(r.json.kind, "convert", "cancel must report the kind the transfer ran as");
      assert.ok(r.json.discarded.includes(target + ".partial"),
        "the temp .partial must be reported discarded: " + JSON.stringify(r.json.discarded));

      // The point of the tree kill: BOTH pids gone.
      await waitFor(() => !pidAlive(pids.pid), { timeoutMs: 15000, what: "the fake ffmpeg to be killed" });
      await waitFor(() => !pidAlive(pids.childPid),
        { timeoutMs: 15000, what: "the grandchild to be killed (tree, not pid-only)" });

      assert.equal(fs.existsSync(target), false, "a cancelled conversion must not publish a file");
      assert.equal(fs.existsSync(target + ".partial"), false, "the temp must be discarded");
      assert.equal((await call("GET", "/api/tasks/" + id)).status, 404, "task leaves the queue");
      await assertSourceIntact(src, srcBody);
      cleanup();
    });

    await suite.test("pause keeps the temp (it is the transfer's state), resume restarts cleanly", async () => {
      const src = path.join(sources, "pause.mkv");
      const srcBody = sourceBody("pause");
      await fsp.writeFile(src, srcBody);
      const cleanup = armEnv({ mode: "hang" });
      const id = await addConvert(src, "mp4");
      const target = await waitFor(() => resolvedTargets.get(id),
        { what: "the convert target to be resolved" });
      await waitFor(() => fs.existsSync(target + ".partial"), { what: "the temp to appear" });

      assert.equal((await call("POST", "/api/tasks/" + id + "/pause")).status, 200);
      const paused = await waitFor(async () => {
        const t = await taskById(id);
        return t && t.status === "paused" ? t : false;
      }, { what: "the task to report paused" });
      assert.equal(paused.status, "paused");
      // Pause semantics match the other strategies: intermediate state stays.
      assert.equal(fs.existsSync(target + ".partial"), true, "pause keeps the intermediate state");
      assert.equal(fs.existsSync(target), false, "nothing is published by a pause");
      await assertSourceIntact(src, srcBody);

      // A conversion cannot resume mid-encode (no journal to continue from);
      // resume RESTARTS it — under the SAME name (the convert journal beside
      // the temp is what proves the leftover is this task's own).
      cleanup();
      const cleanup2 = armEnv({ mode: "ok" });
      assert.equal((await call("POST", "/api/tasks/" + id + "/resume")).status, 200);
      const task = await waitComplete(id);
      assert.equal(task.status, "complete");
      assert.equal(task.filename, "pause.mp4", "resume keeps the name the task started under");
      assert.equal((await fsp.readFile(target)).equals(fakeBody()), true);
      assert.equal(fs.existsSync(target + ".partial"), false);
      assert.equal(fs.existsSync(target + ".downloadx"), false, "success cleans its journal family");
      assert.equal(fs.existsSync(path.join(sources, "pause (2).mp4")), false,
        "no renamed twin may be left beside the output");
      await assertSourceIntact(src, srcBody);
      cleanup2();
    });

    // -------------------------------------------- honest progress / failures
    suite.group("no progress output, startup failure, missing engine");

    await suite.test("no progress blocks: no percentage is invented, task still completes", async () => {
      const src = path.join(sources, "noprog.mkv");
      const srcBody = sourceBody("noprog");
      await fsp.writeFile(src, srcBody);
      const cleanup = armEnv({ mode: "no-progress" });
      const id = await addConvert(src, "mp4");
      const task = await waitComplete(id);

      // Only the engine's own FINAL frame exists; no estimate was fabricated.
      const frames = progressFrames.get(id) || [];
      const estimated = frames.filter((f) => f.approx === true || f.percentNote);
      assert.equal(estimated.length, 0, "without a denominator no percent frame may be invented");
      assert.ok(frames.some((f) => f.percent === 100), "the final exact frame is still emitted");
      assert.equal((await fsp.readFile(resolvedTargets.get(id))).equals(fakeBody()), true);
      assert.equal(task.downloadedBytes, fakeBody().length);
      await assertSourceIntact(src, srcBody);
      cleanup();
    });

    await suite.test("ffmpeg exits at startup: exit code + stderr tail in the error; retry re-runs", async () => {
      const src = path.join(sources, "instant.mkv");
      const srcBody = sourceBody("instant");
      await fsp.writeFile(src, srcBody);
      const cleanup = armEnv({ mode: "instant-exit" });
      const id = await addConvert(src, "mp4");
      const task = await waitError(id);
      assert.ok(task.error && task.error.length > 0, "the error must not be empty");
      assert.match(task.error, /ffmpeg 转换失败/);
      assert.match(task.error, /退出码 3/);
      assert.match(task.error, /simulated startup failure/, "the stderr tail must be carried into the error");
      const target = resolvedTargets.get(id);
      assert.equal(fs.existsSync(target), false, "nothing may be published");
      assert.equal(fs.existsSync(target + ".partial"), false, "a failed temp has no resume value and is removed");
      await assertSourceIntact(src, srcBody);

      // Retry semantics: the same lifecycle as a download — the task re-runs
      // (as a conversion, still failing while the engine is broken).
      assert.equal((await call("POST", "/api/tasks/" + id + "/retry")).status, 200);
      const again = await waitError(id);
      assert.equal(again.kind, "convert", "a retried convert stays a convert");
      assert.match(again.error, /退出码 3/);
      await assertSourceIntact(src, srcBody);
      cleanup();
    });

    await suite.test("missing ffmpeg fails with install guidance, immediately", async () => {
      const src = path.join(sources, "missing.mkv");
      const srcBody = sourceBody("missing");
      await fsp.writeFile(src, srcBody);
      const cleanup = armEnv({ mode: "ok" });
      // An explicit nonexistent path is the deterministic missing-engine
      // contract (this machine has a real ffmpeg on PATH, so ambient absence
      // cannot be assumed here).
      const missingPath = path.join(home, "no-such-dir", "ffmpeg.exe");
      const prev = config.get("ffmpegPath");
      await config.set({ ffmpegPath: missingPath });
      try {
        const id = await addConvert(src, "mp4");
        const task = await waitError(id);
        assert.ok(task.error && task.error.length > 0, "the error must not be empty");
        assert.match(task.error, /格式转换需要 ffmpeg 支持/);
        assert.match(task.error, /ffmpeg\.org/);
        assert.match(task.error, /指定 ffmpeg\.exe 路径/);
        // The engine check happens BEFORE any target is resolved or written:
        // no resolved event, nothing published beside the source.
        assert.equal(resolvedTargets.has(id), false, "a missing engine resolves no output");
        const wouldBe = path.join(sources, "missing.mp4");
        assert.equal(fs.existsSync(wouldBe), false, "nothing may be published");
        assert.equal(fs.existsSync(wouldBe + ".partial"), false, "no temp either");
        await assertSourceIntact(src, srcBody);
      } finally {
        await config.set({ ffmpegPath: prev });
        cleanup();
      }
    });

    await suite.test("unknown preset / missing source: human words, not crashes", async () => {
      const src = path.join(sources, "valid.mkv");
      const srcBody = sourceBody("valid");
      await fsp.writeFile(src, srcBody);
      const cleanup = armEnv({ mode: "ok" });

      const badPreset = await addConvert(src, "avi-1080p-60fps");
      const e1 = await waitError(badPreset);
      assert.match(e1.error, /未知转换预设/);
      assert.match(e1.error, /mp4\(/, "the message must list the available presets");

      const badSource = await addConvert(path.join(sources, "ghost.mkv"), "mp4");
      const e2 = await waitError(badSource);
      assert.match(e2.error, /源文件不存在/);

      await assertSourceIntact(src, srcBody);
      cleanup();
    });

    // ------------------------------------------------ real ffmpeg smoke
    suite.group("real ffmpeg smoke: every preset's literal args convert");

    const realFfmpeg = await findFfmpeg();
    // Resolve the ABSOLUTE engine path ourselves: merge.mjs's ambient
    // findFfmpeg() caches the bare command string "ffmpeg", which does not
    // survive the explicit-path access check (and derives no ffprobe) — an
    // absolute path is what exercises the real ffprobe denominator.
    const realAbs = (() => {
      const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
      for (const dir of (process.env.PATH || "").split(path.delimiter)) {
        if (!dir) continue;
        const c = path.join(dir, exe);
        if (fs.existsSync(c)) return c;
      }
      return null;
    })();
    if (!realFfmpeg || !realAbs) {
      suite.skip("real-ffmpeg presets",
        "no absolute ffmpeg on PATH (ambient=" + Boolean(realFfmpeg) + "); hermetic arms above still cover the engine");
    } else {
      await suite.test("all four presets convert a generated sample, ffprobe verifies", async () => {
        const ffprobeExe = realAbs.replace(/ffmpeg(\.exe)?$/i, (m) =>
          (m.toLowerCase().endsWith(".exe") ? "ffprobe.exe" : "ffprobe"));

        // A 2 s sample with video AND audio, named .mkv so converting to the
        // mp4 presets never names the source itself.
        const sample = path.join(sources, "sample.mkv");
        const genArgs = [
          "-hide_banner", "-loglevel", "error", "-y",
          "-f", "lavfi", "-i", "testsrc2=duration=2:size=160x120:rate=10",
          "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
          "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-shortest", sample,
        ];
        await runTool(realAbs, genArgs, 60000);
        const sampleBody = await fsp.readFile(sample);

        const prev = config.get("ffmpegPath");
        await config.set({ ffmpegPath: realAbs });
        const cleanup = armEnv({ mode: "ok" }); // irrelevant to the real binary
        try {
          // Whitebox: with an absolute engine path the denominator comes from
          // real ffprobe (the banner was not needed).
          const { runConvert } = await import("../src/convert.mjs");
          const wb = await runConvert({
            downloader,
            task: { id: "whitebox-ffprobe", url: "convert:" + sample, kind: "convert",
                    meta: { sourcePath: sample, preset: "mp3" } },
            controller: new AbortController(),
            progressCb: () => {},
          });
          assert.equal(wb.ok, true);
          assert.equal(wb.meta.durationSource, "ffprobe",
            "an absolute engine path must yield the ffprobe denominator");
          assert.ok(wb.meta.durationSec >= 1.4 && wb.meta.durationSec <= 2.6,
            "ffprobe duration must be ~2 s, got " + wb.meta.durationSec);
          await fsp.rm(wb.target, { force: true });   // not part of the naming sweep below

          const expectCodec = { mp4: "h264", h265: "hevc", mp3: "mp3", gif: "gif" };
          const expectName = {
            mp4: "sample.mp4",
            // The second mp4-ext preset collides with the first output and the
            // rename policy applies, exactly like any other task.
            h265: "sample (2).mp4",
            mp3: "sample.mp3",
            gif: "sample.gif",
          };
          for (const name of Object.keys(PRESETS)) {
            const id = await addConvert(sample, name);
            const task = await waitComplete(id, 120000);
            assert.equal(task.kind, "convert");
            const target = resolvedTargets.get(id);
            assert.equal(target, path.join(sources, expectName[name]),
              name + " lands under its preset's name/policy");

            const outStat = await fsp.stat(target);
            assert.ok(outStat.size > 0, name + " output must be non-empty");
            // ffprobe is the honest judge: the preset's codec is really in
            // the file, and the duration survived the conversion.
            const probe = await runTool(ffprobeExe, [
              "-v", "error", "-select_streams", "v:0",
              "-show_entries", "stream=codec_name",
              "-of", "default=noprint_wrappers=1:nokey=1", target,
            ], 30000).catch(() => ({ stdout: "" }));
            let codec = probe.stdout.split(/\r?\n/)[0] || "";
            if (name === "mp3") {
              const ap = await runTool(ffprobeExe, [
                "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=codec_name",
                "-of", "default=noprint_wrappers=1:nokey=1", target,
              ], 30000);
              codec = ap.stdout.split(/\r?\n/)[0] || "";
            }
            assert.equal(codec, expectCodec[name],
              name + " must encode with " + expectCodec[name] + ", got " + JSON.stringify(codec));
            const dur = await runTool(ffprobeExe, [
              "-v", "error", "-show_entries", "format=duration",
              "-of", "default=noprint_wrappers=1:nokey=1", target,
            ], 30000);
            const seconds = Number(dur.stdout.trim());
            assert.ok(Number.isFinite(seconds) && seconds >= 1.4 && seconds <= 2.6,
              name + " duration must be ~2 s, got " + seconds);

            // The real run parses real -progress blocks: estimates only.
            const frames = progressFrames.get(id) || [];
            for (const f of frames) {
              if (typeof f.percent === "number" && f.percent < 100) {
                assert.equal(f.approx, true, "real progress must still be marked 约");
              }
            }
            assert.ok(frames.some((f) => f.percent === 100), "final exact frame present for " + name);
          }
          await assertSourceIntact(sample, sampleBody);
        } finally {
          await config.set({ ffmpegPath: prev });
          cleanup();
        }
      });
    }
  } finally {
    await api.close().catch(() => {});
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch4-convert crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
