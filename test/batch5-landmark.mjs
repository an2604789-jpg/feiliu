// Batch-5 W1 regression (批-5 / P-6 + P-7): the two landmark contracts the
// Linux field report broke.
//
// P-6 显式 dir 权威落点:
//   (a) resolveDirectory units — an explicit dir is returned verbatim (no
//       category layer), categorisation only applies to the defaultDir path;
//   (b) engine level — HTTP and HLS downloads with an explicit dir+filename
//       land exactly there even with categorizeByType on (the feiliu case:
//       "dir/archive/…" hijack), and category is still recorded on the task;
//   (c) 未指定 dir 时分类仍生效 — no dir means defaultDir + category folder;
//   (d) API level — POST /api/tasks with dir+filename publishes exactly
//       dir/filename and nothing else, while a dir-less add still categorises;
//   (e) GUI pure functions — submitDirFor (批-5 反向联动) computes the chosen
//       category INTO the final dir instead of stripping it, and whatever it
//       returns is accepted verbatim by the engine's resolveDirectory (the
//       no-double-nesting invariant of the new world); the legacy stripper
//       categorySubmitDir stays pinned exactly as test/batch1-gui.mjs
//       (批-1 门禁, outside this batch's editable set) asserts it;
//       structural sentinels: both submit paths call submitDirFor, no live
//       callsite of categorySubmitDir remains, and the settings switch copy
//       explains the new "未指定保存目录时的默认行为" semantics.
//
// P-7 HLS/DASH 进度字节口径:
//   (f) every progress event from runHls/runDash reports totalBytes null +
//       lengthKnown false + percent null, bytesWritten as cumulative bytes
//       actually written (multiples of the fragment size, monotonic), and the
//       segment counters separately as segmentsDone/segmentsTotal — the old
//       code stuffed segments.length into totalBytes (observed "64" = segment
//       count rendered as bytes);
//   (g) the separate-audio HLS phase and the DASH audio track keep
//       bytesWritten monotonic ACROSS phases (cumulative), never restarting;
//   (h) the result still reports the real byte size, so the API records
//       real bytes at completion (GUI then shows the true size).
//
// Everything runs against local origins and an isolated DOWNLOADX_HOME temp
// dir: no public network, no user Downloads, no %APPDATA%\downloadx, and
// definitely no D:/IAM/downloadx-data. The process exits clean.
//
// Usage: node test/batch5-landmark.mjs

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";
import { startOrigin } from "./origin.mjs";
import { startHlsOrigin, startDashOrigin } from "./media-e2e.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NL = String.fromCharCode(10);

