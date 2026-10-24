// Real-network acceptance checks.
//
// The default suite (test/acceptance.mjs) uses local deterministic fixtures and
// always runs offline. This script is the opposite: it exercises live public
// endpoints, so it is opt-in, records SKIP when the network is unavailable, and
// never reports a skip as a pass.
//
// Nine scenarios. Eight reach public endpoints; `interrupt-real` uses a server
// this script owns because a public host cannot be told to drop a connection on
// demand. That record carries `controlled: true` and must not be read as
// public-network evidence.
//
// Usage:
//   node test/acceptance-real.mjs
//   node test/acceptance-real.mjs --only https-range
//   node test/acceptance-real.mjs --list
//   node test/acceptance-real.mjs --timeout 120000
//   node test/acceptance-real.mjs --proxy http://127.0.0.1:7897
//   node test/acceptance-real.mjs --probe-selfcheck   (offline: proves the probe itself)
//
// Results are written to test/acceptance-runs-real/<timestamp>/ as result.json
// and RESULT.md, with latest.json / latest.md pointers. DOWNLOADX_ACCEPT_OUT
// redirects that directory; the default is unchanged.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** Endpoints. Kept in one place so a dead host is easy to replace. */
const SCENARIOS = {
  "https-range": {
    title: "HTTPS ranged multi-connection download",
    url: "https://proof.ovh.net/files/10Mb.dat",
    expectBytes: 10 * 1024 * 1024,
    tolerancePct: 5,
  },
  "tls-expired-rejected": {
    title: "Expired certificate is rejected by default",
    url: "https://expired.badssl.com/",
    expectFailure: true,
  },
  "tls-insecure-allowed": {
    title: "Expired certificate accepted only with --insecure",
    url: "https://expired.badssl.com/",
    insecure: true,
    // This scenario expects the default TLS check to fail, so reachability
    // cannot be decided by a certificate-validating request. It uses a TCP
    // connect instead, and only a real connection failure yields SKIP.
    probeTransport: true,
  },
  "hls-live": {
    title: "Real HLS playlist downloads and muxes to media",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    kind: "hls",
    needsFfmpeg: true,
    minBytes: 1024 * 1024,
    // ~478 MB through a proxy took 177-204 s in practice; the CLI needs room to
    // finish the whole 634 s stream and mux it. The default 180 s budget was
    // below what the same URL costs on a slower day: measured 2026-10-20,
    // 502,204,400 B took 389.8 s through the proxy, and the run was killed at
    // 180 s with a correct-but-unfinished transfer. DASH already declares
    // 360000; HLS needs the same headroom, so the scenario is not failed for
    // being slower than the machine's network.
    timeoutMs: 600000,
  },
  "dash-live": {
    title: "Real DASH manifest downloads both tracks",
    url: "https://dash.akamaized.net/envivio/EnvivioDash3/manifest.mpd",
    kind: "dash",
    needsFfmpeg: true,
    minBytes: 1024 * 1024,
    timeoutMs: 360000,
  },
  "headers-vary": {
    title: "Live response headers change between requests",
    // Fetch the same resource twice and require an identical result even
    // though per-request headers (Date, Set-Cookie, X-Request-Id, ...) differ.
    // The point is that volatile headers are not mistaken for content changes.
    url: "https://proof.ovh.net/files/1Mb.dat",
    expectBytes: 1024 * 1024,
    tolerancePct: 5,
    headerProbe: true,
  },
  "interrupt-real": {
    title: "A connection dropped mid-transfer is not reported as success",
    // A public endpoint cannot be made to drop a connection on demand, so
    // this scenario uses a local server owned by the script. It is recorded
    // as a controlled stand-in, NOT as public-network evidence.
    url: "local://interrupt",
    localFixture: true,
    dropAfterBytes: 64 * 1024,
    totalBytes: 1024 * 1024,
  },
  "redirect-live": {
    title: "Live redirect chain resolves to content",
    url: "https://httpbingo.org/redirect/3",
  },
  "non2xx-live": {
    title: "A live 404 is reported as a failure, not a saved page",
    url: "https://httpbingo.org/status/404",
    expectFailure: true,
  },
};

