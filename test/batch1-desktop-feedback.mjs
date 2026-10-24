// Batch1 包6 回归：桌面托盘反馈（事件流→气泡）与托盘队列控制的可自动化部分。
//
// 桌面壳 desktop/main.mjs 无法在普通 node 进程里加载（顶部 import electron
// 且带启动副作用），因此它的纯逻辑被抽到 desktop/tray-feed.mjs，主进程与
// 本测试共用同一实现。这里覆盖：
//   (a) SSE 解析：任意切分的 chunk、两帧同块、keep-alive 注释行、坏帧丢弃、
//       CRLF、多行 data、流尾残帧；
//   (b) 事件分类：只有"见过的状态"跃迁到 complete/error 才触达用户——
//       progress 每 300ms 一条 updated、完成后重复的 complete 帧都不得
//       重复弹泡，订阅建立前就是终态的历史任务不触发；
//   (c) 最近完成列表（3 条、最新在前、同 id 去重）与限速切换决策
//       （当前非零→0 并记住；0→上次非零值；从无记录→兜底档）；
//   (d) 托盘菜单模板：暂停全部/恢复全部/限速开关/最近完成 3 条；daemon
//       不可用时禁用而非隐藏；旧三项（显示主界面/开机自启/退出）原样保留；
//   (e) 托盘状态落盘：写临时再改名（不残留 .tmp），损坏/缺失回退默认；
//   (f) daemon 契约：对真实 ApiServer 的 /api/events 流跑同一套解析器与
//       分类器（证明分类假设与 daemon 实际帧一致：hello 无 payload、
//       完成走 updated+status=complete、payload 带 filename/dir）、
//       /api/queue/pause|resume、/api/config 的 speedLimit PATCH 往返
//       （即托盘限速开关的写回路径）、/api/tasks/:id/location（即气泡
//       点击打开文件的权威路径来源）、事件流无 token 必须 401。
//
// 一切都在本地 origin + 隔离的临时 DOWNLOADX_HOME 上运行：不碰公网、不碰
// 用户 Downloads、不碰 %APPDATA%\downloadx，更不碰生产数据根。
//
// Usage: node test/batch1-desktop-feedback.mjs

import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";
import { startOrigin, payloadFor } from "./origin.mjs";
import {
  createSseParser,
  classifyTaskEvent,
  pushRecent,
  planSpeedToggle,
  humanSpeed,
  speedLimitLabel,
  buildTrayMenuTemplate,
  loadTrayState,
  saveTrayState,
  TRAY_STATE_FILE,
  RECENT_MAX,
  DEFAULT_TOGGLE_SPEED_LIMIT,
} from "../desktop/tray-feed.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NL = String.fromCharCode(10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn() is truthy, or fail with the caller's message. */
async function waitFor(fn, { timeoutMs = 30000, everyMs = 50, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await sleep(everyMs);
  }
}

const byId = (template, id) => template.find((x) => x.id === id) || null;

