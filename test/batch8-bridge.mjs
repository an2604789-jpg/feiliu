#!/usr/bin/env node
// Batch-8 regression: P-24 (MV3 keepalive + startup sweep dedupe) and
// P-25 (in-process clipboard bridge + daemon-side watcher guard).
//
// What this guards:
//   (a) P-24 extension/manifest.json carries the "alarms" permission, and the
//       real extension/background.js, run in a vm sandbox, creates the
//       "keepalive" alarm (periodInMinutes: 0.4) and registers an onAlarm
//       listener at top level — that registration is what makes Chrome restart
//       the worker periodically so the downloads.onCreated listener survives;
//   (b) P-24 the top-level chrome.downloads.search({limit:5}) sweep hands
//       fresh in_progress downloads to the takeover flow, and the same download
//       id is processed ONCE only: in-memory Set within a worker lifetime
//       (onCreated yields to a sweep that already handled the id and vice
//       versa) plus a chrome.storage.local record across worker restarts
//       (TAKEOVER_PENDING's TTL+cap pattern). The pure decision is
//       evaluateSweepCandidate, tested directly;
//   (c) P-25 desktop/main.mjs exposes the [clipboard-bridge-pure] block whose
//       planClipboardPoll mirrors src/clipboard.mjs's ClipboardWatcher.check()
//       semantics exactly (same URL regex, same "last" advance rule, first
//       line only), and the wiring POSTs {url, queueId:"clipboard"} to
//       /api/tasks and PATCHes {clipboardBridge:true} to /api/config after
//       daemon:ensure succeeds;
//   (d) P-25 src/config.mjs: clipboardBridge defaults to false and turns true
//       only on an explicit true/"true" (the remoteAccess/askBeforeAdd-style
//       "explicit true only" rule);
//   (e) P-25 the real src/daemon.mjs Daemon.init(): with clipboardBridge=true
//       the PowerShell-polling ClipboardWatcher is NOT started (guard branch —
//       the bridge replaces a PowerShell derivation that dies under the
//       0xC0000142 lineage); with the flag absent the watcher still starts
//       (old behaviour untouched).
//
// Layers 1-2 run the real extension/background.js in a vm sandbox and extract
// the real [clipboard-bridge-pure] block from desktop/main.mjs; layer 3 imports
// the real src/config.mjs + src/daemon.mjs under throwaway DOWNLOADX_HOMEs.
// The production data root (D:/IAM/downloadx-data) is never touched; no window
// is opened; no PowerShell is ever spawned (monitorClipboard is false in the
// daemon fixtures and the bridge is pure logic); the process must exit cleanly.
//
// Usage: node test/batch8-bridge.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { isLoopbackUrl as isLoopbackRef } from "../src/util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NL = String.fromCharCode(10);
const MB = 1024 * 1024;

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