function parseArgs(argv) {
  // A proxy is often required on machines behind a local gateway. It is read
  // from --proxy or DOWNLOADX_ACCEPT_PROXY so the suite stays usable there.
  const out = { only: null, list: false, timeout: 180000, verbose: false, selfcheck: false,
    proxy: process.env.DOWNLOADX_ACCEPT_PROXY || null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") out.only = argv[++i];
    else if (a === "--list") out.list = true;
    else if (a === "--timeout") out.timeout = Number(argv[++i]) || out.timeout;
    else if (a === "--verbose" || a === "-v") out.verbose = true;
    else if (a === "--proxy") out.proxy = argv[++i];
    else if (a === "--probe-selfcheck") out.selfcheck = true;
  }
  return out;
}

async function hashFile(target) {
  const h = createHash("sha256");
  const fh = await fsp.open(target, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      h.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return h.digest("hex");
}

/**
 * One HTTP request, optionally through an HTTP proxy, with node built-ins only.
 *
 * The helper this replaces asked undici for a ProxyAgent and returned undefined
 * when the import failed — and this project ships no node_modules, so every
 * --proxy run silently probed the *direct* route while the downloader used the
 * proxy. A probe that tests a different network path than the transfer it is
 * vouching for is worse than no probe: it reported the target unreachable and
 * the scenario was skipped for a reason that never applied.
 *
 * The proxy path is therefore implemented here: a CONNECT tunnel for https, an
 * absolute-form request for plain http. Failures carry `proxyFailure` so the
 * caller can tell "the proxy is unusable" from "the target is unreachable".
 */

const PROBE_UA = "downloadx-acceptance/1.0";

/** Proxy-address errors that mean the proxy itself is not reachable. */
const PROXY_DOWN_CODES = new Set([
  "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
]);

/** Split a proxy URL; returns { error } when the scheme is not usable here. */
function proxyParts(proxyUrl) {
  let u;
  try { u = new URL(proxyUrl); } catch (err) { return { error: "invalid proxy URL: " + err.message }; }
  const scheme = u.protocol.replace(":", "");
  if (scheme !== "http" && scheme !== "https") {
    return { error: "unsupported proxy scheme " + scheme + " (this probe speaks http/https CONNECT)" };
  }
  return { scheme, host: u.hostname, port: Number(u.port || (scheme === "https" ? 443 : 80)) };
}

/**
 * Open a CONNECT tunnel through an HTTP proxy.
 *
 * Rejections are tagged: `proxyFailure: true` means the proxy could not be used
 * (refused, unreachable, timed out, or demanding credentials); a non-2xx answer
 * such as 502 means the proxy is fine but the target did not answer.
 */
function connectTunnel(proxyUrl, host, port, timeoutMs) {
  const p = proxyParts(proxyUrl);
  if (p.error) return Promise.reject(Object.assign(new Error(p.error), { proxyFailure: true }));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: p.host, port: p.port, method: "CONNECT", path: host + ":" + port,
      headers: { Host: host + ":" + port, "Proxy-Connection": "keep-alive" }, agent: false,
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(
      new Error("CONNECT to proxy " + p.host + ":" + p.port + " timed out after " + timeoutMs + " ms"),
      { proxyFailure: true, code: "ETIMEDOUT" })));
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        const auth = res.statusCode === 407;
        reject(Object.assign(
          new Error("proxy CONNECT for " + host + ":" + port + " answered HTTP " + res.statusCode),
          { proxyFailure: auth, code: auth ? "EPROXYAUTH" : "EPROXYTARGET" }));
        return;
      }
      socket.setNoDelay(true);
      resolve(socket);
    });
    req.once("error", (err) => reject(Object.assign(
      new Error("CONNECT to proxy " + p.host + ":" + p.port + " failed: " + err.message),
      { proxyFailure: PROXY_DOWN_CODES.has(err.code), code: err.code })));
    req.end();
  });
}

/** Collect one response to completion, releasing the socket on every path. */
function collectResponse(req, timeoutMs, release) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      try { if (release) release(); } catch { /* already gone */ }
      fn(arg);
    };
    req.setTimeout(timeoutMs, () => req.destroy(new Error("request timed out after " + timeoutMs + " ms")));
    req.once("error", (err) => finish(reject, err));
    req.once("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.once("end", () => finish(resolve, {
        statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks),
      }));
      res.once("error", (err) => finish(reject, err));
    });
    req.end();
  });
}

/** An https.Agent that hands back one already-established tunnel socket. */
class TunnelAgent extends https.Agent {
  constructor(socket) {
    super({ keepAlive: false, maxSockets: 1 });
    this.tunnelSocket = socket;
  }
  createConnection() { return this.tunnelSocket; }
}

