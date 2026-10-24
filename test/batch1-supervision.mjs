#!/usr/bin/env node
// 回归（包4 / W5）：owned daemon 崩溃自动重启。
//
// 缺陷背景：desktop/daemonManager.mjs 的 child.on("exit") 只记录不重启，
// daemon 被杀后界面永久“连接断开”。
//
// 这里固定下来的行为：
//   1. 默认退避序列恰为 2s/8s/30s、最多 3 次（DEFAULT_RESTART_BACKOFF_MS）；
//   2. owned daemon 意外退出 → 按退避重启，重启后 runtime.json 是新
//      pid/port/token，管理器收编为 owned=true 并回调 onRestarted
//      （桌面壳据此 loadURL 重载窗口，渲染层拿新 token——那半截是真
//      Electron 进程行为，无法在纯 node 下自动化，见文件尾部的冒烟说明）；
//   3. 每次重启前重跑 readRuntime + healthProbe 复查：退避期间出现健康
//      daemon（别的实例拉起的）就改为复用（owned=false），绝不 spawn
//      第二个，也绝不再“重启”外部实例；
//   4. 从一开始就复用外部 daemon 的路径，外部实例死掉后绝不重启；
//   5. 3 次尝试全部失败 → onGivenUp 恰好一次、不再有第 4 次 spawn
//      （无无限循环）；初始启动失败不进入监督（仍交给 ensure() 报错）；
//   6. 稳定运行超过 stableMs 后的再次崩溃，退避序列从头计；
//   7. ensure() 与自动重启互斥：在途重启未落地前不会并发拉起第二个，
//      且 ensure() 会取消挂起的退避定时器；
//   8. 最后用真实 daemon（bin/downloadx.mjs）做一次端到端：taskkill /F /T
//      强杀 → 2s 退避后自动复活，新 pid/新 token、旧进程确死。
//
// 测试数据一律放临时 DOWNLOADX_HOME（严禁读写 D:/IAM/downloadx-data）；
// 自带假 daemon HTTP 服务器收尾 closeAllConnections，进程干净退出。
//
// Run: node test/batch1-supervision.mjs

import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";
import {
  DaemonManager,
  readRuntime,
  DEFAULT_RESTART_BACKOFF_MS,
  DEFAULT_STABLE_MS,
} from "../desktop/daemonManager.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const realEntry = path.resolve(__dirname, "..", "bin", "downloadx.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitFor(fn, what, timeoutMs = 30000, intervalMs = 25) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) { lastErr = err; }
    await sleep(intervalMs);
  }
  throw new Error("timed out waiting for " + what + (lastErr ? " (" + lastErr.message + ")" : ""));
}

/** 拿一个确定已退出的 pid，用来伪造“崩溃后残留的 runtime.json”。 */
function deadPid() {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true, stdio: "ignore" });
    c.on("exit", () => resolve(c.pid));
  });
}

// ---------------------------------------------------------------------------
// 假 daemon：一个真的 HTTP 服务器扮演 /api/status，runtime.json 由测试
// 直接写入（write-temp-then-rename）。子进程用注入的 FakeChild 扮演，
// 这样退避/计数/状态机全部确定可控，不需要真杀进程。
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.killed = false;
    this.exitTs = 0;
  }
  kill() {
    if (this.killed) return;
    this.killed = true;
    setImmediate(() => {
      this.exitTs = this.exitTs || Date.now();
      this.emit("exit", 1, null);
    });
  }
}

