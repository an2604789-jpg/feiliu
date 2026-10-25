// Batch-7 regressions: proxyMode is consumed for real + proxy authentication (P-18).
//
// P-18 had two halves:
//   (a) proxyMode (system | manual | none) existed in config.mjs — defined,
//       validated, shown as a GUI dropdown — with zero consumers. "Use system
//       proxy" read neither the system nor anything else. Now:
//         src/sysproxy.mjs        discovers the OS proxy (win32 registry via
//                                 `reg query`, posix env vars), 30s cache,
//                                 never throws;
//         src/downloader.mjs      selectRunProxy() applies the mode once per
//                                 run onto prepared.proxy (per-task proxy
//                                 still wins; system falls back to the
//                                 Settings proxy when discovery finds nothing);
//   (b) net.mjs's CONNECT sent only Host/Proxy-Connection — credentials in the
//       proxy URL were parsed by the SOCKS path but never by the HTTP tunnel,
//       so an authenticated proxy refused every CONNECT. Now both proxy hops
//       (CONNECT and plain-HTTP absolute-URI) carry
//       Proxy-Authorization: Basic base64(user:pass), and no error message or
//       log line ever contains the credential.
//
// What is proven here:
//   * the pure parsers: reg query sample strings (both ProxyServer forms,
//     ProxyOverride) and the posix env forms — no spawning, no real registry;
//   * resolveSystemProxy's three branches via injected runner/env, including
//     the 30s cache (success AND failure) and the never-throw contract;
//   * selectRunProxy's three modes + task-proxy precedence + noProxy bypass;
//   * CONNECT header injection against a local capture proxy, and the
//     credential-discipline assertions (raw and base64 forms appear in no
//     error message and no log line);
//   * end-to-end: one real transfer through the downloader in each mode,
//     with the system-mode proxy discovered from a seeded cache and the
//     credentialed header observed on the wire by a local forward proxy.
//
// Everything runs against local servers and a throwaway DOWNLOADX_HOME; no
// public network, no user Downloads, no %APPDATA%\downloadx, no real registry
// access (the win32 branch is exercised with an injected runner), and nothing
// is written under D:/IAM/downloadx-data.
//
// Usage: node test/batch7-proxyauth.mjs

import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";
import { startOrigin, payloadFor } from "./origin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NL = String.fromCharCode(10);

// The credential under test, in the three forms a leak could take.
const PROXY_USER = "dlUser";
const PROXY_PASS = "dl:P@ss";
const PROXY_CRED_URL_PART = PROXY_USER + ":" + encodeURIComponent(PROXY_PASS) + "@";
const PROXY_BASIC = "Basic " + Buffer.from(PROXY_USER + ":" + PROXY_PASS, "utf8").toString("base64");
const PROXY_B64_TAIL = PROXY_BASIC.slice("Basic ".length);

/** reg query stdout, exactly the shape ProxyEnable=1 + a single-form server produces. */
const REG_SAMPLE_ON = [
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
  "    ProxyEnable    REG_DWORD    0x1",
  "    ProxyServer    REG_SZ    127.0.0.1:8080",
  "    ProxyOverride    REG_SZ    localhost;127.0.0.1;<local>",
  "",
].join("\r\n");

/** Same key with the proxy turned off (the UI writes 0x0, the value stays). */
const REG_SAMPLE_OFF = REG_SAMPLE_ON.replace("0x1", "0x0");

/** The per-protocol ProxyServer form: http=/https=/ftp=/socks= in one value. */
const REG_SAMPLE_PER_PROTO = REG_SAMPLE_ON.replace(
  "127.0.0.1:8080",
  "http=proxy:8080;https=proxys:8443;ftp=proxyf:21;socks=proxys5:1080"
);

/** Only a socks= entry: Windows routes every protocol through it. */
const REG_SAMPLE_SOCKS_ONLY = REG_SAMPLE_ON.replace("127.0.0.1:8080", "socks=proxys5:1080");