/**
 * One request: direct, or through `proxy` when one is configured.
 *
 * `ca` and `insecure` exist for the offline self-check, whose origin speaks TLS
 * with this repository's own fixture certificate.
 *
 * @returns {Promise<{statusCode:number, headers:object, body:Buffer}>}
 */
async function httpOnce(url, opts = {}) {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const port = Number(u.port || (isHttps ? 443 : 80));
  const method = String(opts.method || "GET").toUpperCase();
  const timeoutMs = opts.timeoutMs ?? 15000;
  const headers = {
    Host: u.host, "User-Agent": PROBE_UA, "Accept-Encoding": "identity", ...(opts.headers || {}),
  };

  if (!opts.proxy) {
    const mod = isHttps ? https : http;
    const req = mod.request({
      host: u.hostname, port, path: u.pathname + u.search, method, headers, agent: false,
      ca: opts.ca, rejectUnauthorized: opts.insecure ? false : undefined,
    });
    return await collectResponse(req, timeoutMs, null);
  }

  const p = proxyParts(opts.proxy);
  if (p.error) throw Object.assign(new Error(p.error), { proxyFailure: true });

  if (!isHttps) {
    // Plain http goes to the proxy in absolute form; no tunnel is involved.
    const req = http.request({ host: p.host, port: p.port, path: u.href, method, headers, agent: false });
    const res = await collectResponse(req, timeoutMs, null);
    if (res.statusCode === 407) {
      throw Object.assign(new Error("proxy requires authentication (HTTP 407)"), { proxyFailure: true });
    }
    return res;
  }

  const tunnel = await connectTunnel(opts.proxy, u.hostname, port, timeoutMs);
  // No SNI for an IP literal: RFC 6066 forbids it and Node warns about it.
  const sni = net.isIP(u.hostname) ? undefined : u.hostname;
  const tlsSocket = tls.connect({
    socket: tunnel, servername: sni, ALPNProtocols: ["http/1.1"],
    ca: opts.ca, rejectUnauthorized: opts.insecure ? false : true,
  });
  // A failed handshake must surface through the request, not as an unhandled
  // 'error' event on the socket.
  tlsSocket.on("error", () => {});
  const release = () => {
    try { tlsSocket.destroy(); } catch { /* gone */ }
    try { tunnel.destroy(); } catch { /* gone */ }
  };
  try {
    // A custom agent, NOT `createConnection` in the request options: Node's
    // https.Agent owns that method, so the option is silently ignored and the
    // request is made over a *direct* TLS connection to the target while the
    // tunnel sits idle. Verified against a proxy that ignores the requested
    // host: with the option form the request went direct and never appeared in
    // the tunnel.
    const req = https.request({
      host: u.hostname, port, path: u.pathname + u.search, method, headers,
      agent: new TunnelAgent(tlsSocket),
    });
    const res = await collectResponse(req, timeoutMs, release);
    if (res.statusCode === 407) {
      throw Object.assign(new Error("proxy requires authentication (HTTP 407)"), { proxyFailure: true });
    }
    return res;
  } finally {
    release();
  }
}

/**
 * Can we open a network path to this URL's host and port?
 *
 * Used for scenarios where a certificate-validating request is expected to
 * fail. It answers only "is the path usable", leaving the TLS verdict to the
 * scenario itself. With a proxy configured the path that matters is the tunnel:
 * a direct connect would test a route the downloader does not take.
 */
async function tcpReachable(url, timeoutMs = 15000, proxy = null) {
  let host;
  let port;
  try {
    const u = new URL(url);
    host = u.hostname;
    port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  } catch (err) {
    return { ok: false, reason: "invalid URL: " + err.message };
  }
  if (proxy) {
    try {
      const socket = await connectTunnel(proxy, host, port, timeoutMs);
      try { socket.destroy(); } catch { /* gone */ }
      return { ok: true, viaProxy: true };
    } catch (err) {
      return { ok: false, reason: err.message, proxyFailure: Boolean(err.proxyFailure), viaProxy: true };
    }
  }
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => { try { socket.destroy(); } catch { /* gone */ } resolve(result); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done({ ok: true }));
    socket.once("timeout", () => done({ ok: false, reason: "TCP connect to " + host + ":" + port + " timed out after " + timeoutMs + " ms" }));
    socket.once("error", (err) => done({ ok: false, reason: "TCP connect to " + host + ":" + port + " failed: " + err.message }));
  });
}