async function main() {
  const suite = new Suite("batch1-desktop-feedback");
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  // ---------------------------------------------------------- SSE 解析（纯）
  suite.group("SSE 解析：任意切分与脏输入");

  await suite.test("半帧跨 chunk、两帧同块、注释行、坏帧、CRLF 与流尾残帧", () => {
    const got = [];
    const p = createSseParser((e) => got.push(e));
    p.push("data: " + JSON.stringify({ type: "hello" }).slice(0, 12));  // 半个 JSON
    p.push(JSON.stringify({ type: "hello" }).slice(12) + "\n\n");       // 补齐 + 帧结束
    p.push('data: {"type":"updated","payload":{"id":"t1","status":"complete"}}\n\n' +
           'data: {"type":"added"}\n\n');                               // 两帧同块
    p.push(": ping\n\n");                                               // keep-alive 注释
    p.push("data: not-json-at-all\n\n");                                // 坏帧必须被丢弃
    p.push('data: {"type":"x"}\r\n\r\ndata: {"type":"y"}\r\n');         // CRLF + 无结尾空行
    p.flush();
    assert.deepEqual(got.map((e) => e.type), ["hello", "updated", "added", "x", "y"],
      "帧序列必须完整且坏帧/注释被跳过");
    assert.deepEqual(got[1].payload, { id: "t1", status: "complete" });
  });

  await suite.test("多行 data 按规范用换行拼接；hello 无 payload 也不报错", () => {
    const got = [];
    const p = createSseParser((e) => got.push(e));
    p.push('data: {"type":"multi",\ndata: "v":42}\n\n');
    p.push("data: " + JSON.stringify({ type: "hello" }) + "\n\n");
    p.flush();
    assert.equal(got.length, 2, "两帧都要出来，got=" + JSON.stringify(got));
    assert.deepEqual(got[0], { type: "multi", v: 42 });
    assert.equal("payload" in got[1], false, "hello 帧没有 payload 字段");
  });

  await suite.test("空块、纯注释块与无 type 的 JSON 一律静默丢弃", () => {
    const got = [];
    const p = createSseParser((e) => got.push(e));
    p.push("\n\n: only comment\n\n");
    p.push('data: {"noType":1}\n\n');
    p.push('data: [1,2,3]\n\n');
    p.push('data: {"type":"ok"}\n\n');
    p.flush();
    assert.deepEqual(got.map((e) => e.type), ["ok"]);
  });

  // ------------------------------------------------------ 事件分类（纯）
  suite.group("事件分类：只在真实跃迁时打扰用户");

  await suite.test("downloading→complete 触发一次，重复 complete 帧不触发", () => {
    const seen = new Map();
    assert.equal(classifyTaskEvent({ type: "updated", payload: { id: "t", status: "complete" } }, seen), null,
      "订阅前就是终态的历史任务不得弹泡");
    assert.equal(classifyTaskEvent({ type: "updated", payload: { id: "t", status: "downloading" } }, seen), null);
    const hit = classifyTaskEvent({ type: "updated",
      payload: { id: "t", status: "complete", filename: "a.zip", dir: "D:\\dl" } }, seen);
    assert.ok(hit, "downloading→complete 必须触发");
    assert.equal(hit.kind, "complete");
    assert.equal(hit.task.filename, "a.zip");
    assert.equal(hit.task.dir, "D:\\dl");
    assert.equal(classifyTaskEvent({ type: "updated", payload: { id: "t", status: "complete" } }, seen), null,
      "完成后的重复 updated 帧不得再次触发");
  });

  await suite.test("downloading→error 触发；progress/added/hello 与坏 payload 全部忽略", () => {
    const seen = new Map();
    seen.set("e", "downloading");
    const hit = classifyTaskEvent({ type: "updated", payload: { id: "e", status: "error", error: "boom" } }, seen);
    assert.ok(hit, "downloading→error 必须触发");
    assert.equal(hit.kind, "error");
    assert.equal(classifyTaskEvent({ type: "progress", payload: { id: "e" } }, seen), null);
    assert.equal(classifyTaskEvent({ type: "added", payload: { id: "e", status: "queued" } }, seen), null);
    assert.equal(classifyTaskEvent({ type: "hello" }, seen), null);
    assert.equal(classifyTaskEvent({ type: "updated", payload: null }, seen), null);
    assert.equal(classifyTaskEvent({ type: "updated", payload: { status: "complete" } }, seen), null,
      "没有 id 的帧不得触发");
    assert.equal(classifyTaskEvent({ type: "updated", payload: { id: "", status: "complete" } }, seen), null);
  });

  // ------------------------------------------- 最近完成 / 限速切换（纯）
  suite.group("最近完成列表与限速切换决策");

  await suite.test("pushRecent 保留 " + RECENT_MAX + " 条、最新在前、同 id 去重置顶", () => {
    assert.equal(RECENT_MAX, 3, "规格：最近完成 3 条");
    let list = [];
    for (const id of ["a", "b", "c", "d"]) {
      list = pushRecent(list, { id, filename: id + ".bin", dir: "D:\\" });
    }
    assert.deepEqual(list.map((x) => x.id), ["d", "c", "b"], "第 4 条挤掉最旧的");
    list = pushRecent(list, { id: "b", filename: "b.bin", dir: "D:\\" });
    assert.deepEqual(list.map((x) => x.id), ["b", "d", "c"], "同 id 去重并置顶");
    assert.deepEqual(pushRecent(null, { id: "x" }).map((x) => x.id), ["x"], "空历史也能插入");
  });

  await suite.test("planSpeedToggle：非零→0 并记住；0→恢复上次非零；从无记录→兜底档", () => {
    assert.deepEqual(planSpeedToggle(131072, 0), { next: 0, remember: 131072 },
      "关闭时必须记住正在生效的值");
    assert.deepEqual(planSpeedToggle(0, 131072), { next: 131072, remember: 131072 },
      "开启时恢复上次非零值");
    assert.deepEqual(planSpeedToggle(0, 0, DEFAULT_TOGGLE_SPEED_LIMIT), { next: DEFAULT_TOGGLE_SPEED_LIMIT, remember: DEFAULT_TOGGLE_SPEED_LIMIT },
      "从未设置过非零值时用兜底档，而不是切了个寂寞");
    assert.deepEqual(planSpeedToggle("bad", null, 1024), { next: 1024, remember: 1024 },
      "非数字输入按 0 处理");
    assert.equal(DEFAULT_TOGGLE_SPEED_LIMIT > 0, true, "兜底档必须是非零正值");
  });

  await suite.test("限速菜单文案随状态变化，速率人类可读", () => {
    assert.equal(humanSpeed(0), "0 B/s");
    assert.equal(humanSpeed(1536), "1.5 KB/s");
    assert.equal(humanSpeed(2097152), "2 MB/s");
    assert.equal(humanSpeed(3145728), "3 MB/s");
    assert.equal(speedLimitLabel(0), "限速：不限制（点击开启）");
    assert.equal(speedLimitLabel(2097152), "限速：2 MB/s（点击关闭）");
  });

  // ------------------------------------------------- 托盘菜单模板（纯）
  suite.group("托盘菜单模板：包6 新增项与旧三项");

  await suite.test("daemon 不可用：新增项全部禁用而非隐藏，占位可见", () => {
    const tpl = buildTrayMenuTemplate({ hasDaemon: false, recentCompleted: [], speedLimit: 0, openAtLogin: true });
    assert.equal(byId(tpl, "show").label, "显示主界面", "旧项保留");
    assert.equal(byId(tpl, "pause-all").label, "暂停全部");
    assert.equal(byId(tpl, "pause-all").enabled, false);
    assert.equal(byId(tpl, "resume-all").label, "恢复全部");
    assert.equal(byId(tpl, "resume-all").enabled, false);
    assert.equal(byId(tpl, "speed-toggle").label, "限速：不限制（点击开启）");
    assert.equal(byId(tpl, "speed-toggle").enabled, false);
    const recent = byId(tpl, "recent");
    assert.equal(recent.enabled, false);
    assert.deepEqual(recent.submenu.map((x) => x.label), ["（暂无完成记录）"]);
    assert.equal(byId(tpl, "autostart").type, "checkbox", "旧项保留");
    assert.equal(byId(tpl, "autostart").checked, true);
    assert.equal(byId(tpl, "quit").label, "退出", "旧项保留");
  });

  await suite.test("daemon 可用：菜单解锁，最近完成最多 3 条且 id 形如 open:<taskId>", () => {
    const recent = [
      { id: "t1", filename: "a.zip", dir: "D:\\dl" },
      { id: "t2", filename: "b.mp4", dir: "D:\\dl" },
      { id: "t3", filename: "c.pdf", dir: "D:\\dl" },
      { id: "t4", filename: "d.iso", dir: "D:\\dl" },   // 第 4 条必须被挤掉
    ];
    const tpl = buildTrayMenuTemplate({ hasDaemon: true, recentCompleted: recent, speedLimit: 2097152 });
    assert.equal(byId(tpl, "pause-all").enabled, true);
    assert.equal(byId(tpl, "resume-all").enabled, true);
    assert.equal(byId(tpl, "speed-toggle").label, "限速：2 MB/s（点击关闭）");
    assert.equal(byId(tpl, "speed-toggle").enabled, true);
    const r = byId(tpl, "recent");
    assert.equal(r.enabled, true);
    assert.equal(r.submenu.length, 3, "最多 3 条");
    assert.deepEqual(r.submenu.map((x) => x.id), ["open:t1", "open:t2", "open:t3"]);
    assert.deepEqual(r.submenu.map((x) => x.label), ["a.zip", "b.mp4", "c.pdf"]);
    assert.equal(r.submenu.every((x) => x.enabled), true);
  });

  // ------------------------------------------------- 托盘状态落盘（原子）
  suite.group("托盘状态落盘：写临时再改名，损坏回退默认");

  await suite.test("save→load 往返，无 .tmp 残留，损坏/缺失回退默认", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-tray-state-"));
    try {
      await saveTrayState(dir, { lastNonZeroSpeedLimit: 262144 });
      const st = await loadTrayState(dir);
      assert.equal(st.lastNonZeroSpeedLimit, 262144);
      const leftovers = (await fsp.readdir(dir)).filter((n) => n.includes(".tmp-"));
      assert.equal(leftovers.length, 0, "原子落盘不得残留临时文件: " + leftovers.join(","));
      await fsp.writeFile(path.join(dir, TRAY_STATE_FILE), "{broken json", "utf8");
      assert.equal((await loadTrayState(dir)).lastNonZeroSpeedLimit, 0, "损坏文件回退默认");
      assert.equal((await loadTrayState(path.join(dir, "no-such-dir"))).lastNonZeroSpeedLimit, 0,
        "缺失目录回退默认");
      await saveTrayState(path.join(dir, "nested"), { lastNonZeroSpeedLimit: 5 });
      assert.equal((await loadTrayState(path.join(dir, "nested"))).lastNonZeroSpeedLimit, 5,
        "saveTrayState 必须能自建目录");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ------------------------------------------------------- daemon 契约（集成）
  suite.group("daemon 契约：SSE 流、队列控制、限速写回、权威路径");

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-batch1-feedback-"));
  const out = path.join(home, "out");
  await fsp.mkdir(out, { recursive: true });
  process.env.DOWNLOADX_HOME = home;   // 隔离数据根，严禁触碰生产数据

  const origin = await startOrigin();
  const { Config } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { Downloader } = await import("../src/downloader.mjs");
  const { ApiServer } = await import("../src/api.mjs");

  const config = new Config(path.join(home, "config.json"));
  await config.load();
  await config.set({
    defaultDir: out,
    categorizeByType: false,
    maxConnections: 1,
    maxConcurrentDownloads: 2,
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

  const base = "http://127.0.0.1:" + listening.port;
  const call = async (method, route, body) => {
    const headers = { "x-downloadx-token": listening.token };
    if (body) headers["content-type"] = "application/json";
    const res = await fetch(base + route, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  };

  // 托盘主进程同款 SSE 客户端：同一解析器、同一读取循环。
  const events = [];
  const parser = createSseParser((e) => events.push(e));
  const sseAbort = new AbortController();
  let readLoop = null;

  const waitForEvent = async (pred, what, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events.filter(pred);
      if (found.length) return found;
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for " + what +
          "; frames seen: " + events.map((e) => e.type).join(","));
      }
      await sleep(50);
    }
  };

  try {
    // 事件流无 token 必须 401（token 鉴权语义未被包6触碰的回归锚点）。
    await suite.test("/api/events 无 token 或错 token 必须 401", async () => {
      const anon = await fetch(base + "/api/events");
      assert.equal(anon.status, 401);
      anon.body?.cancel?.().catch(() => {});
      const wrong = await fetch(base + "/api/events?token=" + "0".repeat(48));
      assert.equal(wrong.status, 401);
      wrong.body?.cancel?.().catch(() => {});
    });

    await suite.test("订阅 /api/events：先收 hello，随后的帧由同一解析器解析", async () => {
      const res = await fetch(base + "/api/events?token=" + encodeURIComponent(listening.token), {
        signal: sseAbort.signal,
        headers: { accept: "text/event-stream" },
      });
      assert.equal(res.status, 200, "SSE 订阅应 200");
      assert.match(String(res.headers.get("content-type") || ""), /text\/event-stream/);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      readLoop = (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.push(decoder.decode(value, { stream: true }));
          }
        } catch (err) {
          if (!sseAbort.signal.aborted) throw err;
        }
      })();
      await waitForEvent((e) => e.type === "hello", "hello 帧");
      assert.equal("payload" in events[0], false, "hello 帧无 payload（分类器不依赖它）");
    });

    // 快任务：让真实 daemon 走完 added→downloading→complete 的一条龙。
    const FAST_BYTES = 131072;
    const fastUrl = origin.origin + "/throttle/" + FAST_BYTES + "/32768/1";
    let fastId = null;

    await suite.test("真实完成事件的帧形状与分类器假设一致，且整流回放恰好触发一次", async () => {
      const added = await call("POST", "/api/tasks", { url: fastUrl, filename: "fast-one.bin" });
      assert.equal(added.status, 201);
      fastId = added.json.task.id;

      const downloading = await waitForEvent(
        (e) => e.type === "updated" && e.payload && e.payload.id === fastId && e.payload.status === "downloading",
        "downloading 帧");
      assert.ok(downloading.length >= 1);

      const done = await waitForEvent(
        (e) => e.type === "updated" && e.payload && e.payload.id === fastId && e.payload.status === "complete",
        "complete 帧", 60000);
      const payload = done[0].payload;
      // 气泡与打开文件依赖的字段：文件名、目录、字节数。
      assert.equal(payload.filename, "fast-one.bin");
      assert.equal(payload.dir, out);
      assert.equal(payload.downloadedBytes, FAST_BYTES);

      // 把整条真实事件流回放进分类器：恰好一次完成、零次失败。
      const seen = new Map();
      let completeHits = 0;
      let errorHits = 0;
      for (const evt of events) {
        const hit = classifyTaskEvent(evt, seen);
        if (!hit) continue;
        if (hit.task.id !== fastId) continue;
        if (hit.kind === "complete") completeHits += 1;
        if (hit.kind === "error") errorHits += 1;
      }
      assert.equal(completeHits, 1, "真实流回放必须恰好触发一次完成，得 " + completeHits);
      assert.equal(errorHits, 0);
    });

    await suite.test("气泡点击的数据源：location 给出权威路径且文件真实存在", async () => {
      const loc = await call("GET", "/api/tasks/" + encodeURIComponent(fastId) + "/location");
      assert.equal(loc.status, 200);
      assert.equal(loc.json.exists, true, "完成的文件必须真实存在");
      assert.equal(loc.json.path, path.join(out, "fast-one.bin"));
      assert.equal(fs.existsSync(loc.json.path), true);
    });

    // 慢任务：暂停全部 → 恢复全部，正是托盘两个新菜单项调用的端点。
    const SLOW_BYTES = 2 * 1024 * 1024;
    const slowUrl = origin.origin + "/throttle/" + SLOW_BYTES + "/32768/15";
    let slowId = null;
    const taskById = async (id) => (await call("GET", "/api/tasks/" + id)).json.task ?? null;

    await suite.test("暂停全部/恢复全部：POST /api/queue/pause|resume 真实生效", async () => {
      const added = await call("POST", "/api/tasks", { url: slowUrl, filename: "slow-two.bin" });
      assert.equal(added.status, 201);
      slowId = added.json.task.id;

      await waitFor(async () => {
        const t = await taskById(slowId);
        return t && t.status === "downloading" && t.downloadedBytes > 0;
      }, { what: "慢任务产生字节" });

      const paused = await call("POST", "/api/queue/pause");
      assert.equal(paused.status, 200, "暂停全部应 200");
      assert.equal(typeof paused.json.active, "number", "返回队列统计");
      await waitFor(async () => {
        const t = await taskById(slowId);
        return t && t.status === "paused";
      }, { what: "任务进入 paused" });

      const resumed = await call("POST", "/api/queue/resume");
      assert.equal(resumed.status, 200, "恢复全部应 200");
      await waitFor(async () => {
        const t = await taskById(slowId);
        if (!t) return false;
        if (t.status === "error") throw new Error("resume failed: " + t.error);
        return t.status === "complete";
      }, { what: "恢复后完成", timeoutMs: 60000 });
      assert.equal(fs.existsSync(path.join(out, "slow-two.bin")), true);
      // 暂停/恢复的状态跃迁经分类器不得误报失败。
      const seen = new Map();
      const errs = events.filter((e) => e.type === "updated" && e.payload && e.payload.id === slowId)
        .map((e) => classifyTaskEvent(e, seen)).filter((h) => h && h.kind === "error");
      assert.equal(errs.length, 0, "paused 跃迁不是失败，不得触发失败气泡");
    });

    await suite.test("限速开关写回路径：GET/PATCH /api/config 的 speedLimit 往返", async () => {
      const before = await call("GET", "/api/config");
      assert.equal(before.status, 200);
      assert.equal(before.json.config.speedLimit, 0, "默认不限制");

      const on = await call("PATCH", "/api/config", { speedLimit: 131072 });
      assert.equal(on.status, 200);
      assert.equal(on.json.config.speedLimit, 131072, "写回 128 KB/s");
      const reread = await call("GET", "/api/config");
      assert.equal(reread.json.config.speedLimit, 131072, "写回必须持久（托盘下次重建菜单可见）");

      const off = await call("PATCH", "/api/config", { speedLimit: 0 });
      assert.equal(off.status, 200);
      assert.equal(off.json.config.speedLimit, 0, "切回 0");
    });
  } finally {
    sseAbort.abort();   // 断开 SSE，读循环随 abort 结束
    await Promise.race([readLoop, sleep(1500)]).catch(() => {});
    await api.close().catch(() => {});
    await new Promise((r) => {
      try { origin.server.closeAllConnections?.(); } catch { /* none */ }
      origin.close().then(r, r);
      setTimeout(r, 1500);
    });
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch1-desktop-feedback crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
