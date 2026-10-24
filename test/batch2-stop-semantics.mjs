#!/usr/bin/env node
// 批-2 回归 W5:stop() 停机保存语义护栏(src/queue.mjs save() 空内存守护)。
//
// 背景(施工记录附记一/二,2026-10-24):优雅停机的 saveNow 曾把磁盘上 7 条任务
// 记录的 queue.json 写成空——当时是双 daemon 各自为政,单实例锁已根治起因,但
// 护栏仍要防"任何本进程没见过的写入者":内存任务为空时,若磁盘 queue.json 非空
// 且其中的任务 id 不在本进程"已知磁盘快照"(load 过或上次成功 save 过的 id)里,
// 拒绝覆盖、日志 WARN、保留磁盘版本。用户 clearCompleted/remove 属合法清空:
// 这些 id 都在快照内,放行。
//
// 全部走真实 daemon 子进程(临时 DOWNLOADX_HOME,绝不碰生产数据根):
// 1) 正常添加→完成→优雅停机→queue.json 仍保留该任务;
// 2) 启动前外部预置非空 queue.json→daemon 不添加任何任务→停机→文件保持非空;
// 3) clearCompleted 清空已完成→停机→文件为空(合法清空,守护不得拦截、无 WARN);
// 4) 守护本体:daemon 以空库启动、运行期间外部写入非空 queue.json(模拟事故中
//    的第二个 daemon/外部写入者)→不添加任何任务→停机→拒绝覆盖,文件逐字节
//    未动(savedAt 哨兵不变),WARN 落日志,停机链完整走完(锁与 runtime 清除)。
//
// 纪律:仅 node 测试;子进程 windowsHide 无窗口;结束 taskkill 只清自己拉起的
// 子进程;测试自身 process.exit 干净退出。

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startOrigin } from "./origin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ENTRY = path.join(ROOT, "bin", "downloadx.mjs");

const SENTINEL_SAVED_AT = "2026-10-24T00:00:00.000Z"; // 证明"没写过"的时间哨兵