/**
 * Is the network reachable at all, on the route the downloader will use?
 *
 * `proxyFailure: true` means the proxy itself is unusable. The caller reports
 * that as an environment problem and must never retry the target directly: a
 * silent fallback to a direct connection is exactly the defect being fixed.
 */
async function networkProbe(url, timeoutMs = 15000, proxy = null) {
  try {
    const res = await httpOnce(url, { method: "HEAD", timeoutMs, proxy });
    return { ok: true, statusCode: res.statusCode, viaProxy: Boolean(proxy) };
  } catch (err) {
    return {
      ok: false,
      reason: err.message,
      proxyFailure: Boolean(err.proxyFailure),
      viaProxy: Boolean(proxy),
    };
  }
}

function ffprobePath() {
  const explicit = process.env.FFPROBE_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const base = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA,
    "Microsoft", "WinGet", "Packages",
    "Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe",
    "ffmpeg-9.0.2-full_build-shared", "bin");
  if (base && fs.existsSync(path.join(base, "ffprobe.exe"))) return path.join(base, "ffprobe.exe");
  return "ffprobe";
}

function runCli(args, { timeoutMs = 180000, home } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "bin", "downloadx.mjs"), ...args], {
      cwd: ROOT,
      env: { ...process.env, DOWNLOADX_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ code: -1, out, err, timedOut: true }); }, timeoutMs);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code: code ?? 0, out, err, timedOut: false }); });
  });
}

