// 批-4 验收 manualSmoke 第二部分:两组并发各自上限的真机观察。
//
// 临时 DOWNLOADX_HOME;queues=[{id:'smoke-a',concurrent:2},{id:'smoke-b',concurrent:1}],
// maxConcurrentDownloads=3。本地"慢"服务(每响应限速 ~50KB/s)使任务足够长寿,
// 入队 a 组 4 个 + b 组 3 个,采样在途分布,断言每份样本满足 a<=2、b<=1、总<=3。
//
// Usage: node test/manual-smoke-multiqueue.mjs
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import http from "node:http";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "dx-smoke2-"));
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
    defaultDir: out, categorizeByType: false, overwriteExisting: "rename",
    monitorClipboard: false, proxy: "", proxyMode: "none",
    maxConcurrentDownloads: 3, maxConnections: 2,
    queues: [
      { id: "smoke-a", name: "A组", concurrent: 2 },
      { id: "smoke-b", name: "B组", concurrent: 1 },
    ],
  });
  const queue = new QueueManager({ config });
  await queue.load();
  const downloader = new Downloader({ config, queue });
  const api = new ApiServer({ queue, config, downloader, log: { info() {}, warn() {}, error() {}, tail: () => [] } }).startRunner();
  const listening = await api.listen({ port: 0 });
  const call = async (method, route, body) => {
    const headers = { "x-downloadx-token": listening.token };
    if (body) headers["content-type"] = "application/json";
    const res = await fetch("http://127.0.0.1:" + listening.port + route, {
      method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  // A slow local origin: ~1.5MB at ~50KB/s per response → ~30s per task.
  const srv = http.createServer((req, res) => {
    const chunk = Buffer.alloc(8192, 0x61);
    res.writeHead(200, { "content-type": "application/octet-stream" });
    let sent = 0;
    const timer = setInterval(() => {
      res.write(chunk); sent += chunk.length;
      if (sent >= 1536 * 1024) { clearInterval(timer); res.end(); }
    }, 160);
    req.on("close", () => clearInterval(timer));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;

  const ids = [];
  try {
    for (let i = 0; i < 4; i++) {
      const r = await call("POST", "/api/tasks", {
        url: `http://127.0.0.1:${port}/a${i}.bin`, filename: `a${i}.bin`, queueId: "smoke-a",
      });
      if (r.status !== 201) throw new Error("add a" + i + " failed: " + JSON.stringify(r.json));
      ids.push({ id: r.json.task.id, group: "smoke-a" });
    }
    for (let i = 0; i < 3; i++) {
      const r = await call("POST", "/api/tasks", {
        url: `http://127.0.0.1:${port}/b${i}.bin`, filename: `b${i}.bin`, queueId: "smoke-b",
      });
      if (r.status !== 201) throw new Error("add b" + i + " failed: " + JSON.stringify(r.json));
      ids.push({ id: r.json.task.id, group: "smoke-b" });
    }

    // Sample the in-flight distribution for ~12 seconds.
    const samples = [];
    for (let s = 0; s < 12; s++) {
      await sleep(1000);
      const r = await call("GET", "/api/tasks");
      const byId = new Map((r.json.tasks || []).map((t) => [t.id, t]));
      const counts = { "smoke-a": 0, "smoke-b": 0 };
      const activeNames = [];
      for (const { id, group } of ids) {
        const t = byId.get(id);
        const active = t && (t.status === "downloading" || t.status === "connecting");
        if (active) { counts[group]++; activeNames.push(group + ":" + path.basename(t.filename || "")); }
      }
      samples.push({ t: s + 1, a: counts["smoke-a"], b: counts["smoke-b"],
        total: counts["smoke-a"] + counts["smoke-b"], active: activeNames });
    }

    const violations = samples.filter((s) => s.a > 2 || s.b > 1 || s.total > 3);
    const sawA2 = samples.some((s) => s.a === 2);
    const sawB1 = samples.some((s) => s.b === 1);
    const sawTotal3 = samples.some((s) => s.total === 3);

    // Teardown: cancel everything so the process can exit clean.
    for (const { id } of ids) await call("POST", "/api/tasks/" + id + "/cancel").catch(() => {});
    await sleep(500);

    console.log(JSON.stringify({
      home,
      samples,
      violations,
      sawA2, sawB1, sawTotal3,
      verdict: violations.length === 0 && sawA2 && sawB1 && sawTotal3 ? "PASS" : "FAIL",
    }, null, 2));
    process.exitCode = violations.length === 0 && sawA2 && sawB1 && sawTotal3 ? 0 : 1;
  } finally {
    srv.close();
    await api.close().catch(() => {});
  }
}

main().catch((err) => { console.error("smoke crashed: " + ((err && err.stack) || err)); process.exitCode = 1; });
