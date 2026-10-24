// 批-4 验收 manualSmoke(磁力,全本地真协议):
// 外网 BT peer 数据不动(沙箱),故用真 aria2c + 真 BT 协议栈在本地闭环:
//   payload -> 自制 .torrent(bencode+piece sha1)-> 本机 HTTP tracker ->
//   真 aria2c #1 做种(校验既有文件)-> downloadx 以 magnet:?xt=urn:btih:<infohash>
//   &tr=http://127.0.0.1/announce 入队 -> 引擎 spawn 真 aria2c #2 -> tracker
//   announce -> peer wire + ut_metadata + piece 传输 -> 落盘 -> sha256 比对。
// 走的完全是引擎生产路径(bt.mjs runBt:--dir/--summary-interval/取消语义),
// 仅 peer 在本机。临时 DOWNLOADX_HOME;做种进程由本脚本 spawn 并收走。
//
// Usage: node test/manual-smoke-bt-local.mjs <aria2c.exe-abs-path>
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";

const ARIA2C = process.argv[2];
if (!ARIA2C) { console.error("usage: node manual-smoke-bt-local.mjs <aria2c.exe>"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 90000, everyMs = 400, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await sleep(everyMs);
  }
}

// ---- minimal bencode (encode: int/str/bytes/dict/list) ----
const benc = (v) => {
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(v.length + ":"), v]);
  if (typeof v === "string") return benc(Buffer.from(v, "utf8"));
  if (Number.isInteger(v)) return Buffer.from("i" + v + "e");
  if (Array.isArray(v)) return Buffer.concat([Buffer.from("l"), ...v.map(benc), Buffer.from("e")]);
  const keys = Object.keys(v).sort();
  return Buffer.concat([Buffer.from("d"), ...keys.flatMap((k) => [benc(k), benc(v[k])]), Buffer.from("e")]);
};
const sha1 = (b) => createHash("sha1").update(b).digest();