/** Poll until fn() is truthy (returning it), else fail with the caller's text. */
async function waitFor(fn, { timeoutMs = 5000, everyMs = 10, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// 1. the real extension/background.js: keepalive alarm + startup sweep dedupe
// ============================================================================

/**
 * chrome stub faithful to everything background.js touches at load time in the
 * P-24 paths: alarms (create/onAlarm), downloads (onCreated/search/cancel/
 * resume), storage.local, notifications, native-messaging port.
 */
function makeChromeStub(state, storageBacking) {
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
        setTimeout(() => {
          for (const fn of [...portListeners]) fn(reply);
        }, 0);
      }
    },
  };
  const onMessageHandlers = new Set();
  return {
    __port: port,
    runtime: {
      connectNative: () => port,
      lastError: null,
      onInstalled: { addListener() {} },
      onMessage: { addListener: (fn) => onMessageHandlers.add(fn) },
    },
    contextMenus: { create() {}, onClicked: { addListener() {} } },
    action: { onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    tabs: { sendMessage() {}, query: (q, cb) => cb && cb([]) },
    cookies: { getAll: (_opts, cb) => cb([]) },
    storage: {
      local: {
        // Real chrome semantics: get(key, cb) resolves to { [key]: value }.
        get: (key, cb) =>
          cb(key in storageBacking ? { [key]: JSON.parse(JSON.stringify(storageBacking[key])) } : {}),
        set: (obj, cb) => {
          Object.assign(storageBacking, JSON.parse(JSON.stringify(obj)));
          cb && cb();
        },
      },
    },
    downloads: {
      onCreated: { addListener: (fn) => { state.onCreatedListener = fn; } },
      search: (opts, cb) => {
        state.searchQueries.push(opts);
        setTimeout(() => cb && cb(state.searchItems), 0);
        return undefined;   // callback form: no promise
      },
      cancel: (id, cb) => { state.cancelled.push(id); cb && cb(); },
      resume: (id, cb) => { state.resumed.push(id); cb && cb(); },
    },
    notifications: {
      create: (a, b, c) => {
        if (typeof a === "string") { state.notifications.push({ id: a, opts: b }); c && c(); }
        else { state.notifications.push({ id: "(auto)", opts: a }); b && b(); }
      },
      clear: (id, cb) => { state.cleared.push(id); cb && cb(); },
      onClicked: { addListener: (fn) => { state.onClickedListener = fn; } },
    },
    alarms: {
      create: (name, info) => {
        state.alarmsCreated.push({ name, info });
        return undefined;
      },
      onAlarm: { addListener: (fn) => { state.onAlarmListener = fn; } },
    },
    webRequest: { onBeforeRequest: { addListener() {} } },
    __fireMessage: (msg, sender) =>
      new Promise((resolve) => {
        let settled = false;
        const respond = (reply) => { if (!settled) { settled = true; resolve(reply); } };
        for (const fn of [...onMessageHandlers]) fn(msg, sender, respond);
        setTimeout(() => respond(undefined), 50);
      }),
  };
}

/** A fresh in_progress DownloadItem the sweep/onCreated paths accept. */
const sweepItem = (over = {}) => Object.assign({
  id: 41,
  url: "https://cdn.example/files/big.iso?ts=1",
  filename: "",
  state: "in_progress",
  method: "GET",
  referrer: "https://page.example/download",
  fileSize: 5 * MB,
  totalBytes: 5 * MB,
  startTime: new Date().toISOString(),
}, over);

/**
 * Evaluate the real extension/background.js in a sandbox; returns
 * { hooks, state, chrome }. The storage backing is shared across calls so a
 * second load simulates a service-worker restart (same trick as batch2).
 */
async function loadBackground(storageBacking = {}, searchItems = []) {
  const code = await fsp.readFile(path.join(ROOT, "extension", "background.js"), "utf8");
  const logs = [];
  const state = {
    sentToHost: [],
    cancelled: [],
    resumed: [],
    notifications: [],
    cleared: [],
    alarmsCreated: [],
    searchQueries: [],
    searchItems,
    onCreatedListener: null,
    onClickedListener: null,
    onAlarmListener: null,
    consoleOut: logs,
    configReply: { ok: true, config: { takeover: { mode: "notify", extensions: ["iso", "zip", "mp4"] } } },
    addReply: { ok: true, task: { id: "t-takeover", filename: "big.iso", url: "https://cdn.example/files/big.iso" } },
    planReply: (m) => {
      if (m.type === "config") return state.configReply;
      if (m.type === "add") return state.addReply;
      return { ok: true, task: { id: "t-generic", filename: "x.bin", url: "about:blank" } };
    },
  };
  const chrome = makeChromeStub(state, storageBacking);
  const sandbox = {
    chrome,
    console: {
      log: (...a) => logs.push(a.map(String).join(" ")),
      warn: (...a) => logs.push(a.map(String).join(" ")),
      error: (...a) => logs.push(a.map(String).join(" ")),
    },
    setTimeout,
    clearTimeout,
    URL,
    __DOWNLOADX_BATCH1_TEST_PROBE__: true,
    __DOWNLOADX_BATCH2_TEST_PROBE__: true,
    __DOWNLOADX_BATCH8_TEST_PROBE__: true,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "extension/background.js" });
  const hooks = sandbox.__downloadxBatch8Hooks;
  assert.ok(hooks, "background.js must expose __downloadxBatch8Hooks under the batch8 probe");
  return { hooks, state, chrome };
}

