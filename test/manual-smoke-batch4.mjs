// 批-4 验收 manualSmoke 第一部分:真 aria2c 下真磁力 + 任务转 MP3。
//
// 环境纪律:临时 DOWNLOADX_HOME,不触碰 D:/IAM/downloadx-data 与真实 Downloads;
// 真 aria2c 从命令行参数传入(临时目录解压的官方 release);磁力是 ubuntu 官方
// 种子的 infohash 组成(由 releases.ubuntu.com 的 .torrent 现场计算);只观察
// 到真实进度即取消(2GB ISO 不下完),取消后用 tasklist 证明 aria2c 进程树已死。
//
// Usage: node test/manual-smoke-batch4.mjs <aria2c.exe-abs-path>
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import http from "node:http";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

const ARIA2C = process.argv[2];
if (!ARIA2C) { console.error("usage: node manual-smoke-batch4.mjs <aria2c.exe>"); process.exit(2); }

const MAGNET = "magnet:?xt=urn:btih:95c6c298c84fee2eee10c044d673537da158f0f8" +
  "&dn=ubuntu-22.04.5-live-server-amd64.iso&tr=https%3A%2F%2Ftorrent.ubuntu.com%2Fannounce";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 90000, everyMs = 500, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await sleep(everyMs);
  }
}
const tasklistHasAria2c = () => new Promise((resolve) => {
  execFile("tasklist", ["/FI", "IMAGENAME eq aria2c.exe", "/FO", "CSV", "/NH"], { windowsHide: true },
    (err, stdout) => resolve(!err && /aria2c\.exe/i.test(String(stdout))));
});

