// Batch-9 net regressions: the two `agent: false` deletions on the proxy
// tunnel paths (任务书第 1 项 / W1).
//
// net.mjs used to pass BOTH `agent: false` and `createConnection` to
// https.request()/http.request() on its two tunnelled paths. With `agent:
// false` Node builds a fresh no-option Agent whose own createConnection
// (plain net.connect) wins — the per-request factory is ignored, the tunnel
// socket is orphaned and every request goes DIRECT (probe A/D: ECONNREFUSED;
// probe C/E: with the option removed, the factory IS used). The fix deletes
// `agent: false` at the two tunnel sites and keeps it ONLY on the CONNECT
// request itself (net.mjs proxyConnect — no factory there, so it is harmless).
//
// What is proven here:
//   * guard: the source text carries "agent: false" exactly once, inside
//     proxyConnect(), and both createConnection factories survive;
//   * a real transfer in manual proxy mode through a hermetic HTTP CONNECT
//     proxy reaches https://nodejs.org/robots.txt end to end (real TLS through
//     the tunnel, real origin bytes);
//   * a DISCRIMINATING tunnel case: the origin is reachable ONLY through the
//     proxy (a .test hostname the proxy maps to a local TLS origin), so a
//     regression that ignores createConnection fails with ENOTFOUND instead of
//     silently going direct — the body must be our fixture byte-for-byte;
//   * the SOCKS5 plaintext path end to end against a hermetic SOCKS5 server
//     with a local http://127.0.0.1:<port>/ origin (the spec case), plus the
//     same discriminating variant through a name only the proxy can resolve.
//
// Everything runs against local servers and a throwaway DOWNLOADX_HOME; no
// user Downloads, no %APPDATA%\downloadx, nothing under D:/IAM/downloadx-data.
// The only public-network dependency is the nodejs.org case, which SKIPs with
// a printed reason when egress is blocked.
//
// Usage: node test/batch9-net.mjs

import net from "node:net";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NL = String.fromCharCode(10);

// A crash must never be silent: an unhandled socket error or rejection leaves
// a full stack on stderr and a NONZERO exit, so a gate run can diagnose it
// instead of reporting an opaque "exit 1".
process.on("uncaughtException", (err) => {
  process.stderr.write("batch9-net uncaughtException: " + ((err && err.stack) || err) + NL);
  process.exit(3);
});
process.on("unhandledRejection", (err) => {
  process.stderr.write("batch9-net unhandledRejection: " + ((err && err.stack) || err) + NL);
  process.exit(3);
});