async function backgroundTests() {
  group("P-24 keepalive alarm + manifest permissions");

  await test("manifest.json carries the alarms permission (and still downloads)", async () => {
    const manifest = JSON.parse(await fsp.readFile(path.join(ROOT, "extension", "manifest.json"), "utf8"));
    assert.ok(Array.isArray(manifest.permissions), "permissions must be a list");
    assert.ok(manifest.permissions.includes("alarms"), "the alarms permission is required for the keepalive");
    assert.ok(manifest.permissions.includes("downloads"), "the takeover path still needs downloads");
  });

  await test("top level creates the keepalive alarm (0.4 min) and registers onAlarm", async () => {
    const { state } = await loadBackground();
    await waitFor(() => state.alarmsCreated.length > 0, { what: "the keepalive alarm to be created" });
    assert.equal(state.alarmsCreated.length, 1, "exactly one alarm at startup");
    assert.equal(state.alarmsCreated[0].name, "keepalive");
    assert.equal(state.alarmsCreated[0].info.periodInMinutes, 0.4);
    assert.equal(typeof state.onAlarmListener, "function",
      "onAlarm must be registered at top level so the worker is woken and re-runs its listeners");
  });

  group("P-24 evaluateSweepCandidate (pure search-dedupe logic)");

  const hooks = (await loadBackground()).hooks;
  const NOW = Date.now();
  const fresh = (over = {}) => sweepItem({ startTime: new Date(NOW - 5_000).toISOString(), ...over });

  await test("non-candidates are ignored: no id, no startTime, not in_progress, stale startTime", () => {
    assert.equal(hooks.evaluateSweepCandidate({}, { now: NOW }).act, "ignore", "no id");
    assert.equal(hooks.evaluateSweepCandidate({ id: 1 }, { now: NOW }).act, "ignore", "no startTime");
    assert.equal(
      hooks.evaluateSweepCandidate(fresh({ state: "complete" }), { now: NOW }).act, "ignore",
      "a finished download must never be taken over by the sweep");
    assert.equal(
      hooks.evaluateSweepCandidate(fresh({ startTime: new Date(NOW - 10 * 60_000).toISOString() }), { now: NOW }).act,
      "ignore", "a download started 10 min ago is outside the 2 min sweep window");
  });

  await test("already-processed ids are skipped: memory set first, then persisted TTL", () => {
    assert.equal(
      hooks.evaluateSweepCandidate(fresh(), { now: NOW, inMemorySeen: true }).act, "skip",
      "an id processed in this worker lifetime must be skipped");
    assert.equal(
      hooks.evaluateSweepCandidate(fresh(), { now: NOW, persistedSeen: { "41": { at: NOW - 1_000 } } }).act,
      "skip", "an id seen within the persisted TTL must be skipped across worker restarts");
    assert.equal(
      hooks.evaluateSweepCandidate(fresh(), { now: NOW, persistedSeen: { "41": { at: NOW - hooks.TAKEOVER_SWEEP_TTL_MS - 1_000 } } }).act,
      "process", "after the persisted TTL the sweep may offer the download again");
    assert.equal(
      hooks.evaluateSweepCandidate(fresh(), { now: NOW, persistedSeen: { "41": "garbage" } }).act,
      "process", "a malformed persisted entry must not wedge the sweep");
    assert.equal(hooks.evaluateSweepCandidate(fresh(), { now: NOW }).act, "process", "a fresh unseen download is processed");
  });

  await test("constants: storage key, TTL, cap and window are the documented ones", () => {
    assert.equal(hooks.TAKEOVER_SWEEP_KEY, "takeoverSeenDownloadIds");
    assert.equal(hooks.TAKEOVER_SWEEP_TTL_MS, 10 * 60_000, "same window as TAKEOVER_PENDING");
    assert.equal(hooks.TAKEOVER_SWEEP_MAX, 50);
    assert.equal(hooks.TAKEOVER_SWEEP_WINDOW_MS, 2 * 60_000);
  });

  group("P-24 startup sweep through the real handler chain");

  await test("sweep processes a fresh in_progress download exactly like onCreated would", async () => {
    const storage = {};
    const { state } = await loadBackground(storage, [sweepItem()]);
    const n = await waitFor(() => state.notifications.find((x) => /转交飞流\?/.test(x.opts && x.opts.message || "")),
      { what: "the ask notification from the sweep" });
    assert.match(n.opts.message, /big\.iso/, "the notification names the file");
    assert.deepEqual(state.cancelled, [], "notify mode must not cancel the browser download");
    assert.ok(storage[hooks.TAKEOVER_SWEEP_KEY] && Number.isFinite(storage[hooks.TAKEOVER_SWEEP_KEY]["41"].at),
      "the processed id must be persisted for the next worker incarnation");
    assert.equal(state.searchQueries.length, 1);
    // vm 沙箱里的对象原型与宿主 realm 不同,strict deepEqual 会误报(batch2 同坑),
    // 这里按字段值比较。
    assert.equal(state.searchQueries[0].limit, 5, "the sweep must ask for the 5 most recent downloads only");
    assert.equal(Object.keys(state.searchQueries[0]).length, 1, "the query carries nothing but the limit");
  });

  await test("same id in the same worker: sweep first, then onCreated yields (memory set)", async () => {
    const { state } = await loadBackground({}, [sweepItem()]);
    await waitFor(() => state.notifications.find((x) => /转交飞流\?/.test(x.opts && x.opts.message || "")),
      { what: "the sweep notification" });
    state.onCreatedListener(sweepItem());   // same download id, later event
    await sleep(120);
    assert.equal(state.notifications.filter((x) => /转交飞流\?/.test(x.opts && x.opts.message || "")).length, 1,
      "the same download id must be processed once per worker lifetime");
    assert.deepEqual(state.cancelled, []);
  });

  await test("worker restart: the persisted record makes the sweep skip an already-asked download", async () => {
    const storage = {};
    const first = await loadBackground(storage, [sweepItem()]);
    await waitFor(() => first.state.notifications.find((x) => /转交飞流\?/.test(x.opts && x.opts.message || "")),
      { what: "the first worker's ask notification" });
    // Simulate MV3 recycling: re-run background.js with fresh memory, same storage.
    const second = await loadBackground(storage, [sweepItem()]);
    await sleep(150);
    assert.equal(second.state.notifications.length, 0,
      "the restarted worker's sweep must not re-ask a download seen within the TTL");
    assert.deepEqual(second.state.cancelled, []);
  });

  await test("sweep leaves old, finished and seen downloads alone (no notifications, no host traffic)", async () => {
    const { state } = await loadBackground({}, [
      sweepItem({ id: 61, state: "complete" }),
      sweepItem({ id: 62, startTime: new Date(Date.now() - 30 * 60_000).toISOString() }),
    ]);
    await sleep(150);
    assert.equal(state.notifications.length, 0);
    assert.equal(state.sentToHost.filter((m) => m.type !== "config").length, 0);
  });
}

