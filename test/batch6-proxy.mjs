// Batch-6 proxy regressions (P-13 / P-14 / P-15 / P-17).
//
// P-13: the in-flight dedup key is url+kind+(meta.preset||""), not the bare
//       URL — one source under two convert presets queues in parallel, while
//       same url+kind still answers 409 exactly as before.
// P-14: POST /api/proxy/start applies body.mode through proxy.start(mode);
//       status then reports the new mode without any restart. Invalid modes
//       are refused instead of being silently ignored.
// P-15: #mitmConnect awaits the async leaf path BEFORE building the TLS
//       socket, so a host nobody pre-generated a certificate for is signed
//       on its first CONNECT (this was the all-hosts-502 in the field). The
//       proof is end-to-end with a throwaway CA: openssl mints the CA and the
//       leaves, a local HTTPS origin serves the body, and a client that
//       trusts only the throwaway CA verifies the proxy-minted leaf and gets
//       the bytes through the decrypted tunnel. The legacy { getLeaf } wiring
//       shape keeps working for pre-generated hosts (fast path) and still
//       502s for unseen ones — the daemon's own wiring note lives in the
//       batch-6 report, not here. #forwardMitm additionally honours the
//       standard proxy env vars (HTTPS_PROXY..., NO_PROXY) for its upstream
//       leg — the registry/system-proxy half is deliberately batch-7 (P-18).
// P-17: an HTTP proxy CONNECT gets a 15s floor (CONNECT_TIMEOUT_MS in
//       net.mjs): a caller's 300ms request budget must not cut the CONNECT
//       phase, and a CONNECT-layer failure still surfaces with the batch-5
//       attempts context (probe's `attempts` annotation, translation layer
//       untouched).
//
// Everything runs against local servers and a throwaway DOWNLOADX_HOME; no
// public network, no user Downloads, no %APPDATA%\downloadx, and nothing is
// written under D:/IAM/downloadx-data.
//
// Usage: node test/batch6-proxy.mjs

import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NL = String.fromCharCode(10);
const CRLF = "\r\n";   // wire format; NL is for console output only

/** Proxy-related env vars touched by the P-15 pass-through test. */
const ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];