/** Run one real scenario. Returns a record with status PASS | FAIL | SKIP. */
async function runScenario(name, spec, args) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail: detail ?? "" });
  const record = (status, reason) => ({
    scenario: name, title: spec.title, status, reason: reason ?? null,
    url: spec.url, startedAt, elapsedMs: Date.now() - t0,
    timeoutMs: spec.timeoutMs ?? args.timeout, timedOut: false,
    output: null, bytes: null, sha256: null, probes: null, checks,
  });

  // ---- controlled local fixture: connection dropped mid-transfer ----------
  // A public host cannot be told to drop a connection, so this uses a server
  // the script owns. It is reported as a controlled stand-in (see
  // `controlled: true`), never as public-network evidence.
  if (spec.localFixture) {
    return await runLocalFixture(name, spec, args, record, add, checks);
  }

  // Reachability decides SKIP vs FAIL. A skip is never a pass.
  //
  // A scenario that EXPECTS a certificate rejection cannot use a plain probe:
  // the TLS error is the point, not a sign the network is down. For those the
  // check is that the host resolves and answers at the TCP/TLS layer at all.
  // 15 s, not 8: the target was measured reachable in 2.81 s while a Node
  // HEAD needed 5.6 s, so an 8 s budget turned a working network into SKIP.
  const reach = spec.probeTransport
    ? await tcpReachable(spec.url, 15000, args.proxy)
    : await networkProbe(spec.url, 15000, args.proxy);
  if (!reach.ok) {
    const expectedTlsRejection = Boolean(spec.expectFailure) && /certificate|self.signed|expired|TLS/i.test(reach.reason || "");
    if (!expectedTlsRejection) {
      add("network-reachable", false, reach.reason);
      // "The proxy I was told to use is unusable" and "the target is
      // unreachable" are different findings, and only the first is an
      // environment problem. The direct route is deliberately NOT tried: a probe
      // must test the route the downloader will take, never a substitute for it.
      if (reach.proxyFailure) {
        add("proxy-available", false, reach.reason);
        return record("SKIP", "proxy unusable: " + reach.reason);
      }
      return record("SKIP", "network unavailable: " + reach.reason);
    }
    add("network-reachable", true, "reachable; TLS rejected as expected: " + reach.reason);
  } else {
    add("network-reachable", true, reach.viaProxy ? "through proxy " + args.proxy : "");
  }

  // Two live requests to the same URL must return the same bytes even though
  // volatile headers (Date, X-Request-Id, Set-Cookie, ...) differ. The check
  // is that such headers never make the client treat identical content as a
  // change, or a changed header as a reason to report success.
  let headerComparison = null;
  if (spec.headerProbe) {
    // A failure here must not escape: an unreachable host during the probe
    // used to crash the whole run instead of recording a result for this
    // scenario only.
    try {
      // Two live requests through the same client the probe uses, so the
      // comparison runs on the real route (proxied or direct) instead of on a
      // second code path that could differ from it.
      // Follow redirects the way fetch() used to, so a 3xx can never be
      // compared with the downloaded body as if it were the content.
      const grab = async () => {
        let res = await httpOnce(spec.url, { method: "GET", timeoutMs: 15000, proxy: args.proxy });
        for (let hop = 0; hop < 5 && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location; hop++) {
          res = await httpOnce(new URL(res.headers.location, spec.url).toString(),
            { method: "GET", timeoutMs: 15000, proxy: args.proxy });
        }
        return { headers: res.headers, buf: res.body, status: res.statusCode };
      };
      const first = await grab();
      const second = await grab();
      const differing = [];
      const keys = new Set([...Object.keys(first.headers), ...Object.keys(second.headers)]);
      for (const k of keys) {
        if (first.headers[k] !== second.headers[k]) differing.push(k);
      }
      headerComparison = {
        differing,
        sameBody: first.buf.equals(second.buf),
        bytes: first.buf.length,
      };
    } catch (err) {
      headerComparison = { error: err.message };
    }
  }
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-real-"));
  const outDir = path.join(home, "out");
  await fsp.mkdir(outDir, { recursive: true });

  try {
    const cliArgs = ["get", spec.url, "-o", outDir, "--filename", "live", "--quiet"];
    if (spec.kind) cliArgs.push("--kind", spec.kind);
    if (spec.insecure) cliArgs.push("--insecure");
    if (args.proxy) cliArgs.push("--proxy", args.proxy);
    // A scenario may declare its own timeout: media downloads need far more
    // room than a single-range check. Falling back to the global default kept
    // killing the HLS run and reporting an opaque exit code.
    const scenarioTimeout = spec.timeoutMs ?? args.timeout;
    const r = await runCli(cliArgs, { timeoutMs: scenarioTimeout, home });
    const target = path.join(outDir, "live");
    const exists = fs.existsSync(target);
    const bytes = exists ? fs.statSync(target).size : 0;

    // A harness timeout is a definite failure with a stated cause, never a
    // bare exit code that reads like a crash.
    if (r.timedOut) {
      add("completed-within-timeout", false,
        "the command did not finish within " + scenarioTimeout + " ms and was killed");
    } else {
      add("completed-within-timeout", true, "finished in under " + scenarioTimeout + " ms");
    }

    if (spec.expectFailure) {
      add("reported-failure", r.code !== 0, "exit code " + r.code + (r.err ? " :: " + r.err.trim().split("\n").slice(-1)[0] : ""));
      add("no-file-kept", !exists || bytes === 0, exists ? bytes + " bytes kept" : "no file");
      const ok = r.code !== 0;
      return { ...record(ok ? "PASS" : "FAIL", ok ? null : "expected a failure but the command succeeded"), bytes, output: target };
    }

    add("exit-code", r.code === 0, "exit code " + r.code + (r.err ? " :: " + r.err.trim().split("\n").slice(-2).join(" ") : ""));
    add("file-exists", exists, target);
    if (spec.insecure) {
      // The point of this scenario is that --insecure actually permitted a
      // transfer the default policy refused, so the file must hold bytes.
      add("file-nonempty", exists && bytes > 0, bytes + " bytes downloaded with --insecure");
    }
    if (spec.expectBytes) {
      const delta = Math.abs(bytes - spec.expectBytes) / spec.expectBytes * 100;
      add("size", delta <= (spec.tolerancePct ?? 5), bytes + " bytes, expected " + spec.expectBytes);
    }
    if (spec.minBytes) add("size", bytes >= spec.minBytes, bytes + " bytes, at least " + spec.minBytes);

    if (spec.headerProbe && headerComparison && headerComparison.error) {
      add("hdr-probe", false, "header probe failed: " + headerComparison.error);
    }
    if (spec.headerProbe && headerComparison && !headerComparison.error) {
      add("hdr-two-requests-differ", headerComparison.differing.length > 0,
        headerComparison.differing.length ? "volatile headers: " + headerComparison.differing.slice(0, 5).join(", ")
          : "no volatile header observed; the check is inconclusive here");
      add("hdr-same-body", headerComparison.sameBody,
        "both requests returned " + headerComparison.bytes + " bytes" +
        (headerComparison.sameBody ? ", identical" : ", CONTENT DIFFERED"));
      add("hdr-download-matches-live", bytes === headerComparison.bytes,
        "downloaded " + bytes + " bytes vs live " + headerComparison.bytes);
    }

    let sha256 = null;
    if (exists && bytes > 0) sha256 = await hashFile(target);

    // Media outputs must be recognisable by a real demuxer.
    let probes = null;
    if (spec.needsFfmpeg && exists && bytes > 0) {
      const pr = await new Promise((resolve) => {
        const c = spawn(ffprobePath(), ["-v", "error", "-show_entries", "stream=codec_type,codec_name",
          "-show_entries", "format=nb_streams,duration", "-of", "default=noprint_wrappers=1", target],
          { stdio: ["ignore", "pipe", "pipe"] });
        let o = "", e = "";
        c.stdout.on("data", (d) => { o += d; });
        c.stderr.on("data", (d) => { e += d; });
        c.on("error", () => resolve({ ok: false, text: "ffprobe not available" }));
        c.on("exit", (code) => resolve({ ok: code === 0, text: (o + e).trim() }));
      });
      probes = pr.text;
      add("ffprobe", pr.ok, pr.text.split("\n").slice(0, 4).join(" | "));
      add("has-media-stream", /video|audio/.test(pr.text), pr.text.slice(0, 120));
    }

    const ok = checks.every((c) => c.ok);
    return {
      ...record(ok ? "PASS" : "FAIL", ok ? null : "one or more checks failed"),
      timedOut: Boolean(r.timedOut),
      bytes, sha256, probes, output: target,
    };
  } catch (err) {
    add("unexpected-error", false, err.message);
    return record("FAIL", err.message);
  } finally {
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Run a scenario against a local server the script controls.
 *
 * Used where a public endpoint cannot be made to misbehave on demand. The
 * record is marked `controlled: true` so it can never be read as evidence
 * gathered from the public network.
 */
async function runLocalFixture(name, spec, args, record, add, checks) {
  const httpMod = await import("node:http");
  const totalBytes = spec.totalBytes;
  const dropAfterBytes = spec.dropAfterBytes;
  const body = Buffer.alloc(totalBytes, 0x42);
  let requests = 0;

  const srv = httpMod.createServer((req, res) => {
    requests++;
    // Drop after a prefix, ignoring Range: the client cannot assemble a
    // complete file no matter how it retries.
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(totalBytes) });
    res.write(body.subarray(0, dropAfterBytes));
    res.socket?.destroy();
  });
  srv.on("connection", (s) => s.on("error", () => {}));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + srv.address().port + "/file";

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-fixture-"));
  const outDir = path.join(home, "out");
  await fsp.mkdir(outDir, { recursive: true });

  try {
    add("controlled-stand-in", true,
      "served by a server owned by this script, not a public endpoint");
    const r = await runCli(["get", url, "-o", outDir, "--filename", "live", "--quiet",
      "-c", "1"], { timeoutMs: args.timeout, home });
    const target = path.join(outDir, "live");
    const exists = fs.existsSync(target);
    const bytes = exists ? fs.statSync(target).size : 0;

    add("origin-actually-dropped", requests > 0, requests + " request(s) served then dropped");
    add("exit-code-nonzero", r.code !== 0,
      "exit code " + r.code + (r.err ? " :: " + r.err.trim().split("\n").slice(-1)[0].slice(0, 100) : ""));
    add("no-complete-file-delivered", !exists || bytes < totalBytes,
      exists ? bytes + " bytes on disk, expected fewer than " + totalBytes : "no file kept");
    add("not-reported-as-success", !/done:/.test(r.out),
      /done:/.test(r.out) ? "the CLI printed a success summary" : "no success summary printed");

    const ok = checks.every((c) => c.ok);
    return {
      ...record(ok ? "PASS" : "FAIL", ok ? null : "one or more checks failed"),
      controlled: true, bytes, output: target,
    };
  } catch (err) {
    add("unexpected-error", false, err.message);
    return { ...record("FAIL", err.message), controlled: true };
  } finally {
    try { srv.closeAllConnections?.(); } catch { /* none */ }
    await new Promise((r) => { srv.close(() => r(undefined)); setTimeout(() => r(undefined), 1500); });
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}
function renderMarkdown(report) {
  const lines = [];
  lines.push("# Real-network acceptance run");
  lines.push("");
  lines.push("- Started: " + report.startedAt);
  lines.push("- Node: " + report.node);
  lines.push("- Platform: " + report.platform);
  lines.push("- Passed: **" + report.passed + "**  Failed: **" + report.failed + "**  Skipped: **" + report.skipped + "**");
  lines.push("- Total elapsed: " + (report.totalMs / 1000).toFixed(1) + " s");
  lines.push("");
  lines.push("A SKIP means the network was unreachable. It is not a pass.");
  lines.push("");
  lines.push("| Scenario | Status | Elapsed | Timeout | Bytes | SHA-256 | Note |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of report.results) {
    const note = r.controlled ? "controlled local stand-in" : String(r.reason || "").replace(/\|/g, "\\|").slice(0, 70);
    lines.push("| " + r.title + " | " + r.status + " | " + (r.elapsedMs / 1000).toFixed(1) + "s | " +
      ((r.timeoutMs || 0) / 1000).toFixed(0) + "s | " +
      (r.bytes === null ? "—" : r.bytes) + " | " + (r.sha256 ? r.sha256.slice(0, 16) + "…" : "—") + " | " + note + " |");
  }
  lines.push("");
  lines.push("## Checks");
  for (const r of report.results) {
    lines.push("");
    lines.push("### " + r.title + " — " + r.status);
    lines.push("");
    lines.push("URL: " + r.url);
    if (r.probes) { lines.push(""); lines.push("ffprobe: " + r.probes.split("\n").slice(0, 6).join(" / ")); }
    lines.push("");
    lines.push("| Check | Result | Detail |");
    lines.push("|---|---|---|");
    for (const c of r.checks) {
      lines.push("| " + c.id + " | " + (c.ok ? "PASS" : "FAIL") + " | " + String(c.detail).replace(/\|/g, "\\|").slice(0, 160) + " |");
    }
  }
  lines.push("");
  lines.push("## Reproduce");
  lines.push("");
  lines.push("```");
  lines.push("node test/acceptance-real.mjs");
  lines.push("```");
  return lines.join("\n");
}

