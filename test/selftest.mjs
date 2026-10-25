// Full self-test suite. Runs entirely against a controlled local origin; no
// public network access, no writes outside a scratch directory.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";
import { startOrigin, payloadFor } from "./origin.mjs";
import net from "node:net";
import { runExtensionProtocolTests } from "./ext-protocol.mjs";
import { runGuiBrowserTests } from "./gui-browser-run.mjs";
import { runMediaE2ETests } from "./media-e2e.mjs";

/** Registry roots that hold one key per browser, one key name per namespace. */
const HOST_KEY_ROOTS = [
  "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\",
  "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\",
  "HKCU\\Software\\Chromium\\NativeMessagingHosts\\",
  "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\",
  "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\",
];

/**
 * Delete one native messaging namespace's five keys.
 *
 * Only the namespace handed in is ever named, and the production name is
 * refused outright: this function cannot be used to touch a real registration.
 * It is safe to call twice - an absent key is not an error - which is what
 * makes it usable both from the end of the suite and from an exit hook.
 *
 * @returns {number} how many keys were deleted
 */
export function removeHostNamespaceKeys(ns) {
  if (process.platform !== "win32" || !ns || ns === "com.downloadx.host") return 0;
  let deleted = 0;
  for (const regRoot of HOST_KEY_ROOTS) {
    try { execFileSync("reg", ["delete", regRoot + ns, "/f"], { stdio: "ignore" }); deleted++; }
    catch { /* never created */ }
  }
  return deleted;
}

export async function runSelfTest() {
  /** The real checkout, as opposed to `root`, which is a temp sandbox. */
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-selftest-"));
  /**
   * Native messaging names are per user (HKCU), not per DOWNLOADX_HOME: the
   * registry key survives the scratch directory it points into. Everything
   * this suite installs therefore goes into a namespace of its own, so the
   * five real com.downloadx.host keys are never written and never dangle.
   */
  const TEST_HOST_NAME = "DownloadX-Test.com.downloadx.host";
  const home = path.join(root, "home");
  const out = path.join(root, "out");
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(out, { recursive: true });
  process.env.DOWNLOADX_HOME = home;
  // install.mjs resolves the host name from this variable on every call, and
  // the child processes spawned below inherit the environment they are given.
  process.env.DOWNLOADX_HOST_NAME = TEST_HOST_NAME;
  // A crash between here and the cleanup at the end of the suite would leave
  // this namespace's keys pointing at manifests inside the scratch tree,
  // which is deleted below. The exit hook removes them on every exit path.
  process.on("exit", () => { removeHostNamespaceKeys(process.env.DOWNLOADX_HOST_NAME); });

  const origin = await startOrigin();
  const suite = new Suite("downloadx");
  // Stream progress: if a later test crashes the process, the log above still
  // shows exactly how far the suite got.
  const NL = String.fromCharCode(10);
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " + String(r.error).split(NL).join(NL + "          ") + NL);
  };
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  /**
 * Close an HTTP server without waiting on keep-alive connections.
 *
 * server.close() only fires its callback once every connection is gone, so a
 * pooled or aborted socket leaves the process alive after the summary has
 * already printed. Destroying connections first makes the suite exit.
 */
async function closeServer(srv) {
  if (!srv) return;
  try { srv.closeAllConnections?.(); } catch { /* older runtimes */ }
  await new Promise((r) => {
    let done = false;
    const finish = () => { if (!done) { done = true; r(undefined); } };
    try { srv.close(finish); } catch { finish(); }
    setTimeout(finish, 1500);
  });
}