/** Self-signed certificate for the hermetic TLS origin (CN=tunnel-only.test). */
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDner5h125sP/Qu
OWkSQIdh2HHgVQ4EuqwtD3gUZbax3VopzFkGyexRaSoWTcyBXMT06yYZOa4FnNJI
oH0sNBt5eILz8KWxkR7LeNnadWr+MX1oFae0II9R3ytJsbsdM0L8DuQNApZm8o54
o9fBnxHNxuiqRPzYksy0F7ZJi5PAPgRAJWIopKAaQOafds8nws9ipXS3cay4EhPc
YsNcORmT1UZBD5LZaSIcMqfvrMioq4iXZEJf6b1EbfOQSc31inPIeQZg4w+uyXbu
t6L4uvt6huwPsjbEE3lFNBsIzXOrKo4NA+5r56u626zkDFv2lLvJPaBXKXyxyGmM
DLRsELkPAgMBAAECggEAI7Qiflvou8inhKO1SavrVdO5SNVFqsQSP4cFyfugUNHo
EM9koe/uQ+ZZKASK+R8SgAZvI2/qoBH+u1YJyJIm9Lb6V97z564PFmpHC/OVc6y1
f6LrcZSeFo46Eo1X45qfB9rSIRGXmjxqbkAzTLmY2OkHxQ+MAmmuKk8H/lMJkJqV
B/YVRR+sGv2tmmQzEOcDjOODnnIRzqDTsGiJliYAHiDVziuoD1p+hvgBAcYbl5A0
ZL267KEc55aOvZwrGw7Fj/sa9T0afThA+3MGWwt3BluWjszCkMB9nXv8tyBuvVQb
9X5JjO6Wf9OmgfbNTm0l0eG4xst9ffgsw40fCaClxQKBgQD+wkXTN3jfV3XimBAQ
Zi48Cxo9o/Q9lO8YmUQXbyD7L2XdfXOEPOQDGQbcPpiq6o+DOIdB/hPnncqbg7Ke
MTARsVuT2y+O52N/zmlHvIEu2bBtm9/gTzYCLHQPioW0Z4Jb+t2V8u6rdegfhJ3r
fFvqlHTPTGinaqJa4MfaRb0nowKBgQDom3AFLifPIPumg4Z3T6cgokOlV9nDc9t+
NoPIXJYXoJI1MGud43ra0z4Hy0mLCrxumSVqLoz/lZuZSF+A7bmT349WH72Dbgt1
5iv+uHAYR3mXLDTecKJlwx99l9rgnGm/vNKoREruDM0zjdHCDo2MljWikd6FCTYr
v9LCgJfvpQKBgHWf10NtYlakeB52HTylIQXCDoyVTai9QiO2aDT1r2GqgbrhOFu/
DXvMq1k3YZ/QixCIIhM7L4+KUEi7ZtYZWdthayn6UpwFg/A3qm5fv7mU8xu4k4Zq
rEIWqkOerpscC5lSW8rnDoGF//XFcnCOy5Wkk8Y+vjdGSc3x6PSDrJFHAoGBAM+7
6comk1TvTu9B7Tfmwgpp/+HNWGSutqq8QusQjNbjB1BLQwEJ5HFDUNWjHrX3S5u2
V+zBUBj94q19LhW1uROwB5HR3O1gvQl5G3dr/mgghR2WVE0H6HDbVudSVB5eci7T
korGGukIM8bD9D3Lw2x3xcS/YywKsv9VXANq1sYlAoGAdDu6xg96MeMJVtpvLOEb
BG1LIPAzByt267Yn0RsK5+l8Xfv+HlTeAIkSXEbjUfoWMWU/5RENZHwnvVpkI91T
UkN/FhsL6T8PGNafh7fO9K0ST06rLl0fXCn6rgGEV0Jqn1DJNCa7PjCrekWv8uIP
fPwJmIo2Ba27jhbMgfuh7LE=
-----END PRIVATE KEY-----`;
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDFzCCAf+gAwIBAgIUOB7WNiaSpR4fl+lxTMpEfDlfKPEwDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQdHVubmVsLW9ubHkudGVzdDAeFw0yNjEwMzAxOTI4MjNa
Fw0zNjEwMjcxOTI4MjNaMBsxGTAXBgNVBAMMEHR1bm5lbC1vbmx5LnRlc3QwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDner5h125sP/QuOWkSQIdh2HHg
VQ4EuqwtD3gUZbax3VopzFkGyexRaSoWTcyBXMT06yYZOa4FnNJIoH0sNBt5eILz
8KWxkR7LeNnadWr+MX1oFae0II9R3ytJsbsdM0L8DuQNApZm8o54o9fBnxHNxuiq
RPzYksy0F7ZJi5PAPgRAJWIopKAaQOafds8nws9ipXS3cay4EhPcYsNcORmT1UZB
D5LZaSIcMqfvrMioq4iXZEJf6b1EbfOQSc31inPIeQZg4w+uyXbut6L4uvt6huwP
sjbEE3lFNBsIzXOrKo4NA+5r56u626zkDFv2lLvJPaBXKXyxyGmMDLRsELkPAgMB
AAGjUzBRMB0GA1UdDgQWBBSHZn9ec0mjb9fbtn/PVTh2admaFTAfBgNVHSMEGDAW
gBSHZn9ec0mjb9fbtn/PVTh2admaFTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3
DQEBCwUAA4IBAQCvzOXVM7ZGAo8sr3iU6UpJ/oBAI5N73zmu8pBAXkeIkP7Wk2L/
R2aGrliHSBq+ljqgtnevUHiXP+IxubNtbw7GG1usR9sZqskE911BiCcEGC1kWpnc
nZWcV/aXbwnsK7E/bffCESGxAF9kUlRW2GJkgT0zPCv8NN0KXMKkkUrp9odXLWPk
ekVKJJZYvonnXwe4ZFGtvSzpFOEenuZgzJGhuQnkiiSC4q0yXvQ9sWuFr3es7Exz
OlLHp0v7IH4tWUFP5Vv65Cg4/LLQH1LGR/jYN+HyPu89+ozapS9wBR2GQ1LBnyXR
XRD0KeMOLE4RF/2F/WFXPge2Da+X63xONhEs
-----END CERTIFICATE-----`;