// ============================================================================
// 2. desktop/main.mjs: [clipboard-bridge-pure] block + wiring (source level)
// ============================================================================

const MAIN_SRC = await fsp.readFile(path.join(ROOT, "desktop", "main.mjs"), "utf8");
const CLIP_SRC = await fsp.readFile(path.join(ROOT, "src", "clipboard.mjs"), "utf8");
const DAEMON_SRC = await fsp.readFile(path.join(ROOT, "src", "daemon.mjs"), "utf8");
const CONFIG_SRC = await fsp.readFile(path.join(ROOT, "src", "config.mjs"), "utf8");

const bridgeMatch = MAIN_SRC.match(/\/\/ \[clipboard-bridge-pure\] begin[^\n]*\r?\n([\s\S]*?)\/\/ \[clipboard-bridge-pure\] end/);
/** Evaluated bridge pure object; null when the marker pair is missing (test 1 reports FAIL). */
const bridge = bridgeMatch
  ? new Function(
    bridgeMatch[1] +
    "\nreturn { CLIPBOARD_URL_RE, CLIPBOARD_POLL_MS, planClipboardPoll, isLoopbackCandidate };",
  )()
  : null;

/** The URL regex literal as written in src/clipboard.mjs (the parity reference). */
const clipReMatch = CLIP_SRC.match(/const URL_RE\s*=\s*(\/[^\n]+\/[a-z]*)\s*;/);

