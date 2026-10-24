// 批-4 验收 manualSmoke(GUI 设置页队列增删)的服务端:
// 临时 DOWNLOADX_HOME 的 ApiServer(内建 gui/ 伺服),打印 port+token 后挂住。
// 由验收员用浏览器操作设置页,结束后 taskkill。
//
// Usage: node test/manual-smoke-gui-server.mjs
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "dx-gui-smoke-"));
  process.env.DOWNLOADX_HOME = home;
  const { Config } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { Downloader } = await import("../src/downloader.mjs");
  const { ApiServer } = await import("../src/api.mjs");
  const config = new Config(path.join(home, "config.json"));
  await config.load();
  await config.set({
    defaultDir: path.join(home, "out"), monitorClipboard: false,
    proxy: "", proxyMode: "none", askBeforeAdd: false,
  });
  const queue = new QueueManager({ config });
  await queue.load();
  const downloader = new Downloader({ config, queue });
  const api = new ApiServer({ queue, config, downloader, log: { info() {}, warn() {}, error() {}, tail: () => [] } }).startRunner();
  const listening = await api.listen({ port: 0 });
  // marker line for the harness to parse
  console.log("GUI-SMOKE-READY " + JSON.stringify({ url: "http://127.0.0.1:" + listening.port + "/", token: listening.token, home }));
  setInterval(() => {}, 60000);   // hold
  // never exits on its own; the harness taskkills it
}

main().catch((err) => { console.error("gui smoke server crashed: " + err.stack); process.exit(1); });