/**
 * Offline proof that the reachability probe really goes through the proxy.
 *
 * Everything here is loopback: a TLS origin using this repository's fixture
 * certificate, and a real CONNECT proxy this script owns. Four cases, so the
 * positive path is proved and not only the failure path:
 *
 *   direct     - no proxy, the origin answers;
 *   tunnel     - the same URL through a CONNECT proxy answers, and the proxy
 *                really served a tunnel (a silent direct fallback would leave
 *                tunnels at 0 and fail this case);
 *   deadproxy  - a proxy on a closed port is reported as a proxy failure, and
 *                the target is NOT tested directly instead;
 *   deadtarget - a live proxy to a closed target port reports an unreachable
 *                target, not a proxy failure, so the two are distinguishable.
 *
 * Run with: node test/acceptance-real.mjs --probe-selfcheck
 */
async function runProbeSelfCheck() {
  const cases = [];
  const recordCase = (name, ok, detail) => {
    cases.push({ name, ok, detail });
    process.stdout.write("    " + (ok ? "PASS" : "FAIL") + "  " + name + "  - " + detail + "\n");
  };

  const ca = fs.readFileSync(path.join(HERE, "fixtures", "localhost-selfsigned.crt"));
  const key = fs.readFileSync(path.join(HERE, "fixtures", "localhost-selfsigned.key"));

  const origin = https.createServer({ key, cert: ca }, (req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "2" });
    res.end("ok");
  });
  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  const originUrl = "https://127.0.0.1:" + origin.address().port + "/file";

  const proxyState = { tunnels: 0 };
  const proxy = http.createServer((req, res) => { res.writeHead(405, { "Content-Length": "0" }); res.end(); });
  proxy.on("connect", (req, clientSocket, head) => {
    proxyState.tunnels++;
    const [host, portText] = String(req.url).split(":");
    const upstream = net.connect({ host, port: Number(portText || 443) });
    upstream.once("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const teardown = () => {
      try { upstream.destroy(); } catch { /* gone */ }
      try { clientSocket.destroy(); } catch { /* gone */ }
    };
    upstream.on("error", teardown);
    clientSocket.on("error", teardown);
  });
  proxy.on("connection", (s) => s.on("error", () => {}));
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const proxyUrl = "http://127.0.0.1:" + proxy.address().port;

  // A port that was just bound and released: nothing listens there.
  const closedPort = await new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

  try {
    {
      const res = await httpOnce(originUrl, { method: "HEAD", timeoutMs: 15000, ca });
      recordCase("direct probe reaches the local origin", res.statusCode === 200, "HTTP " + res.statusCode + ", no proxy");
    }
    {
      proxyState.tunnels = 0;
      const res = await httpOnce(originUrl, { method: "HEAD", timeoutMs: 15000, proxy: proxyUrl, ca });
      recordCase("probe through a real CONNECT proxy reaches the same origin",
        res.statusCode === 200 && proxyState.tunnels > 0,
        "HTTP " + res.statusCode + ", CONNECT tunnels=" + proxyState.tunnels);
    }
    {
      const deadProxy = "http://127.0.0.1:" + closedPort;
      const probe = await networkProbe(originUrl, 5000, deadProxy);
      recordCase("a dead proxy is a proxy failure, with no silent direct fallback",
        probe.ok === false && probe.proxyFailure === true,
        "networkProbe: " + probe.reason);
    }
    {
      const deadTarget = "https://127.0.0.1:" + closedPort + "/file";
      const probe = await networkProbe(deadTarget, 5000, proxyUrl);
      recordCase("an unreachable target through a live proxy is not called a proxy failure",
        probe.ok === false && probe.proxyFailure !== true,
        "networkProbe: " + probe.reason);
    }
  } finally {
    await new Promise((r) => { try { proxy.closeAllConnections?.(); } catch { /* none */ } proxy.close(() => r(undefined)); setTimeout(r, 1000); });
    await new Promise((r) => { try { origin.closeAllConnections?.(); } catch { /* none */ } origin.close(() => r(undefined)); setTimeout(r, 1000); });
  }

  const failed = cases.filter((c) => !c.ok).length;
  process.stdout.write("\n  probe self-check: " + (cases.length - failed) + " passed, " + failed + " failed\n\n");
  return failed > 0 ? 1 : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Offline mode: prove the probe itself with loopback servers only. No
  // public endpoint and no proxy outside this machine is touched.
  if (args.selfcheck) return await runProbeSelfCheck();
  let names = Object.keys(SCENARIOS);
  if (args.only) names = names.filter((n) => n === args.only);
  if (args.list) {
    for (const n of names) console.log("  " + n.padEnd(24) + SCENARIOS[n].title);
    return 0;
  }
  if (!names.length) { process.stderr.write("no scenarios selected\n"); return 2; }

  const startedAt = new Date().toISOString();
  process.stdout.write("\n  downloadx real-network acceptance\n");
  process.stdout.write("  these checks reach public endpoints; SKIP means unreachable\n\n");

  const results = [];
  const t0 = Date.now();
  for (const name of names) {
    process.stdout.write("  " + name.padEnd(24));
    const r = await runScenario(name, SCENARIOS[name], args);
    results.push(r);
    process.stdout.write(r.status.padEnd(5) + " " + (r.elapsedMs / 1000).toFixed(1) + "s" +
      (r.reason ? "  " + r.reason.slice(0, 70) : "") + "\n");
    if (args.verbose || r.status === "FAIL") {
      for (const c of r.checks) process.stdout.write("      " + (c.ok ? "ok  " : "FAIL") + " " + c.id + " — " + c.detail + "\n");
    }
  }
  const totalMs = Date.now() - t0;

  const report = {
    startedAt, node: process.version, platform: process.platform + " " + process.arch,
    totalMs, results,
    passed: results.filter((r) => r.status === "PASS").length,
    failed: results.filter((r) => r.status === "FAIL").length,
    skipped: results.filter((r) => r.status === "SKIP").length,
  };

  // The real-run evidence directory by default. DOWNLOADX_ACCEPT_OUT redirects
  // it, so an offline probe proof cannot overwrite the latest.json / latest.md
  // pointers a real run publishes.
  const outDir = process.env.DOWNLOADX_ACCEPT_OUT
    ? path.resolve(process.env.DOWNLOADX_ACCEPT_OUT)
    : path.join(ROOT, "test", "acceptance-runs-real");
  const runDir = path.join(outDir, startedAt.replace(/[:.]/g, "-"));
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, "result.json"), JSON.stringify(report, null, 2));
  await fsp.writeFile(path.join(runDir, "RESULT.md"), renderMarkdown(report));
  await fsp.writeFile(path.join(outDir, "latest.json"), JSON.stringify(report, null, 2));
  await fsp.writeFile(path.join(outDir, "latest.md"), renderMarkdown(report));

  process.stdout.write("\n  " + report.passed + " passed, " + report.failed + " failed, " +
    report.skipped + " skipped  (" + (totalMs / 1000).toFixed(1) + "s)\n");
  process.stdout.write("  result: " + path.join(runDir, "result.json") + "\n\n");

  // A skip must not be reported as success, but it is not a failure either.
  return report.failed > 0 ? 1 : 0;
}

main()
  .then((code) => {
    import("node:http").then((h) => h.default.globalAgent.destroy());
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write("\n  real acceptance crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
