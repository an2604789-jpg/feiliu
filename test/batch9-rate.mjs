// Batch-9 rate re-measure (任务书第 5 项 / W1): MEASURE ONLY — no product code
// is touched. src/rate.mjs is read-only for this batch by spec; if the measured
// deviation exceeds 20% the full data goes to the report and the decision is
// escalated, never patched here.
//
// Method (per the task sheet and the lead's 复核 §7):
//   * one local origin serving 220 MB of deterministic content with Range
//     support, generated on the fly (never materialised in memory) and deleted
//     with its temp root after the run;
//   * the segmented engine (DownloadEngine) runs the whole file with a fixed
//     2 MiB/s limit and 4 connections — the engine's bucket is shared by its
//     workers by design, so the measured rate is the check that several
//     connections do NOT multiply the cap;
//   * the transfer rate is recorded at 1 s granularity from the engine's own
//     progress samples (linearly interpolated at each second boundary);
//   * the FIRST second is discarded (the token bucket starts full — one
//     second's worth of free burst) and the trailing partial second with it;
//   * the mean of the remaining stable seconds is compared against the cap;
//     deviation ≤ 20% is the pass line from the task sheet.
//
// Recorded alongside the rate: requested connections, the engine's own worker
// count, the TCP connections the origin actually saw, segments, retries.
//
// NOT registered in test/run.mjs (per spec): it is a re-measurement
// deliverable, run standalone — `node test/batch9-rate.mjs` (~2 minutes).
//
// Everything runs in a throwaway temp root; DOWNLOADX_HOME points there; the
// real data root D:/IAM/downloadx-data is never read or written.

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NL = String.fromCharCode(10);

const SIZE = 220 * 1024 * 1024;             // bytes served by the local origin
const RATE = 2 * 1024 * 1024;               // the engine cap under test: 2 MiB/s
const CONNECTIONS = 4;                       // concurrent connections requested
const TOLERANCE = 0.20;                      // task-sheet pass line
const MIB = 1024 * 1024;

/** Deterministic content byte, so the origin and the assertions agree. */
const patternByte = (i) => (i * 31 + 7) & 0xff;

/**
 * The local origin: 220 MB of the deterministic pattern with full Range
 * support, streamed in 256 KiB chunks honouring backpressure. The payload is
 * generated per chunk — the process never holds the file in memory.
 */
function startRateOrigin() {
  const stats = { connections: 0, requests: 0, bytesServed: 0 };
  const CHUNK = 256 * 1024;
  const server = http.createServer((req, res) => {
    stats.requests++;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    let start = 0;
    let length = SIZE;
    if (m) {
      start = Number(m[1]);
      const e = m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
      length = e - start + 1;
      if (!(start >= 0 && start < SIZE && length > 0)) {
        res.writeHead(416, { "Content-Range": "bytes */" + SIZE });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Type": "application/octet-stream",
        "Content-Range": "bytes " + start + "-" + (start + length - 1) + "/" + SIZE,
        "Content-Length": String(length),
        "Accept-Ranges": "bytes",
      });
    } else {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(SIZE),
        "Accept-Ranges": "bytes",
      });
    }
    if (req.method === "HEAD") { res.end(); return; }
    const buf = Buffer.alloc(CHUNK);
    let sent = 0;
    let stopped = false;
    res.on("close", () => { stopped = true; });
    const step = () => {
      if (stopped || res.destroyed) return;
      if (sent >= length) { res.end(); return; }
      const n = Math.min(CHUNK, length - sent);
      const base = start + sent;
      for (let j = 0; j < n; j++) buf[j] = patternByte(base + j);
      const ok = res.write(n === CHUNK ? buf : buf.subarray(0, n));
      sent += n;
      stats.bytesServed += n;
      if (ok) setImmediate(step);
      else res.once("drain", step);
    };
    step();
  });
  server.on("connection", () => { stats.connections++; });
  server.on("error", () => {});
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server, stats,
      port: server.address().port,
      url: "http://127.0.0.1:" + server.address().port + "/rate-220m.bin",
      close: () => new Promise((r) => {
        try { server.closeAllConnections?.(); } catch { /* none */ }
        server.close(() => r(undefined));
        setTimeout(r, 300);
      }),
    }));
  });
}

/**
 * Per-second rates from cumulative progress samples.
 *
 * Boundaries between samples are linearly interpolated, so the 200 ms emit
 * jitter of the engine's progress events does not smear the 1 s buckets.
 * Returns { rates, fullSeconds } — index 0 is the first second (the initial
 * full-bucket burst), which the caller discards.
 */
function perSecondRates(samples, tDone) {
  const t0 = samples[0].t;
  const bytesAt = (t) => {
    if (t <= samples[0].t) return samples[0].b;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].t >= t) {
        const a = samples[i - 1];
        const b = samples[i];
        const span = b.t - a.t;
        const frac = span > 0 ? (t - a.t) / span : 1;
        return a.b + (b.b - a.b) * frac;
      }
    }
    return samples[samples.length - 1].b;
  };
  const fullSeconds = Math.max(0, Math.floor((tDone - t0) / 1000));
  const rates = [];
  let prev = samples[0].b;
  for (let k = 0; k < fullSeconds; k++) {
    const b = bytesAt(t0 + (k + 1) * 1000);
    rates.push(b - prev);
    prev = b;
  }
  return { rates, fullSeconds };
}

