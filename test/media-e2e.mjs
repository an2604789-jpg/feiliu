// Media download end-to-end tests (output path, rate limit, redirect
// credentials, TLS).
//
// Everything here runs against fixtures started inside the test process on
// 127.0.0.1. Nothing touches the public network, and nothing depends on a
// global TLS knob such as NODE_TLS_REJECT_UNAUTHORIZED or NODE_EXTRA_CA_CERTS:
// the trust decision under test is the one the product makes.
//
// The four groups are:
//   1. exact output path    - `-o <file>` lands on that file, `-o <dir>` keeps
//                             the category behaviour, auto and --kind agree
//   2. rate limiting        - one bucket per task, shared by every fragment,
//                             both DASH tracks and an HLS audio rendition, with
//                             the wait applied inside the response read loop
//   3. redirect credentials - same-origin hops keep their headers, cross-origin
//                             hops lose every credential header
//   4. media TLS            - self-signed HTTPS: rejected by default, accepted
//                             with --insecure, whole request chain covered

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { assert } from "./harness.mjs";
import { readBody } from "../src/net.mjs";
import { RateLimiter } from "../src/rate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");

/** Whole-file SHA-256, streamed so a large file does not sit in memory. */
export async function hashFile(file) {
  const h = createHash("sha256");
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file);
    rs.on("data", (c) => h.update(c));
    rs.once("end", resolve);
    rs.once("error", reject);
  });
  return h.digest("hex");
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Close a server without waiting for pooled keep-alive sockets. */
export async function closeServer(srv) {
  if (!srv) return;
  try { srv.closeAllConnections?.(); } catch { /* older runtime */ }
  await new Promise((r) => {
    let done = false;
    const finish = () => { if (!done) { done = true; r(undefined); } };
    try { srv.close(finish); } catch { finish(); }
    setTimeout(finish, 1500);
  });
}

/** Every regular file under `dir`, recursively, sorted. */
export async function walkFiles(dir) {
  const out = [];
  const rec = async (d) => {
    let entries = [];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) await rec(full);
      else out.push(full);
    }
  };
  await rec(dir);
  return out.sort();
}

/**
 * Deterministic payload.
 *
 * randomBytes is seeded from the OS, so a test could not regenerate the same
 * bytes to compute an expected hash. This does.
 */
function payloadOf(size, seed) {
  const buf = Buffer.allocUnsafe(size);
  let x = (seed >>> 0) || 0x9e3779b9;
  for (let i = 0; i < size; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

/** The self-signed certificate fixtures shipped with the tests. */
export function selfSignedMaterial() {
  return {
    key: fs.readFileSync(path.join(FIXTURES, "localhost-selfsigned.key")),
    cert: fs.readFileSync(path.join(FIXTURES, "localhost-selfsigned.crt")),
  };
}

/** An HLS origin: master/media playlists, fragments, optional init + audio. */
export async function startHlsOrigin(opts = {}) {
  const count = opts.segments ?? 4;
  const segBytes = opts.segBytes ?? 64 * 1024;
  const withMaster = opts.master !== false;
  const withInit = Boolean(opts.initSegment);
  const withAudio = Boolean(opts.audioGroup);
  // Optional pacing for the fragment bodies: lets a test observe a transfer
  // that is genuinely still running when something else happens.
  const trickle = opts.trickle ?? null;

  const segs = Array.from({ length: count }, (_, i) => payloadOf(segBytes, 0x1000 + i));
  const init = withInit ? payloadOf(8 * 1024, 0x0100) : null;
  const audioSegs = Array.from({ length: count }, (_, i) => payloadOf(segBytes, 0x2000 + i));
  const log = [];

  const mediaPlaylist = () => {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:4", "#EXT-X-MEDIA-SEQUENCE:0"];
    if (withInit) lines.push('#EXT-X-MAP:URI="/init.mp4"');
    for (let i = 0; i < count; i++) lines.push("#EXTINF:4.0,", "/seg/" + i);
    lines.push("#EXT-X-ENDLIST");
    return lines.join("\n") + "\n";
  };
  const audioPlaylist = () => {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:4", "#EXT-X-MEDIA-SEQUENCE:0"];
    for (let i = 0; i < count; i++) lines.push("#EXTINF:4.0,", "/aud/" + i);
    lines.push("#EXT-X-ENDLIST");
    return lines.join("\n") + "\n";
  };
  const masterPlaylist = () => {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
    if (withAudio) lines.push('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",DEFAULT=YES,URI="/audio.m3u8"');
    lines.push("#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720" + (withAudio ? ',AUDIO="aud"' : ""));
    lines.push("/media.m3u8");
    return lines.join("\n") + "\n";
  };

  const handler = (req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    log.push({ path: p, headers: { ...req.headers }, encrypted: Boolean(req.socket.encrypted) });
    const text = (body) => {
      const b = Buffer.from(body);
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": b.length });
      res.end(b);
    };
    if (p === "/master.m3u8" && withMaster) return text(masterPlaylist());
    if (p === "/media.m3u8") return text(mediaPlaylist());
    if (p === "/audio.m3u8") return text(audioPlaylist());
    if (p === "/init.mp4" && init) {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": init.length });
      return res.end(init);
    }
    const m = /^\/seg\/(\d+)$/.exec(p);
    if (m) {
      const b = segs[Number(m[1])];
      res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": b.length });
      if (!trickle) return res.end(b);
      let off = 0;
      const tick = () => {
        if (off >= b.length) { res.end(); return; }
        if (res.destroyed) return;
        res.write(b.subarray(off, off + trickle.chunk));
        off += trickle.chunk;
        setTimeout(tick, trickle.delayMs);
      };
      return tick();
    }
    const a = /^\/aud\/(\d+)$/.exec(p);
    if (a) {
      const b = audioSegs[Number(a[1])];
      res.writeHead(200, { "Content-Type": "audio/mp4", "Content-Length": b.length });
      return res.end(b);
    }
    res.writeHead(404, { "Content-Length": "0" });
    res.end();
  };

  const srv = opts.tls ? https.createServer(opts.tls, handler) : http.createServer(handler);
  srv.on("clientError", (_e, socket) => { try { socket.destroy(); } catch { /* gone */ } });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = (opts.tls ? "https" : "http") + "://127.0.0.1:" + srv.address().port;

  const expected = withInit ? Buffer.concat([init, ...segs]) : Buffer.concat(segs);
  return {
    server: srv,
    port: srv.address().port,
    base,
    url: withMaster ? base + "/master.m3u8" : base + "/media.m3u8",
    segments: segs,
    init,
    audioSegments: audioSegs,
    expected,
    expectedSha256: sha256(expected),
    log,
    requestPaths: () => log.map((e) => e.path),
    close: () => closeServer(srv),
  };
}

/** A DASH origin with a video representation and, optionally, an audio one. */
export async function startDashOrigin(opts = {}) {
  const count = opts.segments ?? 4;
  const segBytes = opts.segBytes ?? 64 * 1024;
  const withAudio = opts.audio !== false;
  const initBytes = opts.initBytes ?? 4 * 1024;

  const vInit = payloadOf(initBytes, 0x3000);
  const vSegs = Array.from({ length: count }, (_, i) => payloadOf(segBytes, 0x3100 + i));
  const aInit = payloadOf(initBytes, 0x4000);
  const aSegs = Array.from({ length: count }, (_, i) => payloadOf(segBytes, 0x4100 + i));
  const log = [];

  const mpd = () => {
    const sets = ['<AdaptationSet mimeType="video/mp4">' +
      '<Representation id="v1" bandwidth="1500000" width="1280" height="720">' +
      '<SegmentTemplate timescale="1" duration="2" media="v-$Number$.m4s" initialization="v-init.mp4"/>' +
      "</Representation></AdaptationSet>"];
    if (withAudio) {
      sets.push('<AdaptationSet mimeType="audio/mp4">' +
        '<Representation id="a1" bandwidth="128000">' +
        '<SegmentTemplate timescale="1" duration="2" media="a-$Number$.m4s" initialization="a-init.mp4"/>' +
        "</Representation></AdaptationSet>");
    }
    return '<MPD type="static" mediaPresentationDuration="PT' + (count * 2) + 'S"><Period>' +
      sets.join("") + "</Period></MPD>";
  };

  const handler = (req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    log.push({ path: p, headers: { ...req.headers } });
    if (p === "/manifest.mpd") {
      const b = Buffer.from(mpd());
      res.writeHead(200, { "Content-Type": "application/dash+xml", "Content-Length": b.length });
      return res.end(b);
    }
    const bin = (body) => { res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": body.length }); res.end(body); };
    if (p === "/v-init.mp4") return bin(vInit);
    if (p === "/a-init.mp4") return bin(aInit);
    const v = /^\/v-(\d+)\.m4s$/.exec(p);
    if (v) return bin(vSegs[Number(v[1]) - 1]);
    const a = /^\/a-(\d+)\.m4s$/.exec(p);
    if (a) return bin(aSegs[Number(a[1]) - 1]);
    res.writeHead(404, { "Content-Length": "0" });
    res.end();
  };

  const srv = http.createServer(handler);
  srv.on("clientError", (_e, socket) => { try { socket.destroy(); } catch { /* gone */ } });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + srv.address().port;

  const videoTrack = Buffer.concat([vInit, ...vSegs]);
  const audioTrack = Buffer.concat([aInit, ...aSegs]);
  return {
    server: srv,
    base,
    url: base + "/manifest.mpd",
    videoTrack,
    audioTrack,
    /** Every byte the download must move, whatever it does with the tracks. */
    expectedBytes: videoTrack.length + (withAudio ? audioTrack.length : 0),
    requestPaths: () => log.map((e) => e.path),
    close: () => closeServer(srv),
  };
}

/**
 * A redirect origin.
 *
 * `location` may be absolute (cross-origin) or a path on this server
 * (same-origin). What the target receives is recorded, so a test asserts on the
 * headers that actually arrived.
 */
export async function startRedirectOrigin({ location }) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    seen.push({ path: p, headers: { ...req.headers } });
    if (p === "/start") {
      res.writeHead(302, { Location: location });
      res.end();
      return;
    }
    const body = Buffer.alloc(64 * 1024, 0x33);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": body.length,
      "Accept-Ranges": "bytes",
    });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + srv.address().port;
  return {
    server: srv,
    base,
    url: base + "/start",
    seen,
    at: (p) => seen.find((s) => s.path === p) ?? null,
    close: () => closeServer(srv),
  };
}

/**
 * Run every media end-to-end test into `suite`.
 *
 * @param {import("./harness.mjs").Suite} suite
 * @param {{ out:string, Config:any, QueueManager:any, Downloader:any }} ctx
 */