/** Deterministic fixture byte, so origins and assertions share one pattern. */
const patternByte = (i) => (i * 31 + 7) & 0xff;
function patternBuffer(size) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = patternByte(i);
  return b;
}
const TUNNEL_FIXTURE = patternBuffer(96 * 1024);
const SOCKS_FIXTURE = patternBuffer(96 * 1024);

/**
 * A hermetic HTTP CONNECT proxy: pure TCP relay, never touches TLS.
 *
 * `mapHost` (optional) rewrites the CONNECT target's host before dialling, so
 * a test can serve an origin the client could never reach directly — that is
 * what makes the "must go through the tunnel" assertions discriminating.
 */
function startConnectProxy({ mapHost } = {}) {
  const seen = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => { try { socket.destroy(); } catch { /* gone */ } });
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const at = head.indexOf("\r\n\r\n");
      if (at < 0) return;
      socket.removeListener("data", onData);
      const firstLine = head.subarray(0, at).toString("latin1").split("\r\n")[0];
      const m = /^CONNECT (\S+) HTTP/.exec(firstLine);
      if (!m) {
        socket.end("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const target = m[1];                       // "host:port"
      const cidx = target.lastIndexOf(":");
      let host = cidx > 0 ? target.slice(0, cidx) : target;
      const port = cidx > 0 ? Number(target.slice(cidx + 1)) || 443 : 443;
      const rec = { target, host, port, upstreamBytes: 0, downstreamBytes: 0 };
      seen.push(rec);
      const dial = mapHost ? mapHost(host) : host;
      const upstream = net.connect(port, dial, () => {
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
        const rest = head.subarray(at + 4);
        if (rest.length) upstream.write(rest);
      });
      upstream.on("error", () => { try { socket.destroy(); } catch { /* gone */ } });
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on("data", (c) => { rec.upstreamBytes += c.length; });
      upstream.on("data", (c) => { rec.downstreamBytes += c.length; });
      const bye = () => { try { upstream.destroy(); } catch { /* gone */ } sockets.delete(socket); };
      socket.on("close", bye);
      upstream.on("close", () => { try { socket.destroy(); } catch { /* gone */ } });
    };
    socket.on("data", onData);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server, seen, sockets,
      port: server.address().port,
      close: () => new Promise((r) => {
        // Graceful first: end() (FIN) every tracked client socket, then
        // destroy. A bare destroy can RST a peer socket the product side has
        // already finished with; a real proxy closes the way browsers expect.
        for (const s of [...sockets]) { try { s.end(); } catch { /* gone */ } }
        setTimeout(() => {
          for (const s of [...sockets]) { try { s.destroy(); } catch { /* gone */ } }
          try { server.closeAllConnections?.(); } catch { /* none */ }
          server.close(() => r(undefined));
          setTimeout(r, 200);
        }, 250);
      }),
    }));
  });
}