async function main() {
  const suite = new Suite("batch1-supervision");
  const NL = String.fromCharCode(10);
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + (r.ms > 400 ? "  (" + r.ms + "ms)" : "") + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " + String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const prevHome = process.env.DOWNLOADX_HOME;
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b1-supervision-"));
  process.env.DOWNLOADX_HOME = home;
  const runtimePath = path.join(home, "runtime.json");

  /** 当前“活着”的假 daemon 描述：服务器只接受 currentToken。 */
  let currentToken = "fake-token-a";
  const server = http.createServer((req, res) => {
    if (req.url === "/api/status") {
      if (req.headers["x-downloadx-token"] !== currentToken) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad token" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "fake-daemon" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const serverPort = server.address().port;

  async function writeRuntime({ pid, port, token }) {
    const obj = {
      pid, port, host: "127.0.0.1", token,
      url: `http://127.0.0.1:${port}/`,
      startedAt: new Date().toISOString(),
      version: "fake-daemon",
    };
    const tmp = runtimePath + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
    await fsp.rename(tmp, runtimePath);
  }

  const DEAD = await deadPid();
  assert.equal(isAlive(DEAD), false, "伪造用的 pid 必须确实已死");

  const managers = [];
  const worlds = [];

  /**
   * 一个“世界”：一台受监督的 manager + 可编程的假 spawn。
   * 每个世界开档时都先把 runtime 置为陈旧（指向死 pid），确保上一个测试
   * 留下的“健康 daemon”不会被本世界误复用——各世界共享同一个
   * runtime.json / 假服务器，这是测试间的隔离边界。
   * behaviour(child, index) 决定第 index 个被拉起的假 daemon 如何表现；
   * 便捷函数：healthyNow(token) 立刻把 runtime 指向自己（模拟就绪）、
   * exitAfter(ms) 在 ms 后无 runtime 退出（模拟启动即崩）。
   */
  async function newWorld() {
    await writeRuntime({ pid: DEAD, port: serverPort, token: "stale" });
    const children = [];
    const spawnLog = [];
    let behaviour = null;
    const world = {
      children,
      spawnLog,
      setBehaviour(fn) { behaviour = fn; },
      events: { restarted: [], givenUp: [] },
      m: null,
    };
    const spawnImpl = () => {
      const child = new FakeChild(process.pid); // pid 必须活着，readRuntime 才认
      const index = children.length;
      children.push(child);
      spawnLog.push({ ts: Date.now(), index });
      if (behaviour) behaviour(child, index);
      return child;
    };
    // 测试注入的“进程树强杀”：找到对应的假孩子并让它退出，绝不碰真实进程。
    const killTreeImpl = (pid) => {
      for (let i = children.length - 1; i >= 0; i--) {
        if (children[i].pid === pid && !children[i].killed) { children[i].kill(); return; }
      }
    };
    const m = new DaemonManager({
      backoffMs: [150, 350, 650],   // 行为测试用短退避；默认值另有断言
      stableMs: 400,
      restartTimeoutMs: 1200,
      pollMs: 100,
      spawnImpl,
      killTreeImpl,
      onRestarted: (info) => world.events.restarted.push(info),
      onGivenUp: (info) => world.events.givenUp.push(info),
    });
    managers.push(m);
    world.m = m;
    worlds.push(world);
    return world;
  }

  /** 假 daemon“就绪”：服务器改收新 token，runtime 指向该子进程。 */
  const healthyNow = (token) => (child) => {
    currentToken = token;
    writeRuntime({ pid: child.pid, port: serverPort, token }).catch(() => {});
  };

  /** 假 daemon 启动后 ms 毫秒崩溃（不写 runtime）。 */
  const exitAfter = (ms) => (child) => {
    setTimeout(() => {
      child.killed = true;
      child.exitTs = Date.now();
      child.emit("exit", 1, null);
    }, ms);
  };

  /** 模拟外部强杀：runtime 变陈旧（指向死 pid），子进程收到 exit。 */
  const crash = async (child) => {
    await writeRuntime({ pid: DEAD, port: serverPort, token: "stale" });
    child.killed = true;
    child.exitTs = Date.now();
    child.emit("exit", 1, null);
  };

  const tempDirs = [home];

  try {
    suite.group("退避序列与默认值");

    await suite.test("默认退避恰为 2s/8s/30s，共 3 档（最多 3 次重启），稳定窗口 60s", async () => {
      assert.deepEqual(DEFAULT_RESTART_BACKOFF_MS, [2000, 8000, 30000],
        "规格钉死的退避序列被改动了");
      assert.equal(DEFAULT_RESTART_BACKOFF_MS.length, 3, "最多 3 次重启");
      assert.equal(DEFAULT_STABLE_MS, 60000, "稳定窗口默认 60s");
      const plain = new DaemonManager();
      managers.push(plain);
      assert.deepEqual(plain.backoffMs, [2000, 8000, 30000]);
    });

    suite.group("意外退出 → 自动重启");

    await suite.test("owned daemon 被杀：约 1 档退避后重启，新 token 生效，仍是 owned", async () => {
      const w = await newWorld();
      w.setBehaviour((child, index) => {
        if (index === 0) healthyNow("b-token-0")(child);
        if (index === 1) healthyNow("b-token-1")(child);
      });
      const r = await w.m.ensure({ timeoutMs: 5000 });
      assert.equal(r.owned, true, "初次启动必须 owned");
      assert.equal(w.m.state, "running");

      const t0 = Date.now();
      await crash(w.children[0]);
      await waitFor(() => w.children.length === 2, "第 1 次自动重启发生", 5000);
      const gap1 = w.spawnLog[1].ts - t0;
      assert.ok(gap1 >= 140, "第 1 次重启距崩溃应约等于退避第 1 档(150ms)，实测 " + gap1 + "ms");
      assert.ok(gap1 < 1400, "第 1 次重启必须在远小于默认 2s 的注入退避后发生，实测 " + gap1 + "ms");

      await waitFor(() => w.events.restarted.length === 1, "onRestarted 回调", 5000);
      const info = w.events.restarted[0];
      assert.equal(info.attempt, 1, "这是第 1 次重启尝试");
      assert.equal(info.owned, true, "重启出来的实例仍归桌面版所有");
      assert.equal(info.reused, false);
      assert.equal(w.m.state, "running");
      assert.equal(w.m.owned, true);
      assert.equal(w.m.rt.token, "b-token-1", "管理器必须收编新 token");
      assert.notEqual(w.m.rt.token, "b-token-0", "重启必须换发新 token");
      const rtNow = await readRuntime();
      assert.equal(rtNow.token, "b-token-1");

      // 稳定之后不再有无谓的重启。
      await sleep(600);
      assert.equal(w.children.length, 2, "健康运行期间不得再拉起");
      assert.equal(w.events.restarted.length, 1);
      assert.equal(w.events.givenUp.length, 0);
    });

    await suite.test("重启成功后再 ensure()：报告 owned=true 而不是误标 reused", async () => {
      const w = await newWorld();
      w.setBehaviour((child, index) => {
        if (index === 0) healthyNow("g-token-0")(child);
        if (index === 1) healthyNow("g-token-1")(child);
      });
      await w.m.ensure({ timeoutMs: 5000 });
      await crash(w.children[0]);
      await waitFor(() => w.events.restarted.length === 1, "自动重启完成", 5000);

      const r2 = await w.m.ensure({ timeoutMs: 5000 });
      assert.equal(r2.owned, true, "重启出的实例仍是我们的，ensure 不得把它当外部实例");
      assert.equal(r2.reused, false);
      assert.equal(w.children.length, 2, "ensure 不得重复拉起");
    });

    await suite.test("连崩 3 次重启全败：恰好 3 次 spawn、退避递增、onGivenUp 一次后彻底停", async () => {
      const w = await newWorld();
      w.setBehaviour((child, index) => {
        if (index === 0) healthyNow("c-token-0")(child);
        else exitAfter(30)(child); // 每次重启尝试都启动即崩
      });
      await w.m.ensure({ timeoutMs: 5000 });

      const crashTs = Date.now();
      await crash(w.children[0]);

      await waitFor(() => w.events.givenUp.length === 1, "3 次退避重启全部失败后放弃", 12000);
      assert.equal(w.children.length, 4, "初启 1 次 + 自动重启 3 次，不得更多");
      assert.equal(w.events.givenUp[0].attempts, 3, "放弃时必须已用满 3 次");
      assert.equal(w.m.state, "given-up");
      assert.equal(w.events.restarted.length, 0, "从未重启成功");

      // 退避序列必须递增且与注入值吻合（140/340/640 为下限，上限排除默认 2s/8s/30s）。
      const gap1 = w.spawnLog[1].ts - crashTs;
      const gap2 = w.spawnLog[2].ts - w.children[1].exitTs;
      const gap3 = w.spawnLog[3].ts - w.children[2].exitTs;
      assert.ok(gap1 >= 140 && gap1 < 1400, "第 1 档退避 ≈150ms，实测 " + gap1 + "ms");
      assert.ok(gap2 >= 340 && gap2 < 2500, "第 2 档退避 ≈350ms，实测 " + gap2 + "ms");
      assert.ok(gap3 >= 640 && gap3 < 4000, "第 3 档退避 ≈650ms，实测 " + gap3 + "ms");
      assert.ok(gap2 > gap1 && gap3 > gap2, "退避必须递增");

      // 放弃之后不得再有第 4 次 spawn（无无限循环）。
      await sleep(800);
      assert.equal(w.children.length, 4, "放弃后不得继续重启");
      assert.equal(w.events.givenUp.length, 1, "onGivenUp 只通知一次");
    });

    await suite.test("稳定运行超过 stableMs 后再崩：退避序列从头计（第 1 档）", async () => {
      const w = await newWorld();
      w.setBehaviour((child, index) => healthyNow("d-token-" + index)(child));
      await w.m.ensure({ timeoutMs: 5000 });
      await crash(w.children[0]);
      await waitFor(() => w.events.restarted.length === 1, "第 1 次自动重启", 5000);
      assert.equal(w.m.supervisionState.attempts, 1, "本轮故障已用掉 1 次重启");

      await sleep(400 + 150); // 超过 stableMs(400)，新一次崩溃应重开账
      await crash(w.children[1]);
      await waitFor(() => w.children.length === 3, "第 2 轮重启发生", 5000);
      const gap = w.spawnLog[2].ts - w.children[1].exitTs;
      assert.ok(gap >= 140 && gap < 300,
        "稳定后的崩溃必须重新用第 1 档(150ms)而不是第 2 档(350ms)，实测 " + gap + "ms");
      await waitFor(() => w.m.state === "running" && w.events.restarted.length === 2,
        "第 2 轮重启被收编", 5000);
    });

    suite.group("防双实例与外部 daemon");

    await suite.test("退避期间外部 daemon 先复活：改为复用，不 spawn，且外部死掉后绝不重启它", async () => {
      const w = await newWorld();
      w.setBehaviour((child, index) => {
        if (index === 0) healthyNow("e-token-0")(child);
      });
      await w.m.ensure({ timeoutMs: 5000 });
      await crash(w.children[0]);
      // 退避窗口内（150ms）别的实例把 daemon 拉起来了。
      currentToken = "e-external";
      await writeRuntime({ pid: process.pid, port: serverPort, token: "e-external" });

      await waitFor(() => w.events.restarted.length === 1, "onRestarted(复用外部)", 5000);
      assert.equal(w.children.length, 1, "复查发现健康 daemon 后绝不再 spawn 第二个");
      const info = w.events.restarted[0];
      assert.equal(info.owned, false, "外部实例不归我们所有");
      assert.equal(info.reused, true);
      assert.equal(info.attempt, 1);
      assert.equal(w.m.state, "external");
      assert.equal(w.m.rt.token, "e-external");

      // 外部 daemon 死掉：owned=false 的路径绝不重启。
      await writeRuntime({ pid: DEAD, port: serverPort, token: "stale" });
      await sleep(1400); // 大于全部注入退避之和(150+350+650)并留余量
      assert.equal(w.children.length, 1, "复用路径绝不重启外部 daemon");
      assert.equal(w.events.restarted.length, 1);
      assert.equal(w.events.givenUp.length, 0, "外部实例的死活不触发放弃通知");
    });

    await suite.test("启动即复用外部 daemon：外部死掉后同样绝不重启、绝不 spawn", async () => {
      const w = await newWorld();
      currentToken = "a-external";
      await writeRuntime({ pid: process.pid, port: serverPort, token: "a-external" });
      const r = await w.m.ensure({ timeoutMs: 5000 });
      assert.equal(r.reused, true);
      assert.equal(r.owned, false);
      assert.equal(w.m.child, null, "复用不得留下子进程");
      assert.equal(w.m.state, "external");

      await writeRuntime({ pid: DEAD, port: serverPort, token: "stale" });
      await sleep(1200);
      assert.equal(w.children.length, 0, "复用路径没有任何可重启的东西，也不得凭空 spawn");
      assert.equal(w.events.restarted.length, 0);
      assert.equal(w.events.givenUp.length, 0);
    });

    suite.group("与 ensure() 的互斥及初始失败");

    await suite.test("初始启动失败不进入监督：ensure() 照旧报错，不自动重启、不放弃", async () => {
      const w = await newWorld();
      w.setBehaviour(exitAfter(30));
      let message = "";
      try { await w.m.ensure({ timeoutMs: 5000 }); }
      catch (err) { message = err.message; }
      assert.match(message, /启动过程中退出/, "初始启动失败仍应给出原有的可读错误");
      await sleep(1000);
      assert.equal(w.children.length, 1, "初始失败不得触发自动重启");
      assert.equal(w.events.restarted.length, 0);
      assert.equal(w.events.givenUp.length, 0);
    });

    await suite.test("ensure() 与在途重启互斥：不并发拉起第二个，并取消挂起的退避", async () => {
      const w = await newWorld();
      w.setBehaviour((child, index) => {
        if (index === 0) healthyNow("h-token-0")(child);
        if (index === 1) exitAfter(400)(child); // 重启尝试拖一会儿再崩
        if (index === 2) healthyNow("h-token-2")(child);
      });
      await w.m.ensure({ timeoutMs: 5000 });
      await crash(w.children[0]);
      await sleep(250); // 此刻第 1 档退避(150ms)已触发，重启正在进行
      const ensured = w.m.ensure({ timeoutMs: 8000 });
      const r = await ensured;

      assert.equal(r.owned, true, "ensure 最终拿到一个 owned 实例");
      assert.equal(w.children.length, 3, "初启 1 + 失败的重启 1 + ensure 自己的 1");
      assert.ok(w.spawnLog[2].ts >= w.children[1].exitTs,
        "ensure 的 spawn 必须等在途重启的子进程退出之后（互斥，无双实例窗口）");
      assert.equal(w.m.state, "running");
      await sleep(800);
      assert.equal(w.children.length, 3, "ensure 取消挂起的退避后不得再自动拉起");
      assert.equal(w.events.restarted.length, 0);
    });

    suite.group("真实 daemon 端到端（默认 2s 退避）");

    await suite.test("真实 owned daemon 被 taskkill /F /T：2s 退避后自动复活，新 pid/新 token", async () => {
      const realHome = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b1-real-"));
      tempDirs.push(realHome);
      process.env.DOWNLOADX_HOME = realHome;

      const restarted = [];
      const m = new DaemonManager({ onRestarted: (info) => restarted.push(info) });
      managers.push(m);
      const r = await m.ensure({ timeoutMs: 30000 });
      assert.equal(r.owned, true);
      const oldRt = r.rt;
      assert.equal(isAlive(oldRt.pid), true);

      // 模拟崩溃：不给优雅停机机会，直接强杀进程树。
      await new Promise((resolve) =>
        execFile("taskkill", ["/PID", String(oldRt.pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
      await waitFor(() => !isAlive(oldRt.pid), "旧 daemon 确死", 10000);
      assert.equal(await readRuntime(), null, "强杀后残留 runtime 必须被判为陈旧");

      const newRt = await waitFor(async () => {
        const rt = await readRuntime();
        if (!rt || rt.pid === oldRt.pid) return null;
        try {
          const res = await fetch(`http://127.0.0.1:${rt.port}/api/status`, {
            headers: { "x-downloadx-token": rt.token },
          });
          if (res.status !== 200) return null;
          const data = await res.json();
          return data && data.version ? rt : null;
        } catch { return null; }
      }, "自动重启的新 daemon 就绪", 25000);
      // 管理器的收编可能比测试自己的探测晚一个轮询周期，以管理器为准再等。
      await waitFor(() => m.owned === true && m.state === "running" && restarted.length >= 1,
        "管理器把复活的 daemon 收编为 owned", 10000);

      assert.notEqual(newRt.token, oldRt.token, "新 daemon 必须签发新 token");
      assert.equal(m.owned, true, "复活后的 daemon 仍归桌面版所有");
      assert.equal(m.state, "running");
      assert.ok(restarted.length >= 1, "onRestarted 必须通知桌面壳（重载窗口/换 token 的依据）");
      assert.equal(restarted[restarted.length - 1].owned, true);

      await m.stopOwned();
      await waitFor(() => !isAlive(newRt.pid), "收尾优雅停机", 15000);
    });
  } finally {
    for (const m of managers) {
      try { await m.stopOwned(); } catch { /* best effort */ }
    }
    try { server.closeAllConnections?.(); } catch { /* older runtimes */ }
    await new Promise((r) => { server.close(() => r()); setTimeout(r, 1500); });
    if (prevHome === undefined) delete process.env.DOWNLOADX_HOME;
    else process.env.DOWNLOADX_HOME = prevHome;
    await sleep(300);
    for (const d of tempDirs) {
      await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

// 无法在本文件里自动化的进程级行为（真 Electron 壳），交付时按此人工冒烟：
//   1. 启动桌面版 → 界面正常、任务列表可见。
//   2. 任务管理器强杀 daemon 进程（ELECTRON_RUN_AS_NODE 运行 bin/downloadx.mjs
//      的那个）→ ~2s 后窗口自动整页重载恢复，“连接断开”消失，任务列表还在。
//   3. 再杀（新 pid）→ ~8s 恢复；第三次 → ~30s 恢复（退避递增）。
//   4. 连续快速杀到 3 次重启都失败 → 托盘气泡“下载服务已停止，请重启应用”，
//      任务管理器确认不再有新 daemon 进程（无自愈死循环）。
//   5. 先用 CLI 起 `downloadx daemon` 再开桌面版（复用外部）→ 杀外部 daemon
//      → 桌面版不重启它（无新进程、无气泡）。
//   6. 托盘“退出”→ 自己拉起的 daemon 一并优雅退出；复用场景外部 daemon 保留。

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch1-supervision crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