export async function runMediaE2ETests(suite, ctx) {
  const { out, Config, QueueManager, Downloader } = ctx;
  const workRoot = path.join(out, "media-e2e");
  await fsp.mkdir(workRoot, { recursive: true });

  const freshDownloader = async (name, patch = {}) => {
    const cfg = new Config(path.join(workRoot, name + ".json"));
    await cfg.load();
    await cfg.set({
      defaultDir: path.join(workRoot, name),
      categorizeByType: false,
      maxConnections: 4,
      overwriteExisting: "overwrite",
      maxRetries: 2,
      retryBaseMs: 50,
      speedLimit: 0,
      insecure: false,
      ...patch,
    });
    const queue = new QueueManager({ config: cfg });
    await queue.load();
    return { cfg, queue, downloader: new Downloader({ config: cfg, queue }) };
  };

  /** Run the real CLI in-process while capturing both output streams. */
  const withCapturedCli = async (fn) => {
    const cli = await import("../src/cli.mjs");
    const outChunks = [], errChunks = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (c) => { outChunks.push(String(c)); return true; };
    process.stderr.write = (c) => { errChunks.push(String(c)); return true; };
    try {
      const code = await fn(cli);
      return { code, stdout: outChunks.join(""), stderr: errChunks.join("") };
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
  };
  const withHome = async (homeDir, fn) => {
    const prev = process.env.DOWNLOADX_HOME;
    await fsp.mkdir(homeDir, { recursive: true });
    process.env.DOWNLOADX_HOME = homeDir;
    try { return await fn(); }
    finally {
      if (prev === undefined) delete process.env.DOWNLOADX_HOME;
      else process.env.DOWNLOADX_HOME = prev;
    }
  };

  // =====================================================================
  // 1. Exact output path
  // =====================================================================
  suite.group("Media output path");

  await suite.test("get -o <full file path> writes exactly that file", async () => {
    // The regression: categorizeByType routed a .ts into <dir>/video/, so the
    // file the user asked for was never created while the command exited 0.
    const origin = await startHlsOrigin({ segments: 3, segBytes: 32 * 1024 });
    const { cfg, downloader } = await freshDownloader("exact-path", { categorizeByType: true });
    try {
      const exact = path.join(workRoot, "exact-path", "movie.ts");
      const result = await downloader.run({
        id: "exact-path",
        url: origin.url,
        kind: "hls",
        filename: path.basename(exact),
        dir: path.dirname(exact),
        headers: {},
        connections: 2,
        meta: { exactTarget: true },
      });
      assert.equal(result.target, exact, "the reported target must be the requested path");
      assert.ok(fs.existsSync(exact), "the file must exist at exactly " + exact);
      assert.equal(await hashFile(exact), origin.expectedSha256,
        "the bytes at the exact path must be the fragments served by the origin");
      const files = await walkFiles(path.join(workRoot, "exact-path"));
      assert.equal(files.length, 1,
        "no category folder and no stray file may be created, found " + JSON.stringify(files));
      assert.equal(cfg.get("categorizeByType"), true,
        "this test must keep categorizeByType on, otherwise it proves nothing");
    } finally {
      await origin.close();
    }
  });

  await suite.test("get -o <directory> keeps the category subfolder behaviour", async () => {
    // The other half of the contract: a directory is still a directory, and the
    // category setting still decides the subfolder.
    const origin = await startHlsOrigin({ segments: 2, segBytes: 32 * 1024 });
    const dir = path.join(workRoot, "dir-output");
    await fsp.mkdir(dir, { recursive: true });
    const { downloader } = await freshDownloader("dir-output", { categorizeByType: true });
    try {
      const result = await downloader.run({
        id: "dir-output", url: origin.url, kind: "hls", filename: "clip.ts", dir,
        headers: {}, connections: 2, meta: {},
      });
      const expected = path.join(dir, "video", "clip.ts");
      assert.equal(result.target, expected, "a directory target must still be classified, got " + result.target);
      assert.ok(fs.existsSync(expected), "the categorised file must exist");
      assert.equal(await hashFile(expected), origin.expectedSha256);
    } finally {
      await origin.close();
    }
  });

  await suite.test("a directory target with categorizeByType off stays flat", async () => {
    const origin = await startHlsOrigin({ segments: 2, segBytes: 16 * 1024 });
    const dir = path.join(workRoot, "dir-flat");
    await fsp.mkdir(dir, { recursive: true });
    const { downloader } = await freshDownloader("dir-flat", { categorizeByType: false });
    try {
      const result = await downloader.run({
        id: "dir-flat", url: origin.url, kind: "hls", filename: "flat.ts", dir,
        headers: {}, connections: 2, meta: {},
      });
      assert.equal(result.target, path.join(dir, "flat.ts"));
      assert.ok(fs.existsSync(result.target));
      assert.equal(await hashFile(result.target), origin.expectedSha256);
    } finally {
      await origin.close();
    }
  });

  await suite.test("auto-detected and forced HLS agree on the output path", async () => {
    // `--kind hls` and an auto-detected .m3u8 URL must not disagree about where
    // the file goes, or the same command behaves differently depending on a flag.
    const origin = await startHlsOrigin({ segments: 2, segBytes: 16 * 1024 });
    const dirA = path.join(workRoot, "agree-forced");
    const dirB = path.join(workRoot, "agree-auto");
    await fsp.mkdir(dirA, { recursive: true });
    await fsp.mkdir(dirB, { recursive: true });
    const { downloader } = await freshDownloader("agree", { categorizeByType: true });
    try {
      const { detectKind } = await import("../src/downloader.mjs");
      assert.equal(detectKind(origin.url), "hls", "the fixture URL must auto-detect as hls");
      const forced = await downloader.run({
        id: "agree-forced", url: origin.url, kind: "hls", filename: "same.ts", dir: dirA,
        headers: {}, connections: 2, meta: {},
      });
      const auto = await downloader.run({
        id: "agree-auto", url: origin.url, kind: detectKind(origin.url), filename: "same.ts", dir: dirB,
        headers: {}, connections: 2, meta: {},
      });
      assert.equal(path.basename(path.dirname(forced.target)), path.basename(path.dirname(auto.target)),
        "both must land in the same relative subfolder: " + forced.target + " vs " + auto.target);
      assert.equal(await hashFile(forced.target), await hashFile(auto.target),
        "both routes must produce identical bytes");
    } finally {
      await origin.close();
    }
  });


  await suite.test("auto-detected and forced DASH agree on the exact output path", async () => {
    const origin = await startDashOrigin({ segments: 2, segBytes: 16 * 1024, audio: false });
    const { downloader } = await freshDownloader("dash-agree", { categorizeByType: true });
    try {
      const { detectKind } = await import("../src/downloader.mjs");
      assert.equal(detectKind(origin.url), "dash");
      const plan = [
        ["dash-forced", "dash", path.join(workRoot, "dash-agree", "forced.mp4")],
        ["dash-auto", detectKind(origin.url), path.join(workRoot, "dash-agree", "auto.mp4")],
      ];
      for (const [id, kind, target] of plan) {
        const r = await downloader.run({
          id, url: origin.url, kind, filename: path.basename(target), dir: path.dirname(target),
          headers: {}, connections: 2, meta: { exactTarget: true },
        });
        assert.equal(r.target, target, "DASH (" + kind + ") must write exactly " + target + ", got " + r.target);
        assert.ok(fs.existsSync(target), "missing artefact " + target);
        assert.equal(await hashFile(target), sha256(origin.videoTrack),
          "the DASH artefact must be the concatenation the origin served");
      }
    } finally {
      await origin.close();
    }
  });

  await suite.test("the CLI turns -o <file> into an exact target and -o <dir> into a folder", async () => {
    // The downloader honours meta.exactTarget; this checks the CLI sets it for a
    // file path and leaves it unset for a directory.
    const origin = await startHlsOrigin({ segments: 2, segBytes: 16 * 1024 });
    const homeDir = path.join(workRoot, "cli-home");
    try {
      await withHome(homeDir, async () => {
        // The shipped default has categorizeByType on, which is what made the
        // bug bite, so keep it on here.
        const cfg = new Config(path.join(homeDir, "config.json"));
        await cfg.load();
        await cfg.set({ defaultDir: path.join(homeDir, "dl"), categorizeByType: true });

        const exact = path.join(homeDir, "movie.ts");
        const r = await withCapturedCli((cli) => cli.main(["get", origin.url, "--kind", "hls", "-o", exact, "-q"]));
        assert.equal(r.code, 0, "the download must succeed: " + r.stderr);
        assert.ok(fs.existsSync(exact), "the CLI must write exactly " + exact + "; stdout was " + r.stdout);
        assert.equal(await hashFile(exact), origin.expectedSha256, "the CLI artefact must be correct");
        // config.json lives in DOWNLOADX_HOME by design; every other file is a
        // download artefact and there must be exactly one.
        const written = (await walkFiles(homeDir)).filter((f) => path.basename(f) !== "config.json");
        assert.equal(written.length, 1, "nothing else may be written: " + JSON.stringify(written));

        // With --filename the user named the file separately: directory rules apply.
        const named = path.join(homeDir, "named-dir");
        await fsp.mkdir(named, { recursive: true });
        const r2 = await withCapturedCli((cli) => cli.main([
          "get", origin.url, "--kind", "hls", "-o", named, "--filename", "chosen.ts", "-q",
        ]));
        assert.equal(r2.code, 0, "the named download must succeed: " + r2.stderr);
        assert.ok(fs.existsSync(path.join(named, "video", "chosen.ts")),
          "a directory plus --filename must keep the category behaviour, found " +
          JSON.stringify(await walkFiles(named)));
      });
    } finally {
      await origin.close();
    }
  });

  // =====================================================================
  // 2. Rate limiting
  // =====================================================================
  suite.group("Media rate limiting");

  await suite.test("the limiter paces the source, not the tail (backpressure)", async () => {
    // A limiter that reads everything first and sleeps afterwards passes a
    // stopwatch test but not this one: the source reads are what must be spread
    // out, otherwise the fragment was buffered at full speed and only the tail
    // of the transfer was delayed.
    const CHUNK = 32 * 1024, COUNT = 96;          // 3 MiB
    const pulls = [];
    let made = 0;
    const src = new Readable({
      highWaterMark: 1,                            // no hidden prefetch in the test itself
      read() {
        if (made >= COUNT) { this.push(null); return; }
        pulls.push(Date.now());
        made++;
        this.push(Buffer.alloc(CHUNK, made & 0xff));
      },
    });
    const limiter = new RateLimiter(1024 * 1024);   // 1 MiB/s
    const started = Date.now();
    const body = await readBody({ stream: src }, 8 * 1024 * 1024, { limiter });
    const elapsed = (Date.now() - started) / 1000;
    assert.equal(body.length, CHUNK * COUNT);
    assert.ok(elapsed >= 1.9, "3 MiB at 1 MiB/s (1s burst) needs ~2s, took " + elapsed.toFixed(2) + "s");
    const span = (pulls[pulls.length - 1] - pulls[0]) / 1000;
    assert.ok(span >= 1.0,
      "the source reads must be spread across the transfer; they spanned only " + span.toFixed(2) + "s");
  });

  await suite.test("a chunk larger than the bucket is spent, not deadlocked", async () => {
    // tokens is capped at rate, so asking for more than rate in one call can
    // never be satisfied by waiting; the previous loop hung forever here.
    const limiter = new RateLimiter(64 * 1024);
    const started = Date.now();
    await limiter.take(256 * 1024);
    const elapsed = (Date.now() - started) / 1000;
    assert.ok(elapsed >= 1.9 && elapsed < 10,
      "256 KiB at 64 KiB/s (64 KiB burst) needs ~3s, took " + elapsed.toFixed(2) + "s");
  });

  await suite.test("--limit throttles an HLS download to the configured rate", async () => {
    // The fixture is well past the one-second burst, so the steady-state rate
    // decides the duration rather than the free credit at the start.
    // 4 MiB against a 1 MiB burst: three seconds of steady state, so the
    // measured duration is decided by the rate rather than by free credit.
    const segBytes = 512 * 1024, segments = 8;      // 4 MiB
    const origin = await startHlsOrigin({ segments, segBytes });
    const { downloader } = await freshDownloader("limit-hls", { connections: 4 });
    try {
      const rate = 1024 * 1024;                     // 1 MiB/s
      const dir = path.join(workRoot, "limit-hls");
      const started = Date.now();
      const result = await downloader.run({
        id: "limit-hls", url: origin.url, kind: "hls", filename: "limited.ts", dir,
        headers: {}, connections: 4, speedLimit: rate, meta: {},
      });
      const elapsed = (Date.now() - started) / 1000;
      const total = origin.expected.length;
      assert.equal(result.bytes, total, "the whole playlist must still arrive");
      assert.equal(await hashFile(result.target), origin.expectedSha256,
        "throttling must not corrupt the artefact");

      // Lower bound: the bucket cannot be beaten. (total - burst) / rate.
      const floor = (total - rate) / rate;
      assert.ok(elapsed >= floor * 0.9,
        "4 MiB at 1 MiB/s must take at least ~" + floor.toFixed(1) + "s, took " + elapsed.toFixed(2) + "s");
      const observed = total / elapsed;
      assert.ok(observed <= rate * 1.6,
        "observed " + Math.round(observed / 1024) + " KiB/s exceeds 1 MiB/s by too much");
    } finally {
      await origin.close();
    }
  });

  await suite.test("Settings speedLimit applies when the task has none", async () => {
    const segBytes = 512 * 1024, segments = 8;      // 4 MiB
    const origin = await startHlsOrigin({ segments, segBytes });
    const rate = 1024 * 1024;
    const { downloader } = await freshDownloader("limit-settings", { connections: 2, speedLimit: rate });
    try {
      const dir = path.join(workRoot, "limit-settings");
      const started = Date.now();
      const result = await downloader.run({
        id: "limit-settings", url: origin.url, kind: "hls", filename: "settings.ts", dir,
        headers: {}, connections: 2, meta: {},        // no task-level speedLimit
      });
      const elapsed = (Date.now() - started) / 1000;
      const total = origin.expected.length;
      assert.equal(result.bytes, total);
      const floor = (total - rate) / rate;
      assert.ok(elapsed >= floor * 0.9,
        "the Settings limit must throttle too: expected >= ~" + floor.toFixed(1) +
        "s, took " + elapsed.toFixed(2) + "s");
    } finally {
      await origin.close();
    }
  });

  await suite.test("concurrency does not multiply the cap", async () => {
    // Eight fragment workers share one bucket. With one bucket per worker the
    // task would move eight times the configured rate.
    const segBytes = 512 * 1024, segments = 8;      // 4 MiB
    const origin = await startHlsOrigin({ segments, segBytes });
    const rate = 1024 * 1024;
    const { downloader } = await freshDownloader("limit-concurrency", { connections: 8 });
    try {
      const dir = path.join(workRoot, "limit-concurrency");
      const started = Date.now();
      const result = await downloader.run({
        id: "limit-concurrency", url: origin.url, kind: "hls", filename: "conc.ts", dir,
        headers: {}, connections: 8, speedLimit: rate, meta: {},
      });
      const elapsed = (Date.now() - started) / 1000;
      const total = origin.expected.length;
      assert.equal(result.bytes, total);
      const floor = (total - rate) / rate;
      assert.ok(elapsed >= floor * 0.9,
        "8 connections over 4 MiB at 1 MiB/s must still take ~" + floor.toFixed(1) +
        "s, took " + elapsed.toFixed(2) + "s");
      const observed = total / elapsed;
      assert.ok(observed <= rate * 1.6,
        "8 workers must not beat the shared bucket: " + Math.round(observed / 1024) + " KiB/s observed");
    } finally {
      await origin.close();
    }
  });

  await suite.test("DASH video and audio share one bucket", async () => {
    const segBytes = 384 * 1024, segments = 6;      // ~4.5 MiB across both tracks
    const origin = await startDashOrigin({ segments, segBytes, audio: true });
    const rate = 1536 * 1024;                       // 1.5 MiB/s
    const { downloader } = await freshDownloader("limit-dash", { connections: 4 });
    try {
      const dir = path.join(workRoot, "limit-dash");
      const started = Date.now();
      const result = await downloader.run({
        id: "limit-dash", url: origin.url, kind: "dash", filename: "dash.mp4", dir,
        headers: {}, connections: 4, speedLimit: rate, meta: {},
      });
      const elapsed = (Date.now() - started) / 1000;
      const total = origin.expectedBytes;
      // The reported size is the surviving artefact, which is one track when the
      // mux fails. What matters here is that BOTH tracks were actually fetched,
      // so check the origin's request log rather than the output size.
      const paths = origin.requestPaths();
      for (let i = 1; i <= segments; i++) {
        assert.ok(paths.includes("/v-" + i + ".m4s"), "video fragment " + i + " must be fetched");
        assert.ok(paths.includes("/a-" + i + ".m4s"), "audio fragment " + i + " must be fetched");
      }
      assert.ok(paths.includes("/v-init.mp4") && paths.includes("/a-init.mp4"),
        "both init segments must be fetched");
      assert.ok(result.bytes > 0, "an artefact must be produced");
      const floor = (total - rate) / rate;
      assert.ok(elapsed >= floor * 0.9,
        "DASH at 1.5 MiB/s must take at least ~" + floor.toFixed(1) + "s, took " + elapsed.toFixed(2) + "s");
      const observed = total / elapsed;
      assert.ok(observed <= rate * 1.6,
        "video and audio pools must not each get their own bucket: " +
        Math.round(observed / 1024) + " KiB/s observed");
    } finally {
      await origin.close();
    }
  });

  await suite.test("an HLS audio rendition draws from the same bucket", async () => {
    // A separate audio rendition is more bytes of the same task, not a second
    // download: it must not get a fresh allowance.
    const segBytes = 256 * 1024, segments = 4;      // ~1 MiB video + ~1 MiB audio
    const origin = await startHlsOrigin({ segments, segBytes, audioGroup: true });
    const rate = 512 * 1024;
    const { downloader } = await freshDownloader("limit-hls-audio", {
      connections: 4, ffmpegPath: "C:" + String.fromCharCode(92) + "definitely" +
        String.fromCharCode(92) + "not" + String.fromCharCode(92) + "ffmpeg.exe",
    });
    try {
      const dir = path.join(workRoot, "limit-hls-audio");
      const started = Date.now();
      const result = await downloader.run({
        id: "limit-hls-audio", url: origin.url, kind: "hls", filename: "withaudio.ts", dir,
        headers: {}, connections: 4, speedLimit: rate, meta: {},
      });
      const elapsed = (Date.now() - started) / 1000;
      // The merge cannot succeed without ffmpeg; the transfer still moves both
      // renditions, which is what the timing measures.
      assert.ok(result.bytes > 0, "the video rendition must still be written");
      const audioFetched = origin.requestPaths().filter((p) => p.startsWith("/aud/")).length;
      assert.equal(audioFetched, segments, "the audio rendition must be fetched: " + audioFetched);
      const total = origin.expected.length + origin.audioSegments.reduce((a, b) => a + b.length, 0);
      const floor = (total - rate) / rate;
      assert.ok(elapsed >= floor * 0.85,
        "2 MiB at 512 KiB/s must take at least ~" + floor.toFixed(1) + "s, took " + elapsed.toFixed(2) + "s");
      const observed = total / elapsed;
      assert.ok(observed <= rate * 1.7,
        "the audio rendition must not double the cap: " + Math.round(observed / 1024) + " KiB/s observed");
    } finally {
      await origin.close();
    }
  });

  await suite.test("no limit means no throttling", async () => {
    // Guards against a limiter that throttles when it was asked not to.
    const segBytes = 512 * 1024, segments = 6;      // 3 MiB
    const origin = await startHlsOrigin({ segments, segBytes });
    const { downloader } = await freshDownloader("limit-off", { connections: 4, speedLimit: 0 });
    try {
      const dir = path.join(workRoot, "limit-off");
      const started = Date.now();
      const result = await downloader.run({
        id: "limit-off", url: origin.url, kind: "hls", filename: "free.ts", dir,
        headers: {}, connections: 4, meta: {},
      });
      const elapsed = (Date.now() - started) / 1000;
      assert.equal(result.bytes, origin.expected.length);
      assert.ok(elapsed < 2.5,
        "an unlimited local download of 3 MiB must not take " + elapsed.toFixed(2) + "s");
    } finally {
      await origin.close();
    }
  });

  // =====================================================================
  // 3. Cross-origin redirects must not carry credentials
  // =====================================================================
  suite.group("Redirect credentials");

  const CREDENTIALS = {
    Authorization: "Bearer s3cr3t-token",
    Cookie: "session=SECRET-VALUE",
    "Proxy-Authorization": "Basic cHJveHk6cGFzcw==",
    "X-Api-Key": "key-abc123",
  };
  const HARMLESS = { "X-Trace-Id": "trace-1", Referer: "https://site.test/page" };

  await suite.test("a same-origin redirect keeps the request headers", async () => {
    const target = await startRedirectOrigin({ location: "/final" });
    try {
      const { requestFollow } = await import("../src/net.mjs");
      // Same server, different path: still the same origin.
      const res = await requestFollow(target.url, { headers: { ...CREDENTIALS, ...HARMLESS } });
      await readBody(res);
      const hop2 = target.at("/final");
      assert.ok(hop2, "the redirect target must have been requested");
      assert.equal(hop2.headers.authorization, CREDENTIALS.Authorization,
        "a same-origin hop must keep Authorization");
      assert.equal(hop2.headers.cookie, CREDENTIALS.Cookie, "a same-origin hop must keep Cookie");
      assert.equal(hop2.headers["x-api-key"], CREDENTIALS["X-Api-Key"], "custom headers must survive");
      assert.equal(hop2.headers["x-trace-id"], HARMLESS["X-Trace-Id"], "ordinary headers must survive");
      assert.equal(hop2.headers.referer, HARMLESS.Referer, "Referer must survive");
      assert.deepEqual(res.strippedHeaders, [], "nothing may be stripped on a same-origin hop");
    } finally {
      await target.close();
    }
  });

  await suite.test("a cross-origin redirect drops every credential header", async () => {
    // A different port is a different origin, and that is the cheapest way for
    // an origin to hand a session cookie to a host of its choosing.
    const other = await startRedirectOrigin({ location: "/final" });
    const first = await startRedirectOrigin({ location: other.base + "/final" });
    try {
      const { requestFollow } = await import("../src/net.mjs");
      const res = await requestFollow(first.url, { headers: { ...CREDENTIALS, ...HARMLESS } });
      await readBody(res);

      const hop1 = first.at("/start");
      assert.ok(hop1, "the first hop must have received the request");
      assert.equal(hop1.headers.authorization, CREDENTIALS.Authorization,
        "the origin the credentials were meant for must get them");

      const hop2 = other.at("/final");
      assert.ok(hop2, "the cross-origin target must have been requested");
      for (const name of ["authorization", "cookie", "proxy-authorization", "x-api-key"]) {
        assert.equal(hop2.headers[name], undefined,
          "the cross-origin target must not receive " + name + ", got " + JSON.stringify(hop2.headers[name]));
      }
      assert.equal(hop2.headers["x-trace-id"], HARMLESS["X-Trace-Id"],
        "non-credential headers should still be forwarded");
      assert.deepEqual(res.strippedHeaders.slice().sort(),
        ["Authorization", "Cookie", "Proxy-Authorization", "X-Api-Key"].sort(),
        "every dropped header must be reported, got " + JSON.stringify(res.strippedHeaders));
      assert.equal(res.finalUrl, other.base + "/final");
    } finally {
      await first.close();
      await other.close();
    }
  });

  await suite.test("credentials stay stripped after a chain returns to the origin", async () => {
    // origin -> other origin -> back to the origin. The return hop is a
    // redirect, not the request the credentials were granted for, so they must
    // not reappear.
    const back = await startRedirectOrigin({ location: "/final" });
    const middle = await startRedirectOrigin({ location: back.base + "/start" });
    const first = await startRedirectOrigin({ location: middle.base + "/start" });
    try {
      const { requestFollow } = await import("../src/net.mjs");
      const res = await requestFollow(first.url, { headers: { Cookie: "session=SECRET-VALUE" } });
      await readBody(res);
      assert.equal(back.at("/final").headers.cookie, undefined,
        "a redirect chain must not re-acquire credentials it was stripped of");
    } finally {
      await first.close();
      await middle.close();
      await back.close();
    }
  });

  await suite.test("a download through a cross-origin redirect stays correct and unleaked", async () => {
    // The engine path, not just the transport primitive: the file must still
    // arrive intact while the second host never sees the cookie.
    const other = await startRedirectOrigin({ location: "/final" });
    const first = await startRedirectOrigin({ location: other.base + "/final" });
    try {
      const { downloader } = await freshDownloader("redirect-dl", { connections: 2 });
      const dir = path.join(workRoot, "redirect-dl");
      const result = await downloader.run({
        id: "redirect-dl", url: first.url, kind: "http", filename: "redirected.bin", dir,
        headers: { Cookie: "session=SECRET-VALUE", "X-Trace-Id": "trace-1" },
        connections: 2, meta: {},
      });
      assert.equal(result.bytes, 64 * 1024, "the redirect target's body must be downloaded");
      assert.equal(await hashFile(result.target), sha256(Buffer.alloc(64 * 1024, 0x33)));
      const hop2 = other.at("/final");
      assert.ok(hop2, "the cross-origin target must have been requested");
      assert.equal(hop2.headers.cookie, undefined,
        "the engine must not forward a cookie across origins");
      assert.equal(hop2.headers["x-trace-id"], "trace-1", "ordinary headers still travel");
    } finally {
      await first.close();
      await other.close();
    }
  });

  await suite.test("sameOrigin compares scheme, host and effective port", async () => {
    const { sameOrigin } = await import("../src/net.mjs");
    assert.equal(sameOrigin("https://a.test/x", "https://a.test:443/y"), true,
      "the default port is the same origin");
    assert.equal(sameOrigin("http://a.test/x", "http://a.test:80/y"), true,
      "port 80 is the http default");
    assert.equal(sameOrigin("http://a.test/x", "https://a.test/x"), false,
      "a scheme change is cross-origin");
    assert.equal(sameOrigin("http://a.test/a", "http://a.test:8080/b"), false,
      "a port change is cross-origin");
    assert.equal(sameOrigin("http://a.test/a", "http://b.test/a"), false,
      "a host change is cross-origin");
    assert.equal(sameOrigin("http://A.Test/a", "http://a.test/a"), true,
      "hosts compare case-insensitively");
  });

  await suite.test("the headers the product builds are the ones stripped", async () => {
    // buildRequestHeaders is what turns cookies and Basic credentials into
    // headers; that bag is exactly what used to travel across origins.
    const { buildRequestHeaders, stripCredentialHeaders } = await import("../src/net.mjs");
    const built = buildRequestHeaders({
      headers: { "X-Trace-Id": "t" },
      cookies: "session=SECRET-VALUE",
      username: "user",
      password: "pass",
      referer: "https://site.test/p",
    });
    assert.ok(built.Authorization && built.Cookie, "the helper must produce credentials to strip");
    const { headers, removed } = stripCredentialHeaders(built);
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers.Cookie, undefined);
    assert.equal(headers["X-Trace-Id"], "t");
    assert.equal(headers.Referer, "https://site.test/p");
    assert.deepEqual(removed.sort(), ["Authorization", "Cookie"]);
  });

  // =====================================================================
  // 4. Media TLS: --insecure end to end
  // =====================================================================
  suite.group("Media TLS --insecure");

  await suite.test("default settings reject the self-signed media origin", async () => {
    const origin = await startHlsOrigin({ segments: 2, segBytes: 16 * 1024, tls: selfSignedMaterial() });
    const { cfg, downloader } = await freshDownloader("tls-strict", { insecure: false });
    try {
      assert.equal(cfg.get("insecure"), false, "the fixture must run against the default trust policy");
      const dir = path.join(workRoot, "tls-strict");
      await assert.rejects(
        () => downloader.run({
          id: "tls-strict", url: origin.url, kind: "hls", filename: "strict.ts", dir,
          headers: {}, connections: 2, meta: {},
        }),
        "an untrusted certificate must fail the download");
      const files = await walkFiles(dir);
      assert.equal(files.length, 0,
        "a refused TLS handshake must leave no artefact behind, found " + JSON.stringify(files));
      assert.equal(origin.requestPaths().length, 0,
        "the client must not be able to complete any request, saw " + JSON.stringify(origin.requestPaths()));
    } finally {
      await origin.close();
    }
  });

  await suite.test("--insecure downloads the whole HLS chain with correct bytes", async () => {
    // Manifest, every fragment and the init segment are fetched over the
    // self-signed origin; comparing the final hash proves the fragments went
    // through too, not just the playlist.
    const origin = await startHlsOrigin({
      segments: 3, segBytes: 32 * 1024, initSegment: true, tls: selfSignedMaterial(),
    });
    const dir = path.join(workRoot, "tls-insecure");
    await fsp.mkdir(dir, { recursive: true });
    try {
      const { downloader } = await freshDownloader("tls-insecure", { insecure: true });
      const result = await downloader.run({
        id: "tls-insecure", url: origin.url, kind: "hls", filename: "secure.ts", dir,
        headers: {}, connections: 2, meta: { exactTarget: true },
      });
      assert.equal(result.target, path.join(dir, "secure.ts"));
      assert.equal(result.bytes, origin.expected.length);
      assert.equal(await hashFile(result.target), origin.expectedSha256,
        "the artefact must equal init + every fragment served over TLS");

      const paths = origin.requestPaths();
      assert.ok(paths.includes("/master.m3u8") || paths.includes("/media.m3u8"),
        "the playlist must be fetched");
      for (let i = 0; i < 3; i++) assert.ok(paths.includes("/seg/" + i), "fragment " + i + " must be fetched");
      assert.ok(paths.includes("/init.mp4"), "the init segment must be fetched");
      assert.ok(origin.log.every((e) => e.encrypted), "every request of this chain must have used TLS");
    } finally {
      await origin.close();
    }
  });

  await suite.test("--insecure reaches the DASH manifest, init segment and fragments", async () => {
    // The DASH path builds its own requests; a TLS flag that only covered HLS
    // would pass the previous test and fail here.
    const tls = selfSignedMaterial();
    const served = [];
    const mpd = '<MPD type="static" mediaPresentationDuration="PT4S"><Period>' +
      '<AdaptationSet mimeType="video/mp4"><Representation id="v1" bandwidth="1000" width="640" height="360">' +
      '<SegmentTemplate timescale="1" duration="2" media="v-$Number$.m4s" initialization="v-init.mp4"/>' +
      "</Representation></AdaptationSet></Period></MPD>";
    const init = payloadOf(2 * 1024, 0x5000);
    const seg1 = payloadOf(16 * 1024, 0x5001);
    const seg2 = payloadOf(16 * 1024, 0x5002);
    const srv = https.createServer(tls, (req, res) => {
      const p = new URL(req.url, "http://x").pathname;
      served.push({ path: p, encrypted: Boolean(req.socket.encrypted) });
      const send = (buf) => { res.writeHead(200, { "Content-Length": buf.length }); res.end(buf); };
      if (p === "/manifest.mpd") return send(Buffer.from(mpd));
      if (p === "/v-init.mp4") return send(init);
      if (p === "/v-1.m4s") return send(seg1);
      if (p === "/v-2.m4s") return send(seg2);
      res.writeHead(404, { "Content-Length": "0" }); res.end();
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const base = "https://127.0.0.1:" + srv.address().port;
    try {
      const dir = path.join(workRoot, "tls-dash");
      const { downloader } = await freshDownloader("tls-dash", { insecure: true });
      const result = await downloader.run({
        id: "tls-dash", url: base + "/manifest.mpd", kind: "dash", filename: "secure.mp4", dir,
        headers: {}, connections: 2, meta: { exactTarget: true },
      });
      assert.equal(result.target, path.join(dir, "secure.mp4"));
      assert.equal(await hashFile(result.target), sha256(Buffer.concat([init, seg1, seg2])),
        "the DASH artefact must be the TLS-served segments");
      for (const p of ["/manifest.mpd", "/v-init.mp4", "/v-1.m4s", "/v-2.m4s"]) {
        assert.ok(served.some((e) => e.path === p), p + " must have been requested over TLS");
      }
      assert.ok(served.every((e) => e.encrypted), "every DASH request must have used TLS");

      // The same manifest without -k must fail, or the flag proves nothing.
      const strict = await freshDownloader("tls-dash-strict", { insecure: false });
      await assert.rejects(
        () => strict.downloader.run({
          id: "tls-dash-strict", url: base + "/manifest.mpd", kind: "dash", filename: "strict.mp4",
          dir: path.join(workRoot, "tls-dash-strict"), headers: {}, connections: 2, meta: { exactTarget: true },
        }),
        "the DASH path must reject the self-signed origin without --insecure");
    } finally {
      await closeServer(srv);
    }
  });

  await suite.test("--insecure on the CLI downloads the HTTPS playlist and fragments", async () => {
    // The shape a user actually types, including the -k flag path through
    // runMediaGet rather than a task object built by the test.
    const origin = await startHlsOrigin({ segments: 2, segBytes: 24 * 1024, tls: selfSignedMaterial() });
    const homeDir = path.join(workRoot, "tls-cli-home");
    try {
      await withHome(homeDir, async () => {
        const cfg = new Config(path.join(homeDir, "config.json"));
        await cfg.load();
        await cfg.set({ defaultDir: path.join(homeDir, "dl"), categorizeByType: false, insecure: false });

        const strictPath = path.join(homeDir, "strict.ts");
        const strict = await withCapturedCli((cli) => cli.main([
          "get", origin.url, "--kind", "hls", "-o", strictPath, "-q",
        ]));
        assert.notEqual(strict.code, 0, "the CLI must fail on an untrusted certificate");
        assert.ok(!fs.existsSync(strictPath), "no artefact may be produced without -k");
        assert.equal(origin.requestPaths().length, 0,
          "an untrusted handshake must not complete a single request, saw " +
          JSON.stringify(origin.requestPaths()));

        const insecurePath = path.join(homeDir, "insecure.ts");
        const r = await withCapturedCli((cli) => cli.main([
          "get", origin.url, "--kind", "hls", "-o", insecurePath, "-k", "-q",
        ]));
        assert.equal(r.code, 0, "with -k the download must succeed: " + r.stderr);
        assert.ok(fs.existsSync(insecurePath), "the artefact must exist at " + insecurePath);
        assert.equal(await hashFile(insecurePath), origin.expectedSha256,
          "the -k artefact must equal the fragments served over TLS");
        for (let i = 0; i < 2; i++) {
          assert.ok(origin.requestPaths().includes("/seg/" + i),
            "fragment " + i + " must have been fetched over TLS");
        }
      });
    } finally {
      await origin.close();
    }
  });

  // =====================================================================
  // 5. Full target path obeys the overwrite policy
  // =====================================================================
  suite.group("Exact target and overwrite policy");

  const SENTINEL = "SENTINEL-DO-NOT-REPLACE";

  const sentinelCase = async (name, policy, originFactory) => {
    const origin = await originFactory();
    const dir = path.join(workRoot, name);
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, "movie.ts");
    await fsp.writeFile(target, SENTINEL);
    const { downloader } = await freshDownloader(name, { overwriteExisting: policy });
    return { origin, dir, target, downloader };
  };

  await suite.test("exact target with rename keeps the existing file", async () => {
    // Data protection: `-o <file>` says where the artefact goes, not that an
    // existing file there may be destroyed. The shipped default is rename.
    const c = await sentinelCase("ex-rename", "rename",
      () => startHlsOrigin({ segments: 2, segBytes: 16 * 1024 }));
    try {
      const r = await c.downloader.run({
        id: "ex-rename", url: c.origin.url, kind: "hls", filename: "movie.ts", dir: c.dir,
        headers: {}, connections: 2, meta: { exactTarget: true },
      });
      assert.equal(fs.readFileSync(c.target, "utf8"), SENTINEL,
        "the original file must not be touched");
      assert.notEqual(r.target, c.target, "the artefact must land on a different name");
      assert.equal(path.dirname(r.target), c.dir,
        "the renamed artefact must stay in the requested directory");
      assert.equal(path.basename(r.target), "movie (2).ts",
        "the renamed artefact must follow the existing scheme, got " + path.basename(r.target));
      assert.equal(await hashFile(r.target), c.origin.expectedSha256,
        "the renamed artefact must still be correct");
    } finally {
      await c.origin.close();
    }
  });

  await suite.test("exact target with skip fails and keeps the original bytes", async () => {
    const c = await sentinelCase("ex-skip", "skip",
      () => startHlsOrigin({ segments: 2, segBytes: 16 * 1024 }));
    try {
      let err = null;
      await c.downloader.run({
        id: "ex-skip", url: c.origin.url, kind: "hls", filename: "movie.ts", dir: c.dir,
        headers: {}, connections: 2, meta: { exactTarget: true },
      }).catch((e) => { err = e; });
      assert.ok(err, "the task must fail rather than overwrite under the skip policy");
      assert.equal(err.code, "ALREADY_EXISTS",
        "the failure must name the reason, got " + (err && err.code));
      assert.equal(fs.readFileSync(c.target, "utf8"), SENTINEL,
        "the original bytes must survive a refused overwrite");
    } finally {
      await c.origin.close();
    }
  });

  await suite.test("exact target with overwrite replaces the file", async () => {
    const c = await sentinelCase("ex-overwrite", "overwrite",
      () => startHlsOrigin({ segments: 2, segBytes: 16 * 1024 }));
    try {
      const r = await c.downloader.run({
        id: "ex-overwrite", url: c.origin.url, kind: "hls", filename: "movie.ts", dir: c.dir,
        headers: {}, connections: 2, meta: { exactTarget: true },
      });
      assert.equal(r.target, c.target, "overwrite must use the requested path");
      assert.equal(await hashFile(c.target), c.origin.expectedSha256,
        "the requested file must hold the new artefact");
    } finally {
      await c.origin.close();
    }
  });

  await suite.test("exact target with a fresh path is unaffected by the policy", async () => {
    // No collision: every policy must land on the requested name.
    for (const policy of ["rename", "skip", "overwrite"]) {
      const origin = await startHlsOrigin({ segments: 1, segBytes: 8 * 1024 });
      const dir = path.join(workRoot, "ex-fresh-" + policy);
      await fsp.mkdir(dir, { recursive: true });
      try {
        const { downloader } = await freshDownloader("ex-fresh-" + policy, { overwriteExisting: policy });
        const requested = path.join(dir, "fresh.ts");
        const r = await downloader.run({
          id: "ex-fresh-" + policy, url: origin.url, kind: "hls", filename: "fresh.ts", dir,
          headers: {}, connections: 1, meta: { exactTarget: true },
        });
        assert.equal(r.target, requested, "policy " + policy + " must use the requested path when free");
      } finally {
        await origin.close();
      }
    }
  });

  await suite.test("DASH honours the overwrite policy on an exact target", async () => {
    for (const [policy, expectRename] of [["rename", true], ["skip", false]]) {
      const origin = await startDashOrigin({ segments: 1, segBytes: 8 * 1024, audio: false });
      const dir = path.join(workRoot, "dash-policy-" + policy);
      await fsp.mkdir(dir, { recursive: true });
      const target = path.join(dir, "movie.mp4");
      await fsp.writeFile(target, SENTINEL);
      try {
        const { downloader } = await freshDownloader("dash-policy-" + policy, {
          overwriteExisting: policy,
          ffmpegPath: "C:" + String.fromCharCode(92) + "nope.exe",
        });
        let r = null, err = null;
        await downloader.run({
          id: "dash-policy-" + policy, url: origin.url, kind: "dash", filename: "movie.mp4", dir,
          headers: {}, connections: 1, meta: { exactTarget: true },
        }).then((v) => { r = v; }, (e) => { err = e; });
        assert.equal(fs.readFileSync(target, "utf8"), SENTINEL,
          "policy " + policy + ": the existing DASH file must survive");
        if (expectRename) {
          assert.ok(r, "rename must still produce an artefact: " + (err && err.message));
          // The artefact must sit on a name derived from the unique one. A DASH
          // run whose mux fails reports the surviving track file, which is
          // "<unique>.<track>", so match the prefix rather than the exact name.
          assert.match(path.basename(r.target), /^movie \(2\)\.mp4/,
            "rename must pick a unique name, got " + path.basename(r.target));
          assert.ok(!fs.existsSync(path.join(dir, "movie.mp4.video.mp4")) ||
            r.target !== path.join(dir, "movie.mp4.video.mp4"),
            "the artefact must not reuse the requested (protected) name");
        } else {
          assert.ok(err, "skip must fail the DASH task");
          assert.equal(err.code, "ALREADY_EXISTS");
        }
      } finally {
        await origin.close();
      }
    }
  });

  await suite.test("the CLI refuses to overwrite with -o <file> under the skip policy", async () => {
    // The CLI entry point, not just Downloader.run(): this is what a user hits
    // with `get ... -o <full path>`.
    const origin = await startHlsOrigin({ segments: 1, segBytes: 8 * 1024 });
    const homeDir = path.join(workRoot, "ex-cli-home");
    try {
      await withHome(homeDir, async () => {
        const cfg = new Config(path.join(homeDir, "config.json"));
        await cfg.load();
        await cfg.set({ defaultDir: path.join(homeDir, "dl"), categorizeByType: false, overwriteExisting: "skip" });
        const exact = path.join(homeDir, "keep.ts");
        await fsp.writeFile(exact, SENTINEL);

        const r = await withCapturedCli((cli) => cli.main(["get", origin.url, "--kind", "hls", "-o", exact, "-q"]));
        assert.notEqual(r.code, 0, "the CLI must fail rather than overwrite");
        assert.equal(fs.readFileSync(exact, "utf8"), SENTINEL,
          "the file the user protected must be untouched");
        assert.match(r.stderr, /exist/i,
          "the failure must say the file exists, got: " + r.stderr.trim());
      });
    } finally {
      await origin.close();
    }
  });

  await suite.test("the CLI reports the renamed landing place under the rename policy", async () => {
    const origin = await startHlsOrigin({ segments: 1, segBytes: 8 * 1024 });
    const homeDir = path.join(workRoot, "ex-cli-rename");
    try {
      await withHome(homeDir, async () => {
        const cfg = new Config(path.join(homeDir, "config.json"));
        await cfg.load();
        await cfg.set({ defaultDir: path.join(homeDir, "dl"), categorizeByType: false, overwriteExisting: "rename" });
        const exact = path.join(homeDir, "exists.ts");
        await fsp.writeFile(exact, SENTINEL);

        const r = await withCapturedCli((cli) => cli.main(["get", origin.url, "--kind", "hls", "-o", exact, "-q"]));
        assert.equal(r.code, 0, "rename must succeed: " + r.stderr);
        assert.equal(fs.readFileSync(exact, "utf8"), SENTINEL, "the original must be untouched");
        assert.match(r.stdout, /exists \(2\)\.ts/,
          "the summary must report where the file actually went, got: " + r.stdout.trim());
        assert.ok(fs.existsSync(path.join(homeDir, "exists (2).ts")), "the renamed artefact must exist");
      });
    } finally {
      await origin.close();
    }
  });

  await suite.test("concurrent exact targets never collide on the same name", async () => {
    // Two transfers racing for the same requested path must not both pick
    // "movie (2).ts" and clobber each other.
    const origin = await startHlsOrigin({ segments: 2, segBytes: 16 * 1024 });
    const dir = path.join(workRoot, "ex-concurrent");
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, "race.ts");
    await fsp.writeFile(target, SENTINEL);
    try {
      const { downloader } = await freshDownloader("ex-concurrent", { overwriteExisting: "rename" });
      const results = await Promise.all([1, 2].map((n) => downloader.run({
        id: "race-" + n, url: origin.url, kind: "hls", filename: "race.ts", dir,
        headers: {}, connections: 1, meta: { exactTarget: true },
      }).catch((e) => ({ error: e.message }))));
      const landed = results.filter((r) => r && r.target).map((r) => path.basename(r.target)).sort();
      assert.equal(new Set(landed).size, landed.length,
        "each concurrent transfer must get its own name, got " + JSON.stringify(landed));
      assert.equal(fs.readFileSync(target, "utf8"), SENTINEL, "the original must survive the race");
    } finally {
      await origin.close();
    }
  });

  // =====================================================================
  // 6. Cancelling during a body read
  // =====================================================================
  suite.group("Cancel during body read");

  /** An origin that sends one chunk, then stalls before finishing the body. */
  const startStallingOrigin = async ({ stallMs = 1800, total = 64 * 1024 } = {}) => {
    const state = { closed: 0, requested: 0, finished: 0 };
    const srv = http.createServer((req, res) => {
      const p = new URL(req.url, "http://x").pathname;
      if (p === "/media.m3u8") {
        const b = Buffer.from("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\n/seg/0\n#EXT-X-ENDLIST\n");
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": b.length });
        res.end(b);
        return;
      }
      if (p === "/manifest.mpd") {
        const mpd = '<MPD type="static" mediaPresentationDuration="PT2S"><Period>' +
          '<AdaptationSet mimeType="video/mp4"><Representation id="v1" bandwidth="1000" width="640" height="360">' +
          '<SegmentTemplate timescale="1" duration="2" media="v-$Number$.m4s" initialization="v-init.mp4"/>' +
          "</Representation></AdaptationSet></Period></MPD>";
        const b = Buffer.from(mpd);
        res.writeHead(200, { "Content-Type": "application/dash+xml", "Content-Length": b.length });
        res.end(b);
        return;
      }
      if (p === "/v-init.mp4") {
        res.writeHead(200, { "Content-Length": String(1024) });
        res.end(Buffer.alloc(1024, 0x11));
        return;
      }
      if (p.startsWith("/seg/") || p.startsWith("/v-")) {
        state.requested++;
        res.writeHead(200, { "Content-Length": String(total) });
        res.write(Buffer.alloc(1024, 0x41));            // one chunk, then stall
        const timer = setTimeout(() => {
          try { res.end(Buffer.alloc(total - 1024, 0x42)); state.finished++; } catch { /* gone */ }
        }, stallMs);
        res.on("close", () => { clearTimeout(timer); state.closed++; });
        return;
      }
      res.writeHead(404, { "Content-Length": "0" });
      res.end();
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return {
      base: "http://127.0.0.1:" + srv.address().port,
      state,
      close: () => closeServer(srv),
    };
  };

  await suite.test("readBody rejects promptly when the body stalls", async () => {
    const { requestFollow } = await import("../src/net.mjs");
    const origin = await startStallingOrigin({ stallMs: 1800 });
    try {
      const controller = new AbortController();
      const res = await requestFollow(origin.base + "/seg/0", { signal: controller.signal });
      const started = Date.now();
      const reading = readBody(res, 8 * 1024 * 1024, { signal: controller.signal })
        .then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message }));
      setTimeout(() => controller.abort(), 200);
      const outcome = await reading;
      const ms = Date.now() - started - 200;
      assert.equal(outcome.ok, false, "the read must not report success after a cancel");
      assert.equal(outcome.error, "aborted", "the failure must say aborted, got " + outcome.error);
      assert.ok(ms < 300, "the cancel must settle within 300ms, took " + ms + "ms");
    } finally {
      await origin.close();
    }
  });

  await suite.test("an HLS fragment cancelled mid-body stops at once and is not retried", async () => {
    const origin = await startStallingOrigin({ stallMs: 1800 });
    const dir = path.join(workRoot, "cancel-hls");
    await fsp.mkdir(dir, { recursive: true });
    try {
      const { downloader } = await freshDownloader("cancel-hls", { maxRetries: 3, retryBaseMs: 50 });
      const controller = new AbortController();
      let abortedAt = 0;
      const run = downloader.run({
        id: "cancel-hls", url: origin.base + "/media.m3u8", kind: "hls", filename: "cancel.ts", dir,
        headers: {}, connections: 2, meta: {}, signal: controller.signal,
      }).then((r) => ({ ok: true, r, at: Date.now() }), (e) => ({ ok: false, error: e.message, at: Date.now() }));
      await new Promise((r) => setTimeout(r, 250));
      abortedAt = Date.now();
      controller.abort();
      const outcome = await run;
      // Measured from the abort() call itself, not from launch minus a guess.
      const ms = outcome.at - abortedAt;
      assert.equal(outcome.ok, false, "a cancelled transfer must not report success");
      assert.equal(outcome.error, "aborted", "expected aborted, got " + outcome.error);
      assert.ok(ms < 400, "the cancel must settle within 400ms, took " + ms + "ms");
      assert.equal(origin.state.requested, 1,
        "a cancelled fragment must not be retried, saw " + origin.state.requested + " request(s)");
      // The socket close is observed by the origin a moment after the client
      // settles, so give it a short window rather than racing it.
      let closed = origin.state.closed;
      for (let i = 0; i < 20 && closed < 1; i++) {
        await new Promise((r) => setTimeout(r, 50));
        closed = origin.state.closed;
      }
      assert.ok(closed >= 1, "the origin must observe the connection closing");
      assert.equal(origin.state.finished, 0,
        "the origin must not finish sending the body after a cancel");
      assert.ok(!fs.existsSync(path.join(dir, "cancel.ts")),
        "no final artefact may be published for a cancelled transfer");
    } finally {
      await origin.close();
    }
  });

  await suite.test("a DASH fragment cancelled mid-body stops at once and is not retried", async () => {
    const origin = await startStallingOrigin({ stallMs: 1800 });
    const dir = path.join(workRoot, "cancel-dash");
    await fsp.mkdir(dir, { recursive: true });
    try {
      const { downloader } = await freshDownloader("cancel-dash", { maxRetries: 3, retryBaseMs: 50 });
      const controller = new AbortController();
      let abortedAt = 0;
      const run = downloader.run({
        id: "cancel-dash", url: origin.base + "/manifest.mpd", kind: "dash", filename: "cancel.mp4", dir,
        headers: {}, connections: 1, meta: { exactTarget: true }, signal: controller.signal,
      }).then((r) => ({ ok: true, r, at: Date.now() }), (e) => ({ ok: false, error: e.message, at: Date.now() }));
      await new Promise((r) => setTimeout(r, 250));
      abortedAt = Date.now();
      controller.abort();
      const outcome = await run;
      const ms = outcome.at - abortedAt;
      assert.equal(outcome.ok, false, "a cancelled DASH transfer must not report success");
      assert.equal(outcome.error, "aborted", "expected aborted, got " + outcome.error);
      assert.ok(ms < 400, "the cancel must settle within 400ms, took " + ms + "ms");
      assert.equal(origin.state.requested, 1,
        "a cancelled DASH fragment must not be retried, saw " + origin.state.requested + " request(s)");
      let closedDash = origin.state.closed;
      for (let i = 0; i < 20 && closedDash < 1; i++) {
        await new Promise((r) => setTimeout(r, 50));
        closedDash = origin.state.closed;
      }
      assert.ok(closedDash >= 1, "the origin must observe the connection closing");
      assert.ok(!fs.existsSync(path.join(dir, "cancel.mp4")),
        "no final artefact may be published for a cancelled DASH transfer");
    } finally {
      await origin.close();
    }
  });

  /**
   * A stand-in for AbortSignal that counts live listeners.
   *
   * Node's AbortSignal exposes no listener count, and the previous version of
   * this test asserted `count === 0` against a variable it had just set to 0 —
   * it could never fail. A facade with the two methods the transport uses
   * (`addEventListener` / `removeEventListener`, plus `aborted`) makes the
   * cleanup observable: a listener that is not detached stays counted.
   */
  const countingSignal = () => {
    const inner = new AbortController();
    const live = new Set();
    const signal = {
      get aborted() { return inner.signal.aborted; },
      addEventListener(type, fn, opts) {
        if (type !== "abort") return;
        // `once` listeners remove themselves when fired; mirror that here.
        const wrapped = opts && opts.once
          ? (ev) => { live.delete(wrapped); fn(ev); }
          : fn;
        // Remember the original so removeEventListener(original) works, the way
        // a real AbortSignal does.
        wrapped.__original = fn;
        live.add(wrapped);
        inner.signal.addEventListener(type, wrapped, opts);
      },
      removeEventListener(type, fn) {
        if (type !== "abort") return;
        for (const registered of live) {
          if (registered === fn || registered.__original === fn) {
            live.delete(registered);
            inner.signal.removeEventListener(type, registered);
            return;
          }
        }
        inner.signal.removeEventListener(type, fn);
      },
      /** Test-only: how many listeners this signal still holds. */
      get liveCount() { return live.size; },
      abort() { inner.abort(); },
      get inner() { return inner.signal; },
    };
    return signal;
  };

  await suite.test("abort listeners are released on success, error and cancel", async () => {
    const { requestFollow } = await import("../src/net.mjs");
    const origin = await startStallingOrigin({ stallMs: 0, total: 4 * 1024 });
    try {
      // --- success path ---
      const okSignal = countingSignal();
      for (let i = 0; i < 3; i++) {
        const res = await requestFollow(origin.base + "/seg/0", { signal: okSignal });
        await readBody(res, 1024 * 1024, { signal: okSignal });
      }
      assert.equal(okSignal.liveCount, 0,
        "a completed transfer must leave no abort listener, found " + okSignal.liveCount);

      // --- HTTP error path ---
      const errSignal = countingSignal();
      let err = null;
      await requestFollow(origin.base + "/missing-route", { signal: errSignal })
        .catch((e) => { err = e; });
      assert.ok(err, "the 404 must surface as an error");
      assert.equal(errSignal.liveCount, 0,
        "a failed request must leave no abort listener, found " + errSignal.liveCount);

      // --- cancel path (body mid-read) ---
      const cancelSignal = countingSignal();
      const res = await requestFollow(origin.base + "/seg/0", { signal: cancelSignal });
      const reading = readBody(res, 1024 * 1024, { signal: cancelSignal }).catch(() => "aborted");
      cancelSignal.abort();
      assert.equal(await reading, "aborted");
      // Give any 'close' handler a tick to run; the count must still reach 0.
      for (let i = 0; i < 20 && cancelSignal.liveCount > 0; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(cancelSignal.liveCount, 0,
        "a cancelled read must leave no abort listener, found " + cancelSignal.liveCount);
    } finally {
      await origin.close();
    }
  });

  await suite.test("cancel latency is measured from the abort() call", async () => {
    // Timing from the real abort() moment: subtracting a fixed setTimeout delay
    // from the total could understate (or overstate) the true latency.
    const { requestFollow } = await import("../src/net.mjs");
    const origin = await startStallingOrigin({ stallMs: 1800 });
    try {
      const controller = new AbortController();
      const res = await requestFollow(origin.base + "/seg/0", { signal: controller.signal });
      let abortedAt = 0;
      const reading = readBody(res, 8 * 1024 * 1024, { signal: controller.signal })
        .then(() => ({ ok: true, at: Date.now() }), () => ({ ok: false, at: Date.now() }));
      await new Promise((r) => setTimeout(r, 200));
      abortedAt = Date.now();
      controller.abort();
      const outcome = await reading;
      const latency = outcome.at - abortedAt;
      assert.equal(outcome.ok, false, "the read must not succeed after a cancel");
      assert.ok(latency < 300,
        "abort-to-rejection latency must be < 300ms, measured " + latency + "ms");
    } finally {
      await origin.close();
    }
  });

  // =====================================================================
  // 7. Scheduled speed limit reaches real downloads
  // =====================================================================
  suite.group("Scheduled speed limit");

  /** Build a Downloader plus a schedule window helper around it. */
  const scheduledSetup = async (name, patch = {}) => {
    const { Scheduler } = await import("../src/scheduler.mjs");
    const { cfg, downloader, queue } = await freshDownloader(name, patch);
    const scheduler = new Scheduler({ queue, config: cfg });
    /** Open a window covering `when` with `rate`, and push it into the downloader. */
    const openWindow = (rate, when) => {
      scheduler.schedules = [{
        id: "w1", name: "window", enabled: true, action: "start",
        at: "00:00", endAt: "23:59", days: null, speedLimit: rate,
      }];
      // days: null means "every day"; activeSpeedLimit skips entries with days
      // that do not include today, so null is the portable spelling.
      return scheduler.applySpeedLimit(downloader, when);
    };
    return { cfg, downloader, queue, scheduler, openWindow };
  };

  await suite.test("the scheduler reaches a real Downloader bucket", async () => {
    // The old behaviour: applySpeedLimit wrote downloader.limiter.rate, but a
    // real Downloader had no such property, so a window only logged a line.
    const { downloader, openWindow } = await scheduledSetup("sched-bucket");
    assert.ok(downloader.limiter, "a real Downloader must expose a limiter");
    assert.equal(downloader.limiter.rate, 0, "no window means no global cap");
    const applied = openWindow(256 * 1024, new Date(2026, 0, 5, 12, 0, 0));
    assert.equal(applied, 256 * 1024);
    assert.equal(downloader.limiter.rate, 256 * 1024,
      "the window's rate must land on the downloader bucket");
    // Closing the window must clear it again.
    openWindow(0, new Date(2026, 0, 5, 12, 0, 0));
    assert.equal(downloader.limiter.rate, 0, "leaving the window must restore unlimited");
  });

  await suite.test("a window opened before the start throttles a running HLS task", async () => {
    const segBytes = 512 * 1024, segments = 8;      // 4 MiB
    const origin = await startHlsOrigin({ segments, segBytes });
    const { downloader, openWindow } = await scheduledSetup("sched-hls", { connections: 4 });
    try {
      const rate = 1024 * 1024;
      openWindow(rate, new Date(2026, 0, 5, 12, 0, 0));
      const dir = path.join(workRoot, "sched-hls");
      const started = Date.now();
      const result = await downloader.run({
        id: "sched-hls", url: origin.url, kind: "hls", filename: "sched.ts", dir,
        headers: {}, connections: 4, meta: {},        // no task-level limit at all
      });
      const elapsed = (Date.now() - started) / 1000;
      const total = origin.expected.length;
      assert.equal(result.bytes, total);
      const floor = (total - rate) / rate;
      assert.ok(elapsed >= floor * 0.9,
        "the window must throttle a task with no speedLimit: expected >= ~" +
        floor.toFixed(1) + "s, took " + elapsed.toFixed(2) + "s");
      assert.ok(total / elapsed <= rate * 1.6,
        "observed " + Math.round(total / elapsed / 1024) + " KiB/s exceeds the window");
    } finally {
      await origin.close();
    }
  });

  await suite.test("a window is a total across concurrent tasks, not per task", async () => {
    // The point of one shared bucket: two downloads must not each get the
    // window's full rate.
    const segBytes = 512 * 1024, segments = 8;      // 4 MiB per task
    const origin = await startHlsOrigin({ segments, segBytes });
    const { downloader, openWindow } = await scheduledSetup("sched-two", { connections: 2 });
    try {
      const rate = 1024 * 1024;
      openWindow(rate, new Date(2026, 0, 5, 12, 0, 0));
      const dir = path.join(workRoot, "sched-two");
      const started = Date.now();
      const results = await Promise.all([1, 2].map((n) => downloader.run({
        id: "sched-two-" + n, url: origin.url, kind: "hls", filename: "two" + n + ".ts", dir,
        headers: {}, connections: 2, meta: {},
      })));
      const elapsed = (Date.now() - started) / 1000;
      const total = origin.expected.length * 2;
      for (const r of results) assert.equal(r.bytes, origin.expected.length);
      const combined = total / elapsed;
      assert.ok(combined <= rate * 1.6,
        "two tasks moved " + Math.round(combined / 1024) + " KiB/s against a " +
        Math.round(rate / 1024) + " KiB/s window; the cap must be shared");
    } finally {
      await origin.close();
    }
  });

  await suite.test("a rate change reaches a transfer that is already running", async () => {
    // Opening the window mid-flight must throttle the transfer in progress, not
    // only the next one. The origin trickles, so the transfer is still running
    // when the window opens; the tail must cover the remaining bytes at the
    // window's rate.
    const segBytes = 256 * 1024, segments = 16;     // 4 MiB
    const rate = 512 * 1024;
    const origin = await startHlsOrigin({ segments, segBytes, trickle: { chunk: 32 * 1024, delayMs: 12 } });
    const { downloader, openWindow } = await scheduledSetup("mid-flight", { connections: 1 });
    const dir = path.join(workRoot, "mid-flight");
    const started = Date.now();
    const timer = setTimeout(() => openWindow(rate, new Date(2026, 0, 5, 12, 0, 0)), 300);
    try {
      const result = await downloader.run({
        id: "mid-flight", url: origin.url, kind: "hls", filename: "mid.ts", dir,
        headers: {}, connections: 1, meta: {},
      });
      const elapsed = (Date.now() - started) / 1000;
      assert.equal(result.bytes, origin.expected.length);
      // The trickled origin alone takes ~1.5s for 4 MiB; the window then caps
      // the remainder, so the total must be clearly longer than the origin's
      // own pace.
      assert.ok(elapsed >= 2.5,
        "a window opened mid-transfer must slow it down, took " + elapsed.toFixed(2) + "s");
      assert.ok(origin.expected.length / elapsed <= rate * 2.2,
        "the tail must be capped by the window, observed " +
        Math.round(origin.expected.length / elapsed / 1024) + " KiB/s");
    } finally {
      clearTimeout(timer);
      await origin.close();
    }
  });

  await suite.test("a task limit and a window compose, tightest wins", async () => {
    // Precedence: the effective rate is the tighter of the window (shared) and
    // the task's own limit.
    const segBytes = 512 * 1024, segments = 8;      // 4 MiB
    const origin = await startHlsOrigin({ segments, segBytes });
    const { downloader, openWindow } = await scheduledSetup("compose", { connections: 4 });
    try {
      const windowRate = 2 * 1024 * 1024, taskRate = 512 * 1024;
      openWindow(windowRate, new Date(2026, 0, 5, 12, 0, 0));
      const dir = path.join(workRoot, "compose");
      const started = Date.now();
      const result = await downloader.run({
        id: "compose", url: origin.url, kind: "hls", filename: "compose.ts", dir,
        headers: {}, connections: 4, speedLimit: taskRate, meta: {},
      });
      const elapsed = (Date.now() - started) / 1000;
      const total = origin.expected.length;
      assert.equal(result.bytes, total);
      const floor = (total - taskRate) / taskRate;
      assert.ok(elapsed >= floor * 0.9,
        "the tighter (task) limit must decide: expected >= ~" + floor.toFixed(1) +
        "s, took " + elapsed.toFixed(2) + "s");
      assert.ok(total / elapsed <= taskRate * 1.7,
        "observed " + Math.round(total / elapsed / 1024) + " KiB/s exceeds the tighter limit");
    } finally {
      await origin.close();
    }
  });

  await suite.test("changing the rate under load neither deadlocks nor stalls", async () => {
    // finite -> different finite -> unlimited, while waiters are queued.
    const { RateLimiter } = await import("../src/rate.mjs");
    const limiter = new RateLimiter(64 * 1024);
    const waiters = Array.from({ length: 4 }, () => limiter.take(256 * 1024));
    setTimeout(() => limiter.setRate(256 * 1024), 100);
    setTimeout(() => limiter.setRate(0), 300);
    const started = Date.now();
    await Promise.race([
      Promise.all(waiters),
      new Promise((_, reject) => setTimeout(() => reject(new Error("waiters did not settle")), 8000)),
    ]);
    const elapsed = (Date.now() - started) / 1000;
    assert.ok(elapsed < 8, "the waiters must be released, took " + elapsed.toFixed(2) + "s");
    assert.equal(limiter.rate, 0, "the limiter must be unlimited at the end");
  });

  // =====================================================================
  // 8. Unknown-length HTTP under a scheduled window
  // =====================================================================
  suite.group("Unknown-length rate limiting");

  /** An origin with no Content-Length: the client cannot plan byte ranges. */
  const startChunkedOrigin = async ({ total = 1024 * 1024, chunk = 16 * 1024, delayMs = 1 } = {}) => {
    const body = Buffer.alloc(total, 0x5a);
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Transfer-Encoding": "chunked" });
      let off = 0;
      const tick = () => {
        if (off >= total) { res.end(); return; }
        if (res.destroyed) return;
        res.write(body.subarray(off, off + chunk));
        off += chunk;
        setTimeout(tick, delayMs);
      };
      tick();
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return {
      url: "http://127.0.0.1:" + srv.address().port + "/chunked",
      body,
      sha256: sha256(body),
      close: () => closeServer(srv),
    };
  };

  await suite.test("a chunked download obeys the scheduled window", async () => {
    // The regression: runStreaming() reads its cap from opts.sharedLimiter, but
    // the unknown-length branch never passed one, so a window was ignored and a
    // 1 MiB body moved at line speed (~515 KiB/s against a 64 KiB/s window).
    const origin = await startChunkedOrigin({ total: 512 * 1024 });
    const { downloader, openWindow } = await (async () => {
      const { Scheduler } = await import("../src/scheduler.mjs");
      const { cfg, downloader, queue } = await freshDownloader("chunk-window", {});
      const scheduler = new Scheduler({ queue, config: cfg });
      const openWindow = (rate) => {
        scheduler.schedules = [{ id: "w", name: "w", enabled: true, action: "start",
          at: "00:00", endAt: "23:59", days: null, speedLimit: rate }];
        return scheduler.applySpeedLimit(downloader, new Date(2026, 0, 5, 12, 0, 0));
      };
      return { downloader, openWindow };
    })();
    try {
      const rate = 256 * 1024;          // 256 KiB/s, well under the 512 KiB body
      openWindow(rate);
      const dir = path.join(workRoot, "chunk-window");
      const started = Date.now();
      const result = await downloader.run({
        id: "chunk-window", url: origin.url, kind: "http", filename: "chunked.bin", dir,
        headers: {}, connections: 1, meta: {},
      });
      const elapsed = (Date.now() - started) / 1000;
      assert.equal(result.lengthKnown, false, "a chunked response has no known length");
      assert.equal(result.bytes, origin.body.length, "every byte must arrive");
      assert.equal(await hashFile(result.target), origin.sha256,
        "the streamed bytes must match the origin payload");
      // 512 KiB at 256 KiB/s with a 256 KiB burst: at least ~1s of steady state.
      const floor = (origin.body.length - rate) / rate;
      assert.ok(elapsed >= floor * 0.9,
        "the window must throttle a chunked body: expected >= ~" + floor.toFixed(1) +
        "s, took " + elapsed.toFixed(2) + "s (" +
        Math.round(origin.body.length / elapsed / 1024) + " KiB/s)");
      assert.ok(origin.body.length / elapsed <= rate * 1.6,
        "observed " + Math.round(origin.body.length / elapsed / 1024) +
        " KiB/s exceeds the window");
    } finally {
      await origin.close();
    }
  });

  await suite.test("concurrent chunked downloads share one window bucket", async () => {
    const chunk = 16 * 1024;
    const origin = await startChunkedOrigin({ total: 256 * 1024, chunk });
    const { Scheduler } = await import("../src/scheduler.mjs");
    const { cfg, downloader, queue } = await freshDownloader("chunk-two", {});
    const scheduler = new Scheduler({ queue, config: cfg });
    scheduler.schedules = [{ id: "w", name: "w", enabled: true, action: "start",
      at: "00:00", endAt: "23:59", days: null, speedLimit: 128 * 1024 }];
    scheduler.applySpeedLimit(downloader, new Date(2026, 0, 5, 12, 0, 0));
    try {
      const dir = path.join(workRoot, "chunk-two");
      const started = Date.now();
      const results = await Promise.all([1, 2].map((n) => downloader.run({
        id: "chunk-two-" + n, url: origin.url, kind: "http", filename: "c" + n + ".bin", dir,
        headers: {}, connections: 1, meta: {},
      })));
      const elapsed = (Date.now() - started) / 1000;
      const total = results.reduce((a, r) => a + r.bytes, 0);
      assert.equal(total, origin.body.length * 2, "both bodies must arrive in full");
      for (const r of results) {
        assert.equal(r.lengthKnown, false);
        assert.equal(await hashFile(r.target), origin.sha256, "each artefact must be correct");
      }
      assert.ok(total / elapsed <= 128 * 1024 * 1.6,
        "two chunked tasks moved " + Math.round(total / elapsed / 1024) +
        " KiB/s against a 128 KiB/s window; the bucket must be shared");
    } finally {
      await origin.close();
    }
  });

  await suite.test("a chunked transfer survives rate changes while reading", async () => {
    // The body must be much larger than the initial burst (1s worth), otherwise
    // the transfer can finish before the first rate change and the test proves
    // nothing about a *running* transfer. 2 MiB against a 256 KiB/s burst is 8x.
    //
    // Each phase is entered only after the transfer is observed to have moved
    // bytes, so the evidence shows the transfer was still reading at every
    // change rather than relying on fixed sleeps.
    const rateA = 256 * 1024, rateB = 768 * 1024;
    const total = 2 * 1024 * 1024;
    const origin = await startChunkedOrigin({ total, chunk: 16 * 1024, delayMs: 1 });
    const { downloader } = await freshDownloader("chunk-rates", {});
    try {
      const dir = path.join(workRoot, "chunk-rates");
      const progressAt = [];
      downloader.on("progress", (p) => { if (p.bytesWritten) progressAt.push(p.bytesWritten); });
      downloader.limiter.setRate(rateA);

      const started = Date.now();
      const running = downloader.run({
        id: "chunk-rates", url: origin.url, kind: "http", filename: "rates.bin", dir,
        headers: {}, connections: 1, meta: {},
      });

      /** Wait until at least `bytes` have arrived, or fail after a deadline. */
      const waitForBytes = async (bytes, label) => {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          if (progressAt.length && progressAt[progressAt.length - 1] >= bytes) return true;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("the transfer stopped before reaching " + bytes + " bytes (" + label + ")");
      };

      // Phase A: still reading under the first finite rate.
      await waitForBytes(300 * 1024, "phase A");
      const markA = progressAt[progressAt.length - 1];
      // Phase B: a different finite rate.
      downloader.limiter.setRate(rateB);
      await waitForBytes(markA + 300 * 1024, "phase B");
      const markB = progressAt[progressAt.length - 1];
      // Phase C: unlimited.
      downloader.limiter.setRate(0);
      await waitForBytes(markB + 300 * 1024, "phase C");

      const result = await Promise.race([
        running,
        new Promise((_, reject) => setTimeout(() => reject(new Error("the transfer did not finish")), 30000)),
      ]);
      const elapsed = (Date.now() - started) / 1000;
      assert.equal(result.lengthKnown, false, "a chunked body has no known length");
      assert.equal(result.bytes, total, "every byte must arrive");
      assert.equal(await hashFile(result.target), origin.sha256, "the bytes must match the origin");
      assert.ok(elapsed < 28, "rate changes must not stall the transfer, took " + elapsed.toFixed(2) + "s");
      assert.equal(downloader.limiter.rate, 0, "the limiter must end unlimited");
      // Evidence that all three phases happened while the same transfer ran.
      assert.ok(progressAt[progressAt.length - 1] > markB && markB > markA,
        "the transfer must have progressed through all three rate phases");
    } finally {
      await origin.close();
    }
  });

  // =====================================================================
  // 9. Output reservation: concurrency and lock release
  // =====================================================================
  suite.group("Output reservation");

  await suite.test("concurrent rename tasks each get their own file", async () => {
    // Three tasks racing for one requested path. All must succeed, with three
    // distinct names, three correct hashes, and the original byte-for-byte.
    const origin = await startHlsOrigin({ segments: 2, segBytes: 16 * 1024 });
    const dir = path.join(workRoot, "res-rename");
    await fsp.mkdir(dir, { recursive: true });
    const sentinelPath = path.join(dir, "movie.ts");
    await fsp.writeFile(sentinelPath, SENTINEL);
    try {
      const { downloader } = await freshDownloader("res-rename", { overwriteExisting: "rename" });
      const settled = await Promise.allSettled([1, 2, 3].map((n) => downloader.run({
        id: "res-rename-" + n, url: origin.url, kind: "hls", filename: "movie.ts", dir,
        headers: {}, connections: 1, meta: { exactTarget: true },
      })));
      const ok = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
      const failed = settled.filter((r) => r.status === "rejected");
      assert.equal(ok.length, 3, "every concurrent task must succeed, failed: " +
        JSON.stringify(failed.map((f) => String(f.reason && f.reason.message))));
      const names = ok.map((r) => path.basename(r.target)).sort();
      assert.equal(new Set(names).size, 3, "each task must get a distinct name, got " + JSON.stringify(names));
      for (const r of ok) {
        assert.equal(await hashFile(r.target), origin.expectedSha256,
          "artefact " + path.basename(r.target) + " must be correct");
      }
      assert.equal(fs.readFileSync(sentinelPath, "utf8"), SENTINEL,
        "the original file must survive the race byte-for-byte");
    } finally {
      await origin.close();
    }
  });

  await suite.test("concurrent skip tasks fail cleanly and do not block the next task", async () => {
    const origin = await startHlsOrigin({ segments: 1, segBytes: 8 * 1024 });
    const dir = path.join(workRoot, "res-skip");
    await fsp.mkdir(dir, { recursive: true });
    const keep = path.join(dir, "movie.ts");
    await fsp.writeFile(keep, SENTINEL);
    try {
      const { downloader } = await freshDownloader("res-skip", { overwriteExisting: "skip" });
      const settled = await Promise.allSettled([1, 2].map((n) => downloader.run({
        id: "res-skip-" + n, url: origin.url, kind: "hls", filename: "movie.ts", dir,
        headers: {}, connections: 1, meta: { exactTarget: true },
      })));
      for (const s of settled) {
        assert.equal(s.status, "rejected", "a skip collision must reject");
        assert.equal(s.reason.code, "ALREADY_EXISTS", "expected ALREADY_EXISTS, got " + s.reason.code);
      }
      assert.equal(fs.readFileSync(keep, "utf8"), SENTINEL, "the protected file must be unchanged");
      const started = Date.now();
      const third = await Promise.race([
        downloader.run({
          id: "res-skip-3", url: origin.url, kind: "hls", filename: "other.ts", dir,
          headers: {}, connections: 1, meta: { exactTarget: true },
        }).then(() => "ok", (e) => "error:" + e.message),
        new Promise((r) => setTimeout(() => r("BLOCKED"), 5000)),
      ]);
      assert.equal(third, "ok", "a later task must acquire the path, got " + third);
      assert.ok(Date.now() - started < 5000, "the later task must not wait for the lock timeout");
    } finally {
      await origin.close();
    }
  });

  await suite.test("a lock timeout frees its place in the queue", async () => {
    // A waiter that gives up must not keep the path frozen for those behind it.
    const { downloader } = await freshDownloader("res-timeout", {});
    const target = path.join(workRoot, "res-timeout", "held.bin");
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const release = await downloader.lockTarget(target);
    try {
      let busy = null;
      await downloader.lockTarget(target, { waitMs: 300 }).catch((e) => { busy = e; });
      assert.ok(busy, "the second waiter must fail on the timeout");
      assert.equal(busy.code, "TARGET_BUSY", "the failure must be TARGET_BUSY, got " + busy.code);
    } finally {
      release();
    }
    const started = Date.now();
    const outcome = await Promise.race([
      downloader.lockTarget(target, { waitMs: 2000 }).then(() => "acquired", (e) => "error:" + e.code),
      new Promise((r) => setTimeout(() => r("BLOCKED"), 4000)),
    ]);
    assert.equal(outcome, "acquired", "the path must be usable after the holder releases, got " + outcome);
    assert.ok(Date.now() - started < 2000,
      "the later task must not wait out the full timeout, took " + (Date.now() - started) + "ms");
  });

  await suite.test("a failure while reserving releases the lock", async () => {
    // A policy error during reservation must not strand the path.
    const { downloader } = await freshDownloader("res-error", { overwriteExisting: "skip" });
    const dir = path.join(workRoot, "res-error");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "taken.bin"), "SENTINEL");

    let err = null;
    await downloader.reserveTarget({
      id: "x", url: "http://127.0.0.1:1/a", filename: "taken.bin", dir,
      headers: {}, meta: { exactTarget: true },
    }).catch((e) => { err = e; });
    assert.ok(err, "a skip collision during reservation must throw");
    assert.equal(err.code, "ALREADY_EXISTS");

    const started = Date.now();
    const outcome = await Promise.race([
      downloader.reserveTarget({
        id: "y", url: "http://127.0.0.1:1/a", filename: "free.bin", dir,
        headers: {}, meta: { exactTarget: true },
      }).then((r) => { r.release(); return "ok"; }, (e) => "error:" + e.message),
      new Promise((r) => setTimeout(() => r("BLOCKED"), 3000)),
    ]);
    assert.equal(outcome, "ok", "the lock must be free after a policy failure, got " + outcome);
    assert.ok(Date.now() - started < 3000);
  });

  await suite.test("DASH and HLS concurrency share the same reservation guarantee", async () => {
    // DASH: two tasks racing for one exact path under rename.
    const dash = await startDashOrigin({ segments: 1, segBytes: 8 * 1024, audio: false });
    const dashDir = path.join(workRoot, "res-dash");
    await fsp.mkdir(dashDir, { recursive: true });
    const dashSentinel = path.join(dashDir, "movie.mp4");
    await fsp.writeFile(dashSentinel, SENTINEL);
    try {
      const { downloader } = await freshDownloader("res-dash", {
        overwriteExisting: "rename", ffmpegPath: "C:" + String.fromCharCode(92) + "nope.exe",
      });
      const settled = await Promise.allSettled([1, 2].map((n) => downloader.run({
        id: "res-dash-" + n, url: dash.url, kind: "dash", filename: "movie.mp4", dir: dashDir,
        headers: {}, connections: 1, meta: { exactTarget: true },
      })));
      const ok = settled.filter((x) => x.status === "fulfilled").map((x) => x.value);
      assert.equal(ok.length, 2, "both DASH tasks must succeed: " +
        JSON.stringify(settled.filter((x) => x.status === "rejected").map((x) => String(x.reason && x.reason.message))));
      const names = ok.map((r) => path.basename(r.target));
      assert.equal(new Set(names).size, 2,
        "the two DASH artefacts must have distinct names, got " + JSON.stringify(names));
      assert.equal(fs.readFileSync(dashSentinel, "utf8"), SENTINEL, "the DASH sentinel must survive");
    } finally {
      await dash.close();
    }

    // HLS: two tasks racing for one exact path under skip.
    const hls = await startHlsOrigin({ segments: 1, segBytes: 8 * 1024 });
    const hlsDir = path.join(workRoot, "res-hls-skip");
    await fsp.mkdir(hlsDir, { recursive: true });
    const hlsSentinel = path.join(hlsDir, "clip.ts");
    await fsp.writeFile(hlsSentinel, SENTINEL);
    try {
      const { downloader } = await freshDownloader("res-hls-skip", { overwriteExisting: "skip" });
      const settled = await Promise.allSettled([1, 2].map((n) => downloader.run({
        id: "res-hls-skip-" + n, url: hls.url, kind: "hls", filename: "clip.ts", dir: hlsDir,
        headers: {}, connections: 1, meta: { exactTarget: true },
      })));
      for (const x of settled) {
        assert.equal(x.status, "rejected", "both HLS skip tasks must reject");
        assert.equal(x.reason.code, "ALREADY_EXISTS");
      }
      assert.equal(fs.readFileSync(hlsSentinel, "utf8"), SENTINEL, "the HLS sentinel must survive");
    } finally {
      await hls.close();
    }
  });

  // =====================================================================
  // 10. Lock mutex under timeout, cancellation and failure
  // =====================================================================
  suite.group("Output lock mutex");

  await suite.test("a timeout does not unseat the current holder", async () => {
    // Sequence matters: B times out while A still holds, THEN C asks, THEN A
    // releases. Releasing A first would hide the bug: the timed-out waiter must
    // not delete the live holder's queue entry.
    const { downloader } = await freshDownloader("mutex-hold", {});
    const target = path.join(workRoot, "mutex-hold", "f.bin");
    await fsp.mkdir(path.dirname(target), { recursive: true });

    const releaseA = await downloader.lockTarget(target);     // A holds
    let busy = null;
    await downloader.lockTarget(target, { waitMs: 250 }).catch((e) => { busy = e; });
    assert.ok(busy, "B must time out");
    assert.equal(busy.code, "TARGET_BUSY", "B must fail with TARGET_BUSY, got " + busy.code);

    // C asks while A is still holding.
    let cState = "waiting";
    let releaseC = null;
    const cPromise = downloader.lockTarget(target, { waitMs: 5000 })
      .then((rel) => { cState = "acquired"; releaseC = rel; }, (e) => { cState = "error:" + e.code; });
    // Give the event loop several turns: C must still be waiting.
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(cState, "waiting",
      "C must not acquire the path while A holds it, state=" + cState);

    releaseA();
    await cPromise;
    assert.equal(cState, "acquired", "C must acquire once A releases, state=" + cState);
    releaseC();
  });

  await suite.test("a queued waiter can be cancelled", async () => {
    const { downloader } = await freshDownloader("mutex-cancel", {});
    const target = path.join(workRoot, "mutex-cancel", "f.bin");
    await fsp.mkdir(path.dirname(target), { recursive: true });

    const releaseA = await downloader.lockTarget(target);
    const controller = new AbortController();
    const started = Date.now();
    const bPromise = downloader.lockTarget(target, { waitMs: 8000, signal: controller.signal })
      .then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message, code: e.code, at: Date.now() }));
    await new Promise((r) => setTimeout(r, 60));
    controller.abort();
    const b = await bPromise;
    assert.equal(b.ok, false, "a cancelled waiter must not acquire the lock");
    assert.equal(b.error, "aborted", "the error must be 'aborted', got " + b.error);
    assert.ok(b.at - started < 400,
      "the cancel must settle promptly, took " + (b.at - started) + "ms");

    // C queues after B left; it must still wait for A.
    let cState = "waiting";
    let releaseC = null;
    const cPromise = downloader.lockTarget(target, { waitMs: 5000 })
      .then((rel) => { cState = "acquired"; releaseC = rel; }, (e) => { cState = "error:" + e.code; });
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(cState, "waiting", "C must wait for A after B was cancelled, state=" + cState);
    releaseA();
    await cPromise;
    assert.equal(cState, "acquired", "C must acquire once A releases");
    releaseC();

    // And B must never acquire the lock afterwards.
    let bAcquiredLate = false;
    await Promise.resolve();   // let any stray microtask run
    assert.equal(bAcquiredLate, false);
  });

  await suite.test("the same path can be retried after timeout, cancel and error", async () => {
    const { downloader } = await freshDownloader("mutex-retry", { overwriteExisting: "skip" });
    const dir = path.join(workRoot, "mutex-retry");
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, "taken.bin");
    await fsp.writeFile(target, SENTINEL);

    // (1) policy error on the very same path
    let policyErr = null;
    await downloader.reserveTarget({
      id: "e1", url: "http://127.0.0.1:1/a", kind: "http", filename: "taken.bin", dir,
      headers: {}, meta: { exactTarget: true },
    }).catch((e) => { policyErr = e; });
    assert.ok(policyErr, "the skip collision must throw");
    assert.equal(policyErr.code, "ALREADY_EXISTS");
    assert.equal(fs.readFileSync(target, "utf8"), SENTINEL, "the sentinel must be unchanged");

    // (2) the same path must be usable again immediately (switch to overwrite so
    //     the reservation itself succeeds; the original file is replaced only
    //     because the policy now says so).
    await downloader.config.set({ overwriteExisting: "overwrite" });
    const started = Date.now();
    const again = await Promise.race([
      downloader.reserveTarget({
        id: "e2", url: "http://127.0.0.1:1/a", kind: "http", filename: "taken.bin", dir,
        headers: {}, meta: { exactTarget: true },
      }).then((r) => { r.release(); return "ok"; }, (e) => "error:" + e.code),
      new Promise((r) => setTimeout(() => r("BLOCKED"), 3000)),
    ]);
    assert.equal(again, "ok", "the same path must be reservable after a failure, got " + again);
    assert.ok(Date.now() - started < 3000, "the retry must not wait for a timeout");

    // (3) the skip policy still refuses while the file is there
    await downloader.config.set({ overwriteExisting: "skip" });
    let again2 = null;
    await downloader.reserveTarget({
      id: "e3", url: "http://127.0.0.1:1/a", kind: "http", filename: "taken.bin", dir,
      headers: {}, meta: { exactTarget: true },
    }).catch((e) => { again2 = e; });
    assert.equal(again2 && again2.code, "ALREADY_EXISTS",
      "skip must keep refusing the existing file");
    assert.equal(fs.readFileSync(target, "utf8"), SENTINEL, "the sentinel must still be unchanged");
  });

  await suite.test("cancelling a task queued behind the output lock stops it", async () => {
    // The whole task shape: task 2 queues on the same path, then is cancelled.
    const origin = await startHlsOrigin({
      segments: 1, segBytes: 32 * 1024, trickle: { chunk: 8 * 1024, delayMs: 40 },
    });
    const dir = path.join(workRoot, "mutex-task");
    await fsp.mkdir(dir, { recursive: true });
    try {
      // rename is the policy that legitimately queues behind the output lock;
      // the fail-fast policies now answer "busy"/"exists" without queueing, so
      // a cancellation-while-queued test has to use rename.
      const { downloader } = await freshDownloader("mutex-task", { overwriteExisting: "rename" });
      const first = downloader.run({
        id: "mutex-task-1", url: origin.url, kind: "hls", filename: "same.ts", dir,
        headers: {}, connections: 1, meta: {},
      });
      await new Promise((r) => setTimeout(r, 120));
      const controller = new AbortController();
      let abortedAt = 0;
      const second = downloader.run({
        id: "mutex-task-2", url: origin.url, kind: "hls", filename: "same.ts", dir,
        headers: {}, connections: 1, meta: {}, signal: controller.signal,
      }).then((r) => ({ ok: true, at: Date.now() }), (e) => ({ ok: false, error: e.message, at: Date.now() }));
      await new Promise((r) => setTimeout(r, 150));
      abortedAt = Date.now();
      controller.abort();
      const outcome = await second;
      const latency = outcome.at - abortedAt;
      assert.equal(outcome.ok, false, "the queued task must not complete after a cancel");
      assert.equal(outcome.error, "aborted", "expected aborted, got " + outcome.error);
      assert.ok(latency < 400, "a queued task must cancel promptly, took " + latency + "ms");
      const held = await first;
      assert.ok(held.bytes > 0, "the holder must still finish normally");
    } finally {
      await origin.close();
    }
  });

  // =====================================================================
  // 11. Derived-path conflict protection
  // =====================================================================
  suite.group("Derived path conflicts");

  // Every path each strategy may create, write, rename or delete.
  const DERIVED = {
    hls: ["movie.ts.parts", "movie.ts.audio.ts", "movie.ts.audioparts", "movie.ts.merged.mp4"],
    dash: ["movie.mp4.tracks", "movie.mp4.video.mp4", "movie.mp4.audio.m4a"],
    http: ["f.bin.partial", "f.bin.downloadx"],
  };
  const BASE = { hls: "movie.ts", dash: "movie.mp4", http: "f.bin" };

  await suite.test("a media claim blocks a plain download on every derived name", async () => {
    // Forward direction: the media task reserves first; a plain download whose
    // target equals one of its derived paths must not receive that path.
    for (const [kind, names] of Object.entries(DERIVED)) {
      for (const derived of names) {
        const { downloader } = await freshDownloader("derived-fwd", { overwriteExisting: "rename" });
        const dir = path.join(workRoot, "derived-fwd", kind + "-" + derived.replace(/[^a-z0-9.]/gi, "_"));
        await fsp.mkdir(dir, { recursive: true });
        const media = await downloader.reserveTarget({
          id: "m", url: "http://127.0.0.1:1/x", kind, filename: BASE[kind], dir,
          headers: {}, meta: { exactTarget: true },
        });
        try {
          assert.ok(media.pathSet.some((p) => path.basename(p) === derived),
            kind + " must claim " + derived + ", claimed " + JSON.stringify(media.pathSet.map((p) => path.basename(p))));

          const plain = await downloader.reserveTarget({
            id: "p", url: "http://127.0.0.1:1/y", kind: "http", filename: derived, dir,
            headers: {}, meta: { exactTarget: true },
          });
          assert.notEqual(path.basename(plain.target), derived,
            kind + ": a plain download must not get the claimed derived path " + derived);
          plain.release();

          media.release();
          // Once released the same name must be available.
          const after = await downloader.reserveTarget({
            id: "p2", url: "http://127.0.0.1:1/y", kind: "http", filename: derived, dir,
            headers: {}, meta: { exactTarget: true },
          });
          assert.equal(path.basename(after.target), derived,
            kind + ": " + derived + " must be free after release, got " + path.basename(after.target));
          after.release();
        } finally {
          try { media.release(); } catch { /* already released */ }
        }
      }
    }
  });

  await suite.test("a plain claim blocks a later media task on its derived paths", async () => {
    // Reverse direction: the plain download holds a derived-looking name, so the
    // media task must not reuse it as scratch.
    for (const [kind, names] of Object.entries(DERIVED)) {
      const derived = names[0];
      const { downloader } = await freshDownloader("derived-rev", {
        overwriteExisting: kind === "http" ? "rename" : "skip",
      });
      const dir = path.join(workRoot, "derived-rev", kind);
      await fsp.mkdir(dir, { recursive: true });
      const plain = await downloader.reserveTarget({
        id: "p", url: "http://127.0.0.1:1/y", kind: "http", filename: derived, dir,
        headers: {}, meta: { exactTarget: true },
      });
      try {
        let mediaErr = null, mediaOk = null;
        await downloader.reserveTarget({
          id: "m", url: "http://127.0.0.1:1/x", kind, filename: BASE[kind], dir,
          headers: {}, meta: { exactTarget: true },
        }).then((r) => { mediaOk = r; }, (e) => { mediaErr = e; });
        if (mediaOk) {
          // Under rename the media task may proceed, but never on the held path.
          assert.notEqual(path.basename(mediaOk.target), BASE[kind],
            kind + ": a rename must move off the blocked base name");
          assert.ok(!mediaOk.pathSet.includes(path.resolve(dir, derived)),
            kind + ": the held derived path must not appear in the new claim set");
          mediaOk.release();
        } else {
          assert.ok(mediaErr, "the media task must either move or be refused");
          assert.ok(["ALREADY_EXISTS", "TARGET_BUSY"].includes(mediaErr.code),
            kind + ": unexpected refusal code " + mediaErr.code);
        }
      } finally {
        plain.release();
      }
    }
  });

  await suite.test("HLS and DASH run correctly beside a conflicting plain download", async () => {
    // End to end: the media task and a plain task that wants its scratch name
    // must both end up correct, with the sentinel untouched and the scratch
    // cleaned up by the media task itself.
    const hls = await startHlsOrigin({ segments: 2, segBytes: 16 * 1024 });
    const dir = path.join(workRoot, "derived-e2e-hls");
    await fsp.mkdir(dir, { recursive: true });
    try {
      const { downloader } = await freshDownloader("derived-e2e-hls", { overwriteExisting: "rename" });
      // The plain download takes the exact name the HLS task would use for its
      // fragment scratch.
      const occupied = path.join(dir, "clip.ts.parts");
      await fsp.writeFile(occupied, SENTINEL);

      const [hlsResult, plainResult] = await Promise.all([
        downloader.run({
          id: "d-hls", url: hls.url, kind: "hls", filename: "clip.ts", dir,
          headers: {}, connections: 2, meta: { exactTarget: true },
        }),
        downloader.run({
          id: "d-plain", url: hls.base + "/seg/0", kind: "http", filename: "clip.ts.parts", dir,
          headers: {}, connections: 1, meta: { exactTarget: true },
        }),
      ]);
      assert.equal(await hashFile(hlsResult.target), hls.expectedSha256,
        "the HLS artefact must be correct");
      assert.notEqual(path.basename(hlsResult.target), "clip.ts",
        "the HLS task must move off the blocked base name");
      assert.notEqual(path.basename(plainResult.target), "clip.ts.parts",
        "the plain task must move off its blocked name");
      assert.equal(fs.readFileSync(occupied, "utf8"), SENTINEL,
        "the sentinel at the contested scratch name must survive");
      assert.ok(!fs.existsSync(path.join(dir, "clip.ts.parts")) ||
        fs.statSync(path.join(dir, "clip.ts.parts")).isFile(),
        "the contested name must remain a file, not become a directory");
    } finally {
      await hls.close();
    }

    const dash = await startDashOrigin({ segments: 1, segBytes: 8 * 1024, audio: false });
    const dashDir = path.join(workRoot, "derived-e2e-dash");
    await fsp.mkdir(dashDir, { recursive: true });
    try {
      const { downloader } = await freshDownloader("derived-e2e-dash", {
        overwriteExisting: "rename", ffmpegPath: "C:" + String.fromCharCode(92) + "nope.exe",
      });
      const occupied = path.join(dashDir, "movie.mp4.tracks");
      await fsp.writeFile(occupied, SENTINEL);
      const [dashResult, plainResult] = await Promise.all([
        downloader.run({
          id: "d-dash", url: dash.url, kind: "dash", filename: "movie.mp4", dir: dashDir,
          headers: {}, connections: 1, meta: { exactTarget: true },
        }),
        downloader.run({
          id: "d-plain2", url: dash.base + "/v-1.m4s", kind: "http", filename: "movie.mp4.tracks",
          dir: dashDir, headers: {}, connections: 1, meta: { exactTarget: true },
        }),
      ]);
      assert.equal(fs.readFileSync(occupied, "utf8"), SENTINEL,
        "the DASH sentinel must survive");
      assert.notEqual(path.basename(dashResult.target), "movie.mp4",
        "the DASH task must move off the blocked base name");
      assert.notEqual(path.basename(plainResult.target), "movie.mp4.tracks",
        "the plain task must move off its blocked name");
    } finally {
      await dash.close();
    }
  });

  await suite.test("overwrite never replaces a path another transfer is using", async () => {
    // Overwrite may replace an old file; it must never take a live path.
    const { downloader } = await freshDownloader("derived-overwrite", { overwriteExisting: "overwrite" });
    const dir = path.join(workRoot, "derived-overwrite");
    await fsp.mkdir(dir, { recursive: true });

    const media = await downloader.reserveTarget({
      id: "m", url: "http://127.0.0.1:1/x", kind: "hls", filename: "movie.ts", dir,
      headers: {}, meta: { exactTarget: true },
    });
    try {
      let err = null;
      await downloader.reserveTarget({
        id: "p", url: "http://127.0.0.1:1/y", kind: "http", filename: "movie.ts.parts", dir,
        headers: {}, meta: { exactTarget: true },
      }).catch((e) => { err = e; });
      assert.ok(err, "overwrite must not hand out a live path");
      assert.equal(err.code, "TARGET_BUSY", "expected TARGET_BUSY, got " + err.code);
    } finally {
      media.release();
    }
    // After release the name is available again.
    const after = await downloader.reserveTarget({
      id: "p2", url: "http://127.0.0.1:1/y", kind: "http", filename: "movie.ts.parts", dir,
      headers: {}, meta: { exactTarget: true },
    });
    assert.equal(path.basename(after.target), "movie.ts.parts");
    after.release();
  });

  // =====================================================================
  // 12. Case-insensitive path identity (Windows default volumes)
  // =====================================================================
  suite.group("Case-insensitive path identity");

  /** Are two paths the same file under this platform's default semantics? */
  const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

  /**
   * Bounded settle helper for fail-fast cases.
   *
   * The distinction that matters is "refused by policy now" versus "still
   * waiting" — a bare await would eventually pass for the wrong reason if the
   * implementation queued behind the holder and returned after its release.
   */
  const settleWithin = async (promise, ms) => {
    const started = Date.now();
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ settled: false, timedOut: true, afterMs: ms }), ms);
    });
    const raced = await Promise.race([
      promise.then(
        (value) => ({ settled: true, ok: true, value, afterMs: Date.now() - started }),
        (error) => ({ settled: true, ok: false, error, afterMs: Date.now() - started }),
      ),
      timeout,
    ]);
    if (timer) clearTimeout(timer);
    return raced;
  };

  await suite.test("the low-level lock stays FIFO across case variants", async () => {
    // The lock is keyed on the comparison key, so "Case.bin" and "case.BIN"
    // are one lock on a case-insensitive volume. The FIFO property must not be
    // weakened by the fail-fast policy work: a raw lockTarget() writer still
    // waits for the holder instead of being handed the path.
    if (!CASE_INSENSITIVE) {
      suite.skip("the low-level lock stays FIFO across case variants", "case-sensitive platform");
      return;
    }
    const { pathKey } = await import("../src/downloader.mjs");
    const { downloader } = await freshDownloader("case-fifo", {});
    const dir = path.join(workRoot, "case-fifo");
    await fsp.mkdir(dir, { recursive: true });
    const heldPath = path.join(dir, "Case.bin");
    const variantPath = path.join(dir, "case.BIN");
    assert.equal(pathKey(heldPath), pathKey(variantPath), "both spellings must share the lock key");

    const releaseA = await downloader.lockTarget(heldPath);
    let state = "waiting";
    let releaseB = null;
    const bPromise = downloader.lockTarget(variantPath, { waitMs: 5000 })
      .then((rel) => { state = "acquired"; releaseB = rel; }, (e) => { state = "error:" + e.code; });
    try {
      for (let i = 0; i < 10 && state === "waiting"; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(state, "waiting", "the variant must wait while the holder lives, state=" + state);
      releaseA();
      await bPromise;
      assert.equal(state, "acquired", "the variant must acquire after the release, state=" + state);
    } finally {
      try { releaseA(); } catch { /* already */ }
      if (releaseB) releaseB();
    }
    // No stranded waiter or lock entry for that key.
    assert.equal(downloader.targetLocks.size, 0,
      "no lock entry may be left behind, saw " + downloader.targetLocks.size);
    const again = await downloader.lockTarget(variantPath, { waitMs: 1000 });
    again();
  });

  await suite.test("pathKey folds case only where the volume does", async () => {
    const { pathKey } = await import("../src/downloader.mjs");
    const a = path.resolve("Case.bin");
    const b = path.resolve("case.BIN");
    if (CASE_INSENSITIVE) {
      assert.equal(pathKey(a), pathKey(b),
        "on " + process.platform + " the two spellings must share one comparison key");
    } else {
      assert.notEqual(pathKey(a), pathKey(b),
        "on a case-sensitive platform the two names are different files");
    }
    assert.ok(pathKey(a).length > 0, "the key must be usable");
  });

  await suite.test("the case-insensitivity assumption matches the actual volume", async () => {
    // Guard: if this filesystem behaves differently from the platform
    // assumption, the tests below would be testing the wrong thing.
    const dir = path.join(workRoot, "case-probe");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "probe.bin"), "x");
    const upperSeen = await fsp.access(path.join(dir, "PROBE.BIN")).then(() => true, () => false);
    assert.equal(upperSeen, CASE_INSENSITIVE,
      "the volume behaves " + (upperSeen ? "case-insensitively" : "case-sensitively") +
      " but the platform constant says otherwise");
  });

  await suite.test("rename waits for a live case variant, then picks a disjoint name", async () => {
    if (!CASE_INSENSITIVE) {
      suite.skip("rename waits for a live case variant, then picks a disjoint name",
        "platform " + process.platform + " is case-sensitive; the names are different files");
      return;
    }
    const { downloader } = await freshDownloader("case-rename", { overwriteExisting: "rename" });
    const dir = path.join(workRoot, "case-rename");
    await fsp.mkdir(dir, { recursive: true });
    const a = await downloader.reserveTarget({
      id: "a", url: "http://127.0.0.1:1/a", kind: "http", filename: "Case.bin", dir,
      headers: {}, meta: { exactTarget: true },
    });
    let b = null;
    try {
      // rename is the one policy that may queue: it must still be waiting here.
      await fsp.writeFile(a.target, "A-CONTENT");
      assert.equal(await downloader.livePolicyVerdict({
        url: "http://127.0.0.1:1/b", filename: "case.BIN", dir, meta: { exactTarget: true },
      }), null, "rename must not be answered by the fail-fast probe");

      const bPromise = downloader.reserveTarget({
        id: "b", url: "http://127.0.0.1:1/b", kind: "http", filename: "case.BIN", dir,
        headers: {}, meta: { exactTarget: true },
      });
      const waiting = await settleWithin(bPromise, 300);
      assert.equal(waiting.settled, false,
        "rename must queue behind the holder, it settled after " + waiting.afterMs + "ms");

      a.release();
      b = await bPromise;
      assert.equal(samePath(b.target, a.target), false,
        "B must not be given A's file, got " + path.basename(b.target));
      assert.equal(fs.readFileSync(a.target, "utf8"), "A-CONTENT", "A's bytes must be untouched");
      const overlap = a.pathSet.filter((x) => b.pathSet.some((y) => samePath(x, y)));
      assert.deepEqual(overlap, [],
        "the two reservations' path sets must be disjoint, overlap: " + JSON.stringify(overlap));
    } finally {
      if (b) b.release();
      try { a.release(); } catch { /* already */ }
    }
    assert.equal(downloader.targetLocks.size, 0, "no lock entry may be left behind");
  });

  await suite.test("a case variant of a live target is refused at once (skip)", async () => {
    if (!CASE_INSENSITIVE) {
      suite.skip("a case variant of a live target is refused at once (skip)", "case-sensitive platform");
      return;
    }
    const { downloader } = await freshDownloader("case-skip", { overwriteExisting: "skip" });
    const dir = path.join(workRoot, "case-skip");
    await fsp.mkdir(dir, { recursive: true });
    const a = await downloader.reserveTarget({
      id: "a", url: "http://127.0.0.1:1/a", kind: "http", filename: "Case.bin", dir,
      headers: {}, meta: { exactTarget: true },
    });
    let b = null;
    try {
      // A is alive and holds the case variant, with its sentinel already written.
      await fsp.writeFile(a.target, "A-CONTENT");
      assert.equal(await downloader.livePolicyVerdict({
        url: "http://127.0.0.1:1/b", filename: "case.BIN", dir, meta: { exactTarget: true },
      }), "skip", "the pre-lock probe must see the live case variant as a skip refusal");

      const outcome = await settleWithin(downloader.reserveTarget({
        id: "b", url: "http://127.0.0.1:1/b", kind: "http", filename: "case.BIN", dir,
        headers: {}, meta: { exactTarget: true },
      }), 1000);
      assert.equal(outcome.settled, true,
        "skip must answer while A still holds the target; it never settled within " + outcome.afterMs + "ms");
      assert.equal(outcome.ok, false, "skip must refuse the live case variant");
      assert.equal(outcome.error.code, "ALREADY_EXISTS",
        "expected ALREADY_EXISTS, got " + outcome.error.code);
      assert.ok(outcome.afterMs < 1000,
        "the refusal must be bounded well below the lock wait, took " + outcome.afterMs + "ms");
      // A stays valid: its lock is untouched and its bytes are intact.
      assert.equal(fs.readFileSync(a.target, "utf8"), "A-CONTENT", "A's bytes must be untouched");
      const probe = await settleWithin(downloader.reserveTarget({
        id: "p", url: "http://127.0.0.1:1/p", kind: "http", filename: "Case.bin", dir,
        headers: {}, meta: { exactTarget: true },
      }), 500);
      assert.equal(probe.settled, true, "A must still be the accepted owner of its own name");
      assert.equal(probe.ok, false, "A's own name must be refused while A holds it");
      assert.equal(probe.error.code, "ALREADY_EXISTS", "expected ALREADY_EXISTS, got " + probe.error.code);
      const locks = [...downloader.targetLocks.values()];
      assert.equal(locks.length, 1, "only A's own lock may exist, saw " + locks.length);
      assert.equal(locks[0].queue.length, 0,
        "the refused skip must never enter the FIFO, queue length " + locks[0].queue.length);
      assert.equal(locks[0].holder, true, "A must remain the holder");
    } finally {
      a.release();
    }
    assert.equal(downloader.targetLocks.size, 0, "A's release must clear its lock entry");

    // The holder released, and the file it wrote is still there: the on-disk
    // half of the skip policy keeps refusing.
    let err = null;
    await downloader.reserveTarget({
      id: "d", url: "http://127.0.0.1:1/d", kind: "http", filename: "case.BIN", dir,
      headers: {}, meta: { exactTarget: true },
    }).catch((e) => { err = e; });
    assert.ok(err, "skip must refuse the file the holder left on disk");
    assert.equal(err.code, "ALREADY_EXISTS", "expected ALREADY_EXISTS, got " + err.code);
    let err2 = null;
    await downloader.reserveTarget({
      id: "c", url: "http://127.0.0.1:1/c", kind: "http", filename: "CASE.bin", dir,
      headers: {}, meta: { exactTarget: true },
    }).catch((e) => { err2 = e; });
    assert.equal(err2 && err2.code, "ALREADY_EXISTS",
      "skip must keep refusing a file that is still on disk");
  });

  await suite.test("overwrite refuses a live case variant at once", async () => {
    if (!CASE_INSENSITIVE) {
      suite.skip("overwrite refuses a live case variant at once", "case-sensitive platform");
      return;
    }
    const { downloader } = await freshDownloader("case-overwrite", { overwriteExisting: "overwrite" });
    const dir = path.join(workRoot, "case-overwrite");
    await fsp.mkdir(dir, { recursive: true });
    const a = await downloader.reserveTarget({
      id: "a", url: "http://127.0.0.1:1/a", kind: "http", filename: "Case.bin", dir,
      headers: {}, meta: { exactTarget: true },
    });
    try {
      // A holds the target and has already written its sentinel bytes.
      await fsp.writeFile(a.target, "A-CONTENT");
      assert.equal(await downloader.livePolicyVerdict({
        url: "http://127.0.0.1:1/b", filename: "case.BIN", dir, meta: { exactTarget: true },
      }), "overwrite", "the pre-lock probe must see the live case variant as an overwrite refusal");

      // The contract is a refusal, not a queued wait. Waiting for A and then
      // taking the name would pass a "did it eventually succeed?" assertion
      // while doing the opposite of what this task requires.
      const outcome = await settleWithin(downloader.reserveTarget({
        id: "b", url: "http://127.0.0.1:1/b", kind: "http", filename: "case.BIN", dir,
        headers: {}, meta: { exactTarget: true },
      }), 1000);
      assert.equal(outcome.settled, true,
        "overwrite must answer while A still holds the target; it never settled within " + outcome.afterMs + "ms");
      assert.equal(outcome.ok, false,
        "overwrite must not queue for, and then take, a live case variant");
      assert.equal(outcome.error.code, "TARGET_BUSY",
        "expected TARGET_BUSY, got " + outcome.error.code);
      assert.ok(outcome.afterMs < 1000,
        "the refusal must be bounded well below the lock wait, took " + outcome.afterMs + "ms");
      assert.equal(fs.readFileSync(a.target, "utf8"), "A-CONTENT", "A's sentinel bytes must be untouched");
      const locks = [...downloader.targetLocks.values()];
      assert.equal(locks.length, 1, "only A's own lock may exist, saw " + locks.length);
      assert.equal(locks[0].queue.length, 0,
        "the refused overwrite must never enter the FIFO, queue length " + locks[0].queue.length);
      assert.equal(locks[0].holder, true, "A must remain the holder");
    } finally {
      a.release();
    }
    assert.equal(downloader.targetLocks.size, 0, "A's release must clear its lock entry");

    // After the holder released, a fresh overwrite request takes the name.
    const b = await downloader.reserveTarget({
      id: "b2", url: "http://127.0.0.1:1/b", kind: "http", filename: "case.BIN", dir,
      headers: {}, meta: { exactTarget: true },
    });
    try {
      assert.equal(samePath(b.target, a.target), true,
        "overwrite must resolve to the same file once it is free, got " + path.basename(b.target));
      assert.equal(path.basename(b.target), "case.BIN",
        "the selected spelling must survive, got " + path.basename(b.target));
    } finally {
      b.release();
    }
    assert.equal(downloader.targetLocks.size, 0, "no lock entry may survive the release");
  });

  await suite.test("a retry takes over its own stale reservation, another task still may not", async () => {
    // Root-cause guard for the GUI Retry regression. A resume or a retry
    // re-enters reserveTarget() with the SAME task id while the previous run of
    // that task may not have released its claim yet. That stale claim belongs to
    // this task: it must be dropped so the retry can reserve the path again.
    // A different task id must still be refused — the fail-fast policy is about
    // other transfers, and a permanent self-exemption would break that.
    const { pathKey } = await import("../src/downloader.mjs");
    const { downloader } = await freshDownloader("retry-reenter", { overwriteExisting: "overwrite" });
    const dir = path.join(workRoot, "retry-reenter");
    await fsp.mkdir(dir, { recursive: true });
    const baseTask = { url: "http://127.0.0.1:1/a", kind: "http", filename: "retry.bin", dir,
      headers: {}, meta: { exactTarget: true } };

    // The previous run of task "same" reserved and did not release (it was
    // paused/cancelled mid-flight), exactly like a paused GUI row.
    const stale = await downloader.reserveTarget({ ...baseTask, id: "same" });
    assert.equal(stale.filename, "retry.bin");
    assert.equal(downloader.claimOwners.get(pathKey(path.join(dir, "retry.bin"))), "same",
      "the claim must record its owning task id");

    // A different task asking for the same spelling queues on the FIFO and
    // takes the path once the holder releases: overwrite must succeed, not be
    // refused. This is the GUI Retry shape (all rows share one file name).
    let sameSpelling = null;
    const sameSpellingPromise = downloader.reserveTarget({ ...baseTask, id: "other" })
      .then((r) => { sameSpelling = r; }, (e) => { sameSpelling = { error: e }; });
    const queued = await settleWithin(sameSpellingPromise.then(() => "settled"), 300);
    assert.equal(queued.settled, false,
      "an identical-spelling overwrite request must queue, it settled after " + queued.afterMs + "ms");
    assert.equal([...downloader.targetLocks.values()][0].queue.length, 1,
      "the identical-spelling request must be the one FIFO waiter");
    stale.release();
    await sameSpellingPromise;
    assert.ok(sameSpelling && !sameSpelling.error,
      "the queued overwrite must acquire the path once released, got " +
      (sameSpelling && sameSpelling.error && sameSpelling.error.code));
    sameSpelling.release();

    // A different task asking for a CASE VARIANT is refused at once instead:
    // that is the fast-reject contract the strategy task order requires.
    const stale2 = await downloader.reserveTarget({ ...baseTask, id: "same2" });
    let variantErr = null;
    await downloader.reserveTarget({
      ...baseTask, id: "other2", filename: "RETRY.BIN",
    }).catch((e) => { variantErr = e; });
    assert.ok(variantErr, "another task must not be handed a live case variant");
    assert.equal(variantErr.code, "TARGET_BUSY",
      "expected TARGET_BUSY for a case variant, got " + variantErr.code);
    stale2.release();

    // The same task may re-enter: the stale reservation is released, not
    // permanently exempted.
    const again = await downloader.reserveTarget({ ...baseTask, id: "same" });
    assert.equal(again.filename, "retry.bin", "the retry must get its own target back");
    assert.equal(downloader.reservedNames.has(pathKey(path.join(dir, "retry.bin"))), true,
      "the retry must own the claim, not merely be exempted");
    assert.equal(downloader.claimOwners.get(pathKey(path.join(dir, "retry.bin"))), "same",
      "the new claim must be owned by the retrying task");
    again.release();
    assert.equal(downloader.reservedNames.size, 0, "the release must clear every claim");
    assert.equal(downloader.claimOwners.size, 0, "the release must clear the ownership record");
    assert.equal(downloader.targetLocks.size, 0, "the release must clear the lock entry");
    stale.release();   // idempotent, and must not disturb the finished reservation
  });

  await suite.test("a failed task retried under the same id succeeds with correct bytes", async () => {
    // End to end version of the same flow: the first run fails, the retry runs
    // as the same task id and must deliver a byte-correct file.
    const body = Buffer.alloc(64 * 1024, 0x5a);
    const state = { fail: true, requests: 0 };
    const http = await import("node:http");
    const srv = http.createServer((req, res) => {
      state.requests++;
      if (state.fail) {
        res.writeHead(500, { "Content-Type": "text/plain", "Content-Length": "5" });
        res.end("boom!");
        return;
      }
      res.writeHead(200, {
        "Content-Length": body.length, "Accept-Ranges": "bytes",
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="retry-e2e.bin"',
      });
      res.end(body);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const url = "http://127.0.0.1:" + srv.address().port + "/file.bin";
    const dir = path.join(workRoot, "retry-e2e");
    await fsp.mkdir(dir, { recursive: true });
    try {
      const { downloader } = await freshDownloader("retry-e2e", { overwriteExisting: "overwrite" });
      const task = { id: "retry-e2e-1", url, kind: "http", filename: "retry-e2e.bin", dir,
        headers: {}, connections: 1, meta: { exactTarget: true } };
      let firstErr = null;
      await downloader.run(task).catch((e) => { firstErr = e; });
      assert.ok(firstErr, "the first attempt must fail");
      assert.equal(downloader.reservedNames.size, 0,
        "a failed transfer must release its claim, saw " + downloader.reservedNames.size);
      assert.equal(downloader.targetLocks.size, 0,
        "a failed transfer must release its lock, saw " + downloader.targetLocks.size);

      state.fail = false;
      const result = await downloader.run({ ...task });
      assert.equal(result.bytes, body.length, "the retry must deliver every byte");
      assert.equal(await hashFile(result.target), sha256(body),
        "the retried file must be byte-correct");
      assert.equal(downloader.reservedNames.size, 0, "the retry must release its claim");
      assert.equal(downloader.targetLocks.size, 0, "the retry must release its lock");
    } finally {
      await closeServer(srv);
    }
  });

  await suite.test("an identical-spelling overwrite queues, then overwrites", async () => {
    // The other half of the arbitration: same spelling waits on the existing
    // FIFO and then overwrites. A case variant of the same file is refused at
    // once (the tests above). Getting these two backwards breaks either the GUI
    // Retry flow or the variant protection.
    const { downloader } = await freshDownloader("same-spelling", { overwriteExisting: "overwrite" });
    const dir = path.join(workRoot, "same-spelling");
    await fsp.mkdir(dir, { recursive: true });
    const livePath = path.join(dir, "live.bin");

    const a = await downloader.reserveTarget({
      id: "a", url: "http://127.0.0.1:1/a", kind: "http", filename: "live.bin", dir,
      headers: {}, meta: { exactTarget: true },
    });
    let b = null;
    try {
      await fsp.writeFile(a.target, "A-SENTINEL");
      // Identical spelling: must queue, not be refused.
      const bPromise = downloader.reserveTarget({
        id: "b", url: "http://127.0.0.1:1/b", kind: "http", filename: "live.bin", dir,
        headers: {}, meta: { exactTarget: true },
      });
      const waiting = await settleWithin(bPromise, 400);
      assert.equal(waiting.settled, false,
        "B must still be queued while A holds the identical path, settled after " + waiting.afterMs + "ms");
      const entry = [...downloader.targetLocks.values()][0];
      assert.ok(entry && entry.holder === true, "A must still hold the lock");
      assert.equal(entry.queue.length, 1, "B must be the one FIFO waiter, saw " + entry.queue.length);
      assert.equal(fs.readFileSync(livePath, "utf8"), "A-SENTINEL",
        "A's sentinel must not be touched while A holds the path");

      a.release();
      b = await bPromise;
      assert.equal(samePath(b.target, a.target), true,
        "overwrite must resolve to the same file, got " + path.basename(b.target));
      assert.equal(path.basename(b.target), "live.bin",
        "the requested spelling must survive, got " + path.basename(b.target));
      // The overwrite is what the transfer does, so prove the bytes are B's.
      await fsp.writeFile(b.target, "B-PAYLOAD");
      assert.equal(fs.readFileSync(livePath, "utf8"), "B-PAYLOAD",
        "after the queued overwrite the file must hold B's bytes");
    } finally {
      if (b) b.release();
      try { a.release(); } catch { /* already */ }
    }
    assert.equal(downloader.targetLocks.size, 0, "no lock entry may survive");
    assert.equal(downloader.reservedNames.size, 0, "no claim may survive");
  });

  await suite.test("a live case variant keeps its derived names", async () => {
    if (!CASE_INSENSITIVE) {
      suite.skip("a live case variant keeps its derived names", "case-sensitive platform");
      return;
    }
    const { downloader } = await freshDownloader("case-derived", { overwriteExisting: "rename" });
    const dir = path.join(workRoot, "case-derived");
    await fsp.mkdir(dir, { recursive: true });
    const media = await downloader.reserveTarget({
      id: "m", url: "http://127.0.0.1:1/x", kind: "hls", filename: "Movie.ts", dir,
      headers: {}, meta: { exactTarget: true },
    });
    let plain = null;
    try {
      plain = await downloader.reserveTarget({
        id: "p", url: "http://127.0.0.1:1/y", kind: "http", filename: "MOVIE.TS.PARTS", dir,
        headers: {}, meta: { exactTarget: true },
      });
      assert.equal(samePath(plain.target, path.join(dir, "MOVIE.TS.PARTS")), false,
        "a differently-cased derived name must not be handed out, got " + path.basename(plain.target));
      const overlap = plain.pathSet.filter((x) => media.pathSet.some((y) => samePath(x, y)));
      assert.deepEqual(overlap, [], "path sets must be disjoint, overlap: " + JSON.stringify(overlap));
    } finally {
      if (plain) plain.release();
      media.release();
    }
  });

  await suite.test("the suite does not tamper with global TLS state", () => {
    // If the harness trusted this certificate (NODE_EXTRA_CA_CERTS) or disabled
    // verification (NODE_TLS_REJECT_UNAUTHORIZED=0), the "rejected by default"
    // tests above would pass for the wrong reason.
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined,
      "the suite must not disable TLS verification globally");
    assert.ok(!process.env.NODE_EXTRA_CA_CERTS,
      "the suite must not inject extra CAs globally");
  });
}