/** A raw TCP server that records the full CONNECT request head, then refuses. */
function startCaptureConnectProxy() {
  const seen = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => { try { socket.destroy(); } catch { /* gone */ } });
    socket.once("data", (buf) => {
      const head = buf.toString("latin1").split("\r\n\r\n")[0];
      const lines = head.split("\r\n");
      const target = (/^CONNECT (\S+) HTTP/.exec(lines[0] || "") || [])[1] || lines[0];
      const headers = {};
      for (const line of lines.slice(1)) {
        const c = line.indexOf(":");
        if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
      }
      seen.push({ target, headers });
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, sockets, port: server.address().port }));
  });
}

/** An HTTP forward proxy for plain absolute-URI requests; records every hop's headers. */
function startForwardProxy() {
  const seen = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    sockets.add(req.socket);
    seen.push({ url: req.url, host: req.headers.host || "", authorization: req.headers["proxy-authorization"] || null });
    const up = http.request(req.url, { method: req.method }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on("error", () => { try { res.destroy(); } catch { /* gone */ } });
    req.pipe(up);
  });
  server.on("connection", (s) => sockets.add(s));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, sockets, port: server.address().port }));
  });
}

/** Assert nothing in a message list carries the credential in either form. */
function assertNoCredential(texts, what) {
  for (const t of texts) {
    const s = String(t);
    assert.ok(!s.includes(PROXY_USER + ":" + PROXY_PASS), what + " must not contain the raw credential: " + s);
    assert.ok(!s.includes(PROXY_B64_TAIL), what + " must not contain the base64 credential: " + s);
  }
}

