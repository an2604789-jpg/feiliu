// Batch-1 regression: the extension capture chain (P0 fixes, 2026-10-24).
//
// The defects this guards against, all observed on real sites:
//   (a) segment URLs were judged dash/hls: a .m4s fragment entered the queue
//       with kind:"dash", the downloader pulled it as an MPD manifest and died
//       at the 8 MiB body limit (two error tasks in the live queue.json);
//   (b) auto-report had no threshold: YouTube's 6636-byte UI sound
//       /s/search/audio/success.mp3 was grabbed 4 times as "<page title>.mp4";
//   (c) the enqueue filename extension was always ".mp4" (a ternary whose two
//       branches were both "mp4"), so audio/mpeg got saved as .mp4;
//   (d) the context-menu path sent `cookies: info.cookie`, a field Chrome's
//       OnClickData does not have — logged-in resources came back as login
//       pages; every enqueue path must carry buildStreamHeaders() output;
//   (e) host.mjs counted "error" as a live task status, so the extension could
//       never re-queue a failed URL, and media/add-stream defaulted kind:"hls".
//
// Three layers, no browser needed:
//   1. pure functions from extension/background.js, evaluated in a vm sandbox
//      with a chrome stub (the file exposes test hooks only when the sandbox
//      sets __DOWNLOADX_BATCH1_TEST_PROBE__);
//   2. the real media-found / QUEUE_STREAM handlers driven end to end through
//      that sandbox against a fake native-messaging port;
//   3. extension/host.mjs exercised for real as a child process against a fake
//      daemon HTTP server (framing, live-set, duplicate status, default kind,
//      header pass-through).
//
// Everything runs in throwaway DOWNLOADX_HOME temp dirs; the production data
// root (D:/IAM/downloadx-data) is never touched. The process must exit cleanly.
//
// Usage: node test/batch1-capture.mjs

import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NL = String.fromCharCode(10);

// ---------------------------------------------------------------- mini runner

let passed = 0;
let failed = 0;
const failures = [];

function group(name) {
  process.stdout.write(NL + "  " + name + NL);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write("    PASS  " + name + NL);
  } catch (err) {
    failed++;
    failures.push(name);
    process.stdout.write(
      "    FAIL  " + name + NL + "          " +
      String((err && err.message) || err).split(NL).join(NL + "          ") + NL
    );
  }
}

const COOKIE_NAME = "SESSDATA";
const COOKIE_VALUE = "s3cr3t-cookie-value"; // fake on purpose; must never be logged

/**
 * chrome API stub faithful to what background.js actually touches at load time
 * and in the media-found / QUEUE_STREAM paths.
 */
