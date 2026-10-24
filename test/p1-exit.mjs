// P1 regression: a proxied transfer must let the process exit.
//
// The defect this guards against: every tunnelled (CONNECT) request left the
// raw socket to the proxy open and still referenced by the event loop, so a
// *completed* download never exited. Measured before the fix: a full HLS
// download through a proxy printed its summary and then hung for 182 s /
// 361.9 s / >307 s across three runs, while the same download direct exited
// in ~41 s. The leak was in https-over-CONNECT only: a plain http:// target is
// forwarded in absolute form and never opens a tunnel.
//
// The test must not merely check that the file appeared — a hung process also
// produces the file. Every case therefore runs the real CLI as a child and
// asserts on *exit*, with a hard deadline.
//
// Usage:
//   node test/p1-exit.mjs                 (self-contained: local fixture servers)
//   node test/p1-exit.mjs --real          (also against the public HLS stream)
//   node test/p1-exit.mjs --proxy <url>   (proxy for the --real case)

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CLI = path.join(ROOT, "bin", "downloadx.mjs");

const results = [];
const record = (name, status, detail, extra = {}) => {
  results.push({ name, status, detail, ...extra });
  console.log("    " + status.padEnd(5) + "  " + name + (detail ? "  — " + detail : ""));
};

/**
 * Run the CLI with a hard deadline and report whether it exited.
 *
 * A timeout is a failure with a stated cause, never a silent pass: the whole
 * point of this file is that "the file exists" is not evidence of exit.
 */
function runCli(args, { timeoutMs = 120000, home, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, DOWNLOADX_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const t0 = Date.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      // Killing it here is the assertion: the process owed us an exit.
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err, elapsedMs: Date.now() - t0, timedOut });
    });
  });
}

/** Generate a throwaway self-signed certificate so the origin can speak TLS. */
/**
 * Find an openssl binary. It is not on PATH on this machine, but Git for
 * Windows ships one, and that is where the test looks before giving up.
 */
function findOpenssl() {
  const candidates = ["openssl",
    "C:\\\\Program Files\\\\Git\\\\usr\\\\bin\\\\openssl.exe",
    "C:\\\\Program Files\\\\Git\\\\mingw64\\\\bin\\\\openssl.exe"];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function makeCert(dir) {
  const openssl = findOpenssl();
  if (!openssl) return null;
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  const r = spawnSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "2", "-subj", "/CN=127.0.0.1"],
    { encoding: "utf8" });
  if (r.status !== 0 || !fs.existsSync(keyPath)) return null;
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

/** Start a CONNECT proxy the test owns, so no external proxy is required. */
function startConnectProxy() {
  const state = { connects: 0, hosts: new Set() };
  const server = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });
  server.on("connect", (req, clientSocket, head) => {
    state.connects++;
    state.hosts.add(String(req.url));
    const [host, p] = String(req.url).split(":");
    const upstream = net.connect(Number(p) || 443, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const close = () => { try { upstream.destroy(); } catch {} try { clientSocket.destroy(); } catch {} };
    upstream.on("error", close);
    clientSocket.on("error", close);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, state }));
  });
}