async function main() {
  const suite = new Suite("batch7-proxyauth");
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + (r.ms > 400 ? "  (" + r.ms + "ms)" : "") + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " + String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-batch7-proxyauth-"));
  const out = path.join(home, "out");
  await fsp.mkdir(out, { recursive: true });
  process.env.DOWNLOADX_HOME = home;

  const netMod = await import("../src/net.mjs");
  const sysproxy = await import("../src/sysproxy.mjs");

  const servers = [];
  try {
    // ============================================== pure parsers: registry
    suite.group("sysproxy parsers: reg query samples (win32 forms)");

    await suite.test("parseRegQueryOutput: enabled single-form sample", async () => {
      const r = sysproxy.parseRegQueryOutput(REG_SAMPLE_ON);
      assert.equal(r.enable, true);
      assert.equal(r.server, "127.0.0.1:8080");
      assert.equal(r.override, "localhost;127.0.0.1;<local>");
    });

    await suite.test("parseRegQueryOutput: ProxyEnable 0x0 means disabled, value kept", async () => {
      const r = sysproxy.parseRegQueryOutput(REG_SAMPLE_OFF);
      assert.equal(r.enable, false);
      assert.equal(r.server, "127.0.0.1:8080", "the stale server value stays visible to the caller");
    });

    await suite.test("parseProxyServer: single form serves both schemes", async () => {
      const r = sysproxy.parseProxyServer("127.0.0.1:8080");
      assert.deepEqual(r, { http: "http://127.0.0.1:8080", https: "http://127.0.0.1:8080" });
    });

    await suite.test("parseProxyServer: per-protocol form maps http=/https=, ignores ftp=", async () => {
      const r = sysproxy.parseProxyServer("http=proxy:8080;https=proxys:8443;ftp=proxyf:21;socks=proxys5:1080");
      assert.deepEqual(r, { http: "http://proxy:8080", https: "http://proxys:8443" });
    });

    await suite.test("parseProxyServer: socks-only form becomes a socks5 URL for both schemes", async () => {
      const r = sysproxy.parseProxyServer("socks=proxys5:1080");
      assert.deepEqual(r, { http: "socks5://proxys5:1080", https: "socks5://proxys5:1080" });
    });

    await suite.test("parseProxyServer: garbage and empty yield null", async () => {
      assert.equal(sysproxy.parseProxyServer(""), null);
      assert.equal(sysproxy.parseProxyServer(null), null);
      assert.equal(sysproxy.parseProxyServer(";;=;"), null);
    });

    await suite.test("parseProxyOverride: semicolon list, empties dropped, <local> kept", async () => {
      assert.deepEqual(sysproxy.parseProxyOverride("localhost; 127.0.0.1 ;;<local>;"), ["localhost", "127.0.0.1", "<local>"]);
      assert.deepEqual(sysproxy.parseProxyOverride(""), []);
    });

    // ============================================ pure parsers: posix env
    suite.group("sysproxy parsers: environment forms (posix)");

    await suite.test("parseEnvProxy: upper-case pair plus no_proxy list", async () => {
      const r = sysproxy.parseEnvProxy({
        HTTP_PROXY: "http://up:8080", HTTPS_PROXY: "http://ups:8443",
        NO_PROXY: "a.com, .b.org ,*",
      });
      assert.deepEqual(r, { http: "http://up:8080", https: "http://ups:8443", noProxy: ["a.com", ".b.org", "*"] });
    });

    await suite.test("parseEnvProxy: all_proxy covers both schemes, scheme preserved", async () => {
      const r = sysproxy.parseEnvProxy({ all_proxy: "socks5://s:1080" });
      assert.deepEqual(r, { http: "socks5://s:1080", https: "socks5://s:1080", noProxy: [] });
    });

    await suite.test("parseEnvProxy: bare host gains http://; nothing set yields null", async () => {
      assert.deepEqual(sysproxy.parseEnvProxy({ http_proxy: "proxy:3128" }).http, "http://proxy:3128");
      assert.equal(sysproxy.parseEnvProxy({}), null);
      assert.equal(sysproxy.parseEnvProxy({ no_proxy: "x.com" }), null, "an exclusion list alone is not a proxy");
    });

    await suite.test("matchesNoProxy: <local>, domains, exact hosts, *", async () => {
      assert.equal(sysproxy.matchesNoProxy("localhost", ["localhost", "127.0.0.1"]), true);
      assert.equal(sysproxy.matchesNoProxy("intranet", ["<local>"]), true);
      assert.equal(sysproxy.matchesNoProxy("a.b", ["<local>"]), false);
      assert.equal(sysproxy.matchesNoProxy("x.a.com", [".a.com"]), true);
      assert.equal(sysproxy.matchesNoProxy("a.com", [".a.com"]), true);
      assert.equal(sysproxy.matchesNoProxy("nota.com", [".a.com"]), false);
      assert.equal(sysproxy.matchesNoProxy("x.a.com", ["a.com"]), true, "an exact entry covers its subdomains");
      assert.equal(sysproxy.matchesNoProxy("b.com", ["a.com"]), false);
      assert.equal(sysproxy.matchesNoProxy("any.host", ["*"]), true);
      assert.equal(sysproxy.matchesNoProxy("any.host", []), false);
      assert.equal(sysproxy.matchesNoProxy("", ["*"]), false);
    });

    // P-21: the native Windows ProxyOverride forms the simplified matcher
    // used to drop on the floor — prefix wildcards ("127.*") and a <local>
    // that must also cover loopback. Five pinned families: prefix wildcard
    // 127.*, prefix wildcard 192.168.*, <local>, exact domain, no match.
    await suite.test("matchesNoProxy: Windows prefix wildcards and loopback <local> (P-21)", async () => {
      // "127.*" — prefix match, anchored by the dot.
      assert.equal(sysproxy.matchesNoProxy("127.0.0.1", ["127.*"]), true);
      assert.equal(sysproxy.matchesNoProxy("127.9.9.9", ["127.*"]), true);
      assert.equal(sysproxy.matchesNoProxy("1270.0.0.1", ["127.*"]), false, "the dot anchors the prefix");
      assert.equal(sysproxy.matchesNoProxy("128.0.0.1", ["127.*"]), false);
      // "192.168.*" — the other native form from the field report.
      assert.equal(sysproxy.matchesNoProxy("192.168.1.5", ["192.168.*"]), true);
      assert.equal(sysproxy.matchesNoProxy("192.169.1.5", ["192.168.*"]), false);
      // "<local>" — dotless hostnames as before, plus loopback (P-21).
      assert.equal(sysproxy.matchesNoProxy("my-pc", ["<local>"]), true, "dotless hostname stays local");
      assert.equal(sysproxy.matchesNoProxy("host.corp", ["<local>"]), false, "dotted non-loopback is not local");
      assert.equal(sysproxy.matchesNoProxy("127.0.0.2", ["<local>"]), true, "dotted loopback is local");
      assert.equal(sysproxy.matchesNoProxy("::1", ["<local>"]), true, "ipv6 loopback is local");
      // exact domain entry keeps its curl-style semantics next to wildcards.
      assert.equal(sysproxy.matchesNoProxy("example.com", ["example.com"]), true);
      assert.equal(sysproxy.matchesNoProxy("sub.example.com", ["example.com"]), true);
      assert.equal(sysproxy.matchesNoProxy("badexample.com", ["example.com"]), false);
      // a realistic mixed list, and a host nothing in it matches.
      assert.equal(sysproxy.matchesNoProxy("192.168.0.3", ["localhost", "127.*", "192.168.*", "<local>", "example.com"]), true);
      assert.equal(sysproxy.matchesNoProxy("8.8.8.8", ["localhost", "127.*", "192.168.*", "<local>", "example.com"]), false);
    });

    // ================================= resolveSystemProxy: branches/cache/failure
    suite.group("resolveSystemProxy: injected branches, 30s cache, never throws");

    await suite.test("win32 branch parses the reg output through the injected runner", async () => {
      sysproxy.clearSystemProxyCache();
      const r = await sysproxy.resolveSystemProxy({
        platform: "win32", force: true,
        runner: async () => REG_SAMPLE_PER_PROTO,
      });
      assert.deepEqual(r, { http: "http://proxy:8080", https: "http://proxys:8443", noProxy: ["localhost", "127.0.0.1", "<local>"] });
    });

    await suite.test("win32 branch: ProxyEnable=0 and a failed reg both mean null", async () => {
      sysproxy.clearSystemProxyCache();
      assert.equal(await sysproxy.resolveSystemProxy({ platform: "win32", force: true, runner: async () => REG_SAMPLE_OFF }), null);
      assert.equal(
        await sysproxy.resolveSystemProxy({ platform: "win32", force: true, runner: async () => { throw new Error("reg exploded"); } }),
        null,
        "a runner failure must collapse to null, never throw"
      );
    });

    await suite.test("posix branch reads the injected environment", async () => {
      sysproxy.clearSystemProxyCache();
      const r = await sysproxy.resolveSystemProxy({
        platform: "linux", force: true,
        env: { https_proxy: "http://ups:8443", no_proxy: "a.com" },
      });
      assert.deepEqual(r, { http: null, https: "http://ups:8443", noProxy: ["a.com"] });
    });

    await suite.test("the 30s cache serves results and failures without re-running", async () => {
      sysproxy.clearSystemProxyCache();
      let calls = 0;
      let fakeNow = 1000;
      const now = () => fakeNow;
      const runner = async () => { calls++; return REG_SAMPLE_ON; };
      const a = await sysproxy.resolveSystemProxy({ platform: "win32", runner, now, force: true });
      assert.equal(calls, 1);
      fakeNow = 1000 + 29_999;
      const b = await sysproxy.resolveSystemProxy({ platform: "win32", runner, now });
      assert.equal(calls, 1, "a fresh-enough cache must not re-run the runner");
      assert.equal(b.http, a.http);
      fakeNow = 1000 + 30_001;
      await sysproxy.resolveSystemProxy({ platform: "win32", runner, now });
      assert.equal(calls, 2, "an expired cache must re-run the runner");
      // A failure is cached the same way: one reg attempt per window, even broken.
      calls = 0;
      const failing = async () => { calls++; throw new Error("nope"); };
      assert.equal(await sysproxy.resolveSystemProxy({ platform: "win32", runner: failing, now, force: true }), null);
      assert.equal(await sysproxy.resolveSystemProxy({ platform: "win32", runner: failing, now }), null);
      assert.equal(calls, 1, "a cached failure must not re-run the runner");
      sysproxy.clearSystemProxyCache();
    });

    // ============================================== proxyMode selection logic
    suite.group("selectRunProxy: the three modes");

    const { selectRunProxy } = await import("../src/downloader.mjs");
    const SYS = { http: "http://sys-http:1", https: "http://sys-https:2", noProxy: ["internal.test"] };

    await suite.test("manual uses the Settings proxy; empty Settings means direct", async () => {
      assert.equal(selectRunProxy({ taskProxy: undefined, mode: "manual", configured: "http://m:3", url: "http://x/", systemProxy: null }), "http://m:3");
      assert.equal(selectRunProxy({ taskProxy: undefined, mode: "manual", configured: "", url: "http://x/", systemProxy: SYS }), undefined);
    });

    await suite.test("none goes direct even when a Settings proxy is configured", async () => {
      assert.equal(selectRunProxy({ taskProxy: undefined, mode: "none", configured: "http://m:3", url: "http://x/", systemProxy: SYS }), undefined);
    });

    await suite.test("system prefers the discovery, scheme-appropriate", async () => {
      assert.equal(selectRunProxy({ taskProxy: undefined, mode: "system", configured: "http://m:3", url: "https://x/", systemProxy: SYS }), "http://sys-https:2");
      assert.equal(selectRunProxy({ taskProxy: undefined, mode: "system", configured: "http://m:3", url: "http://x/", systemProxy: SYS }), "http://sys-http:1");
    });

    await suite.test("system falls back to Settings when discovery finds nothing (the fixed ruling)", async () => {
      assert.equal(selectRunProxy({ taskProxy: undefined, mode: "system", configured: "http://m:3", url: "http://x/", systemProxy: null }), "http://m:3");
      assert.equal(selectRunProxy({ taskProxy: undefined, mode: "system", configured: "", url: "http://x/", systemProxy: null }), undefined);
    });

    await suite.test("system: a noProxy host goes direct; a missing scheme entry crosses over", async () => {
      assert.equal(selectRunProxy({ taskProxy: undefined, mode: "system", configured: "http://m:3", url: "http://internal.test/f", systemProxy: SYS }), undefined);
      const onlyHttps = { http: null, https: "http://sys-https:2", noProxy: [] };
      assert.equal(selectRunProxy({ taskProxy: undefined, mode: "system", configured: "", url: "http://x/", systemProxy: onlyHttps }), "http://sys-https:2");
      assert.equal(selectRunProxy({ taskProxy: undefined, mode: "system", configured: "http://m:3", url: "http://x/", systemProxy: { http: null, https: null, noProxy: [] } }), "http://m:3");
    });

    await suite.test("a per-task proxy outranks every mode; an unknown mode behaves as system", async () => {
      for (const mode of ["manual", "none", "system"]) {
        assert.equal(selectRunProxy({ taskProxy: "http://task:9", mode, configured: "http://m:3", url: "https://x/", systemProxy: SYS }), "http://task:9", "mode " + mode);
      }
      assert.equal(selectRunProxy({ taskProxy: undefined, mode: "bogus", configured: "http://m:3", url: "http://x/", systemProxy: null }), "http://m:3");
    });

    // ============================================ CONNECT credential injection
    suite.group("net: Proxy-Authorization on the proxy hops");

    await suite.test("proxyAuthHeader: value, URL-decoding, and the null cases", async () => {
      assert.equal(netMod.proxyAuthHeader("http://" + PROXY_CRED_URL_PART + "h:1"), PROXY_BASIC);
      const encoded = "http://" + encodeURIComponent("u@x") + ":" + encodeURIComponent("p:q") + "@h:1";
      assert.equal(netMod.proxyAuthHeader(encoded), "Basic " + Buffer.from("u@x:p:q", "utf8").toString("base64"), "%XX escapes decode before base64");
      assert.equal(netMod.proxyAuthHeader("http://h:1"), null);
      assert.equal(netMod.proxyAuthHeader("not a url"), null);
      assert.equal(netMod.proxyAuthHeader(undefined), null);
    });

    const capture = await startCaptureConnectProxy();
    servers.push(capture.server);
    const CRED_PROXY = "http://" + PROXY_CRED_URL_PART + "127.0.0.1:" + capture.port;

    await suite.test("a CONNECT through a credentialed proxy carries the exact Basic header", async () => {
      let err = null;
      try {
        await netMod.request("https://origin.example/x.bin", { proxy: CRED_PROXY, timeoutMs: 5000 });
      } catch (e) { err = e; }
      assert.ok(err, "the refusing proxy must fail the request");
      assert.equal(capture.seen.length, 1, "exactly one CONNECT (no TLS-profile retry for a proxy refusal)");
      assert.equal(capture.seen[0].target, "origin.example:443");
      assert.equal(capture.seen[0].headers["proxy-authorization"], PROXY_BASIC);
      assert.equal(capture.seen[0].headers["proxy-connection"], "keep-alive");
      assert.equal(capture.seen[0].headers["host"], "origin.example:443");
    });

    await suite.test("the failure text never carries the credential (raw or base64)", async () => {
      capture.seen.length = 0;
      let err = null;
      try {
        await netMod.request("https://origin.example/y.bin", { proxy: CRED_PROXY, timeoutMs: 5000 });
      } catch (e) { err = e; }
      assert.ok(err);
      assert.match(String(err.message), /proxy CONNECT failed: HTTP 403 for origin\.example/);
      assertNoCredential([err.message, String(err && err.stack || "")], "the CONNECT error");
    });

    await suite.test("a proxy URL without credentials sends no Proxy-Authorization", async () => {
      capture.seen.length = 0;
      try { await netMod.request("https://origin.example/z.bin", { proxy: "http://127.0.0.1:" + capture.port, timeoutMs: 5000 }); } catch { /* expected */ }
      assert.equal(capture.seen.length, 1);
      assert.equal(capture.seen[0].headers["proxy-authorization"], undefined);
    });

    const fwd = await startForwardProxy();
    servers.push(fwd.server);
    // The credentialed URL of the FORWARD proxy (CRED_PROXY above points at
    // the CONNECT-capture one, which answers 403 to everything).
    const FWD_CRED_PROXY = "http://" + PROXY_CRED_URL_PART + "127.0.0.1:" + fwd.port;
    // A separate origin for the plain-HTTP hop: the forward proxy dials the
    // absolute URI it receives, so the target must not be the proxy itself.
    const answer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Length": 7 });
      res.end("proxied");
    });
    servers.push(answer);
    await new Promise((r) => answer.listen(0, "127.0.0.1", r));
    const answerPort = answer.address().port;

    await suite.test("plain HTTP through the proxy carries the header too (absolute-URI hop)", async () => {
      const res = await netMod.request("http://127.0.0.1:" + answerPort + "/hop", {
        proxy: FWD_CRED_PROXY, timeoutMs: 5000,
      });
      let body = "";
      for await (const chunk of res.stream) body += chunk.toString("utf8");
      assert.equal(body, "proxied");
      assert.equal(fwd.seen.length, 1);
      assert.equal(fwd.seen[0].authorization, PROXY_BASIC);
      assert.match(fwd.seen[0].url, new RegExp("^http://127\\.0\\.0\\.1:" + answerPort + "/hop$"), "an absolute URI must reach the proxy");
    });

    // ======================================= end-to-end through the downloader
    suite.group("end-to-end: proxyMode drives a real transfer");

    const origin = await startOrigin();
    servers.push(origin.server);
    const { Config } = await import("../src/config.mjs");
    const { Downloader } = await import("../src/downloader.mjs");

    const config = new Config(path.join(home, "config.json"));
    await config.load();
    await config.set({
      defaultDir: out,
      categorizeByType: false,
      overwriteExisting: "overwrite",
      maxRetries: 0,
      retryBaseMs: 50,
    });
    const downloader = new Downloader({ config, queue: null });
    const logMessages = [];
    downloader.on("log", (e) => { if (e && e.message) logMessages.push(e.message); });

    const DATA_URL = origin.origin + "/throttle/4096/1024/0";
    const runTask = (id, filename) => downloader.run({ id, url: DATA_URL, filename });

    await suite.test("system mode: the discovered (seeded) proxy is used, authenticated, and the bytes land", async () => {
      // Seed the module cache with a "discovered" credentialed proxy — the
      // same object resolveSystemProxy() would return, so the downloader's
      // real call inside run() reads it from the 30s cache. No real registry
      // is touched, and the win32 branch on this machine never runs.
      const seeded = await sysproxy.resolveSystemProxy({
        platform: "linux", force: true,
        env: { http_proxy: "http://" + PROXY_CRED_URL_PART + "127.0.0.1:" + fwd.port },
      });
      assert.equal(seeded.http, "http://" + PROXY_CRED_URL_PART + "127.0.0.1:" + fwd.port);

      await config.set({ proxyMode: "system", proxy: "" });
      fwd.seen.length = 0;
      const r = await runTask("sys-1", "sys-mode.bin");
      assert.equal(r.ok, true, "the transfer must succeed through the discovered proxy");
      assert.equal(r.bytes, 4096);
      assert.ok(fwd.seen.length >= 1, "the forward proxy must have seen the traffic");
      for (const hop of fwd.seen) {
        assert.equal(hop.authorization, PROXY_BASIC, "every proxied hop carries the credential");
        assert.match(hop.url, /^http:\/\/127\.0\.0\.1:\d+\//, "requests reach the proxy as absolute URIs");
      }
      const body = await fsp.readFile(path.join(out, "sys-mode.bin"));
      assert.equal(body.length, 4096);
      assert.equal(body.equals(payloadFor(4096)), true, "the published bytes are exactly what the origin served");
    });

    await suite.test("none mode: a configured Settings proxy is ignored, the transfer goes direct", async () => {
      await config.set({ proxyMode: "none", proxy: "http://127.0.0.1:1" });   // port 1: instant refusal if used
      fwd.seen.length = 0;
      const r = await runTask("none-1", "none-mode.bin");
      assert.equal(r.ok, true, "mode none must not touch any proxy, not even the Settings one");
      assert.equal(fwd.seen.length, 0, "no proxied hop may exist in none mode");
      assert.equal((await fsp.readFile(path.join(out, "none-mode.bin"))).length, 4096);
    });

    await suite.test("manual mode: the Settings proxy is consumed for real (and a dead one fails the task)", async () => {
      await config.set({ proxyMode: "manual", proxy: "http://127.0.0.1:1" });
      fwd.seen.length = 0;
      let err = null;
      try {
        await runTask("manual-1", "manual-mode.bin");
      } catch (e) { err = e; }
      assert.ok(err, "a dead manual proxy must fail the task, proving config.proxy is consumed");
      assert.match(String(err.message), /127\.0\.0\.1:1|连接被拒绝|ECONNREFUSED/i);
      assert.equal(fwd.seen.length, 0);
      assert.equal(fsExists(path.join(out, "manual-mode.bin")), false, "nothing may be published");
    });

    await suite.test("no log line ever carried the credential", async () => {
      assertNoCredential(logMessages, "downloader log output");
    });
  } finally {
    for (const s of servers) {
      await new Promise((r) => { try { s.closeAllConnections?.(); } catch { /* none */ } s.close(() => r()); setTimeout(r, 300); });
    }
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

/** Synchronous exists, for the "nothing was published" assertions. */
function fsExists(p) { return fs.existsSync(p); }

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch7-proxyauth crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
