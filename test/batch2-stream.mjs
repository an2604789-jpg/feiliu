// 批-2 回归:HLS/DASH 分片流式落盘(src/net.mjs readBodyToFile + src/downloader.mjs
// 五处媒体下载路径)。
//
// 被守护的行为:
//   (a) 媒体分片(含 init/map/音频分片)不再整片缓冲进内存,而是流式写进
//       .part 文件;>8MB 的分片(远超旧的 64MiB 缓冲时代想象、更远超
//       readBody 默认 8MiB)能下载成功,且产物字节与 origin 提供的完全一致;
//   (b) 断点续传:.part 只有在旁边有 .ok 完成标记(记录字节数)且长度相符时
//       才算完成;取消/崩溃遗留的半截 .part、以及"标记与实际长度不符"的损
//       坏件,在重入时被丢弃重取——重入后的产物必须与一次完整下载字节一致
//       (实测,不是推断);
//   (c) 传输中途连接被掐断(fetchMediaPartToFile 的重试路径):半截字节绝不
//       会漏进最终 .part,重试后字节仍精确;
//   (d) 限速:mediaLimiter 的桶在 readBodyToFile 里按块扣减,限速下传输能完
//       成且字节精确(按任务书,慢速下"无超量内存"的行为断言简化为传输完成,
//       附加一个宽松的耗时下限证明桶确实在起作用);
//   (e) readBodyToFile 单元行为:显式 position 追加、ABORT_ERR 取消、超上限
//       保险丝报错、limiter 逐块扣减。
//
// 一切都在本地 origin + 隔离 DOWNLOADX_HOME 里进行:不碰公网、不碰用户
// Downloads、不碰 D:/IAM/downloadx-data,进程必须干净退出。
//
// Usage: node test/batch2-stream.mjs

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";
import { requestFollow, readBodyToFile } from "../src/net.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NL = String.fromCharCode(10);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function sha256File(file) {
  const h = createHash("sha256");
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file);
    rs.on("data", (c) => h.update(c));
    rs.once("end", resolve);
    rs.once("error", reject);
  });
  return h.digest("hex");
}

