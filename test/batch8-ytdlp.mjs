// Batch-8 regression: yt-dlp integration (resolver mode + full delegation).
//
// Covers the batch-8 acceptance:
//   (a) config: the two new keys sanitize like their aria2c/remoteAccess
//       counterparts (trimmed string / explicit-true-only switch, defaults
//       "" and false);
//   (a2) status: /api/status serves capabilities.ytdlp {found,version,path}
//       — the settings badge's data source (包2), version probed once through
//       the fake's --version;
//   (b) findYtDlp search order: config.ytdlpPath → PATH → app root
//       (DOWNLOADX_APPROOT seam; a broken configured path keeps searching);
//   (c) resolveMedia: -J JSON parsed (title/extractor/duration/formats),
//       exit failures, bad JSON, the 60s-budget timeout mechanism, playlist
//       entries; pickFormat maps "bestvideo*+bestaudio/best" onto ONE direct
//       link (single-file result → best progressive → best video stream);
//       topFormats sorts by height, keeps 5; --newline progress lines parse
//       with unknown totals honest;
//   (d) smart fallback end to end: a URL that probes as text/html resolves
//       to a direct link and the EXISTING http engine downloads it, with
//       yt-dlp's http_headers merged in (the origin sees the merged UA) and
//       meta.ytdlp (picked + top-5 formats) on the task record;
//   (e) resolve failure → human-readable error: a 404 keeps its original
//       error and gains the resolve reason; with yt-dlp missing, the install
//       guidance; an HTML page with a failed resolve still downloads the
//       page (historical behaviour) and records why;
//   (f) full delegation: when the resolved direct link fails with its
//       retries exhausted, yt-dlp takes the WHOLE job (--newline progress
//       marked 约, artefact landed under the rename policy, sha256 recorded,
//       both failure reasons in the meta); cancel kills the WHOLE process
//       tree and discards the staging family;
//   (g) kind:"ytdlp" as a first-class task kind runs the same delegate;
//   (h) magnet:/ftp never reach the fallback (a magnet with no aria2c fails
//       with the P-3 message and no yt-dlp mention);
//   (i) ytdlpAutoDownload: default-off downloads nothing; true downloads
//       once into the app root through the real task path; one failed
//       attempt is remembered for the process lifetime.
//
// No real yt-dlp exists on this machine and none is needed: the fixture
// test/fixtures/fake-ytdlp.mjs imitates its console surface. The "release
// server" for the auto-download arms is this file's own loopback origin
// (DOWNLOADX_YTDLP_RELEASE_BASE seam) — no public network. Everything runs
// in an isolated DOWNLOADX_HOME (temp dir): no user Downloads, no
// D:/IAM/downloadx-data, and the process exits clean.
//
// Usage: node test/batch8-ytdlp.mjs

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import http from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FAKE_YTDLP = path.join(HERE, "fixtures", "fake-ytdlp.mjs");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** The deterministic delegate body the fake lands (see fake-ytdlp.mjs). */
function delegateBody() {
  const chunk = Buffer.from("downloadx fake yt-dlp payload" + String.fromCharCode(10), "utf8");
  const parts = [];
  for (let i = 0; i < 4096; i++) parts.push(chunk);
  return Buffer.concat(parts);
}

/** The exact /direct/<n> body this file's origin serves. */
const directBody = (size) => Buffer.alloc(size, 0x5a);

