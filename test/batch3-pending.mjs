#!/usr/bin/env node
// 批-3 回归 P-1:挂起表(ask-before-add)全生命周期——横幅数据链、状态留痕、
// 停机 flush 防丢。
//
// 背景(待修问题清单 P-1 / 施工记录附记九,2026-10-24):用户点 B站悬浮条后收到
// "已挂起"系统通知(证明 daemon 曾应答 202+pending),但 GUI 批准横幅从未出现;
// 事后 /api/pending 为空、任务列表无该 URL、daemon 日志零相关行——挂起条目
// 无声消失,无法归因。
//
// 本套件锁定的行为:
//   R1 横幅数据链:extension 来源 POST /api/tasks → 202+pending → GET
//      /api/pending 可见 → SSE pending_added/pending_resolved 帧可达 →
//      真实浏览器(headless Edge)里横幅元素实际显示并随 reject 消失。
//   R2 全生命周期日志:创建/批准/拒绝/超时入队/停机flush/冲突丢弃 各留一行,
//      任何离开挂起表的路径都有痕迹,"无声消失"不再可能。
//   R3 stop() 的 flushToQueue 失败不得静默丢条目:记 WARN 且条目保留在挂起表。
//   R4 完整回归链:202→SSE 帧→横幅数据就绪→approve 入队→reject→超时入队→
//      停机 flush(重启后任务仍在)。
//
// 纪律:临时 DOWNLOADX_HOME,绝不读写 D:/IAM/downloadx-data;浏览器仅
// headless(无窗口);所有 daemon/SSE/浏览器/origin 全部收尾,进程干净退出。
//
// Usage: node test/batch3-pending.mjs

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { startOrigin } from "./origin.mjs";
import { findBrowser, launchBrowser, Cdp, pageTarget } from "./gui-browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** Poll until fn() returns truthy, or throw with `what`. */
async function waitFor(fn, { timeoutMs = 30000, everyMs = 100, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Literal string -> RegExp fragment. */
const rx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Minimal SSE client over fetch: yields parsed `data:` frames in order. */
async function sseConnect(port, token) {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/events?token=${encodeURIComponent(token)}`, {
    signal: controller.signal,
    headers: { accept: "text/event-stream" },
  });
  if (res.status !== 200) throw new Error("SSE connect answered HTTP " + res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buf = "";
  let closed = false;
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = raw.split(/\r?\n/).find((l) => l.startsWith("data: "));
          if (!line) continue;
          try { frames.push(JSON.parse(line.slice(6))); } catch { /* not JSON */ }
        }
      }
    } catch { /* aborted */ }
    closed = true;
  })();
  return {
    /** Next frame matching pred, or null on timeout/stream end. */
    next(pred, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolve) => {
        const tick = () => {
          const i = frames.findIndex(pred);
          if (i >= 0) return resolve(frames.splice(i, 1)[0]);
          if (closed || Date.now() > deadline) return resolve(null);
          setTimeout(tick, 50);
        };
        tick();
      });
    },
    close() { controller.abort(); },
  };
}

/** Boot an in-process Daemon on a fresh temp home (the gui-browser suite's pattern). */
async function bootDaemon() {
  const { Daemon } = await import("../src/daemon.mjs");
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b3-pending-"));
  const previousHome = process.env.DOWNLOADX_HOME;
  process.env.DOWNLOADX_HOME = home;
  const daemon = await new Daemon({ port: 0 }).init();
  daemon.clipboard.stop();   // never read the real clipboard
  await daemon.config.set({
    defaultDir: path.join(home, "downloads"),
    categorizeByType: false,
    overwriteExisting: "rename",
    monitorClipboard: false,
  });
  const runtime = await daemon.start();
  daemon.clipboard.stop();
  return { daemon, home, runtime, previousHome };
}

async function readLog(home) {
  try { return await fsp.readFile(path.join(home, "logs", "downloadx.log"), "utf8"); }
  catch { return ""; }
}

async function run() {
  let failures = 0;
  const results = [];
  const diag = [];
  const homes = [];
  const daemons = [];
  const sseClients = [];
  let launched = null;
  let cdp = null;
  const origin = await startOrigin();

  const api = (rt, method, route, body) => {
    const headers = { "x-downloadx-token": rt.token };
    if (body) headers["content-type"] = "application/json";
    return fetch("http://127.0.0.1:" + rt.port + route, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    }).then(async (res) => {
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      return { status: res.status, json };
    });
  };

  const test = async (name, fn) => {
    try {
      await fn();
      results.push("  PASS  " + name);
    } catch (err) {
      failures++;
      results.push("  FAIL  " + name + "\n          " + String((err && err.message) || err));
    }
  };

  // A fresh daemon+home for the main lifecycle chain, then dedicated ones for
  // the flush and flush-failure groups, so stop() ordering cannot interfere.
  let ctx = null;

  try {
    ctx = await bootDaemon();
    daemons.push(ctx.daemon);
    homes.push(ctx.home);
    const { daemon, home, runtime } = ctx;

    // ------------------------------------------------ R1: the visible chain
    const heldUrl = origin.origin + "/range/65536?case=p1-banner";
    let heldId = null;

    await test("extension add answers 202 + pending view with the fields the banner renders", async () => {
      const r = await api(runtime, "POST", "/api/tasks", {
        url: heldUrl, filename: "p1-banner.bin", queueId: "extension",
      });
      if (r.status !== 202) throw new Error("expected 202, got " + r.status + " " + JSON.stringify(r.json));
      const p = r.json.pending || {};
      heldId = p.id;
      if (!heldId) throw new Error("response must carry pending.id");
      for (const field of ["url", "filename", "queueId", "createdAt", "expiresAt"]) {
        if (!(field in p)) throw new Error("pending view is missing " + field + " (renderPendBanner reads it)");
      }
      if (p.queueId !== "extension") throw new Error("queueId must stay extension, got " + p.queueId);
      const tasks = (await api(runtime, "GET", "/api/tasks")).json.tasks.filter((t) => t.url === heldUrl);
      if (tasks.length) throw new Error("a held add must not enter the queue yet");
    });

    await test("GET /api/pending lists the entry (the GUI 2s poll sees it)", async () => {
      const list = (await api(runtime, "GET", "/api/pending")).json.pending || [];
      const hit = list.find((p) => p.id === heldId);
      if (!hit) throw new Error("entry " + heldId + " not in /api/pending: " + JSON.stringify(list));
      if (hit.url !== heldUrl) throw new Error("url mismatch");
    });

    await test("creation leaves one log line (R2: 创建)", async () => {
      const log = await readLog(home);
      if (!new RegExp("pending: held " + rx(heldUrl)).test(log)) {
        throw new Error("no 'pending: held' line for the created entry; log tail:\n" + log.split(/\r?\n/).slice(-8).join("\n"));
      }
    });

    // SSE: subscribe, then hold+reject a second URL and watch both frames.
    const sseUrl = origin.origin + "/range/65536?case=p1-sse";
    let sseFrameAdded = null;
    let sseFrameResolved = null;
    const sse = await sseConnect(runtime.port, runtime.token);
    sseClients.push(sse);

    await test("SSE delivers pending_added and pending_resolved frames (R4: SSE 帧)", async () => {
      const held = await api(runtime, "POST", "/api/tasks", { url: sseUrl, filename: "p1-sse.bin", queueId: "extension" });
      if (held.status !== 202) throw new Error("expected 202, got " + held.status);
      const add = await sse.next((f) => f.type === "pending_added" && f.payload && f.payload.url === sseUrl, 10000);
      if (!add) throw new Error("no pending_added frame for " + sseUrl);
      sseFrameAdded = add;
      if (add.payload.id !== held.json.pending.id) throw new Error("frame id mismatch");
      const rej = await api(runtime, "POST", "/api/pending/" + encodeURIComponent(held.json.pending.id) + "/reject");
      if (rej.status !== 200) throw new Error("reject answered " + rej.status);
      const resolved = await sse.next((f) => f.type === "pending_resolved" && f.payload && f.payload.id === held.json.pending.id, 10000);
      if (!resolved) throw new Error("no pending_resolved frame after reject");
      if (resolved.payload.action !== "rejected") throw new Error("resolved action must be rejected, got " + resolved.payload.action);
      sseFrameResolved = resolved;
    });
    if (!sseFrameAdded || !sseFrameResolved) {
      diag.push("SSE frames missing: added=" + JSON.stringify(sseFrameAdded) + " resolved=" + JSON.stringify(sseFrameResolved));
    }

    await test("approve enqueues through queue.add and logs one line (R4: approve 入队, R2: 批准)", async () => {
      const r = await api(runtime, "POST", "/api/pending/" + encodeURIComponent(heldId) + "/approve", { filename: "p1-approved.bin" });
      if (r.status !== 201) throw new Error("expected 201, got " + r.status + " " + JSON.stringify(r.json));
      const id = r.json.task.id;
      const t = (await api(runtime, "GET", "/api/tasks/" + id)).json.task;
      if (!t) throw new Error("approved task not in the queue");
      if (t.filename !== "p1-approved.bin") throw new Error("filename override lost: " + t.filename);
      const list = (await api(runtime, "GET", "/api/pending")).json.pending || [];
      if (list.some((p) => p.id === heldId)) throw new Error("approved entry must leave the pending table");
      const log = await readLog(home);
      if (!new RegExp("pending: approved .*" + rx(heldUrl)).test(log)) {
        throw new Error("no 'pending: approved' log line; log tail:\n" + log.split(/\r?\n/).slice(-8).join("\n"));
      }
    });

    await test("reject drops the entry and logs one line (R4: reject, R2: 拒绝)", async () => {
      const url = origin.origin + "/range/65536?case=p1-reject";
      const held = await api(runtime, "POST", "/api/tasks", { url, queueId: "extension" });
      if (held.status !== 202) throw new Error("expected 202, got " + held.status);
      const r = await api(runtime, "POST", "/api/pending/" + encodeURIComponent(held.json.pending.id) + "/reject");
      if (r.status !== 200) throw new Error("reject answered " + r.status);
      const list = (await api(runtime, "GET", "/api/pending")).json.pending || [];
      if (list.length) throw new Error("pending table must be empty after reject, got " + JSON.stringify(list));
      const tasks = (await api(runtime, "GET", "/api/tasks")).json.tasks.filter((t) => t.url === url);
      if (tasks.length) throw new Error("reject must not queue anything");
      const log = await readLog(home);
      if (!new RegExp("pending: rejected .*" + rx(url)).test(log)) {
        throw new Error("no 'pending: rejected' log line; log tail:\n" + log.split(/\r?\n/).slice(-8).join("\n"));
      }
    });

    // --------------------------------- R1 GUI: the banner in a real browser
    const browser = findBrowser();
    if (!browser) {
      results.push("  SKIP  GUI banner shows in a real browser (no Chrome/Edge on this host)");
    } else {
      await test("GUI approval banner shows in a real browser and hides on reject (R1: 横幅)", async () => {
        launched = await launchBrowser({ browser, port: 9337 });
        const target = await pageTarget(launched.port);
        cdp = await Cdp.connect(target.webSocketDebuggerUrl);
        await cdp.send("Page.enable");
        await cdp.send("Runtime.enable");
        await cdp.send("Page.navigate", { url: runtime.url });
        await waitFor(async () => cdp.eval("document.readyState === 'complete'"), { what: "the GUI page to load" });
        await waitFor(() => cdp.eval("!!(window.__DOWNLOADX__ && window.__DOWNLOADX__.token)"), { what: "the token to be injected" });
        await waitFor(() => cdp.eval("/\\d+\\s*\\/\\s*\\d+/.test(document.getElementById('ovActive').textContent)"), { what: "the overview bar to render" });

        // Exactly the extension host's shape: queueId marks the source.
        const bannerUrl = origin.origin + "/range/65536?case=p1-gui-banner";
        const held = await api(runtime, "POST", "/api/tasks", {
          url: bannerUrl, filename: "p1-gui-banner.bin", queueId: "extension",
        });
        if (held.status !== 202) throw new Error("expected 202, got " + held.status);

        const shown = await waitFor(() => cdp.eval(
          "document.getElementById('pendBanner').classList.contains('show') && document.getElementById('pendList').textContent.includes('p1-gui-banner.bin')",
        ), { timeoutMs: 15000, what: "the approval banner to appear in the DOM" });
        if (!shown) throw new Error("banner never showed");

        const src = await cdp.eval("document.getElementById('pendList').textContent");
        if (!src.includes("浏览器扩展")) throw new Error("banner must name the extension source, got: " + src);

        const rej = await api(runtime, "POST", "/api/pending/" + encodeURIComponent(held.json.pending.id) + "/reject");
        if (rej.status !== 200) throw new Error("reject answered " + rej.status);
        await waitFor(() => cdp.eval("!document.getElementById('pendBanner').classList.contains('show')"),
          { timeoutMs: 15000, what: "the banner to hide after reject" });
      });
    }

    // ------------------------------------------- timeout paths (1s timeout)
    await test("timeout auto-queues to the default dir and logs one line (R4: 超时入队, R2: 超时)", async () => {
      const patched = await api(runtime, "PATCH", "/api/config", { askBeforeAddTimeoutMs: 1000 });
      if (patched.status !== 200) throw new Error("config PATCH answered " + patched.status);
      const url = origin.origin + "/range/65536?case=p1-timeout";
      const held = await api(runtime, "POST", "/api/tasks", { url, queueId: "extension" });
      if (held.status !== 202) throw new Error("expected 202, got " + held.status);
      const t = await waitFor(async () => {
        const tasks = (await api(runtime, "GET", "/api/tasks")).json.tasks.filter((x) => x.url === url);
        return tasks[0] || false;
      }, { timeoutMs: 15000, what: "the timed-out entry to be queued" });
      if (t.dir && t.dir !== path.join(home, "downloads")) {
        throw new Error("timeout must fall back to the default dir, got " + t.dir);
      }
      const log = await readLog(home);
      if (!new RegExp("pending: timeout .*queued.*" + rx(url)).test(log)) {
        throw new Error("no 'pending: timeout' log line; log tail:\n" + log.split(/\r?\n/).slice(-8).join("\n"));
      }
    });

    await test("timeout against a live same-URL task is logged, never silent (R2: 冲突丢弃)", async () => {
      const url = origin.origin + "/throttle/1048576/4096/40?case=p1-superseded";   // ~10 s transfer
      const held = await api(runtime, "POST", "/api/tasks", { url, queueId: "extension" });
      if (held.status !== 202) throw new Error("expected 202, got " + held.status);
      const manual = await api(runtime, "POST", "/api/tasks", { url });   // no queueId: direct add
      if (manual.status !== 201) throw new Error("manual add answered " + manual.status + " " + JSON.stringify(manual.json));
      const before = ((await api(runtime, "GET", "/api/tasks")).json.tasks).filter((t) => t.url === url).length;
      await waitFor(async () => {
        const list = (await api(runtime, "GET", "/api/pending")).json.pending || [];
        return !list.some((p) => p.url === url);
      }, { timeoutMs: 15000, what: "the superseded pending entry to leave the table" });
      const after = ((await api(runtime, "GET", "/api/tasks")).json.tasks).filter((t) => t.url === url).length;
      if (after !== before) throw new Error("superseded resolve must not create a second task");
      const log = await readLog(home);
      if (!new RegExp("\\[WARN\\] pending: .*superseded.*" + rx(url)).test(log)) {
        throw new Error("superseded drop must leave a WARN line; log tail:\n" + log.split(/\r?\n/).slice(-8).join("\n"));
      }
      await api(runtime, "POST", "/api/tasks/" + manual.json.task.id + "/cancel").catch(() => {});
    });

    // ------------------------------------------- stop() flush, with restart
    let flushGroup = null;
    await test("stop() flush queues waiting entries, logs, and they survive a restart (R4: 停机 flush, R2: flush)", async () => {
      flushGroup = await bootDaemon();
      daemons.push(flushGroup.daemon);
      homes.push(flushGroup.home);
      const { daemon: d2, home: h2, runtime: rt2 } = flushGroup;
      const url = origin.origin + "/range/65536?case=p1-flush";
      const held = await api(rt2, "POST", "/api/tasks", { url, filename: "p1-flush.bin", queueId: "extension" });
      if (held.status !== 202) throw new Error("expected 202, got " + held.status);
      if (!((await api(rt2, "GET", "/api/pending")).json.pending || []).some((p) => p.url === url)) {
        throw new Error("entry not held before stop");
      }
      await d2.stop();
      const log = await readLog(h2);
      if (!new RegExp("pending: shutdown flush .*queued.*" + rx(url)).test(log)) {
        throw new Error("no 'pending: shutdown flush' log line; log tail:\n" + log.split(/\r?\n/).slice(-8).join("\n"));
      }
      const saved = JSON.parse(await fsp.readFile(path.join(h2, "queue.json"), "utf8"));
      if (!(saved.tasks || []).some((t) => t.url === url)) {
        throw new Error("flushed entry missing from queue.json: " + JSON.stringify(saved.tasks && saved.tasks.map((t) => t.url)));
      }
      // Graceful stop must leave no ownership artefacts behind.
      await fsp.access(path.join(h2, "runtime.json")).then(() => { throw new Error("runtime.json must be removed by stop()"); }, () => {});
      await fsp.access(path.join(h2, "daemon.lock")).then(() => { throw new Error("daemon.lock must be removed by stop()"); }, () => {});

      // Restart on the same home: the flushed task is still there.
      const { Daemon } = await import("../src/daemon.mjs");
      const savedHome = process.env.DOWNLOADX_HOME;
      process.env.DOWNLOADX_HOME = h2;
      const d3 = await new Daemon({ port: 0 }).init();
      d3.clipboard.stop();
      const rt3 = await d3.start();
      d3.clipboard.stop();
      process.env.DOWNLOADX_HOME = savedHome;
      daemons.push(d3);
      const tasks = (await api(rt3, "GET", "/api/tasks")).json.tasks;
      if (!tasks.some((t) => t.url === url)) {
        throw new Error("flushed task not visible after restart: " + JSON.stringify(tasks.map((t) => t.url)));
      }
      await d3.stop();
    });

    // -------------------------------------- R3: flush failure keeps entries
    await test("a failing queue.add during stop() flush WARNs and keeps the entry (R3)", async () => {
      const g = await bootDaemon();
      daemons.push(g.daemon);
      homes.push(g.home);
      const { daemon: d4, home: h4, runtime: rt4 } = g;
      const url = origin.origin + "/range/65536?case=p1-flush-fail";
      const held = await api(rt4, "POST", "/api/tasks", { url, filename: "p1-flush-fail.bin", queueId: "extension" });
      if (held.status !== 202) throw new Error("expected 202, got " + held.status);
      const boom = new Error("simulated queue failure");
      d4.queue.add = () => { throw boom; };   // flush path must survive this
      await d4.stop();
      const log = await readLog(h4);
      if (!new RegExp("\\[WARN\\] pending: shutdown flush failed for " + rx(url) + ": simulated queue failure").test(log)) {
        throw new Error("no WARN naming the kept entry; log tail:\n" + log.split(/\r?\n/).slice(-8).join("\n"));
      }
      const kept = [...d4.pending.items.values()].some((r) => r.url === url);
      if (!kept) throw new Error("the failed entry must stay in the pending table, not be dropped");
    });

    await test("a failing queue.add at timeout re-arms instead of crashing the daemon (R3 sibling)", async () => {
      // Unit level: a queue.add that throws inside the timeout timer used to
      // escape as an uncaught exception (process-killing) after the entry had
      // already been deleted. Now the entry is kept and the timeout retried.
      const { PendingManager } = await import("../src/daemon.mjs");
      const lines = [];
      const pm = new PendingManager({
        config: { get: (k) => (k === "askBeforeAddTimeoutMs" ? 1000 : true) },
        queue: { tasks: new Map(), add() { throw new Error("boom"); } },
        log: { info: (m) => lines.push(m), warn: (m) => lines.push(m) },
      });
      pm.add({ url: "http://127.0.0.1:1/timeout-fail.bin", queueId: "extension" });
      await new Promise((r) => setTimeout(r, 2600));   // first fire + one re-arm
      pm.dispose();
      if (!lines.some((l) => l.includes("pending: held "))) throw new Error("creation line missing: " + JSON.stringify(lines));
      const warns = lines.filter((l) => l.includes("timeout failed for") && l.includes("entry kept"));
      if (warns.length < 2) throw new Error("expected the re-armed timeout to retry and WARN again, got " + JSON.stringify(lines));
      if (pm.items.size !== 1) throw new Error("the failed entry must stay in the pen, items=" + pm.items.size);
    });
  } finally {
    for (const s of sseClients) s.close();
    if (cdp) { try { cdp.close(); } catch { /* gone */ } }
    if (launched) await launched.close();
    for (const d of daemons) {
      if (d && d.started) { try { await d.stop(); } catch (err) { diag.push("daemon stop: " + err.message); } }
    }
    if (ctx && ctx.previousHome === undefined) delete process.env.DOWNLOADX_HOME;
    else if (ctx) process.env.DOWNLOADX_HOME = ctx.previousHome;
    await new Promise((r) => {
      try { origin.server.closeAllConnections?.(); } catch { /* none */ }
      origin.close().then(r);
      setTimeout(r, 1500);
    });
    for (const h of homes) await fsp.rm(h, { recursive: true, force: true }).catch(() => {});
  }

  for (const line of results) process.stdout.write(line + "\n");
  if (diag.length) process.stdout.write("  diag:\n" + diag.map((d) => "    " + d).join("\n") + "\n");
  process.stdout.write(failures ? "  " + failures + " failed\n" : "  all passed\n");
  return failures;
}

run()
  .then((failures) => { process.exitCode = failures ? 1 : 0; })
  .catch((err) => {
    process.stderr.write("batch3-pending crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