async function desktopTests() {
  group("P-25 [clipboard-bridge-pure]: planClipboardPoll");

  await test("marked pure block exists in desktop/main.mjs and evaluates", async () => {
    assert.ok(bridgeMatch, "desktop/main.mjs 里找不到 [clipboard-bridge-pure] 标记对");
    assert.ok(bridge, "标记段求值失败");
    assert.ok(bridge.CLIPBOARD_URL_RE instanceof RegExp);
    assert.equal(typeof bridge.planClipboardPoll, "function");
    assert.equal(bridge.CLIPBOARD_POLL_MS, 1500, "the polling interval must stay 1.5s per the spec");
  });

  await test("URL regex is byte-identical to src/clipboard.mjs's URL_RE", () => {
    assert.ok(clipReMatch, "src/clipboard.mjs 里找不到 URL_RE 字面量");
    const reference = new Function("return " + clipReMatch[1] + ";")();
    assert.equal(bridge.CLIPBOARD_URL_RE.source, reference.source, "same pattern");
    assert.equal(bridge.CLIPBOARD_URL_RE.flags, reference.flags, "same flags");
  });

  await test("dedupe: empty text and unchanged text never post, and last does not move", () => {
    assert.deepEqual(bridge.planClipboardPoll("", "https://a/x"), { post: null, nextLast: "https://a/x" });
    assert.deepEqual(bridge.planClipboardPoll("https://a/x", "https://a/x"), { post: null, nextLast: "https://a/x" });
    assert.deepEqual(bridge.planClipboardPoll("", ""), { post: null, nextLast: "" });
  });

  await test("a new URL posts once; repeating it does not post again", () => {
    const first = bridge.planClipboardPoll("https://a/file.zip", "");
    assert.deepEqual(first, { post: "https://a/file.zip", nextLast: "https://a/file.zip" });
    const again = bridge.planClipboardPoll("https://a/file.zip", first.nextLast);
    assert.equal(again.post, null, "the same clipboard text must not be posted twice in a row");
  });

  await test("URL -> other text -> same URL posts again (mirrors ClipboardWatcher.check)", () => {
    let last = "";
    last = bridge.planClipboardPoll("https://a/1", last).nextLast;
    const mid = bridge.planClipboardPoll("hello world", last);
    assert.equal(mid.post, null);
    assert.equal(mid.nextLast, "hello world", "last must advance even for non-URL text (same as clipboard.mjs)");
    const back = bridge.planClipboardPoll("https://a/1", mid.nextLast);
    assert.equal(back.post, "https://a/1", "a re-copy after other text is a new detection");
  });

  await test("only the first line is a candidate, trimmed, scheme-whitelisted", () => {
    assert.equal(bridge.planClipboardPoll("https://a/2\nsecond line", "").post, "https://a/2");
    assert.equal(bridge.planClipboardPoll("junk\nhttps://a/3", "").post, null, "a URL on line 2 is not seen, like clipboard.mjs");
    assert.equal(bridge.planClipboardPoll("  https://a/4  \n", "").post, "https://a/4", "surrounding whitespace is trimmed");
    assert.equal(bridge.planClipboardPoll("FTP://a/5", "").post, "FTP://a/5", "http/https/ftp, case-insensitive");
    assert.equal(bridge.planClipboardPoll("javascript:alert(1)", "").post, null, "non-(http|https|ftp) schemes are refused");
    assert.equal(bridge.planClipboardPoll("https://", "").post, null, "scheme alone is not a URL");
  });

  await test("loopback URLs are never posted (第10项收口: same host set as util.mjs's isLoopbackUrl)", () => {
    for (const bad of ["http://127.0.0.1:8045/v1/files", "http://localhost:3000/", "http://[::1]:9/x",
      "http://127.127.0.5/a.zip", "HTTPS://LOCALHOST/up.bin"]) {
      const r = bridge.planClipboardPoll(bad, "");
      assert.equal(r.post, null, "must not post " + bad);
      assert.notEqual(r.nextLast, "", "last still advances so the skip is not re-litigated forever");
      assert.ok(bridge.isLoopbackCandidate(bad), "isLoopbackCandidate agrees on " + bad);
    }
    for (const good of ["https://example.com/video.mp4", "http://192.168.1.10/a.zip", "ftp://files.lan/x"]) {
      assert.equal(bridge.isLoopbackCandidate(good), false, "isLoopbackCandidate must not overmatch " + good);
    }
    // 语义钉:与 src/util.mjs 的判定对每一个样例输入结论一致。
    assert.equal(bridge.isLoopbackCandidate("http://127.0.0.1:1/"), isLoopbackRef("http://127.0.0.1:1/"));
    assert.equal(bridge.isLoopbackCandidate("https://example.com/"), isLoopbackRef("https://example.com/"));
  });

  group("P-25 wiring (source-level, batch3-style assertions on the real files)");

  await test("desktop/main.mjs starts the bridge right after daemon ensure succeeds", () => {
    assert.match(MAIN_SRC, /startEventFeed\(rt\);[\s\S]{0,400}startClipboardBridge\(\);/,
      "startClipboardBridge() must be called in the daemon:ensure success path");
    assert.match(MAIN_SRC, /queueId: "clipboard"/, "the bridge POSTs tasks with queueId clipboard");
    assert.match(MAIN_SRC, /clipboard\.readText\(\)/, "the bridge polls electron.clipboard in-process");
  });

  await test("desktop/main.mjs PATCHes clipboardBridge:true to the daemon", () => {
    const patchMatch = MAIN_SRC.match(/method: "PATCH"[\s\S]{0,400}JSON\.stringify\(\{ clipboardBridge: true \}\)/);
    assert.ok(patchMatch, "the bridge must PATCH /api/config {clipboardBridge:true}");
  });

  await test("src/daemon.mjs guards ClipboardWatcher.start() behind clipboardBridge", () => {
    const guardMatch = DAEMON_SRC.match(
      /if \(this\.config\.get\("clipboardBridge"\) === true\) \{[\s\S]{0,600}?\} else \{\s*this\.clipboard\.start\(\);\s*\}/);
    assert.ok(guardMatch, "daemon.mjs must not start the PowerShell watcher when clipboardBridge===true");
    assert.match(DAEMON_SRC, /0xC0000142/, "the guard comment must name the 0xC0000142 lineage");
    assert.match(DAEMON_SRC, /附记十二\/十八/, "the guard comment must cite 附记十二/十八");
  });
}

