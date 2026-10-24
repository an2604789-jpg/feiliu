// Batch-2 regression: browser-download takeover (包4, 2026-10-24).
//
// What this guards:
//   (a) src/config.mjs grows config.takeover { mode: notify|auto|off (default
//       notify), extensions: default archive/program/media table } with strict
//       sanitize (mode whitelist, extension tokens normalised, empty table
//       falls back to the default table, junk dropped);
//   (b) extension/background.js decides takeover purely by URL filter
//       (blob:/data:/non-http(s) ignored, GET only), extension table and the
//       "> 1 MiB known size" threshold; notify mode asks via a system
//       notification whose click performs the transfer, auto mode transfers
//       immediately, off mode does nothing at all;
//   (c) the transfer itself = chrome.downloads.cancel + an "add" through the
//       existing native-host channel carrying buildStreamHeaders() output
//       (page Referer + Cookie); an enqueue failure notifies and calls
//       chrome.downloads.resume so the browser download is released again;
//   (d) the pending notify-mode handoffs survive a service-worker restart
//       because they live in chrome.storage.local, not memory;
//   (e) manifest.json carries the "downloads" permission and gui/index.html
//       exposes the 浏览器接管 settings (mode select + comma-separated table)
//       on the existing save chain.
//
// Layer 1-2 run the real extension/background.js in a vm sandbox with a chrome
// stub (the file exposes hooks only when the sandbox sets the probe flags);
// layer 3 imports the real src/config.mjs under a throwaway DOWNLOADX_HOME.
// The production data root (D:/IAM/downloadx-data) is never touched; the
// process must exit cleanly. Real browser behaviour (an actual download bar,
// a real system notification) is smoke-only, not here.
//
// Usage: node test/batch2-takeover.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

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

const COOKIE_NAME = "SESSDATA";
const COOKIE_VALUE = "batch2-takeover-cookie"; // fake on purpose; must never be logged

/**
 * chrome stub faithful to everything background.js touches at load time and in
 * the takeover paths: native-messaging port, downloads, notifications (with
 * onClicked), storage.local, cookies, tabs.
 *
 * @param {Object} state shared recorder (also carries planReply/configReply)
 * @param {Object} storageBacking backing store for chrome.storage.local, shared
 *   across sandbox loads to simulate a service-worker restart
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
  const stub = {
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
    tabs: {
      sendMessage: () => {},
      query: (q, cb) => cb && cb([]),
    },
    cookies: {
      getAll: (_opts, cb) => cb([{ name: COOKIE_NAME, value: COOKIE_VALUE }]),
    },
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
      cancel: (id, cb) => { state.cancelled.push(id); cb && cb(); },
      resume: (id, cb) => { state.resumed.push(id); cb && cb(); },
    },
    notifications: {
      create: (a, b, c) => {
        // chrome.notifications.create(notificationId, options, cb) and
        // create(options, cb) are both used in background.js.
        if (typeof a === "string") {
          state.notifications.push({ id: a, opts: b });
          c && c();
        } else {
          state.notifications.push({ id: "(auto)", opts: a });
          b && b();
        }
      },
      clear: (id, cb) => { state.cleared.push(id); cb && cb(); },
      onClicked: { addListener: (fn) => { state.onClickedListener = fn; } },
    },
    webRequest: { onBeforeRequest: { addListener() {} } },
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
      setTimeout(() => respond(undefined), 50);
    });
  return stub;
}

/**
 * Evaluate the real extension/background.js in a sandbox; returns
 * { hooks, state, chrome }. The storage backing is shared across calls so a
 * second load simulates a service-worker restart.
 */
