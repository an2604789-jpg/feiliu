// Extension protocol tests (batch P2, task A).
//
// The native host is the only component that speaks the browser's stdio
// framing, so driving it directly exercises everything except the browser
// itself: the message shape, the error reporting, the daemon call and the
// duplicate suppression. No browser is required, and nothing here claims a
// browser-level pass.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

import { Suite, assert } from "./harness.mjs";

const PROJECT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

/** Read a file's SHA-256, streamed so a large file does not sit in memory. */
async function hashFile(file) {
  const h = createHash("sha256");
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file);
    rs.on("data", (c) => h.update(c));
    rs.once("end", resolve);
    rs.once("error", reject);
  });
  return h.digest("hex");
}

/**
 * Start the real native host as a subprocess.
 *
 * @param {string} homeDir  DOWNLOADX_HOME the host will use
 */
export function startNativeHost(homeDir) {
  const hostPath = path.join(PROJECT, "extension", "host.mjs");
  const child = spawn(process.execPath, [hostPath], {
    env: { ...process.env, DOWNLOADX_HOME: homeDir },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = Buffer.alloc(0);
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const len = buffer.readUInt32LE(0);
      if (buffer.length < 4 + len) return;
      let body = null;
      try { body = JSON.parse(buffer.subarray(4, 4 + len).toString("utf8")); } catch { body = { ok: false, error: "invalid frame" }; }
      buffer = buffer.subarray(4 + len);
      const next = waiters.shift();
      if (next) next(body);
    }
  });

  const send = (message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the native host did not reply within 15s")), 15000);
    waiters.push((reply) => { clearTimeout(timer); resolve(reply); });
    const json = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    child.stdin.write(Buffer.concat([header, json]));
  });

  return {
    child,
    send,
    close() { try { child.kill(); } catch { /* already gone */ } },
  };
}

/** A local origin that honours Range and records what the client sent. */
export async function startContextOrigin({ size = 128 * 1024, fill = 0x2a, contentType = "" } = {}) {
  const body = Buffer.alloc(size, fill);
  const seen = { cookie: null, referer: null, authorization: null, userAgent: null };
  const srv = http.createServer((req, res) => {
    if (req.headers.cookie) seen.cookie = req.headers.cookie;
    if (req.headers.referer) seen.referer = req.headers.referer;
    if (req.headers.authorization) seen.authorization = req.headers.authorization;
    if (req.headers["user-agent"]) seen.userAgent = req.headers["user-agent"];
    const headers = { "Content-Length": size, "Accept-Ranges": "bytes" };
    if (contentType) headers["Content-Type"] = contentType;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    if (m) {
      const s = Number(m[1]);
      const e = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      const slice = body.subarray(s, e + 1);
      res.writeHead(206, Object.assign(headers, {
        "Content-Range": "bytes " + s + "-" + e + "/" + size,
        "Content-Length": slice.length,
      }));
      res.end(slice);
      return;
    }
    res.writeHead(200, headers);
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: "http://127.0.0.1:" + srv.address().port + "/file.bin",
    body,
    seen,
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r(undefined)); setTimeout(() => r(undefined), 1500); }),
  };
}

/**
 * An origin that trickles a 2 MiB media body over several seconds: the size and
 * content-type satisfy the batch-1 auto-report gate, and the trickle keeps a
 * task fetching it visibly live (connecting/downloading) long enough for
 * duplicate-suppression checks to be deterministic instead of a race against
 * the transfer finishing.
 */
export async function startSlowOrigin({ seconds = 6, totalBytes = 2 * 1024 * 1024, contentType = "video/mp4" } = {}) {
  const chunks = 8;
  const piece = Buffer.alloc(Math.ceil(totalBytes / chunks), 0x2a).subarray(0, Math.floor(totalBytes / chunks));
  const srv = http.createServer((req, res) => {
    // Probes (HEAD) must answer instantly: the batch-1 background probes every
    // candidate before queueing, and a trickled HEAD would delay the duplicate
    // check until the first transfer is finishing — exactly the race this
    // origin exists to remove.
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": contentType, "Content-Length": piece.length * chunks });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": contentType, "Content-Length": piece.length * chunks });
    let i = 0;
    const timer = setInterval(() => {
      res.write(piece);
      if (++i >= chunks) { clearInterval(timer); res.end(); }
    }, Math.max(50, Math.floor((seconds * 1000) / chunks)));
    req.on("close", () => clearInterval(timer));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: "http://127.0.0.1:" + srv.address().port + "/stream",
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r(undefined)); setTimeout(() => r(undefined), 1500); }),
  };
}

/**
 * Register the extension-protocol tests on a suite.
 *
 * @param {Suite} suite
 * @param {{ home:string, out:string, projectDir:string }} ctx
 */