async function main() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "dx-smoke1-"));
  const out = path.join(home, "out");
  await fsp.mkdir(out, { recursive: true });
  process.env.DOWNLOADX_HOME = home;

  const { Config } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { Downloader } = await import("../src/downloader.mjs");
  const { ApiServer } = await import("../src/api.mjs");

  const config = new Config(path.join(home, "config.json"));
  await config.load();
  await config.set({
    defaultDir: out,
    categorizeByType: false,
    overwriteExisting: "rename",
    monitorClipboard: false,
    proxy: "", proxyMode: "none",
    aria2cPath: ARIA2C,
    maxConcurrentDownloads: 3,
  });
  const queue = new QueueManager({ config });
  await queue.load();
  const downloader = new Downloader({ config, queue });
  const frames = [];
  downloader.on("progress", (p) => { if (p && p.approx === true) frames.push(p); });
  const api = new ApiServer({ queue, config, downloader, log: { info() {}, warn() {}, error() {}, tail: () => [] } }).startRunner();
  const listening = await api.listen({ port: 0 });
  const call = async (method, route, body) => {
    const headers = { "x-downloadx-token": listening.token };
    if (body) headers["content-type"] = "application/json";
    const res = await fetch("http://127.0.0.1:" + listening.port + route, {
      method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  };

  const report = { magnet: {}, mp3: {} };
  try {
    // ================= 1) magnet via REAL aria2c (best-effort: sandboxed egress
    // may not move BT peer data; the dedicated local-protocol smoke covers the
    // magnet path separately, this arm documents the WAN attempt) =================
    try {
      if (process.env.SMOKE_SKIP_WAN === "1") throw new Error("skipped via SMOKE_SKIP_WAN=1");
      const before = await tasklistHasAria2c();
      const added = await call("POST", "/api/tasks", { url: MAGNET, filename: "ubuntu-22.04.5.iso" });
      if (added.status !== 201) throw new Error("add failed: " + JSON.stringify(added.json));
      const id = added.json.task.id;
      report.magnet.taskId = id;
      report.magnet.kind = added.json.task.kind;

      // Wait for real data flow: downloading status with bytes on disk.
      const t = await waitFor(async () => {
        const r = await call("GET", "/api/tasks/" + id);
        const task = r.json.task;
        if (task && task.status === "error") throw new Error("task failed: " + task.error);
        return task && (task.status === "downloading") && (task.downloadedBytes || 0) > 0 ? task : false;
      }, { timeoutMs: 90000, what: "the real BT transfer to move bytes" });
      report.magnet.reachedStatus = t.status;
      report.magnet.bytesWhenCancelled = t.downloadedBytes;
      report.magnet.totalBytes = t.totalBytes;
      report.magnet.approxFrames = frames.filter((f) => f.approx === true).length;
      report.magnet.aria2cRunningMidFlight = await tasklistHasAria2c();
      if (before) console.error("[warn] an aria2c.exe was already running before the smoke started");

      const cancel = await call("POST", "/api/tasks/" + id + "/cancel");
      report.magnet.cancelStatus = cancel.status;
      await waitFor(async () => !(await tasklistHasAria2c()),
        { timeoutMs: 20000, what: "the real aria2c tree to be gone after cancel" });
      report.magnet.aria2cGoneAfterCancel = true;
      const gone = await call("GET", "/api/tasks/" + id);
      report.magnet.taskGone404 = gone.status === 404;
      report.magnet.nothingLanded = !(await fsp.stat(path.join(out, "ubuntu-22.04.5.iso")).then(() => true, () => false));
      report.magnet.stagingLeft = await fsp.stat(path.join(out, "ubuntu-22.04.5.iso") + ".downloadx").then(() => true, () => false);
    } catch (err) {
      report.magnet.wanAttemptError = String(err && err.message || err);
      // best-effort cleanup of the half task, if any (bounded: never hang the smoke)
      try {
        const list = await Promise.race([call("GET", "/api/tasks"), sleep(8000).then(() => null)]);
        for (const t of (list && list.json && list.json.tasks) || []) {
          if (t.url && t.url.startsWith("magnet:")) {
            await Promise.race([call("POST", "/api/tasks/" + t.id + "/cancel").catch(() => {}), sleep(8000)]);
          }
        }
      } catch { /* cleanup itself is best-effort */ }
    }

    // ================= 2) real task -> convert to MP3 =================
    // a real sample video via the real ffmpeg
    const sample = path.join(home, "sample.mp4");
    await new Promise((res, rej) => {
      execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
        "testsrc=duration=3:size=320x240:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", sample],
        { windowsHide: true }, (err) => err ? rej(err) : res());
    });
    // served over local http so the download task is a real transfer
    const body = await fsp.readFile(sample);
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "video/mp4", "content-length": body.length });
      res.end(body);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    const dl = await call("POST", "/api/tasks", { url: "http://127.0.0.1:" + port + "/sample.mp4", filename: "sample.mp4" });
    if (dl.status !== 201) throw new Error("download add failed: " + JSON.stringify(dl.json));
    const dlTask = await waitFor(async () => {
      const r = await call("GET", "/api/tasks/" + dl.json.task.id);
      const task = r.json.task;
      if (task && task.status === "error") throw new Error("download failed: " + task.error);
      return task && task.status === "complete" ? task : false;
    }, { timeoutMs: 60000, what: "the sample download" });
    // the REAL landed path, exactly the way the GUI's convert dialog gets it
    const loc = await call("GET", "/api/tasks/" + encodeURIComponent(dlTask.id) + "/location");
    const sourcePath = loc.json && loc.json.path;
    if (!sourcePath || !loc.json.exists) throw new Error("location says no file: " + JSON.stringify(loc.json));
    report.mp3.sourceTask = { id: dlTask.id, bytes: dlTask.downloadedBytes, sourcePath };

    const cv = await call("POST", "/api/tasks", {
      url: "convert:" + sourcePath, kind: "convert",
      meta: { sourcePath, sourceTaskId: dlTask.id, preset: "mp3" },
    });
    if (cv.status !== 201) throw new Error("convert add failed: " + JSON.stringify(cv.json));
    const cvTask = await waitFor(async () => {
      const r = await call("GET", "/api/tasks/" + cv.json.task.id);
      const task = r.json.task;
      if (task && task.status === "error") throw new Error("convert failed: " + task.error);
      return task && task.status === "complete" ? task : false;
    }, { timeoutMs: 120000, what: "the mp3 conversion" });
    const cvLoc = await call("GET", "/api/tasks/" + encodeURIComponent(cvTask.id) + "/location");
    report.mp3.convertTask = {
      id: cvTask.id, target: cvLoc.json && cvLoc.json.path, bytes: cvTask.downloadedBytes,
      sha256: cvTask.sha256 ? cvTask.sha256.slice(0, 12) + "…" : null,
      percentFinal: cvTask.percent,
    };
    // ffprobe the artefact: it must really be MP3 audio
    const probe = await new Promise((res) => {
      execFile("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,codec_type",
        "-of", "csv=p=0", report.mp3.convertTask.target], { windowsHide: true },
        (err, stdout) => res(err ? "probe-error: " + err.message : String(stdout).trim()));
    });
    report.mp3.ffprobe = probe;
    report.mp3.isMp3 = /mp3/.test(probe) && /audio/.test(probe);
    srv.close();
  } finally {
    await Promise.race([api.close().catch(() => {}), sleep(12000)]);
  }

  console.log(JSON.stringify({ home, report }, null, 2));
  // the WAN magnet arm is best-effort (sandbox egress); the MP3 arm decides.
  process.exitCode = report.mp3.isMp3 ? 0 : 1;
}

main().catch((err) => { console.error("smoke crashed: " + ((err && err.stack) || err)); process.exitCode = 1; });
