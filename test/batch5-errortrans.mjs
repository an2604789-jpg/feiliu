// 批-5 回归:P-8 重试可见 + P-9 给极错误翻译 + P-10 BT 透出。
//
// ============================================================================
// P-9 云上取证步骤(顶部注释,按要求写在最前面)
// ============================================================================
// 背景:Linux 云电脑实测中,建连失败一律报 "Connection to establish proxy tunnel
// ended unexpectedly"。该文案逐字不在本仓库(开发机已验证:
//   grep -rn "ended unexpectedly" <仓库根>            → 0 命中)。
// 本仓库下载主路径(daemon)只走 src/net.mjs 的 node:http/https,仓库内全部
// fetch() 调用都指向本机 daemon 端口(开发机已 grep 验证,2026-10-25):
//   src/cli.mjs:683、desktop/daemonManager.mjs:69/508、desktop/main.mjs:534/559/597/681、
//   mcp/client.mjs:129/172、mcp/server.mjs:835
// 因此文案来源需在云机上一次运行时取证,按下述步骤执行并把原始输出回填问题单:
//
//   0) 数据根(两处都查):echo $DOWNLOADX_HOME 与默认 ~/.config/downloadx。
//   1) 仓库复核(应 0 命中):
//        grep -rn "ended unexpectedly" <downloadx 仓库根>
//   2) 复现一次必然建连失败的任务(等它进 error),取任务错误:
//        ROOT=${DOWNLOADX_HOME:-$HOME/.config/downloadx}
//        TOKEN=$(jq -r .token $ROOT/runtime.json); PORT=$(jq -r .port $ROOT/runtime.json)
//        curl -s -H "x-downloadx-token: $TOKEN" http://127.0.0.1:$PORT/api/tasks \
//          | jq -r '.tasks[].error'
//      判断点:若 task.error 已是本批的中文翻译(如 "连接被拒绝:…"),而用户看到的
//      仍是 tunnel 英文文案,则该文案出自别的进程(GUI/Electron/CLI),不是 daemon
//      ——范围立即收窄,引擎侧排除。
//   3) 同屏取证配置与 daemon 进程环境:
//        jq '{proxy, proxyMode}' $ROOT/config.json
//        tr '\0' '\n' < /proc/$(pgrep -f "downloadx.mjs daemon")/environ \
//          | grep -iE 'proxy|NODE_|ELECTRON'
//      判断点:a) config.proxy 非空 → 本仓库 net.mjs 的 CONNECT 路径在工作,其报错
//      是 "proxy CONNECT failed: HTTP <code> for <host>"(本批起带 host),与 tunnel
//      文案不同——两者同时出现说明还有第二条路径;b) daemon 环境里即使有
//      HTTP(S)_PROXY,Node 原生 fetch 默认也不读它们(需 Node>=24 的
//      NODE_USE_ENV_PROXY=1 或代码显式传 dispatcher;本仓库两者都没有),"undici 经
//      fetch" 的假设就此减弱。
//   4) 若文案出现在 GUI/Electron(待验证假设,不以文案风格定论):Electron 主进程的
//      fetch 走 Chromium 网络栈并遵循系统代理,可能与 daemon 的报错不同源。比对:
//        a) daemon 日志 $ROOT/logs/ 里同一时刻有无同文案;
//        b) strings <应用内的 electron 可执行文件> | grep -i "proxy tunnel" 是否命中。
//   5) undici 最小复现(仅当步骤 3 查到代理变量时才有意义):
//        env HTTP_PROXY=http://<代理> HTTPS_PROXY=http://<代理> node -e \
//          "fetch('http://example.com/').then(r=>console.log(r.status)).catch(e=>console.log(String(e.cause||e)))"
//      再加 NODE_USE_ENV_PROXY=1 跑一次对比:只有后者报 tunnel 文案而前者不报,
//      才能坐实 "undici 经 fetch 路径"。
//   6) 结论回填:贴 1/2/3 的原始输出;若 task.error 已是中文而 GUI 仍显 tunnel 文案,
//      问题转给 desktop/(Electron fetch × 系统代理),引擎侧关闭。
// ============================================================================
//
// 本文件的回归内容:
//   (a) translateTaskError 单元:各底层码 → 固定中文文案(域名解析失败/连接被拒绝/
//       连接超时或被重置,含 host[:port]);proxy CONNECT 非 200 保留既有文案家族并
//       带 host;未知 errno 码原文+目标主机;取消/应用语义码(TARGET_BUSY 等)/无码
//       错误原样不动;磁盘 errno 不追加 host;
//   (b) P-8 probe 尝试次数透出:对拒绝连接的本地端口,probe() 拒绝值带
//       attempts/backoffMs/attemptErrors;经完整任务链路(API→queue→downloader)
//       的最终错误为 "after N attempts(退避合计 Xs): 连接被拒绝:…",且任务
//       retries 字段 = N-1(此前恒 0);
//   (c) P-8 成功路径:probe 前两轮 503、第三轮可用 → 任务完成且 retries=2,
//       并落盘到 queue.json;
//   (d) P-10 BT tail:aria2c 失败(instant-exit)→ task.error 带退出码+尾部输出,
//       且 task.meta.tail 携带完整 stdout/stderr;暂停(hang)→ error 为空、
//       meta.tail 保留挂起前输出;任务级 proxy → --all-proxy 显式透传。
//
// 一切都在本地 origin/本地端口 + 隔离 DOWNLOADX_HOME(临时目录)里进行:不碰公网、
// 不碰用户 Downloads、不碰 D:/IAM/downloadx-data,只跑 node,进程必须干净退出。
//
// Usage: node test/batch5-errortrans.mjs

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ARIA2C = path.join(HERE, "fixtures", "fake-aria2c.mjs");