/**
 * A hermetic SOCKS5 server (no-auth), relay style: it never inspects the
 * relayed bytes. `mapHost` rewrites the requested host before dialling, so
 * a ".test" name can point at a loopback origin the client cannot resolve.
 * Shape follows the startSocks5Proxy precedent in test/selftest.mjs.
 */
function startSocks5Proxy({ mapHost } = {}) {
  const seen = { methods: [], connects: [] };
  const sockets = new Set();
  const srv = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => { try { sock.destroy(); } catch { /* gone */ } });
    let buf = Buffer.alloc(0);
    let stage = "greeting";
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greeting") {
        if (buf.length < 2) return;
        const n = buf[1];
        if (buf.length < 2 + n) return;
        seen.methods.push([...buf.subarray(2, 2 + n)]);
        buf = buf.subarray(2 + n);
        sock.write(Buffer.from([0x05, 0x00]));     // choose: no authentication
        stage = "connect";
        if (buf.length === 0) return;
      }
      if (stage === "connect") {
        if (buf.length < 4) return;
        const atyp = buf[3];
        let host; let off;
        if (atyp === 1) { host = [...buf.subarray(4, 8)].join("."); off = 8; }
        else if (atyp === 3) {
          if (buf.length < 5) return;
          const l = buf[4];
          if (buf.length < 5 + l) return;
          host = buf.subarray(5, 5 + l).toString();
          off = 5 + l;
        } else { sock.destroy(); return; }
        if (buf.length < off + 2) return;
        const port = buf.readUInt16BE(off);
        const rest = buf.subarray(off + 2);
        buf = Buffer.alloc(0);
        const mapped = mapHost ? mapHost(host) : host;
        seen.connects.push({ host, port, mapped });
        const upstream = net.connect(port, mapped, () => {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
          if (rest.length) upstream.write(rest);
          sock.removeListener("data", onData);
          sock.pipe(upstream);
          upstream.pipe(sock);
        });
        upstream.on("error", () => {
          try { sock.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch { /* gone */ }
          sock.destroy();
        });
        stage = "relay";
        return;
      }
    };
    sock.on("data", onData);
    sock.on("close", () => sockets.delete(sock));
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({
      server: srv, seen, sockets,
      port: srv.address().port,
      url: "socks5://127.0.0.1:" + srv.address().port,
      close: () => new Promise((r) => {
        // Graceful first (see startConnectProxy.close): end() the client
        // sockets so the relays finish with FIN, then destroy the rest.
        for (const s of [...sockets]) { try { s.end(); } catch { /* gone */ } }
        setTimeout(() => {
          for (const s of [...sockets]) { try { s.destroy(); } catch { /* gone */ } }
          try { srv.closeAllConnections?.(); } catch { /* none */ }
          srv.close(() => r(undefined));
          setTimeout(r, 200);
        }, 250);
      }),
    }));
  });
}

/**
 * One origin (http or https) serving a fixed fixture with full Range support,
 * so the engine may probe it with HEAD and fetch it in ranges.
 */
function startFixtureOrigin({ tls, body, name }) {
  const connections = { count: 0 };
  const handler = (req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    if (m) {
      const s = Number(m[1]);
      const e = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
      const slice = body.subarray(s, e + 1);
      res.writeHead(206, {
        "Content-Type": "application/octet-stream",
        "Content-Range": "bytes " + s + "-" + e + "/" + body.length,
        "Content-Length": slice.length,
        "Accept-Ranges": "bytes",
      });
      res.end(req.method === "HEAD" ? undefined : slice);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": body.length,
      "Accept-Ranges": "bytes",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };
  const server = tls
    ? https.createServer({ key: TLS_KEY, cert: TLS_CERT }, handler)
    : http.createServer(handler);
  server.on("connection", () => { connections.count++; });
  server.on("error", () => {});
  // A mid-handshake reset must not surface as anything louder than a closed
  // socket (same guard as test/origin.mjs).
  server.on("clientError", (err, socket) => { try { socket.destroy(); } catch { /* gone */ } });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server, connections,
      port: server.address().port,
      close: () => new Promise((r) => {
        try { server.closeAllConnections?.(); } catch { /* none */ }
        server.close(() => r(undefined));
        setTimeout(r, 200);
      }),
    }));
  });
}