export async function runExtensionProtocolTests(suite, ctx) {
  const { home, out } = ctx;
  const root = ctx.root ?? path.dirname(home);
  const Config = (await import("../src/config.mjs")).Config;
  const QueueManager = (await import("../src/queue.mjs")).QueueManager;
  const Downloader = (await import("../src/downloader.mjs")).Downloader;

  const withHost = async (fn, label) => {
    const hostHome = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-host-" + label + "-"));
    const host = startNativeHost(hostHome);
    try { return await fn(host, hostHome); }
    finally {
      host.close();
      await fsp.rm(hostHome, { recursive: true, force: true });
    }
  };

  /**
   * Give a daemon and the native host the same private data root.
   *
   * They find each other through the runtime file there, so they must agree on
   * DOWNLOADX_HOME; a temporary root per test also keeps the suite's own home
   * free of a stray runtime.json and config.json.
   *
   * The daemon runs in this process, so the variable is set around its
   * lifetime and restored afterwards. paths.mjs resolves the root on every
   * access rather than caching it at import time, which is what makes this
   * safe.
   */
  const withDaemon = async (fn, label) => {
    const daemonHome = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-daemon-" + label + "-"));
    const previousHome = process.env.DOWNLOADX_HOME;
    process.env.DOWNLOADX_HOME = daemonHome;
    const { Daemon } = await import("../src/daemon.mjs");
    const daemon = await new Daemon({ port: 0 }).init();
    // These scenarios test the host protocol plumbing, not the approval gate;
    // askBeforeAdd off keeps extension adds entering the queue directly here.
    await daemon.config.set({ askBeforeAdd: false });
    const runtime = await daemon.start();
    const host = startNativeHost(daemonHome);
    try { return await fn(runtime, daemon, host, daemonHome); }
    finally {
      host.close();
      await daemon.stop();
      if (previousHome === undefined) delete process.env.DOWNLOADX_HOME;
      else process.env.DOWNLOADX_HOME = previousHome;
      await fsp.rm(daemonHome, { recursive: true, force: true });
    }
  };

  await suite.test("the native host reports 'daemon not running' with a fix", async () => {
    await withHost(async (host) => {
      const ping = await host.send({ type: "ping", protocol: 1 });
      assert.equal(ping.ok, false, "ping must not claim success with no daemon");
      assert.equal(ping.daemon.running, false);

      // The case that matters: the user clicked something and needs to know
      // what to do, not merely that something failed.
      const add = await host.send({ type: "add", url: "http://127.0.0.1:1/nope.bin", protocol: 1 });
      assert.equal(add.ok, false, "adding must fail when the daemon is down");
      assert.match(add.error, /daemon is not running/i, "the error must name the daemon: " + add.error);
      assert.match(add.error, /start it|downloadx\.cmd|bin[\\/]downloadx\.mjs/i,
        "the error must say how to start it: " + add.error);
    }, "down");
  });

  await suite.test("the native host rejects an invalid message and stays alive", async () => {
    await withHost(async (host) => {
      const bad = await host.send({ type: "not-a-real-type", protocol: 1 });
      assert.equal(bad.ok, false);
      assert.match(bad.error, /unknown message type/i);

      // A rejected message must not kill the host: the extension holds an open
      // port, so a dead host looks to the user like a hung button.
      const ping = await host.send({ type: "ping", protocol: 1 });
      assert.ok("daemon" in ping, "the host must still answer after a bad message");
    }, "bad");
  });

  await suite.test("the native host rejects a protocol version it cannot speak", async () => {
    await withHost(async (host) => {
      const reply = await host.send({ type: "ping", protocol: 99 });
      assert.equal(reply.ok, false);
      assert.match(reply.error, /protocol version/i, "expected a version complaint, got: " + reply.error);
      assert.match(reply.error, /reload the extension/i, "the error must say what to do");
    }, "ver");
  });

  await suite.test("an invalid JSON frame is answered without crashing the host", async () => {
    await withHost(async (host) => {
      // Write raw bytes that are not JSON at all, the way a corrupted message
      // would arrive. The host must answer and keep serving.
      const junk = Buffer.from("{ this is not json", "utf8");
      const header = Buffer.alloc(4);
      header.writeUInt32LE(junk.length, 0);
      host.child.stdin.write(Buffer.concat([header, junk]));
      await new Promise((r) => setTimeout(r, 300));
      const ping = await host.send({ type: "ping", protocol: 1 });
      assert.ok("daemon" in ping, "the host must survive a malformed frame");
    }, "json");
  });

  await suite.test("a repeated media URL is queued once, not once per event", async () => {
    // Batch-1 (2026-10-24) contract: a repeat is a duplicate only while a task
    // for the URL is still live. A task that has FAILED is a legitimate reason
    // to download again — the old fixture (an instantly unreachable URL) only
    // passed because "error" wrongly counted as live, which is the exact defect
    // that kept the extension from ever retrying a failed URL.
    const slow = await startSlowOrigin();
    try {
      await withDaemon(async (runtime, daemon, host) => {
        const media = { type: "media", protocol: 1, url: slow.url, kind: "hls" };
        const first = await host.send(media);
        assert.equal(first.ok, true, "the first media event must queue: " + JSON.stringify(first));
        assert.equal(first.duplicate, false);

        // While the transfer is live, a repeat must resolve to the same task.
        const second = await host.send(media);
        assert.equal(second.ok, true, "a repeat must still answer ok");
        assert.equal(second.duplicate, true, "a repeat of a live task must be reported as a duplicate");
        assert.equal(second.task.id, first.task.id, "the repeat must resolve to the same task");
        assert.ok(["queued", "connecting", "downloading", "paused"].includes(second.duplicateStatus),
          "the duplicate reply must carry a live status, got " + second.duplicateStatus);

        const res = await fetch("http://127.0.0.1:" + runtime.port + "/api/tasks", {
          headers: { "x-downloadx-token": runtime.token },
        });
        const payload = await res.json();
        const matching = payload.tasks.filter((t) => t.url === media.url);
        assert.equal(matching.length, 1, "exactly one task may exist for the repeated URL");

        // Leave the daemon as we found it: drop the stuck transfer.
        await fetch("http://127.0.0.1:" + runtime.port + "/api/tasks/" + first.task.id + "/cancel", {
          method: "POST", headers: { "x-downloadx-token": runtime.token },
        }).catch(() => {});
      }, "dup");

      // The other half of the contract: a task that failed is NOT live.
      await withDaemon(async (runtime, daemon, host) => {
        const dead = { type: "media", protocol: 1, url: "http://127.0.0.1:9/dead.m3u8", kind: "hls" };
        const first = await host.send(dead);
        assert.equal(first.ok, true, "queueing an unreachable URL must still answer ok");
        // Port 9 refuses instantly; wait until the task honestly reports error.
        const deadline = Date.now() + 15000;
        let view = null;
        for (;;) {
          const res = await fetch("http://127.0.0.1:" + runtime.port + "/api/tasks/" + first.task.id, {
            headers: { "x-downloadx-token": runtime.token },
          });
          view = (await res.json()).task;
          if (!view || view.status === "error") break;
          if (Date.now() > deadline) throw new Error("the unreachable task never errored: " + JSON.stringify(view));
          await new Promise((r) => setTimeout(r, 150));
        }
        assert.equal(view.status, "error");

        const retry = await host.send(dead);
        assert.equal(retry.ok, true, "a retry after failure must be answered ok");
        assert.equal(retry.duplicate, false, "a failed task must not block a retry of the same URL");
        assert.notEqual(retry.task.id, first.task.id, "the retry must be a new task");
      }, "retry");
    } finally {
      await slow.close();
    }
  });

  await suite.test("the native host queues a real download into the daemon", async () => {
    const origin = await startContextOrigin({ size: 384 * 1024 });
    try {
      await withDaemon(async (runtime, daemon, host, daemonHome) => {
        const dlDir = path.join(daemonHome, "ext-out");
        await fsp.mkdir(dlDir, { recursive: true });
        await daemon.config.set({ defaultDir: dlDir, categorizeByType: false, maxConnections: 2, overwriteExisting: "overwrite" });

        const reply = await host.send({
          type: "add", protocol: 1, url: origin.url,
          referer: "https://page.example/watch", cookies: "sid=acceptance-cookie",
        });
        assert.equal(reply.ok, true, "the add must succeed: " + JSON.stringify(reply));

        const deadline = Date.now() + 30000;
        let view = null;
        while (Date.now() < deadline) {
          const res = await fetch("http://127.0.0.1:" + runtime.port + "/api/tasks/" + reply.task.id, {
            headers: { "x-downloadx-token": runtime.token },
          });
          view = (await res.json()).task;
          if (view.status === "complete" || view.status === "error") break;
          await new Promise((r) => setTimeout(r, 200));
        }
        assert.equal(view.status, "complete", "the task must complete: " + (view && view.error));
        const landed = path.join(dlDir, view.filename);
        assert.ok(fs.existsSync(landed), "the file must exist at " + landed);
        assert.equal(await hashFile(landed), createHash("sha256").update(origin.body).digest("hex"),
          "the bytes must match the origin exactly");
        assert.equal(origin.seen.referer, "https://page.example/watch",
          "the Referer the page supplied must reach the origin");
        assert.equal(origin.seen.cookie, "sid=acceptance-cookie",
          "the Cookie the page supplied must reach the origin");
      }, "e2e");
    } finally {
      await origin.close();
    }
  });

  await suite.test("task cookies and referer reach the origin", async () => {
    const origin = await startContextOrigin({ size: 128 * 1024 });
    try {
      const cfg = new Config(path.join(out, "ctx.json"));
      await cfg.load();
      await cfg.set({ defaultDir: out, categorizeByType: false, overwriteExisting: "overwrite" });
      const q = new QueueManager({ config: cfg });
      await q.load();
      const dl = new Downloader({ config: cfg, queue: q });
      const result = await dl.run({
        id: "ctx-1", url: origin.url, kind: "http", filename: "ctx.bin", dir: out, headers: {},
        referer: "https://site.example/page", cookies: "session=abc123", meta: {},
      });
      assert.equal(result.bytes, origin.body.length);
      assert.equal(origin.seen.cookie, "session=abc123", "the task cookie must be sent");
      assert.equal(origin.seen.referer, "https://site.example/page", "the task referer must be sent");
    } finally {
      await origin.close();
    }
  });

  await suite.test("credentials become a Basic authorization header", async () => {
    const { buildRequestHeaders } = await import("../src/net.mjs");
    const both = buildRequestHeaders({ username: "u", password: "p" });
    assert.equal(both.Authorization, "Basic " + Buffer.from("u:p").toString("base64"));
    // Half a credential pair is not a credential. Sending an empty Basic header
    // would claim authentication and could not deliver it.
    assert.equal(buildRequestHeaders({ username: "u" }).Authorization, undefined);
    assert.equal(buildRequestHeaders({ password: "p" }).Authorization, undefined);
  });

  await suite.test("an explicitly set header wins over the convenience fields", async () => {
    const { buildRequestHeaders } = await import("../src/net.mjs");
    const h = buildRequestHeaders({
      headers: { Cookie: "explicit=1", Referer: "https://explicit/" },
      cookies: "from-field=1", referer: "https://field/",
    });
    assert.equal(h.Cookie, "explicit=1", "an explicit Cookie header must win");
    assert.equal(h.Referer, "https://explicit/", "an explicit Referer header must win");
  });

  await suite.test("buildRequestHeaders does not mutate the task's own headers", async () => {
    const { buildRequestHeaders } = await import("../src/net.mjs");
    const task = { headers: { "X-Trace": "1" }, cookies: "c=1", referer: "https://r/" };
    const built = buildRequestHeaders(task);
    built["X-Trace"] = "changed";
    assert.equal(task.headers["X-Trace"], "1", "the caller's header object must not be modified");
    assert.equal(task.headers.Cookie, undefined, "the caller's headers must not gain fields");
  });

  await suite.test("a cookie never reaches the daemon log", async () => {
    // A cookie in a log file is a leaked session, so this is checked on real
    // output rather than trusted. The value travels through the API, the queue
    // and the downloader, any of which could echo the task object.
    const origin = await startContextOrigin({ size: 96 * 1024 });
    try {
      await withDaemon(async (runtime, daemon, host, daemonHome) => {
        const dlDir = path.join(daemonHome, "leak-out");
        await fsp.mkdir(dlDir, { recursive: true });
        await daemon.config.set({ defaultDir: dlDir, categorizeByType: false, overwriteExisting: "overwrite" });
        const secret = "leak-canary-8f2c1d";
        const created = await fetch("http://127.0.0.1:" + runtime.port + "/api/tasks", {
          method: "POST",
          headers: { "x-downloadx-token": runtime.token, "content-type": "application/json" },
          body: JSON.stringify({ url: origin.url, cookies: "sid=" + secret, referer: "https://page.example/" }),
        });
        const task = (await created.json()).task;
        const deadline = Date.now() + 30000;
        for (;;) {
          const res = await fetch("http://127.0.0.1:" + runtime.port + "/api/tasks/" + task.id, {
            headers: { "x-downloadx-token": runtime.token },
          });
          const v = (await res.json()).task;
          if (v.status === "complete" || v.status === "error") break;
          if (Date.now() > deadline) throw new Error("the task did not settle");
          await new Promise((r) => setTimeout(r, 200));
        }
        const logFile = path.join(daemonHome, "logs", "downloadx.log");
        let text = "";
        try { text = await fsp.readFile(logFile, "utf8"); } catch { text = ""; }
        assert.ok(!text.includes(secret), "the cookie value must not appear in the daemon log");
        // The tail the API exposes is the same material the GUI shows.
        const tailRes = await fetch("http://127.0.0.1:" + runtime.port + "/api/log?lines=500", {
          headers: { "x-downloadx-token": runtime.token },
        });
        const tail = (await tailRes.json()).lines || [];
        assert.ok(!tail.some((l) => l.includes(secret)), "the cookie must not appear in the log API");
      }, "leak");
    } finally {
      await origin.close();
    }
  });
}