function makeChromeStub(state) {
  const portListeners = new Set();
  const port = {
    onMessage: {
      addListener: (fn) => portListeners.add(fn),
      removeListener: (fn) => portListeners.delete(fn),
    },
    onDisconnect: { addListener() {}, removeListener() {} },
    postMessage(message) {
      state.sentToHost.push(message);
      const reply = state.planReply(message);
      if (reply) {
        // ask() registers its listener before postMessage returns, so a timer
        // tick later the reply reaches exactly the pending request.
        setTimeout(() => {
          for (const fn of [...portListeners]) fn(reply);
        }, 0);
      }
    },
  };
  const onMessageHandlers = new Set();
  const tabsSent = [];
  const stub = {
    __port: port,
    __tabsSent: tabsSent,
    runtime: {
      connectNative: () => port,
      lastError: null,
      onInstalled: { addListener() {} },
      onMessage: {
        addListener: (fn) => onMessageHandlers.add(fn),
      },
    },
    contextMenus: { create() {}, onClicked: { addListener() {} } },
    action: { onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    tabs: {
      sendMessage: (tabId, msg, cb) => {
        tabsSent.push({ tabId, msg });
        if (cb) cb();
      },
      query: (q, cb) => cb && cb([]),
    },
    cookies: {
      getAll: (_opts, cb) => {
        cb([{ name: COOKIE_NAME, value: COOKIE_VALUE }]);
      },
    },
    notifications: {
      create: (_opts, cb) => cb && cb(),
    },
    webRequest: {
      onBeforeRequest: { addListener: (fn) => { state.webRequestListener = fn; } },
    },
  };
  stub.__fire = (msg, sender) =>
    new Promise((resolve) => {
      let settled = false;
      const respond = (reply) => {
        if (settled) return;
        settled = true;
        resolve(reply);
      };
      for (const fn of [...onMessageHandlers]) fn(msg, sender, respond);
      // handlers that do not keep the channel must still resolve
      setTimeout(() => respond(undefined), 50);
    });
  return stub;
}

/**
 * Evaluate the real extension/background.js inside a sandbox and return
 * { hooks, state, chrome }.
 */
async function loadBackground() {
  const code = await fsp.readFile(path.join(ROOT, "extension", "background.js"), "utf8");
  const logs = [];
  const state = {
    sentToHost: [],
    consoleOut: logs,
    planReply: () => ({ ok: true, task: { id: "t-host", filename: "stub.bin", url: "about:blank" } }),
  };
  const consoleStub = {
    log: (...a) => logs.push(a.map(String).join(" ")),
    warn: (...a) => logs.push(a.map(String).join(" ")),
    error: (...a) => logs.push(a.map(String).join(" ")),
  };
  const chrome = makeChromeStub(state);
  const sandbox = {
    chrome,
    console: consoleStub,
    setTimeout,
    clearTimeout,
    URL,
    __DOWNLOADX_BATCH1_TEST_PROBE__: true,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "extension/background.js" });
  const hooks = sandbox.__downloadxBatch1Hooks;
  assert.ok(hooks, "background.js must expose __downloadxBatch1Hooks under the test probe");
  return { hooks, state, chrome };
}

// ============================================================================
// 1. background.js pure functions
// ============================================================================