/** Poll until fn() is truthy, or fail with the caller's message. */
async function waitFor(fn, { timeoutMs = 30000, everyMs = 50, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// ---------------------------------------------------------------------------
// 本地 origin:所有字节都是位置相关的确定性图案,截断、错序、重复拼接都不可
// 能碰巧哈希出正确答案。
// ---------------------------------------------------------------------------

const SEG_SIZE = 9 * 1024 * 1024;        // 9 MiB > 8 MiB(任务书下限)
const SMALL_SEG = 512 * 1024;
const AUDIO_SEG = 256 * 1024;
const INIT_SIZE = 4096;

const bodyCache = new Map();
/** Deterministic body: byte i = f(tag, i), so every position is distinguishable. */
function patternBody(tag, size, seed) {
  const key = tag + ":" + size;
  if (!bodyCache.has(key)) {
    const b = Buffer.alloc(size);
    for (let i = 0; i < size; i++) b[i] = (seed + i * 7 + tag * 131) & 0xff;
    bodyCache.set(key, b);
  }
  return bodyCache.get(key);
}
const segBody = (n) => patternBody(n, SEG_SIZE, 11);
const smallBody = (n) => patternBody(100 + n, SMALL_SEG, 23);
const audioBody = (n) => patternBody(200 + n, AUDIO_SEG, 37);
const hlsInit = () => patternBody(900, INIT_SIZE, 5);
const dashInit = () => patternBody(901, INIT_SIZE, 19);

/**
 * @returns {{origin:string, segRequests:Map, flakyTries:Map, close:()=>Promise<void>,
 *            server:http.Server}}
 */
function startOrigin() {
  const segRequests = new Map();   // bigseg segment index -> request count
  const flakyTries = new Map();    // flakyseg segment index -> request count
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const p = u.pathname;
    const count = Number(u.searchParams.get("count") || 3);
    let closed = false;
    res.once("close", () => { closed = true; });

    const sendText = (body, type) => {
      res.writeHead(200, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
      res.end(body);
    };
    const m3u8 = (lines) => sendText(lines.join("\n"), "application/vnd.apple.mpegurl");

    /** Serve `body` in 64 KiB ticks so a caller can abort mid-transfer. */
    const trickle = (body, onDone) => {
      res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": body.length });
      let i = 0;
      const tick = () => {
        if (closed || res.destroyed) return;
        if (i >= body.length) { res.end(); onDone?.(); return; }
        res.write(body.subarray(i, i + 64 * 1024));
        i += 64 * 1024;
        setTimeout(tick, 5);
      };
      tick();
    };

    // --- HLS playlists -----------------------------------------------------
    if (p === "/hls/media.m3u8" || p === "/hlsf/media.m3u8" || p === "/hlsv/media.m3u8") {
      const prefix = p.startsWith("/hlsf/") ? "/flakyseg/" : p.startsWith("/hlsv/") ? "/vseg/" : "/bigseg/";
      const lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-TARGETDURATION:4",
        '#EXT-X-MAP:URI="/init.bin"'];
      for (let i = 0; i < count; i++) { lines.push("#EXTINF:4.0,"); lines.push(prefix + i); }
      lines.push("#EXT-X-ENDLIST");
      m3u8(lines);
      return;
    }
    if (p === "/hlsa/audio.m3u8") {
      const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:4"];
      for (let i = 0; i < count; i++) { lines.push("#EXTINF:4.0,"); lines.push("/aseg/" + i); }
      lines.push("#EXT-X-ENDLIST");
      m3u8(lines);
      return;
    }
    if (p === "/hls/master.m3u8") {
      m3u8([
        "#EXTM3U",
        "#EXT-X-VERSION:6",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="aom",DEFAULT=YES,AUTOSELECT=YES,URI="/hlsa/audio.m3u8?count=3"',
        '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="aud"',
        "/hlsv/media.m3u8?count=" + count,
      ]);
      return;
    }

    // --- segment bodies ----------------------------------------------------
    if (p.startsWith("/bigseg/")) {
      const n = Number(p.slice(8)) || 0;
      segRequests.set(n, (segRequests.get(n) || 0) + 1);
      trickle(segBody(n));
      return;
    }
    if (p.startsWith("/flakyseg/")) {
      const n = Number(p.slice(10)) || 0;
      const tries = (flakyTries.get(n) || 0) + 1;
      flakyTries.set(n, tries);
      const body = segBody(n);
      // First attempt for each segment dies halfway through the body; every
      // later attempt serves it whole.
      if (tries === 1) {
        const half = Math.floor(body.length / 2);
        res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": body.length });
        let i = 0;
        const tick = () => {
          if (closed || res.destroyed) return;
          if (i >= half) { res.destroy(); return; }   // drop mid-body
          res.write(body.subarray(i, i + 64 * 1024));
          i += 64 * 1024;
          setTimeout(tick, 5);
        };
        tick();
        return;
      }
      trickle(body);
      return;
    }
    if (p.startsWith("/vseg/")) {
      const n = Number(p.slice(6)) || 0;
      const body = smallBody(n);
      res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": body.length });
      res.end(body);
      return;
    }
    if (p.startsWith("/aseg/")) {
      const n = Number(p.slice(6)) || 0;
      const body = audioBody(n);
      res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": body.length });
      res.end(body);
      return;
    }
    if (p === "/init.bin") {
      const body = hlsInit();
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": body.length });
      res.end(body);
      return;
    }

    // --- DASH ---------------------------------------------------------------
    if (p === "/dash/manifest.mpd") {
      const xml = '<MPD type="static" mediaPresentationDuration="PT9S"><Period>' +
        '<AdaptationSet mimeType="video/mp4">' +
        '<Representation id="v1" bandwidth="1500000" width="1280" height="720">' +
        '<SegmentTemplate timescale="1" duration="3" media="v-$Number$.m4s" initialization="v-init.mp4" startNumber="1"/>' +
        "</Representation></AdaptationSet></Period></MPD>";
      sendText(xml, "application/dash+xml");
      return;
    }
    if (p === "/dash/v-init.mp4") {
      const body = dashInit();
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": body.length });
      res.end(body);
      return;
    }
    if (/^\/dash\/v-\d+\.m4s$/.test(p)) {
      const n = Number(/v-(\d+)\.m4s$/.exec(p)[1]);
      trickle(segBody(n));
      return;
    }

    // --- readBodyToFile unit fixtures --------------------------------------
    if (p.startsWith("/unit/")) {
      const size = Number(p.split("/")[2]) || 1024;
      const body = patternBody(500, size, 61);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
      res.end(body);
      return;
    }
    if (p.startsWith("/unit-slow/")) {
      const size = Number(p.split("/")[2]) || 65536;
      const body = patternBody(501, size, 71);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
      let i = 0;
      const tick = () => {
        if (closed || res.destroyed) return;
        if (i >= body.length) { res.end(); return; }
        res.write(body.subarray(i, i + 16 * 1024));
        i += 16 * 1024;
        setTimeout(tick, 10);
      };
      tick();
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  server.on("clientError", (err, socket) => { try { socket.destroy(); } catch { /* gone */ } });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        origin: "http://127.0.0.1:" + server.address().port,
        segRequests,
        flakyTries,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Complete vs partial part files in a scratch directory. */
async function partState(partDir) {
  let names = [];
  try { names = await fsp.readdir(partDir); } catch { return { complete: [], partial: [] }; }
  const complete = [];
  const partial = [];
  for (const n of names) {
    if (!n.endsWith(".part")) continue;
    (names.includes(n + ".ok") ? complete : partial).push(n);
  }
  return { complete, partial };
}

async function main() {
  const suite = new Suite("batch2-stream");
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + (r.ms > 400 ? "  (" + r.ms + "ms)" : "") + NL);
    else if (r.kind === "skip") process.stdout.write("    SKIP  " + r.text + "  - " + r.reason + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  // Isolated home BEFORE the first import of anything that reads paths.
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b2-stream-"));
  const out = path.join(home, "out");
  await fsp.mkdir(out, { recursive: true });
  process.env.DOWNLOADX_HOME = home;

  const origin = await startOrigin();
  const { Config } = await import(new URL("../src/config.mjs", import.meta.url).href);
  const { Downloader } = await import(new URL("../src/downloader.mjs", import.meta.url).href);

  const config = new Config(path.join(home, "config.json"));
  await config.load();
  await config.set({
    defaultDir: out,
    categorizeByType: false,
    // "overwrite" is deliberate: a re-entered transfer must land on the SAME
    // target (and therefore the same .parts scratch) as its interrupted run,
    // which is exactly the resume path under test.
    overwriteExisting: "overwrite",
    maxConnections: 8,
    proxy: "",
    proxyMode: "none",
    maxRetries: 6,
    retryBaseMs: 50,
    // A path that does not exist: keeps the muxer out of the picture so the
    // byte comparisons assert exactly what the downloader wrote, independent
    // of whether this machine has ffmpeg.
    ffmpegPath: path.join(home, "no-ffmpeg-here.exe"),
  });
  const downloader = new Downloader({ config });

  /** Run one task to completion and return the downloader's result. */
  const runTask = (task) => downloader.run({ headers: {}, ...task });

  const expectedProduct = (parts) => {
    const h = createHash("sha256");
    let size = 0;
    for (const b of parts) { h.update(b); size += b.length; }
    return { sha256: h.digest("hex"), size };
  };

  const scratch = path.join(os.tmpdir(), "downloadx-b2-unit-");
  const unitFile = async (name) => {
    const dir = await fsp.mkdtemp(scratch);
    return path.join(dir, name);
  };

  try {
    // ================================================== readBodyToFile 单测
    suite.group("net.mjs readBodyToFile");

    await suite.test("streams a whole body into an open handle and reports the byte count", async () => {
      const res = await requestFollow(origin.origin + "/unit/262144");
      const file = await unitFile("plain.bin");
      const fh = await fsp.open(file, "w");
      let written;
      try {
        written = await readBodyToFile(res, fh);
      } finally {
        await fh.close();
      }
      assert.equal(written, 262144, "bytes written must equal the body length");
      const body = await fsp.readFile(file);
      assert.equal(body.length, 262144, "file length");
      assert.equal(sha256(body), sha256(patternBody(500, 262144, 61)), "file bytes must be exactly what the origin served");
    });

    await suite.test("writes at an explicit position (append after a prefix)", async () => {
      const res = await requestFollow(origin.origin + "/unit/65536");
      const file = await unitFile("prefixed.bin");
      const fh = await fsp.open(file, "w");
      try {
        await fh.write(Buffer.from("PRE:"));
        const written = await readBodyToFile(res, fh, { position: 4 });
        assert.equal(written, 65536, "bytes written");
        const body = await fsp.readFile(file);
        assert.equal(body.length, 4 + 65536, "prefix + body, nothing else");
        assert.equal(sha256(body.subarray(4)), sha256(patternBody(500, 65536, 61)), "body must start exactly at the given position");
        assert.equal(body.subarray(0, 4).toString(), "PRE:", "prefix untouched");
      } finally {
        await fh.close();
      }
    });

    await suite.test("abort mid-body rejects with ABORT_ERR and keeps only the bytes that arrived", async () => {
      const res = await requestFollow(origin.origin + "/unit-slow/1048576");
      const file = await unitFile("aborted.bin");
      const fh = await fsp.open(file, "w");
      const controller = new AbortController();
      let err = null;
      const p = (async () => {
        try {
          return await readBodyToFile(res, fh, { signal: controller.signal });
        } catch (e) {
          err = e;
          throw e;
        }
      })();
      await new Promise((r) => setTimeout(r, 150));   // let some chunks land
      controller.abort();
      await p.then(() => { throw new Error("expected the stream to reject on abort"); }, () => {});
      assert.equal(err && err.code, "ABORT_ERR", "the rejection must be the abort error");
      await fh.close();
      const st = await fsp.stat(file);
      assert.ok(st.size > 0, "some bytes were written before the abort");
      assert.ok(st.size < 1048576, "the body must NOT have completed: " + st.size);
    });

    await suite.test("refuses a body larger than the guard limit", async () => {
      const res = await requestFollow(origin.origin + "/unit/2097152");
      const file = await unitFile("overlimit.bin");
      const fh = await fsp.open(file, "w");
      let err = null;
      try {
        await readBodyToFile(res, fh, { limit: 1024 * 1024 });
      } catch (e) {
        err = e;
      } finally {
        await fh.close();
      }
      assert.ok(err, "the runaway fuse must fire");
      assert.match(String(err && err.message), /exceeds 1048576 bytes/, "the fuse error names the limit");
    });

    await suite.test("spends the limiter chunk by chunk, before writing", async () => {
      const res = await requestFollow(origin.origin + "/unit/65536");
      const file = await unitFile("limited.bin");
      const takes = [];
      const limiter = { take: async (n) => { takes.push(n); } };
      const fh = await fsp.open(file, "w");
      try {
        const written = await readBodyToFile(res, fh, { limiter });
        assert.equal(written, 65536, "transfer completes under the limiter");
        assert.ok(takes.length >= 1, "the limiter must have been consulted");
        const total = takes.reduce((a, b) => a + b, 0);
        assert.equal(total, 65536, "every byte must pass through the bucket exactly once");
      } finally {
        await fh.close();
      }
    });

    // ================================================== HLS 大分片
    suite.group("HLS segments larger than 8 MiB");

    const bigUrl = origin.origin + "/hls/media.m3u8?count=3";
    const bigTarget = path.join(out, "big.ts");

    await suite.test(">8 MiB segments (with EXT-X-MAP) download and hash to the exact bytes", async () => {
      const result = await runTask({ id: "hls-big", url: bigUrl, filename: "big.ts" });
      assert.equal(result.ok, true, "the transfer must succeed");
      assert.equal(result.target, bigTarget, "target path");
      const expected = expectedProduct([hlsInit(), segBody(0), segBody(1), segBody(2)]);
      const st = await fsp.stat(bigTarget);
      assert.equal(st.size, expected.size, "product size: init + 3 big segments");
      assert.equal(await sha256File(bigTarget), expected.sha256, "product bytes must be byte-identical to what the origin served");
      assert.equal(result.meta.initSegment, true, "the map/init segment was fetched");
      assert.equal(result.meta.segments, 3);
      assert.equal(fs.existsSync(bigTarget + ".parts"), false, "scratch cleaned after success");
    });

    // ================================================== abort → 重入
    suite.group("cancel mid-transfer, then resume");

    const resumeUrl = origin.origin + "/hls/media.m3u8?count=5";
    const resumeTarget = path.join(out, "resume.ts");
    const resumeParts = resumeTarget + ".parts";

    await suite.test("abort leaves complete parts (.ok) and partials (no marker) on disk", async () => {
      const controller = new AbortController();
      // 2 workers over 5 segments: the first two finish while the next pair is
      // mid-flight, so aborting then leaves both complete and partial parts.
      let runError = null;
      const p = runTask({
        id: "hls-abort-1", url: resumeUrl, filename: "resume.ts",
        connections: 2, signal: controller.signal,
      }).then(
        (r) => { throw new Error("expected the aborted run to reject, it completed: " + JSON.stringify(r.meta)); },
        (e) => { runError = e; return e; },
      );
      await waitFor(async () => {
        const s = await partState(resumeParts);
        return s.complete.length >= 1 && s.partial.length >= 1;
      }, { what: "a complete part AND a mid-flight partial to exist" });
      controller.abort();
      const err = await p;
      assert.match(String(err && err.message), /abort/i, "the run must fail as aborted");

      // Post-abort state: scratch kept, no product published.
      assert.equal(fs.existsSync(resumeTarget), false, "an aborted transfer must not publish a file");
      assert.equal(fs.existsSync(resumeParts), true, "the scratch directory must survive the abort (that is the resume state)");
      const state = await partState(resumeParts);
      assert.ok(state.complete.length >= 1, "at least one finished part with an .ok marker");
      assert.ok(state.partial.length >= 1, "at least one partial part without a marker");

      // A part carrying the completion marker must already hold the exact
      // bytes the origin serves for that segment: the .part file IS a piece
      // of the final product from the moment it completes.
      for (const name of state.complete) {
        const idx = Number(name.replace(/\.part$/, ""));
        const part = await fsp.readFile(path.join(resumeParts, name));
        assert.equal(sha256(part), sha256(segBody(idx)), "completed .part " + name + " must equal the origin bytes");
      }
    });

    await suite.test("re-entry reuses good parts, discards partials and a marker/size mismatch, and is byte-identical", async () => {
      const before = await partState(resumeParts);
      const countsBefore = new Map(origin.segRequests);

      // Simulate a crash artefact the length check has to catch: grow one
      // COMPLETE part behind its marker's back, so marker size != file size.
      const corruptName = before.complete[0];
      const corruptIdx = Number(corruptName.replace(/\.part$/, ""));
      await fsp.appendFile(path.join(resumeParts, corruptName), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
      const mismatch = await fsp.readFile(path.join(resumeParts, corruptName));
      const marker = Number(await fsp.readFile(path.join(resumeParts, corruptName + ".ok"), "utf8"));
      assert.notEqual(mismatch.length, marker, "the corruption must actually create a mismatch");

      // Re-entry: a fresh task for the same URL and filename. Under the
      // overwrite policy it lands on the same target and the same scratch.
      const result = await runTask({ id: "hls-resume-2", url: resumeUrl, filename: "resume.ts" });
      assert.equal(result.ok, true, "the resumed transfer must succeed");
      assert.equal(result.target, resumeTarget);

      // THE assertion the task book demands: the recovered product is
      // byte-identical to a one-shot download.
      const expected = expectedProduct([hlsInit(), segBody(0), segBody(1), segBody(2), segBody(3), segBody(4)]);
      const st = await fsp.stat(resumeTarget);
      assert.equal(st.size, expected.size, "resumed product size");
      assert.equal(await sha256File(resumeTarget), expected.sha256, "resumed product must be byte-identical to a full download");
      assert.equal(fs.existsSync(resumeParts), false, "scratch cleaned after success");

      // And the resume semantics themselves: good parts were NOT re-fetched,
      // the mismatched one WAS re-fetched (marker + length check caught it),
      // partials were re-fetched from zero.
      for (const name of before.complete) {
        const idx = Number(name.replace(/\.part$/, ""));
        const after = origin.segRequests.get(idx) || 0;
        const was = countsBefore.get(idx) || 0;
        if (idx === corruptIdx) {
          assert.equal(after, was + 1, "the marker/size-mismatched part must have been re-fetched");
        } else {
          assert.equal(after, was, "a completed part must be reused, not re-fetched (segment " + idx + ")");
        }
      }
      for (let i = 0; i < 5; i++) {
        assert.ok((origin.segRequests.get(i) || 0) >= 1, "every segment must have been fetched at least once");
      }
    });

    // ================================================== 中途断线重试
    suite.group("mid-body connection drop");

    await suite.test("a dropped connection's partial bytes never reach the final product", async () => {
      const target = path.join(out, "flaky.ts");
      const result = await runTask({
        id: "hls-flaky", url: origin.origin + "/hlsf/media.m3u8?count=2", filename: "flaky.ts",
      });
      assert.equal(result.ok, true, "the transfer must succeed despite the drop");
      const expected = expectedProduct([hlsInit(), segBody(0), segBody(1)]);
      const st = await fsp.stat(target);
      assert.equal(st.size, expected.size, "product size");
      assert.equal(await sha256File(target), expected.sha256,
        "the half-written bytes from the dropped attempt must have been truncated away");
      assert.equal((origin.flakyTries.get(0) || 0), 2, "segment 0 was dropped once and then served whole");
      assert.equal((origin.flakyTries.get(1) || 0), 2, "segment 1 was dropped once and then served whole");
    });

    // ================================================== 限速
    suite.group("rate-limited media transfer");

    await suite.test("a 2 MiB/s task limit completes, is byte-exact, and actually throttles", async () => {
      const target = path.join(out, "slow.ts");
      const started = Date.now();
      const result = await runTask({
        id: "hls-slow", url: origin.origin + "/hls/media.m3u8?count=1", filename: "slow.ts",
        speedLimit: 2 * 1024 * 1024,
      });
      const elapsed = Date.now() - started;
      assert.equal(result.ok, true, "the throttled transfer must complete");
      const expected = expectedProduct([hlsInit(), segBody(0)]);
      const st = await fsp.stat(target);
      assert.equal(st.size, expected.size, "throttled product size");
      assert.equal(await sha256File(target), expected.sha256, "throttled product bytes");
      // ~9 MiB at 2 MiB/s (with one second's burst credit) cannot finish much
      // under ~3.5 s: a loose floor proves the bucket is being spent inside
      // the streaming loop rather than after the body was slurped.
      // (Per the task brief, the "no excess memory while slow" assertion is
      // simplified to transfer completion plus this floor.)
      assert.ok(elapsed >= 3000, "the transfer must have taken the throttled time, took " + elapsed + "ms");
    });

    // ================================================== DASH
    suite.group("DASH segments larger than 8 MiB");

    await suite.test("a video-only MPD streams init + big segments into the exact track bytes", async () => {
      const requested = path.join(out, "movie.mp4");
      // Without ffmpeg, mergeTracks reports "keeping separate track files"
      // BEFORE its single-track rename branch, so the product is the track
      // file itself (existing behaviour; this test is about the bytes).
      const target = requested + ".video.mp4";
      const result = await runTask({
        id: "dash-big", url: origin.origin + "/dash/manifest.mpd", filename: "movie.mp4",
      });
      assert.equal(result.ok, true, "the transfer must succeed");
      assert.equal(result.target, target, "with no ffmpeg the video track file is the product");
      assert.equal(result.meta.merged, false, "no merge without ffmpeg");
      const expected = expectedProduct([dashInit(), segBody(1), segBody(2), segBody(3)]);
      const st = await fsp.stat(target);
      assert.equal(st.size, expected.size, "product size: init + 3 big segments");
      assert.equal(await sha256File(target), expected.sha256, "product bytes must be exact");
      assert.equal(result.meta.segments, 3);
      assert.equal(fs.existsSync(requested), false, "nothing must be published under the requested name");
      assert.equal(fs.existsSync(requested + ".tracks"), false, "scratch cleaned after success");
    });

    // ================================================== HLS 音频 rendition
    suite.group("HLS separate audio rendition");

    await suite.test("audio parts stream too; both files keep the exact served bytes", async () => {
      const target = path.join(out, "withaudio.ts");
      const audio = target + ".audio.ts";
      const result = await runTask({
        id: "hls-audio", url: origin.origin + "/hls/master.m3u8?count=2", filename: "withaudio.ts",
      });
      assert.equal(result.ok, true, "the transfer must succeed");
      // No ffmpeg on purpose: the mux must fail cleanly and keep both tracks.
      assert.equal(result.meta.merged, false, "merge must fail without ffmpeg");
      assert.deepEqual(result.meta.separateTracks, [target, audio], "both track files must be reported");

      const expectedVideo = expectedProduct([hlsInit(), smallBody(0), smallBody(1)]);
      const st = await fsp.stat(target);
      assert.equal(st.size, expectedVideo.size, "video product size");
      assert.equal(await sha256File(target), expectedVideo.sha256, "video product bytes");

      const expectedAudio = expectedProduct([audioBody(0), audioBody(1), audioBody(2)]);
      const ast = await fsp.stat(audio);
      assert.equal(ast.size, expectedAudio.size, "audio product size");
      assert.equal(await sha256File(audio), expectedAudio.sha256, "audio product bytes");
      assert.equal(fs.existsSync(target + ".audioparts"), false, "audio scratch cleaned after success");
      assert.equal(fs.existsSync(target + ".parts"), false, "video scratch cleaned after success");
    });
  } finally {
    try { origin.server.closeAllConnections?.(); } catch { /* none */ }
    await new Promise((r) => { origin.close().then(r); setTimeout(r, 1500); });
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
    // Keep-alive sockets in the global agent would hold this process open.
    http.globalAgent.destroy();
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch2-stream crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