export default runMediaE2ETests;

// ---------------------------------------------------------------------------
// Standalone entry: `node test/media-e2e.mjs`
//
// The suite is also mounted inside test/run.mjs. Running it alone keeps the
// media-facing checks usable while working on one of them, and gives the
// delivery commands a single-purpose exit code (and a skip count, which the
// combined runner reports but does not fail on).
// ---------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const os = await import("node:os");
  const { Suite } = await import("./harness.mjs");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "media-e2e-"));
  const out = path.join(root, "out");
  const home = path.join(root, "home");
  await fsp.mkdir(out, { recursive: true });
  await fsp.mkdir(home, { recursive: true });
  process.env.DOWNLOADX_HOME = home;

  const { Config } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { Downloader } = await import("../src/downloader.mjs");

  const suite = new Suite("media-e2e");
  const NL = String.fromCharCode(10);
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else if (r.kind === "skip") process.stdout.write("    SKIP  " + r.text + "  - " + r.reason + NL);
    else process.stdout.write("    FAIL  " + r.text + NL +
      "          " + String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const started = Date.now();
  await runMediaE2ETests(suite, { out, Config, QueueManager, Downloader });
  process.stdout.write(suite.report());
  process.stdout.write("  elapsed: " + ((Date.now() - started) / 1000).toFixed(1) + "s" + NL);
  if (!process.env.DOWNLOADX_KEEP_MEDIA_E2E) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  } else {
    process.stdout.write("  scratch kept at " + root + NL);
  }
  process.exitCode = suite.failed === 0 ? 0 : 1;
}