async function loadBackground(storageBacking = {}) {
  const code = await fsp.readFile(path.join(ROOT, "extension", "background.js"), "utf8");
  const logs = [];
  const state = {
    sentToHost: [],
    cancelled: [],
    resumed: [],
    notifications: [],
    cleared: [],
    consoleOut: logs,
    onCreatedListener: null,
    onClickedListener: null,
    configReply: { ok: true, config: { takeover: { mode: "notify", extensions: ["iso", "zip", "mp4"] } } },
    addReply: { ok: true, task: { id: "t-takeover", filename: "big.iso", url: "about:blank" } },
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
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "extension/background.js" });
  const hooks = sandbox.__downloadxBatch2Hooks;
  assert.ok(hooks, "background.js must expose __downloadxBatch2Hooks under the batch2 probe");
  return { hooks, state, chrome };
}

/** A matching chrome.downloads.DownloadItem for the takeover table. */
const bigItem = (over = {}) => Object.assign({
  id: 41,
  url: "https://cdn.example/files/big.iso?ts=1",
  filename: "",
  mime: "application/octet-stream",
  state: "in_progress",
  method: "GET",
  referrer: "https://page.example/download",
  fileSize: 5 * MB,
  totalBytes: 5 * MB,
}, over);

/** Wait until no notification matching /pattern/ is missing, etc. (poll helpers). */
const notifMatching = (state, re) => state.notifications.find((n) => re.test(n.opts && n.opts.message || ""));

// ============================================================================
// 1. background.js pure takeover logic (匹配表 / 模式判定 / URL 过滤)
// ============================================================================