/** Poll until fn() is truthy, or fail with the caller's message. */
async function waitFor(fn, { timeoutMs = 30000, everyMs = 50, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Every file under `dir`, relative, forward-slashed (for "nothing else was created"). */
async function walkFiles(dir, prefix = "") {
  const out = [];
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return out; }
  for (const n of names) {
    const rel = prefix ? prefix + "/" + n : n;
    const st = await fsp.stat(path.join(dir, n));
    if (st.isDirectory()) out.push(...(await walkFiles(path.join(dir, n), rel)));
    else out.push(rel);
  }
  return out.sort();
}

async function main() {
  const suite = new Suite("batch5-landmark");
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  // Isolated data root FIRST: src modules resolve paths lazily through
  // dataRoot(), but the discipline is to have DOWNLOADX_HOME in place before
  // any of them is imported (same pattern as test/p1-cancel.mjs).
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-batch5-"));
  process.env.DOWNLOADX_HOME = home;

  const origin = await startOrigin();
  const { resolveDirectory, categorize } = await import("../src/categories.mjs");
  const { DEFAULT_CONFIG, Config } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { Downloader } = await import("../src/downloader.mjs");
  const { ApiServer } = await import("../src/api.mjs");

  const CAT_ON = { defaultDir: "D:/dl", categorizeByType: true, categories: DEFAULT_CONFIG.categories };
  const CAT_OFF = { defaultDir: "D:/dl", categorizeByType: false, categories: DEFAULT_CONFIG.categories };

  /** A downloader + config + queue wired like media-e2e's freshDownloader. */
  const freshDownloader = async (name, patch = {}) => {
    const cfg = new Config(path.join(home, name + ".config.json"));
    await cfg.load();
    await cfg.set({
      defaultDir: path.join(home, name, "dl"),
      categorizeByType: true,
      maxConnections: 4,
      overwriteExisting: "overwrite",
      maxRetries: 2,
      retryBaseMs: 50,
      speedLimit: 0,
      insecure: false,
      ...patch,
    });
    const queue = new QueueManager({ config: cfg });
    await queue.load();
    return { cfg, queue, downloader: new Downloader({ config: cfg, queue }) };
  };

  const httpTask = (id, url, patch = {}) => ({
    id, url, kind: "http", headers: {}, connections: 2, meta: {}, ...patch,
  });

  // Declared at main scope so the finally below can always close it: a const
  // inside the try block would be out of scope there, and a listening server
  // nobody closes keeps the process alive forever (exit code never delivered).
  let api = null;

  try {
    // ================================================================ P-6 units
    suite.group("P-6 resolveDirectory：显式 dir 即权威落点");

    await suite.test("显式 dir 原样返回，不追加分类（category 给了也不追加）", () => {
      assert.equal(resolveDirectory({ filename: "movie.ts", dir: "E:/exact", category: "video", config: CAT_ON }),
        "E:/exact", "explicit dir must be returned verbatim");
      assert.equal(resolveDirectory({ filename: "pack.zip", dir: String.raw`E:\exact`, config: CAT_ON }),
        String.raw`E:\exact`, "no category, still verbatim");
      assert.equal(resolveDirectory({ filename: "movie.ts", dir: "E:/exact", category: "archive", config: CAT_OFF }),
        "E:/exact", "toggle off changes nothing for an explicit dir");
    });

    await suite.test("未指定 dir（走 defaultDir）时分类仍生效", () => {
      assert.equal(resolveDirectory({ filename: "pack.zip", config: CAT_ON }),
        path.join("D:/dl", "archive"), "extension-derived category under defaultDir");
      assert.equal(resolveDirectory({ filename: "pack.zip", category: "video", config: CAT_ON }),
        path.join("D:/dl", "video"), "explicit category wins over the extension");
      assert.equal(resolveDirectory({ filename: "pack.zip", config: CAT_OFF }),
        "D:/dl", "toggle off → flat defaultDir");
      assert.equal(resolveDirectory({ filename: "pack.zip", dir: "", config: CAT_ON }),
        path.join("D:/dl", "archive"), "empty-string dir counts as unspecified");
      assert.equal(categorize("pack.zip", DEFAULT_CONFIG.categories), "archive",
        "the extension table must still classify .zip as archive");
    });

    // ============================================================ P-6 GUI pure
    suite.group("P-6 GUI 纯函数：submitDirFor 反向联动（从交付文件原样提取）");

    const html = fs.readFileSync(path.join(ROOT, "gui", "index.html"), "utf8");
    const regionMatch = /\/\* ==== GUI-PURE-START[\s\S]*?GUI-PURE-END ==== \*\//.exec(html);
    assert.ok(regionMatch, "gui/index.html must contain the GUI-PURE region");
    const pure = new Function(
      regionMatch[0] + NL +
      "return { esc, normPath, joinDir, linkedDirFor, categorySubmitDir, submitDirFor, pickCategory };"
    )();

    await suite.test("submitDirFor：选中分类直接算进最终 dir，不再剥掉", () => {
      // 目录留空 + 手选分类 → 前端补齐 defaultDir/<分类>（不依赖 daemon 拼接）
      assert.equal(pure.submitDirFor("", "video", "D:/dl"), "D:/dl/video");
      assert.equal(pure.submitDirFor("   ", "video", "D:/dl"), "D:/dl/video", "空白目录视为空");
      // 联动出来的 defaultDir/<分类> 原样提交（旧语义会剥回 D:/dl —— 反向）
      assert.equal(pure.submitDirFor("D:/dl/video", "video", "D:/dl"), "D:/dl/video");
      assert.equal(pure.submitDirFor(String.raw`D:/dl\video`, "video", "D:/dl"), String.raw`D:/dl\video`);
      // 用户手输的路径 = 权威落点，原样发
      assert.equal(pure.submitDirFor("D:/custom", "video", "D:/dl"), "D:/custom");
      assert.equal(pure.submitDirFor("D:\\", "video", "D:/dl"), "D:\\", "盘根路径不得被规范化破坏");
      // 未选分类：展示什么发什么；空则不发（交给引擎默认行为）
      assert.equal(pure.submitDirFor("D:/dl", "", "D:/dl"), "D:/dl");
      assert.equal(pure.submitDirFor("", "", "D:/dl"), "");
    });

    await suite.test("submitDirFor 的结果经引擎 resolveDirectory 一字不差（不双重嵌套）", () => {
      const cases = [
        ["", "video", "D:/dl"], ["D:/dl/video", "video", "D:/dl"],
        ["D:/custom", "video", "D:/dl"], ["D:/dl", "", "D:/dl"],
      ];
      for (const [shown, key, def] of cases) {
        const sent = pure.submitDirFor(shown, key, def);
        if (!sent) continue;
        assert.equal(resolveDirectory({ filename: "movie.ts", dir: sent, category: key, config: CAT_ON }),
          sent, "engine must not append a category to what the GUI sends: " + sent);
      }
    });

    await suite.test("旧剥离函数 categorySubmitDir 原样保留（batch1-gui 门禁钉住的契约）", () => {
      // test/batch1-gui.mjs（批-1 门禁，不在批-5 可改清单内）逐字断言这份旧行为；
      // 这里钉住“它没被改动”，门禁才不会红。活跃链路已改用 submitDirFor。
      assert.equal(typeof pure.categorySubmitDir, "function");
      assert.equal(pure.categorySubmitDir("D:/dl/video", "video", true, "D:/dl"), "D:/dl");
      assert.equal(pure.categorySubmitDir("D:/custom", "video", true, "D:/dl"), "D:/custom");
      assert.equal(pure.categorySubmitDir("D:/dl", "", true, "D:/dl"), "D:/dl");
    });

    await suite.test("结构哨兵：两条提交链路都走 submitDirFor，旧函数无存活调用点", () => {
      const calls = html.split("submitDirFor(").length - 1;
      assert.ok(calls >= 3, "submitDirFor must be defined AND called by both submit paths, found " + calls + " occurrences");
      const legacyCalls = html.split("categorySubmitDir(").length - 1;
      assert.equal(legacyCalls, 1, "categorySubmitDir must exist only as its definition (no live callsite), found " + legacyCalls);
      assert.ok(html.includes("未指定保存目录时的默认行为"),
        "settings switch copy must explain the new categorizeByType semantics");
      assert.ok(/未指定目录|未指定保存目录/.test(html) && html.includes("原样落盘"),
        "the copy must say explicit dirs land verbatim");
    });

    // ========================================================= P-6 engine level
    suite.group("P-6 引擎实测：HTTP/HLS 显式 dir+filename 精确落点");

    await suite.test("HTTP：显式 dir + pack.zip → 恰好落 dir/pack.zip，无 archive/ 层，category 仍记录", async () => {
      const { downloader } = await freshDownloader("p6-http", { categorizeByType: true });
      const exact = path.join(home, "p6-http", "exact");
      const result = await downloader.run(httpTask("p6-http", origin.origin + "/range/65536", {
        filename: "pack.zip", dir: exact,
      }));
      assert.equal(result.target, path.join(exact, "pack.zip"), "must land exactly at dir/filename");
      assert.equal(result.category, "archive", "category is still recorded (bookkeeping)");
      const files = await walkFiles(exact);
      assert.deepEqual(files, ["pack.zip"], "no category folder may be created: " + JSON.stringify(files));
      assert.equal((await fsp.stat(result.target)).size, 65536);
    });

    await suite.test("HLS（feiliu 场景）：显式 dir + movie.ts → 恰好落 dir/movie.ts", async () => {
      const hls = await startHlsOrigin({ segments: 3, segBytes: 16 * 1024 });
      try {
        const { downloader } = await freshDownloader("p6-hls", { categorizeByType: true });
        const exact = path.join(home, "p6-hls", "exact");
        const resolved = [];
        downloader.on("resolved", (p) => { if (p.taskId === "p6-hls") resolved.push(p); });
        const result = await downloader.run({
          id: "p6-hls", url: hls.url, kind: "hls", filename: "movie.ts", dir: exact,
          headers: {}, connections: 2, meta: {},
        });
        assert.equal(result.target, path.join(exact, "movie.ts"),
          ".ts is in the video category — the old code hijacked this into dir/video/");
        assert.equal(result.category, "video");
        assert.ok(resolved.length >= 1 && resolved[0].target === path.join(exact, "movie.ts"),
          "the resolved event must announce the exact path too");
        const files = await walkFiles(exact);
        assert.deepEqual(files, ["movie.ts"], "no video/ folder: " + JSON.stringify(files));
        assert.equal(result.bytes, 3 * 16 * 1024, "real stitched bytes");
      } finally { await hls.close(); }
    });

    await suite.test("未指定 dir：分类仍生效（defaultDir/archive/pack.zip + 显式 category 覆写）", async () => {
      const { cfg, downloader } = await freshDownloader("p6-nodir", { categorizeByType: true });
      const defaultDir = cfg.get("defaultDir");
      const a = await downloader.run(httpTask("p6-nodir-a", origin.origin + "/range/32768", { filename: "pack.zip" }));
      assert.equal(a.target, path.join(defaultDir, "archive", "pack.zip"),
        "a dir-less add must still be categorised under defaultDir");
      const b = await downloader.run(httpTask("p6-nodir-b", origin.origin + "/range/16384", { filename: "pack.zip", category: "video" }));
      assert.equal(b.target, path.join(defaultDir, "video", "pack.zip"),
        "an explicit category still steers the defaultDir placement");
      const flat = await freshDownloader("p6-nodir-flat", { categorizeByType: false });
      const c = await flat.downloader.run(httpTask("p6-nodir-c", origin.origin + "/range/8192", { filename: "pack.zip" }));
      assert.equal(c.target, path.join(flat.cfg.get("defaultDir"), "pack.zip"),
        "categorizeByType off → flat defaultDir (unchanged behaviour)");
    });

    // ============================================================ P-6 API level
    suite.group("P-6 API 契约：POST /api/tasks 的 dir+filename 精确落点");

    const apiCfg = new Config(path.join(home, "api.config.json"));
    await apiCfg.load();
    const dlDir = path.join(home, "api-dl");
    await apiCfg.set({
      defaultDir: dlDir, categorizeByType: true, overwriteExisting: "rename",
      maxConnections: 2, proxy: "", proxyMode: "none",
    });
    const apiQueue = new QueueManager({ config: apiCfg });
    await apiQueue.load();
    const apiDownloader = new Downloader({ config: apiCfg, queue: apiQueue });
    api = new ApiServer({
      queue: apiQueue, config: apiCfg, downloader: apiDownloader,
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

    await suite.test("API 指定 dir+filename → 文件落在 dir/filename，目录里没有分类层", async () => {
      const exact = path.join(home, "api-exact");
      const added = await call("POST", "/api/tasks", {
        url: origin.origin + "/range/65536", filename: "pack.zip", dir: exact,
      });
      assert.equal(added.status, 201, "added: " + JSON.stringify(added.json));
      const id = added.json.task.id;
      const done = await waitFor(async () => {
        const t = await taskById(id);
        if (t && t.status === "error") throw new Error("task failed: " + t.error);
        return t && t.status === "complete" ? t : false;
      }, { what: "the explicit-dir task to complete" });
      assert.equal(path.resolve(done.dir), path.resolve(exact), "task.dir must stay the explicit dir");
      assert.equal(done.filename, "pack.zip");
      assert.equal(done.category, "archive", "the task record still carries the category");
      assert.equal(done.totalBytes, 65536, "real byte size recorded at completion");
      assert.equal(done.downloadedBytes, 65536);
      const files = await walkFiles(exact);
      assert.deepEqual(files, ["pack.zip"], "exactly one file, no category layer: " + JSON.stringify(files));
    });

    await suite.test("API 未指定 dir → defaultDir/archive 归类不变", async () => {
      const added = await call("POST", "/api/tasks", {
        url: origin.origin + "/range/32768", filename: "pack2.zip",
      });
      assert.equal(added.status, 201);
      const id = added.json.task.id;
      const done = await waitFor(async () => {
        const t = await taskById(id);
        if (t && t.status === "error") throw new Error("task failed: " + t.error);
        return t && t.status === "complete" ? t : false;
      }, { what: "the dir-less task to complete" });
      const expected = path.join(dlDir, "archive", "pack2.zip");
      assert.equal(path.resolve(done.dir), path.resolve(path.dirname(expected)), "dir must be defaultDir/archive");
      assert.equal(fs.existsSync(expected), true, "the categorised file must exist at " + expected);
    });

    // ================================================================== P-7
    suite.group("P-7 HLS/DASH 进度：字节口径 + segmentsDone/segmentsTotal");

    const collectProgress = (downloader, id) => {
      const events = [];
      downloader.on("progress", (p) => { if (p.taskId === id) events.push(p); });
      return events;
    };
    const assertByteSemantics = (events, label) => {
      assert.ok(events.length > 0, label + ": progress events must exist");
      for (const e of events) {
        assert.equal(e.totalBytes, null, label + ": totalBytes must be null (unknown length)");
        assert.equal(e.lengthKnown, false, label + ": lengthKnown must be false");
        assert.equal(e.percent, null, label + ": percent must be null");
        assert.ok(typeof e.bytesWritten === "number" && e.bytesWritten > 0,
          label + ": bytesWritten must be a positive byte count");
        assert.ok(Number.isInteger(e.segmentsDone) && Number.isInteger(e.segmentsTotal) &&
          e.segmentsDone >= 1 && e.segmentsDone <= e.segmentsTotal && e.segmentsTotal > 0,
          label + ": segment counters must be exposed and sane, got " +
          e.segmentsDone + "/" + e.segmentsTotal);
      }
      for (let i = 1; i < events.length; i++) {
        assert.ok(events[i].bytesWritten >= events[i - 1].bytesWritten,
          label + ": bytesWritten must never go backwards");
      }
    };

    await suite.test("HLS：进度事件按字节报告，分片数另列字段（不再 64=分片数当字节）", async () => {
      const SEGS = 4, SEG = 32 * 1024;
      const hls = await startHlsOrigin({ segments: SEGS, segBytes: SEG });
      try {
        const { downloader } = await freshDownloader("p7-hls", { categorizeByType: false });
        const events = collectProgress(downloader, "p7-hls");
        const result = await downloader.run({
          id: "p7-hls", url: hls.url, kind: "hls", filename: "movie.ts",
          dir: path.join(home, "p7-hls", "out"), headers: {}, connections: 2, meta: {},
        });
        assert.equal(events.length, SEGS, "one progress event per segment");
        assertByteSemantics(events, "hls");
        for (const e of events) {
          assert.equal(e.bytesWritten % SEG, 0, "byte counts must be multiples of the fragment size");
          assert.equal(e.segmentsTotal, SEGS);
        }
        assert.equal(events[events.length - 1].bytesWritten, SEGS * SEG,
          "final progress must report the full fragment byte total");
        assert.equal(events[events.length - 1].segmentsDone, SEGS);
        // 旧缺陷回归哨兵：分片数曾被塞进 totalBytes/bytesWritten。
        assert.ok(!events.some((e) => e.totalBytes === SEGS), "segment count must never appear as totalBytes");
        assert.ok(!events.some((e) => e.bytesWritten === SEGS), "segment count must never appear as bytesWritten");
        // 完成后按真实字节汇报（API 层据此把 totalBytes 记成 result.bytes）。
        assert.equal(result.bytes, SEGS * SEG, "the result reports the real stitched size");
        assert.notEqual(result.lengthKnown, false, "the result must not claim an unknown length");
      } finally { await hls.close(); }
    });

    await suite.test("HLS 独立音轨阶段：字节累计不回退，跨阶段单调", async () => {
      const SEGS = 3, SEG = 16 * 1024;
      const hls = await startHlsOrigin({ segments: SEGS, segBytes: SEG, audioGroup: true });
      try {
        // ffmpeg 指到不存在的路径：音轨照样下载（进度照发），合成确定性地失败，
        // 不依赖本机是否装了真 ffmpeg。
        const { downloader } = await freshDownloader("p7-hls-audio", {
          categorizeByType: false, ffmpegPath: path.join(home, "no-such-ffmpeg.exe"),
        });
        const events = collectProgress(downloader, "p7-hls-audio");
        const result = await downloader.run({
          id: "p7-hls-audio", url: hls.url, kind: "hls", filename: "movie.ts",
          dir: path.join(home, "p7-hls-audio", "out"), headers: {}, connections: 2, meta: {},
        });
        assert.equal(events.length, SEGS * 2, "video phase + audio phase, one event per fragment");
        assertByteSemantics(events, "hls-audio");
        const videoBytes = SEGS * SEG;
        // 视频阶段结束后，音轨阶段从已累计字节继续加（不得从 0 重来）。
        assert.equal(events[SEGS - 1].bytesWritten, videoBytes, "video phase ends at its byte total");
        for (let i = SEGS; i < events.length; i++) {
          assert.ok(events[i].bytesWritten > videoBytes,
            "audio-phase events must continue the cumulative count, got " + events[i].bytesWritten);
          assert.equal(equalsSegmentsTotal(events[i], SEGS), true, "audio phase counts its own segments");
        }
        assert.equal(events[events.length - 1].bytesWritten, videoBytes * 2,
          "audio phase must add its bytes on top of the video bytes");
        assert.ok(result.meta && (result.meta.separateTracks || result.meta.mergeNote),
          "merge must have failed as configured (proving the audio phase ran)");
        assert.equal(result.bytes, videoBytes, "the kept video artefact is the video bytes");
      } finally { await hls.close(); }
    });

    await suite.test("DASH：视频轨+音频轨进度同为字节口径，跨轨累计", async () => {
      const SEGS = 2, SEG = 32 * 1024, INIT = 4 * 1024;
      const dash = await startDashOrigin({ segments: SEGS, segBytes: SEG, audio: true, initBytes: INIT });
      try {
        const { downloader } = await freshDownloader("p7-dash", {
          categorizeByType: false, ffmpegPath: path.join(home, "no-such-ffmpeg.exe"),
        });
        const events = collectProgress(downloader, "p7-dash");
        const result = await downloader.run({
          id: "p7-dash", url: dash.url, kind: "dash", filename: "movie.mp4",
          dir: path.join(home, "p7-dash", "out"), headers: {}, connections: 2, meta: {},
        });
        assert.equal(events.length, SEGS * 2, "one event per fragment across both tracks");
        assertByteSemantics(events, "dash");
        const videoBytes = SEGS * SEG;
        assert.equal(events[SEGS - 1].bytesWritten, videoBytes, "video track ends at its byte total");
        assert.equal(events[events.length - 1].bytesWritten, videoBytes * 2,
          "the audio track's bytes accumulate on top of the video track's");
        for (const e of events) {
          assert.equal(e.bytesWritten % SEG, 0, "byte counts must be multiples of the fragment size");
          assert.equal(e.segmentsTotal, SEGS, "each track counts its own segments");
        }
        assert.ok(!events.some((e) => e.totalBytes === SEGS), "segment count must never appear as totalBytes");
        // 合成失败保留视频轨：init 4KiB + 2×32KiB 分片 = 真实产物字节。
        assert.equal(result.bytes, INIT + videoBytes, "the result reports the real kept-track size");
        assert.notEqual(result.lengthKnown, false, "the result must not claim an unknown length");
      } finally { await dash.close(); }
    });
  } finally {
    await api?.close().catch(() => {});
    await new Promise((r) => { try { origin.server.closeAllConnections?.(); } catch { /* none */ } origin.close().then(r); setTimeout(r, 1500); });
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

/** The event's segmentsTotal equals `n` (kept as a one-liner for readability above). */
function equalsSegmentsTotal(ev, n) {
  return ev.segmentsTotal === n;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch5-landmark crashed: " + ((err && err.stack) || err) + NL);
    process.exitCode = 1;
  });