async function main() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "dx-smoke3-"));
  const seedDir = path.join(home, "seed");
  const out = path.join(home, "out");
  await fsp.mkdir(seedDir, { recursive: true });
  await fsp.mkdir(out, { recursive: true });
  process.env.DOWNLOADX_HOME = home;

  // 1) the payload and its torrent
  const NAME = "smoke-payload.bin";
  const payload = createHash("sha512").update("downloadx batch-4 manual smoke " + Date.now()).digest();
  const parts = [];
  for (let i = 0; i < 96; i++) parts.push(createHash("sha512").update(payload).update(String(i)).digest()); // 6144B*96 = 589824
  const body = Buffer.concat(parts);
  await fsp.writeFile(path.join(seedDir, NAME), body);
  const PIECE = 131072;
  const pieces = [];
  for (let o = 0; o < body.length; o += PIECE) pieces.push(sha1(body.subarray(o, Math.min(o + PIECE, body.length))));
  const info = { length: body.length, name: NAME, "piece length": PIECE, pieces: Buffer.concat(pieces) };
  const infoBuf = benc(info);
  const infohash = sha1(infoBuf);

  // 2) a local HTTP tracker (compact peers)
  const peers = new Map(); // peerKey -> Buffer(6)
  const announceLog = [];
  const tracker = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname !== "/announce") { res.writeHead(404); res.end(); return; }
    const raw = u.search.slice(1);
    const q = {};
    for (const kv of raw.split("&")) {
      const eq = kv.indexOf("=");
      if (eq < 0) continue;
      const k = decodeURIComponent(kv.slice(0, eq));
      const vRaw = kv.slice(eq + 1);
      if (k === "info_hash" || k === "peer_id") {
        // raw percent-encoded bytes -> hex string (safe map key)
        let hex = "";
        for (let i = 0; i < vRaw.length;) {
          if (vRaw[i] === "%" && i + 3 <= vRaw.length) {
            hex += parseInt(vRaw.slice(i + 1, i + 3), 16).toString(16).padStart(2, "0");
            i += 3;
          } else { hex += Buffer.from(vRaw[i], "utf8").toString("hex"); i += 1; }
        }
        q[k] = hex;
      } else {
        q[k] = decodeURIComponentSafe(vRaw.replace(/\+/g, "%20"));
      }
    }
    const port = parseInt(q.port, 10) || 0;
    const key = (q.info_hash || "?") + ":" + port;
    if (port) peers.set(key, Buffer.concat([Buffer.from([127, 0, 0, 1]), Buffer.from([(port >> 8) & 255, port & 255])]));
    const others = [...peers.entries()].filter(([k]) => k !== key).map(([, v]) => v);
    const resp = benc({ interval: 2, peers: Buffer.concat(others) });
    announceLog.push({ port, left: q.left, numwant: q.numwant, knownPeers: peers.size, served: others.length });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(resp);
  });
  function decodeURIComponentSafe(s) {
    try { return decodeURIComponent(s); } catch { return s.replace(/%[0-9A-Fa-f]{2}/g, (m) => String.fromCharCode(parseInt(m.slice(1), 16))); }
  }
  await new Promise((r) => tracker.listen(0, "127.0.0.1", r));
  const tport = tracker.address().port;

  // 3) the seeder: a REAL aria2c verifying the existing file then seeding
  const torrentPath = path.join(seedDir, NAME + ".torrent");
  await fsp.writeFile(torrentPath, benc({ announce: "http://127.0.0.1:" + tport + "/announce", info }));
  const listenPort = 20000 + Math.floor(Math.random() * 20000);
  const seeder = spawn(ARIA2C, [
    "--dir=" + seedDir, "--check-integrity=true", "--seed-time=300",
    "--enable-dht=false", "--disable-ipv6=true", "--listen-port=" + listenPort,
    "--console-log-level=notice", "--summary-interval=0", "--file-allocation=none",
    torrentPath,
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let seederOut = "";
  seeder.stdout.on("data", (c) => { seederOut += c; });
  seeder.stderr.on("data", (c) => { seederOut += c; });
  await waitFor(() => /SEED|seeding|complete/i.test(seederOut) || peers.size > 0,
    { timeoutMs: 30000, what: "the seeder to verify and announce" });
  await sleep(1500);   // let the announce settle

  // 4) downloadx takes the magnet — the REAL production path (bt.mjs runBt)
  const { Config } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { Downloader } = await import("../src/downloader.mjs");
  const { ApiServer } = await import("../src/api.mjs");
  const config = new Config(path.join(home, "config.json"));
  await config.load();
  await config.set({
    defaultDir: out, categorizeByType: false, overwriteExisting: "rename",
    monitorClipboard: false, proxy: "", proxyMode: "none", aria2cPath: ARIA2C,
  });
  const queue = new QueueManager({ config });
  await queue.load();
  const downloader = new Downloader({ config, queue });
  const frames = [];
  downloader.on("progress", (p) => { if (p) frames.push(p); });
  const api = new ApiServer({ queue, config, downloader, log: { info() {}, warn() {}, error() {}, tail: () => [] } }).startRunner();
  const listening = await api.listen({ port: 0 });
  const call = async (method, route, body) => {
    const headers = { "x-downloadx-token": listening.token };
    if (body) headers["content-type"] = "application/json";
    const res = await fetch("http://127.0.0.1:" + listening.port + route, {
      method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const report = {};
  try {
    const magnet = "magnet:?xt=urn:btih:" + infohash.toString("hex") +
      "&dn=" + encodeURIComponent(NAME) +
      "&tr=" + encodeURIComponent("http://127.0.0.1:" + tport + "/announce");
    const added = await call("POST", "/api/tasks", { url: magnet, filename: "bt-real-landed.bin" });
    if (added.status !== 201) throw new Error("add failed: " + JSON.stringify(added.json));
    const id = added.json.task.id;
    report.addedKind = added.json.task.kind;

    let lastTask = null;
    const task = await waitFor(async () => {
      const r = await call("GET", "/api/tasks/" + id);
      const t = r.json.task;
      if (t) lastTask = t;
      if (t && t.status === "error") throw new Error("task failed: " + t.error);
      return t && t.status === "complete" ? t : false;
    }, { timeoutMs: 120000, what: "the local real-BT task to complete" }).catch(async (err) => {
      // Cancel first so the engine kills its aria2c and close() cannot hang.
      await call("POST", "/api/tasks/" + id + "/cancel").catch(() => {});
      await sleep(2000);
      throw new Error(err.message + " || lastTask=" + JSON.stringify(lastTask && {
        status: lastTask.status, bytes: lastTask.downloadedBytes, total: lastTask.totalBytes, error: lastTask.error,
      }) + " || announces=" + JSON.stringify(announceLog.slice(-6)) +
        " || seederTail=" + JSON.stringify(seederOut.slice(-600)) +
        " || frames=" + frames.length);
    });

    const landed = await fsp.readFile(path.join(out, "bt-real-landed.bin"));
    report.bytes = landed.length;
    report.sha256Match = landed.equals(body);
    report.taskSha256 = (task.sha256 || "").slice(0, 12) + "…";
    report.approxFrames = frames.filter((f) => f.approx === true && typeof f.percent === "number" && f.percent < 100).length;
    report.unknownTotalFrames = frames.filter((f) => f.totalBytes === null).length;
    report.stagingCleaned = !fs.existsSync(path.join(out, "bt-real-landed.bin") + ".downloadx");
    report.finalKind = task.kind;
    report.seederStillSeeding = seeder.exitCode === null;
    report.seederExitCode = seeder.exitCode;
  } finally {
    // teardown: only processes this script spawned
    await new Promise((r) => { execFile("taskkill", ["/PID", String(seeder.pid), "/T", "/F"], { windowsHide: true }, () => r()); });
    tracker.close();
    await Promise.race([api.close().catch(() => {}), sleep(10000)]).catch(() => {});
  }

  console.log(JSON.stringify({ home, report }, null, 2));
  process.exitCode = report.sha256Match && report.stagingCleaned ? 0 : 1;
}

main().catch(async (err) => {
  console.error("smoke crashed: " + ((err && err.stack) || err));
  process.exitCode = 1;
});