/** 一个 paused 任务记录,永不自动启动,load() 原样收进内存。 */
function fakeTask(id) {
  return {
    id,
    url: "http://127.0.0.1:1/never-fetched-" + id,
    filename: id + ".bin",
    dir: null,
    status: "paused",
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
}

function queueFile(ids) {
  return {
    version: 1,
    savedAt: SENTINEL_SAVED_AT,
    order: [...ids],
    tasks: ids.map(fakeTask),
  };
}

async function writeConfig(home) {
  // defaultDir 必须钉在临时根内,否则子 daemon 会把文件下到用户真实 Downloads。
  await fsp.writeFile(path.join(home, "config.json"), JSON.stringify({
    defaultDir: path.join(home, "downloads"),
    categorizeByType: false,
  }, null, 2), "utf8");
}

/** 拉起一个真实 daemon 子进程;stdout/stderr 只攒不断,留作失败诊断。 */
function startDaemon(home, diag, liveChildren) {
  const child = spawn(process.execPath, [ENTRY, "daemon"], {
    env: { ...process.env, DOWNLOADX_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  liveChildren.push(child);
  child.stdout.on("data", (d) => diag.push("[stdout] " + d));
  child.stderr.on("data", (d) => diag.push("[stderr] " + d));
  return child;
}

async function waitHealthy(home, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const rt = JSON.parse(await fsp.readFile(path.join(home, "runtime.json"), "utf8"));
      const res = await fetch(`http://127.0.0.1:${rt.port}/api/status`, {
        headers: { "x-downloadx-token": rt.token },
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return rt;
    } catch { /* not ready yet */ }
  }
  return null;
}

async function api(rt, method, route, body) {
  const headers = { "x-downloadx-token": rt.token };
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${rt.port}` + route, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function waitFor(fn, { timeoutMs = 30000, everyMs = 100, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** POST /api/shutdown 后等子进程真的退出;返回退出码或 "timeout"。 */
async function stopDaemon(child, rt, timeoutMs = 15000) {
  await api(rt, "POST", "/api/shutdown").catch(() => { /* 响应可能随连接关闭中断 */ });
  return await new Promise((resolve) => {
    const t = setTimeout(() => resolve("timeout"), timeoutMs);
    child.once("exit", (code) => { clearTimeout(t); resolve(code); });
  });
}

async function readQueue(home) {
  return JSON.parse(await fsp.readFile(path.join(home, "queue.json"), "utf8"));
}

async function readLog(home) {
  try { return await fsp.readFile(path.join(home, "logs", "downloadx.log"), "utf8"); }
  catch { return ""; }
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    } else {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      setTimeout(resolve, 300);
    }
  });
}

/** 停机链完整性:锁与 runtime 必须被优雅停机清掉(守护拒绝不得打断 stop())。 */
async function assertCleanStop(home) {
  await assert.rejects(() => fsp.access(path.join(home, "daemon.lock")),
    undefined, "daemon.lock must be removed by a graceful stop");
  await assert.rejects(() => fsp.readFile(path.join(home, "runtime.json"), "utf8"),
    undefined, "runtime.json must be removed by a graceful stop");
}

async function run() {
  let failures = 0;
  const diag = [];
  const homes = [];
  const liveChildren = [];
  const origin = await startOrigin();

  const mkHome = async (tag) => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-stop-sem-" + tag + "-"));
    homes.push(home);
    await writeConfig(home);
    return home;
  };

  const scenarios = [];

  scenarios.push(["add -> complete -> graceful stop keeps the task on disk", async () => {
    const home = await mkHome("keep");
    const child = startDaemon(home, diag, liveChildren);
    const rt = await waitHealthy(home);
    assert.ok(rt, "daemon became healthy");

    const added = await api(rt, "POST", "/api/tasks", {
      url: origin.origin + "/range/65536",
      filename: "keep-me.bin",
      dir: path.join(home, "downloads"),
    });
    assert.equal(added.status, 201, "add must answer 201: " + JSON.stringify(added.json));
    const id = added.json.task.id;

    await waitFor(async () => {
      const r = await api(rt, "GET", "/api/tasks/" + id);
      return r.json.task && r.json.task.status === "complete" ? r.json.task : false;
    }, { timeoutMs: 60000, what: "the download to complete" });

    const code = await stopDaemon(child, rt);
    assert.notEqual(code, "timeout", "daemon must exit after /api/shutdown");
    await assertCleanStop(home);

    const saved = await readQueue(home);
    assert.equal(saved.tasks.length, 1, "queue.json must keep the task, got " + saved.tasks.length);
    assert.equal(saved.tasks[0].id, id);
    assert.equal(saved.tasks[0].status, "complete");
    const log = await readLog(home);
    assert.ok(!log.includes("queue save refused"),
      "a non-empty memory save must not trip the guard");
  }]);

  scenarios.push(["preset non-empty queue.json survives a daemon that adds nothing", async () => {
    const home = await mkHome("preset");
    await fsp.writeFile(path.join(home, "queue.json"),
      JSON.stringify(queueFile(["preset-a", "preset-b"]), null, 2), "utf8");

    const child = startDaemon(home, diag, liveChildren);
    const rt = await waitHealthy(home);
    assert.ok(rt, "daemon became healthy");

    // 预置文件确实进了内存(排除"没读到文件"的假通过)。
    const q = await api(rt, "GET", "/api/queue");
    assert.equal(q.json.total, 2, "daemon must load the 2 preset tasks, got " + q.json.total);

    const code = await stopDaemon(child, rt);
    assert.notEqual(code, "timeout", "daemon must exit after /api/shutdown");
    await assertCleanStop(home);

    const saved = await readQueue(home);
    assert.equal(saved.tasks.length, 2,
      "stop must not shrink the loaded queue, got " + saved.tasks.length);
    const ids = saved.tasks.map((t) => t.id).sort();
    assert.deepEqual(ids, ["preset-a", "preset-b"]);
  }]);

  scenarios.push(["clearCompleted then stop saves an empty file (legitimate clear)", async () => {
    const home = await mkHome("clear");
    const child = startDaemon(home, diag, liveChildren);
    const rt = await waitHealthy(home);
    assert.ok(rt, "daemon became healthy");

    const added = await api(rt, "POST", "/api/tasks", {
      url: origin.origin + "/range/65536",
      filename: "clear-me.bin",
      dir: path.join(home, "downloads"),
    });
    assert.equal(added.status, 201);
    const id = added.json.task.id;
    await waitFor(async () => {
      const r = await api(rt, "GET", "/api/tasks/" + id);
      return r.json.task && r.json.task.status === "complete";
    }, { timeoutMs: 60000, what: "the download to complete" });

    const cleared = await api(rt, "POST", "/api/queue/clear-completed");
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.removed, 1, "clearCompleted must remove the finished task");

    const code = await stopDaemon(child, rt);
    assert.notEqual(code, "timeout", "daemon must exit after /api/shutdown");
    await assertCleanStop(home);

    const saved = await readQueue(home);
    assert.equal(saved.tasks.length, 0,
      "a user-driven clear must persist as an empty queue, got " + saved.tasks.length);
    const log = await readLog(home);
    assert.ok(!log.includes("queue save refused"),
      "the guard must not fire on a legitimate clearCompleted");
  }]);

  scenarios.push(["guard: external non-empty queue written mid-run is never clobbered at stop", async () => {
    const home = await mkHome("guard");
    const child = startDaemon(home, diag, liveChildren);
    const rt = await waitHealthy(home);
    assert.ok(rt, "daemon became healthy (empty home)");

    // 本进程从未见过的写入者(事故形态:第二个 daemon / 外部恢复)。
    const external = queueFile(["ext-1", "ext-2"]);
    await fsp.writeFile(path.join(home, "queue.json"),
      JSON.stringify(external, null, 2), "utf8");

    const q = await api(rt, "GET", "/api/queue");
    assert.equal(q.json.total, 0, "daemon memory stays empty (it never re-reads the file)");

    const code = await stopDaemon(child, rt);
    assert.notEqual(code, "timeout", "daemon must exit after /api/shutdown");
    await assertCleanStop(home);

    const saved = await readQueue(home);
    assert.equal(saved.savedAt, SENTINEL_SAVED_AT,
      "the disk copy must be untouched (sentinel savedAt was rewritten)");
    assert.deepEqual(saved.tasks, external.tasks,
      "the external task records must survive the stop");
    // 拒绝路径不写 tmp:不得留下半成品。
    await assert.rejects(() => fsp.access(path.join(home, "queue.json.tmp")),
      undefined, "a refused save must not leave a .tmp behind");

    const log = await readLog(home);
    assert.ok(/\[WARN\] queue save refused: memory holds no tasks but queue\.json holds 2/.test(log),
      "the refusal must be logged as WARN, log was:\n" + log);
  }]);

  try {
    for (const [name, fn] of scenarios) {
      try {
        await fn();
        console.log("  PASS ", name);
      } catch (err) {
        failures++;
        console.log("  FAIL ", name, "\n   ", (err && err.message) || err);
        const recent = diag.slice(-20).join("");
        if (recent.trim()) {
          console.log("    daemon tail:\n" +
            recent.split(/\r?\n/).map((l) => "      " + l).join("\n"));
        }
      }
    }
  } finally {
    for (const c of liveChildren) {
      if (c.exitCode === null && !c.killed) await killTree(c.pid);
    }
    await new Promise((r) => {
      try { origin.server.closeAllConnections?.(); } catch { /* none */ }
      origin.close().then(r);
      setTimeout(r, 1500);
    });
    for (const home of homes) await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  return failures;
}

run()
  .then((failures) => {
    console.log(failures ? `${failures} failed` : "all passed");
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error("batch2-stop-semantics crashed:", (err && err.stack) || err);
    process.exit(1);
  });