/** Direct (no proxy) fetch used as the egress probe and the expected body. */
function fetchDirect(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error("direct fetch answered HTTP " + res.statusCode));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", () => { req.destroy(new Error("direct fetch timed out")); });
    req.on("error", reject);
  });
}

async function main() {
  const suite = new Suite("batch9-net");
  const skipNotes = [];
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + (r.ms > 400 ? "  (" + r.ms + "ms)" : "") + NL);
    else if (r.kind === "skip") {
      skipNotes.push(r.text + ": " + r.reason);
      process.stdout.write("    SKIP  " + r.text + "  - " + r.reason + NL);
    } else process.stdout.write("    FAIL  " + r.text + NL + "          " + String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-batch9-net-"));
  const out = path.join(home, "out");
  await fsp.mkdir(out, { recursive: true });
  process.env.DOWNLOADX_HOME = home;   // throwaway data root, never the real one

  // src modules load only after DOWNLOADX_HOME points at the throwaway root.
  const { Config } = await import("../src/config.mjs");
  const { Downloader } = await import("../src/downloader.mjs");

  const servers = [];
  try {
    // ============================================== guard: the fix stays put
    suite.group("guard: net.mjs carries exactly one agent:false (CONNECT only)");

    await suite.test("'agent: false' appears exactly once, inside proxyConnect()", async () => {
      const src = fs.readFileSync(path.join(HERE, "..", "src", "net.mjs"), "utf8");
      const hits = src.split("agent: false").length - 1;
      assert.equal(hits, 1, "exactly one 'agent: false' must survive (the CONNECT request); found " + hits);
      const fnAt = src.indexOf("function proxyConnect(");
      const hitAt = src.indexOf("agent: false");
      const nextDoc = src.indexOf("/**", fnAt);
      assert.ok(fnAt >= 0, "proxyConnect() must exist");
      assert.ok(hitAt > fnAt && nextDoc > 0 && hitAt < nextDoc,
        "the surviving 'agent: false' must be the CONNECT request inside proxyConnect(), not a tunnel site");
      assert.ok(src.includes("createConnection: () => tlsSocket"),
        "httpsOverTunnel must keep its createConnection factory");
      assert.ok(src.includes("createConnection: () => socket"),
        "the SOCKS plaintext hop must keep its createConnection factory");
    });

    // ===================================== fixtures for the hermetic cases
    const tlsOrigin = await startFixtureOrigin({ tls: true, body: TUNNEL_FIXTURE, name: "tunnel" });
    servers.push(tlsOrigin);
    const localOrigin = await startFixtureOrigin({ tls: false, body: SOCKS_FIXTURE, name: "socks" });
    servers.push(localOrigin);

    // A CONNECT proxy that can ONLY reach loopback: any .test name maps to
    // 127.0.0.1 on the same port. With the old `agent: false` the request
    // bypassed the tunnel and dialled the URL's own host directly — for a
    // .test name that is ENOTFOUND, so this fixture actually catches it.
    const proxyLoop = await startConnectProxy({ mapHost: (h) => (h.endsWith(".test") ? "127.0.0.1" : h) });
    servers.push(proxyLoop);

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
    const runTask = (task) => downloader.run(task);

    // ============================== real world: CONNECT tunnel to nodejs.org
    suite.group("manual proxyMode over a hermetic HTTP CONNECT tunnel");

    const REAL_URL = "https://nodejs.org/robots.txt";
    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
    // Transport-level noise a public origin can emit; a tunnel DEFECT is not
    // transient, so it fails every round and stays a failure.
    const TRANSIENT_RE = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|request timeout|proxy CONNECT timeout|socket hang up/i;
    const isTransientNetErr = (err) => {
      if (!err) return false;
      if (err.name === "HttpStatusError") return err.retryable === true;
      return TRANSIENT_RE.test(String(err.code || "") + " " + String(err.message || ""));
    };

    // The internet leg is the only part of this file that can flake for
    // reasons that say nothing about the tunnel: a 5xx from the CDN, a reset
    // mid-handshake, a probe starved by a loaded machine. The transfer runs
    // OUTSIDE suite.test so a mid-test egress collapse can still be reported
    // as the spec's skip (egress blocked), while every other outcome keeps
    // its honest verdict: three rounds, then FAIL with the real error.
    const a1 = { expected: null, body: null, data: null, hit: null, skipReason: null, error: null };

    for (let round = 1; round <= 3 && !a1.expected; round++) {
      try {
        a1.expected = await fetchDirect(REAL_URL);
      } catch (err) {
        a1.skipReason = "egress to nodejs.org unavailable from this sandbox (" + (err && err.message) + ")";
        if (round < 3) await sleepMs(1000);
      }
    }

    if (a1.expected) {
      const proxyReal = await startConnectProxy({});   // relays to the real target
      servers.push(proxyReal);
      await config.set({ proxyMode: "manual", proxy: "http://127.0.0.1:" + proxyReal.port });
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          // Expected bytes are re-fetched inside the round, so origin and
          // tunnel views come from the same window.
          a1.expected = await fetchDirect(REAL_URL);
          const r = await runTask({
            id: "b9-connect-real", url: REAL_URL, filename: "b9-robots.txt",
          });
          assert.equal(r.ok, true, "the transfer must succeed through the CONNECT tunnel");
          a1.data = r;
          a1.body = await fsp.readFile(path.join(out, "b9-robots.txt"));
          a1.hit = proxyReal.seen.find((s) => s.target === "nodejs.org:443");
          break;
        } catch (err) {
          a1.error = err;
          // Egress may have died mid-test: re-probe directly before blaming
          // the tunnel. A dead egress is the spec's skip case, never a FAIL.
          let egressDead = false;
          try {
            a1.expected = await fetchDirect(REAL_URL);
          } catch (err2) {
            egressDead = true;
            a1.skipReason = "egress lost during the tunnel test (" + (err2 && err2.message) + ")";
          }
          if (egressDead) break;
          if (attempt < 3 && isTransientNetErr(err)) {
            await sleepMs(1200 * attempt);
            continue;
          }
          break;
        }
      }
    }

    if (a1.skipReason) {
      suite.skip("real CONNECT tunnel: https://nodejs.org/robots.txt", a1.skipReason);
    } else if (a1.data) {
      await suite.test("a real https download rides the tunnel and lands byte-for-byte", async () => {
        assert.equal(a1.data.ok, true, "the transfer must succeed through the CONNECT tunnel");
        assert.equal(a1.data.bytes, a1.expected.length, "the byte count must match a direct fetch");
        assert.ok(a1.body.equals(a1.expected), "the published bytes must be the origin's robots.txt");
        assert.ok(a1.hit, "the proxy must have seen CONNECT nodejs.org:443");
        assert.ok(a1.hit.upstreamBytes > 0, "the tunnel must have carried request bytes");
        assert.ok(a1.hit.downstreamBytes > 0, "the tunnel must have carried response bytes");
      });
    } else {
      // Egress was healthy at the pre-check, yet the tunnel leg failed three
      // rounds with a non-skip error — a real defect (or a network that breaks
      // proxied traffic only). Fail with the last real error.
      await suite.test("a real https download rides the tunnel and lands byte-for-byte", async () => {
        throw a1.error;
      });
    }

    // ===================== discriminating: tunnel-only host via CONNECT+TLS
    await suite.test("a host reachable ONLY through the proxy arrives via the tunnel (catches a recurrence)", async () => {
      await config.set({ proxyMode: "manual", proxy: "http://127.0.0.1:" + proxyLoop.port });
      const url = "https://tunnel-only.test:" + tlsOrigin.port + "/tunnel-fixture.bin";
      const r = await runTask({
        id: "b9-connect-loop", url, filename: "b9-tunnel-fixture.bin",
        insecure: true,   // the hermetic origin presents a self-signed certificate
      });
      assert.equal(r.ok, true, "the transfer must succeed through the tunnel");
      assert.equal(r.bytes, TUNNEL_FIXTURE.length);
      const body = await fsp.readFile(path.join(out, "b9-tunnel-fixture.bin"));
      assert.ok(body.equals(TUNNEL_FIXTURE),
        "the body must be the loopback origin's fixture — the only route to it is the tunnel");
      const hit = proxyLoop.seen.find((s) => s.host === "tunnel-only.test" && s.port === tlsOrigin.port);
      assert.ok(hit, "the proxy must have been asked for tunnel-only.test");
      assert.ok(hit.upstreamBytes > 0 && hit.downstreamBytes > 0,
        "the request AND the response must both have travelled the tunnel");
    });

    // ==================================== SOCKS5 plaintext path (spec case)
    suite.group("manual proxyMode over a hermetic SOCKS5 server");

    const socks = await startSocks5Proxy({
      mapHost: (h) => (h.endsWith(".test") ? "127.0.0.1" : h),
    });
    servers.push(socks);

    await suite.test("a download completes through the SOCKS5 proxy from a local http origin", async () => {
      await config.set({ proxyMode: "manual", proxy: socks.url });
      const url = "http://127.0.0.1:" + localOrigin.port + "/socks-fixture.bin";
      const r = await runTask({
        id: "b9-socks-local", url, filename: "b9-socks-local.bin",
      });
      assert.equal(r.ok, true, "the transfer must succeed through the SOCKS5 proxy");
      assert.equal(r.bytes, SOCKS_FIXTURE.length);
      const body = await fsp.readFile(path.join(out, "b9-socks-local.bin"));
      assert.ok(body.equals(SOCKS_FIXTURE), "the published bytes must match the origin's fixture");
      assert.ok(socks.seen.methods.length >= 1, "the proxy must have received a greeting");
      assert.ok(socks.seen.methods[0].includes(0x00), "the client must offer the no-auth method");
      const hit = socks.seen.connects.find((c) => c.host === "127.0.0.1" && c.port === localOrigin.port);
      assert.ok(hit, "the proxy must have been asked for 127.0.0.1:" + localOrigin.port);
    });

    await suite.test("a SOCKS5 name only the proxy can resolve rides the relay (catches a recurrence)", async () => {
      await config.set({ proxyMode: "manual", proxy: socks.url });
      const url = "http://socks-only.test:" + localOrigin.port + "/socks-fixture.bin";
      const r = await runTask({
        id: "b9-socks-fake", url, filename: "b9-socks-fake.bin",
      });
      assert.equal(r.ok, true, "the transfer must succeed through the SOCKS5 proxy");
      assert.equal(r.bytes, SOCKS_FIXTURE.length);
      const body = await fsp.readFile(path.join(out, "b9-socks-fake.bin"));
      assert.ok(body.equals(SOCKS_FIXTURE),
        "the body must be the loopback origin's fixture — the name resolves nowhere else");
      const hit = socks.seen.connects.find((c) => c.host === "socks-only.test" && c.port === localOrigin.port);
      assert.ok(hit, "the proxy must have received the name for resolution (ATYP 0x03)");
      assert.equal(hit.mapped, "127.0.0.1", "the proxy must have dialled the loopback origin");
    });
  } finally {
    for (const s of servers) {
      await s.close().catch(() => {});
    }
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  if (skipNotes.length) {
    process.stdout.write(NL + "  skip notes (deviations):" + NL);
    for (const n of skipNotes) process.stdout.write("    - " + n + NL);
  }
  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch9-net crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