/** A TCP port that is guaranteed free RIGHT NOW (listen, read, close). */
async function closedPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
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

async function main() {
  const suite = new Suite("batch5-errortrans");
  const NL = String.fromCharCode(10);
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else if (r.kind === "skip") process.stdout.write("    SKIP  " + r.text + "  - " + r.reason + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b5-errortrans-"));
  const out = path.join(home, "out");
  await fsp.mkdir(out, { recursive: true });
  process.env.DOWNLOADX_HOME = home;

  const { translateTaskError } = await import("../src/net.mjs");
  const { probe } = await import("../src/probe.mjs");
  const { Config } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { Downloader } = await import("../src/downloader.mjs");
  const { ApiServer } = await import("../src/api.mjs");

  let api = null;
  let queue = null;
  const resolvedTargets = new Map();

  /** Set the fake aria2c's mode/files for one arm; returns a cleanup fn. */
  const armEnv = ({ mode = "ok", argsFile = null, pidFile = null } = {}) => {
    process.env.DOWNLOADX_FAKE_ARIA2C_MODE = mode;
    if (argsFile) process.env.DOWNLOADX_FAKE_ARIA2C_ARGSFILE = argsFile;
    else delete process.env.DOWNLOADX_FAKE_ARIA2C_ARGSFILE;
    if (pidFile) process.env.DOWNLOADX_FAKE_ARIA2C_PIDFILE = pidFile;
    else delete process.env.DOWNLOADX_FAKE_ARIA2C_PIDFILE;
    return () => {
      delete process.env.DOWNLOADX_FAKE_ARIA2C_MODE;
      delete process.env.DOWNLOADX_FAKE_ARIA2C_ARGSFILE;
      delete process.env.DOWNLOADX_FAKE_ARIA2C_PIDFILE;
    };
  };

  try {
    // ============================================================ (a) 单元
    suite.group("P-9 translateTaskError:底层码 → 固定文案");

    await suite.test("ENOTFOUND / EAI_AGAIN → 域名解析失败:<host>", async () => {
      const dns = Object.assign(new Error("getaddrinfo ENOTFOUND gone.example"), {
        code: "ENOTFOUND", hostname: "gone.example",
      });
      assert.equal(translateTaskError(dns, { url: "http://gone.example/x" }),
        "域名解析失败:gone.example");
      const again = Object.assign(new Error("getaddrinfo EAI_AGAIN slow.example"), {
        code: "EAI_AGAIN",
      });
      // 无 hostname 时从 URL 兜底取名。
      assert.equal(translateTaskError(again, { url: "http://slow.example:8080/x" }),
        "域名解析失败:slow.example");
    });

    await suite.test("ECONNREFUSED → 连接被拒绝:<host>:<port>(err.port 与 URL 兜底)", async () => {
      const withPort = Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:9"), {
        code: "ECONNREFUSED", port: 9,
      });
      assert.equal(translateTaskError(withPort, { url: "http://10.1.2.3:9/f" }),
        "连接被拒绝:10.1.2.3:9");
      const fromUrl = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:46321"), {
        code: "ECONNREFUSED",
      });
      assert.equal(translateTaskError(fromUrl, { url: "http://127.0.0.1:46321/f" }),
        "连接被拒绝:127.0.0.1:46321");
    });

    await suite.test("ECONNRESET / ETIMEDOUT → 连接超时或被重置:<host>", async () => {
      const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      assert.equal(translateTaskError(reset, { url: "https://cdn.example/f" }),
        "连接超时或被重置:cdn.example");
      const timedOut = Object.assign(new Error("connect ETIMEDOUT 1.2.3.4:443"), {
        code: "ETIMEDOUT",
      });
      assert.equal(translateTaskError(timedOut, { url: "https://1.2.3.4/f" }),
        "连接超时或被重置:1.2.3.4");
    });

    await suite.test("proxy CONNECT 非 200:保留既有文案家族,缺 host 时补上", async () => {
      const bare = new Error("proxy CONNECT failed: HTTP 403");
      bare.name = "ProxyConnectError";
      assert.equal(translateTaskError(bare, { url: "https://media.example/f" }),
        "proxy CONNECT failed: HTTP 403 for media.example");
      const withHost = new Error("proxy CONNECT failed: HTTP 502 for media.example");
      withHost.name = "ProxyConnectError";
      assert.equal(translateTaskError(withHost, { url: "https://irrelevant.example/" }),
        "proxy CONNECT failed: HTTP 502 for media.example");
    });

    await suite.test("未知 errno 码:保留原文并追加目标主机", async () => {
      const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      assert.equal(translateTaskError(epipe, { url: "http://origin.example/f" }),
        "write EPIPE（目标 origin.example）");
      const undici = Object.assign(new Error("fetch failed"), { code: "UND_ERR_SOCKET" });
      assert.equal(translateTaskError(undici, { url: "http://u.example/f" }),
        "fetch failed（目标 u.example）");
    });

    await suite.test("取消/应用语义码/无码/磁盘 errno:原样不动(null)", async () => {
      const aborted = Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
      assert.equal(translateTaskError(aborted, { url: "http://x.example/" }), null);
      const busy = Object.assign(new Error("output path is in use by another transfer"), {
        code: "TARGET_BUSY",
      });
      assert.equal(translateTaskError(busy, { url: "http://x.example/" }), null);
      const exists = Object.assign(new Error("file already exists and overwriteExisting is skip"), {
        code: "ALREADY_EXISTS",
      });
      assert.equal(translateTaskError(exists, { url: "http://x.example/" }), null);
      const httpAnswer = new Error("HTTP 404 Not Found for http://x.example/f");
      assert.equal(translateTaskError(httpAnswer, { url: "http://x.example/f" }), null);
      const disk = Object.assign(new Error("EPERM: operation not permitted, open 'C:/x'"), {
        code: "EPERM",
      });
      assert.equal(translateTaskError(disk, { url: "http://x.example/f" }), null,
        "磁盘错误不得被追加网络目标(错误的环节归因)");
    });

    // ==================================================== (b1) probe 直测
    suite.group("P-8 probe 尝试次数透出(直连 probe)");

    await suite.test("预算耗尽:attempts/backoffMs/attemptErrors 挂在拒绝值上", async () => {
      const port = await closedPort();
      let caught = null;
      try {
        await probe("http://127.0.0.1:" + port + "/probe.bin",
          { serialized: false, maxRetries: 3, retryBaseMs: 20 });
      } catch (err) { caught = err; }
      assert.ok(caught, "the probe must reject");
      assert.equal(caught.code, "ECONNREFUSED", "底层错误原样透传(不包裹)");
      assert.equal(caught.attempts, 3, "实际尝试轮数");
      assert.equal(caught.backoffMs, 60, "退避合计 = 20*2^0 + 20*2^1 = 60ms");
      assert.deepEqual(caught.attemptErrors, ["ECONNREFUSED", "ECONNREFUSED", "ECONNREFUSED"],
        "每轮一行错误摘要");
    });

    // ============================== (b2) 完整任务链路:翻译文案 + retries 字段
    suite.group("P-8/P-9 完整任务链路(拒绝连接 → 翻译 + 重试计数)");

    // 独立的 API 栈:重试参数收紧(3 轮、50ms 起)让断言又快又确定。
    const config = new Config(path.join(home, "config.json"));
    await config.load();
    await config.set({
      defaultDir: out,
      categorizeByType: false,
      maxConnections: 1,
      maxConcurrentDownloads: 1,
      segmentBytes: 262144,
      overwriteExisting: "rename",
      proxy: "",
      proxyMode: "none",
      maxRetries: 3,
      retryBaseMs: 50,
    });
    queue = new QueueManager({ config });
    await queue.load();
    const downloader = new Downloader({ config, queue });
    api = new ApiServer({
      queue, config, downloader,
      log: { info() {}, warn() {}, error() {}, tail: () => [] },
    }).startRunner();
    const listening = await api.listen({ port: 0 });
    downloader.on("resolved", (p) => { if (p && p.taskId && p.target) resolvedTargets.set(p.taskId, p.target); });

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

    await suite.test("任务失败:错误=after N attempts(退避合计 Xs)+中文翻译,retries=N-1", async () => {
      const port = await closedPort();
      const added = await call("POST", "/api/tasks",
        { url: "http://127.0.0.1:" + port + "/refused.bin", filename: "refused.bin" });
      assert.equal(added.status, 201, "add must be accepted: " + JSON.stringify(added.json));
      const id = added.json.task.id;

      const task = await waitFor(async () => {
        const t = await taskById(id);
        return t && t.status === "error" ? t : false;
      }, { what: "the refused task to fail" });

      assert.match(task.error,
        new RegExp("^after 3 attempts\\(退避合计 [\\d.]+s\\): 连接被拒绝:127\\.0\\.0\\.1:" + port + "$"),
        "最终错误 = 尝试次数 + 退避合计 + 翻译后的底层原因,实际: " + task.error);
      assert.equal(task.retries, 2, "任务 retries 必须计入 probe 的重试轮数(此前恒 0)");
      assert.equal(fs.existsSync(path.join(out, "refused.bin")), false, "失败任务不得发布文件");
    });

    // ==================================== (c) probe 重试后成功 → retries 可见
    suite.group("P-8 成功路径:probe 前两轮 503,第三轮可用");

    await suite.test("任务完成且 retries=2,并落盘 queue.json", async () => {
      // 本地 origin:前两个请求(任意方法)回 503,之后正常服务带 Range 的小文件。
      const body = Buffer.alloc(2048, 7);
      let hits = 0;
      const origin = http.createServer((req, res) => {
        hits++;
        if (hits <= 2) { res.writeHead(503, { "content-type": "text/plain" }); res.end("boom"); return; }
        const range = /bytes=(\d+)-(\d+)?/.exec(req.headers.range || "");
        if (range) {
          const start = Number(range[1]);
          const end = Math.min(Number(range[2] ?? body.length - 1), body.length - 1);
          const slice = body.subarray(start, end + 1);
          res.writeHead(206, {
            "content-length": slice.length,
            "content-range": "bytes " + start + "-" + end + "/" + body.length,
            "accept-ranges": "bytes",
          });
          res.end(slice);
          return;
        }
        res.writeHead(200, {
          "content-length": body.length,
          "accept-ranges": "bytes",
          etag: '"b5-stable"',
        });
        res.end(body);
      });
      await new Promise((r) => origin.listen(0, "127.0.0.1", r));
      const port = origin.address().port;

      try {
        const added = await call("POST", "/api/tasks",
          { url: "http://127.0.0.1:" + port + "/flaky.bin", filename: "flaky.bin" });
        const id = added.json.task.id;
        const task = await waitFor(async () => {
          const t = await taskById(id);
          if (t && t.status === "error") throw new Error("task failed: " + t.error);
          return t && t.status === "complete" ? t : false;
        }, { what: "the flaky task to complete" });
        assert.equal(task.retries, 2, "成功任务也要把 probe 的两轮重试记进 retries");
        assert.equal(task.downloadedBytes, 2048);

        // 落盘复核:queue.json(400ms 去抖保存)里的同一任务 retries=2。
        const persisted = await waitFor(async () => {
          try {
            const raw = JSON.parse(await fsp.readFile(path.join(home, "queue.json"), "utf8"));
            const rec = (raw.tasks || []).find((t) => t.id === id);
            return rec && rec.retries === 2 ? rec : false;
          } catch { return false; }
        }, { timeoutMs: 8000, what: "queue.json to persist retries=2" });
        assert.equal(persisted.retries, 2, "retries 必须进入持久化任务记录");
      } finally {
        await new Promise((r) => { origin.close(r); setTimeout(r, 300); });
      }
    });

    // ======================================================== (d) P-10 BT
    suite.group("P-10 BT 透出:tail 并入 + --all-proxy 显式透传");

    await config.set({ aria2cPath: FAKE_ARIA2C });
    const MAGNET_A = "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=tail-fail";
    const MAGNET_B = "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&dn=tail-hang";
    const MAGNET_C = "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&dn=task-proxy";

    await suite.test("aria2c 失败:error 带退出码+尾部输出,meta.tail 带完整 stdout/stderr", async () => {
      const cleanup = armEnv({ mode: "instant-exit" });
      const added = await call("POST", "/api/tasks", { url: MAGNET_A, filename: "tail-fail.bin" });
      const id = added.json.task.id;
      const task = await waitFor(async () => {
        const t = await taskById(id);
        return t && t.status === "error" ? t : false;
      }, { what: "the BT task to fail" });

      assert.match(task.error, /aria2c 委托失败（退出码 3）/, "错误必须带退出码");
      assert.match(task.error, /simulated startup failure/, "错误内联携带控制台尾部");
      assert.equal(task.error.startsWith("after"), false,
        "委托失败的错误不被错误翻译层改写(无底层码)");
      assert.equal(task.retries, 0, "BT 委托失败不产生重试计数");

      const meta = queue.get(id).meta;
      assert.ok(meta && meta.tail, "task.meta.tail 必须存在");
      assert.equal(meta.tail.stderr.length, 1, "stderr tail 全量并入");
      assert.match(meta.tail.stderr[0], /simulated startup failure/);
      assert.deepEqual(meta.tail.stdout, [], "该模式下 stdout 无输出,如实为空");
      cleanup();
    });

    await suite.test("暂停(abort):error 为空,meta.tail 保留挂起前的输出", async () => {
      const pidFile = path.join(home, "hang-pids.json");
      const cleanup = armEnv({ mode: "hang", pidFile });
      const added = await call("POST", "/api/tasks", { url: MAGNET_B, filename: "tail-hang.bin" });
      const id = added.json.task.id;

      // 等委托真正跑起来(pidfile 是 fake 写的,证明进程已活)。
      await waitFor(async () => {
        try { return Boolean(JSON.parse(await fsp.readFile(pidFile, "utf8")).pid); }
        catch { return false; }
      }, { what: "the hung delegate to start" });

      assert.equal((await call("POST", "/api/tasks/" + id + "/pause")).status, 200);
      const task = await waitFor(async () => {
        const t = await taskById(id);
        return t && t.status === "paused" ? t : false;
      }, { what: "the BT task to report paused" });

      assert.equal(task.error, null, "暂停不是失败,error 必须为空");
      // 状态是同步翻成 paused 的,而 tail 要等 aria2c 进程树死透、close 事件
      // 携带 btTail 拒绝回来才并入——对合并本身做等待,不猜时序。
      const meta = await waitFor(() => {
        const m = queue.get(id) && queue.get(id).meta;
        return m && m.tail ? m : false;
      }, { timeoutMs: 15000, what: "the abort path to merge meta.tail" });
      assert.ok(meta.tail, "取消/暂停路径也必须并入 meta.tail");
      assert.ok(meta.tail.stdout.length >= 1,
        "挂起前打印的进度行必须在 tail 里,实际: " + JSON.stringify(meta.tail));
      // 暂停保留续传现场(BT 语义),清理交给 cancel。
      assert.equal((await call("POST", "/api/tasks/" + id + "/cancel")).status, 200);
      cleanup();
    });

    await suite.test("任务级 proxy 显式透传 --all-proxy(配置为空时依然生效)", async () => {
      const argsFile = path.join(home, "args-taskproxy.json");
      const cleanup = armEnv({ mode: "ok", argsFile });
      // API 的 add 不收 proxy 字段;任务级代理经 queue 直加(与 API 同一条 runner 链)。
      const task = queue.add({
        url: MAGNET_C, filename: "task-proxy.bin",
        proxy: "http://10.9.8.7:3128", queueId: "proxytest",
      });
      const done = await waitFor(async () => {
        const t = await taskById(task.id);
        if (t && t.status === "error") throw new Error("task failed: " + t.error);
        return t && t.status === "complete" ? t : false;
      }, { what: "the proxied BT task to complete" });
      assert.equal(done.status, "complete");
      const argv = JSON.parse(await fsp.readFile(argsFile, "utf8"));
      assert.ok(argv.includes("--all-proxy=http://10.9.8.7:3128"),
        "任务级代理必须显式传给 aria2c: " + JSON.stringify(argv));
      cleanup();
    });
  } finally {
    if (api) await api.close().catch(() => {});
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch5-errortrans crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