async function backgroundPureTests() {
  group("background.js evaluateTakeover 纯逻辑(匹配表/模式判定/URL 过滤)");

  const ctx = await loadBackground();
  const ev = (item, cfg) => ctx.hooks.evaluateTakeover(item, cfg);

  await test("阈值常量与默认表:1 MiB 严格大于,默认表覆盖归档/程序/媒体", async () => {
    assert.equal(ctx.hooks.TAKEOVER_MIN_BYTES, MB);
    for (const ext of ["zip", "rar", "7z", "exe", "msi", "mp4", "mkv", "mp3", "flac"]) {
      assert.ok(ctx.hooks.DEFAULT_TAKEOVER_EXTENSIONS.includes(ext), "default table must contain " + ext);
    }
  });

  await test("blob: 与 data: URL 直接忽略(即使 auto 模式、体积达标)", async () => {
    const cfg = { mode: "auto", extensions: ["zip"] };
    assert.equal(ev({ url: "blob:https://x/uuid-123", fileSize: 50 * MB }, cfg).act, "ignore");
    assert.equal(ev({ url: "data:application/zip;base64,AAAA", fileSize: 50 * MB }, cfg).act, "ignore");
  });

  await test("非 http(s) 协议一律忽略", async () => {
    const cfg = { mode: "auto", extensions: ["zip"] };
    assert.equal(ev({ url: "ftp://x/f.zip", fileSize: 50 * MB }, cfg).act, "ignore");
    assert.equal(ev({ url: "file:///D:/f.zip", fileSize: 50 * MB }, cfg).act, "ignore");
    assert.equal(ev({ url: "chrome-extension://x/f.zip", fileSize: 50 * MB }, cfg).act, "ignore");
    assert.equal(ev({ url: "about:blank" }, cfg).act, "ignore");
  });

  await test("off 模式忽略;非 GET 忽略", async () => {
    assert.equal(ev(bigItem(), { mode: "off", extensions: ["iso"] }).act, "ignore");
    const post = ev(bigItem({ method: "POST" }), { mode: "auto", extensions: ["iso"] });
    assert.equal(post.act, "ignore");
    assert.match(post.reason, /POST/);
  });

  await test("扩展名必须命中接管表:表内命中,表外放行", async () => {
    const cfg = { mode: "auto", extensions: ["iso", "zip"] };
    assert.equal(ev(bigItem(), cfg).act, "transfer", ".iso in table");
    assert.equal(ev(bigItem({ url: "https://cdn.example/files/doc.pdf" }), cfg).act, "pass");
    assert.equal(ev(bigItem({ url: "https://cdn.example/api/no-ext?f=1" }), cfg).act, "pass",
      "URL 无扩展名放行");
  });

  await test("大小门槛:已知 ≤1 MiB 放行;恰好 1 MiB 也不接管(严格大于)", async () => {
    const cfg = { mode: "auto", extensions: ["iso"] };
    assert.equal(ev(bigItem({ fileSize: 100 }), cfg).act, "pass");
    assert.equal(ev(bigItem({ fileSize: MB }), cfg).act, "pass", "1 MiB 本身不接管");
    assert.equal(ev(bigItem({ fileSize: MB + 1 }), cfg).act, "transfer");
  });

  await test("大小未知(onCreated 时 0/-1)不接管:让浏览器继续,不误抢", async () => {
    const cfg = { mode: "auto", extensions: ["iso"] };
    const unknown = ev(bigItem({ fileSize: 0, totalBytes: -1 }), cfg);
    assert.equal(unknown.act, "pass");
    assert.match(unknown.reason, /unknown/);
    // totalBytes 兜底:fileSize 未知但 totalBytes 已知且达标照样命中
    assert.equal(ev(bigItem({ fileSize: 0, totalBytes: 2 * MB }), cfg).act, "transfer");
  });

  await test("模式判定:notify → notify,auto → transfer;query/fragment 不影响扩展名", async () => {
    const cfg = { mode: "notify", extensions: ["iso"] };
    assert.equal(ev(bigItem(), cfg).act, "notify");
    assert.equal(ev(bigItem(), { ...cfg, mode: "auto" }).act, "transfer");
    assert.equal(ev(bigItem({ url: "https://x/f.zip#frag" }), { mode: "auto", extensions: ["zip"] }).act,
      "transfer", "#fragment must not defeat the extension match");
  });

  await test("配置缺省的兜底:mode 未给出按 notify,extensions 为空用默认表", async () => {
    const d = ev(bigItem(), {});
    assert.equal(d.act, "notify", "缺省 mode = notify(与 Config.sanitize({}) 同口径)");
    // 空表 → 默认表,big.iso 命中默认表的 iso
    assert.equal(ev(bigItem(), { mode: "auto", extensions: [] }).act, "transfer");
  });

  await test("normalizeTakeoverExtensions:大小写/前导点/逗号串/杂质/去重", async () => {
    const n = ctx.hooks.normalizeTakeoverExtensions;
    // 展开回宿主 realm:vm 沙箱数组的原型不同,strict deepEqual 会误报。
    assert.deepEqual([...n([".ZIP", "Zip ", "rar", 7, "x!.bad", "tar"])], ["zip", "rar", "tar"]);
    assert.deepEqual([...n("MP4, mkv ,.iso")], ["mp4", "mkv", "iso"]);
    assert.deepEqual([...n([])], []);
    assert.deepEqual([...n(null)], []);
  });

  await test("takeoverDisplayName:URL basename 解码,有文件名优先", async () => {
    const d = ctx.hooks.takeoverDisplayName;
    assert.equal(d(bigItem()), "big.iso", "query string stripped");
    assert.equal(d({ filename: "C:\\Users\\a\\Downloads\\x.zip", url: "https://x/y" }), "x.zip");
    assert.equal(d({ url: "https://x/%E4%B8%AD%E6%96%87.iso" }), "中文.iso");
  });
}

// ============================================================================
// 2. the real onCreated / notification-click handlers through the sandbox
// ============================================================================