async function main() {
  const suite = new Suite("batch6-proxy");
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + (r.ms > 400 ? "  (" + r.ms + "ms)" : "") + NL);
    else if (r.kind === "skip") process.stdout.write("    SKIP  " + r.text + "  - " + r.reason + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " + String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-batch6-proxy-"));
  process.env.DOWNLOADX_HOME = home;
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];

  // Modules come in after DOWNLOADX_HOME so every path they resolve is ours.
  const { Config } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { Downloader } = await import("../src/downloader.mjs");
  const { ApiServer } = await import("../src/api.mjs");
  const { CaptureProxy, envProxyFor } = await import("../src/proxy.mjs");
  const { CertificateAuthority } = await import("../src/ca.mjs");
  const netMod = await import("../src/net.mjs");
  const probeMod = await import("../src/probe.mjs");

  // ------------------------------------------------------------- helpers

  /** A minimal CONNECT relay: records targets, then pipes to the origin. */
  function startConnectRelay() {
    const seen = [];
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.once("data", (buf) => {
        const line = buf.toString("latin1").split("\r\n")[0];
        const m = /^CONNECT (\S+) HTTP/.exec(line);
        seen.push(m ? m[1] : line);
        const [h, pt] = (m ? m[1] : "127.0.0.1:443").split(":");
        const up = net.connect(Number(pt || 443), h, () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          up.pipe(socket);
          socket.pipe(up);
        });
        up.on("error", () => { try { socket.destroy(); } catch { /* gone */ } });
        socket.on("error", () => { try { up.destroy(); } catch { /* gone */ } });
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve({ server, seen, sockets, port: server.address().port }));
    });
  }

  /** Accept TCP, never answer the CONNECT — for the P-17 timeout floor. */
  function startStallProxy() {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", () => { /* swallow: a stall is the point */ });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve({ server, sockets, port: server.address().port }));
    });
  }

  /** Answers 403 to every CONNECT — for the ProxyConnectError family. */
  function startRefusingProxy() {
    const server = http.createServer();
    server.on("connect", (req, socket) => {
      try { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); } catch { /* gone */ }
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
    });
  }

  /**
   * One HTTPS request through the capture proxy the way a real client does
   * it: CONNECT, then TLS that trusts only `caPem`. A leaf the proxy minted
   * on demand verifies here or the handshake fails — that verification IS
   * the end-to-end proof for P-15.
   */
  function mitmFetch({ proxyPort, host, port, target, caPem }) {
    return new Promise((resolve, reject) => {
      const raw = net.connect(proxyPort, "127.0.0.1");
      const fail = (err) => { try { raw.destroy(); } catch { /* gone */ } reject(err); };
      raw.once("connect", () => {
        raw.write(`CONNECT ${host}:${port} HTTP/1.1${CRLF}Host: ${host}:${port}${CRLF}${CRLF}`);
      });
      raw.once("error", fail);
      let header = "";
      let stage = "connect";
      const onData = (chunk) => {
        if (stage !== "connect") return;
        header += chunk.toString("latin1");
        const idx = header.indexOf("\r\n\r\n");
        if (idx === -1) return;
        raw.removeListener("data", onData);
        const rest = header.slice(idx + 4);
        const statusLine = header.slice(0, idx).split("\r\n")[0];
        if (rest.length) raw.unshift(Buffer.from(rest, "latin1"));
        if (!/^HTTP\/1\.1 200/.test(statusLine)) {
          fail(new Error("CONNECT refused: " + statusLine));
          return;
        }
        stage = "tls";
        const tlsSock = tls.connect({ socket: raw, servername: host, ca: caPem, rejectUnauthorized: true });
        tlsSock.once("error", (err) => {
          fail(new Error("TLS through proxy failed (leaf not signed by the test CA?): " + err.message));
        });
        tlsSock.once("secureConnect", () => {
          const chunks = [];
          let head = "";
          let bodyStart = -1;
          tlsSock.on("data", (c) => {
            if (bodyStart === -1) {
              head += c.toString("latin1");
              const i = head.indexOf("\r\n\r\n");
              if (i === -1) return;
              bodyStart = i + 4;
              chunks.push(Buffer.from(head.slice(bodyStart), "latin1"));
            } else {
              chunks.push(c);
            }
          });
          tlsSock.once("end", () => {
            resolve({
              statusLine,
              status: Number(head.split(" ")[1] || 0),
              body: Buffer.concat(chunks),
              authorized: tlsSock.authorized,
              close: () => { try { tlsSock.destroy(); } catch { /* gone */ } },
            });
          });
          tlsSock.write(`GET ${target} HTTP/1.1${CRLF}Host: ${host}:${port}${CRLF}Connection: close${CRLF}${CRLF}`);
        });
      };
      raw.on("data", onData);
      setTimeout(() => fail(new Error("mitmFetch timeout (stage " + stage + ")")), 15000).unref?.();
    });
  }

  /** Track every server for the teardown, so the process can exit cleanly. */
  const closers = [];
  const track = (v) => { closers.push(v); return v; };

  const out = path.join(home, "out");
  await fsp.mkdir(out, { recursive: true });
  const config = new Config(path.join(home, "config.json"));
  await config.load();
  await config.set({
    defaultDir: out,
    categorizeByType: false,
    maxConnections: 1,
    maxConcurrentDownloads: 1,
    overwriteExisting: "rename",
    proxy: "",
    proxyMode: "none",
  });
  const queue = new QueueManager({ config });
  await queue.load();
  const downloader = new Downloader({ config, queue });
  // No startRunner() on purpose: without the runner, added tasks sit in
  // "queued" — a live status — which is exactly what the dedup guard reads.
  const apiReal = new ApiServer({
    queue, config, downloader,
    log: { info() {}, warn() {}, error() {}, tail: () => [] },
  });
  const listening = await apiReal.listen({ port: 0 });

  const call = async (method, route, body) => {
    const headers = { "x-downloadx-token": listening.token };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch("http://127.0.0.1:" + listening.port + route, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  };

  try {
    // ================================================== P-13 dedup key
    suite.group("P-13 dedup key: url + kind + meta.preset");

    const SRC = "file:///data/source-video.mp4";
    const OTHER = "file:///data/other-source.mp4";

    await suite.test("same url + same kind + same preset still 409s (download behaviour unchanged)", async () => {
      const first = await call("POST", "/api/tasks", { url: SRC, kind: "convert", meta: { preset: "mp4-h264" } });
      assert.equal(first.status, 201, "first convert add must be accepted: " + JSON.stringify(first.json));
      const dup = await call("POST", "/api/tasks", { url: SRC, kind: "convert", meta: { preset: "mp4-h264" } });
      assert.equal(dup.status, 409, "identical intent must still be refused");
      assert.equal(dup.json.error, "task already in queue");
      assert.equal(dup.json.existingTaskId, first.json.task.id, "the 409 must point at the live task");
    });

    await suite.test("same url, different preset queues in parallel (201, not 409)", async () => {
      const r = await call("POST", "/api/tasks", { url: SRC, kind: "convert", meta: { preset: "mp4-h265" } });
      assert.equal(r.status, 201, "a second preset on the same source is a different job: " + JSON.stringify(r.json));
      assert.equal(r.json.task.kind, "convert");
      // taskView does not expose meta; read the queue's own record.
      assert.equal(queue.get(r.json.task.id).meta.preset, "mp4-h265", "the parallel task must carry its own preset");
    });

    await suite.test("same url across kinds coexists; same url + same kind still collides", async () => {
      const plain = await call("POST", "/api/tasks", { url: SRC, kind: "http" });
      assert.equal(plain.status, 201, "a plain download of the same URL must not collide with converts");
      const plainDup = await call("POST", "/api/tasks", { url: SRC, kind: "http" });
      assert.equal(plainDup.status, 409, "same url + same kind http is still one in-flight task");
      const def1 = await call("POST", "/api/tasks", { url: OTHER });
      assert.equal(def1.status, 201);
      const def2 = await call("POST", "/api/tasks", { url: OTHER });
      assert.equal(def2.status, 409, "default-kind adds keep the old same-URL semantics");
    });

    // ================================================== P-14 start(mode)
    suite.group("P-14 POST /api/proxy/start applies body.mode");

    const caForApi = track(new CertificateAuthority({ dir: path.join(home, "ca-api") }));
    const proxyForApi = track(new CaptureProxy({ port: 0, mode: "tunnel", ca: caForApi }));
    apiReal.proxy = proxyForApi;
    apiReal.ca = caForApi;

    await suite.test("start {\"mode\":\"mitm\"} switches mode without a restart", async () => {
      const r = await call("POST", "/api/proxy/start", { mode: "mitm" });
      assert.equal(r.status, 200, "start must succeed: " + JSON.stringify(r.json));
      assert.equal(r.json.mode, "mitm", "the start answer must report the effective mode");
      const st = await call("GET", "/api/proxy/status");
      assert.equal(st.json.proxy.running, true);
      assert.equal(st.json.proxy.mode, "mitm", "status must show mitm after POST start mode=mitm");
      assert.equal(config.get("captureProxy").mode, "mitm", "config write-back keeps working");
    });

    await suite.test("start without a mode keeps the current mode", async () => {
      const r = await call("POST", "/api/proxy/start", {});
      assert.equal(r.status, 200);
      assert.equal(r.json.mode, "mitm", "no mode in the body must not flip anything");
    });

    await suite.test("an invalid mode is refused, not silently ignored", async () => {
      const r = await call("POST", "/api/proxy/start", { mode: "bogus" });
      assert.equal(r.status, 500, "proxy.start must reject the invalid mode: " + JSON.stringify(r.json));
      assert.ok(/must be/.test(String(r.json.error)), "the error must name the legal values: " + r.json.error);
      const st = await call("GET", "/api/proxy/status");
      assert.equal(st.json.proxy.mode, "mitm", "a refused mode must leave the proxy untouched");
    });

    await suite.test("unit: start(mode) validates before listening and hot-switches a running proxy", async () => {
      const p = track(new CaptureProxy({ port: 0 }));
      let threw = null;
      try { await p.start("nope"); } catch (err) { threw = err; }
      assert.ok(threw, "start('nope') must throw");
      assert.ok(/must be/.test(threw.message));
      assert.equal(p.enabled, false, "a refused start must not leave a listener behind");
      const info = await p.start("tunnel");
      assert.equal(info.mode, "tunnel");
      // Already listening: a mode still takes effect for new connections.
      const switched = await p.start("mitm");
      assert.equal(switched.mode, "mitm");
      assert.equal(p.status().mode, "mitm");
      await p.stop();
    });

    // ================================================== P-15 MITM e2e
    suite.group("P-15 MITM: unseen host is signed on first CONNECT (real CA + openssl)");

    let ca = null;
    let caPem = null;
    let origin = null;
    let proxy = null;
    let opensslFound = true;
    try {
      ca = track(new CertificateAuthority({ dir: path.join(home, "ca-mitm") }));
      await ca.ensure();
      caPem = await fsp.readFile(ca.certPath, "utf8");
    } catch (err) {
      opensslFound = false;
      suite.skip("CA could not be minted (openssl missing?)", err.message);
    }

    if (opensslFound) {
      // The origin presents a leaf for a DIFFERENT name (minted up front), so
      // the "localhost" leaf the proxy needs can never pre-exist: its absence
      // before the CONNECT is what makes the on-demand proof honest.
      const originLeaf = await ca.leafFor("origin-fixture.local");
      const BODY = "hello-through-mitm";
      const BIN = Buffer.alloc(300 * 1024, 7);
      origin = track(https.createServer({ key: originLeaf.key, cert: originLeaf.cert }, (req, res) => {
        if (req.url === "/e2e.bin") {
          res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(BIN.length), "Connection": "close" });
          res.end(BIN);
        } else {
          res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": String(BODY.length), "Connection": "close" });
          res.end(BODY);
        }
      }));
      await new Promise((r) => origin.listen(0, "127.0.0.1", r));
      const originPort = origin.address().port;

      proxy = track(new CaptureProxy({ port: 0, mode: "mitm", ca }));
      await proxy.start();

      await suite.test("no localhost leaf exists before the CONNECT", async () => {
        assert.equal(fs.existsSync(path.join(ca.leafDir, "localhost.key")), false, "the test needs an unseen host");
        assert.equal(fs.existsSync(path.join(ca.leafDir, "localhost.crt")), false);
      });

      await suite.test("CONNECT to the unseen host signs, verifies against the CA, and serves the body", async () => {
        const r = await mitmFetch({ proxyPort: proxy.port, host: "localhost", port: originPort, target: "/e2e.txt", caPem });
        assert.equal(r.status, 200, "through-tunnel status: " + r.status);
        assert.equal(r.body.toString("utf8"), BODY, "the decrypted round trip must return the origin's bytes");
        assert.equal(r.authorized, true, "the client must VERIFY the proxy-minted leaf against the CA — this is the openssl proof");
        assert.equal(fs.existsSync(path.join(ca.leafDir, "localhost.key")), true, "the signed leaf must be persisted");
        assert.equal(fs.existsSync(path.join(ca.leafDir, "localhost.crt")), true);
        assert.ok(proxy.status().stats.mitm >= 1, "the mitm counter must have moved");
        r.close();
      });

      await suite.test("a downloadable response over MITM lands in captures as decrypted", async () => {
        const r = await mitmFetch({ proxyPort: proxy.port, host: "localhost", port: originPort, target: "/e2e.bin", caPem });
        assert.equal(r.status, 200);
        assert.equal(r.body.length, BIN.length);
        const caps = proxy.list();
        const hit = caps.find((c) => c.url === "https://localhost/e2e.bin");
        assert.ok(hit, "the decrypted octet-stream must be captured");
        assert.equal(hit.decrypted, true);
        assert.equal(hit.host, "localhost");
        r.close();
      });

      await suite.test("legacy { getLeaf } wiring: pre-generated host works, unseen host still 502s (documented boundary)", async () => {
        const legacy = track(new CaptureProxy({ port: 0, mode: "mitm", ca: { getLeaf: (h) => ca.leafForSync(h) } }));
        await legacy.start();
        // Fast path: "localhost" was signed by the async path above and is on disk.
        const ok = await mitmFetch({ proxyPort: legacy.port, host: "localhost", port: originPort, target: "/e2e.txt", caPem });
        assert.equal(ok.status, 200, "the read-only fast path must keep serving pre-generated leaves");
        assert.equal(ok.body.toString("utf8"), BODY);
        ok.close();
        // Boundary: a read-only wrapper cannot sign — this is exactly why the
        // daemon's wiring (daemon.mjs ca: { getLeaf }) must move to the async
        // object in the batch-6/7 window.
        await assert.rejects(
          () => mitmFetch({ proxyPort: legacy.port, host: "never-signed-here.test", port: originPort, target: "/e2e.txt", caPem }),
          /CONNECT refused: HTTP\/1\.1 502/,
          "an unseen host through the legacy wrapper must answer 502, not sign");
        await legacy.stop();
      });

      // ---------------------------------------- P-15 env proxy pass-through
      suite.group("P-15 #forwardMitm honours the proxy env vars");

      const relay = track(await startConnectRelay());
      process.env.HTTPS_PROXY = "http://127.0.0.1:" + relay.port;

      await suite.test("HTTPS_PROXY: the upstream leg leaves through the env proxy", async () => {
        const r = await mitmFetch({ proxyPort: proxy.port, host: "localhost", port: originPort, target: "/e2e.txt", caPem });
        assert.equal(r.status, 200);
        assert.equal(r.body.toString("utf8"), BODY, "the body must survive proxy -> env proxy -> origin");
        assert.ok(relay.seen.includes("localhost:" + originPort), "the env proxy must have seen the CONNECT: " + JSON.stringify(relay.seen));
        r.close();
      });

      await suite.test("NO_PROXY excludes the host and goes direct again", async () => {
        process.env.NO_PROXY = "localhost";
        const before = relay.seen.length;
        const r = await mitmFetch({ proxyPort: proxy.port, host: "localhost", port: originPort, target: "/e2e.txt", caPem });
        assert.equal(r.status, 200);
        assert.equal(relay.seen.length, before, "NO_PROXY=localhost must bypass the env proxy");
        r.close();
        delete process.env.NO_PROXY;
      });

      await suite.test("unit: envProxyFor precedence and NO_PROXY shapes", async () => {
        assert.equal(envProxyFor("example.test"), "http://127.0.0.1:" + relay.port, "HTTPS_PROXY wins when set");
        process.env.NO_PROXY = "sub.example.test, other.test";
        assert.equal(envProxyFor("sub.example.test"), null, "exact NO_PROXY entry");
        assert.equal(envProxyFor("deep.sub.example.test"), null, "suffix match covers subdomains");
        assert.equal(envProxyFor("example.test"), "http://127.0.0.1:" + relay.port, "a bare domain must not exclude its subdomains' parent");
        process.env.NO_PROXY = "*";
        assert.equal(envProxyFor("anything.test"), null, "* excludes everything");
        delete process.env.NO_PROXY;
        delete process.env.HTTPS_PROXY;
        process.env.HTTP_PROXY = "http://127.0.0.1:9";
        assert.equal(envProxyFor("example.test"), "http://127.0.0.1:9", "HTTP_PROXY is the last fallback");
        delete process.env.HTTP_PROXY;
        assert.equal(envProxyFor("example.test"), null, "no env, no proxy");
      });

      await new Promise((r) => {
        relay.sockets.forEach((s) => { try { s.destroy(); } catch { /* gone */ } });
        relay.server.close(r);
      });
      await proxy.stop();
    }

    // ================================================== P-17 CONNECT floor
    suite.group("P-17 CONNECT timeout floor and attempts context");

    await suite.test("a 300ms caller budget must not cut the proxy CONNECT phase", async () => {
      const stall = track(await startStallProxy());
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 1100).unref?.();
      const t0 = Date.now();
      let err = null;
      try {
        await netMod.request("https://never-answered.example/x", {
          proxy: "http://127.0.0.1:" + stall.port,
          timeoutMs: 300,          // without the floor the CONNECT dies here
          signal: ctrl.signal,
        });
      } catch (e) { err = e; }
      const elapsed = Date.now() - t0;
      assert.ok(err, "the stalled CONNECT must fail somehow");
      assert.ok(!/proxy CONNECT timeout/.test(String(err.message)),
        "the CONNECT must not time out at the caller's 300ms budget: " + err.message);
      assert.ok(elapsed >= 1000,
        "the CONNECT must still be pending at ~1.1s (floor 15s), elapsed " + elapsed + "ms");
      stall.sockets.forEach((s) => { try { s.destroy(); } catch { /* gone */ } });
      await new Promise((r) => stall.server.close(r));
    });

    await suite.test("a dead proxy surfaces through probe WITH attempts context (batch-5 bridge, translation untouched)", async () => {
      let err = null;
      try {
        await probeMod.probe("https://target.example/file.bin", {
          proxy: "http://127.0.0.1:1",   // nothing listens: ECONNREFUSED, fast
          maxRetries: 3,
          retryBaseMs: 5,
        });
      } catch (e) { err = e; }
      assert.ok(err, "the probe must fail against a dead proxy");
      assert.equal(err.attempts, 3, "the CONNECT-layer failure must carry the probe's attempts annotation");
      assert.equal(err.attemptErrors.length, 3, "one line per round");
      assert.ok(/ECONNREFUSED/.test(String(err.message)) || /127\.0\.0\.1:1/.test(String(err.message)),
        "the raw transport error must name the proxy endpoint: " + err.message);
      // The translation layer (batch-5) passes this family through; nothing
      // here changed it — the assertion pins the bridge, not a new behaviour.
      const translated = netMod.translateTaskError(err, { url: "https://target.example/file.bin" });
      assert.ok(translated === null || /ECONNREFUSED|127\.0\.0\.1:1|目标/.test(translated),
        "translation keeps a meaningful message: " + translated);
    });

    await suite.test("ProxyConnectError keeps its wording and gains attempts after retries", async () => {
      const refuse = track(await startRefusingProxy());
      let err = null;
      try {
        await probeMod.probe("https://target.example/file.bin", {
          proxy: "http://127.0.0.1:" + refuse.port,
          maxRetries: 2,
          retryBaseMs: 5,
        });
      } catch (e) { err = e; }
      assert.ok(err, "the refused CONNECT must fail");
      assert.equal(err.name, "ProxyConnectError");
      assert.ok(/proxy CONNECT failed: HTTP 403 for target\.example/.test(err.message), "P-9 wording intact: " + err.message);
      assert.equal(err.attempts, 2, "retries happened and are visible");
      const translated = netMod.translateTaskError(err, { url: "https://target.example/file.bin" });
      assert.equal(translated, err.message, "the translation layer passes the family through verbatim");
      await new Promise((r) => refuse.server.close(r));
    });
  } finally {
    // Teardown: every tracked proxy/server down, env restored, temp home gone.
    for (const v of closers) {
      try {
        if (v instanceof CaptureProxy && v.enabled) await v.stop();
        else if (typeof v.close === "function") await v.close();
        else if (typeof v.stop === "function") await v.stop();
      } catch { /* already gone */ }
    }
    try { await apiReal.close(); } catch { /* already gone */ }
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
    // Watchdog: the suite must exit on its own; if a socket slipped the
    // teardown, exit anyway (and say so) rather than hanging the runner.
    setTimeout(() => {
      process.stderr.write("batch6-proxy: event loop still alive after teardown, forcing exit " + code + NL);
      process.exit(code);
    }, 2500).unref?.();
  })
  .catch((err) => {
    process.stderr.write("batch6-proxy crashed: " + ((err && err.stack) || err) + NL);
    process.exitCode = 1;
  });