async function backgroundPureTests() {
  group("background.js inferStreamKind / segment detection (kind 收口)");

  let ctx;
  await test("background.js evaluates in the sandbox with a chrome stub", async () => {
    ctx = await loadBackground();
  });

  await test("m3u8 -> hls, mpd -> dash (query strings ignored)", async () => {
    const k = ctx.hooks.inferStreamKind;
    assert.equal(k("https://cdn.x/live/master.m3u8?token=a#frag"), "hls");
    assert.equal(k("https://cdn.x/vod/manifest.mpd"), "dash");
  });

  await test("content-type alone confirms manifests when the URL has no extension", async () => {
    const k = ctx.hooks.inferStreamKind;
    assert.equal(k("https://x/api/playlist", "application/vnd.apple.mpegurl"), "hls");
    assert.equal(k("https://x/api/manifest", "application/dash+xml"), "dash");
  });

  await test("B站-style .m4s segment URLs are NOT dash any more (the 8MiB bug)", async () => {
    const k = ctx.hooks.inferStreamKind;
    const bilibiliVideoSeg =
      "https://upos-sz-mirror08h.bilivideo.com/upgcx/AA/BB/1122/awhale30280.m4s?e=ut8&os=upos&deadline=1";
    assert.equal(k(bilibiliVideoSeg), "http", ".m4s must infer http, never dash");
    assert.equal(k(bilibiliVideoSeg, "video/mp4"), "http", "even with video/mp4 a segment stays http");
    assert.equal(k("https://x/live/seg-000042.ts"), "http");
    assert.equal(k("https://x/movie.mp4"), "http");
  });

  await test("isMediaSegmentUrl: m4s/ts/mts/m2ts yes; manifests and plain media no", async () => {
    const seg = ctx.hooks.isMediaSegmentUrl;
    assert.equal(seg("https://x/v/30280.m4s?range=0-"), true);
    assert.equal(seg("https://x/live/seg-12.ts"), true);
    assert.equal(seg("https://x/a.mts"), true);
    assert.equal(seg("https://x/b.m2ts"), true);
    assert.equal(seg("https://x/movie.mp4"), false);
    assert.equal(seg("https://x/index.m3u8"), false);
    assert.equal(seg("https://x/manifest.mpd"), false);
    assert.equal(seg("https://x/app.tsx"), false, ".tsx is not a media segment");
    assert.equal(seg("https://x/ts/segment"), false, "path segment named ts is not a fragment");
  });

  group("background.js auto-report threshold (上报门槛)");

  await test("contentTypeIsMedia: only video/* and audio/* count as media", async () => {
    const m = ctx.hooks.contentTypeIsMedia;
    assert.equal(m("video/mp4"), true);
    assert.equal(m("AUDIO/MPEG"), true);
    assert.equal(m("audio/mpeg; charset=binary"), true);
    assert.equal(m("application/vnd.apple.mpegurl"), false, "manifests are streams, not media files");
    assert.equal(m("text/html"), false);
    assert.equal(m(""), false);
  });

  await test("evaluateMediaCandidate: the 6636-byte YouTube sound is refused", async () => {
    const r = ctx.hooks.evaluateMediaCandidate({
      userInitiated: false,
      probeOk: true,
      contentType: "audio/mpeg",
      totalBytes: 6636,
    });
    assert.equal(r.report, false);
    assert.match(r.reason, /6636/);
  });

  await test("evaluateMediaCandidate: threshold is exactly 1 MiB, inclusive", async () => {
    const e = ctx.hooks.evaluateMediaCandidate;
    const min = ctx.hooks.AUTO_REPORT_MIN_BYTES;
    assert.equal(min, 1024 * 1024);
    assert.equal(e({ probeOk: true, contentType: "video/mp4", totalBytes: min - 1 }).report, false);
    assert.equal(e({ probeOk: true, contentType: "video/mp4", totalBytes: min }).report, true);
  });

  await test("evaluateMediaCandidate: non-media content-type refused, big media accepted", async () => {
    const e = ctx.hooks.evaluateMediaCandidate;
    assert.equal(e({ probeOk: true, contentType: "text/html", totalBytes: 50e6 }).report, false);
    assert.equal(e({ probeOk: true, contentType: "video/webm", totalBytes: 50 * 1024 * 1024 }).report, true);
  });

  await test("evaluateMediaCandidate: user clicks bypass the threshold, probe failure does not auto-report", async () => {
    const e = ctx.hooks.evaluateMediaCandidate;
    assert.equal(e({ userInitiated: true, probeOk: true, contentType: "audio/mpeg", totalBytes: 6636 }).report, true);
    assert.equal(e({ userInitiated: false, probeOk: false }).report, false);
    assert.equal(e({ userInitiated: true, probeOk: false }).report, true);
    // 用户主动时未知 content-type 不误伤,明确非媒体才拦
    assert.equal(e({ userInitiated: true, probeOk: true, contentType: "", totalBytes: 6636 }).report, true);
    assert.equal(e({ userInitiated: true, probeOk: true, contentType: "application/octet-stream" }).report, true);
    assert.equal(e({ userInitiated: true, probeOk: true, contentType: "text/html" }).report, false);
    assert.equal(e({ userInitiated: false, probeOk: true, contentType: "" }).report, false,
      "auto reports must require a positive video/*|audio/* answer");
  });

  await test("contentTypeBlocksStream: pages/JSON blocked, unknown binaries pass", async () => {
    const b = ctx.hooks.contentTypeBlocksStream;
    assert.equal(b("text/html; charset=utf-8"), true);
    assert.equal(b("application/json"), true);
    assert.equal(b("video/mp4"), false);
    assert.equal(b("audio/mpeg"), false);
    assert.equal(b("application/vnd.apple.mpegurl"), false);
    assert.equal(b("application/octet-stream"), false);
    assert.equal(b(""), false);
  });

  group("background.js filename extension derivation (扩展名推导)");

  await test("extForContentType maps the common families", async () => {
    const f = ctx.hooks.extForContentType;
    assert.equal(f("audio/mpeg"), ".mp3");
    assert.equal(f("video/webm"), ".webm");
    assert.equal(f("application/vnd.apple.mpegurl"), ".m3u8");
    assert.equal(f("application/dash+xml"), ".mpd");
    assert.equal(f("application/octet-stream"), "");
    assert.equal(f(""), "");
  });

  await test("streamFilename: audio/mpeg is named .mp3, not .mp4 (the success.mp3 bug)", async () => {
    const f = ctx.hooks.streamFilename;
    const title = "折1万次,会坏吗?iPhone Duo深度评测 - YouTube";
    const got = f(title, "https://www.youtube.com/s/search/audio/success.mp3", "audio/mpeg");
    assert.ok(got.endsWith(".mp3"), "expected .mp3 filename, got " + got);
    assert.ok(got.startsWith("折1万次"), "title should be kept");
    assert.equal(f(null, "https://x/a.mp4", "video/mp4"), undefined, "no title -> daemon derives the name");
    const webm = f("clip", "https://x/api/video?id=9", "video/webm");
    assert.equal(webm, "clip.webm", "no URL extension -> content-type decides");
  });

  await test("correctedFilenameForUrl only intervenes when content-type is known", async () => {
    const f = ctx.hooks.correctedFilenameForUrl;
    assert.equal(f("https://x/track.mp4", "audio/mpeg"), "track.mp3", "wrong-family extension gets corrected");
    assert.equal(f("https://x/api/1080", "video/mp4"), "1080.mp4");
    assert.equal(f("https://x/anything", "text/html"), undefined);
    assert.equal(f("https://x/clip.mp4", "video/mp4"), "clip.mp4");
  });

  group("background.js webRequest observer skips segments");

  await test("m4s never reaches the tab; a manifest still announces as hls", async () => {
    const listener = ctx.state.webRequestListener;
    assert.ok(typeof listener === "function", "webRequest observer must be registered");
    listener({ tabId: 7, method: "GET", url: "https://x/v/30280.m4s?range=0-1000" });
    assert.equal(ctx.chrome.__tabsSent.length, 0, "segments must not be announced to the tab");
    listener({ tabId: 7, method: "GET", url: "https://x/live/master.m3u8" });
    assert.equal(ctx.chrome.__tabsSent.length, 1);
    assert.equal(ctx.chrome.__tabsSent[0].msg.kind, "hls");
  });
}