async function backgroundHandlerTests() {
  group("chrome.downloads.onCreated 全链路(经真实 handler 与假 native host)");

  await test("notify 模式:只询问不打断——零 cancel、零入队,通知文案为 转交飞流?", async () => {
    const ctx = await loadBackground();
    ctx.state.onCreatedListener(bigItem());
    const n = await waitFor(() => notifMatching(ctx.state, /转交飞流\?/),
      { what: "the ask notification" });
    assert.equal(n.id, "downloadx-takeover-41");
    assert.match(n.opts.message, /big\.iso/, "通知里带文件名");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(ctx.state.cancelled.length, 0, "notify 模式询问期间不得 cancel 浏览器下载");
    assert.equal(ctx.state.sentToHost.filter((m) => m.type !== "config").length, 0,
      "询问期间不得向 host 发任何入队消息");
  });

  await test("notify 模式点击通知 = 转交:cancel + add,带 Referer/Cookie(buildStreamHeaders)", async () => {
    const storage = {};
    const ctx = await loadBackground(storage);
    ctx.state.onCreatedListener(bigItem());
    await waitFor(() => notifMatching(ctx.state, /转交飞流\?/), { what: "the ask notification" });
    await waitFor(() => storage.takeoverPending && storage.takeoverPending["downloadx-takeover-41"],
      { what: "the pending handoff to reach chrome.storage.local" });

    ctx.state.onClickedListener("downloadx-takeover-41");
    await waitFor(() => ctx.state.sentToHost.find((m) => m.type === "add"),
      { what: "the add message after the click" });
    assert.deepEqual(ctx.state.cancelled, [41], "点击后必须 cancel 对应的浏览器下载");
    const add = ctx.state.sentToHost.find((m) => m.type === "add");
    assert.equal(add.url, bigItem().url);
    assert.equal(add.referer, "https://page.example/download", "页面 Referer 必须随转交带入");
    assert.equal(add.headers.Cookie, COOKIE_NAME + "=" + COOKIE_VALUE,
      "转交必须带 buildStreamHeaders 的 Cookie");
    assert.equal(add.headers.Referer, "https://page.example/download");
    assert.ok(add.headers["User-Agent"], "UA 必须在");
    assert.equal(add.meta && add.meta.source, "browser-takeover");
    assert.ok(ctx.state.cleared.includes("downloadx-takeover-41"), "点击后清掉询问通知");
    await waitFor(() => !storage.takeoverPending["downloadx-takeover-41"],
      { what: "the pending handoff to be consumed" });
  });

  await test("待决转交落在 chrome.storage.local:service worker 重启后点击仍然生效", async () => {
    const storage = {};
    const ctx1 = await loadBackground(storage);
    ctx1.state.onCreatedListener(bigItem());
    await waitFor(() => storage.takeoverPending && storage.takeoverPending["downloadx-takeover-41"],
      { what: "the pending handoff to reach chrome.storage.local" });
    // 模拟 MV3 worker 被回收:重新执行 background.js(全新内存,同一 storage)
    const ctx2 = await loadBackground(storage);
    ctx2.state.onClickedListener("downloadx-takeover-41");
    await waitFor(() => ctx2.state.sentToHost.find((m) => m.type === "add"),
      { what: "the add message after the click in the restarted worker" });
    assert.deepEqual(ctx2.state.cancelled, [41]);
  });

  await test("auto 模式:不询问直接转交(cancel + add),没有询问通知", async () => {
    const ctx = await loadBackground();
    ctx.state.configReply = { ok: true, config: { takeover: { mode: "auto", extensions: ["iso"] } } };
    ctx.state.onCreatedListener(bigItem());
    await waitFor(() => ctx.state.sentToHost.find((m) => m.type === "add"), { what: "the auto add" });
    assert.deepEqual(ctx.state.cancelled, [41]);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(notifMatching(ctx.state, /转交飞流\?/), undefined,
      "auto 模式不得再弹询问通知");
  });

  await test("off 模式零打扰:无通知、无 cancel、除 config 拉取外零 host 消息", async () => {
    const ctx = await loadBackground();
    ctx.state.configReply = { ok: true, config: { takeover: { mode: "off" } } };
    ctx.state.onCreatedListener(bigItem());
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(ctx.state.notifications.length, 0, "off 模式不得有任何通知");
    assert.equal(ctx.state.cancelled.length, 0);
    assert.equal(ctx.state.resumed.length, 0);
    assert.equal(ctx.state.sentToHost.filter((m) => m.type !== "config").length, 0,
      "off 模式除 config 拉取外不得发任何消息");
  });

  await test("blob:/data: 在 auto 模式下也被忽略", async () => {
    const ctx = await loadBackground();
    ctx.state.configReply = { ok: true, config: { takeover: { mode: "auto", extensions: ["zip"] } } };
    ctx.state.onCreatedListener(bigItem({ id: 42, url: "blob:https://x/uuid", fileSize: 50 * MB }));
    ctx.state.onCreatedListener(bigItem({ id: 43, url: "data:application/zip;base64,AAAA", fileSize: 50 * MB }));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(ctx.state.cancelled.length, 0);
    assert.equal(ctx.state.sentToHost.filter((m) => m.type !== "config").length, 0);
    assert.equal(ctx.state.notifications.length, 0);
  });

  await test("未命中(小文件/表外扩展名/大小未知)不产生任何动作", async () => {
    const ctx = await loadBackground();
    ctx.state.onCreatedListener(bigItem({ id: 44, url: "https://x/small.zip", fileSize: 100 * 1024 }));
    ctx.state.onCreatedListener(bigItem({ id: 45, url: "https://x/doc.pdf", fileSize: 50 * MB }));
    ctx.state.onCreatedListener(bigItem({ id: 46, fileSize: 0, totalBytes: -1 }));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(ctx.state.notifications.length, 0, "未命中不得打扰");
    assert.equal(ctx.state.cancelled.length, 0);
    assert.equal(ctx.state.sentToHost.filter((m) => m.type !== "config").length, 0);
  });

  await test("转交失败(host 报错):resume 放开浏览器下载 + 失败通知,无通用错误通知", async () => {
    const ctx = await loadBackground();
    ctx.state.configReply = { ok: true, config: { takeover: { mode: "auto", extensions: ["iso"] } } };
    ctx.state.addReply = { ok: false, error: "downloadx daemon is not running" };
    ctx.state.onCreatedListener(bigItem());
    const n = await waitFor(() => notifMatching(ctx.state, /转交飞流失败/),
      { what: "the takeover failure notification" });
    assert.match(n.opts.message, /已恢复浏览器下载/, "失败通知必须说明浏览器下载已恢复");
    assert.match(n.opts.message, /daemon is not running/);
    await waitFor(() => ctx.state.resumed.includes(41), { what: "chrome.downloads.resume to be called" });
    assert.equal(notifMatching(ctx.state, /Could not queue/), undefined,
      "转交路径的失败提示是合并的一条,不得再叠通用错误通知");
  });

  await test("守护进程不可达(config 拉取失败):按 off 处理,零打扰", async () => {
    const ctx = await loadBackground();
    ctx.state.configReply = { ok: false, error: "downloadx daemon is not running" };
    ctx.state.onCreatedListener(bigItem());
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(ctx.state.notifications.length, 0);
    assert.equal(ctx.state.cancelled.length, 0);
    assert.equal(ctx.state.sentToHost.filter((m) => m.type !== "config").length, 0);
  });

  await test("配置缓存:TTL 内沿用旧值,复位钩子后立即采用新值", async () => {
    const ctx = await loadBackground();
    ctx.state.onCreatedListener(bigItem({ id: 50 }));
    await waitFor(() => notifMatching(ctx.state, /转交飞流\?/), { what: "first ask" });
    // 同一 TTL 窗口内把守护进程配置改成 off:缓存仍按 notify 询问
    ctx.state.configReply = { ok: true, config: { takeover: { mode: "off" } } };
    ctx.state.onCreatedListener(bigItem({ id: 51 }));
    await waitFor(() => notifMatching(ctx.state, /转交飞流\?/), { what: "cached ask" });
    // 复位缓存(等价 TTL 过期):off 生效,零打扰
    ctx.hooks.__resetTakeoverConfigCacheForTest();
    ctx.state.onCreatedListener(bigItem({ id: 52 }));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(ctx.state.cancelled.length, 0);
    assert.equal(ctx.state.sentToHost.filter((m) => m.type !== "config").length, 0);
  });

  await test("Cookie 值不得出现在任何日志行", async () => {
    const ctx = await loadBackground();
    ctx.state.configReply = { ok: true, config: { takeover: { mode: "auto", extensions: ["iso"] } } };
    ctx.state.onCreatedListener(bigItem());
    await waitFor(() => ctx.state.sentToHost.find((m) => m.type === "add"), { what: "the auto add" });
    const leaked = ctx.state.consoleOut.filter((line) => line.includes(COOKIE_VALUE));
    assert.deepEqual(leaked, [], "cookie values must never be logged");
  });
}

