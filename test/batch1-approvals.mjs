// Batch-1 regression: ask-before-add pending approvals + same-URL 409.
//
// The behaviour asserted here (task sheet 包5):
//   (a) askBeforeAdd defaults to on, and a POST /api/tasks marked as
//       extension-sourced (queueId "extension") is HELD: it lands in
//       GET /api/pending with a pendingId, an SSE "pending_added" frame is
//       pushed, and no task exists yet. A manual add (no queueId) still
//       enters the queue directly with 201.
//   (b) The same URL held twice deduplicates to one pending entry.
//   (c) POST /api/pending/:id/approve queues it through the ordinary
//       queue.add path, applying optional dir/filename/category overrides;
//       the file really downloads to the overridden directory, and page
//       context (headers) captured with the add reaches the task.
//   (d) POST /api/pending/:id/reject forgets the entry, nothing is queued,
//       and unknown ids answer 404 on both verbs.
//   (e) After askBeforeAddTimeoutMs the entry queues itself to the DEFAULT
//       directory — never silently dropped.
//   (f) POST /api/tasks of a URL with a live task (queued / connecting /
//       downloading / paused) answers 409 {error:"task already in queue",
//       existingTaskId}; removing the task unblocks the URL again.
//   (g) Every new route requires the token: no token or a wrong one, 401.
//   (h) Daemon-side wiring: a clipboard URL is held the same way and can be
//       approved, and an orderly stop() flushes still-pending entries into
//       the queue instead of dropping them.
//
// Everything runs against a local origin and isolated DOWNLOADX_HOME(s), so
// no public network, no user Downloads, no %APPDATA%\downloadx, and the real
// clipboard is never touched (the watcher is stopped and driven by its own
// event).
//
// Usage: node test/batch1-approvals.mjs

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";
import { startOrigin } from "./origin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const NL = String.fromCharCode(10);

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