// ============================================================================
// 3. real src/config.mjs + src/daemon.mjs under throwaway DOWNLOADX_HOMEs
// ============================================================================

async function daemonTests() {
  group("P-25 src/config.mjs clipboardBridge sanitize (real module, temp HOME)");

  // 临时 DOWNLOADX_HOME:先建目录、置环境,再 import,严禁触碰 D:/IAM/downloadx-data。
  const home1 = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b8-bridge-on-"));
  const prevHome = process.env.DOWNLOADX_HOME;
  process.env.DOWNLOADX_HOME = home1;

  let daemonA = null;
  let daemonB = null;
  let home2 = null;
  try {
    const { Config, DEFAULT_CONFIG } = await import("../src/config.mjs");
    const { Daemon } = await import("../src/daemon.mjs");
    const { paths } = await import("../src/paths.mjs");

    await test("sanitize: default false, explicit true/\"true\" only, junk stays false", () => {
      assert.equal(Config.sanitize({}).clipboardBridge, false, "default must be false");
      assert.equal(Config.sanitize({ clipboardBridge: true }).clipboardBridge, true);
      assert.equal(Config.sanitize({ clipboardBridge: "true" }).clipboardBridge, true);
      assert.equal(Config.sanitize({ clipboardBridge: "yes" }).clipboardBridge, false);
      assert.equal(Config.sanitize({ clipboardBridge: 1 }).clipboardBridge, false);
      assert.equal(Config.sanitize({ clipboardBridge: false }).clipboardBridge, false);
      assert.equal(DEFAULT_CONFIG.clipboardBridge, false, "the shipped default table carries false");
    });

    await test("daemon with clipboardBridge=true does NOT start the PowerShell watcher", async () => {
      const out = path.join(home1, "out");
      const cfg = new Config(paths.config);
      await cfg.load();
      // defaultDir inside the temp home keeps the EpermCanary's write probe away
      // from the real Downloads folder; monitorClipboard=false means even a
      // stray watcher tick could never spawn PowerShell in either branch.
      await cfg.set({
        clipboardBridge: true,
        monitorClipboard: false,
        defaultDir: out,
        proxyMode: "none",
        captureProxy: { enabled: false },
      });
      daemonA = new Daemon();
      await daemonA.init();
      assert.equal(daemonA.config.get("clipboardBridge"), true, "the daemon must load the flag from config.json");
      assert.ok(daemonA.clipboard, "the watcher object is still constructed (stop() stays safe)");
      assert.equal(daemonA.clipboard.timer, null,
        "guard branch: clipboardBridge===true must leave the PowerShell watcher unarmed");
    });

    await test("daemon without the flag still starts the watcher (old behaviour untouched)", async () => {
      home2 = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b8-bridge-off-"));
      process.env.DOWNLOADX_HOME = home2;   // paths.mjs resolves through live getters
      const out2 = path.join(home2, "out");
      const cfg = new Config();
      await cfg.load();
      await cfg.set({ monitorClipboard: false, defaultDir: out2, proxyMode: "none" });
      daemonB = new Daemon();
      await daemonB.init();
      assert.equal(daemonB.config.get("clipboardBridge"), false);
      assert.notEqual(daemonB.clipboard.timer, null,
        "without the flag the watcher must be armed exactly as before P-25");
    });
  } finally {
    // 不得留下任何会派生 PowerShell 的定时器;其余组件未 start(),无需 stop。
    try { daemonB && daemonB.clipboard && daemonB.clipboard.stop(); } catch { /* already down */ }
    try { daemonB && daemonB.canary && daemonB.canary.stop(); } catch { /* already down */ }
    try { daemonA && daemonA.canary && daemonA.canary.stop(); } catch { /* already down */ }
    process.env.DOWNLOADX_HOME = prevHome;
    await fsp.rm(home1, { recursive: true, force: true }).catch(() => {});
    if (home2) await fsp.rm(home2, { recursive: true, force: true }).catch(() => {});
  }
}

// ============================================================================

async function main() {
  process.stdout.write("batch8-bridge: P-24 keepalive/sweep + P-25 clipboard bridge" + NL);
  await backgroundTests();
  await desktopTests();
  await daemonTests();
  process.stdout.write(NL + "  " + passed + " passed, " + failed + " failed" + NL + NL);
  if (failures.length) {
    process.stdout.write("  failed: " + failures.join(" | ") + NL + NL);
  }
  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch8-bridge crashed: " + ((err && err.stack) || err) + NL);
    process.exitCode = 1;
  });