// ============================================================================
// 2. background.js handlers end to end through the fake native host port
// ============================================================================

async function backgroundHandlerTests() {
  group("media-found / QUEUE_STREAM through the real handlers");

  const ctx = await loadBackground();
  const fire = (msg) =>
    ctx.chrome.__fire(msg, { tab: { url: "https://page.example/watch", title: "页面标题" } });

  await test("auto media-found of a 6636-byte UI sound: probed, then NOT enqueued", async () => {
    ctx.state.planReply = (m) =>
      m.type === "probe"
        ? { ok: true, contentType: "audio/mpeg", totalBytes: 6636, excluded: false }
        : { ok: true, task: { id: "should-not-happen" } };
    const reply = await fire({
      type: "media-found",
      url: "https://www.youtube.com/s/search/audio/success.mp3",
    });
    assert.equal(reply.ok, true);
    assert.equal(reply.queued, false, "must not queue a below-threshold auto report");
    assert.match(reply.skipped, /6636/);
    const enqueued = ctx.state.sentToHost.filter((m) => m.type !== "probe");
    assert.equal(enqueued.length, 0, "no enqueue message may reach the native host");
  });

  await test("auto media-found of real video: enqueued with headers and corrected filename", async () => {
    ctx.state.planReply = (m) =>
      m.type === "probe"
        ? { ok: true, contentType: "video/mp4", totalBytes: 60 * 1024 * 1024, excluded: false }
        : { ok: true, task: { id: "t1", filename: "clip.mp4", url: "u" } };
    const reply = await fire({ type: "media-found", url: "https://cdn.x/videos/clip.mp4?sig=1" });
    assert.equal(reply.ok, true);
    assert.equal(reply.queued, true);
    const media = ctx.state.sentToHost.find((m) => m.type === "media");
    assert.ok(media, "a media message must reach the native host");
    assert.equal(media.kind, "http");
    assert.equal(media.headers.Cookie, COOKIE_NAME + "=" + COOKIE_VALUE,
      "enqueue must carry the Cookie from buildStreamHeaders");
    assert.equal(media.filename, "clip.mp4");
    assert.equal(media.referer, "https://page.example/watch");
  });

  await test("media-found with a segment URL is refused with the floating-bar hint", async () => {
    const before = ctx.state.sentToHost.length;
    const reply = await fire({ type: "media-found", url: "https://x/v/30280.m4s?range=0-" });
    assert.equal(reply.ok, false);
    assert.equal(reply.error, ctx.hooks.SEGMENT_HINT);
    assert.match(reply.error, /这是流媒体的一个分片/);
    assert.equal(ctx.state.sentToHost.length, before, "not even a probe should be sent");
  });

  await test("QUEUE_STREAM with a segment URL is refused with the floating-bar hint", async () => {
    const before = ctx.state.sentToHost.length;
    const reply = await fire({
      type: "QUEUE_STREAM",
      payload: { url: "https://upos.example/upgcx/video/30280.m4s", pageUrl: "https://b.example/v/1", kind: "dash" },
    });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /这是流媒体的一个分片/);
    assert.equal(ctx.state.sentToHost.length, before);
  });

  await test("QUEUE_STREAM ignores a bogus kind and derives .mp3 from real content-type", async () => {
    let addStream = null;
    ctx.state.planReply = (m) => {
      if (m.type === "probe") {
        return { ok: true, contentType: "audio/mpeg", totalBytes: 6636, excluded: false };
      }
      addStream = m;
      return { ok: true, task: { id: "t2", filename: "x.mp3", url: m.url } };
    };
    const reply = await fire({
      type: "QUEUE_STREAM",
      payload: {
        url: "https://www.youtube.com/s/search/audio/success.mp3",
        pageUrl: "https://www.youtube.com/watch?v=abc",
        title: "折1万次,会坏吗?iPhone Duo深度评测 - YouTube",
        kind: "dash",
      },
    });
    assert.equal(reply.ok, true, "a user click queues even below 1 MiB");
    assert.ok(addStream, "add-stream must reach the native host");
    assert.equal(addStream.kind, "http", "provided kind must be re-derived, not trusted");
    assert.ok(addStream.filename.endsWith(".mp3"),
      "audio/mpeg must be named .mp3, got " + addStream.filename);
    assert.equal(addStream.headers.Cookie, COOKIE_NAME + "=" + COOKIE_VALUE);
  });

  await test("QUEUE_STREAM of a page URL (text/html) is refused instead of downloading HTML", async () => {
    ctx.state.planReply = (m) =>
      m.type === "probe"
        ? { ok: true, contentType: "text/html; charset=utf-8", excluded: false }
        : { ok: true, task: { id: "bad" } };
    const reply = await fire({
      type: "QUEUE_STREAM",
      payload: { url: "https://www.youtube.com/watch?v=abc", pageUrl: "https://www.youtube.com/watch?v=abc", title: "watch" },
    });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /not media/);
  });

  await test("context-menu enqueue carries buildStreamHeaders output (info.cookie is gone)", async () => {
    const code = await fsp.readFile(path.join(ROOT, "extension", "background.js"), "utf8");
    assert.equal(/cookies:\s*info\.cookie/.test(code), false,
      "the dead info.cookie field must not be sent any more");
    assert.match(code, /onClicked[\s\S]{0,600}buildStreamHeaders/,
      "the click paths must call buildStreamHeaders");
  });

  await test("no Cookie value ever reaches a log line", async () => {
    const leaked = ctx.state.consoleOut.filter((line) => line.includes(COOKIE_VALUE));
    assert.deepEqual(leaked, [], "cookie values must never be logged");
    for (const m of ctx.state.sentToHost) {
      // cookies travel inside headers to the host, which is the point; but
      // nothing else (meta, title, kind) should smuggle them.
      if (!m.headers) {
        const json = JSON.stringify(m);
        assert.equal(json.includes(COOKIE_VALUE), false, "cookie leaked outside headers: " + json.slice(0, 120));
      }
    }
  });
}