// ============================================================================
// 3. src/config.mjs: takeover defaults + sanitize (真实模块, 临时 HOME)
// ============================================================================

async function configTests() {
  group("src/config.mjs takeover 默认值与 sanitize");

  // 临时 DOWNLOADX_HOME:先建目录、置环境,再 import,严禁触碰 D:/IAM/downloadx-data。
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b2-takeover-"));
  const prevHome = process.env.DOWNLOADX_HOME;
  process.env.DOWNLOADX_HOME = home;

  try {
    const { Config, DEFAULT_CONFIG } = await import("../src/config.mjs");
    const { paths } = await import("../src/paths.mjs");
    await test("临时 DOWNLOADX_HOME 生效(不触碰 D:/IAM/downloadx-data)", async () => {
      assert.ok(paths.config.startsWith(home), "config path must live under the temp home: " + paths.config);
    });

    await test("DEFAULT_CONFIG.takeover:mode 默认 notify,默认表覆盖归档/程序/媒体", async () => {
      assert.equal(DEFAULT_CONFIG.takeover.mode, "notify");
      for (const ext of ["zip", "7z", "iso", "exe", "msi", "apk", "mp4", "mkv", "mp3", "flac", "wav"]) {
        assert.ok(DEFAULT_CONFIG.takeover.extensions.includes(ext), ext + " must be in the default table");
      }
    });

    await test("sanitize({}) 保留默认接管配置(老 config.json 无此字段也安全)", async () => {
      const c = Config.sanitize({});
      assert.equal(c.takeover.mode, "notify");
      assert.deepEqual(c.takeover.extensions, DEFAULT_CONFIG.takeover.extensions);
    });

    await test("mode 白名单校验:非法值回落 notify,合法三值透传", async () => {
      assert.equal(Config.sanitize({ takeover: { mode: "bogus" } }).takeover.mode, "notify");
      assert.equal(Config.sanitize({ takeover: { mode: "auto" } }).takeover.mode, "auto");
      assert.equal(Config.sanitize({ takeover: { mode: "off" } }).takeover.mode, "off");
      assert.equal(Config.sanitize({ takeover: { mode: 42 } }).takeover.mode, "notify");
    });

    await test("extensions 归一化:前导点/大小写/空白/杂质/去重,非法元素丢弃", async () => {
      const c = Config.sanitize({ takeover: { mode: "off", extensions: [".ZIP", "Zip ", "rar", 7, "x!", "tar"] } });
      assert.deepEqual(c.takeover.extensions, ["zip", "rar", "tar"]);
    });

    await test("extensions 接受逗号分隔字符串(手改 config.json 的形态)", async () => {
      const c = Config.sanitize({ takeover: { extensions: "mp4, MKV ,.iso" } });
      assert.deepEqual(c.takeover.extensions, ["mp4", "mkv", "iso"]);
    });

    await test("空表回落默认表;takeover 字段为垃圾类型时整体回落默认", async () => {
      assert.deepEqual(
        Config.sanitize({ takeover: { mode: "auto", extensions: [] } }).takeover.extensions,
        DEFAULT_CONFIG.takeover.extensions
      );
      const junk = Config.sanitize({ takeover: "nonsense" });
      assert.equal(junk.takeover.mode, "notify");
      assert.deepEqual(junk.takeover.extensions, DEFAULT_CONFIG.takeover.extensions);
    });

    await test("GUI 保存链路等价:config.set 深合并 + 落盘(write-temp-then-rename)后回读一致", async () => {
      const cfg = new Config(path.join(home, "config.json"));
      await cfg.load();
      await cfg.set({ takeover: { mode: "auto", extensions: ["iso", "zip"] } });
      assert.equal(cfg.values.takeover.mode, "auto");
      assert.deepEqual(cfg.values.takeover.extensions, ["iso", "zip"]);
      const onDisk = JSON.parse(await fsp.readFile(path.join(home, "config.json"), "utf8"));
      assert.equal(onDisk.takeover.mode, "auto", "set() 必须落盘");
      // 深合并:后续只改 mode 不应清掉 extensions
      await cfg.set({ takeover: { mode: "notify" } });
      assert.deepEqual(cfg.values.takeover.extensions, ["iso", "zip"],
        "PATCH 只改 mode 时 extensions 必须保留");
    });
  } finally {
    if (prevHome === undefined) delete process.env.DOWNLOADX_HOME;
    else process.env.DOWNLOADX_HOME = prevHome;
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

// ============================================================================
// 4. static wiring: manifest permission + gui settings block
// ============================================================================

async function wiringTests() {
  group("manifest.json 权限与 gui/index.html 设置区块(静态接线)");

  await test("manifest.json 含 downloads 与 notifications 权限且 JSON 合法", async () => {
    const m = JSON.parse(await fsp.readFile(path.join(ROOT, "extension", "manifest.json"), "utf8"));
    assert.ok(m.permissions.includes("downloads"), "chrome.downloads 需要 downloads 权限");
    assert.ok(m.permissions.includes("notifications"), "系统通知权限必须在");
    assert.ok(m.permissions.includes("storage"), "待决转交落 chrome.storage 需要 storage 权限");
  });

  await test("gui/index.html:浏览器接管区块含模式三选一与扩展名表输入", async () => {
    const html = fs.readFileSync(path.join(ROOT, "gui", "index.html"), "utf8");
    assert.match(html, /id="cfg-takeoverMode"/);
    for (const mode of ["notify", "auto", "off"]) {
      assert.ok(html.includes('value="' + mode + '"'), "模式选项 " + mode + " 必须存在");
    }
    assert.match(html, /id="cfg-takeoverExtensions"/);
  });

  await test("fillConfig 回显与 btnSaveCfg 保存体都带上 takeover(既有保存链路)", async () => {
    const html = fs.readFileSync(path.join(ROOT, "gui", "index.html"), "utf8");
    const fill = html.slice(html.indexOf("function fillConfig"), html.indexOf("function fillConfig") + 2000);
    assert.match(fill, /set\("cfg-takeoverMode"/, "fillConfig 必须回显模式");
    assert.match(fill, /set\("cfg-takeoverExtensions"/, "fillConfig 必须回显扩展名表");
    const save = html.slice(html.indexOf('getElementById("btnSaveCfg").onclick'), html.indexOf('getElementById("btnSaveCfg").onclick') + 3000);
    assert.match(save, /takeover:\s*\{/, "保存体必须携带 takeover");
    assert.match(save, /getElementById\("cfg-takeoverMode"\)\.value/, "保存体读取模式选择");
    assert.match(save, /getElementById\("cfg-takeoverExtensions"\)\.value/, "保存体读取扩展名表");
    assert.match(save, /split\(","\)/, "扩展名表按逗号拆分");
    assert.match(save, /api\("\/api\/config",\{method:"PATCH"/, "仍走既有 /api/config PATCH 链路");
  });
}

// ============================================================================
// main
// ============================================================================

async function main() {
  process.stdout.write(NL + "  downloadx batch2-takeover" + NL);

  await backgroundPureTests();
  await backgroundHandlerTests();
  await configTests();
  await wiringTests();

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
    process.stderr.write("batch2-takeover crashed: " + ((err && err.stack) || err) + NL);
    process.exitCode = 1;
  });