async function main() {
  const suite = new Suite("batch9-rate");
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + (r.ms > 400 ? "  (" + r.ms + "ms)" : "") + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " + String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-batch9-rate-"));
  const home = path.join(root, "home");
  const work = path.join(root, "work");
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(work, { recursive: true });
  process.env.DOWNLOADX_HOME = home;   // throwaway data root, never the real one

  const target = path.join(work, "rate-220m.bin");
  let origin = null;
  try {
    const { DownloadEngine } = await import("../src/engine.mjs");

    await suite.test("220 MB at a fixed 2 MiB/s through the segmented engine", async () => {
      origin = await startRateOrigin();

      const engine = new DownloadEngine({
        url: origin.url,
        targetPath: target,
        connections: CONNECTIONS,
        maxRate: RATE,
      });

      const samples = [];
      const logs = [];
      let retries = 0;
      let workers = null;
      let segments = null;
      engine.on("progress", (snap) => { samples.push({ t: Date.now(), b: snap.bytesWritten }); });
      engine.on("log", (m) => {
        logs.push(String(m));
        const w = /(\d+) worker\(s\) over (\d+) segment\(s\)/.exec(String(m));
        if (w) { workers = Number(w[1]); segments = Number(w[2]); }
      });
      engine.on("retry", () => { retries++; });

      const result = await engine.run({
        probe: {
          finalUrl: origin.url,
          totalBytes: SIZE,
          supportsRanges: true,
          etag: null,
          lastModified: null,
        },
        resume: false,
      });
      const tDone = Date.now();

      // ---- the transfer itself must be sound before the rate means anything
      assert.equal(result.ok, true, "the transfer must complete");
      assert.equal(result.bytes, SIZE, "every byte must be accounted for");
      const st = await fsp.stat(target);
      assert.equal(st.size, SIZE, "the published file must hold the whole resource");
      // Spot-check the pattern at the head, the middle seam and the tail.
      for (const [off, len] of [[0, 4096], [Math.floor(SIZE / 2) - 2048, 4096], [SIZE - 4096, 4096]]) {
        const fh = await fsp.open(target, "r");
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, off);
        await fh.close();
        for (let j = 0; j < len; j++) {
          if (buf[j] !== patternByte(off + j)) {
            throw new Error("content mismatch at offset " + (off + j));
          }
        }
      }

      // ---- the measurement
      assert.ok(samples.length >= 10, "progress samples must exist, got " + samples.length);
      const { rates, fullSeconds } = perSecondRates(samples, tDone);
      assert.ok(fullSeconds >= 31, "at least 31 full seconds of data expected, got " + fullSeconds);
      // 剔首秒(令牌桶初始满桶);其余整秒即稳定段。
      const stable = rates.slice(1);
      assert.ok(stable.length >= 30, "at least 30 stable seconds expected, got " + stable.length);
      const mean = stable.reduce((a, b) => a + b, 0) / stable.length;
      const deviation = Math.abs(mean - RATE) / RATE;
      const ok = deviation <= TOLERANCE;

      // Full data first, so the record survives either verdict.
      process.stdout.write(NL + "    --- measurement (2 MiB/s cap, " + CONNECTIONS + " connections) ---" + NL);
      process.stdout.write("    origin: " + origin.url + "  (local, 220 MB)" + NL);
      process.stdout.write("    elapsed: " + result.elapsedMs + " ms; retries: " + retries +
        "; segments: " + segments + NL);
      process.stdout.write("    connections requested: " + CONNECTIONS +
        "; engine workers: " + workers +
        "; TCP connections the origin saw: " + origin.stats.connections + NL);
      process.stdout.write("    per-second rates, first second DISCARDED, MiB/s:" + NL);
      for (let i = 0; i < rates.length; i += 10) {
        process.stdout.write("      " + rates.slice(i, i + 10)
          .map((v) => (v / MIB).toFixed(2)).join(", ") + NL);
      }
      process.stdout.write("    stable seconds: " + stable.length +
        " (dropped first second; trailing partial excluded)" + NL);
      process.stdout.write("    mean stable rate: " + (mean / MIB).toFixed(3) + " MiB/s (cap " +
        (RATE / MIB) + " MiB/s)" + NL);
      process.stdout.write("    deviation: " + (deviation * 100).toFixed(2) + "% (line: ±" +
        (TOLERANCE * 100) + "%)" + NL);
      process.stdout.write("    verdict: " + (ok
        ? "不超纲、不动代码 — measured " + (mean / MIB).toFixed(3) + " MiB/s vs 2 MiB/s cap, deviation " +
          (deviation * 100).toFixed(2) + "% ≤ 20%; src/rate.mjs untouched"
        : "超纲 — full data above; escalate, do NOT touch src/rate.mjs in this batch") + NL);

      assert.equal(ok, true, "stable-segment mean " + (mean / MIB).toFixed(3) +
        " MiB/s deviates " + (deviation * 100).toFixed(2) + "% from the 2 MiB/s cap (line ±20%)");
    });
  } finally {
    if (origin) await origin.close().catch(() => {});
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch9-rate crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