// --- mini origin ------------------------------------------------------------
//
//   /page                        200 text/html — a "video page"
//   /direct/<size>               200/206 application/octet-stream (ranged),
//                                deterministic 0x5a body; last headers logged
//   /broken                      500 always (the failing "direct link")
//   /gone                        404 always
//   /ytdlp-releases/<name>       a fake "official release" binary (16 KiB)
//   anything else                404 (the auto-download failure arm's server)
function startOrigin() {
  const headerLog = new Map();   // "GET /direct/65536" -> last request headers
  const hits = new Map();        // pathname -> request count
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    hits.set(p, (hits.get(p) || 0) + 1);
    if (p === "/page") {
      const body = "<!doctype html><html><body>fake video page</body></html>";
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    const direct = /^\/direct\/(\d+)$/.exec(p);
    if (direct) {
      headerLog.set("GET " + p, { ...req.headers });
      const size = Number(direct[1]);
      const body = directBody(size);
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        const slice = body.subarray(start, end + 1);
        res.writeHead(206, {
          "Content-Type": "application/octet-stream",
          "Content-Range": "bytes " + start + "-" + end + "/" + size,
          "Content-Length": String(slice.length),
          "Accept-Ranges": "bytes",
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length),
        "Accept-Ranges": "bytes",
      });
      res.end(body);
      return;
    }
    if (p === "/broken") { res.writeHead(500, { "Content-Length": "0" }); res.end(); return; }
    if (p.startsWith("/ytdlp-releases/")) {
      const body = Buffer.alloc(16 * 1024, 0x77);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(body.length) });
      res.end(body);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  server.on("clientError", (err, socket) => { try { socket.destroy(); } catch { /* gone */ } });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        origin: "http://127.0.0.1:" + server.address().port,
        headerLog,
        hits,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function waitFor(fn, { timeoutMs = 30000, everyMs = 50, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** process.kill(pid, 0) throws when the pid is gone; false while it lives. */
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The harness has no doesNotMatch; same contract, negated. */
const notMatch = (value, re, message) => {
  if (re.test(String(value ?? ""))) {
    throw new Error((message ? message + ": " : "") + JSON.stringify(String(value)) + " must not match " + re);
  }
};

async function main() {
  const suite = new Suite("batch8-ytdlp");
  const NL = String.fromCharCode(10);
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b8-ytdlp-"));
  const out = path.join(home, "out");
  await fsp.mkdir(out, { recursive: true });
  process.env.DOWNLOADX_HOME = home;

  const origin = await startOrigin();
  const ORIGIN = origin.origin;

  // Env keys this run fiddles with; every arm restores them, PATH above all
  // (a broken PATH would break taskkill's own lookup in later arms).
  const ENV_KEYS = [
    "PATH", "DOWNLOADX_APPROOT", "DOWNLOADX_YTDLP_RELEASE_BASE",
    "DOWNLOADX_FAKE_YTDLP_MODE", "DOWNLOADX_FAKE_YTDLP_JSONFILE",
    "DOWNLOADX_FAKE_YTDLP_ARGSFILE", "DOWNLOADX_FAKE_YTDLP_PIDFILE",
  ];
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const restoreEnv = () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  /** Set the fake's mode/files for one arm; returns a cleanup fn. */
  const armEnv = ({ mode = "json", jsonFile = null, argsFile = null, pidFile = null } = {}) => {
    process.env.DOWNLOADX_FAKE_YTDLP_MODE = mode;
    if (jsonFile) process.env.DOWNLOADX_FAKE_YTDLP_JSONFILE = jsonFile;
    else delete process.env.DOWNLOADX_FAKE_YTDLP_JSONFILE;
    if (argsFile) process.env.DOWNLOADX_FAKE_YTDLP_ARGSFILE = argsFile;
    else delete process.env.DOWNLOADX_FAKE_YTDLP_ARGSFILE;
    if (pidFile) process.env.DOWNLOADX_FAKE_YTDLP_PIDFILE = pidFile;
    else delete process.env.DOWNLOADX_FAKE_YTDLP_PIDFILE;
    return () => {
      delete process.env.DOWNLOADX_FAKE_YTDLP_MODE;
      delete process.env.DOWNLOADX_FAKE_YTDLP_JSONFILE;
      delete process.env.DOWNLOADX_FAKE_YTDLP_ARGSFILE;
      delete process.env.DOWNLOADX_FAKE_YTDLP_PIDFILE;
    };
  };

  // The pid files of every hang-mode fake this run spawned, so a failing
  // assertion cannot leave hung node processes behind.
  const livePidFiles = new Set();
  const killPidFile = async (file) => {
    try {
      const pids = JSON.parse(await fsp.readFile(file, "utf8"));
      for (const pid of [pids.pid, pids.childPid]) {
        if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      }
    } catch { /* no file */ }
    livePidFiles.delete(file);
  };

  // Fixture -J JSONs: the format URLs point at the live origin, whose port is
  // dynamic. jsonBroken's top-level url is the /broken route, so the resolved
  // direct link fails and the full-delegation arm has a reason to fire.
  const mkJson = (topUrl, title) => ({
    id: "fake1",
    title,
    extractor: "fake:page",
    duration: 61.2,
    url: topUrl,
    ext: "mp4",
    height: 720,
    vcodec: "avc1",
    acodec: "mp4a",
    protocol: "https",
    format_id: "f0",
    http_headers: { "User-Agent": "fake-ytdlp-ua/1.0", "Referer": ORIGIN + "/page" },
    formats: [
      { format_id: "f0", url: topUrl, ext: "mp4", height: 720, vcodec: "avc1", acodec: "mp4a", protocol: "https", filesize: 65536 },
      { format_id: "f1080", url: ORIGIN + "/direct/65536?h=1080", ext: "webm", height: 1080, vcodec: "vp9", acodec: "none", protocol: "https", filesize: 65536 },
      { format_id: "f720a", url: ORIGIN + "/direct/1024?h=720a", ext: "m4a", height: null, vcodec: "none", acodec: "mp4a", protocol: "https", filesize: 1024 },
      { format_id: "f480", url: ORIGIN + "/direct/2048?h=480", ext: "mp4", height: 480, vcodec: "avc1", acodec: "none", protocol: "https", filesize: 2048 },
      { format_id: "f360", url: ORIGIN + "/direct/4096?h=360", ext: "mp4", height: 360, vcodec: "avc1", acodec: "mp4a", protocol: "https", filesize: 4096 },
      { format_id: "f240", url: ORIGIN + "/direct/8192?h=240", ext: "3gp", height: 240, vcodec: "mp4v", acodec: "samr", protocol: "https", filesize: 8192 },
    ],
  });
  // Distinct titles per fixture: the delegate arms share this file and each
  // landing must not collide with another arm's artefact (the rename policy
  // would otherwise pick "(2)" spellings mid-assertion).
  const jsonOkPath = path.join(home, "fake-json-ok.json");
  const jsonBrokenPath = path.join(home, "fake-json-broken.json");
  const jsonPlaylistPath = path.join(home, "fake-json-playlist.json");
  await fsp.writeFile(jsonOkPath, JSON.stringify(mkJson(ORIGIN + "/direct/65536", "Fake Video 测试")), "utf8");
  await fsp.writeFile(jsonBrokenPath, JSON.stringify(mkJson(ORIGIN + "/broken", "Broken Direct 影片")), "utf8");
  await fsp.writeFile(jsonPlaylistPath, JSON.stringify({
    _type: "playlist", title: "A playlist wrapper",
    entries: [mkJson(ORIGIN + "/direct/65536", "Fake Video 测试")],
  }), "utf8");

  const { Config, DEFAULT_CONFIG } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { Downloader, detectKind } = await import("../src/downloader.mjs");
  const { ApiServer } = await import("../src/api.mjs");
  const { findYtDlp, resetYtDlpCache, ensureYtDlp, resolveMedia, pickFormat, topFormats, parseYtdlpProgress, ytDlpAssetName } = await import("../src/ytdlp.mjs");

  // 第6项:产物名期望由导出的 ytDlpAssetName 派生,不按平台写死
  // "yt-dlp.exe"/"yt-dlp_linux"。PATH 探测用的是环境二进制名(win32 上与
  // 产物名相同;POSIX 上 findYtDlp 找 "yt-dlp",与 src/ytdlp.mjs 里那个
  // 非 win32 的额外打包候选一致),所以这里也只保留这一个平台字面量。
  const ASSET = ytDlpAssetName();
  const AMBIENT = process.platform === "win32" ? ASSET : "yt-dlp";

  const config = new Config(path.join(home, "config.json"));
  await config.load();
  await config.set({
    defaultDir: out,
    categorizeByType: false,
    overwriteExisting: "rename",
    proxy: "",
    proxyMode: "none",
    maxConnections: 1,
    maxConcurrentDownloads: 1,
    maxRetries: 1,           // keep failure arms fast
    retryBaseMs: 30,
    segmentBytes: 65536,
    ytdlpPath: FAKE_YTDLP,
    ytdlpAutoDownload: false,
  });

  const queue = new QueueManager({ config });
  await queue.load();
  const downloader = new Downloader({ config, queue });
  const api = new ApiServer({
    queue, config, downloader,
    log: { info() {}, warn() {}, error() {}, tail: () => [] },
  }).startRunner();
  const listening = await api.listen({ port: 0 });

  const call = async (method, route, body) => {
    const headers = { "x-downloadx-token": listening.token };
    if (body) headers["content-type"] = "application/json";
    const res = await fetch("http://127.0.0.1:" + listening.port + route, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  };
  const taskById = async (id) => (await call("GET", "/api/tasks/" + id)).json.task ?? null;
  const taskRecord = (id) => queue.get(id);

  const addTask = async (body) => {
    const added = await call("POST", "/api/tasks", body);
    assert.equal(added.status, 201, "add must be accepted: " + JSON.stringify(added.json));
    return added.json.task.id;
  };
  const waitComplete = async (id) => waitFor(async () => {
    const t = await taskById(id);
    if (!t) return false;
    if (t.status === "error") throw new Error("task failed: " + t.error);
    return t.status === "complete" ? t : false;
  }, { timeoutMs: 60000, what: "the task to complete" });
  const waitError = async (id) => waitFor(async () => {
    const t = await taskById(id);
    return t && t.status === "error" ? t : false;
  }, { timeoutMs: 60000, what: "the task to fail" });

  const progressFrames = new Map();   // taskId -> [{...}]
  const resolvedTargets = new Map();  // taskId -> target
  downloader.on("progress", (p) => {
    if (!p || !p.taskId) return;
    if (!progressFrames.has(p.taskId)) progressFrames.set(p.taskId, []);
    progressFrames.get(p.taskId).push(p);
  });
  downloader.on("resolved", (p) => { if (p && p.taskId && p.target) resolvedTargets.set(p.taskId, p); });

  try {
    // ------------------------------------------------------------ config
    suite.group("config: ytdlpPath / ytdlpAutoDownload sanitize");

    await suite.test("defaults are empty and off; the keys round-trip like aria2cPath", async () => {
      assert.equal(DEFAULT_CONFIG.ytdlpPath, "");
      assert.equal(DEFAULT_CONFIG.ytdlpAutoDownload, false);
      const c = Config.sanitize({});
      assert.equal(c.ytdlpPath, "");
      assert.equal(c.ytdlpAutoDownload, false);
    });

    await suite.test("ytdlpPath trims strings and rejects junk; autoDownload is explicit-true-only", async () => {
      assert.equal(Config.sanitize({ ytdlpPath: "  C:\\tools\\yt-dlp.exe  " }).ytdlpPath, "C:\\tools\\yt-dlp.exe");
      assert.equal(Config.sanitize({ ytdlpPath: 42 }).ytdlpPath, "", "a number must not become a probe path");
      assert.equal(Config.sanitize({ ytdlpPath: { a: 1 } }).ytdlpPath, "");
      for (const [v, want] of [[true, true], ["true", true], [false, false], ["false", false], [1, false], ["yes", false], [undefined, false]]) {
        assert.equal(Config.sanitize({ ytdlpAutoDownload: v }).ytdlpAutoDownload, want,
          "ytdlpAutoDownload(" + JSON.stringify(v) + ")");
      }
    });

    // ------------------------------------------- settings badge data source
    suite.group("status: capabilities.ytdlp served for the settings badge");

    await suite.test("/api/status reports {found,version,path} for the configured binary", async () => {
      const st = await call("GET", "/api/status");
      assert.equal(st.status, 200);
      const cap = st.json && st.json.capabilities && st.json.capabilities.ytdlp;
      assert.ok(cap && typeof cap === "object", "capabilities.ytdlp must exist as an object");
      assert.equal(cap.found, true, "the configured fake is found");
      assert.equal(cap.path, FAKE_YTDLP);
      assert.equal(cap.version, "2026.10.26-fake",
        "the --version probe ran once through the fake (cached thereafter)");
    });

    // -------------------------------------------------------- detection
    suite.group("findYtDlp: config 路径 → PATH → 打包根(appRoot)");

    await suite.test("search order and fallbacks", async () => {
      const dirA = path.join(home, "cfgdir");
      const dirP = path.join(home, "pathdir");
      const dirR = path.join(home, "approot-r");
      const dirEmpty = path.join(home, "approot-empty");
      for (const d of [dirA, dirP, dirR, dirEmpty]) await fsp.mkdir(d, { recursive: true });
      const inA = path.join(dirA, AMBIENT);
      const inP = path.join(dirP, AMBIENT);
      const inR = path.join(dirR, ASSET);
      await fsp.writeFile(inA, "fake", "utf8");
      await fsp.writeFile(inP, "fake", "utf8");
      await fsp.writeFile(inR, "fake", "utf8");

      process.env.PATH = dirP;
      process.env.DOWNLOADX_APPROOT = dirR;
      try {
        // 1. an explicit (configured) path wins and is checked fresh.
        resetYtDlpCache();
        assert.equal(await findYtDlp(inA), inA, "configured path must win");
        // 2. a BROKEN configured path keeps the spec's search order going.
        resetYtDlpCache();
        assert.equal(await findYtDlp(path.join(home, "nope", AMBIENT)), inP,
          "a missing configured path must fall through to PATH");
        // 3. PATH beats the app root.
        resetYtDlpCache();
        assert.equal(await findYtDlp(""), inP, "PATH entry must beat the app root");
        // 4. app root when PATH has nothing.
        process.env.PATH = "";
        resetYtDlpCache();
        assert.equal(await findYtDlp(""), inR, "the packaged app-root binary must be found last");
        // 5. nothing anywhere.
        process.env.DOWNLOADX_APPROOT = dirEmpty;
        resetYtDlpCache();
        assert.equal(await findYtDlp(""), null, "an empty machine finds nothing");
      } finally {
        restoreEnv();
        resetYtDlpCache();
      }
    });

    // ------------------------------------------------------ resolve unit
    suite.group("resolveMedia / pickFormat / topFormats / progress lines");

    await suite.test("-J JSON parses into the normalized shape", async () => {
      const cleanup = armEnv({ mode: "json", jsonFile: jsonOkPath });
      try {
        const info = await resolveMedia(FAKE_YTDLP, ORIGIN + "/page", { timeoutMs: 15000 });
        assert.equal(info.title, "Fake Video 测试");
        assert.equal(info.extractor, "fake:page");
        assert.equal(info.duration, 61.2);
        assert.equal(info.formats.length, 6);
        assert.equal(info.httpHeaders["User-Agent"], "fake-ytdlp-ua/1.0");
        assert.ok(info.url && info.url.startsWith(ORIGIN), "the top-level single-file url");
      } finally { cleanup(); }
    });

    await suite.test("a playlist-shaped -J answer uses its first entry", async () => {
      const cleanup = armEnv({ mode: "json", jsonFile: jsonPlaylistPath });
      try {
        const info = await resolveMedia(FAKE_YTDLP, ORIGIN + "/page", { timeoutMs: 15000 });
        assert.equal(info.title, "Fake Video 测试", "the entry's title, not the playlist's");
        assert.equal(info.formats.length, 6);
      } finally { cleanup(); }
    });

    await suite.test("exit failure / bad JSON / timeout are specific errors", async () => {
      let cleanup = armEnv({ mode: "instant-exit" });
      try {
        await assert.rejects(
          () => resolveMedia(FAKE_YTDLP, ORIGIN + "/page", { timeoutMs: 15000 }),
          (err) => /退出码 3/.test(err.message) && /instant-exit/.test(err.message),
          "the exit code and stderr tail must name the failure");
      } finally { cleanup(); }
      cleanup = armEnv({ mode: "bad-json" });
      try {
        await assert.rejects(
          () => resolveMedia(FAKE_YTDLP, ORIGIN + "/page", { timeoutMs: 15000 }),
          (err) => /JSON/.test(err.message), "garbage stdout must be a JSON error");
      } finally { cleanup(); }
      cleanup = armEnv({ mode: "hang" });
      const pidFile = path.join(home, "hang-resolve-pids.json");
      process.env.DOWNLOADX_FAKE_YTDLP_PIDFILE = pidFile;
      livePidFiles.add(pidFile);
      try {
        const started = Date.now();
        await assert.rejects(
          () => resolveMedia(FAKE_YTDLP, ORIGIN + "/page", { timeoutMs: 900 }),
          (err) => /解析超时/.test(err.message), "the timeout must fire");
        assert.ok(Date.now() - started < 10000, "the timeout must be the caller's budget");
        await waitFor(async () => {
          try { return !pidAlive(JSON.parse(await fsp.readFile(pidFile, "utf8")).pid); }
          catch { return false; }
        },
          { timeoutMs: 15000, what: "the hung resolver to be tree-killed" });
      } finally { cleanup(); await killPidFile(pidFile); }
    });

    await suite.test("pickFormat maps bestvideo*+bestaudio/best onto ONE link", async () => {
      const info = await (async () => {
        const cleanup = armEnv({ mode: "json", jsonFile: jsonOkPath });
        try { return await resolveMedia(FAKE_YTDLP, ORIGIN + "/page", { timeoutMs: 15000 }); }
        finally { cleanup(); }
      })();
      // 1) yt-dlp's own single-file selection is the /best arm.
      const top = pickFormat(info);
      assert.equal(top.formatId, "f0");
      assert.equal(top.url, ORIGIN + "/direct/65536");
      assert.equal(top.note, null);
      // 2) no single-file result → the best PROGRESSIVE format (the same
      //    fallback yt-dlp uses when it cannot merge).
      const dashOnly = {
        url: null, ext: null, height: null, vcodec: null, acodec: null, protocol: null, formatId: null,
        formats: [
          { formatId: "v1080", url: ORIGIN + "/direct/100", ext: "webm", height: 1080, vcodec: "vp9", acodec: "none", protocol: "https", filesize: 100, abr: null },
          { formatId: "a", url: ORIGIN + "/direct/50", ext: "m4a", height: null, vcodec: "none", acodec: "mp4a", protocol: "https", filesize: 50, abr: 128 },
          { formatId: "p360", url: ORIGIN + "/direct/60", ext: "mp4", height: 360, vcodec: "avc1", acodec: "mp4a", protocol: "https", filesize: 60, abr: null },
        ],
      };
      const prog = pickFormat(dashOnly);
      assert.equal(prog.formatId, "p360", "the progressive format wins over a silent 1080p");
      assert.match(prog.note, /单文件直链/);
      // 3) DASH-only with no progressive → the best video stream, honestly noted.
      const noProg = { ...dashOnly, formats: dashOnly.formats.filter((f) => f.formatId !== "p360") };
      const video = pickFormat(noProg);
      assert.equal(video.formatId, "v1080");
      assert.match(video.note, /无音轨/);
      // manifest protocols and .m3u8 urls are never direct links
      const m3u8Only = { ...dashOnly, url: ORIGIN + "/x.m3u8", formats: [] };
      assert.throws(() => pickFormat(m3u8Only), "a playlist url is not a direct link");
    });

    await suite.test("topFormats sorts by height desc and keeps five", async () => {
      const cleanup = armEnv({ mode: "json", jsonFile: jsonOkPath });
      try {
        const info = await resolveMedia(FAKE_YTDLP, ORIGIN + "/page", { timeoutMs: 15000 });
        const top = topFormats(info, 5);
        assert.equal(top.length, 5, "six formats in, five out");
        assert.deepEqual(top.map((f) => f.formatId), ["f1080", "f0", "f480", "f360", "f240"],
          "height desc, the null-height audio format last out");
        assert.ok(top.every((f) => typeof f.url === "string"), "formats keep their fields");
      } finally { cleanup(); }
    });

    await suite.test("--newline progress lines parse; unknown totals stay honest", async () => {
      const p = parseYtdlpProgress("[download]  25.0% of ~ 120.00KiB at  96.00KiB/s ETA 00:01");
      assert.equal(p.percent, 25);
      assert.equal(p.bytesWritten, 30720);
      assert.equal(p.totalBytes, 122880);
      assert.equal(p.speed, 98304);
      const unknown = parseYtdlpProgress("[download] 2.53MiB at 1.05MiB/s ETA 00:05");
      assert.equal(unknown.percent, null, "no percent is invented without a total");
      assert.equal(unknown.totalBytes, null);
      assert.equal(unknown.bytesWritten, Math.round(2.53 * 1024 * 1024));
      assert.equal(parseYtdlpProgress("[download] Destination: /x/y.mp4"), null);
      assert.equal(parseYtdlpProgress("[Merger] Merging formats into \"x.mp4\""), null);
      assert.equal(parseYtdlpProgress("garbage"), null);
    });

    // ------------------------------------------- smart fallback: success
    suite.group("smart fallback: resolve 成功 → 直链下载(既有 http 引擎)");

    await suite.test("a text/html probe resolves and downloads the direct link", async () => {
      const argsFile = path.join(home, "args-resolve.json");
      const cleanup = armEnv({ mode: "json", jsonFile: jsonOkPath, argsFile });
      try {
        const id = await addTask({ url: ORIGIN + "/page" });
        const task = await waitComplete(id);
        const expected = path.join(out, "Fake Video 测试.mp4");
        assert.equal(task.kind, "http", "the transfer ran (and reports) as http");
        assert.equal(task.filename, "Fake Video 测试.mp4", "the resolved title names the file");
        assert.equal(resolvedTargets.get(id).target, expected);
        const landed = await fsp.readFile(expected);
        assert.equal(landed.equals(directBody(65536)), true, "the direct link's bytes landed");
        assert.equal(task.sha256, sha256(directBody(65536)));
        assert.equal(task.downloadedBytes, 65536);

        // yt-dlp's http_headers were merged into the direct request and WIN:
        // the origin saw the fixture's UA and Referer, not the defaults.
        const sent = origin.headerLog.get("GET /direct/65536");
        assert.ok(sent, "the direct request must have reached the origin");
        assert.equal(sent["user-agent"], "fake-ytdlp-ua/1.0");
        assert.equal(sent["referer"], ORIGIN + "/page");

        // The resolver's argv spoke the documented CLI.
        const argv = JSON.parse(await fsp.readFile(argsFile, "utf8"));
        assert.deepEqual(argv, ["-J", "--no-playlist", ORIGIN + "/page"]);

        // The resolver metadata (picked + top-5) landed on the task record.
        const meta = taskRecord(id).meta;
        assert.equal(meta.ytdlpResolved, true);
        assert.equal(meta.ytdlp.title, "Fake Video 测试");
        assert.equal(meta.ytdlp.extractor, "fake:page");
        assert.equal(meta.ytdlp.picked.formatId, "f0");
        assert.equal(meta.ytdlp.picked.note, null);
        assert.equal(meta.ytdlp.formats.length, 5);
        assert.equal(meta.ytdlp.formats[0].formatId, "f1080");

        // The engine's ordinary progress still flowed.
        const frames = progressFrames.get(id) || [];
        assert.ok(frames.length >= 1, "engine progress frames expected");
        assert.equal(fs.existsSync(expected + ".downloadx"), false, "success cleans its journal");
      } finally { cleanup(); }
    });

    // --------------------------------------------- smart fallback: errors
    suite.group("smart fallback: resolve 失败 → 人话错误;ytdlp 缺失 → 安装指引");

    await suite.test("404 + resolve failure: the original error keeps its meaning and gains the reason", async () => {
      const cleanup = armEnv({ mode: "instant-exit" });
      try {
        const id = await addTask({ url: ORIGIN + "/gone" });
        const task = await waitError(id);
        assert.match(task.error, /HTTP 404/, "the original failure stays");
        assert.match(task.error, /yt-dlp 解析失败/, "the resolve was attempted and failed");
        assert.match(task.error, /退出码 3/, "with the resolve's specific reason");
        assert.equal(fs.existsSync(path.join(out, "gone")), false, "nothing published");
      } finally { cleanup(); }
    });

    await suite.test("yt-dlp missing: the error carries the install guidance", async () => {
      const emptyRoot = path.join(home, "approot-missing");
      await fsp.mkdir(emptyRoot, { recursive: true });
      process.env.PATH = "";
      process.env.DOWNLOADX_APPROOT = emptyRoot;
      await config.set({ ytdlpPath: path.join(home, "nope", AMBIENT) });
      try {
        resetYtDlpCache();
        const id = await addTask({ url: ORIGIN + "/gone" });
        const task = await waitError(id);
        assert.match(task.error, /HTTP 404/, "the original failure stays");
        assert.match(task.error, /安装 yt-dlp/, "the way out is named");
        assert.match(task.error, /ytdlpAutoDownload/, "so is the opt-in switch");
        notMatch(task.error, /yt-dlp 解析失败/, "no resolve ran when nothing was found");
      } finally {
        await config.set({ ytdlpPath: FAKE_YTDLP });
        restoreEnv();
        resetYtDlpCache();
      }
    });

    await suite.test("HTML page + failed resolve: the page still downloads (historical behaviour), reason recorded", async () => {
      const cleanup = armEnv({ mode: "instant-exit" });
      try {
        const id = await addTask({ url: ORIGIN + "/page", meta: {} });
        const task = await waitComplete(id);
        assert.equal(task.filename, "page.html", "ensureExtension named the page");
        const landed = await fsp.readFile(path.join(out, "page.html"));
        assert.match(landed.toString("utf8"), /fake video page/);
        const meta = taskRecord(id).meta;
        assert.match(meta.ytdlpResolveError, /退出码 3/, "the resolve failure is on the record");
      } finally { cleanup(); }
    });

    // -------------------------------------------------- full delegation
    suite.group("全程委托兜底: 直链失败 → yt-dlp 全程;取消杀树");

    await suite.test("direct link fails → delegate downloads, progress marked 约, meta carries both reasons", async () => {
      const argsFile = path.join(home, "args-delegate.json");
      const cleanup = armEnv({ mode: "json", jsonFile: jsonBrokenPath, argsFile });
      try {
        const id = await addTask({ url: ORIGIN + "/page" });
        const task = await waitComplete(id);
        const expected = path.join(out, "Broken Direct 影片.mp4");
        assert.equal(task.filename, "Broken Direct 影片.mp4");
        const landed = await fsp.readFile(expected);
        assert.equal(landed.equals(delegateBody()), true, "the delegate's artefact landed");
        assert.equal(task.sha256, sha256(delegateBody()));

        // The delegate argv spoke the documented CLI.
        const argv = JSON.parse(await fsp.readFile(argsFile, "utf8"));
        assert.equal(argv.includes("--newline"), true);
        assert.equal(argv.includes("--no-playlist"), true);
        assert.equal(argv.includes(ORIGIN + "/page"), true, "the ORIGINAL page url is delegated");
        const oAt = argv.indexOf("-o");
        assert.ok(oAt >= 0 && argv[oAt + 1].includes("ytdlp-stage"), "-o targets the staging dir");
        assert.ok(argv[oAt + 1].endsWith("Broken Direct 影片.%(ext)s"), "the template carries the title");

        // Progress: approximate percentages while running, exact 100 at the end.
        const frames = progressFrames.get(id) || [];
        const pct = frames.filter((f) => typeof f.percent === "number");
        const running = pct.filter((f) => f.percent < 100);
        assert.ok(running.length >= 2, "several running frames expected, got " + running.length);
        for (const f of running) {
          assert.equal(f.approx, true, "delegate percent frames must be marked approximate");
          assert.match(f.percentNote, /^约 \d+%$/, "percent note must read 约 N%");
        }
        assert.ok(frames.some((f) => f.percent === 100), "a final exact 100% frame");

        // The task record: engine, both failure stories, formats.
        const meta = taskRecord(id).meta;
        assert.equal(meta.engine, "yt-dlp");
        assert.match(meta.directError, /HTTP 500/, "why the direct link gave up");
        assert.equal(meta.ytdlp, "fake-ytdlp.mjs");
        assert.equal(meta.title, "Broken Direct 影片");
        assert.equal(meta.formats.length, 5);
        assert.equal(fs.existsSync(expected + ".downloadx"), false, "success cleans its staging family");
      } finally { cleanup(); }
    });

    await suite.test("cancel during the delegate kills the whole tree and discards staging", async () => {
      const pidFile = path.join(home, "hang-delegate-pids.json");
      const cleanup = armEnv({ mode: "download-hang", jsonFile: jsonBrokenPath, pidFile });
      livePidFiles.add(pidFile);
      try {
        const id = await addTask({ url: ORIGIN + "/page" });
        // The delegate announces its target AFTER the direct link failed, so
        // a resolved target here already proves the fallback fired.
        const resolved = await waitFor(() => resolvedTargets.get(id),
          { what: "the delegate target to be resolved" });
        assert.equal(resolved.kind, "ytdlp", "the resolved event names the delegate engine");
        const pids = await waitFor(async () => {
          try { return JSON.parse(await fsp.readFile(pidFile, "utf8")); } catch { return false; }
        }, { what: "the fake to record its pids" });
        assert.ok(pidAlive(pids.pid), "the delegate must be alive before the cancel");
        assert.ok(pidAlive(pids.childPid), "the grandchild must be alive before the cancel");

        const r = await call("POST", "/api/tasks/" + id + "/cancel");
        assert.equal(r.status, 200, "expected 200, got " + r.status + " " + JSON.stringify(r.json));
        assert.equal(r.json.ok, true);
        assert.equal(r.json.kind, "ytdlp", "cancel must clean up as the delegate kind");
        assert.equal(r.json.target, resolved.target);

        // The point of the tree kill: BOTH pids gone.
        await waitFor(() => !pidAlive(pids.pid), { timeoutMs: 15000, what: "the delegate to be killed" });
        await waitFor(() => !pidAlive(pids.childPid),
          { timeoutMs: 15000, what: "the grandchild to be killed (tree, not pid-only)" });
        assert.equal(fs.existsSync(resolved.target), false, "nothing published");
        assert.equal(fs.existsSync(resolved.target + ".downloadx"), false, "the staging family is discarded");
        assert.equal((await call("GET", "/api/tasks/" + id)).status, 404, "the task leaves the queue");
      } finally { cleanup(); await killPidFile(pidFile); }
    });

    // ------------------------------------------- first-class kind + guards
    suite.group("kind:ytdlp 显式任务 + magnet/ftp 永不触发 fallback");

    await suite.test("an explicit kind:'ytdlp' task runs the whole delegate", async () => {
      const cleanup = armEnv({ mode: "json", jsonFile: jsonBrokenPath });
      try {
        const id = await addTask({ url: ORIGIN + "/page", kind: "ytdlp" });
        const task = await waitComplete(id);
        assert.equal(task.kind, "ytdlp");
        const expected = path.join(out, task.filename);
        const landed = await fsp.readFile(expected);
        assert.equal(landed.equals(delegateBody()), true, "the delegate's artefact landed");
        const meta = taskRecord(id).meta;
        assert.equal(meta.engine, "yt-dlp");
        assert.equal(meta.directError, null, "no direct-link failure preceded this run");
      } finally { cleanup(); }
    });

    await suite.test("a magnet never reaches the fallback: no aria2c keeps the P-3 error, no yt-dlp mention", async () => {
      // The magnet arm must be deterministic even on a machine where a real
      // aria2c sits on PATH (this one has one via WinGet): a configured but
      // missing aria2cPath is authoritative-null in findAria2c.
      await config.set({ aria2cPath: path.join(home, "nope", "aria2c.exe") });
      try {
        const cleanup = armEnv({ mode: "json", jsonFile: jsonOkPath });
        try {
          const id = await addTask({
            url: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=fake-show",
          });
          const task = await waitError(id);
          assert.match(task.error, /磁力链接需要 aria2c 支持/);
          notMatch(task.error, /yt-dlp/, "the magnet path never touches the fallback");
        } finally { cleanup(); }
      } finally {
        await config.set({ aria2cPath: "" });
      }
    });

    await suite.test("ftp urls dispatch to ftp, not to the http fallback", async () => {
      assert.equal(detectKind("ftp://example.com/file.bin"), "ftp");
      assert.equal(detectKind("magnet:?xt=urn:btih:ABC"), "bt");
    });

    // ------------------------------------------------------ auto-download
    suite.group("ytdlpAutoDownload: 默认不下载;开启后进 appRoot;失败记一次");

    await suite.test("default off: nothing is fetched", async () => {
      const appRoot = path.join(home, "approot-auto-a");
      await fsp.mkdir(appRoot, { recursive: true });
      process.env.PATH = "";
      process.env.DOWNLOADX_APPROOT = appRoot;
      process.env.DOWNLOADX_YTDLP_RELEASE_BASE = ORIGIN + "/ytdlp-releases/";
      try {
        resetYtDlpCache();
        assert.equal(await ensureYtDlp({ explicit: "", autoDownload: false }), null,
          "absent + opt-out means null");
        assert.equal(origin.hits.get("/ytdlp-releases/" + ASSET) || 0, 0,
          "no download request may fire without the opt-in");
      } finally { restoreEnv(); resetYtDlpCache(); }
    });

    await suite.test("opted in: downloads once into the app root, then findable", async () => {
      const appRoot = path.join(home, "approot-auto-b");
      await fsp.mkdir(appRoot, { recursive: true });
      process.env.PATH = "";
      process.env.DOWNLOADX_APPROOT = appRoot;
      process.env.DOWNLOADX_YTDLP_RELEASE_BASE = ORIGIN + "/ytdlp-releases/";
      try {
        resetYtDlpCache();
        const before = origin.hits.get("/ytdlp-releases/" + ASSET) || 0;
        const bin = await ensureYtDlp({ explicit: "", autoDownload: true });
        assert.equal(bin, path.join(appRoot, ASSET), "the asset name lands in the app root");
        const st = await fsp.stat(bin);
        assert.ok(st.size >= 1024, "a real-sized binary, not an error page");
        assert.equal((origin.hits.get("/ytdlp-releases/" + ASSET) || 0) - before, 1,
          "exactly one download request");
        const leftovers = (await fsp.readdir(appRoot)).filter((n) => n.endsWith(".tmp"));
        assert.equal(leftovers.length, 0, "no .tmp sibling left behind (write-temp-then-rename)");
        resetYtDlpCache();
        assert.equal(await findYtDlp(""), bin, "a fresh scan finds the downloaded binary");
      } finally { restoreEnv(); resetYtDlpCache(); }
    });

    await suite.test("a failed download is remembered: one attempt per process", async () => {
      const appRoot = path.join(home, "approot-auto-c");
      await fsp.mkdir(appRoot, { recursive: true });
      process.env.PATH = "";
      process.env.DOWNLOADX_APPROOT = appRoot;
      process.env.DOWNLOADX_YTDLP_RELEASE_BASE = ORIGIN + "/ytdlp-releases-missing/";
      try {
        resetYtDlpCache();
        const before = origin.hits.get("/ytdlp-releases-missing/" + ASSET) || 0;
        assert.equal(await ensureYtDlp({ explicit: "", autoDownload: true }), null, "404 release → null");
        assert.equal((origin.hits.get("/ytdlp-releases-missing/" + ASSET) || 0) - before, 1);
        assert.equal(await ensureYtDlp({ explicit: "", autoDownload: true }), null,
          "the second call must not retry");
        assert.equal((origin.hits.get("/ytdlp-releases-missing/" + ASSET) || 0) - before, 1,
          "still exactly one request: the failure is remembered");
        resetYtDlpCache();
        await ensureYtDlp({ explicit: "", autoDownload: true });
        assert.equal((origin.hits.get("/ytdlp-releases-missing/" + ASSET) || 0) - before, 2,
          "the test seam reset unblocks a new attempt");
      } finally { restoreEnv(); resetYtDlpCache(); }
    });

    await suite.test("end to end: a task triggers the opted-in download through the real path", async () => {
      const appRoot = path.join(home, "approot-auto-d");
      await fsp.mkdir(appRoot, { recursive: true });
      process.env.PATH = "";
      process.env.DOWNLOADX_APPROOT = appRoot;
      process.env.DOWNLOADX_YTDLP_RELEASE_BASE = ORIGIN + "/ytdlp-releases/";
      await config.set({ ytdlpPath: "", ytdlpAutoDownload: true });
      try {
        resetYtDlpCache();
        const before = origin.hits.get("/ytdlp-releases/" + ASSET) || 0;
        const id = await addTask({ url: ORIGIN + "/gone" });
        const task = await waitError(id);
        assert.equal((origin.hits.get("/ytdlp-releases/" + ASSET) || 0) - before, 1,
          "the download fired exactly once from the task path");
        const st = await fsp.stat(path.join(appRoot, ASSET)).catch(() => null);
        assert.ok(st && st.size >= 1024, "the binary landed in the app root");
        // The downloaded fixture bytes are not a runnable exe, so the resolve
        // stage fails honestly on top of the original 404.
        assert.match(task.error, /HTTP 404/);
        assert.ok(task.error.length > 40, "an honest, non-empty final error: " + task.error);
      } finally {
        await config.set({ ytdlpPath: FAKE_YTDLP, ytdlpAutoDownload: false });
        restoreEnv();
        resetYtDlpCache();
      }
    });
  } finally {
    restoreEnv();
    for (const pidFile of [...livePidFiles]) await killPidFile(pidFile);
    await api.close().catch(() => {});
    await new Promise((r) => {
      try { origin.close().then(r); } catch { r(); }
      setTimeout(r, 1500);
    });
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch8-ytdlp crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