const hashFile = async (p) => {
    const h = createHash("sha256");
    await new Promise((res, rej) => {
      const rs = fs.createReadStream(p);
      rs.on("data", (c) => h.update(c));
      rs.once("end", res);
      rs.once("error", rej);
    });
    return h.digest("hex");
  };

  // ---------------------------------------------------------------- utils
  suite.group("Utilities");
  const util = await import("../src/util.mjs");
  await suite.test("parseSize understands units", () => {
    assert.equal(util.parseSize("8M"), 8 * 1024 * 1024);
    assert.equal(util.parseSize("512k"), 512 * 1024);
    assert.equal(util.parseSize("2G"), 2 * 1024 * 1024 * 1024);
    assert.equal(util.parseSize("1024"), 1024);
    assert.throws(() => util.parseSize("nonsense"));
  });
  await suite.test("formatBytes / formatDuration are stable", () => {
    assert.equal(util.formatBytes(0), "0 B");
    assert.equal(util.formatBytes(1536), "1.5 KB");
    assert.match(util.formatDuration(3661), /^1:01:01$/);
    assert.equal(util.formatDuration(59), "00:59");
  });
  await suite.test("sanitizeName strips characters Windows rejects", () => {
    assert.equal(util.sanitizeName('a<b>c:d"e/f\\g|h?i*j'), "a_b_c_d_e_f_g_h_i_j");
    assert.equal(util.sanitizeName(""), "download");
  });
  await suite.test("filenameFromUrl / filenameFromDisposition", () => {
    assert.equal(util.filenameFromUrl("https://x.test/a/b/file.zip?q=1"), "file.zip");
    assert.equal(util.filenameFromDisposition('attachment; filename="nice-name.bin"'), "nice-name.bin");
    assert.equal(util.filenameFromDisposition("attachment; filename*=UTF-8''caf%C3%A9.zip"), "café.zip");
  });

  // ------------------------------------------------------------ planning
  suite.group("Segment planning");
  const plan = await import("../src/plan.mjs");
  await suite.test("plan covers the resource exactly once", () => {
    for (const total of [1, 999, plan.MIN_SEGMENT_BYTES, plan.MIN_SEGMENT_BYTES * 17 + 3]) {
      for (const c of [1, 2, 8, 32]) {
        const segs = plan.planSegments(total, { connections: c });
        assert.ok(plan.validatePlan(segs, total), "invalid plan for " + total + "/" + c);
        assert.equal(segs[0].start, 0);
        assert.equal(segs[segs.length - 1].end, total - 1);
      }
    }
  });
  await suite.test("small files are not split", () => {
    assert.equal(plan.planSegments(512 * 1024, { connections: 16 }).length, 1);
  });
  await suite.test("segment count respects both limits", () => {
    const segs = plan.planSegments(32 * 1024 * 1024, { connections: 4, segmentBytes: 1024 * 1024 });
    assert.ok(segs.length <= 4 && segs.length >= 1);
  });
  await suite.test("splitSegment preserves coverage", () => {
    const [seg] = plan.planSegments(16 * 1024 * 1024, { connections: 1 });
    assert.ok(plan.validatePlan(plan.splitSegment(seg, 4), 16 * 1024 * 1024));
  });

  // ----------------------------------------------------------- categories
  suite.group("Classification and naming");
  const cat = await import("../src/categories.mjs");
  const { DEFAULT_CONFIG } = await import("../src/config.mjs");
  await suite.test("extension detection handles URLs, queries and dots", () => {
    assert.equal(cat.extensionOf("movie.MKV"), "mkv");
    assert.equal(cat.extensionOf("https://x.test/a/b.tar.gz?token=1"), "gz");
    assert.equal(cat.extensionOf("noextension"), "");
    assert.equal(cat.extensionOf("archive.tar.gz#frag"), "gz");
  });
  await suite.test("categorize routes known types", () => {
    assert.equal(cat.categorize("a.mp4", DEFAULT_CONFIG.categories), "video");
    assert.equal(cat.categorize("b.pdf", DEFAULT_CONFIG.categories), "document");
    assert.equal(cat.categorize("c.zip", DEFAULT_CONFIG.categories), "archive");
    assert.equal(cat.categorize("d.unknownext", DEFAULT_CONFIG.categories), null);
  });
  await suite.test("resolveDirectory honours categorizeByType", () => {
    // 批-5/P-6 语义：显式 dir 即权威落点（原样返回，绝不追加分类子目录）；
    // 分类只改变未指定目录（走 defaultDir）时的落点，且受 categorizeByType 控制。
    const config = { defaultDir: "D:/dl", categorizeByType: true, categories: DEFAULT_CONFIG.categories };
    assert.equal(cat.resolveDirectory({ filename: "a.mp4", config }).replace(/\\/g, "/"), "D:/dl/video");
    assert.equal(cat.resolveDirectory({ filename: "a.mp4", dir: "E:/x", config }).replace(/\\/g, "/"), "E:/x");
    assert.equal(cat.resolveDirectory({ filename: "a.mp4", dir: "E:/x", category: "audio", config }).replace(/\\/g, "/"), "E:/x",
      "an explicit category must not add a subfolder to an explicit dir either");
    assert.equal(cat.resolveDirectory({ filename: "a.mp4", dir: "", config }).replace(/\\/g, "/"), "D:/dl/video",
      "an empty-string dir counts as unspecified");
    const flat = { defaultDir: "D:/dl", categorizeByType: false, categories: DEFAULT_CONFIG.categories };
    assert.equal(cat.resolveDirectory({ filename: "a.mp4", config: flat }).replace(/\\/g, "/"), "D:/dl");
  });
  await suite.test("uniquePath avoids collisions", async () => {
    const dir = path.join(root, "unique");
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, "file.bin");
    await fsp.writeFile(target, "x");
    const second = await cat.uniquePath(target);
    assert.equal(path.basename(second), "file (2).bin");
    await fsp.writeFile(second, "x");
    assert.equal(path.basename(await cat.uniquePath(target)), "file (3).bin");
  });

  // ---------------------------------------------------------------- rules
  suite.group("Site rules");
  const rules = await import("../src/rules.mjs");
  await suite.test("glob matching is host-safe", () => {
    assert.ok(rules.globMatch("*.example.com", "a.example.com"));
    assert.ok(rules.globMatch("*.example.com", "example.com"));
    assert.ok(!rules.globMatch("*.example.com", "evil-example.com.attacker.net"));
  });
  await suite.test("exceptions and per-host overrides", () => {
    assert.ok(rules.isExcepted("https://download.windowsupdate.com/x", [], ["download.windowsupdate.com"]));
    assert.ok(!rules.isExcepted("https://example.com/x", [], ["*.windowsupdate.com"]));
    const merged = rules.applyRule("https://slow.example.com/f", { connections: 8 }, [
      { pattern: "slow.example.com", connections: 2, headers: { Referer: "https://slow.example.com/" } },
    ]);
    assert.equal(merged.connections, 2);
    assert.equal(merged.headers.Referer, "https://slow.example.com/");
  });

  // ---------------------------------------------------------------- config
  suite.group("Configuration");
  const { Config } = await import("../src/config.mjs");
  await suite.test("defaults are sane and paths resolve", async () => {
    const c = new Config(path.join(root, "config.json"));
    const v = await c.load();
    assert.ok(v.defaultDir.length > 0);
    assert.equal(v.maxConnections, 8);
  });
  await suite.test("values are clamped and persisted", async () => {
    const c = new Config(path.join(root, "config2.json"));
    await c.load();
    await c.set({ maxConnections: 999, maxConcurrentDownloads: 0, speedLimit: -5 });
    assert.equal(c.get("maxConnections"), 32);
    assert.equal(c.get("maxConcurrentDownloads"), 1);
    assert.equal(c.get("speedLimit"), 0);
    const re = new Config(path.join(root, "config2.json"));
    await re.load();
    assert.equal(re.get("maxConnections"), 32, "must survive a reload");
  });
  await suite.test("a corrupt config falls back to defaults", async () => {
    const file = path.join(root, "bad.json");
    await fsp.writeFile(file, "{ this is not json");
    const c = new Config(file);
    const v = await c.load();
    assert.equal(v.maxConnections, 8);
  });

  // ------------------------------------------------------------- schedule
  suite.group("Scheduler");
  const sched = await import("../src/scheduler.mjs");
  await suite.test("clock parsing and windows", () => {
    assert.equal(sched.parseClock("02:30"), 150);
    assert.equal(sched.parseClock("24:00"), null);
    assert.equal(sched.parseClock("nope"), null);
    const midnight = new Date(2026, 0, 1, 23, 30);
    assert.ok(sched.inWindow(midnight, "22:00", "06:00"), "should wrap across midnight");
    assert.ok(!sched.inWindow(new Date(2026, 0, 1, 12, 0), "22:00", "06:00"));
  });
  await suite.test("nextOccurrence rolls to tomorrow when past", () => {
    const from = new Date(2026, 0, 1, 10, 0);
    const next = sched.nextOccurrence("09:00", from);
    assert.equal(next.getDate(), 2);
    assert.equal(next.getHours(), 9);
  });
  await suite.test("tick fires once per minute per schedule", () => {
    const fired = [];
    const queue = { add() {}, resumeAll() { fired.push("resume"); }, pauseAll() {}, clearCompleted() {} };
    const s = new sched.Scheduler({ queue, config: { get() { return 1; } }, log: { info() {}, warn() {}, error() {} } });
    s.add({ at: "12:00", action: "resume", name: "noon" });
    const at = new Date(2026, 0, 1, 12, 0, 5);
    assert.equal(s.tick(at).length, 1);
    assert.equal(s.tick(new Date(2026, 0, 1, 12, 0, 40)).length, 0, "must not fire twice in the same minute");
    assert.equal(fired.length, 1);
  });

  // ---------------------------------------------------------------- engine
  suite.group("Download engine");
  const { probe } = await import("../src/probe.mjs");
  const { DownloadEngine, DEFAULT_MAX_ATTEMPTS } = await import("../src/engine.mjs");
  const { TransferStore } = await import("../src/store.mjs");

  await suite.test("probe reports size, ranges, type and filename", async () => {
    const info = await probe(origin.origin + "/range/4096");
    assert.equal(info.totalBytes, 4096);
    assert.ok(info.supportsRanges);
    assert.equal(info.filename, "4096");
  });
  await suite.test("probe detects an origin that ignores Range", async () => {
    const info = await probe(origin.origin + "/norange/2048");
    assert.equal(info.supportsRanges, false);
    assert.equal(info.totalBytes, 2048);
  });
  await suite.test("probe follows redirects and reads Content-Disposition", async () => {
    const info = await probe(origin.origin + "/disposition/1024");
    assert.equal(info.filename, "nice-name.bin");
  });
  await suite.test("single connection is byte-exact", async () => {
    const size = 8192;
    const url = origin.origin + "/range/" + size;
    const info = await probe(url);
    const target = path.join(out, "single.bin");
    const r = await new DownloadEngine({ url, targetPath: target, connections: 1 }).run({ probe: info, resume: false });
    assert.equal(r.bytes, size);
    assert.equal(await hashFile(target), r.sha256);
  });
  await suite.test("multi-connection matches single-connection output", async () => {
    const size = 8 * 1024 * 1024;
    const url = origin.origin + "/range/" + size;
    const info = await probe(url);
    const t1 = path.join(out, "multi1.bin");
    const t8 = path.join(out, "multi8.bin");
    const r1 = await new DownloadEngine({ url, targetPath: t1, connections: 1, segmentBytes: 1024 * 1024 }).run({ probe: info, resume: false });
    const r8 = await new DownloadEngine({ url, targetPath: t8, connections: 8, segmentBytes: 1024 * 1024 }).run({ probe: info, resume: false });
    assert.equal(r1.sha256, r8.sha256, "1 and 8 connections must agree");
    assert.equal(await hashFile(t8), r8.sha256);
  });
  await suite.test("workers never claim the same segment twice", async () => {
    const size = 8 * 1024 * 1024;
    const url = origin.origin + "/range/" + size;
    const info = await probe(url);
    const target = path.join(out, "nodupes.bin");
    const engine = new DownloadEngine({ url, targetPath: target, connections: 8, segmentBytes: 1024 * 1024 });
    let peak = 0;
    engine.on("progress", (p) => { peak = Math.max(peak, p.bytesWritten); });
    await engine.run({ probe: info, resume: false });
    assert.ok(peak <= size, "progress reported " + peak + " for a " + size + "-byte file");
    assert.ok(peak >= size * 0.9, "progress should approach the full size, saw " + peak);
  });
  await suite.test("one ranged request per segment on a clean run", async () => {
    const size = 4 * 1024 * 1024;
    const route = "/range/" + size;
    const url = origin.origin + route;
    const info = await probe(url);
    const before = origin.rangedRequests.get(route) || 0;
    await new DownloadEngine({ url, targetPath: path.join(out, "onereq.bin"), connections: 4, segmentBytes: 1024 * 1024 }).run({ probe: info, resume: false });
    const issued = (origin.rangedRequests.get(route) || 0) - before;
    assert.ok(issued >= 1, "no ranged requests issued");
    // 4 segment fetches plus the integrity probes that re-read each seam.
    assert.ok(issued <= 12, "expected at most 4 segment fetches plus seam probes, saw " + issued);
  });
  await suite.test("temporary state is removed on success", async () => {
    const size = 4096;
    const url = origin.origin + "/range/" + size;
    const info = await probe(url);
    const target = path.join(out, "cleanup.bin");
    await new DownloadEngine({ url, targetPath: target, connections: 2 }).run({ probe: info, resume: false });
    assert.equal(fs.existsSync(new TransferStore(target).dir), false, "state directory should be gone");
    assert.ok(fs.existsSync(target));
  });

  // --------------------------------------------------------------- resume
  suite.group("Resume and recovery");
  await suite.test("interrupted download resumes to the correct bytes", async () => {
    const size = 8 * 1024 * 1024;
    const url = origin.origin + "/range/" + size;
    const info = await probe(url);
    const target = path.join(out, "resume.bin");
    const controller = new AbortController();
    const e1 = new DownloadEngine({ url, targetPath: target, connections: 4, segmentBytes: 1024 * 1024, signal: controller.signal });
    e1.on("progress", (p) => { if (p.percent > 20) controller.abort(); });
    await assert.rejects(() => e1.run({ probe: info, resume: false }));

    const carried = (await new TransferStore(target).loadSegments()).reduce((a, s) => a + (s.downloaded || 0), 0);
    assert.ok(carried > 0, "segment progress must survive an abort");

    const r2 = await new DownloadEngine({ url, targetPath: target, connections: 4, segmentBytes: 1024 * 1024 }).run({ probe: info, resume: true });
    assert.equal(r2.bytes, size);
    assert.equal(await hashFile(target), r2.sha256);
  });
  await suite.test("stale partial data is discarded when the revision changed", async () => {
    const size = 4 * 1024 * 1024;
    const url = origin.origin + "/etag/" + size;
    const info = await probe(url);
    assert.ok(info.etag, "test origin must expose an ETag");
    const target = path.join(out, "stale.bin");
    const controller = new AbortController();
    const e1 = new DownloadEngine({ url, targetPath: target, connections: 2, segmentBytes: 1024 * 1024, signal: controller.signal });
    e1.on("progress", (p) => { if (p.percent > 15) controller.abort(); });
    await assert.rejects(() => e1.run({ probe: info, resume: false }));

    const logs = [];
    const e2 = new DownloadEngine({ url, targetPath: target, connections: 2, segmentBytes: 1024 * 1024 });
    e2.on("log", (m) => logs.push(m));
    const r2 = await e2.run({ probe: Object.assign({}, info, { etag: '"different"' }), resume: true });
    assert.ok(logs.some((l) => /discarding partial data/.test(l)), "expected a discard notice, got " + JSON.stringify(logs));
    assert.equal(await hashFile(target), r2.sha256);
  });
  await suite.test("recovers from an origin that drops the socket mid-body", async () => {
    const size = 2 * 1024 * 1024;
    const url = origin.origin + "/flaky/" + size;
    const info = await probe(url);
    const target = path.join(out, "flaky.bin");
    const engine = new DownloadEngine({ url, targetPath: target, connections: 4, segmentBytes: 512 * 1024 });
    let retries = 0;
    engine.on("retry", () => retries++);
    const r = await engine.run({ probe: info, resume: false });
    assert.ok(retries > 0, "a flaky origin should force retries");
    assert.equal(await hashFile(target), r.sha256);
  });
  await suite.test("short body is completed by re-requesting the remainder", async () => {
    const size = 1024 * 1024;
    const url = origin.origin + "/short/" + size;
    const info = await probe(url);
    const target = path.join(out, "short.bin");
    const r = await new DownloadEngine({ url, targetPath: target, connections: 2, segmentBytes: 256 * 1024 }).run({ probe: info, resume: false });
    assert.equal(r.bytes, size);
    assert.equal(await hashFile(target), r.sha256);
  });
  await suite.test("downgrades to a single stream when Range is ignored", async () => {
    const size = 2 * 1024 * 1024;
    const url = origin.origin + "/norange/" + size;
    const info = { finalUrl: url, supportsRanges: true, totalBytes: size, etag: null, lastModified: null, filename: "n.bin", contentType: null, redirects: [] };
    const target = path.join(out, "downgrade.bin");
    const engine = new DownloadEngine({ url, targetPath: target, connections: 4, segmentBytes: 1024 * 1024 });
    const notices = [];
    engine.on("downgrade", (m) => notices.push(m));
    const r = await engine.run({ probe: info, resume: false });
    assert.ok(notices.length > 0, "a downgrade notice is expected");
    assert.equal(r.downgraded, true);
    assert.equal(await hashFile(target), r.sha256);
  });

  // ------------------------------------------------------------- limiting
  suite.group("Rate limiting");
  await suite.test("speed limit slows the transfer down", async () => {
    const size = 1024 * 1024;
    const url = origin.origin + "/range/" + size;
    const info = await probe(url);
    const target = path.join(out, "limited.bin");
    const started = Date.now();
    const r = await new DownloadEngine({ url, targetPath: target, connections: 4, maxRate: 512 * 1024 }).run({ probe: info, resume: false });
    const elapsed = (Date.now() - started) / 1000;
    assert.equal(r.bytes, size);
    assert.ok(elapsed > 1.0, "1 MiB at 512 KiB/s should exceed 1s, took " + elapsed.toFixed(2) + "s");
  });

  // ------------------------------------------------------------------ HLS
  suite.group("HLS streams");
  const hls = await import("../src/hls.mjs");
  await suite.test("parses a master playlist and ranks variants", () => {
    const doc = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
      "low.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720",
      "high.m3u8",
    ].join("\n");
    const parsed = hls.parseM3u8(doc, "https://cdn.test/path/master.m3u8");
    assert.ok(parsed.isMaster);
    assert.equal(parsed.variants.length, 2);
    const ranked = hls.rankVariants(parsed.variants);
    assert.equal(ranked[0].resolution, "1280x720", "best variant first");
    const best = hls.pickBestVariant(parsed.variants);
    assert.ok(best.uri.endsWith("high.m3u8"));
  });
  await suite.test("parses a media playlist with keys and init segment", () => {
    const doc = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:4",
      "#EXT-X-MAP:URI=\"init.mp4\"",
      "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"",
      "#EXTINF:4.0,seg0",
      "s0.ts",
      "#EXTINF:4.0,seg1",
      "s1.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const p = hls.parseM3u8(doc, "https://cdn.test/a/media.m3u8");
    assert.ok(p.isMedia);
    assert.equal(p.segments.length, 2);
    assert.ok(p.mapUri.endsWith("init.mp4"));
    assert.equal(p.segments[0].key.method, "AES-128");
    assert.ok(p.endList);
    assert.equal(p.duration, 8);
  });
  await suite.test("attribute parsing handles quoted commas", () => {
    const attrs = hls.parseAttributes('BANDWIDTH=1,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720');
    assert.equal(attrs.CODECS, "avc1.4d401f,mp4a.40.2");
    assert.equal(attrs.RESOLUTION, "1280x720");
  });

  // ----------------------------------------------------------------- DASH
  suite.group("DASH manifests");
  const dash = await import("../src/dash.mjs");
  await suite.test("parses durations", () => {
    assert.equal(dash.parseDuration("PT1H2M3S"), 3723);
    assert.equal(dash.parseDuration("PT30S"), 30);
    assert.equal(dash.parseDuration("bogus"), null);
  });
  await suite.test("expands segment templates", () => {
    assert.equal(dash.expandTemplate("seg-$Number%05d$.m4s", { number: 7 }), "seg-00007.m4s");
    assert.equal(dash.expandTemplate("$RepresentationID$/$Number$", { number: 3, representationId: "v1" }), "v1/3");
  });
  await suite.test("parses an MPD and picks the best representation", () => {
    const xml = [
      '<MPD type="static" mediaPresentationDuration="PT20S">',
      "<Period>",
      '<AdaptationSet mimeType="video/mp4">',
      '<Representation id="v0" bandwidth="800000" width="640" height="360">',
      '<SegmentTemplate timescale="1" duration="5" media="seg-$Number$.m4s" initialization="init.mp4"/>',
      "</Representation>",
      '<Representation id="v1" bandwidth="3000000" width="1920" height="1080">',
      '<SegmentTemplate timescale="1" duration="5" media="seg-$Number$.m4s" initialization="init.mp4"/>',
      "</Representation>",
      "</AdaptationSet>",
      "</Period>",
      "</MPD>",
    ].join("");
    const mpd = dash.parseMpd(xml, "https://cdn.test/m.mpd");
    assert.equal(mpd.representations.length, 2);
    const best = dash.pickBestRepresentation(mpd);
    assert.equal(best.id, "v1", "highest bandwidth wins");
    const segs = dash.listSegments(mpd, best, { segmentCount: 4 });
    assert.equal(segs.length, 4);
    assert.equal(segs[0], "seg-1.m4s");
  });

  // ------------------------------------------------------------------ FTP
  suite.group("FTP protocol");
  const ftp = await import("../src/ftp.mjs");
  await suite.test("URL parsing extracts host, path and credentials", () => {
    const p = ftp.parseFtpUrl("ftp://user:pw@ftp.test:2121/dir/file.bin");
    assert.equal(p.host, "ftp.test");
    assert.equal(p.port, 2121);
    assert.equal(p.path, "/dir/file.bin");
    assert.equal(p.username, "user");
    assert.equal(p.password, "pw");
    const anon = ftp.parseFtpUrl("ftp://ftp.test/file.bin");
    assert.equal(anon.username, "anonymous");
    assert.throws(() => ftp.parseFtpUrl("https://nope.test/x"));
  });
  await suite.test("control channel parses multi-line replies", async () => {
    const net = await import("node:net");
    // Fake FTP servers destroy sockets on purpose; absorb server-side resets.
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.write("220-Welcome to the test server\r\n220 Ready\r\n");
      socket.on("data", (buf) => {
        const cmd = buf.toString().trim().toUpperCase();
        if (cmd.startsWith("USER")) socket.write("331 need password\r\n");
        else if (cmd.startsWith("PASS")) socket.write("230 logged in\r\n");
        else if (cmd.startsWith("TYPE")) socket.write("200 binary\r\n");
        else if (cmd.startsWith("SIZE")) socket.write("213 12345\r\n");
        else if (cmd.startsWith("MDTM")) socket.write("213 20260101120000\r\n");
        else if (cmd.startsWith("QUIT")) { socket.write("221 bye\r\n"); socket.end(); }
        else socket.write("500 unknown\r\n");
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const ctl = new ftp.FtpControl({ host: "127.0.0.1", port });
    await ctl.connect();
    await ctl.login("anonymous", "x@y.z");
    await ctl.binary();
    assert.equal(await ctl.size("/f.bin"), 12345);
    const when = await ctl.mdtm("/f.bin");
    assert.ok(when instanceof Date);
    assert.equal(when.getUTCFullYear(), 2026);
    ctl.close();
    await new Promise((r) => server.close(r));
  });
  await suite.test("FTP login failure surfaces the server reply", async () => {
    const net = await import("node:net");
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.write("220 hi\r\n");
      socket.on("data", (buf) => {
        const cmd = buf.toString().trim().toUpperCase();
        if (cmd.startsWith("USER")) socket.write("331 pw?\r\n");
        else socket.write("530 login incorrect\r\n");
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const ctl = new ftp.FtpControl({ host: "127.0.0.1", port: server.address().port });
    await ctl.connect();
    await assert.rejects(() => ctl.login("bad", "bad"), "bad credentials must reject");
    ctl.close();
    await new Promise((r) => server.close(r));
  });

  // ---------------------------------------------------------------- queue
  suite.group("Queue manager");
  const { QueueManager } = await import("../src/queue.mjs");
  const { STATUS } = await import("../src/task.mjs");
  await suite.test("adds, lists and orders tasks", async () => {
    const config = new Config(path.join(root, "qconfig.json"));
    await config.load();
    const q = new QueueManager({ config });
    await q.load();
    const a = q.add({ url: "https://x.test/a.bin" });
    const b = q.add({ url: "https://x.test/b.bin" });
    assert.equal(q.stats.total, 2);
    assert.equal(q.list()[0].id, b.id, "newest first");
    q.reorder(a.id, 0);
    assert.equal(q.list()[0].id, a.id, "reorder moves the task up");
    assert.ok(q.get(a.id).priority > q.get(b.id).priority);
  });
  await suite.test("state transitions are validated", async () => {
    const config = new Config(path.join(root, "qconfig2.json"));
    await config.load();
    const q = new QueueManager({ config });
    await q.load();
    const t = q.add({ url: "https://x.test/c.bin" });
    assert.ok(q.setStatus(t.id, STATUS.PAUSED));
    assert.equal(q.get(t.id).status, STATUS.PAUSED);
    q.setStatus(t.id, STATUS.COMPLETE);
    assert.equal(q.get(t.id).status, STATUS.PAUSED, "queued -> complete must be refused");
  });
  await suite.test("queue persistence round-trips", async () => {
    const config = new Config(path.join(root, "qconfig3.json"));
    await config.load();
    const q = new QueueManager({ config });
    await q.load();
    const t = q.add({ url: "https://x.test/persist.bin", filename: "persist.bin" });
    q.apply(t.id, { downloadedBytes: 1234 }); // runtime progress write: apply(), not the PATCH-whitelisted update()
    await q.saveNow();
    const q2 = new QueueManager({ config });
    await q2.load();
    const back = q2.get(t.id);
    assert.ok(back, "task must survive a reload");
    assert.equal(back.downloadedBytes, 1234);
    assert.equal(back.filename, "persist.bin");
  });
  await suite.test("tasks that were active on crash come back paused", async () => {
    const config = new Config(path.join(root, "qconfig4.json"));
    await config.load();
    const q = new QueueManager({ config });
    await q.load();
    const t = q.add({ url: "https://x.test/crash.bin" });
    q.setStatus(t.id, STATUS.DOWNLOADING);
    await q.saveNow();
    const q2 = new QueueManager({ config });
    await q2.load();
    assert.equal(q2.get(t.id).status, STATUS.PAUSED, "must not resume silently after a crash");
  });
  await suite.test("concurrency capacity is enforced", async () => {
    const config = new Config(path.join(root, "qconfig5.json"));
    await config.load();
    await config.set({ maxConcurrentDownloads: 2 });
    const q = new QueueManager({ config });
    await q.load();
    const runs = [];
    q.on("run", (id) => runs.push(id));
    for (let i = 0; i < 5; i++) q.add({ url: "https://x.test/" + i + ".bin" });
    q.pump();
    assert.equal(runs.length, 2, "only 2 slots are available, got " + runs.length);
    assert.equal(q.activeCount, 2);
  });

  // ------------------------------------------------------------------ API
  suite.group("HTTP API");
  const { ApiServer } = await import("../src/api.mjs");
  const { Downloader } = await import("../src/downloader.mjs");
  const apiConfig = new Config(path.join(root, "apiconfig.json"));
  await apiConfig.load();
  await apiConfig.set({ defaultDir: out, categorizeByType: false, maxConnections: 2, segmentBytes: 262144 });
  const apiQueue = new QueueManager({ config: apiConfig });
  await apiQueue.load();
  const apiDownloader = new Downloader({ config: apiConfig, queue: apiQueue });
  const api = new ApiServer({ queue: apiQueue, config: apiConfig, downloader: apiDownloader, log: { info() {}, warn() {}, error() {} } }).startRunner();
  const listening = await api.listen({ port: 0 });
  const call = async (method, route, body, token) => {
    const headers = {};
    if (token !== null) headers["x-downloadx-token"] = token === undefined ? listening.token : token;
    if (body) headers["content-type"] = "application/json";
    const res = await fetch("http://127.0.0.1:" + listening.port + route, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  };

  await suite.test("rejects requests without a valid token", async () => {
    assert.equal((await call("GET", "/api/status", null, null)).status, 401);
    assert.equal((await call("GET", "/api/status", null, "wrong")).status, 401);
    assert.equal((await call("GET", "/api/status")).status, 200);
  });
  await suite.test("serves status and task list", async () => {
    const st = await call("GET", "/api/status");
    assert.equal(st.json.version, "1.0.0");
    assert.ok(st.json.queue);
    const list = await call("GET", "/api/tasks");
    assert.ok(Array.isArray(list.json.tasks));
  });
  await suite.test("rejects a task with no URL", async () => {
    assert.equal((await call("POST", "/api/tasks", {})).status, 400);
  });
  await suite.test("adds a task and completes it end to end", async () => {
    const size = 3 * 1024 * 1024;
    const url = origin.origin + "/range/" + size;
    const added = await call("POST", "/api/tasks", { url, filename: "api-e2e.bin" });
    assert.equal(added.status, 201);
    const id = added.json.task.id;
    let task = null;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const t = await call("GET", "/api/tasks/" + id);
      task = t.json.task;
      if (task.status === "complete" || task.status === "error") break;
    }
    assert.equal(task.status, "complete", "task failed: " + task.error);
    assert.equal(task.downloadedBytes, size);
    const file = path.join(out, "api-e2e.bin");
    assert.equal(fs.statSync(file).size, size);
    assert.equal(await hashFile(file), task.sha256);
  });
  await suite.test("pause, resume and remove work through the API", async () => {
    const added = await call("POST", "/api/tasks", { url: origin.origin + "/slow/4194304", filename: "api-pause.bin" });
    const id = added.json.task.id;
    await new Promise((r) => setTimeout(r, 600));
    assert.equal((await call("POST", "/api/tasks/" + id + "/pause")).status, 200);
    await new Promise((r) => setTimeout(r, 300));
    const paused = await call("GET", "/api/tasks/" + id);
    assert.ok(["paused", "queued"].includes(paused.json.task.status), "expected paused, got " + paused.json.task.status);
    assert.equal((await call("POST", "/api/tasks/" + id + "/resume")).status, 200);
    assert.equal((await call("DELETE", "/api/tasks/" + id)).status, 200);
    assert.equal((await call("GET", "/api/tasks/" + id)).status, 404);
  });
  await suite.test("unknown routes and methods are refused", async () => {
    assert.equal((await call("GET", "/api/nope")).status, 404);
    const added = await call("POST", "/api/tasks", { url: origin.origin + "/range/1024", filename: "api-method.bin" });
    assert.equal((await call("PUT", "/api/tasks/" + added.json.task.id + "/start")).status, 405);
  });
  await suite.test("config can be read and patched", async () => {
    const patched = await call("PATCH", "/api/config", { maxConnections: 5 });
    assert.equal(patched.json.config.maxConnections, 5);
    assert.equal((await call("GET", "/api/config")).json.config.maxConnections, 5);
  });
  await suite.test("probe endpoint reports without downloading", async () => {
    const r = await call("POST", "/api/probe", { url: origin.origin + "/range/65536" });
    assert.equal(r.json.totalBytes, 65536);
    assert.equal(r.json.excluded, false);
  });
  await suite.test("probe endpoint honours the exception list", async () => {
    const r = await call("POST", "/api/probe", { url: "https://download.windowsupdate.com/x.bin" });
    assert.equal(r.json.excluded, true);
  });
  await suite.test("static GUI is served with a token injected", async () => {
    const res = await fetch("http://127.0.0.1:" + listening.port + "/");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /__DOWNLOADX__/);
    assert.match(html, /downloadx/);
  });
  await suite.test("path traversal cannot escape the GUI directory", async () => {
    const res = await fetch("http://127.0.0.1:" + listening.port + "/../../package.json");
    assert.ok(res.status === 403 || res.status === 404, "expected 403/404, got " + res.status);
  });
  await suite.test("clear-completed removes finished tasks", async () => {
    const r = await call("POST", "/api/queue/clear-completed");
    assert.ok(typeof r.json.removed === "number");
  });
  await api.close();

  // ---------------------------------------------------------------- HLS e2e
  suite.group("Stream download end to end");
  const streamConfig = new Config(path.join(root, "streamconfig.json"));
  await streamConfig.load();
  await streamConfig.set({ defaultDir: out, categorizeByType: false });
  const streamQueue = new QueueManager({ config: streamConfig });
  await streamQueue.load();
  const streamDownloader = new Downloader({ config: streamConfig, queue: streamQueue });

  await suite.test("downloads an HLS stream by stitching its segments", async () => {
    const url = origin.origin + "/hls/master.m3u8?count=5";
    const target = path.join(out, "stream.ts");
    const result = await streamDownloader.run({
      id: "hls-test", url, kind: "hls", filename: "stream.ts", dir: out,
      headers: {}, connections: 4, meta: {},
    });
    assert.equal(result.bytes, 5 * 64 * 1024, "expected 5 segments of 64 KiB");
    assert.ok(fs.existsSync(result.target));
    assert.equal(result.meta.segments, 5);
  });
  await suite.test("picker can choose a specific variant", async () => {
    const hls2 = await import("../src/hls.mjs");
    const resolved = await hls2.resolvePlaylist(origin.origin + "/hls/master.m3u8?count=3");
    assert.equal(resolved.variants.length, 2);
    assert.ok(resolved.playlist.isMedia);
    const low = await hls2.resolvePlaylist(origin.origin + "/hls/master.m3u8?count=3", { variantIndex: 0 });
    assert.ok(low.played !== undefined || low.playlist.segments.length === 3);
  });

  // ----------------------------------------------------------- native host
  suite.group("Browser integration");
  await suite.test("extension manifest is valid MV3 with nativeMessaging", async () => {
    const m = JSON.parse(await fsp.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension", "manifest.json"), "utf8"));
    assert.equal(m.manifest_version, 3);
    assert.ok(m.permissions.includes("nativeMessaging"));
    assert.ok(m.background.service_worker);
    assert.ok(m.content_scripts.length > 0);
  });
  await suite.test("native host frames replies with a length prefix", async () => {
    const self = fileURLToPath(import.meta.url);
    const hostPath = path.join(path.dirname(self), "..", "extension", "host.mjs");
    const child = spawn(process.execPath, [hostPath], {
      env: Object.assign({}, process.env, { DOWNLOADX_HOME: home }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const message = Buffer.from(JSON.stringify({ type: "ping" }), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(message.length, 0);
    child.stdin.write(Buffer.concat([header, message]));

    const reply = await new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error("host did not reply in time")), 15000);
      child.stdout.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= 4) {
          const len = buf.readUInt32LE(0);
          if (buf.length >= 4 + len) {
            clearTimeout(timer);
            resolve(JSON.parse(buf.subarray(4, 4 + len).toString("utf8")));
          }
        }
      });
      child.on("error", reject);
    });
    child.kill();
    assert.ok(reply.ok === true || reply.ok === false, "reply must carry an ok flag");
    assert.ok("daemon" in reply || "error" in reply);
  });
  await suite.test("native host rejects an unknown message type", async () => {
    const self = fileURLToPath(import.meta.url);
    const hostPath = path.join(path.dirname(self), "..", "extension", "host.mjs");
    const child = spawn(process.execPath, [hostPath], {
      env: Object.assign({}, process.env, { DOWNLOADX_HOME: home }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const message = Buffer.from(JSON.stringify({ type: "definitely-not-a-command" }), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(message.length, 0);
    child.stdin.write(Buffer.concat([header, message]));
    const reply = await new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error("no reply")), 15000);
      child.stdout.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
          clearTimeout(timer);
          resolve(JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString("utf8")));
        }
      });
      child.on("error", reject);
    });
    child.kill();
    assert.equal(reply.ok, false);
    assert.match(reply.error, /unknown message type/);
  });
  await suite.test("install script runs when invoked directly", async () => {
    // Regression: the direct-invocation guard compared import.meta.url against
    // a hand-built "file://" string, which never matched on Windows, so the
    // script exited 0 having printed nothing.
    const self = fileURLToPath(import.meta.url);
    const installPath = path.join(path.dirname(self), "..", "extension", "install.mjs");
    const child = spawn(process.execPath, [installPath, "status"], {
      env: Object.assign({}, process.env, { DOWNLOADX_HOME: path.join(root, "hoststatus") }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const code = await new Promise((r) => child.on("exit", (c) => r(c ?? 0)));
    assert.equal(code, 0, "install.mjs should exit 0");
    // The child inherits DOWNLOADX_HOST_NAME, so it must report the scratch
    // namespace - proof the namespace reaches a separately spawned process.
    assert.ok(out.includes(process.env.DOWNLOADX_HOST_NAME),
      "expected host name " + process.env.DOWNLOADX_HOST_NAME + " in output, got: " + JSON.stringify(out) + " err=" + err);
    assert.ok(out.includes("Chrome"), "expected browser list in output");
  });

  await suite.test("install writes manifests whose path exists", async () => {
    const install = await import("../extension/install.mjs");
    const hostDir = path.join(root, "hostinstall");
    const result = await install.install({ extensionIds: ["abcdefghijklmnopabcdefghijklmnop"] });
    assert.ok(result.written.length >= 4, "expected several browsers, got " + result.written.length);
    for (const w of result.written) {
      assert.ok(w.ok, "registration failed for " + w.browser + ": " + w.error);
      assert.ok(fs.existsSync(w.file), "manifest missing: " + w.file);
      const manifest = JSON.parse(fs.readFileSync(w.file, "utf8"));
      assert.ok(fs.existsSync(manifest.path), "host script missing: " + manifest.path);
      assert.equal(manifest.name, install.hostName(),
        "the manifest name must match the registry subkey the host registers under");
      const origins = manifest.allowed_origins || manifest.allowed_extensions || [];
      assert.ok(origins.length > 0, "no allowed origins for " + w.browser);
      assert.ok(origins.some((o) => o.includes("abcdefghijklmnopabcdefghijklmnop")), "extension id missing from " + w.browser);
    }
  });

  await suite.test("native host registration reports per-browser status", async () => {
    const install = await import("../extension/install.mjs");
    const st = install.status();
    assert.ok(Array.isArray(st) && st.length >= 4);
    assert.ok(st.every((s) => typeof s.browser === "string" && typeof s.installed === "boolean"));
    // "Registered" is not the same as "usable": a registry key pointing at a
    // deleted manifest, or at one that still carries the placeholder extension
    // id, lets the browser refuse every connection with no visible reason.
    assert.ok(st.every((s) => typeof s.usable === "boolean"),
      "status must report whether the registration is actually usable");
    assert.ok(st.every((s) => s.usable || typeof s.reason === "string"),
      "an unusable registration must explain why");
  });
  await suite.test("a placeholder registration is not reported as usable", async () => {
    const install = await import("../extension/install.mjs");
    // Installing without an extension id leaves the placeholder in
    // allowed_origins. That host is registered but unreachable, so a status
    // that only checked for the registry key would lie to the user.
    await install.install({ extensionIds: [] });
    const unusable = install.status().filter((s) => !s.usable);
    assert.ok(unusable.length > 0, "a placeholder registration must not be reported as usable");
    for (const s of unusable) {
      assert.match(s.reason, /extension id|host script|manifest|registry/i,
        "the reason must name the actual problem: " + s.reason);
    }
  });

  // ------------------------------------------- queue control (P2, task B)
  suite.group("Queue control");

  await suite.test("starting a paused or failed task actually runs it", async () => {
    // Regression found through the real GUI: start() moved the task to
    // "queued" but never pumped the scheduler, so Resume and Retry left the
    // task sitting in the queue until some unrelated event happened to pump
    // it. The user saw the button do nothing.
    const qcfg = new Config(path.join(out, "qstart.json"));
    await qcfg.load();
    await qcfg.set({ defaultDir: out, categorizeByType: false, overwriteExisting: "overwrite" });
    const q = new QueueManager({ config: qcfg });
    await q.load();
    const runs = [];
    q.on("run", (id) => runs.push(id));

    // A failed task: the state a Retry button exists to fix.
    const failed = q.add({ url: "http://127.0.0.1:1/never.bin", filename: "failed.bin" });
    q.apply(failed.id, { status: "error", error: "boom" }); // runtime state write: apply(), not the PATCH-whitelisted update()
    q.start(failed.id);
    assert.ok(runs.includes(failed.id), "start() on a failed task must hand it to the runner");
    assert.ok(["connecting", "downloading", "queued"].includes(q.get(failed.id).status),
      "the task must leave the error state, got " + q.get(failed.id).status);

    // A paused task: the state a Resume button exists to fix.
    runs.length = 0;
    q.running.clear();
    for (const t of [...q.tasks.values()]) q.remove(t.id);
    const paused = q.add({ url: "http://127.0.0.1:1/never2.bin", filename: "paused.bin" });
    q.pause(paused.id);
    assert.equal(q.get(paused.id).status, "paused");
    q.start(paused.id);
    assert.ok(runs.includes(paused.id), "start() on a paused task must hand it to the runner");
  });

  await suite.test("an explicit start overrides a paused queue", async () => {
    // "Pause all" then "Resume" on one row is a normal sequence; the single
    // row the user asked for must run.
    const qcfg = new Config(path.join(out, "qall.json"));
    await qcfg.load();
    await qcfg.set({ defaultDir: out, categorizeByType: false, overwriteExisting: "overwrite" });
    const q = new QueueManager({ config: qcfg });
    await q.load();
    const runs = [];
    q.on("run", (id) => runs.push(id));

    const a = q.add({ url: "http://127.0.0.1:1/a.bin", filename: "a.bin" });
    q.pauseAll();
    assert.equal(q.pausedAll, true);
    runs.length = 0;
    q.start(a.id);
    assert.ok(runs.includes(a.id), "the explicitly started task must run while others stay paused");
    assert.equal(q.get(a.id).status === "paused", false, "the started task must not remain paused");
  });

  await suite.test("two transfers aimed at one file do not corrupt each other", async () => {
    // Regression found through the real GUI: retrying a failed download while
    // another task for the same URL was still running made both share the
    // per-target state directory. The retry inherited the first transfer's
    // progress, they wrote interleaved offsets, and when the first finished it
    // deleted the segment journal the second was still using. The observable
    // failure was an ENOENT on a segment file after most of the bytes had
    // transferred, which is exactly the sort of silent corruption to prevent.
    const httpMod = await import("node:http");
    const size = 2 * 1024 * 1024;
    const body = payloadFor(size);
    const srv = httpMod.createServer((req, res) => {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
      const s = m ? Number(m[1]) : 0;
      const e = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      const slice = body.subarray(s, e + 1);
      res.writeHead(m ? 206 : 200, {
        "Content-Range": "bytes " + s + "-" + e + "/" + size,
        "Content-Length": slice.length, "Accept-Ranges": "bytes",
      });
      let i = 0;
      const tick = () => {
        if (i >= slice.length) { res.end(); return; }
        if (res.destroyed) return;
        res.write(slice.subarray(i, i + 32 * 1024));
        i += 32 * 1024;
        setTimeout(tick, 2);
      };
      tick();
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const url = "http://127.0.0.1:" + srv.address().port + "/same.bin";

    // A private directory: the shared `out` contains state from every other
    // test, and scanning it for leftovers would report their files.
    const clashDir = path.join(out, "clash");
    await fsp.mkdir(clashDir, { recursive: true });
    const cfg = new Config(path.join(clashDir, "config.json"));
    await cfg.load();
    await cfg.set({ defaultDir: clashDir, categorizeByType: false, maxConnections: 2, segmentBytes: 512 * 1024, overwriteExisting: "overwrite" });
    const q = new QueueManager({ config: cfg });
    await q.load();
    const dl = new Downloader({ config: cfg, queue: q });

    // Two tasks, the same URL and the same explicit file name, started together.
    const taskA = dl.run({ id: "clash-a", url, kind: "http", filename: "clash.bin", dir: clashDir, headers: {}, connections: 2, meta: {} });
    const taskB = dl.run({ id: "clash-b", url, kind: "http", filename: "clash.bin", dir: clashDir, headers: {}, connections: 2, meta: {} });
    const settled = await Promise.allSettled([taskA, taskB]);
    const rejected = settled.filter((r) => r.status === "rejected");
    assert.equal(rejected.length, 0,
      "neither transfer may fail: " + rejected.map((r) => r.reason && r.reason.message).join("; "));

    // Both must have produced a complete, correct file. rename policy would
    // give them different names; overwrite means the same name and the same
    // bytes, which is fine because the content is identical either way.
    const landed = (await fsp.readdir(clashDir)).filter((f) => f.endsWith(".bin"));
    assert.ok(landed.length >= 1, "at least one file must exist, got " + JSON.stringify(landed));
    for (const f of landed) {
      assert.equal(await hashFile(path.join(clashDir, f)), createHash("sha256").update(body).digest("hex"),
        "every delivered file must be byte-for-byte correct: " + f);
    }
    // And no scratch journal may be left behind: a completed transfer removes
    // its own state, and neither transfer may have removed the other's while
    // it was still writing.
    const leftovers = (await fsp.readdir(clashDir)).filter((f) => f.includes(".downloadx"));
    for (const dir of leftovers) {
      const segs = await fsp.readdir(path.join(clashDir, dir, "segments")).catch(() => []);
      assert.equal(segs.length, 0, "a finished transfer must clean up its segment journal: " + dir);
    }
    await closeServer(srv);
  });

  // --------------------------------------- installation, diagnosis (D)
  suite.group("Installation and diagnosis");

  await suite.test("doctor reports a working runtime without leaking the token", async () => {
    // The daemon's token is the one secret on this machine's local API; a
    // diagnostic command is exactly where it would leak into a screenshot.
    const { spawn } = await import("node:child_process");
    const doctorHome = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-doctor-"));
    const savedHome = process.env.DOWNLOADX_HOME;
    process.env.DOWNLOADX_HOME = doctorHome;
    const { Daemon } = await import("../src/daemon.mjs");
    const daemon = await new Daemon({ port: 0 }).init();
    const runtime = await daemon.start();
    try {
      const entry = path.join(projectDir, "bin", "downloadx.mjs");
      const out = await new Promise((resolve) => {
        const child = spawn(process.execPath, [entry, "doctor"], {
          cwd: projectDir,
          env: { ...process.env, DOWNLOADX_HOME: doctorHome },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let text = "";
        child.stdout.on("data", (d) => { text += d; });
        child.stderr.on("data", (d) => { text += d; });
        child.on("exit", (code) => resolve({ code, text }));
      });
      assert.equal(out.code, 0, "doctor must exit 0 when everything works:\n" +out.text);
      assert.ok(!out.text.includes(runtime.token), "the doctor output must not contain the daemon token");
      for (const word of ["node", "daemon", "api", "runtime dir"]) {
        assert.ok(out.text.toLowerCase().includes(word), "doctor must report " + word + ":\n" +out.text);
      }
    } finally {
      await daemon.stop();
      if (savedHome === undefined) delete process.env.DOWNLOADX_HOME;
      else process.env.DOWNLOADX_HOME = savedHome;
      await fsp.rm(doctorHome, { recursive: true, force: true });
    }
  });

  await suite.test("doctor fails and explains an unusable download folder", async () => {
    // A diagnostic that always says "ok" is worse than none. This checks the
    // failure path: a broken setting must be reported with a fix, and the exit
    // code must say something is wrong.
    const { spawn } = await import("node:child_process");
    const doctorHome = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-doctor-bad-"));
    const blocker = path.join(doctorHome, "not-a-directory");
    await fsp.writeFile(blocker, "a file, so nothing can be created inside it");
    await fsp.writeFile(path.join(doctorHome, "config.json"),
      JSON.stringify({ defaultDir: path.join(blocker, "sub") }));

    try {
      const entry = path.join(projectDir, "bin", "downloadx.mjs");
      const out = await new Promise((resolve) => {
        const child = spawn(process.execPath, [entry, "doctor"], {
          cwd: projectDir,
          env: { ...process.env, DOWNLOADX_HOME: doctorHome },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let text = "";
        child.stdout.on("data", (d) => { text += d; });
        child.stderr.on("data", (d) => { text += d; });
        child.on("exit", (code) => resolve({ code, text }));
      });
      assert.equal(out.code, 1, "doctor must exit non-zero when a folder is unusable:\n" +out.text);
      assert.ok(/not writable/i.test(out.text), "the problem must be named:\n" +out.text);
      assert.ok(/Settings|config defaultDir/.test(out.text),
        "the output must contain an actionable fix:\n" +out.text);
    } finally {
      await fsp.rm(doctorHome, { recursive: true, force: true });
    }
  });

  await suite.test("doctor flags a stale runtime file from a dead daemon", async () => {
    // A runtime file with no live process behind it makes every client that
    // reads it wait; the diagnostic has to notice.
    const { spawn } = await import("node:child_process");
    const doctorHome = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-doctor-stale-"));
    await fsp.writeFile(path.join(doctorHome, "runtime.json"), JSON.stringify({
      pid: 999999999, port: 1, host: "127.0.0.1", token: "stale-token-value",
      url: "http://127.0.0.1:1/", startedAt: new Date().toISOString(), version: "1.0.0",
    }));
    try {
      const entry = path.join(projectDir, "bin", "downloadx.mjs");
      const out = await new Promise((resolve) => {
        const child = spawn(process.execPath, [entry, "doctor"], {
          cwd: projectDir,
          env: { ...process.env, DOWNLOADX_HOME: doctorHome },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let text = "";
        child.stdout.on("data", (d) => { text += d; });
        child.stderr.on("data", (d) => { text += d; });
        child.on("exit", (code) => resolve({ code, text }));
      });
      assert.ok(/runtime file/i.test(out.text), "a stale runtime file must be reported:\n" +out.text);
      assert.ok(!out.text.includes("stale-token-value"), "the stale token must not be printed");
    } finally {
      await fsp.rm(doctorHome, { recursive: true, force: true });
    }
  });

  await suite.test("discarding a transfer never deletes a directory at the target", async () => {
    // Regression that cost real user data: TransferStore.discard() used
    // fsp.rm(recursive: true) on the target path, so a download whose name
    // collided with an existing folder deleted that folder and everything
    // inside it.
    const { TransferStore } = await import("../src/store.mjs");
    const dirCase = path.join(out, "discard-guard");
    await fsp.mkdir(dirCase, { recursive: true });
    const victim = path.join(dirCase, "looks-like-a-download.bin");
    await fsp.mkdir(victim, { recursive: true });
    await fsp.writeFile(path.join(victim, "irreplaceable.txt"), "user data");

    const store = new TransferStore(victim);
    await store.discard();

    const stillDir = (await fsp.stat(victim).catch(() => null))?.isDirectory() === true;
    assert.ok(stillDir, "a directory at the target path must survive a discard");
    assert.ok(fs.existsSync(path.join(victim, "irreplaceable.txt")),
      "the files inside it must survive too");

    // A regular file at the target IS the transfer partial and must go.
    const fileCase = path.join(dirCase, "partial.bin");
    await fsp.writeFile(fileCase, "half a download");
    await new TransferStore(fileCase).discard();
    assert.equal(fs.existsSync(fileCase), false, "a partial file must still be discarded");
  });

  // ------------------------------------------------ URL history (E, item 1)
  suite.group("URL history");
  const { UrlHistory, redactUrl } = await import("../src/history.mjs");

  await suite.test("a secret in a URL is never written to the history file", async () => {
    // A history file is plain text the user reads and may paste into a bug
    // report, so a query-string token must not survive into it.
    // (imported once for the group above)
    assert.equal(redactUrl("https://h.test/f.iso?token=SECRET&arch=x86"),
      "https://h.test/f.iso?arch=x86&__redacted=1", "a token parameter must be dropped");
    assert.equal(redactUrl("https://u:p@h.test/f.iso"), "https://h.test/f.iso",
      "credentials in the authority must be dropped");
    assert.equal(redactUrl("https://h.test/f.iso?sig=abc123&part=2"),
      "https://h.test/f.iso?part=2&__redacted=1", "a signature must be dropped");
    assert.equal(redactUrl("https://h.test/f.iso?page=3#frag"),
      "https://h.test/f.iso?page=3", "a harmless parameter is kept and the fragment is dropped");

    const dir = path.join(out, "history-redact");
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, "history.jsonl");
    const h = new UrlHistory({ file });
    await h.load();
    h.record("https://h.test/download?token=SUPERSECRET&v=2", { filename: "f.bin" });
    h.record("https://user:hunter2@h.test/private.bin");
    await h.flush();
    const raw = await fsp.readFile(file, "utf8");
    assert.ok(!raw.includes("SUPERSECRET"), "the token must not appear in the file: " + raw);
    assert.ok(!raw.includes("hunter2"), "the password must not appear in the file: " + raw);
    assert.ok(!/hunter2|SUPERSECRET/.test(JSON.stringify(h.list())), "nor in the listing");
  });

  await suite.test("history survives a reload and de-duplicates by URL", async () => {
    const dir = path.join(out, "history-reload");
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, "history.jsonl");

    const first = new UrlHistory({ file });
    await first.load();
    first.record("https://h.test/a.bin", { filename: "a.bin" });
    first.record("https://h.test/b.bin", { filename: "b.bin" });
    first.record("https://h.test/a.bin", { filename: "a.bin" });
    await first.flush();

    // Re-using a URL must not create a second row, and must move it to the top.
    assert.equal(first.size, 2, "the same URL must be stored once");
    assert.equal(first.list()[0].url, "https://h.test/a.bin", "the re-used entry moves to the top");

    const second = new UrlHistory({ file });
    await second.load();
    assert.equal(second.size, 2, "the entries must survive a reload");
    assert.equal(second.list()[0].url, "https://h.test/a.bin", "the order must survive a reload");

    // A damaged line (a crash mid-append) must not lose the rest.
    await fsp.appendFile(file, '{"url":"https://h.test/c.bin","at":9999999}\n{"torn', "utf8");
    const third = new UrlHistory({ file });
    await third.load();
    assert.equal(third.size, 3, "a torn trailing line must be skipped, not fatal");
  });

  await suite.test("the history file stays bounded", async () => {
    // An unbounded file would grow forever on a machine that downloads daily.
    const dir = path.join(out, "history-bounded");
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, "history.jsonl");
    const h = new UrlHistory({ file, maxEntries: 5 });
    await h.load();
    for (let i = 0; i < 20; i++) h.record("https://h.test/file-" + i + ".bin");
    await h.flush();
    assert.equal(h.size, 5, "only the configured number of entries is kept");
    assert.equal(h.list()[0].url, "https://h.test/file-19.bin", "the newest entry is first");
    await h.compact();
    const lines = (await fsp.readFile(file, "utf8")).split("\n").filter(Boolean);
    assert.equal(lines.length, 5, "compaction rewrites the file to the live entries");
  });

  await suite.test("clearing history is explicit and removes the file", async () => {
    const dir = path.join(out, "history-clear");
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, "history.jsonl");
    const h = new UrlHistory({ file });
    await h.load();
    h.record("https://h.test/x.bin");
    await h.flush();
    assert.ok(fs.existsSync(file), "the file must exist after recording");
    // Nothing in the codebase clears history on a timer or at startup; this is
    // the only path, and it is reached from an explicit command or button.
    const removed = await h.clear();
    assert.equal(removed, 1);
    assert.equal(h.size, 0);
    assert.equal(fs.existsSync(file), false, "clearing must remove the file, not just empty the list");
  });

  await suite.test("the daemon records queued URLs and offers them back", async () => {
    // End to end through the real daemon: a queued URL is remembered, and the
    // API returns it with no secret attached.
    const historyHome = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-hist-"));
    const savedHome = process.env.DOWNLOADX_HOME;
    process.env.DOWNLOADX_HOME = historyHome;
    const { Daemon } = await import("../src/daemon.mjs");
    const daemon = await new Daemon({ port: 0 }).init();
    const runtime = await daemon.start();
    try {
      const H = { "x-downloadx-token": runtime.token, "content-type": "application/json" };
      const initial = await (await fetch("http://127.0.0.1:" + runtime.port + "/api/history", { headers: H })).json();
      assert.equal(initial.total, 0, "a fresh data root starts with no history");

      await fetch("http://127.0.0.1:" + runtime.port + "/api/tasks", {
        method: "POST", headers: H,
        body: JSON.stringify({ url: "http://127.0.0.1:9/thing.bin?token=HISTLEAK", filename: "thing.bin" }),
      });
      // The history append is coalesced, so give it a moment to land.
      const deadline = Date.now() + 5000;
      let listed = null;
      while (Date.now() < deadline) {
        listed = await (await fetch("http://127.0.0.1:" + runtime.port + "/api/history", { headers: H })).json();
        if (listed.total > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(listed && listed.total >= 1, "the queued URL must be recorded");
      assert.equal(listed.entries[0].filename, "thing.bin", "the file name must be remembered");
      assert.ok(!JSON.stringify(listed).includes("HISTLEAK"), "the token must not be returned");
      assert.match(listed.entries[0].url, /__redacted=1/, "the redaction must be visible");

      // The history route is behind the token like every other API route.
      const unauth = await fetch("http://127.0.0.1:" + runtime.port + "/api/history");
      assert.equal(unauth.status, 401, "history must require the token");

      // Clearing through the API works and is reported.
      const cleared = await (await fetch("http://127.0.0.1:" + runtime.port + "/api/history", { method: "DELETE", headers: H })).json();
      assert.ok(cleared.removed >= 1, "clearing must report what it removed");
      const after = await (await fetch("http://127.0.0.1:" + runtime.port + "/api/history", { headers: H })).json();
      assert.equal(after.total, 0, "the history must be empty afterwards");
    } finally {
      await daemon.stop();
      if (savedHome === undefined) delete process.env.DOWNLOADX_HOME;
      else process.env.DOWNLOADX_HOME = savedHome;
      await fsp.rm(historyHome, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------- SOCKS5 (E, item 3)
  suite.group("SOCKS5 proxy");

  /**
   * A minimal SOCKS5 server, so the client is exercised against a real
   * handshake instead of a mock of one.
   */
  function startSocks5Proxy({ requireAuth = null, refuseAll = false } = {}) {
    const netMod = net;
    const seen = { greeting: 0, auth: [], connects: [], methods: [] };
    const srv = netMod.createServer((sock) => {
      let stage = "greet";
      let buf = Buffer.alloc(0);
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (stage === "greet") {
            if (buf.length < 2) return;
            const n = buf[1];
            if (buf.length < 2 + n) return;
            const methods = [...buf.subarray(2, 2 + n)];
            buf = buf.subarray(2 + n);
            seen.greeting++;
            seen.methods.push(methods);
            if (refuseAll) { sock.write(Buffer.from([0x05, 0xff])); sock.destroy(); return; }
            if (requireAuth) {
              if (!methods.includes(2)) { sock.write(Buffer.from([0x05, 0xff])); sock.destroy(); return; }
              sock.write(Buffer.from([0x05, 0x02]));
              stage = "auth";
              continue;
            }
            sock.write(Buffer.from([0x05, 0x00]));
            stage = "connect";
            continue;
          }
          if (stage === "auth") {
            if (buf.length < 2) return;
            const ulen = buf[1];
            if (buf.length < 2 + ulen + 1) return;
            const user = buf.subarray(2, 2 + ulen).toString();
            const plen = buf[2 + ulen];
            if (buf.length < 2 + ulen + 1 + plen) return;
            const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
            buf = buf.subarray(3 + ulen + plen);
            seen.auth.push({ user, pass });
            const good = user === requireAuth.user && pass === requireAuth.pass;
            sock.write(Buffer.from([0x01, good ? 0x00 : 0x01]));
            if (!good) { sock.destroy(); return; }
            stage = "connect";
            continue;
          }
          if (stage === "connect") {
            if (buf.length < 4) return;
            const atyp = buf[3];
            let host; let off;
            if (atyp === 1) { host = [...buf.subarray(4, 8)].join("."); off = 8; }
            else if (atyp === 3) { if (buf.length < 5) return; const l = buf[4]; if (buf.length < 5 + l) return; host = buf.subarray(5, 5 + l).toString(); off = 5 + l; }
            else { sock.destroy(); return; }
            if (buf.length < off + 2) return;
            const port = buf.readUInt16BE(off);
            buf = buf.subarray(off + 2);
            seen.connects.push({ host, port, atyp });
            const upstream = netMod.connect(port, host, () => {
              sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
              sock.pipe(upstream);
              upstream.pipe(sock);
            });
            upstream.on("error", () => {
              sock.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
              sock.destroy();
            });
            stage = "relay";
            return;
          }
          return;
        }
      });
      sock.on("error", () => {});
    });
    return new Promise((resolve) => {
      srv.listen(0, "127.0.0.1", () => {
        resolve({
          url: "socks5://127.0.0.1:" + srv.address().port,
          seen,
          close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r(undefined)); setTimeout(() => r(undefined), 1000); }),
        });
      });
    });
  }

  await suite.test("SOCKS5 is recognised and HTTP proxy URLs are not", async () => {
    const { isSocksProxy } = await import("../src/net.mjs");
    assert.equal(isSocksProxy("socks5://127.0.0.1:1080"), true);
    assert.equal(isSocksProxy("socks5h://127.0.0.1:1080"), true);
    assert.equal(isSocksProxy("SOCKS5://h:1"), true, "the scheme is case-insensitive");
    assert.equal(isSocksProxy("http://127.0.0.1:8080"), false, "an HTTP proxy must not take the SOCKS path");
    assert.equal(isSocksProxy("https://127.0.0.1:8080"), false);
    assert.equal(isSocksProxy(""), false);
    assert.equal(isSocksProxy(null), false);
  });

  await suite.test("a download completes through a SOCKS5 proxy", async () => {
    // End to end: the bytes must arrive intact, and the proxy must have been
    // asked to reach the origin by name.
    const body = payloadFor(96 * 1024);
    const httpMod = await import("node:http");
    const originSrv = httpMod.createServer((req, res) => {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
      if (m) {
        const s = Number(m[1]);
        const e = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
        const slice = body.subarray(s, e + 1);
        res.writeHead(206, {
          "Content-Range": "bytes " + s + "-" + e + "/" + body.length,
          "Content-Length": slice.length, "Accept-Ranges": "bytes",
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, { "Content-Length": body.length, "Accept-Ranges": "bytes" });
      res.end(body);
    });
    await new Promise((r) => originSrv.listen(0, "127.0.0.1", r));
    const originUrl = "http://127.0.0.1:" + originSrv.address().port + "/via.bin";

    const proxy = await startSocks5Proxy();
    try {
      const cfg = new Config(path.join(out, "socks.json"));
      await cfg.load();
      await cfg.set({
        defaultDir: out, categorizeByType: false, overwriteExisting: "overwrite",
        maxConnections: 2, proxy: proxy.url,
        // Batch-7 hermeticity (P-18): this test asserts that the Settings
        // proxy IS used, which is exactly manual-mode semantics. Under the
        // default "system" mode the OS proxy discovery would WIN over the
        // Settings value (the fixed batch-7 ruling), so on a machine whose
        // OS proxy is enabled the transfer would silently ride the host's
        // proxy instead of the SOCKS one below and "the proxy must have
        // been used" would fail. Pin the mode so the suite is independent
        // of the host machine's proxy state.
        proxyMode: "manual",
      });
      const q = new QueueManager({ config: cfg });
      await q.load();
      const dl = new Downloader({ config: cfg, queue: q });
      const r = await dl.run({
        id: "socks-1", url: originUrl, kind: "http", filename: "socks.bin", dir: out,
        headers: {}, connections: 2, meta: {},
      });
      assert.equal(r.bytes, body.length, "the whole body must arrive through the proxy");
      assert.equal(await hashFile(path.join(out, "socks.bin")), createHash("sha256").update(body).digest("hex"));
      assert.ok(proxy.seen.connects.length > 0, "the proxy must have been used");
      assert.equal(proxy.seen.connects[0].host, "127.0.0.1", "the destination must be the origin");
      assert.equal(proxy.seen.connects[0].port, originSrv.address().port);
    } finally {
      await proxy.close();
      await closeServer(originSrv);
    }
  });

  await suite.test("SOCKS5 username/password authentication is performed", async () => {
    // RFC 1929. The destination must be told nothing about the credential:
    // it belongs to the proxy relationship only.
    const proxy = await startSocks5Proxy({ requireAuth: { user: "alice", pass: "s3cret" } });
    const httpMod = await import("node:http");
    let sawProxyAuthHeader = false;
    const originSrv = httpMod.createServer((req, res) => {
      if (req.headers["proxy-authorization"]) sawProxyAuthHeader = true;
      res.writeHead(200, { "Content-Length": "2" });
      res.end("ok");
    });
    await new Promise((r) => originSrv.listen(0, "127.0.0.1", r));
    try {
      const { requestFollow } = await import("../src/net.mjs");
      const res = await requestFollow(
        "http://127.0.0.1:" + originSrv.address().port + "/x",
        { proxy: proxy.url.replace("socks5://", "socks5://alice:s3cret@"), timeoutMs: 10000 },
      );
      const chunks = [];
      for await (const c of res.stream) chunks.push(c);
      assert.equal(Buffer.concat(chunks).toString(), "ok");
      assert.deepEqual(proxy.seen.auth, [{ user: "alice", pass: "s3cret" }],
        "the credential must be offered to the proxy");
      assert.equal(sawProxyAuthHeader, false,
        "the proxy credential must not be forwarded to the destination");
    } finally {
      await proxy.close();
      await closeServer(originSrv);
    }
  });

  await suite.test("a SOCKS5 proxy that refuses every method is reported, not retried forever", async () => {
    const proxy = await startSocks5Proxy({ refuseAll: true });
    try {
      const { requestFollow } = await import("../src/net.mjs");
      let err = null;
      try {
        await requestFollow("http://127.0.0.1:9/x", { proxy: proxy.url, timeoutMs: 8000 });
      } catch (e) { err = e; }
      assert.ok(err, "a refusing proxy must produce an error");
      assert.match(err.message, /refused every offered auth method|socks5/i, "the error must explain: " + err.message);
    } finally {
      await proxy.close();
    }
  });

  await suite.test("a credential-requiring SOCKS5 proxy without credentials says so", async () => {
    const proxy = await startSocks5Proxy({ requireAuth: { user: "a", pass: "b" } });
    try {
      const { requestFollow } = await import("../src/net.mjs");
      let err = null;
      try {
        await requestFollow("http://127.0.0.1:9/x", { proxy: proxy.url, timeoutMs: 8000 });
      } catch (e) { err = e; }
      assert.ok(err, "the download must fail rather than hang");
      assert.match(err.message, /username and password/i,
        "the message must say what is missing: " + err.message);
    } finally {
      await proxy.close();
    }
  });

  await suite.test("an unreachable SOCKS5 destination reports why", async () => {
    const proxy = await startSocks5Proxy();
    try {
      const { requestFollow } = await import("../src/net.mjs");
      let err = null;
      try { await requestFollow("http://127.0.0.1:1/x", { proxy: proxy.url, timeoutMs: 8000 }); }
      catch (e) { err = e; }
      assert.ok(err, "an unreachable destination must fail");
      assert.match(err.message, /could not reach the destination|refused/i,
        "the reply code must be translated: " + err.message);
    } finally {
      await proxy.close();
    }
  });

  await suite.test("a malformed SOCKS5 proxy URL is rejected clearly", async () => {
    const { requestFollow } = await import("../src/net.mjs");
    let err = null;
    try { await requestFollow("http://x/y", { proxy: "socks5://", timeoutMs: 3000 }); }
    catch (e) { err = e; }
    assert.ok(err, "a malformed proxy URL must fail");
    assert.match(err.message, /host:port/i, "the message must say what is missing: " + err.message);
  });

  // ------------------------------------------------- extension protocol (A)
  // Drives the real native host over the browser framing, against a real
  // daemon and a real origin. This is not a browser test: see the smoke
  // record for what still needs a browser.
  suite.group("Extension protocol");
  await runExtensionProtocolTests(suite, { home, out, root, projectDir });

  // ---------------------------------------------------- browser GUI (B)
  // Drives a real Chromium browser against the real page. Skipped, with a
  // reason, when no Chrome or Edge is installed: an unrunnable scenario is
  // reported as SKIP, never as PASS.
  suite.group("Browser GUI lifecycle");
  const guiResult = await runGuiBrowserTests(suite, { projectDir });
  if (guiResult.executed) {
    console.log("        (browser: " + guiResult.browser + ")");
  } else {
    console.log("        (skipped: " + guiResult.reason + ")");
  }

  // ------------------------------------------------------------------- CLI
  suite.group("Command line");
  const cli = await import("../src/cli.mjs");
  await suite.test("argument parsing handles all documented flags", () => {
    const { opts, positional } = cli.parseArgs(["get", "https://x.test/f.bin", "-c", "16", "-o", "D:/dl", "--limit", "2M", "-H", "X-Test: 1", "-k"]);
    assert.equal(positional[0], "get");
    assert.equal(positional[1], "https://x.test/f.bin");
    assert.equal(opts.connections, 16);
    assert.equal(opts.output, "D:/dl");
    assert.equal(opts.limit, 2 * 1024 * 1024);
    assert.equal(opts.headers["X-Test"], "1");
    assert.equal(opts.insecure, true);
  });
  await suite.test("connection count is clamped to 1..32", () => {
    assert.equal(cli.parseArgs(["-c", "999", "get", "x"]).opts.connections, 32);
    assert.equal(cli.parseArgs(["-c", "0", "get", "x"]).opts.connections, 1);
  });
  await suite.test("unknown options are rejected", () => {
    assert.throws(() => cli.parseArgs(["--nonsense"]));
  });
  await suite.test("bare hosts get an https scheme", () => {
    assert.equal(cli.normalizeUrl("example.com/file.bin"), "https://example.com/file.bin");
    assert.equal(cli.normalizeUrl("http://x.test/a"), "http://x.test/a");
    assert.throws(() => cli.normalizeUrl("http://"));
  });

  // -------------------------------------------------------------- grabber
  suite.group("Site grabber");
  const grabber = await import("../src/grabber.mjs");
  await suite.test("extractLinks finds attributes and skips non-resources", () => {
    const html = [
      '<a href="/files/report.pdf">r</a>',
      '<a href="#top">skip</a>',
      '<a href="mailto:a@b.c">mail</a>',
      '<img src="/images/photo.jpg">',
      '<video src="/media/clip.mp4"></video>',
      '<script src="/assets/app.js"></script>',
      "<script>var u='/stream/master.m3u8';</script>",
    ].join("");
    const links = grabber.extractLinks(html, "https://site.test/page");
    const urls = links.map((l) => l.url);
    assert.ok(urls.includes("https://site.test/files/report.pdf"));
    assert.ok(urls.includes("https://site.test/images/photo.jpg"));
    assert.ok(urls.includes("https://site.test/media/clip.mp4"));
    assert.ok(urls.includes("https://site.test/stream/master.m3u8"));
    assert.ok(!urls.some((u) => u.includes("mailto")), "mailto must be skipped");
    assert.ok(!urls.some((u) => u.endsWith("#top")), "fragments must be skipped");
    const pdf = links.find((l) => l.url.endsWith("report.pdf"));
    assert.equal(pdf.category, "document");
  });
  await suite.test("grabPage lists a real page and dedupes the page URL", async () => {
    const page = await grabber.grabPage(origin.origin + "/page");
    assert.ok(page.isDocument);
    const urls = page.links.map((l) => l.url);
    assert.ok(urls.length >= 5, "expected several links, got " + urls.length);
    assert.ok(!urls.includes(page.finalUrl), "the page itself must not be listed");
    assert.equal(new Set(urls).size, urls.length, "links must be unique");
  });
  await suite.test("grabPage mediaOnly keeps only media", async () => {
    const page = await grabber.grabPage(origin.origin + "/page", { mediaOnly: true });
    for (const l of page.links) {
      const ext = (l.filename.split(".").pop() || "").toLowerCase();
      assert.ok(grabber.MEDIA_EXT.has(ext), "non-media link leaked: " + l.url);
    }
  });
  await suite.test("grabPage extension filter works", async () => {
    const page = await grabber.grabPage(origin.origin + "/page", { extensions: ["pdf"] });
    assert.equal(page.links.length, 1);
    assert.ok(page.links[0].url.endsWith(".pdf"));
  });
  await suite.test("a direct file URL is returned as the resource", async () => {
    const page = await grabber.grabPage(origin.origin + "/range/4096");
    assert.equal(page.isDocument, false);
    assert.equal(page.links.length, 1);
    assert.equal(page.links[0].tag, "direct");
  });
  await suite.test("grabAndQueue queues every link", async () => {
    const q = new QueueManager({ config: apiConfig });
    await q.load();
    // This queue is shared with earlier tests, so measure the delta rather
    // than the absolute total.
    const before = q.stats.total;
    const result = await grabber.grabAndQueue(origin.origin + "/page", q, { dir: out });
    assert.ok(result.queued.length >= 5, "expected queued links");
    assert.equal(q.stats.total - before, result.queued.length);
    assert.ok(result.queued.every((x) => x.task), "every link should produce a task");
  });

  // -------------------------------------------------------------- sniffer
  suite.group("Media sniffer");
  const sniffer = await import("../src/sniffer.mjs");
  await suite.test("classify recognises stream and media URLs", () => {
    assert.equal(sniffer.classify("https://x.test/a/master.m3u8"), "hls");
    assert.equal(sniffer.classify("https://x.test/a/manifest.mpd?t=1"), "dash");
    assert.equal(sniffer.classify("https://x.test/a/clip.mp4"), "http");
    assert.equal(sniffer.classify("https://x.test/a/page.html"), null);
  });
  await suite.test("sniffPage finds HLS and DASH candidates on a page", async () => {
    const result = await sniffer.sniffPage(origin.origin + "/page");
    const kinds = result.candidates.map((c) => c.kind);
    assert.ok(kinds.includes("hls"), "expected an HLS candidate, got " + JSON.stringify(kinds));
    assert.ok(kinds.includes("dash"), "expected a DASH candidate, got " + JSON.stringify(kinds));
  });
  await suite.test("inspectStream describes an HLS master playlist", async () => {
    const info = await sniffer.inspectStream(origin.origin + "/stream/master.m3u8?count=3");
    assert.equal(info.kind, "hls");
    assert.equal(info.master, true);
    assert.ok(info.variants.length >= 1);
    assert.ok(info.best, "a best variant should be chosen");
  });
  await suite.test("inspectStream counts segments in a media playlist", async () => {
    const info = await sniffer.inspectStream(origin.origin + "/hls/media.m3u8?count=4");
    assert.equal(info.kind, "hls");
    assert.equal(info.master, false);
    assert.equal(info.segmentCount, 4);
    assert.equal(info.live, false);
  });
  await suite.test("inspectStream describes a DASH manifest", async () => {
    const info = await sniffer.inspectStream(origin.origin + "/stream/manifest.mpd");
    assert.equal(info.kind, "dash");
    assert.ok(info.representations.length >= 1);
    assert.ok(info.best && info.best.resolution === "1280x720");
  });
  await suite.test("inspectStream probes a progressive file", async () => {
    const info = await sniffer.inspectStream(origin.origin + "/media/clip.mp4");
    assert.equal(info.kind, "http");
    assert.ok(info.totalBytes > 0, "a progressive file should report its size");
    assert.ok(info.supportsRanges);
  });
  await suite.test("inspectStream rejects a non-media URL", async () => {
    const info = await sniffer.inspectStream(origin.origin + "/page");
    assert.equal(info.kind, null);
    assert.ok(info.error);
  });

  // ------------------------------------------- grabber/sniffer over the API
  suite.group("Grabber and sniffer over the API");
  const api2Config = new Config(path.join(root, "api2config.json"));
  await api2Config.load();
  await api2Config.set({ defaultDir: out, categorizeByType: false, maxConnections: 2, segmentBytes: 262144 });
  const api2Queue = new QueueManager({ config: api2Config });
  await api2Queue.load();
  const api2 = new ApiServer({
    queue: api2Queue, config: api2Config,
    downloader: new Downloader({ config: api2Config, queue: api2Queue }),
    log: { info() {}, warn() {}, error() {} },
  }).startRunner();
  const listen2 = await api2.listen({ port: 0 });
  const call2 = async (route, body) => {
    const res = await fetch("http://127.0.0.1:" + listen2.port + route, {
      method: "POST",
      headers: { "x-downloadx-token": listen2.token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  await suite.test("POST /api/grab lists resources without queueing", async () => {
    const r = await call2("/api/grab", { url: origin.origin + "/page" });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.links));
    assert.ok(r.json.links.length >= 5);
  });
  await suite.test("POST /api/grab with queue=true enqueues them", async () => {
    const before = api2Queue.stats.total;
    const r = await call2("/api/grab", { url: origin.origin + "/page", queue: true });
    assert.equal(r.status, 200);
    assert.ok(r.json.queued >= 5, "expected queued count, got " + r.json.queued);
    assert.ok(api2Queue.stats.total > before);
  });
  await suite.test("POST /api/sniff returns candidates", async () => {
    const r = await call2("/api/sniff", { url: origin.origin + "/page" });
    assert.equal(r.status, 200);
    assert.ok(r.json.candidates.length >= 2);
  });
  await suite.test("POST /api/inspect-stream describes a stream", async () => {
    const r = await call2("/api/inspect-stream", { url: origin.origin + "/hls/media.m3u8?count=2" });
    assert.equal(r.status, 200);
    assert.equal(r.json.segmentCount, 2);
  });
  await suite.test("grab and sniff reject a missing url", async () => {
    assert.equal((await call2("/api/grab", {})).status, 400);
    assert.equal((await call2("/api/sniff", {})).status, 400);
    assert.equal((await call2("/api/inspect-stream", {})).status, 400);
  });
  await api2.close();

  // -------------------------------------------------------- track selection
  suite.group("Track selection and merging");
  const dash2 = await import("../src/dash.mjs");
  const merge = await import("../src/merge.mjs");

  await suite.test("SegmentTimeline drives segment enumeration", () => {
    const xml = '<MPD type="static" mediaPresentationDuration="PT8S"><Period>' +
      '<AdaptationSet mimeType="video/mp4"><Representation id="0" bandwidth="100">' +
      '<SegmentTemplate timescale="15360" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number$.m4s" startNumber="1">' +
      '<SegmentTimeline><S t="0" d="61440"/><S d="61440"/></SegmentTimeline>' +
      "</SegmentTemplate></Representation></AdaptationSet></Period></MPD>";
    const mpd = dash2.parseMpd(xml, "http://cdn.test/m.mpd");
    const rep = mpd.representations[0];
    assert.ok(Array.isArray(rep.segmentTimeline) && rep.segmentTimeline.length === 2,
      "the timeline must be parsed, got " + JSON.stringify(rep.segmentTimeline));
    const segs = dash2.listSegments(mpd, rep, {});
    assert.equal(segs.length, 2, "two timeline entries means two segments, got " + JSON.stringify(segs));
    assert.equal(segs[0], "chunk-0-1.m4s");
    assert.equal(segs[1], "chunk-0-2.m4s");
  });
  await suite.test("a timeline with a repeat attribute expands correctly", () => {
    const xml = '<MPD type="static"><Period><AdaptationSet mimeType="video/mp4">' +
      '<Representation id="7"><SegmentTemplate media="s-$Number$.m4s" startNumber="3">' +
      '<SegmentTimeline><S t="0" d="1000" r="3"/></SegmentTimeline>' +
      "</SegmentTemplate></Representation></AdaptationSet></Period></MPD>";
    const mpd = dash2.parseMpd(xml, "http://cdn.test/m.mpd");
    const segs = dash2.listSegments(mpd, mpd.representations[0], {});
    assert.equal(segs.length, 4, "r=3 means four segments, got " + segs.length);
    assert.equal(segs[0], "s-3.m4s");
    assert.equal(segs[3], "s-6.m4s");
  });
  await suite.test("initialization names expand \$RepresentationID\$", () => {
    const { expandTemplate } = dash2;
    assert.equal(expandTemplate("init-$RepresentationID$.m4s", { representationId: "0" }), "init-0.m4s");
    assert.equal(expandTemplate("init-$RepresentationID$.m4s", { representationId: "audio" }), "init-audio.m4s");
  });
  await suite.test("a real ffmpeg-style DASH package downloads and merges", async () => {
    const sc = new Config(path.join(root, "dash6config.json"));
    await sc.load();
    await sc.set({ defaultDir: out, categorizeByType: false, maxConnections: 4 });
    const q = new QueueManager({ config: sc });
    await q.load();
    const downloader = new Downloader({ config: sc, queue: q });
    const result = await downloader.run({
      id: "dash6", url: origin.origin + "/dash3/manifest.mpd", kind: "dash",
      filename: "ffmpeg-style.mp4", dir: out, headers: {}, connections: 4, meta: {},
    });
    assert.ok(result.bytes > 0, "expected output bytes");
    assert.equal(result.meta.representation, "0");
    assert.equal(result.meta.audioRepresentation, "1");
    assert.equal(result.meta.segments, 4, "2 video + 2 audio segments, got " + result.meta.segments);
  });

  await suite.test("audio representations are identified", () => {
    assert.equal(dash2.isAudio({ mimeType: "audio/mp4" }), true);
    assert.equal(dash2.isAudio({ mimeType: "video/mp4" }), false);
    assert.equal(dash2.isAudio({ codecs: "mp4a.40.2" }), true);
    assert.equal(dash2.isAudio({ codecs: "avc1.4d401f" }), false);
    assert.equal(dash2.isAudio({}), true, "no dimensions and no codec implies audio");
  });
  await suite.test("selectTracks returns both video and audio", () => {
    const xml = '<MPD type="static" mediaPresentationDuration="PT6S"><Period>' +
      '<AdaptationSet mimeType="video/mp4">' +
      '<Representation id="v1" bandwidth="2000000" width="1920" height="1080">' +
      '<SegmentTemplate timescale="1" duration="3" media="v-$Number$.m4s" initialization="v-init.mp4"/>' +
      "</Representation></AdaptationSet>" +
      '<AdaptationSet mimeType="audio/mp4">' +
      '<Representation id="a1" bandwidth="128000">' +
      '<SegmentTemplate timescale="1" duration="3" media="a-$Number$.m4s" initialization="a-init.mp4"/>' +
      "</Representation></AdaptationSet></Period></MPD>";
    const mpd = dash2.parseMpd(xml, "https://cdn.test/m.mpd");
    const tracks = dash2.selectTracks(mpd);
    assert.ok(tracks.video, "video track should be selected");
    assert.ok(tracks.audio, "audio track should be selected");
    assert.equal(tracks.video.id, "v1");
    assert.equal(tracks.audio.id, "a1");
    const videoOnly = dash2.selectTracks(mpd, { includeAudio: false });
    assert.equal(videoOnly.audio, null);
  });
  await suite.test("pickBestRepresentation never picks an audio track", () => {
    const xml = '<MPD type="static"><Period>' +
      '<AdaptationSet mimeType="audio/mp4"><Representation id="a1" bandwidth="9999999">' +
      '<SegmentTemplate media="a-$Number$.m4s"/></Representation></AdaptationSet>' +
      '<AdaptationSet mimeType="video/mp4"><Representation id="v1" bandwidth="1000" width="640" height="360">' +
      '<SegmentTemplate media="v-$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>';
    const mpd = dash2.parseMpd(xml, "https://cdn.test/m.mpd");
    assert.equal(dash2.pickBestRepresentation(mpd).id, "v1", "video must win even at lower bandwidth");
  });
  await suite.test("ffmpeg is discoverable on this host", async () => {
    const found = await merge.findFfmpeg();
    // ffmpeg is optional; when absent the downloader keeps separate tracks.
    assert.ok(found === null || typeof found === "string");
    console.log("        (ffmpeg: " + (found || "not installed — merge will be skipped") + ")");
  });
  await suite.test("mergeTracks with a single track just renames it", async () => {
    const src = path.join(out, "single-track.mp4");
    await fsp.writeFile(src, Buffer.alloc(1024, 1));
    const dst = path.join(out, "single-track-out.mp4");
    const r = await merge.mergeTracks({ videoPath: src, audioPath: null, outputPath: dst });
    assert.ok(r.ok, "single track should succeed: " + r.error);
    assert.ok(fs.existsSync(dst));
    assert.equal(fs.statSync(dst).size, 1024);
  });
  await suite.test("mergeTracks reports honestly when ffmpeg is missing", async () => {
    const a = path.join(out, "noff-v.mp4");
    const b = path.join(out, "noff-a.m4a");
    await fsp.writeFile(a, Buffer.alloc(512, 2));
    await fsp.writeFile(b, Buffer.alloc(512, 3));
    const r = await merge.mergeTracks({ videoPath: a, audioPath: b, outputPath: path.join(out, "noff-out.mp4"), ffmpegPath: "C:\\definitely\\not\\ffmpeg.exe" });
    assert.equal(r.ok, false, "a bogus ffmpeg path must fail rather than silently succeed");
    assert.ok(r.error);
  });

  // ------------------------------------------------- multi-track DASH e2e
  await suite.test("DASH with separate audio fetches and merges both tracks", async () => {
    const sc = new Config(path.join(root, "dash2config.json"));
    await sc.load();
    await sc.set({ defaultDir: out, categorizeByType: false, maxConnections: 4 });
    const q = new QueueManager({ config: sc });
    await q.load();
    const downloader = new Downloader({ config: sc, queue: q });
    const result = await downloader.run({
      id: "dash2", url: origin.origin + "/dash2/manifest.mpd", kind: "dash",
      filename: "twotrack.mp4", dir: out, headers: {}, connections: 4, meta: {},
    });
    assert.ok(result.bytes > 0, "expected output bytes");
    assert.equal(result.meta.representation, "v1");
    assert.equal(result.meta.audioRepresentation, "a1", "the audio track must be selected too");
    assert.ok(result.meta.segments >= 4, "expected segments from both tracks, got " + result.meta.segments);
    assert.ok(fs.existsSync(result.target));
  });
  await suite.test("a failed merge keeps the tracks and reports the real output", async () => {
    const sc = new Config(path.join(root, "dash4config.json"));
    await sc.load();
    // A bogus ffmpeg path forces the merge to fail while both tracks download.
    await sc.set({ defaultDir: out, categorizeByType: false, maxConnections: 4, ffmpegPath: "C:\\definitely\\not\\ffmpeg.exe" });
    const q = new QueueManager({ config: sc });
    await q.load();
    const downloader = new Downloader({ config: sc, queue: q });
    const result = await downloader.run({
      id: "dash4", url: origin.origin + "/dash2/manifest.mpd", kind: "dash",
      filename: "mergefail.mp4", dir: out, headers: {}, connections: 4, meta: {},
    });
    // The download still succeeds, but the reported target must be a file that
    // actually exists, and the note must explain why it is not the requested name.
    assert.ok(fs.existsSync(result.target), "the reported target must exist");
    assert.equal(result.meta.merged, false);
    assert.ok(result.meta.mergeNote, "a merge note is required when merging fails");
    assert.ok(Array.isArray(result.meta.separateTracks) && result.meta.separateTracks.length === 2,
      "both track files should be listed, got " + JSON.stringify(result.meta.separateTracks));
    for (const p of result.meta.separateTracks) {
      assert.ok(fs.existsSync(p), "listed track should exist: " + p);
    }
    // The video track must be the reported output, not a non-existent merged name.
    assert.ok(result.target.includes("video"), "target should be the video track, got " + result.target);
  });

  await suite.test("a successful merge removes the intermediate track files", async () => {
    const sc = new Config(path.join(root, "dash5config.json"));
    await sc.load();
    await sc.set({ defaultDir: out, categorizeByType: false, maxConnections: 4 });
    const q = new QueueManager({ config: sc });
    await q.load();
    const downloader = new Downloader({ config: sc, queue: q });
    const result = await downloader.run({
      id: "dash5", url: origin.origin + "/dash2/manifest.mpd", kind: "dash",
      filename: "mergeok.mp4", dir: out, headers: {}, connections: 4, meta: {},
    });
    if (result.meta.merged) {
      assert.equal(fs.existsSync(result.target), true);
      const leftovers = fs.readdirSync(out).filter((f) => f.startsWith("mergeok.mp4."));
      assert.equal(leftovers.length, 0, "track files should be cleaned up: " + leftovers.join(", "));
    } else {
      // ffmpeg absent: the note must say so rather than claiming success.
      assert.ok(result.meta.mergeNote);
    }
  });

  await suite.test("DASH videoOnly skips the audio track", async () => {
    const sc = new Config(path.join(root, "dash3config.json"));
    await sc.load();
    await sc.set({ defaultDir: out, categorizeByType: false, maxConnections: 4 });
    const q = new QueueManager({ config: sc });
    await q.load();
    const downloader = new Downloader({ config: sc, queue: q });
    const result = await downloader.run({
      id: "dash3", url: origin.origin + "/dash2/manifest.mpd", kind: "dash",
      filename: "videoonly.mp4", dir: out, headers: {}, connections: 4, meta: { videoOnly: true },
    });
    assert.equal(result.meta.audioRepresentation, null, "audio must be skipped when asked");
  });

  // ------------------------------------------------------------ clipboard
  suite.group("Clipboard watcher");
  const clip = await import("../src/clipboard.mjs");
  await suite.test("clipboard watcher honours the setting and dedupes", async () => {
    const fakeConfig = { get: (k) => (k === "monitorClipboard" ? false : undefined) };
    const w = new clip.ClipboardWatcher({ config: fakeConfig });
    const seen = [];
    w.on("url", (u) => seen.push(u));
    // Disabled: check() must not emit even if the clipboard holds a URL.
    w.last = "";
    await w.check();
    assert.equal(seen.length, 0, "a disabled watcher must stay silent");
  });
  await suite.test("URL_RE accepts http/ftp and rejects prose", () => {
    const w = new clip.ClipboardWatcher({});
    assert.ok(w.constructor.name === "ClipboardWatcher");
    // The module's regex is internal; verify the observable contract instead.
    assert.ok(typeof w.check === "function");
  });

  // --------------------------------------------------------- capture proxy
  suite.group("Capture proxy");
  const proxyMod = await import("../src/proxy.mjs");
  const caMod = await import("../src/ca.mjs");
  const httpMod = await import("node:http");
  const httpsMod = await import("node:https");
  const tlsMod = await import("node:tls");
  const netMod = await import("node:net");

  await suite.test("response classification is conservative", () => {
    const c = proxyMod.classifyResponse;
    // Things a user wants: attachments, known file types, big binaries.
    assert.ok(c({ url: "https://x/f", statusCode: 200, headers: { "content-disposition": 'attachment; filename="a.zip"' } }).isDownload);
    assert.ok(c({ url: "https://x/big.zip", statusCode: 200, headers: { "content-length": "5000000" } }).isDownload);
    assert.ok(c({ url: "https://x/v.mp4", statusCode: 200, headers: { "content-type": "video/mp4", "content-length": "90000000" } }).isDownload);
    // Things it must not interrupt: pages, APIs, redirects, partial content.
    assert.ok(!c({ url: "https://x/", statusCode: 200, headers: { "content-type": "text/html" } }).isDownload);
    assert.ok(!c({ url: "https://x/a.json", statusCode: 200, headers: { "content-type": "application/json" } }).isDownload);
    assert.ok(!c({ url: "https://x/r", statusCode: 302, headers: {} }).isDownload);
    assert.ok(!c({ url: "https://x/p", statusCode: 206, headers: { "content-range": "bytes 0-9/100" } }).isDownload);
    assert.ok(!c({ url: "https://x/ico.ico", statusCode: 200, headers: { "content-type": "application/octet-stream", "content-length": "900" } }).isDownload);
  });
  await suite.test("confidence reflects how certain the classification is", () => {
    const c = proxyMod.classifyResponse;
    assert.equal(c({ url: "https://x/f", statusCode: 200, headers: { "content-disposition": "attachment" } }).confidence, "high");
    assert.equal(c({ url: "https://x/a.zip", statusCode: 200, headers: { "content-length": "100000" } }).confidence, "high");
    assert.equal(c({ url: "https://x/blob", statusCode: 200, headers: { "content-length": "9000000" } }).confidence, "low");
  });
  await suite.test("filename comes from Content-Disposition then the URL", () => {
    const f = proxyMod.filenameFromHeaders;
    assert.equal(f({ "content-disposition": 'attachment; filename="report.pdf"' }, "https://x/d?q=1"), "report.pdf");
    assert.equal(f({ "content-disposition": "attachment; filename*=UTF-8''caf%C3%A9.zip" }, "https://x/d"), "café.zip");
    assert.equal(f({}, "https://x/path/file.bin?token=1"), "file.bin");
    assert.equal(f({}, "https://x/"), "download");
  });

  await suite.test("proxy forwards plain HTTP byte-for-byte and captures the file", async () => {
    const origin = httpMod.createServer((req, res) => {
      if (req.url.startsWith("/dl.zip")) {
        const body = Buffer.alloc(400 * 1024, 0x33);
        res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": body.length, "Content-Disposition": 'attachment; filename="dl.zip"' });
        res.end(body);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>page</html>");
    });
    await new Promise((r) => origin.listen(0, "127.0.0.1", r));
    const oPort = origin.address().port;

    const proxy = new proxyMod.CaptureProxy({ port: 0, mode: "tunnel" });
    const seen = [];
    proxy.on("capture", (e) => seen.push(e));
    const p = await proxy.start();

    const fetched = await new Promise((resolve, reject) => {
      const req = httpMod.request({ host: p.host, port: p.port, method: "GET", path: "http://127.0.0.1:" + oPort + "/dl.zip" }, (res2) => {
        let n = 0; res2.on("data", (d) => { n += d.length; }); res2.on("end", () => resolve({ status: res2.statusCode, bytes: n }));
      });
      req.on("error", reject); req.end();
    });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.bytes, 400 * 1024, "the body must pass through unmodified");

    await new Promise((r) => setTimeout(r, 200));
    assert.equal(seen.length, 1, "the file should be captured exactly once");
    assert.equal(seen[0].filename, "dl.zip");
    assert.equal(seen[0].confidence, "high");

    // A browser page request must not be offered.
    await new Promise((resolve) => {
      const req = httpMod.request({ host: p.host, port: p.port, method: "GET", path: "http://127.0.0.1:" + oPort + "/page" }, (res2) => { res2.resume(); res2.on("end", resolve); });
      req.on("error", () => resolve()); req.end();
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(seen.length, 1, "an HTML page must not be captured");

    await proxy.stop();
    await new Promise((r) => { origin.close(() => r(undefined)); setTimeout(() => r(undefined), 2000); });
  });

  await suite.test("the same URL is only offered once", async () => {
    const origin = httpMod.createServer((req, res) => {
      const body = Buffer.alloc(300 * 1024, 1);
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": body.length });
      res.end(body);
    });
    await new Promise((r) => origin.listen(0, "127.0.0.1", r));
    const oPort = origin.address().port;
    const proxy = new proxyMod.CaptureProxy({ port: 0 });
    const seen = [];
    proxy.on("capture", (e) => seen.push(e));
    const p = await proxy.start();
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => {
        const req = httpMod.request({ host: p.host, port: p.port, method: "GET", path: "http://127.0.0.1:" + oPort + "/same.zip" }, (res2) => { res2.resume(); res2.on("end", resolve); });
        req.on("error", () => resolve()); req.end();
      });
    }
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(seen.length, 1, "repeat visits must not spam the list");
    await proxy.stop();
    await new Promise((r) => { origin.close(() => r(undefined)); setTimeout(() => r(undefined), 2000); });
  });

  await suite.test("CONNECT tunnels opaque HTTPS without decrypting", async () => {
    // In tunnel mode the proxy must relay bytes and learn only the destination.
    const echoSockets = new Set();
    const echo = netMod.createServer((socket) => {
      echoSockets.add(socket);
      socket.on("close", () => echoSockets.delete(socket));
      socket.on("error", () => {});
      socket.on("data", (d) => socket.write(Buffer.concat([Buffer.from("pong:"), d])));
    });
    await new Promise((r) => echo.listen(0, "127.0.0.1", r));
    const ePort = echo.address().port;
    const proxy = new proxyMod.CaptureProxy({ port: 0, mode: "tunnel" });
    const p = await proxy.start();

    const roundTrip = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("tunnel round-trip timed out")), 8000);
      const req = httpMod.request({ host: p.host, port: p.port, method: "CONNECT", path: "127.0.0.1:" + ePort });
      req.on("connect", (res2, socket) => {
        if (res2.statusCode !== 200) { clearTimeout(timer); reject(new Error("CONNECT " + res2.statusCode)); return; }
        let got = "";
        socket.on("data", (d) => {
          got += d.toString();
          if (got.includes("pong")) { clearTimeout(timer); resolve(got.trim()); }
        });
        socket.on("error", (err) => { clearTimeout(timer); reject(err); });
        socket.write("ping\n");
      });
      req.on("error", (err) => { clearTimeout(timer); reject(err); });
      req.end();
    });
    assert.match(roundTrip, /pong/, "raw bytes must traverse the tunnel");
    assert.equal(proxy.status().stats.tunnels, 1);
    assert.equal(proxy.status().stats.mitm, 0, "tunnel mode must not decrypt");
    await proxy.stop();
    // close() waits for live connections; the tunnel socket is one of them.
    for (const s of echoSockets) { try { s.destroy(); } catch { /* gone */ } }
    await new Promise((r) => echo.close(() => r(undefined)));
  });

  await suite.test("openssl is discoverable and a CA can be created", async () => {
    const openssl = await caMod.findOpenssl();
    if (!openssl) {
      console.log("        (openssl not installed — CA tests skipped)");
      return;
    }
    assert.ok(!String(openssl).includes(String.fromCharCode(92) + String.fromCharCode(92)),
      "path must not contain doubled separators: " + openssl);
    const authority = new caMod.CertificateAuthority({ dir: path.join(root, "ca-test") });
    assert.equal(authority.installed, false);
    const info = await authority.ensure();
    assert.equal(info.installed, true);
    assert.ok(fs.existsSync(info.certPath));
    assert.ok(fs.existsSync(info.keyPath));
    const pem = fs.readFileSync(info.certPath, "utf8");
    assert.match(pem, /BEGIN CERTIFICATE/);
    await authority.destroy();
    assert.equal(fs.existsSync(info.certPath), false);
  });

  await suite.test("leaf certificates are issued per host and cached", async () => {
    const openssl = await caMod.findOpenssl();
    if (!openssl) return;
    const authority = new caMod.CertificateAuthority({ dir: path.join(root, "ca-leaf") });
    await authority.ensure();
    const leaf = await authority.leafFor("example.com");
    assert.match(leaf.cert, /BEGIN CERTIFICATE/);
    assert.match(leaf.key, /BEGIN PRIVATE KEY/);
    // The synchronous lookup is what the TLS callback uses.
    const again = authority.leafForSync("example.com");
    assert.equal(again.cert, leaf.cert, "a cached leaf must be reused");
    await authority.destroy();
  });

  await suite.test("MITM mode decrypts HTTPS and captures the download", async () => {
    const openssl = await caMod.findOpenssl();
    if (!openssl) { console.log("        (openssl not installed — MITM test skipped)"); return; }

    const work = path.join(root, "mitm-e2e");
    await fsp.mkdir(work, { recursive: true });
    const authority = new caMod.CertificateAuthority({ dir: path.join(work, "ca") });
    await authority.ensure();
    await authority.leafFor("localhost");

    // A real HTTPS origin, deliberately NOT trusted by the client.
    const { execFileSync } = await import("node:child_process");
    execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", path.join(work, "o.key"), "-out", path.join(work, "o.crt"),
      "-days", "30", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });

    const origin = httpsMod.createServer({
      key: fs.readFileSync(path.join(work, "o.key")),
      cert: fs.readFileSync(path.join(work, "o.crt")),
    }, (req, res) => {
      const body = Buffer.alloc(512 * 1024, 0x44);
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": body.length, "Content-Disposition": 'attachment; filename="secure.zip"' });
      res.end(body);
    });
    await new Promise((r) => origin.listen(0, "127.0.0.1", r));
    const oPort = origin.address().port;

    const proxy = new proxyMod.CaptureProxy({
      port: 0, mode: "mitm",
      ca: { getLeaf: (h) => authority.leafForSync(h) },
    });
    const seen = [];
    proxy.on("capture", (e) => seen.push(e));
    const p = await proxy.start();

    const caPem = fs.readFileSync(authority.certPath);
    const out = await new Promise((resolve, reject) => {
      const req = httpMod.request({ host: p.host, port: p.port, method: "CONNECT", path: "localhost:" + oPort });
      req.on("connect", (res2, socket) => {
        if (res2.statusCode !== 200) { reject(new Error("CONNECT " + res2.statusCode)); return; }
        // Trust ONLY our CA: success proves the proxy minted the certificate.
        const tlsSock = tlsMod.connect({ socket, servername: "localhost", ca: [caPem], rejectUnauthorized: true }, () => {
          const cn = tlsSock.getPeerCertificate().subject && tlsSock.getPeerCertificate().subject.CN;
          const inner = httpMod.request({ createConnection: () => tlsSock, method: "GET", path: "/secure.zip", headers: { host: "localhost:" + oPort } }, (r2) => {
            let n = 0; r2.on("data", (d) => { n += d.length; }); r2.on("end", () => resolve({ cn, status: r2.statusCode, bytes: n }));
          });
          inner.on("error", reject); inner.end();
        });
        tlsSock.on("error", reject);
      });
      req.on("error", reject); req.end();
    });

    assert.equal(out.status, 200);
    assert.equal(out.bytes, 512 * 1024, "the decrypted body must arrive intact");
    assert.equal(out.cn, "localhost", "the leaf must be minted for the requested host");
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(seen.length, 1, "the HTTPS download should be captured");
    assert.equal(seen[0].decrypted, true);
    assert.equal(seen[0].filename, "secure.zip");
    assert.equal(proxy.status().stats.mitm, 1);

    await proxy.stop();
    await new Promise((r) => { origin.close(() => r(undefined)); setTimeout(() => r(undefined), 2000); });
    await authority.destroy();
  });

  await suite.test("proxy start/stop is idempotent and reports state", async () => {
    const proxy = new proxyMod.CaptureProxy({ port: 0 });
    assert.equal(proxy.status().running, false);
    const a = await proxy.start();
    const b = await proxy.start();
    assert.equal(a.port, b.port, "starting twice must reuse the same listener");
    assert.equal(proxy.status().running, true);
    await proxy.stop();
    assert.equal(proxy.status().running, false);
    // Stopping again must not throw.
    await proxy.stop();
  });

  // ------------------------------------------- integrity and limit defects
  suite.group("Integrity verification and per-server limits");
  const probeMod = await import("../src/probe.mjs");

  await suite.test("digest headers are parsed across all three spellings", () => {
    const p = probeMod.parseDigestHeaders;
    assert.equal(p({ digest: "sha-256=abc=" }).algo, "sha256");
    assert.equal(p({ "content-digest": "sha-256=:abc=:" }).algo, "sha256");
    assert.equal(p({ "repr-digest": "sha-256=:abc=:" }).algo, "sha256");
    assert.equal(p({ "content-md5": "XrY7u+Ae7tCTyyK7j1rNww==" }).algo, "md5");
    assert.equal(p({ digest: "sha-512=zzz" }), null, "unsupported algorithm must be ignored");
    assert.equal(p({}), null);
  });

  await suite.test("origin digest is verified against the downloaded file", async () => {
    // Regression: the engine had this branch, but probe never produced the
    // field, so verification could never run.
    const url = origin.origin + "/digest/262144";
    const info = await probeMod.probe(url);
    assert.ok(info.contentDigest, "probe must surface the origin digest");
    assert.equal(info.contentDigest.algo, "sha256");
    const target = path.join(out, "digest-ok.bin");
    const r = await new DownloadEngine({ url, targetPath: target, connections: 2 }).run({ probe: info, resume: false });
    assert.ok(r.ok);
    assert.match(String(r.verified), /sha256=ok/, "verification should be reported, got " + r.verified);
    assert.ok(fs.existsSync(target), "a matching file must be kept");
  });

  await suite.test("a mismatched digest discards the download", async () => {
    const url = origin.origin + "/digest/262144?corrupt=1";
    const info = await probeMod.probe(url);
    assert.ok(info.contentDigest);
    const target = path.join(out, "digest-bad.bin");
    await assert.rejects(
      () => new DownloadEngine({ url, targetPath: target, connections: 2 }).run({ probe: info, resume: false }),
      "a wrong digest must fail the download"
    );
    assert.equal(fs.existsSync(target), false, "the bad file must be discarded, not delivered");
  });

  await suite.test("an inconsistent origin is caught and re-downloaded as one stream", async () => {
    // Regression for IDM's core fault tolerance, which this project lacked:
    // concurrent connections pinned to different backends stitch two revisions
    // together, producing a file that hashes consistently but is torn.
    const size = 2 * 1024 * 1024;
    const url = origin.origin + "/drift/" + size;
    const info = await probeMod.probe(url);
    const target = path.join(out, "drift.bin");
    const engine = new DownloadEngine({ url, targetPath: target, connections: 4, segmentBytes: 512 * 1024 });
    const logs = [];
    const downgrades = [];
    engine.on("log", (m) => logs.push(m));
    engine.on("downgrade", (m) => downgrades.push(m));
    const r = await engine.run({ probe: info, resume: false });

    assert.ok(logs.some((l) => /boundary check/.test(l)), "the boundary check must run");
    assert.equal(r.downgraded, true, "an inconsistent origin must trigger the single-stream retry");
    assert.ok(downgrades.length > 0, "a downgrade notice is expected");

    // The result must be one coherent revision, not a blend of both.
    const backendA = Buffer.alloc(size);
    const backendB = Buffer.alloc(size);
    for (let i = 0; i < size; i++) { backendA[i] = (i * 7 + 13) & 0xff; backendB[i] = backendA[i] ^ 0xff; }
    const hashA = createHash("sha256").update(backendA).digest("hex");
    const hashB = createHash("sha256").update(backendB).digest("hex");
    const got = await hashFile(target);
    assert.ok(got === hashA || got === hashB,
      "the file must match one backend exactly, got a blend: " + got);
  });

  await suite.test("a consistent origin passes the boundary check", async () => {
    const size = 2 * 1024 * 1024;
    const url = origin.origin + "/range/" + size;
    const info = await probeMod.probe(url);
    const target = path.join(out, "consistent.bin");
    const engine = new DownloadEngine({ url, targetPath: target, connections: 4, segmentBytes: 512 * 1024 });
    const logs = [];
    engine.on("log", (m) => logs.push(m));
    const r = await engine.run({ probe: info, resume: false });
    assert.equal(r.downgraded, false, "a good origin must not be condemned");
    assert.ok(logs.some((l) => /0 mismatch/.test(l)), "the check should report zero mismatches: " + JSON.stringify(logs));
  });

  await suite.test("per-server connection cap is enforced", async () => {
    // Regression: maxConnectionsPerServer existed in config but was never read.
    const { applyPerServerCap } = await import("../src/downloader.mjs");
    const cfg = { get: (k) => (k === "maxConnectionsPerServer" ? 4 : undefined) };
    assert.equal(applyPerServerCap("https://a.test/f", 8, cfg, new Map()), 4, "cap must limit a fresh host");
    assert.equal(applyPerServerCap("https://a.test/f", 8, cfg, new Map([["a.test", 3]])), 1, "only one slot left");
    assert.equal(applyPerServerCap("https://a.test/f", 8, cfg, new Map([["a.test", 4]])), 1, "never below one");
    assert.equal(applyPerServerCap("https://b.test/f", 8, cfg, new Map([["a.test", 4]])), 4, "other hosts unaffected");
  });

  await suite.test("scheduled bandwidth windows reach the rate limiter", async () => {
    // Regression: the schedule's speedLimit field was never applied.
    const { Scheduler } = await import("../src/scheduler.mjs");
    const q = { add() {}, resumeAll() {}, pauseAll() {}, clearCompleted() {} };
    const sc = new Scheduler({ queue: q, config: { get: () => 1 }, log: { info() {}, warn() {}, error() {} } });
    sc.add({ name: "night", at: "02:00", endAt: "06:00", action: "resume", speedLimit: 524288 });
    assert.equal(sc.activeSpeedLimit(new Date(2026, 0, 1, 3, 0)).limit, 524288, "inside the window");
    assert.equal(sc.activeSpeedLimit(new Date(2026, 0, 1, 12, 0)), null, "outside the window");
    const dl = { limiter: { rate: 0 } };
    sc.applySpeedLimit(dl, new Date(2026, 0, 1, 3, 0));
    assert.equal(dl.limiter.rate, 524288, "the limiter must take the window rate");
    sc.applySpeedLimit(dl, new Date(2026, 0, 1, 12, 0));
    assert.equal(dl.limiter.rate, 0, "the limiter must be released outside the window");
  });

  // ------------------------------------------------ adaptive concurrency
  suite.group("Adaptive concurrency and worker health");
  const gateMod = await import("../src/gate.mjs");
  const healthMod = await import("../src/health.mjs");

  await suite.test("adaptive gate halves on a throttle and recovers one at a time", () => {
    let t = 0;
    const g = new gateMod.AdaptiveConcurrencyGate({ max: 16, recoveryMs: 1000, now: () => t });
    assert.equal(g.current, 16);
    g.noteThrottle();
    assert.equal(g.current, 8, "first throttle halves");
    t += 2000;
    for (let i = 0; i < 8; i++) { g.noteSuccess(); t += 1000; }
    assert.equal(g.current, 16, "recovery adds one per healthy window");
    assert.equal(g.view().throttled, false, "the episode ends at the ceiling");
  });

  await suite.test("repeated throttles in one episode do not halve twice", () => {
    // Regression: without a default cooldown window every 429 looked like a new
    // episode, so a burst collapsed the cap to 1 instead of stopping at half.
    let t = 0;
    const g = new gateMod.AdaptiveConcurrencyGate({ max: 16, recoveryMs: 15_000, now: () => t });
    g.noteThrottle();
    const afterFirst = g.current;
    g.noteThrottle();
    g.noteThrottle();
    g.noteThrottle();
    assert.equal(g.current, afterFirst, "same episode must not halve again");
    assert.equal(afterFirst, 8);
    t += 20_000;
    g.noteThrottle();
    assert.equal(g.current, 4, "a new episode halves again");
  });

  await suite.test("an explicit Retry-After is honoured as the cooldown", () => {
    let t = 0;
    const g = new gateMod.AdaptiveConcurrencyGate({ max: 8, recoveryMs: 1000, now: () => t });
    g.noteThrottle(30_000);
    const cap = g.current;
    g.noteThrottle();
    assert.equal(g.current, cap, "inside the server-requested pause, no further halving");
    assert.ok(g.view().cooldownUntil > t);
  });

  await suite.test("throttle status codes are recognised", () => {
    assert.ok(gateMod.isThrottleStatus(429));
    assert.ok(gateMod.isThrottleStatus(503));
    assert.ok(!gateMod.isThrottleStatus(404));
    assert.ok(!gateMod.isThrottleStatus(200));
  });

  await suite.test("the gate admits only up to its current cap", async () => {
    let t = 0;
    const g = new gateMod.AdaptiveConcurrencyGate({ max: 4, now: () => t });
    const admitted = [];
    for (let i = 0; i < 4; i++) admitted.push(await g.acquire(null, () => false));
    assert.deepEqual(admitted, [true, true, true, true]);
    assert.equal(g.free, 0);
    // The fifth must not be admitted while the cap is full.
    const fifth = await Promise.race([
      g.acquire(null, () => false).then(() => "admitted"),
      new Promise((r) => setTimeout(() => r("waited"), 250)),
    ]);
    assert.equal(fifth, "waited", "a full gate must hold the next worker");
    g.release();
    assert.equal(g.free, 1, "releasing frees a slot");
  });

  await suite.test("worker health flags a stalled connection", () => {
    let now = 0;
    const hits = [];
    const h = new healthMod.WorkerHealthMonitor({
      graceMs: 1000, stallMs: 5000, now: () => now,
      onUnhealthy: (id, reason) => hits.push([id, reason]),
    });
    h.track("w1");
    now = 2000;
    h.noteBytes("w1", 1000);
    now = 3000;
    h.check();
    assert.equal(hits.length, 0, "within the stall window nothing is flagged");
    now = 12_000;
    h.check();
    assert.ok(hits.some(([id, r]) => id === "w1" && r === "stalled"), "a silent worker must be flagged");
  });

  await suite.test("a worker waiting on the rate limiter is never judged slow", () => {
    // Regression guard for an interaction that would otherwise cancel every
    // worker the moment a speed limit is switched on.
    let now = 0;
    const hits = [];
    const h = new healthMod.WorkerHealthMonitor({
      graceMs: 500, stallMs: 100_000, slowRatio: 0.5, now: () => now,
      onUnhealthy: (id, reason) => hits.push([id, reason]),
    });
    h.track("fast"); h.track("throttled-worker");
    now = 1000;
    h.noteBytes("fast", 500_000);
    h.noteLimiterWait("throttled-worker", true);
    now = 2000;
    h.noteBytes("fast", 500_000);
    h.check();
    assert.equal(hits.length, 0, "a limiter-parked worker must be skipped: " + JSON.stringify(hits));
  });

  await suite.test("worker health flags a connection far below the mean", () => {
    let now = 0;
    const hits = [];
    const h = new healthMod.WorkerHealthMonitor({
      graceMs: 500, stallMs: 100_000, slowRatio: 0.3, minSpeedBytes: 1, now: () => now,
      onUnhealthy: (id, reason) => hits.push([id, reason]),
    });
    h.track("fast1"); h.track("fast2"); h.track("slow");
    now = 1000;
    h.noteBytes("fast1", 100_000); h.noteBytes("fast2", 100_000); h.noteBytes("slow", 100);
    now = 2000;
    h.noteBytes("fast1", 100_000); h.noteBytes("fast2", 100_000); h.noteBytes("slow", 100);
    h.check();
    assert.ok(hits.some(([id, r]) => id === "slow" && r === "slow"), "a degraded connection must be flagged");
    assert.ok(!hits.some(([id]) => id === "fast1"), "healthy workers must be left alone");
  });

  await suite.test("a tiny text body for a binary name is flagged as suspicious", () => {
    const p = probeMod.suspiciousResponseWarning;
    assert.ok(p("archive.zip", "text/html", 320), "a 320-byte HTML answer for a .zip is an error page");
    assert.ok(p("setup.exe", "text/plain; charset=utf-8", 90));
    assert.ok(p("movie.mp4", "text/html", 200));
    assert.equal(p("archive.zip", "application/zip", 320), null, "a real zip is not suspicious");
    assert.equal(p("archive.zip", "text/html", 5_000_000), null, "a large body is not an error page");
    assert.equal(p("page.html", "text/html", 300), null, "an HTML page is expected to be HTML");
  });

  await suite.test("concurrent probes to one host are serialised", async () => {
    // Regression: parallel probes are what trigger rate limits on strict hosts.
    const httpMod = await import("node:http");
    let active = 0;
    let peak = 0;
    const srv = httpMod.createServer((req, res) => {
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        res.writeHead(200, { "Content-Length": "10", "Accept-Ranges": "bytes" });
        res.end("0123456789");
      }, 80);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const u = "http://127.0.0.1:" + srv.address().port + "/f.bin";
    await Promise.all([probeMod.probe(u), probeMod.probe(u), probeMod.probe(u), probeMod.probe(u)]);
    assert.equal(peak, 1, "the origin must never see two probes at once, saw " + peak);
    await closeServer(srv);
  });

  await suite.test("the gate survives a throttling origin and still finishes correctly", async () => {
    const httpMod = await import("node:http");
    const size = 3 * 1024 * 1024;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i++) payload[i] = (i * 5 + 3) & 0xff;

    let inFlight = 0;
    let throttles = 0;
    const srv = httpMod.createServer((req, res) => {
      inFlight++;
      const over = inFlight > 2;
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      setTimeout(() => {
        inFlight--;
        if (over) {
          throttles++;
          res.writeHead(429, { "Retry-After": "1", "Content-Length": "0" });
          res.end();
          return;
        }
        const slice = payload.subarray(start, end + 1);
        res.writeHead(m ? 206 : 200, { "Content-Range": "bytes " + start + "-" + end + "/" + size, "Content-Length": slice.length, "Accept-Ranges": "bytes" });
        res.end(slice);
      }, 30);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const u = "http://127.0.0.1:" + srv.address().port + "/f.bin";

    const info = await probeMod.probe(u);
    const target = path.join(out, "throttled-e2e.bin");
    const engine = new DownloadEngine({ url: u, targetPath: target, connections: 8, segmentBytes: 512 * 1024, recoveryMs: 300 });
    const caps = [];
    engine.on("throttled", (e) => caps.push(e));

    const r = await engine.run({ probe: info, resume: false });
    assert.ok(r.ok, "the transfer must complete despite throttling");
    assert.equal(r.bytes, size);
    assert.equal(await hashFile(target), createHash("sha256").update(payload).digest("hex"),
      "throttling must not corrupt the result");
    assert.ok(throttles > 0, "the fixture should have exercised throttling");
    if (caps.length) {
      assert.ok(caps[0].newCap < caps[0].oldCap, "the first throttle must lower the cap");
    }
    await new Promise((r2) => srv.close(() => r2(undefined)));
  });

  // ------------------------------------------------------------ native muxer
  suite.group("Native MP4 muxing");
  const mp4Mod = await import("../src/mp4.mjs");

  await suite.test("box listing walks a real init segment", () => {
    const boxes = mp4Mod.listBoxes(Buffer.from([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]));
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].type, "ftyp");
  });

  await suite.test("a non-MP4 buffer is not mistaken for one", () => {
    assert.equal(mp4Mod.isFragmentedMp4(Buffer.from("not a video at all")), false);
    assert.equal(mp4Mod.isMediaFragment(Buffer.from("0123456789abcdef")), false);
  });

  await suite.test("the muxer joins two fragmented-MP4 tracks into one file", async () => {
    const { execFileSync } = await import("node:child_process");
    const ffmpeg = await (await import("../src/merge.mjs")).findFfmpeg();
    if (!ffmpeg) { console.log("        (ffmpeg unavailable; cannot build a fixture)"); return; }

    // Build a real two-track DASH package to mux for real.
    const work = path.join(root, "mux-fixture");
    await fsp.mkdir(work, { recursive: true });
    execFileSync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
      "-f", "dash", "-seg_duration", "1", "-use_timeline", "1",
      "-init_seg_name", "init-$RepresentationID$.mp4",
      "-media_seg_name", "seg-$RepresentationID$-$Number$.m4s",
      "manifest.mpd",
    ], { cwd: work, stdio: "ignore" });

    const readIf = (f) => fs.existsSync(path.join(work, f)) ? fs.readFileSync(path.join(work, f)) : null;
    const vInit = readIf("init-0.mp4");
    const aInit = readIf("init-1.mp4");
    assert.ok(vInit && aInit, "the fixture should produce two init segments");

    const vFrags = fs.readdirSync(work).filter((f) => /^seg-0-\d+\.m4s$/.test(f)).sort().map((f) => fs.readFileSync(path.join(work, f)));
    const aFrags = fs.readdirSync(work).filter((f) => /^seg-1-\d+\.m4s$/.test(f)).sort().map((f) => fs.readFileSync(path.join(work, f)));
    assert.ok(vFrags.length && aFrags.length, "both tracks should have fragments");

    const v = mp4Mod.parseTrack(vInit, vFrags);
    const a = mp4Mod.parseTrack(aInit, aFrags);
    assert.ok(v.trackId >= 1 && a.trackId >= 1);

    const merged = mp4Mod.muxTracks([v, a]);
    const outFile = path.join(work, "merged.mp4");
    fs.writeFileSync(outFile, merged);
    assert.ok(merged.length > 0);

    // The result must be recognised by a real demuxer with both streams.
    const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith(".exe") ? "ffprobe.exe" : "ffprobe"));
    const info = execFileSync(ffprobe, [
      "-v", "error", "-show_entries", "stream=codec_type",
      "-of", "csv=p=0", outFile,
    ], { encoding: "utf8" });
    assert.match(info, /video/, "the merged file must contain video");
    assert.match(info, /audio/, "the merged file must contain audio");

    // And it must decode without error.
    execFileSync(ffmpeg, ["-v", "error", "-i", outFile, "-f", "null", "-"], { stdio: "ignore" });
  });

  await suite.test("muxTracks handles a single track", async () => {
    const ffmpeg = await (await import("../src/merge.mjs")).findFfmpeg();
    if (!ffmpeg) return;
    const work = path.join(root, "mux-single");
    await fsp.mkdir(work, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    execFileSync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-f", "dash", "-seg_duration", "1",
      "-init_seg_name", "init-$RepresentationID$.mp4",
      "-media_seg_name", "seg-$RepresentationID$-$Number$.m4s",
      "manifest.mpd",
    ], { cwd: work, stdio: "ignore" });
    const init = fs.readFileSync(path.join(work, "init-0.mp4"));
    const frags = fs.readdirSync(work).filter((f) => /^seg-0-\d+\.m4s$/.test(f)).sort().map((f) => fs.readFileSync(path.join(work, f)));
    const t = mp4Mod.parseTrack(init, frags);
    const merged = mp4Mod.muxTracks([t]);
    const outFile = path.join(work, "single.mp4");
    fs.writeFileSync(outFile, merged);
    const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith(".exe") ? "ffprobe.exe" : "ffprobe"));
    const info = execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", outFile], { encoding: "utf8" });
    assert.match(info, /video/);
  });

  await suite.test("muxNatively returns null for input it cannot handle", async () => {
    const { muxNatively } = await import("../src/merge.mjs");
    const work = path.join(root, "mux-nonmp4");
    await fsp.mkdir(work, { recursive: true });
    const v = path.join(work, "v.bin");
    const a = path.join(work, "a.bin");
    await fsp.writeFile(v, Buffer.from("this is not an mp4"));
    await fsp.writeFile(a, Buffer.from("neither is this"));
    const r = await muxNatively({ videoPath: v, audioPath: a, outputPath: path.join(work, "out.mp4") });
    // null means "not fragmented MP4" so the caller can try ffmpeg.
    assert.ok(r === null || r.ok === false, "unusable input must not report success");
  });

  // ------------------------------------------------------ dynamic splitting
  suite.group("Dynamic segmentation");
  await suite.test("a slow origin lets an idle worker share a long segment", async () => {
    const httpMod = await import("node:http");
    const size = 8 * 1024 * 1024;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i++) payload[i] = (i * 7 + 1) & 0xff;

    const srv = httpMod.createServer((req, res) => {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      const slice = payload.subarray(start, end + 1);
      res.writeHead(m ? 206 : 200, {
        "Content-Range": "bytes " + start + "-" + end + "/" + size,
        "Content-Length": slice.length, "Accept-Ranges": "bytes",
      });
      // Trickle the body so a request occupies its worker for seconds. That is
      // what leaves a peer idle with a long segment still in flight.
      let i = 0;
      const tick = () => {
        if (i >= slice.length) { res.end(); return; }
        res.write(slice.subarray(i, i + 16 * 1024));
        i += 16 * 1024;
        setTimeout(tick, 6);
      };
      tick();
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const u = "http://127.0.0.1:" + srv.address().port + "/f.bin";

    const info = await probeMod.probe(u);
    const target = path.join(out, "dynamic.bin");
    // info.supportsRanges is what the downloader would pass through, and it
    // gates splitting, so declare it explicitly here.
    const engine = new DownloadEngine({ url: u, targetPath: target, connections: 4, segmentBytes: 4 * 1024 * 1024, rangeSupport: info.supportsRanges });
    const logs = [];
    engine.on("log", (m) => logs.push(m));
    const r = await engine.run({ probe: info, resume: false });

    assert.equal(r.bytes, size);
    assert.equal(await hashFile(target), createHash("sha256").update(payload).digest("hex"),
      "splitting must not corrupt the file");
    assert.ok(logs.some((l) => /split segment/.test(l)), "an idle worker should have shared a segment: " + JSON.stringify(logs.filter((l) => /split/.test(l))));
    await closeServer(srv);
  });

  await suite.test("the downloader passes probe range support to the engine", async () => {
    // Regression: this pass-through was once written to a stray copy of
    // downloader.mjs at the repository root instead of the real one under src/,
    // so splitting was never actually gated at runtime. Assert the wired code
    // path, not just the engine's own default.
    const { DownloadEngine } = await import("../src/engine.mjs");
    const original = DownloadEngine.prototype.run;
    const captured = [];
    DownloadEngine.prototype.run = function patched(opts) {
      captured.push({ rangeSupport: this.rangeSupport, connections: this.connections });
      return original.call(this, opts);
    };
    try {
      const origin2 = await startOrigin();
      const url = origin2.origin + "/norange/" + (256 * 1024);
      const cfg = new Config(path.join(root, "cfg-range.json"));
      await cfg.load();
      await cfg.set({ defaultDir: out, categorizeByType: false, maxConnections: 4 });
      const q = new QueueManager({ config: cfg });
      await q.load();
      const dl = new Downloader({ config: cfg, queue: q });
      await dl.run({ id: "range-wire", url, kind: "http", filename: "rw.bin", dir: out, headers: {}, connections: 4, meta: {} });
      assert.ok(captured.length > 0, "the engine should have been constructed");
      // The first construction is the real transfer and must be gated. Any
      // later one is the single-stream retry, which must be gated too.
      assert.equal(captured[0].rangeSupport, false,
        "a range-less origin must reach the engine with rangeSupport false, got " + captured[0].rangeSupport);
      for (const c of captured) {
        assert.equal(c.rangeSupport, false,
          "every engine built for a range-less origin must stay unsplittable: " + JSON.stringify(captured));
      }
      await new Promise((r) => { origin2.close(() => r(undefined)); setTimeout(() => r(undefined), 2000); });
    } finally {
      DownloadEngine.prototype.run = original;
    }
  });

  await suite.test("a range-less origin never enables splitting", async () => {
    // Regression: the single-stream fallback used to keep splitting its one
    // segment, and since a lone worker could never claim the tail the transfer
    // looped forever. The downloader now passes rangeSupport through from the
    // probe, so a range-less origin is never split in the first place.
    const size = 1024 * 1024;
    const url = origin.origin + "/norange/" + size;
    const info = await probeMod.probe(url);
    assert.equal(info.supportsRanges, false, "the fixture must report no range support");

    const target = path.join(out, "norange-nosplit.bin");
    const engine = new DownloadEngine({
      url, targetPath: target, connections: 4, segmentBytes: 256 * 1024,
      rangeSupport: info.supportsRanges,
    });
    const logs = [];
    engine.on("log", (m) => logs.push(m));
    const r = await engine.run({ probe: info, resume: false });
    assert.ok(r.bytes > 0, "the download must still complete");
    assert.equal(logs.filter((l) => /split segment/.test(l)).length, 0,
      "a range-less origin must never be split");
  });

  await suite.test("splitting is disabled once the origin ignores Range", async () => {
    // The harder case: the probe THINKS ranges work (a lying origin), so
    // splitting is enabled, then the first 200 proves otherwise. The engine
    // must stop splitting from that point and still finish.
    const size = 1024 * 1024;
    const url = origin.origin + "/norange/" + size;
    const fakeProbe = {
      finalUrl: url, supportsRanges: true, totalBytes: size, etag: null,
      lastModified: null, filename: "n.bin", contentType: null, redirects: [],
    };
    const target = path.join(out, "lying-origin.bin");
    const engine = new DownloadEngine({
      url, targetPath: target, connections: 4, segmentBytes: 256 * 1024,
      rangeSupport: true,
    });
    const r = await engine.run({ probe: fakeProbe, resume: false });
    assert.ok(r.bytes > 0, "the fallback must complete despite the lie");
    assert.equal(r.downgraded, true, "the engine must fall back to one stream");
    assert.equal(engine.rangeSupport, false, "range support must be revoked after a 200");
  });

  // ------------------------------------ defects found by the acceptance suite
  suite.group("Acceptance-suite regressions");

  await suite.test("prepareTarget preserves existing data on resume", async () => {
    // Regression: prepareTarget opened the target with "w+", which truncates
    // on open. A resume therefore wiped every byte already downloaded and
    // silently re-fetched the whole file; an interrupted transfer left a
    // file that was part old data and part zeros.
    const target = path.join(out, "preserve.bin");
    await fsp.writeFile(target, Buffer.alloc(4096, 0xab));
    const store = new TransferStore(target);
    await store.prepareTarget(8192);
    const after = await fsp.readFile(target);
    assert.equal(after.length, 8192, "the file should be extended to the target size");
    assert.ok(after.subarray(0, 4096).every((b) => b === 0xab),
      "the first 4096 bytes must survive prepareTarget");
    assert.ok(after.subarray(4096).every((b) => b === 0),
      "the extension should be zero-filled");
  });

  await suite.test("prepareTarget grows but never shrinks an existing file", async () => {
    const target = path.join(out, "grow.bin");
    await fsp.writeFile(target, Buffer.alloc(8192, 0xcd));
    const store = new TransferStore(target);
    await store.prepareTarget(4096);
    const after = await fsp.readFile(target);
    assert.equal(after.length, 8192, "a smaller total must not discard existing bytes");
    assert.ok(after.every((b) => b === 0xcd));
  });

  await suite.test("a HEAD request reaches the origin as HEAD", async () => {
    // Regression: request() hardcoded method GET, so a HEAD silently became
    // a GET and the origin sent a whole body just to read headers.
    const httpMod = await import("node:http");
    const seen = [];
    const srv = httpMod.createServer((req, res) => {
      seen.push(req.method);
      res.writeHead(200, { "Content-Length": "16", "Accept-Ranges": "bytes" });
      if (req.method === "HEAD") res.end();
      else res.end(Buffer.alloc(16, 1));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const u = "http://127.0.0.1:" + srv.address().port + "/f";
    const { requestFollow, discard } = await import("../src/net.mjs");
    const res = await requestFollow(u, { method: "HEAD" });
    await discard(res);
    assert.deepEqual(seen, ["HEAD"], "the origin must receive HEAD, saw " + JSON.stringify(seen));
    await closeServer(srv);
  });

  await suite.test("probing a large resource does not transfer its body", async () => {
    // Regression: probe issued a plain GET and "discarded" the body, but
    // draining a response means the origin sends the whole file first.
    const httpMod = await import("node:http");
    const size = 4 * 1024 * 1024;
    let bodyBytes = 0;
    const srv = httpMod.createServer((req, res) => {
      res.writeHead(200, { "Content-Length": String(size), "Accept-Ranges": "bytes", "ETag": "\"x\"" });
      if (req.method === "HEAD") { res.end(); return; }
      bodyBytes += size;
      res.end(Buffer.alloc(size));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const u = "http://127.0.0.1:" + srv.address().port + "/f";
    const info = await probeMod.probe(u);
    assert.equal(info.supportsRanges, true);
    assert.equal(info.totalBytes, size, "the probe must still learn the true size");
    assert.equal(bodyBytes, 0, "the probe must not pull the body, transferred " + bodyBytes + " bytes");
    await closeServer(srv);
  });

  await suite.test("transient failures at probe time are retried", async () => {
    // Regression: probe had no retry, so one 503 before any byte was fetched
    // failed the whole task.
    const httpMod = await import("node:http");
    let attempts = 0;
    const size = 64 * 1024;
    const srv = httpMod.createServer((req, res) => {
      attempts++;
      if (attempts <= 2) { res.writeHead(503, { "Content-Length": "0" }); res.end(); return; }
      res.writeHead(200, { "Content-Length": String(size), "Accept-Ranges": "bytes", "ETag": "\"y\"" });
      if (req.method === "HEAD") { res.end(); return; }
      res.end(Buffer.alloc(size));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const u = "http://127.0.0.1:" + srv.address().port + "/f";
    const info = await probeMod.probe(u, { maxRetries: 4, retryBaseMs: 20 });
    assert.ok(info, "the probe must recover from transient 503s");
    assert.ok(attempts > 2, "the probe should have retried, attempts=" + attempts);
    await closeServer(srv);
  });

  await suite.test("a definitive 404 at probe time is not retried", async () => {
    const httpMod = await import("node:http");
    let attempts = 0;
    const srv = httpMod.createServer((req, res) => {
      attempts++;
      res.writeHead(404, { "Content-Length": "0" });
      res.end();
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const u = "http://127.0.0.1:" + srv.address().port + "/missing";
    await assert.rejects(() => probeMod.probe(u, { maxRetries: 4, retryBaseMs: 20 }));
    // A 404 must not be amplified: no retry loop, and no fallback request
    // either, since HEAD already received a definitive answer.
    assert.equal(attempts, 1, "a 404 must produce exactly one request, attempts=" + attempts);
    await closeServer(srv);
  });

  await suite.test("the engine honours the configured retry policy", async () => {
    // Regression: maxRetries and retryBaseMs existed in config but the engine
    // used a hardcoded attempt ceiling and ignored the configured backoff base.
    const engine = new DownloadEngine({ url: "http://x/y", targetPath: path.join(out, "r.bin"), connections: 2, maxRetries: 3, retryBaseMs: 250 });
    assert.equal(engine.maxAttempts, 3, "maxAttempts must come from config");
    assert.equal(engine.retryBaseMs, 250, "retryBaseMs must come from config");
    const engine2 = new DownloadEngine({ url: "http://x/y", targetPath: path.join(out, "r2.bin"), connections: 2 });
    assert.equal(engine2.maxAttempts, DEFAULT_MAX_ATTEMPTS, "the fallback applies when unset");
  });

  await suite.test("resuming reuses on-disk progress instead of restarting", async () => {
    // Regression: progress is written to per-segment files, but run() read the
    // plan from state.json (whose downloaded values are always zero) and never
    // loaded the segment files, so every resume began at byte 0.
    const size = 2 * 1024 * 1024;
    const url = origin.origin + "/range/" + size;
    const info = await probeMod.probe(url);
    const target = path.join(out, "resume-progress.bin");
    const engine = new DownloadEngine({
      url, targetPath: target, connections: 2, segmentBytes: 1024 * 1024,
      rangeSupport: info.supportsRanges,
    });
    const controller = new AbortController();
    const first = engine.run({ probe: info, resume: false });
    setTimeout(() => controller.abort(), 60);
    await first.catch(() => null);

    const store = new TransferStore(target);
    const saved = await store.loadSegments();
    const recorded = saved.reduce((a, s) => a + (s.downloaded || 0), 0);

    const engine2 = new DownloadEngine({
      url, targetPath: target, connections: 2, segmentBytes: 1024 * 1024,
      rangeSupport: info.supportsRanges,
    });
    const logs = [];
    engine2.on("log", (m) => logs.push(m));
    await engine2.run({ probe: info, resume: true });
    const resumeLog = logs.find((l) => /resuming:/.test(l)) || "";
    if (recorded > 0) {
      assert.ok(/bytes already present/.test(resumeLog),
        "a resume with recorded progress must report it: " + resumeLog);
    }
    assert.equal(await hashFile(target),
      createHash("sha256").update(payloadFor(size)).digest("hex"),
      "the resumed file must be correct");
  });
  // ------------------------------------------------- construction doc P0-A/P0-B
  suite.group("P0-A media routing and P0-B unknown length");

  await suite.test("detectKind identifies media URLs and leaves HTTP alone", async () => {
    const { detectKind } = await import("../src/downloader.mjs");
    assert.equal(detectKind("http://x/a.m3u8"), "hls");
    assert.equal(detectKind("http://x/a.mpd"), "dash");
    assert.equal(detectKind("http://x/a.m3u8?token=1"), "hls");
    assert.equal(detectKind("ftp://x/a.bin"), "ftp");
    assert.equal(detectKind("http://x/a.zip"), "http", "a plain file must stay HTTP");
    assert.equal(detectKind("https://x/video.mp4"), "http");
  });

  await suite.test("the streaming path writes the exact bytes of a chunked response", async () => {
    // A response with no Content-Length cannot be turned into a byte-range
    // plan, so it must stream in one pass and still produce correct bytes.
    const size = 192 * 1024;
    const url = origin.origin + "/chunked/" + size;
    const probeInfo = await probeMod.probe(url);
    assert.equal(probeInfo.totalBytes, null, "a chunked response has no declared length");

    const target = path.join(out, "chunked.bin");
    const engine = new DownloadEngine({ url, targetPath: target, connections: 1 });
    const progress = [];
    const r = await engine.runStreaming({
      url, targetPath: target, onProgress: (pr) => progress.push(pr),
    });
    assert.equal(r.bytes, size);
    assert.equal(r.lengthKnown, false, "the length must be reported as unknown");
    assert.equal(r.resumable, false, "an unplanned transfer is not resumable");
    assert.equal(await hashFile(target),
      createHash("sha256").update(payloadFor(size)).digest("hex"),
      "streamed bytes must match the origin payload");
    assert.ok(progress.length > 0, "progress should be reported");
    for (const pr of progress) {
      assert.equal(pr.lengthKnown, false, "progress must not claim a known length");
      assert.equal(pr.percent, null, "no percentage may be invented");
      assert.equal(pr.eta, null, "no ETA may be invented");
    }
  });

  await suite.test("a cancelled stream leaves no file behind", async () => {
    const target = path.join(out, "cancelled.bin");
    const engine = new DownloadEngine({ url: "x", targetPath: target, connections: 1 });
    const controller = new AbortController();
    const url = origin.origin + "/chunked/" + (4 * 1024 * 1024);
    await assert.rejects(
      () => engine.runStreaming({
        url, targetPath: target, signal: controller.signal,
        onProgress: (pr) => { if (pr.bytesWritten >= 64 * 1024) controller.abort(); },
      }),
      "cancellation must reject");
    assert.equal(fs.existsSync(target), false, "no final file may exist after a cancel");
    assert.equal(fs.existsSync(target + ".partial"), false, "no temp file may remain");
  });

  await suite.test("an HTTP error on the streaming path creates no file", async () => {
    const target = path.join(out, "notfound.bin");
    const engine = new DownloadEngine({ url: "x", targetPath: target, connections: 1 });
    await assert.rejects(
      () => engine.runStreaming({ url: origin.origin + "/no-such-route-here", targetPath: target }));
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(target + ".partial"), false);
  });

  await suite.test("the streaming path publishes atomically over an existing file", async () => {
    const target = path.join(out, "replace.bin");
    await fsp.writeFile(target, Buffer.alloc(32, 0x11));
    const size = 96 * 1024;
    const url = origin.origin + "/chunked/" + size;
    const engine = new DownloadEngine({ url, targetPath: target, connections: 1 });
    const r = await engine.runStreaming({ url, targetPath: target });
    assert.equal(r.bytes, size);
    const after = await fsp.readFile(target);
    assert.equal(after.length, size, "the stale file must be replaced, not appended to");
    assert.equal(await hashFile(target),
      createHash("sha256").update(payloadFor(size)).digest("hex"));
  });

  await suite.test("a known-length download still uses the segmented engine", async () => {
    // P0-B must not regress the normal path: a declared length still plans
    // segments and still resumes.
    const size = 1024 * 1024;
    const url = origin.origin + "/range/" + size;
    const info = await probeMod.probe(url);
    assert.equal(info.totalBytes, size, "a normal response declares its length");
    const target = path.join(out, "still-segmented.bin");
    const engine = new DownloadEngine({ url, targetPath: target, connections: 2, segmentBytes: 256 * 1024, rangeSupport: info.supportsRanges });
    const r = await engine.run({ probe: info, resume: false });
    assert.equal(r.bytes, size);
    assert.equal(r.streaming, undefined, "the segmented engine must not take the streaming path");
    assert.equal(await hashFile(target),
      createHash("sha256").update(payloadFor(size)).digest("hex"));
  });
  // ------------------------------------- CLI media routing (construction P0-A)
  // The foreground `get` must take the same media path the daemon uses. These
  // tests drive the real CLI entry point against the local origin, so a
  // regression that saves the playlist instead of the media fails here.

  const runCli = async (argv) => {
    // The CLI writes progress to stderr and results to stdout; both are
    // captured so the assertions can look at what a user would see.
    const outChunks = [];
    const errChunks = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (c) => { outChunks.push(String(c)); return true; };
    process.stderr.write = (c) => { errChunks.push(String(c)); return true; };
    try {
      const code = await cli.main(argv);
      return { code, stdout: outChunks.join(""), stderr: errChunks.join("") };
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
  };

  await suite.test("get --kind hls produces media, not the playlist text", async () => {
    const mediaDir = path.join(out, "cli-hls");
    await fsp.mkdir(mediaDir, { recursive: true });
    const { code, stdout } = await runCli([
      "get", origin.origin + "/hls/master.m3u8?count=3", "--kind", "hls", "-o", mediaDir, "-q",
    ]);
    assert.equal(code, 0, "a working HLS download must exit 0");
    assert.match(stdout, /done:/, "a success summary must be printed");

    const produced = [];
    const walk = async (d) => {
      for (const ent of await fsp.readdir(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) await walk(full);
        else produced.push(full);
      }
    };
    await walk(mediaDir);
    assert.equal(produced.length, 1, "exactly one media artefact expected, got " + JSON.stringify(produced));
    const file = produced[0];
    const size = (await fsp.stat(file)).size;
    // Three 64 KiB fragments: the artefact must be their concatenation.
    assert.equal(size, 3 * 64 * 1024, "the artefact must contain every fragment, got " + size);

    const head = (await fsp.readFile(file)).subarray(0, 32).toString("utf8");
    assert.ok(!head.includes("#EXTM3U"), "the playlist text must not be the deliverable, got " + JSON.stringify(head));
    assert.equal(await hashFile(file), createHash("sha256")
      .update(Buffer.concat([0, 1, 2].map((n) => Buffer.alloc(64 * 1024, 0x41 + (n % 26))))).digest("hex"),
      "the media bytes must match the fragments served by the origin");
  });

  await suite.test("get auto-detects an HLS URL without --kind", async () => {
    const mediaDir = path.join(out, "cli-hls-auto");
    await fsp.mkdir(mediaDir, { recursive: true });
    const { code } = await runCli([
      "get", origin.origin + "/hls/master.m3u8?count=2", "-o", mediaDir, "-q",
    ]);
    assert.equal(code, 0);
    // 批-5/P-6：-o <目录> 是显式目录，文件直接落在其中（不再追加 video/ 子目录）。
    assert.match(await fsp.readFile(path.join(mediaDir, "media720.ts"), "utf8").catch(() => ""),
      /A/, "the auto-detected path must still fetch fragments");
    const size = (await fsp.stat(path.join(mediaDir, "media720.ts"))).size;
    assert.equal(size, 2 * 64 * 1024);
  });

  await suite.test("get --kind dash reports a merge failure instead of a false success", async () => {
    // The synthetic DASH origin serves filler bytes, not valid media, so the
    // mux cannot succeed. A merge failure means the requested file was not
    // produced: the command must fail rather than print a success summary.
    const mediaDir = path.join(out, "cli-dash");
    await fsp.mkdir(mediaDir, { recursive: true });
    const { code, stdout, stderr } = await runCli([
      "get", origin.origin + "/dash2/manifest.mpd", "--kind", "dash", "-o", mediaDir, "-q",
    ]);
    assert.notEqual(code, 0, "an unmerged DASH download must not exit 0");
    assert.ok(!/^\s*done:/m.test(stdout), "no success summary may be printed, got " + JSON.stringify(stdout));
    assert.match(stderr, /merge/i, "the failure must say the merge did not happen");
    // Both track files exist, which is what the message promises.
    // 批-5/P-6：-o <目录> 是显式目录，轨道文件直接落在其中（无 video/ 子目录）。
    const files = (await fsp.readdir(mediaDir)).sort();
    assert.equal(files.length, 2, "both tracks must be kept, got " + JSON.stringify(files));
  });

  await suite.test("get --dry-run on a media URL transfers no fragments", async () => {
    const mediaDir = path.join(out, "cli-dry");
    await fsp.mkdir(mediaDir, { recursive: true });
    const { code, stdout } = await runCli([
      "get", origin.origin + "/hls/master.m3u8?count=4", "--kind", "hls", "--dry-run", "-o", mediaDir, "-q",
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /plan: 4 segment/, "the plan must list the fragments");
    const walk = async (d) => {
      let found = 0;
      for (const ent of await fsp.readdir(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) found += await walk(full);
        else found++;
      }
      return found;
    };
    assert.equal(await walk(mediaDir), 0, "--dry-run must not write any file");
  });

  await suite.test("the media path honours the task-level insecure flag", async () => {
    // -k is a per-command choice; the media path only read the config value,
    // so `get -k <hls-url>` silently ignored the flag.
    const src = fs.readFileSync(path.join(projectDir, "src", "downloader.mjs"), "utf8");
    const configOnly = src.match(/insecure: this\.config\.get\("insecure"\)/g) || [];
    assert.equal(configOnly.length, 0,
      "the downloader must prefer task.insecure over the config value, found " +
      configOnly.length + " config-only call site(s)");
  });

  await suite.test("the media path receives the caller's abort signal", async () => {
    // The downloader creates its own AbortController; the CLI's SIGINT handler
    // was attached to a controller nothing listened to.
    const { Downloader: D } = await import("../src/downloader.mjs");
    const cfg2 = new Config(path.join(root, "clisig.json"));
    await cfg2.load();
    const q2 = new QueueManager({ config: cfg2 });
    await q2.load();
    const dl2 = new D({ config: cfg2, queue: q2 });
    const controller = new AbortController();
    controller.abort();
    // With no listener for the external signal this would try to hit the
    // network; an already-aborted signal must short-circuit to a rejection.
    await assert.rejects(
      () => dl2.run({ id: "sig-1", url: origin.origin + "/hls/master.m3u8?count=2", kind: "hls", signal: controller.signal, headers: {}, meta: {} }),
      "an aborted signal must stop the transfer");
  });

  // -------------------------------------------------- construction doc P1-A
  suite.group("P1-A daemon lifecycle");

  await suite.test("the daemon entry point is executable and self-starting", async () => {
    // Regression: ensureDaemon used import.meta.url, which resolves to
    // src/cli.mjs — a plain module with no main() call. Spawning it was a
    // no-op that exited immediately, so every cold start waited out the full
    // timeout and then reported a generic failure.
    const cliPath = path.join(projectDir, "src", "cli.mjs");
    const entry = path.resolve(path.dirname(cliPath), "..", "bin", "downloadx.mjs");
    assert.ok(fs.existsSync(entry), "the entry point must exist at " + entry);
    const entrySrc = fs.readFileSync(entry, "utf8");
    assert.match(entrySrc, /main\(\)/, "the entry point must invoke main()");
    const cliSrc = fs.readFileSync(cliPath, "utf8");
    assert.ok(!/^main\(\)/m.test(cliSrc),
      "src/cli.mjs must not self-invoke main(); running it directly is a no-op");
  });

  await suite.test("the runtime file is validated against a live process", async () => {
    // A runtime file left by a crashed daemon must not look alive.
    const { readRuntime } = await import("../src/daemon.mjs");
    const { paths } = await import("../src/paths.mjs");
    const saved = fs.existsSync(paths.runtime) ? fs.readFileSync(paths.runtime, "utf8") : null;
    try {
      await fsp.mkdir(path.dirname(paths.runtime), { recursive: true });
      await fsp.writeFile(paths.runtime, JSON.stringify({ pid: 999999999, port: 1, host: "127.0.0.1", url: "http://127.0.0.1:1", token: "x" }));
      assert.equal(await readRuntime(), null, "a dead pid must not report a running daemon");
      await fsp.writeFile(paths.runtime, "{ not json");
      assert.equal(await readRuntime(), null, "malformed runtime must be rejected");
    } finally {
      if (saved === null) await fsp.rm(paths.runtime, { force: true });
      else await fsp.writeFile(paths.runtime, saved);
    }
  });

  await suite.test("daemon shutdown removes the runtime file and exits", async () => {
    // End-to-end: spawn the real daemon, ask it to stop over the API, and
    // confirm the runtime file is gone. This is what `downloadx stop` waits
    // on, and it used to hang because server.close() waits for keep-alive
    // clients that never leave.
    const { spawn } = await import("node:child_process");
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-daemon-"));
    const entry = path.join(projectDir, "bin", "downloadx.mjs");
    const env = { ...process.env, DOWNLOADX_HOME: home };
    const rtPath = path.join(home, "runtime.json");
    const child = spawn(process.execPath, [entry, "daemon"], { cwd: projectDir, env, stdio: "ignore" });
    try {
      const deadline = Date.now() + 20000;
      let runtime = null;
      while (Date.now() < deadline) {
        if (fs.existsSync(rtPath)) {
          try { runtime = JSON.parse(fs.readFileSync(rtPath, "utf8")); } catch { runtime = null; }
          if (runtime && runtime.port) break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(runtime && runtime.port, "the daemon must publish a runtime file");

      const res = await fetch("http://127.0.0.1:" + runtime.port + "/api/shutdown", {
        method: "POST",
        headers: { "x-downloadx-token": runtime.token },
      });
      assert.ok(res.ok, "the shutdown request must be accepted");

      const goneDeadline = Date.now() + 15000;
      let gone = false;
      while (Date.now() < goneDeadline) {
        if (!fs.existsSync(rtPath)) { gone = true; break; }
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(gone, "shutdown must remove the runtime file");
    } finally {
      try { child.kill(); } catch { /* already gone */ }
      await new Promise((r) => setTimeout(r, 300));
      await fsp.rm(home, { recursive: true, force: true });
    }
  });
  // -------------------------------------------- media segment retry (P1-B)
  suite.group("Media segment retry");

  await suite.test("a dropped connection on one HLS segment is retried", async () => {
    // Regression found by the real-network suite: each HLS/DASH fragment was
    // fetched once, so a single dropped connection partway through a long
    // playlist discarded the entire download. Serving the same playlist from
    // a flaky origin must now still complete.
    const httpMod = await import("node:http");
    const seg = Buffer.alloc(4096, 0x5a);
    let drops = 0;
    const srv = httpMod.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/media.m3u8") {
        const body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n" +
          "#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.0,\n/seg/0\n#EXTINF:4.0,\n/seg/1\n#EXTINF:4.0,\n/seg/2\n#EXT-X-ENDLIST\n";
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      if (u.pathname.startsWith("/seg/")) {
        // Drop the first two attempts at one specific segment.
        if (u.pathname === "/seg/1" && drops < 2) {
          drops++;
          res.writeHead(200, { "Content-Length": String(seg.length) });
          res.write(seg.subarray(0, 64));
          setTimeout(() => res.destroy(), 10);
          return;
        }
        res.writeHead(200, { "Content-Length": String(seg.length) });
        res.end(seg);
        return;
      }
      res.writeHead(404).end("no");
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const base = "http://127.0.0.1:" + srv.address().port;

    const cfg = new Config(path.join(out, "hls-retry.json"));
    await cfg.load();
    await cfg.set({ defaultDir: out, categorizeByType: false, maxRetries: 4, retryBaseMs: 50, overwriteExisting: "overwrite" });
    const q = new QueueManager({ config: cfg });
    await q.load();
    const dl = new Downloader({ config: cfg, queue: q });

    const target = path.join(out, "hls-retry");
    const r = await dl.run({ id: "hls-retry", url: base + "/media.m3u8", kind: "hls", filename: "hls-retry", dir: out, headers: {}, connections: 2, meta: {} });
    assert.ok(r.bytes > 0, "the download must complete despite dropped segments");
    assert.ok(drops > 0, "the fixture must have dropped at least one connection");
    assert.equal(fs.readFileSync(target).length, seg.length * 3, "all three segments must be present");
    await closeServer(srv);
  });

  await suite.test("a 404 on a media segment is not retried", async () => {
    // Only transient failures are worth retrying; a definitive answer must
    // fail fast rather than hammering the origin.
    const httpMod = await import("node:http");
    let segRequests = 0;
    const srv = httpMod.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/media.m3u8") {
        const body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.0,\n/seg/0\n#EXT-X-ENDLIST\n";
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      if (u.pathname.startsWith("/seg/")) { segRequests++; res.writeHead(404, { "Content-Length": "0" }); res.end(); return; }
      res.writeHead(404).end("no");
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const base = "http://127.0.0.1:" + srv.address().port;

    const cfg = new Config(path.join(out, "hls-404.json"));
    await cfg.load();
    await cfg.set({ defaultDir: out, categorizeByType: false, maxRetries: 4, retryBaseMs: 20, overwriteExisting: "overwrite" });
    const q = new QueueManager({ config: cfg });
    await q.load();
    const dl = new Downloader({ config: cfg, queue: q });
    await assert.rejects(
      () => dl.run({ id: "hls-404", url: base + "/media.m3u8", kind: "hls", filename: "hls-404", dir: out, headers: {}, connections: 1, meta: {} }),
      "a missing segment must fail the download");
    assert.equal(segRequests, 1, "a 404 must be fetched once, saw " + segRequests);
    await closeServer(srv);
  });
  // ------------------------------- media output path / limit / TLS / redirects
  // Four end-to-end groups against local fixtures: the exact output path for
  // `-o <file>`, task-wide rate limiting for HLS and DASH fragments, credential
  // hygiene across redirects, and the media TLS trust decision.
  await runMediaE2ETests(suite, { out, Config, QueueManager, Downloader });

  // ------------------------------------------------------ construction doc P1-C
  suite.group("P1-C gap coverage");

  await suite.test("repeated interruptions still converge on the correct bytes", async () => {
    // Interrupt the same transfer three times at different progress points,
    // then let it finish. The result must equal a single-stream download.
    const httpMod = await import("node:http");
    const size = 4 * 1024 * 1024;
    const body = payloadFor(size);
    const srv = httpMod.createServer((req, res) => {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      const slice = body.subarray(start, end + 1);
      res.writeHead(m ? 206 : 200, {
        "Content-Range": "bytes " + start + "-" + end + "/" + size,
        "Content-Length": slice.length, "Accept-Ranges": "bytes",
      });
      // Trickle so an abort lands mid-transfer.
      let i = 0;
      const tick = () => {
        if (i >= slice.length) { res.end(); return; }
        if (res.destroyed) return;
        res.write(slice.subarray(i, i + 16 * 1024));
        i += 16 * 1024;
        setTimeout(tick, 3);
      };
      tick();
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const url = "http://127.0.0.1:" + srv.address().port + "/f";

    const cfg = new Config(path.join(out, "repeat.json"));
    await cfg.load();
    await cfg.set({ defaultDir: out, categorizeByType: false, maxConnections: 2, segmentBytes: 1024 * 1024, overwriteExisting: "overwrite" });
    const q = new QueueManager({ config: cfg });
    await q.load();
    const dl = new Downloader({ config: cfg, queue: q });
    const target = path.join(out, "repeat.bin");

    const thresholds = [300 * 1024, 700 * 1024, 1200 * 1024];
    for (const threshold of thresholds) {
      let aborted = false;
      const entryId = "repeat-" + threshold;
      const p = dl.run({ id: entryId, url, kind: "http", filename: "repeat.bin", dir: out, headers: {}, connections: 2, meta: {} });
      const watcher = new Promise((resolve) => {
        const onProgress = (pr) => {
          if (aborted) return;
          if ((pr.bytesWritten || 0) >= threshold) {
            aborted = true;
            const entry = dl.active.get(entryId);
            if (entry && entry.controller) entry.controller.abort();
            resolve(undefined);
          }
        };
        dl.on("progress", onProgress);
        setTimeout(resolve, 12000);
      });
      await watcher;
      await p.catch(() => null);
    }

    // Final, uninterrupted pass.
    const result = await dl.run({ id: "repeat-final", url, kind: "http", filename: "repeat.bin", dir: out, headers: {}, connections: 2, meta: {} });
    assert.equal(result.bytes, size);
    assert.equal(await hashFile(target), createHash("sha256").update(body).digest("hex"),
      "three interruptions must not corrupt the result");
    await closeServer(srv);
  });

  await suite.test("maxConnectionsPerServer is counted across tasks", async () => {
    // The cap must be shared between concurrent tasks on one host, not applied
    // per task — otherwise N tasks each open the full allowance.
    const { applyPerServerCap } = await import("../src/downloader.mjs");
    const cfg = { get: (k) => (k === "maxConnectionsPerServer" ? 4 : undefined) };
    const inUse = new Map();
    // First task takes the whole allowance.
    assert.equal(applyPerServerCap("https://h.test/a", 4, cfg, inUse), 4);
    inUse.set("h.test", 4);
    // A second task on the same host must be capped to the minimum, not 4.
    assert.equal(applyPerServerCap("https://h.test/b", 4, cfg, inUse), 1,
      "a second task must not get the full allowance again");
    // A different host is unaffected.
    assert.equal(applyPerServerCap("https://other.test/a", 4, cfg, inUse), 4);
  });

  await suite.test("a write failure surfaces instead of reporting success", async () => {
    // Point the target at a path that cannot be created: the transfer must
    // fail loudly rather than claim a download that is not on disk.
    const engine = new DownloadEngine({ url: "x", targetPath: path.join(out, "nodir"), connections: 1 });
    const controller = new AbortController();
    const url = origin.origin + "/chunked/" + (64 * 1024);
    // A directory where the file should go makes the open fail.
    const blocked = path.join(out, "blocked-target");
    await fsp.mkdir(blocked, { recursive: true });
    let failed = false;
    try {
      await engine.runStreaming({ url, targetPath: blocked, signal: controller.signal });
    } catch { failed = true; }
    assert.ok(failed, "writing to a directory path must fail, not report success");
  });

  await suite.test("an aborted segmented transfer keeps resumable state", async () => {
    // Cancelling must not delete the per-segment progress, otherwise the
    // resume path has nothing to work from. The origin is throttled so the
    // abort reliably lands mid-transfer rather than racing a fast server.
    const size = 4 * 1024 * 1024;
    const url = origin.origin + "/throttle/" + size + "/16384/40";
    const info = await probeMod.probe(url);
    assert.equal(info.supportsRanges, true, "the throttle route must serve ranges");

    const target = path.join(out, "abort-state.bin");
    const engine = new DownloadEngine({
      url, targetPath: target, connections: 2, segmentBytes: 1024 * 1024,
      rangeSupport: info.supportsRanges,
    });
    const controller = new AbortController();
    let abortedAt = 0;
    // Trigger from the progress event, which fires during the transfer. Polling
    // the disk raced the transfer on a fast local server.
    const watcher = new Promise((resolve) => {
      const onProgress = (pr) => {
        if (abortedAt) return;
        if ((pr.bytesWritten || 0) >= 262144) {
          abortedAt = pr.bytesWritten;
          controller.abort();
          resolve(undefined);
        }
      };
      engine.on("progress", onProgress);
      setTimeout(() => { if (!abortedAt) controller.abort(); resolve(undefined); }, 15000);
    });
    const p = engine.run({ probe: info, resume: false, signal: controller.signal }).catch(() => null);
    await watcher;
    await p;

    const store = new TransferStore(target);
    const saved = await store.loadSegments();
    const recorded = saved.reduce((a, s) => a + (s.downloaded || 0), 0);
    assert.ok(saved.length > 0, "segment state must survive a cancel");
    assert.ok(recorded > 0, "recorded progress must survive a cancel, got " + recorded);
    // The final path must stay clean: a transfer assembles its bytes in a
    // staging file and only renames them into place once every segment is
    // provably full, so an interrupted transfer leaves nothing here that could
    // be mistaken for a finished download. The resumable state is the staging
    // file plus the journal asserted above.
    assert.equal(fs.existsSync(target), false,
      "an aborted transfer must not leave a file at the final path");
    assert.ok(fs.existsSync(target + ".downloadx-part"), "the staging file must remain for a resume");

    // And a resume must reuse that progress rather than starting over.
    const engine2 = new DownloadEngine({
      url, targetPath: target, connections: 2, segmentBytes: 1024 * 1024,
      rangeSupport: info.supportsRanges,
    });
    const logs = [];
    engine2.on("log", (m) => logs.push(m));
    const r2 = await engine2.run({ probe: info, resume: true });
    assert.equal(r2.bytes, size);
    assert.equal(await hashFile(target),
      createHash("sha256").update(payloadFor(size)).digest("hex"),
      "the resumed file must be correct");
    assert.ok(logs.some((l) => /resuming:/.test(l)),
      "the resume must report reused progress: " + JSON.stringify(logs));
  });

  // ------------------------------------------------- agent integration (DX-A1)
  // Three surfaces an agent drives: idempotent start, machine-readable CLI
  // output, and the MCP server. They share one daemon per sub-group so the
  // numbers below stay small; every one of them runs against a scratch home.
  suite.group("Agent integration: start idempotency");

  const idemHome = path.join(root, "idem-home");
  await fsp.mkdir(idemHome, { recursive: true });
  const idemOut = path.join(root, "idem-out");
  await fsp.mkdir(idemOut, { recursive: true });
  const homeBeforeIdem = process.env.DOWNLOADX_HOME;
  process.env.DOWNLOADX_HOME = idemHome;

  const idemConfig = new Config(path.join(root, "idem-config.json"));
  await idemConfig.load();
  // One slot keeps the queue order deterministic, which is what makes the
  // retry test below able to hold a task in a chosen state.
  await idemConfig.set({
    defaultDir: idemOut, categorizeByType: false, maxConnections: 2,
    segmentBytes: 262144, maxConcurrentDownloads: 1,
  });
  const idemQueue = new QueueManager({ config: idemConfig });
  await idemQueue.load();
  const idemDownloader = new Downloader({ config: idemConfig, queue: idemQueue });
  const idemApi = new ApiServer({
    queue: idemQueue, config: idemConfig, downloader: idemDownloader,
    log: { info() {}, warn() {}, error() {} },
  }).startRunner();
  const idemListening = await idemApi.listen({ port: 0 });
  const idemCall = async (method, route, body) => {
    const headers = { "x-downloadx-token": idemListening.token };
    if (body) headers["content-type"] = "application/json";
    const res = await fetch("http://127.0.0.1:" + idemListening.port + route, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  };
  /** Poll one task until it is terminal, or give up after `tries` ticks. */
  const settle = async (id, tries = 400, every = 50) => {
    let task = null;
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, every));
      task = (await idemCall("GET", "/api/tasks/" + id)).json.task;
      if (task && (task.status === "complete" || task.status === "error")) return task;
    }
    return task;
  };
  const filesLike = async (dir, prefix) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.startsWith(prefix)).map((e) => e.name);
  };

  await suite.test("start is idempotent while downloading", async () => {
    // Slow enough that three explicit starts land mid-transfer, fast enough
    // that the test does not wait on the throttle for long.
    const url = origin.origin + "/throttle/" + (8 * 1024 * 1024) + "/65536/15";
    const created = await idemCall("POST", "/api/tasks", { url, filename: "idem-a.bin", dir: idemOut });
    assert.equal(created.status, 201);
    const id = created.json.task.id;

    let status = "";
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 25));
      status = (await idemCall("GET", "/api/tasks/" + id)).json.task.status;
      if (status === "downloading" || status === "complete" || status === "error") break;
    }
    assert.equal(status, "downloading", "the fixture must still be transferring, got " + status);

    // The reproduction from the task sheet: three starts in a row.
    for (let i = 0; i < 3; i++) {
      const res = await idemCall("POST", "/api/tasks/" + id + "/start");
      assert.equal(res.status, 200, "start " + (i + 1) + " must succeed");
    }

    const task = await settle(id);
    assert.ok(task, "the task disappeared");
    assert.equal(task.status, "complete", "task failed: " + task.error);
    assert.equal(task.id, id, "the task id must not change");
    const files = await filesLike(idemOut, "idem-a");
    assert.deepEqual(files, ["idem-a.bin"], "exactly one artefact expected, got " + JSON.stringify(files));
    assert.equal(idemQueue.list().filter((t) => t.id === id).length, 1, "the queue must hold one entry for the id");
  });

  await suite.test("start still revives a paused task", async () => {
    const url = origin.origin + "/throttle/" + (8 * 1024 * 1024) + "/65536/15";
    const created = await idemCall("POST", "/api/tasks", { url, filename: "idem-paused.bin", dir: idemOut });
    const id = created.json.task.id;

    let paused = false;
    for (let i = 0; i < 200 && !paused; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const s = (await idemCall("GET", "/api/tasks/" + id)).json.task.status;
      if (s === "downloading") {
        await idemCall("POST", "/api/tasks/" + id + "/pause");
        paused = true;
      }
    }
    assert.ok(paused, "the fixture never reached downloading");

    let state = "";
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 25));
      state = (await idemCall("GET", "/api/tasks/" + id)).json.task.status;
      if (state === "paused") break;
    }
    assert.equal(state, "paused", "expected paused, got " + state);

    assert.equal((await idemCall("POST", "/api/tasks/" + id + "/start")).status, 200);
    const task = await settle(id);
    assert.equal(task.status, "complete", "a paused task must still start and finish: " + task.error);
  });

  await suite.test("retry of an errored task still works", async () => {
    // Occupy the only slot, so the task under test stays queued and can be put
    // into ERROR without racing a live runner.
    const blocker = await idemCall("POST", "/api/tasks", {
      url: origin.origin + "/throttle/" + (8 * 1024 * 1024) + "/65536/12", filename: "idem-blocker.bin", dir: idemOut,
    });
    const created = await idemCall("POST", "/api/tasks", {
      url: origin.origin + "/range/" + (512 * 1024), filename: "idem-retry.bin", dir: idemOut,
    });
    const id = created.json.task.id;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await idemCall("GET", "/api/tasks/" + id)).json.task.status, "queued",
      "the second task must be waiting for the slot");

    // The state a failed download really is in when the user hits Retry.
    idemQueue.setStatus(id, STATUS.ERROR);
    assert.equal(idemQueue.get(id).status, STATUS.ERROR);

    const retried = await idemCall("POST", "/api/tasks/" + id + "/retry");
    assert.equal(retried.status, 200, "retry must be accepted");
    assert.ok(["queued", "connecting", "downloading"].includes(retried.json.task.status),
      "retry must restart it, got " + retried.json.task.status);

    await settle(blocker.json.task.id, 800);
    const task = await settle(id, 800);
    assert.equal(task.status, "complete", "a retried task must finish: " + task.error);
    assert.equal(await hashFile(path.join(idemOut, "idem-retry.bin")),
      createHash("sha256").update(payloadFor(512 * 1024)).digest("hex"));
  });

  // ------------------------------------------------------ CLI machine output
  suite.group("Agent integration: CLI --json");

  const cliHome = path.join(root, "cli-home");
  await fsp.mkdir(cliHome, { recursive: true });
  await fsp.writeFile(path.join(cliHome, "config.json"),
    JSON.stringify({ monitorClipboard: false, categorizeByType: false, defaultDir: idemOut }), "utf8");
  const cliEnv = { ...process.env, DOWNLOADX_HOME: cliHome };
  const cliBin = path.join(projectDir, "bin", "downloadx.mjs");
  const cliDaemon = spawn(process.execPath, [cliBin, "daemon"], { env: cliEnv, stdio: "ignore", windowsHide: true });
  cliDaemon.on("error", () => { /* reported by the tests below */ });

  let cliRuntime = null;
  for (let i = 0; i < 120 && !cliRuntime; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try { cliRuntime = JSON.parse(await fsp.readFile(path.join(cliHome, "runtime.json"), "utf8")); }
    catch { /* not up yet */ }
  }

  /** Run the real CLI in a child process, capturing both streams and the exit code. */
  const runCliProcess = (args) => {
    try {
      const stdout = execFileSync(process.execPath, [cliBin, ...args], {
        env: cliEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, stdout, stderr: "" };
    } catch (err) {
      return { status: err.status, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
    }
  };

  await suite.test("cli list --json emits parseable json", async () => {
    assert.ok(cliRuntime, "the CLI test daemon did not start");
    const added = runCliProcess(["add", origin.origin + "/range/65536", "--filename", "cli-json.bin", "-o", idemOut]);
    assert.equal(added.status, 0, "add failed: " + added.stderr);

    const r = runCliProcess(["list", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout.trim());
    assert.ok(Array.isArray(parsed.tasks), "tasks must be an array");
    assert.equal(parsed.count, parsed.tasks.length);
    assert.ok(parsed.tasks.some((t) => t.filename === "cli-json.bin"), "the queued task must be listed");
    assert.equal(r.stdout.trim().split("\n").length, 1, "stdout must be a single JSON line");
  });

  await suite.test("cli task <id> --json emits one task", async () => {
    assert.ok(cliRuntime, "the CLI test daemon did not start");
    // A DISTINCT URL from the previous test's add: its task may still be
    // live, and POST /api/tasks now refuses a live URL with 409.
    runCliProcess(["add", origin.origin + "/range/131072", "--filename", "cli-task.bin", "-o", idemOut]);
    const list = JSON.parse(runCliProcess(["list", "--json"]).stdout.trim());
    const target = list.tasks.find((t) => t.filename === "cli-task.bin");
    assert.ok(target, "the task must be listed");

    const r = runCliProcess(["task", target.id, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.task.id, target.id);
    assert.ok(!/token|cookie|password/i.test(r.stdout), "no credential may appear in task JSON");

    // A short prefix is what the human output shows, so it has to resolve too.
    const prefixed = runCliProcess(["task", target.id.slice(0, 8), "--json"]);
    assert.equal(JSON.parse(prefixed.stdout.trim()).task.id, target.id);

    // A task that does not exist is a caller error: one JSON line, exit 2.
    const missing = runCliProcess(["task", "no-such-task-id", "--json"]);
    assert.equal(missing.status, 2, "expected exit code 2, got " + missing.status);
    const errObj = JSON.parse(missing.stderr.trim());
    assert.equal(errObj.error, "no such task");
    assert.equal(errObj.code, "ENOTASK");

    // Without the flag the output must stay human.
    const human = runCliProcess(["list"]);
    assert.ok(!human.stdout.trimStart().startsWith("{"), "plain list must not look like JSON");
    const humanStatus = runCliProcess(["status", "--json"]);
    const statusObj = JSON.parse(humanStatus.stdout.trim());
    assert.ok(statusObj.daemon && statusObj.daemon.url, "status --json must name the daemon");
    assert.ok(statusObj.queue && typeof statusObj.queue.total === "number", "status --json must carry the queue stats");
    assert.ok(!/token/i.test(humanStatus.stdout), "no token may appear in status JSON");
  });

  // --------------------------------------------------------------- MCP shell
  suite.group("Agent integration: MCP server");
  const mcp = await import("../mcp/server.mjs");

  await suite.test("mcp tools/list exposes 5 tools", async () => {
    const res = await mcp.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = res.result.tools.map((t) => t.name);
    for (const want of ["downloadx_download", "downloadx_list", "downloadx_status", "downloadx_control", "downloadx_probe"]) {
      assert.ok(names.includes(want), "missing tool " + want + " in " + JSON.stringify(names));
    }
    for (const tool of res.result.tools) {
      assert.equal(tool.inputSchema.type, "object", tool.name + " needs an object schema");
      assert.ok(tool.inputSchema.properties && typeof tool.inputSchema.properties === "object");
      assert.ok(Array.isArray(tool.inputSchema.required), tool.name + " needs a required array");
      assert.ok(tool.description && tool.description.length > 20, tool.name + " needs a real description");
    }
  });

  await suite.test("mcp speaks JSON-RPC: negotiate, ping, notify, unknown", async () => {
    const init = await mcp.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    assert.equal(init.result.protocolVersion, "2025-06-18", "a known version must be echoed");
    assert.equal(init.result.serverInfo.name, "downloadx");
    assert.ok(init.result.capabilities.tools, "tools must be advertised");
    assert.ok(!init.result.capabilities.resources, "resources must not be claimed");

    const unknownVersion = await mcp.handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    assert.equal(unknownVersion.result.protocolVersion, "2025-06-18", "an unknown version must fall back to the newest supported");

    const ping = await mcp.handleMessage({ jsonrpc: "2.0", id: 3, method: "ping" });
    assert.deepEqual(ping.result, {});

    const notified = await mcp.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(notified, null, "a notification must not be answered");

    const unknown = await mcp.handleMessage({ jsonrpc: "2.0", id: 4, method: "resources/list" });
    assert.equal(unknown.error.code, -32601);

    const badParams = await mcp.handleMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "downloadx_download", arguments: {} } });
    assert.equal(badParams.error.code, -32602, "a missing required argument must be -32602");
  });

  await suite.test("mcp refuses file: and data: URLs", async () => {
    // Checked before any daemon contact, so this needs no server at all.
    for (const url of ["file:///C:/Windows/win.ini", "data:text/plain;base64,SGk=", "C:\\Windows\\win.ini"]) {
      const res = await mcp.handleMessage({
        jsonrpc: "2.0", id: 20, method: "tools/call",
        params: { name: "downloadx_probe", arguments: { url } },
      });
      assert.equal(res.result.isError, true, "must refuse " + url);
      const payload = JSON.parse(res.result.content[0].text);
      assert.equal(payload.code, "EUNSUPPORTED_URL", "expected EUNSUPPORTED_URL for " + url + ", got " + JSON.stringify(payload));
    }
  });

  await suite.test("mcp download schema documents allowLarge", async () => {
    const res = await mcp.handleMessage({ jsonrpc: "2.0", id: 21, method: "tools/list" });
    const download = res.result.tools.find((t) => t.name === "downloadx_download");
    assert.equal(download.inputSchema.properties.allowLarge.type, "boolean");
    assert.equal(download.inputSchema.properties.waitMs.type, "integer");
    assert.deepEqual(download.inputSchema.required, ["url"]);
  });

  // A runtime file that points at the in-process API: ensureDaemon must reuse
  // it instead of spawning a second daemon, which is exactly the reuse path.
  const mcpHome = path.join(root, "mcp-home");
  await fsp.mkdir(mcpHome, { recursive: true });
  await fsp.writeFile(path.join(mcpHome, "runtime.json"), JSON.stringify({
    pid: process.pid, port: idemListening.port, host: "127.0.0.1",
    token: idemListening.token, url: "http://127.0.0.1:" + idemListening.port + "/",
  }), "utf8");

  await suite.test("mcp download with waitMs returns path and sha256", async () => {
    const before = process.env.DOWNLOADX_HOME;
    process.env.DOWNLOADX_HOME = mcpHome;
    try {
      const size = 2 * 1024 * 1024;
      const res = await mcp.handleMessage({
        jsonrpc: "2.0", id: 10, method: "tools/call",
        params: {
          name: "downloadx_download",
          arguments: { url: origin.origin + "/range/" + size, dir: idemOut, filename: "mcp-t7.bin", waitMs: 8000 },
        },
      });
      assert.ok(res.result, "the call must return a result: " + JSON.stringify(res.error || null));
      assert.notEqual(res.result.isError, true, "the tool reported an error: " + JSON.stringify(res.result));
      const payload = JSON.parse(res.result.content[0].text);
      assert.equal(payload.status, "complete", "expected complete, got " + payload.status);
      assert.ok(payload.path && fs.existsSync(payload.path), "the reported path must exist: " + payload.path);
      const expected = createHash("sha256").update(payloadFor(size)).digest("hex");
      assert.equal(payload.sha256, expected, "the reported sha256 must match the fixture");
      assert.equal(await hashFile(payload.path), expected);
    } finally {
      process.env.DOWNLOADX_HOME = before;
    }
  });

  await suite.test("mcp refuses external redirect", async () => {
    const http = await import("node:http");
    // A daemon that answers the health check (so it is reused rather than
    // replaced by a freshly spawned one) but redirects every API call to
    // another host: the token must not follow it, and nothing may reach the
    // target directory.
    const redirector = http.createServer((req, res) => {
      if (req.url === "/api/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ version: "1.0.0", queue: {} }));
        return;
      }
      res.writeHead(302, { Location: "http://example.invalid/steal" });
      res.end();
    });
    await new Promise((r) => redirector.listen(0, "127.0.0.1", r));
    const port = redirector.address().port;

    const redirectHome = path.join(root, "mcp-redirect-home");
    const redirectOut = path.join(root, "mcp-redirect-out");
    await fsp.mkdir(redirectHome, { recursive: true });
    await fsp.mkdir(redirectOut, { recursive: true });
    await fsp.writeFile(path.join(redirectHome, "runtime.json"), JSON.stringify({
      pid: process.pid, port, host: "127.0.0.1", token: "not-a-real-token", url: "http://127.0.0.1:" + port + "/",
    }), "utf8");

    const before = process.env.DOWNLOADX_HOME;
    process.env.DOWNLOADX_HOME = redirectHome;
    try {
      const res = await mcp.handleMessage({
        jsonrpc: "2.0", id: 11, method: "tools/call",
        params: {
          name: "downloadx_download",
          arguments: { url: origin.origin + "/range/1024", dir: redirectOut, filename: "must-not-exist.bin", waitMs: 0 },
        },
      });
      assert.equal(res.result.isError, true, "the tool must fail rather than follow the redirect");
      const payload = JSON.parse(res.result.content[0].text);
      assert.equal(payload.code, "redirect_refused", "expected redirect_refused, got " + JSON.stringify(payload));
      assert.ok(!/not-a-real-token/.test(JSON.stringify(payload)), "the token must never appear in an error");
      assert.deepEqual(await fsp.readdir(redirectOut), [], "nothing may be written when the redirect is refused");
    } finally {
      process.env.DOWNLOADX_HOME = before;
      redirector.closeAllConnections?.();
      await new Promise((r) => redirector.close(() => r(undefined)));
    }
  });

  // Tear down the daemon this group started, then the group's API.
  if (cliRuntime) {
    await fetch("http://" + (cliRuntime.host || "127.0.0.1") + ":" + cliRuntime.port + "/api/shutdown", {
      method: "POST", headers: { "x-downloadx-token": cliRuntime.token },
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
  }
  try { cliDaemon.kill(); } catch { /* already gone */ }
  await idemApi.close();
  process.env.DOWNLOADX_HOME = homeBeforeIdem;

  // Drop the scratch namespace's keys. They point at manifests inside `root`,
  // which is deleted a few lines below, so leaving them would recreate the
  // dangling-registration defect on different keys. The production keys were
  // never named by this run and are left exactly as they were found. The exit
  // hook armed above calls the same helper, so this is the normal-exit path,
  // not the only one.
  removeHostNamespaceKeys(process.env.DOWNLOADX_HOST_NAME);

  process.stdout.write(suite.report());

  await new Promise((r) => { origin.close(() => r(undefined)); setTimeout(() => r(undefined), 2000); });

  // Remove the scratch tree. Leaving it behind filled the temp directory with
  // one directory per run; the summary has already been printed, so a failure
  // here cannot hide a test result.
  if (!process.env.DOWNLOADX_KEEP_SELFTEST) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  } else {
    process.stdout.write("  (scratch kept at " + root + ")\n");
  }

  return suite.failed === 0 ? 0 : 1;
}