/** Local HTTPS origin: a ranged file plus a segmented HLS playlist. */
function startOrigin(creds) {
  const payload = Buffer.alloc(256 * 1024, 0x41);
  const segments = 8;
  const segBody = Buffer.alloc(64 * 1024, 0x42);
  const handler = (req, res) => {
    const url = req.url || "/";
    if (url === "/file.bin") {
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-(\d+)?/.exec(range);
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : payload.length - 1;
        res.writeHead(206, {
          "content-type": "application/octet-stream",
          "content-range": "bytes " + start + "-" + end + "/" + payload.length,
          "content-length": String(end - start + 1),
          "accept-ranges": "bytes",
        });
        res.end(payload.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(payload.length), "accept-ranges": "bytes" });
      res.end(payload);
      return;
    }
    if (url === "/playlist.m3u8") {
      const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:4", "#EXT-X-PLAYLIST-TYPE:VOD"];
      for (let i = 0; i < segments; i++) lines.push("#EXTINF:4.000,", "seg" + i + ".ts");
      lines.push("#EXT-X-ENDLIST");
      const body = lines.join("\n");
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "content-length": String(Buffer.byteLength(body)) });
      res.end(body);
      return;
    }
    if (/^\/seg\d+\.ts$/.test(url)) {
      res.writeHead(200, { "content-type": "video/mp2t", "content-length": String(segBody.length) });
      res.end(segBody);
      return;
    }
    res.writeHead(404); res.end("not found");
  };
  return new Promise((resolve) => {
    const server = creds ? https.createServer({ key: creds.key, cert: creds.cert }, handler) : http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function hashFile(target) {
  const h = createHash("sha256");
  h.update(await fsp.readFile(target));
  return h.digest("hex");
}

async function main() {
  const argv = process.argv.slice(2);
  const real = argv.includes("--real");
  let proxyArg = null;
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--proxy") proxyArg = argv[++i];

  console.log("\n  downloadx P1 exit regression");
  console.log("  a proxied transfer must let the process exit, not just write the file\n");

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-p1-"));
  const outDir = path.join(home, "out");
  await fsp.mkdir(outDir, { recursive: true });

  const creds = makeCert(home);
  if (!creds) {
    console.log("  SKIP: openssl is not available, cannot stand up a TLS origin");
    console.log("  (the tunnel path this file guards cannot be exercised over plain http)\n");
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
    return 2;
  }

  const proxy = await startConnectProxy();
  const origin = await startOrigin(creds);
  const proxyUrl = "http://127.0.0.1:" + proxy.port;
  const base = "https://127.0.0.1:" + origin.port;

  console.log("  Transport: CONNECT proxy on " + proxy.port + ", TLS origin on " + origin.port + "\n");

  try {
    // ---- 1. a plain file over the tunnel ------------------------------------
    {
      const target = path.join(outDir, "plain.bin");
      const r = await runCli(["get", base + "/file.bin", "-o", target,
        "--proxy", proxyUrl, "--insecure", "--quiet"], { timeoutMs: 60000, home });
      const ok = r.code === 0 && fs.existsSync(target) && proxy.state.connects > 0;
      record("a small file through a CONNECT proxy exits",
        ok ? "PASS" : "FAIL",
        "exit=" + r.code + " in " + r.elapsedMs + " ms, tunnels=" + proxy.state.connects +
        (r.err ? " :: " + r.err.trim().split("\n").slice(-1)[0] : ""),
        { exitCode: r.code, elapsedMs: r.elapsedMs, timedOut: r.timedOut });
    }

    // ---- 2. HLS over the tunnel ---------------------------------------------
    {
      const dir = path.join(outDir, "hls");
      await fsp.mkdir(dir, { recursive: true });
      const r = await runCli(["get", base + "/playlist.m3u8", "-o", dir, "--filename", "live",
        "--kind", "hls", "--proxy", proxyUrl, "--insecure", "--quiet"],
        { timeoutMs: 120000, home });
      const target = path.join(dir, "live");
      const exists = fs.existsSync(target);
      const bytes = exists ? fs.statSync(target).size : 0;
      // Exit is the assertion. A non-empty file proves the transfer really ran.
      const ok = r.code === 0 && exists && bytes > 0 && !r.timedOut;
      record("a segmented (HLS) download through a CONNECT proxy exits",
        ok ? "PASS" : "FAIL",
        "exit=" + r.code + " in " + r.elapsedMs + " ms, " + bytes + " bytes" +
        (r.timedOut ? " (KILLED AT DEADLINE — the process never exited)" : ""),
        { exitCode: r.code, elapsedMs: r.elapsedMs, bytes, timedOut: r.timedOut,
          sha256: exists ? await hashFile(target) : null });
    }

    // ---- 3. repeated tunnelled requests must not accumulate sockets ---------
    {
      // Eight sequential tunnel downloads: if each leaked a socket the run
      // would still "succeed" and then hang, which is what happened in the
      // field. Requiring all eight to exit is the accumulation test.
      let failed = 0;
      const t0 = Date.now();
      for (let i = 0; i < 8; i++) {
        const target = path.join(outDir, "loop-" + i + ".bin");
        const r = await runCli(["get", base + "/file.bin", "-o", target,
          "--proxy", proxyUrl, "--insecure", "--quiet"], { timeoutMs: 45000, home });
        if (r.code !== 0 || r.timedOut) failed++;
      }
      record("eight sequential tunnelled downloads all exit",
        failed === 0 ? "PASS" : "FAIL",
        failed + " of 8 did not exit cleanly, total " + (Date.now() - t0) + " ms");
    }

    // ---- 4. a direct (unproxied) download still exits ----------------------
    {
      const target = path.join(outDir, "direct.bin");
      const r = await runCli(["get", base + "/file.bin", "-o", target,
        "--insecure", "--quiet"], { timeoutMs: 60000, home });
      const ok = r.code === 0 && fs.existsSync(target);
      record("a direct (unproxied) download still exits",
        ok ? "PASS" : "FAIL", "exit=" + r.code + " in " + r.elapsedMs + " ms");
    }

    // ---- 5. optional: the public stream that exposed the defect ------------
    if (real) {
      const url = "https://test-streams.mux.dev/x36xhzz/url_2/193039199_mp4_h264_aac_ld_7.m3u8";
      const dir = path.join(outDir, "real");
      await fsp.mkdir(dir, { recursive: true });
      const args = ["get", url, "-o", dir, "--filename", "live", "--kind", "hls", "--quiet"];
      if (proxyArg) args.push("--proxy", proxyArg);
      const r = await runCli(args, { timeoutMs: 600000, home });
      const target = path.join(dir, "live");
      const exists = fs.existsSync(target);
      const ok = r.code === 0 && exists && fs.statSync(target).size > 0 && !r.timedOut;
      record("public HLS stream" + (proxyArg ? " through a proxy" : " direct") + " exits",
        ok ? "PASS" : "FAIL",
        "exit=" + r.code + " in " + r.elapsedMs + " ms, " + (exists ? fs.statSync(target).size : 0) + " bytes" +
        (r.timedOut ? " (KILLED AT DEADLINE)" : ""));
    }
  } finally {
    proxy.server.close();
    origin.server.close();
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log("\n  " + passed + " passed, " + failed + " failed\n");
  return failed > 0 ? 1 : 0;
}

main().then((code) => { process.exitCode = code; })
  .catch((err) => { process.stderr.write("p1-exit crashed: " + ((err && err.stack) || err) + "\n"); process.exitCode = 1; });