// ============================================================================
// 3. host.mjs: pure exports + the real process against a fake daemon
// ============================================================================

/** 4-byte little-endian length + UTF-8 JSON, the native messaging framing. */
function frame(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

/** Async iterator of framed messages read from a stream of Buffers. */
function framedReader() {
  const queue = [];
  const waiters = [];
  let buffer = Buffer.alloc(0);
  let done = false;
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) break;
        const len = buffer.readUInt32LE(0);
        if (buffer.length < 4 + len) break;
        const body = buffer.subarray(4, 4 + len);
        buffer = buffer.subarray(4 + len);
        const parsed = JSON.parse(body.toString("utf8"));
        const w = waiters.shift();
        if (w) w(parsed);
        else queue.push(parsed);
      }
    },
    end() { done = true; for (const w of waiters.splice(0)) w(null); },
    next(timeoutMs = 8000) {
      if (queue.length) return Promise.resolve(queue.shift());
      if (done) return Promise.resolve(null);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          resolve(new Error("timed out waiting for a framed reply from host.mjs"));
        }, timeoutMs);
        const waiter = (v) => {
          clearTimeout(timer);
          resolve(v);
        };
        waiters.push(waiter);
      });
    },
  };
}

async function hostTests() {
  const hostHome = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b1-host-"));
  process.env.DOWNLOADX_HOME = hostHome;

  group("host.mjs pure exports (live set)");

  const host = await import(pathToFileURL(path.join(ROOT, "extension", "host.mjs")).href);

  await test("LIVE_TASK_STATUSES has no error/complete", async () => {
    assert.ok(Array.isArray(host.LIVE_TASK_STATUSES));
    assert.equal(host.LIVE_TASK_STATUSES.includes("error"), false,
      "error must not be live: a failed task is a reason to download again");
    assert.equal(host.LIVE_TASK_STATUSES.includes("complete"), false);
    for (const s of ["queued", "connecting", "downloading", "paused"]) {
      assert.equal(host.LIVE_TASK_STATUSES.includes(s), true, s + " must stay live");
    }
  });

  await test("findLiveTaskIn: error task is not live, downloading is", async () => {
    const failed = [{ id: "e1", url: "https://e.com/v.mp4", status: "error" }];
    assert.equal(host.findLiveTaskIn(failed, "https://e.com/v.mp4"), null,
      "the extension must be able to re-queue a failed URL");
    const live = [{ id: "d1", url: "https://e.com/v.mp4", status: "downloading" }];
    assert.equal(host.findLiveTaskIn(live, "https://e.com/v.mp4").id, "d1");
    assert.equal(host.findLiveTaskIn(null, "https://e.com/v.mp4"), null);
  });

  await test("duplicateReply carries the existing task status", async () => {
    const r = host.duplicateReply({ id: "x", url: "u", status: "paused" });
    assert.equal(r.duplicate, true);
    assert.equal(r.duplicateStatus, "paused");
    assert.equal(r.ok, true);
  });

  group("host.mjs as a real process against a fake daemon");

  const TOKEN = "batch1-test-token";
  const posts = [];
  const daemonState = { tasks: [] };
  let tokenSeenOk = true;

  const daemon = http.createServer((req, res) => {
    if (req.headers["x-downloadx-token"] !== TOKEN) tokenSeenOk = false;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      if (req.method === "GET" && req.url === "/api/tasks") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tasks: daemonState.tasks }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/tasks") {
        posts.push(body);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({
          task: { id: "new-" + posts.length, url: body.url, status: "queued", filename: "queued.bin" },
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no such route" }));
    });
  });
  await new Promise((r) => daemon.listen(0, "127.0.0.1", r));
  const daemonPort = daemon.address().port;

  // runtime.json via write-temp-then-rename, per the workspace discipline.
  const runtime = {
    pid: process.pid, // the probe only checks that the pid is alive
    host: "127.0.0.1",
    port: daemonPort,
    token: TOKEN,
    url: "http://127.0.0.1:" + daemonPort,
  };
  const rtPath = path.join(hostHome, "runtime.json");
  const rtTmp = rtPath + ".tmp-" + Date.now();
  await fsp.writeFile(rtTmp, JSON.stringify(runtime), "utf8");
  await fsp.rename(rtTmp, rtPath);

  const child = spawn(process.execPath, [path.join(ROOT, "extension", "host.mjs")], {
    env: { ...process.env, DOWNLOADX_HOME: hostHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = framedReader();
  child.stdout.on("data", (c) => reader.push(c));
  child.stderr.on("data", (c) => process.stderr.write("    host stderr: " + c));
  let childExit = null;
  child.on("exit", (code) => { childExit = code; reader.end(); });

  const send = (obj) => child.stdin.write(frame(obj));

  try {
    await test("framing + daemon reachability: ping answers ok with the daemon url", async () => {
      send({ protocol: 1, type: "ping" });
      const r = await reader.next();
      assert.ok(!(r instanceof Error), String(r));
      assert.equal(r.ok, true);
      assert.equal(r.daemon.running, true);
    });

    await test("media without a kind is queued as http, not hls", async () => {
      daemonState.tasks = []; // nothing live
      send({ protocol: 1, type: "media", url: "https://e.com/v.mp4" });
      const r = await reader.next();
      assert.ok(!(r instanceof Error), String(r));
      assert.equal(r.ok, true);
      assert.equal(r.duplicate, false);
      assert.equal(posts.length, 1, "the media message must be POSTed to the daemon");
      assert.equal(posts[0].kind, "http", "default kind must be http (was hls)");
    });

    await test("a task with status error is NOT live: the URL is re-queued", async () => {
      daemonState.tasks = [{ id: "e1", url: "https://e.com/v.mp4", status: "error" }];
      send({ protocol: 1, type: "media", url: "https://e.com/v.mp4" });
      const r = await reader.next();
      assert.ok(!(r instanceof Error), String(r));
      assert.equal(r.duplicate, false, "an error task must not block a retry");
      assert.equal(posts.length, 2, "the retry must be POSTed as a new task");
    });

    await test("a downloading task is live: duplicate:true with its status", async () => {
      daemonState.tasks = [{ id: "d1", url: "https://e.com/dup.mp4", status: "downloading" }];
      send({ protocol: 1, type: "media", url: "https://e.com/dup.mp4" });
      const r = await reader.next();
      assert.ok(!(r instanceof Error), String(r));
      assert.equal(r.ok, true);
      assert.equal(r.duplicate, true);
      assert.equal(r.duplicateStatus, "downloading");
      assert.equal(r.task.id, "d1");
      assert.equal(posts.length, 2, "a live duplicate must not be POSTed again");
    });

    await test("add passes headers (incl. Cookie) through to the daemon", async () => {
      daemonState.tasks = [];
      send({
        protocol: 1,
        type: "add",
        url: "https://e.com/login-required.zip",
        referer: "https://page.example/",
        headers: { Cookie: "LOGIN_INFO=abc; SESSDATA=def", Referer: "https://page.example/" },
      });
      const r = await reader.next();
      assert.ok(!(r instanceof Error), String(r));
      assert.equal(r.ok, true);
      assert.equal(posts.length, 3);
      assert.equal(posts[2].headers.Cookie, "LOGIN_INFO=abc; SESSDATA=def",
        "the Cookie must survive the host on the add path");
      assert.equal(posts[2].referer, "https://page.example/");
    });

    await test("the daemon saw the auth token on every call", async () => {
      assert.equal(tokenSeenOk, true, "x-downloadx-token must be sent on every daemon call");
    });
  } finally {
    child.stdin.end();
    await new Promise((r) => {
      const t = setTimeout(() => { child.kill(); r(); }, 4000);
      child.on("exit", () => { clearTimeout(t); r(); });
    });
    try { daemon.closeAllConnections(); } catch { /* none on this Node */ }
    await new Promise((r) => daemon.close(() => r()));
    assert.ok(childExit !== null && childExit === 0, "host.mjs must exit cleanly with code 0, got " + childExit);
    await fsp.rm(hostHome, { recursive: true, force: true }).catch(() => {});
  }
}

// ============================================================================
// main
// ============================================================================

async function main() {
  process.stdout.write(NL + "  downloadx batch1-capture" + NL);

  await backgroundPureTests();
  await backgroundHandlerTests();
  await hostTests();

  process.stdout.write(NL + "  " + passed + " passed, " + failed + " failed" + NL);
  if (failed > 0) {
    process.stdout.write("  failing: " + failures.join(" | ") + NL + NL);
    return 1;
  }
  process.stdout.write(NL);
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch1-capture crashed: " + ((err && err.stack) || err) + NL);
    process.exitCode = 1;
  });