async function main() {
  const suite = new Suite("batch1-approvals");
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b1-approvals-"));
  const out = path.join(home, "out");
  const out2 = path.join(home, "out2");
  await fsp.mkdir(out, { recursive: true });
  await fsp.mkdir(out2, { recursive: true });
  process.env.DOWNLOADX_HOME = home;

  const origin = await startOrigin();
  const { Config } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { Downloader } = await import("../src/downloader.mjs");
  const { ApiServer } = await import("../src/api.mjs");
  const { PendingManager } = await import("../src/daemon.mjs");

  const config = new Config(path.join(home, "config.json"));
  await config.load();
  await config.set({
    defaultDir: out,
    categorizeByType: false,
    maxConnections: 2,
    maxConcurrentDownloads: 2,
    segmentBytes: 262144,
    overwriteExisting: "rename",
    proxy: "",
    proxyMode: "none",
    // askBeforeAdd stays at its default (on); the test asserts the default
    // gating, not a fixture-turned-on gate.
  });
  assert.equal(config.get("askBeforeAdd"), true, "askBeforeAdd must default to true");

  const queue = new QueueManager({ config });
  await queue.load();
  const downloader = new Downloader({ config, queue });
  const pending = new PendingManager({ config, queue, log: null });
  const api = new ApiServer({
    queue, config, downloader, pending,
    log: { info() {}, warn() {}, error() {}, tail: () => [] },
  }).startRunner();
  pending.onPush = (type, payload) => api.pushEvent(type, payload);
  const listening = await api.listen({ port: 0 });

  const call = async (method, route, body, { token = listening.token } = {}) => {
    const headers = token ? { "x-downloadx-token": token } : {};
    if (body) headers["content-type"] = "application/json";
    const res = await fetch("http://127.0.0.1:" + listening.port + route, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  };

  // ---- SSE: one subscription for the whole run, frames collected here.
  const events = [];
  const sseAbort = new AbortController();
  const sseDone = (async () => {
    const res = await fetch("http://127.0.0.1:" + listening.port + "/api/events?token=" + encodeURIComponent(listening.token),
      { signal: sseAbort.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (line) { try { events.push(JSON.parse(line.slice(6))); } catch { /* keep-alive comment */ } }
      }
    }
  })().catch(() => { /* aborted at teardown */ });
  const waitForEvent = (pred, what) =>
    waitFor(() => events.find(pred) ?? false, { what: "SSE frame: " + what });

  const pendingList = async () => (await call("GET", "/api/pending")).json.pending;
  const tasksFor = async (url) => {
    const payload = (await call("GET", "/api/tasks")).json;
    return (payload.tasks || []).filter((t) => t.url === url);
  };
  const taskById = async (id) => (await call("GET", "/api/tasks/" + id)).json.task ?? null;

  // Distinct URLs per scenario; the origin ignores the query string.
  const heldUrl = origin.origin + "/range/65536?case=held";
  const manualUrl = origin.origin + "/range/65536?case=manual";
  const rejectUrl = origin.origin + "/range/65536?case=rejected";
  const timeoutUrl = origin.origin + "/range/65536?case=timeout";
  const dupUrl = origin.origin + "/throttle/2097152/32768/40?case=dup409";

  try {
    await waitForEvent((e) => e.type === "hello", "hello");

    // ------------------------------------------------------------- auth 401
    suite.group("pending routes require the token");

    await suite.test("no token or wrong token answers 401 on every new route", async () => {
      assert.equal((await call("GET", "/api/pending", undefined, { token: null })).status, 401);
      assert.equal((await call("GET", "/api/pending", undefined, { token: "deadbeef" })).status, 401);
      assert.equal((await call("POST", "/api/pending/x/approve", { dir: out }, { token: null })).status, 401);
      assert.equal((await call("POST", "/api/pending/x/reject", undefined, { token: null })).status, 401);
      // The gate itself must not become a tokenless side door.
      assert.equal((await call("POST", "/api/tasks", { url: heldUrl, queueId: "extension" }, { token: null })).status, 401);
    });

    // ------------------------------------------------- held vs direct add
    suite.group("askBeforeAdd holds extension adds, not manual ones");

    let heldId = null;
    await suite.test("an extension-marked add is held with a pendingId, not queued", async () => {
      const r = await call("POST", "/api/tasks", {
        url: heldUrl,
        queueId: "extension",
        filename: "approved.bin",
        headers: { Cookie: "SESSDATA=held-secret" },
      });
      assert.equal(r.status, 202, "a held add answers 202, got " + r.status + " " + JSON.stringify(r.json));
      assert.ok(r.json.pending && r.json.pending.id, "the response must carry the pending entry");
      assert.equal(r.json.duplicate, false);
      heldId = r.json.pending.id;
      assert.equal(r.json.pending.url, heldUrl);
      assert.equal(r.json.pending.queueId, "extension");
      assert.equal(r.json.pending.filename, "approved.bin");
      assert.ok(r.json.pending.expiresAt > Date.now(), "the entry must say when it times out");
      // Credentials captured with the add must not leak through the view.
      assert.equal("headers" in r.json.pending, false, "pending views must not carry headers");
      assert.equal("cookies" in r.json.pending, false, "pending views must not carry cookies");

      const list = await pendingList();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, heldId);
      assert.equal((await tasksFor(heldUrl)).length, 0, "no task may exist for a held add");
    });

    await suite.test("SSE pushed a pending_added frame with the same id", async () => {
      const frame = await waitForEvent((e) => e.type === "pending_added" && e.payload && e.payload.id === heldId,
        "pending_added for the held url");
      assert.equal(frame.payload.url, heldUrl);
      assert.equal(frame.payload.queueId, "extension");
      assert.ok(typeof frame.at === "number", "frames keep the shared {type,payload,at} shape");
    });

    await suite.test("a manual add (no queueId) still enters the queue directly", async () => {
      const r = await call("POST", "/api/tasks", { url: manualUrl, filename: "manual-direct.bin" });
      assert.equal(r.status, 201, "manual adds keep 201, got " + r.status);
      assert.ok(r.json.task && r.json.task.id);
      assert.equal((await tasksFor(manualUrl)).length, 1);
    });

    await suite.test("holding the same URL twice deduplicates to one entry", async () => {
      const again = await call("POST", "/api/tasks", { url: heldUrl, queueId: "extension", filename: "approved.bin" });
      assert.equal(again.status, 202);
      assert.equal(again.json.duplicate, true, "the second hold must be flagged as a duplicate");
      assert.equal(again.json.pending.id, heldId, "the duplicate must point at the existing entry");
      assert.equal((await pendingList()).length, 1, "still exactly one pending entry");
    });

    // ------------------------------------------------------------- approve
    suite.group("approve queues with overrides");

    await suite.test("approve applies dir/filename overrides and the file lands there", async () => {
      const r = await call("POST", "/api/pending/" + heldId + "/approve", { dir: out2, filename: "approved.bin", category: "video" });
      assert.equal(r.status, 201, "expected 201, got " + r.status + " " + JSON.stringify(r.json));
      const task = r.json.task;
      assert.equal(task.dir, out2, "the directory override must reach the task");
      assert.equal(task.filename, "approved.bin");
      assert.equal(r.json.pendingId, heldId);

      assert.equal((await pendingList()).length, 0, "approving must empty the pending list");
      assert.equal((await tasksFor(heldUrl)).length, 1, "the approved add must be one task");

      // Page context captured at add time must reach the task, not the view.
      const raw = queue.get(task.id);
      assert.ok(raw && raw.headers && raw.headers.Cookie === "SESSDATA=held-secret",
        "the extension's page context must survive into the task");

      const done = await waitFor(async () => {
        const t = await taskById(task.id);
        if (t && t.status === "error") throw new Error("approved task failed: " + t.error);
        return t && t.status === "complete" ? t : false;
      }, { what: "the approved download to complete" });
      assert.equal(done.dir, out2);
      assert.equal(fs.existsSync(path.join(out2, "approved.bin")), true,
        "the file must land in the overridden directory");
      assert.equal(fs.statSync(path.join(out2, "approved.bin")).size, 65536);

      const frame = await waitForEvent((e) => e.type === "pending_resolved" && e.payload && e.payload.id === heldId,
        "pending_resolved for the approval");
      assert.equal(frame.payload.action, "approved");
      assert.equal(frame.payload.taskId, task.id);
    });

    await suite.test("approve of an unknown or already-resolved id answers 404", async () => {
      assert.equal((await call("POST", "/api/pending/" + heldId + "/approve", {})).status, 404);
      assert.equal((await call("POST", "/api/pending/no-such-id/approve", {})).status, 404);
    });

    // -------------------------------------------------------------- reject
    suite.group("reject");

    await suite.test("reject forgets the entry without queuing anything", async () => {
      const held = await call("POST", "/api/tasks", { url: rejectUrl, queueId: "extension" });
      assert.equal(held.status, 202);
      const id = held.json.pending.id;

      const r = await call("POST", "/api/pending/" + id + "/reject");
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.rejected, true);

      assert.equal((await pendingList()).length, 0);
      assert.equal((await tasksFor(rejectUrl)).length, 0, "a rejected add must never become a task");
      assert.equal((await call("POST", "/api/pending/" + id + "/reject")).status, 404,
        "a second reject is a deliberate 404");

      const frame = await waitForEvent((e) => e.type === "pending_resolved" && e.payload && e.payload.id === id,
        "pending_resolved for the rejection");
      assert.equal(frame.payload.action, "rejected");

      // After a rejection the same URL can be held again: rejecting must not
      // blacklist anything.
      const reheld = await call("POST", "/api/tasks", { url: rejectUrl, queueId: "extension" });
      assert.equal(reheld.status, 202);
      assert.equal(reheld.json.duplicate, false);
      await call("POST", "/api/pending/" + reheld.json.pending.id + "/reject");
    });

    // ------------------------------------------------------------- timeout
    suite.group("timeout auto-enqueues to the default directory");

    await suite.test("an unattended entry queues itself to defaultDir, never dropped", async () => {
      // Live config change: arm this one entry with a short fuse.
      const patched = await call("PATCH", "/api/config", { askBeforeAddTimeoutMs: 1200 });
      assert.equal(patched.json.config.askBeforeAddTimeoutMs, 1200);

      const held = await call("POST", "/api/tasks", { url: timeoutUrl, queueId: "extension", filename: "timeout.bin" });
      assert.equal(held.status, 202);
      assert.equal((await tasksFor(timeoutUrl)).length, 0, "nothing queued at hold time");

      const done = await waitFor(async () => {
        const found = await tasksFor(timeoutUrl);
        if (found.length === 0) return false;
        const t = await taskById(found[0].id);
        if (t && t.status === "error") throw new Error("timed-out task failed: " + t.error);
        return t && t.status === "complete" ? t : false;
      }, { timeoutMs: 30000, what: "the timed-out entry to queue and complete" });

      // The default directory, not one the user never confirmed.
      assert.equal(done.dir, out, "the timeout must queue to the default directory");
      assert.equal(fs.existsSync(path.join(out, "timeout.bin")), true,
        "the timed-out download must actually produce its file");
      assert.equal((await pendingList()).length, 0, "the entry must be gone once timed out");

      const frame = await waitForEvent((e) => e.type === "pending_resolved" && e.payload && e.payload.url === timeoutUrl,
        "pending_resolved for the timeout");
      assert.equal(frame.payload.action, "timeout");

      // Restore the production default so later pendings keep the long fuse.
      await call("PATCH", "/api/config", { askBeforeAddTimeoutMs: 300000 });
    });

    // ----------------------------------------------------------------- 409
    suite.group("same-URL in-flight detection on POST /api/tasks");

    await suite.test("a live task makes the URL 409; removing it unblocks the URL", async () => {
      // A paused task is the clearest "live but not moving" state.
      const first = await call("POST", "/api/tasks", { url: dupUrl, filename: "dup409.bin" });
      assert.equal(first.status, 201);
      const id = first.json.task.id;
      await call("POST", "/api/tasks/" + id + "/pause");
      const paused = await waitFor(async () => {
        const t = await taskById(id);
        return t && t.status === "paused" ? t : false;
      }, { what: "the task to report paused" });

      const dup = await call("POST", "/api/tasks", { url: dupUrl });
      assert.equal(dup.status, 409, "expected 409, got " + dup.status + " " + JSON.stringify(dup.json));
      assert.equal(dup.json.error, "task already in queue");
      assert.equal(dup.json.existingTaskId, id, "the 409 must name the existing task");

      // The pending gate must not be a way around the guard either.
      const dupExt = await call("POST", "/api/tasks", { url: dupUrl, queueId: "extension" });
      assert.equal(dupExt.status, 409, "an extension-marked duplicate must also be refused");
      assert.equal((await pendingList()).length, 0, "no pending entry may be created for a live URL");

      // Once the task is gone the URL is addable again.
      await call("POST", "/api/tasks/" + id + "/cancel");
      const fresh = await call("POST", "/api/tasks", { url: dupUrl, filename: "dup409.bin" });
      assert.equal(fresh.status, 201, "a removed task must unblock the URL");
      assert.notEqual(fresh.json.task.id, id);
      // Leave the queue as we found it.
      await call("POST", "/api/tasks/" + fresh.json.task.id + "/cancel");
    });

    // ------------------------------------------------------- daemon wiring
    suite.group("daemon wiring: clipboard gate and stop() flush");

    await suite.test("a clipboard URL is held, approvable, and stop() flushes the rest", async () => {
      const home2 = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b1a-daemon-"));
      const previousHome = process.env.DOWNLOADX_HOME;
      process.env.DOWNLOADX_HOME = home2;
      let daemon = null;
      try {
        const { Daemon } = await import("../src/daemon.mjs");
        daemon = await new Daemon({ port: 0 }).init();
        // Never read or write the real clipboard, and keep files inside the
        // temp home.
        daemon.clipboard.stop();
        await daemon.config.set({
          defaultDir: out, categorizeByType: false, overwriteExisting: "rename",
        });
        assert.equal(daemon.config.get("askBeforeAdd"), true, "the daemon must gate by default");
        const runtime = await daemon.start();
        daemon.clipboard.stop();

        const dcall = async (method, route, body) => {
          const headers = { "x-downloadx-token": runtime.token };
          if (body) headers["content-type"] = "application/json";
          const res = await fetch("http://127.0.0.1:" + runtime.port + route, {
            method, headers, body: body ? JSON.stringify(body) : undefined,
          });
          const text = await res.text();
          let json2 = null;
          try { json2 = JSON.parse(text); } catch { json2 = { raw: text }; }
          return { status: res.status, json: json2 };
        };

        // The exact event ClipboardWatcher emits on a copied URL.
        // 第10项收口后 clipboard+回环一律跳过(挂起也进不去),而 fake server 只能在
        // 127.0.0.1——挂起/批准/落盘接线改用非回环 fixture host 验证;批准后这条
        // URL 不可达,下载成功语义由 approve-overrides 用例(manual 来源,可达)覆盖。
        const clipUrl = "https://clipboard.fixture.example/range/65536?case=clipboard";
        daemon.clipboard.emit("url", clipUrl);

        const heldClip = await waitFor(async () => {
          const list = (await dcall("GET", "/api/pending")).json.pending;
          const hit = list.find((p) => p.url === clipUrl);
          return hit ?? false;
        }, { what: "the clipboard URL to be held" });
        assert.equal(heldClip.queueId, "clipboard", "the held entry must be tagged as clipboard-sourced");
        const clipTasks = (await dcall("GET", "/api/tasks")).json.tasks.filter((t) => t.url === clipUrl);
        assert.equal(clipTasks.length, 0, "the clipboard URL must not be queued directly");

        const approved = await dcall("POST", "/api/pending/" + heldClip.id + "/approve", { dir: out2 });
        assert.equal(approved.status, 201, "expected 201, got " + approved.status + " " + JSON.stringify(approved.json));
        // fixture host 不可解析(且 Windows DNS 死等分钟级):批准→入队的接线
        // 到此已证,下载生命周期不归本用例管(approve-overrides 用例以可达 URL
        // 覆盖了"批准后真实落盘")。
        const clipTask = (await dcall("GET", "/api/tasks/" + approved.json.task.id)).json.task;
        assert.ok(clipTask, "approving the held entry must create its task");
        assert.equal(clipTask.dir, out2);

        // Still-pending entries must be flushed into the queue by stop(),
        // not dropped: a restart may not silently lose a copied link.
        const flushUrl = "https://clipboard.fixture.example/range/65536?case=flushme";
        daemon.clipboard.emit("url", flushUrl);
        await waitFor(async () => {
          const list = (await dcall("GET", "/api/pending")).json.pending;
          return list.some((p) => p.url === flushUrl);
        }, { what: "the second clipboard URL to be held" });

        await daemon.stop();
        assert.equal(daemon.started, false);

        const { paths } = await import("../src/paths.mjs");
        const saved = JSON.parse(await fsp.readFile(paths.queue, "utf8"));
        const flushed = (saved.tasks || []).find((t) => t.url === flushUrl);
        assert.ok(flushed, "stop() must flush still-pending entries into queue.json");
        assert.equal(flushed.dir, null, "the flush uses the default-directory fallback");
        daemon = null; // already stopped
      } finally {
        if (daemon && daemon.started) await daemon.stop().catch(() => {});
        if (previousHome === undefined) delete process.env.DOWNLOADX_HOME;
        else process.env.DOWNLOADX_HOME = previousHome;
        // Windows rmdir can race a still-flushing transfer; retry briefly.
        for (let i = 0; ; i++) {
          try { await fsp.rm(home2, { recursive: true, force: true }); break; }
          catch (err) {
            if (i >= 8 || (err.code !== "ENOTEMPTY" && err.code !== "EBUSY" && err.code !== "EPERM")) throw err;
            await new Promise((r) => setTimeout(r, 300));
          }
        }
      }
    });
  } finally {
    pending.dispose();
    sseAbort.abort();
    await sseDone;
    await api.close().catch(() => {});
    await new Promise((r) => { try { origin.server.closeAllConnections?.(); } catch { /* none */ } origin.close().then(r); setTimeout(r, 1500); });
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch1-approvals crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
