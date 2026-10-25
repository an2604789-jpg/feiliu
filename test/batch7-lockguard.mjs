#!/usr/bin/env node
// 批-7 回归:daemon.lock 的 pid 复用防护(P-19,src/daemon.mjs acquireRootLock)。
//
// 背景:锁的 pid 判定(kill(pid,0))只能证明"这个数字有主"。daemon 崩溃后其 pid
// 被操作系统复用给无关进程时,旧逻辑 alive=true 直接拒绝启动,用户必须手动删锁
// (2026-10-25 差距分析 P-19)。修复(方案 B,跨平台零依赖):锁文件结构升级为
// {pid,port,token,startedAt}——pid/startedAt 在独占创建时写入,port/token 由
// 持有者在 listen 成功后回写;后来者在 pid 判活之后再向 127.0.0.1:port 发一次
// 带锁内 token 的 GET /api/status,200 且响应携带有效 version 标识才认持有者
// 活着,否则按陈旧锁破锁接管。旧格式锁(无 port/token)降级为原 pid 判定。
//
// 用例(全部在临时 DOWNLOADX_HOME 下运行,不触碰真实数据根):
// 1) 新格式锁 + 死 pid → 破锁接管(batch1-singleton 语义在新锁结构下不回退);
// 2) pid 被活着的无关进程占用但身份探活失败 → 破锁接管(P-19 主场景:误拒解除);
// 3) 真持有者 → 后来者礼让(exit 0),锁未被破,且锁内已回写 port/token;
// 4) 旧格式锁(仅 pid/startedAt)兼容:活 pid 降级礼让,死 pid 照旧破锁。
//
// Usage: node test/batch7-lockguard.mjs

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ENTRY = path.join(ROOT, "bin", "downloadx.mjs");

/** Every temp home created during the run; removed in the finally block. */
const homes = [];

async function freshHome(tag) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-lockguard-" + tag + "-"));
  homes.push(home);
  return home;
}

function startDaemon(home) {
  return spawn(process.execPath, [ENTRY, "daemon"], {
    env: { ...process.env, DOWNLOADX_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

/** Collect a child's stdout/stderr so a stand-down message can be asserted. */
function collect(child) {
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  return () => out;
}

// 45s: same budget as batch1-singleton (ready times can exceed 20s under load).
async function waitHealthy(home, timeoutMs = 45000) {
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

/** Write a lock file by hand: this is the pre-existing holder a starter sees. */
async function writeLock(home, record) {
  await fsp.writeFile(path.join(home, "daemon.lock"), JSON.stringify(record), "utf8");
}

async function readLock(home) {
  return JSON.parse(await fsp.readFile(path.join(home, "daemon.lock"), "utf8"));
}

/** A pid that has definitely exited (the OS may recycle it later, not now). */
async function deadPid() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
  const pid = child.pid;
  await new Promise((r) => child.once("exit", r));
  // The premise of cases 1/4b: the pid really is dead. If the OS reused it in
  // this millisecond window, the case would silently degrade to the
  // probe-failure path — refuse to run it with a broken premise instead.
  try { process.kill(pid, 0); } catch { return pid; }
  throw new Error("premise broken: pid " + pid + " still alive after child exit");
}

/** A loopback port with nothing listening: the probe must fail fast on it. */
async function deadPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

async function shutdownDaemon(rt) {
  await fetch(`http://127.0.0.1:${rt.port}/api/shutdown`, {
    method: "POST",
    headers: { "x-downloadx-token": rt.token },
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
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

const children = [];
const track = (child) => { children.push(child); return child; };
const waitExit = (child, timeoutMs = 20000) => Promise.race([
  new Promise((r) => child.once("exit", (code) => r(code))),
  new Promise((r) => setTimeout(() => r("timeout"), timeoutMs)),
]);

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("new-format lock naming a dead pid is broken and taken over", async () => {
  const home = await freshHome("deadpid");
  const pid = await deadPid();
  await writeLock(home, { pid, port: await deadPort(), token: "0".repeat(48), startedAt: new Date().toISOString() });
  const daemon = track(startDaemon(home));
  const rt = await waitHealthy(home);
  assert.ok(rt, "daemon broke the dead-pid lock and became healthy");
  assert.notEqual(rt.pid, pid, "the new daemon is a different process");
  const lock = await readLock(home);
  assert.equal(lock.pid, rt.pid, "the lock now names the new holder");
  await shutdownDaemon(rt);
  await waitExit(daemon);
});

test("pid reused by an unrelated live process, probe fails: lock broken, takeover (P-19)", async () => {
  const home = await freshHome("reused");
  await writeLock(home, {
    pid: process.pid, // alive, but it is this test, not a daemon
    port: await deadPort(), // nothing answers the identity probe
    token: "0".repeat(48),
    startedAt: new Date().toISOString(),
  });
  const daemon = track(startDaemon(home));
  const rt = await waitHealthy(home);
  assert.ok(rt, "daemon must not be blocked by a reused pid; it probes, fails and takes over");
  assert.equal(daemon.exitCode, null, "the new daemon is the one serving");
  const lock = await readLock(home);
  assert.equal(lock.pid, rt.pid, "the reused-pid lock was replaced by the new holder");
  assert.equal(lock.port, rt.port, "the new holder stamped its port");
  await shutdownDaemon(rt);
  await waitExit(daemon);
});

test("a live holder is confirmed by the probe and yielded to; lock keeps its identity", async () => {
  const home = await freshHome("realholder");
  const first = track(startDaemon(home));
  const rtA = await waitHealthy(home);
  assert.ok(rtA, "first daemon became healthy");

  // The stamp written after listen() is the probe's data: without it the
  // second daemon could only fall back to the raw-pid rule.
  const lock = await readLock(home);
  assert.equal(lock.pid, rtA.pid, "lock names the running holder");
  assert.equal(lock.port, rtA.port, "holder stamped its port into the lock");
  assert.equal(lock.token, rtA.token, "holder stamped its token into the lock");

  const second = track(startDaemon(home));
  const out = collect(second);
  const code = await waitExit(second, 20000);
  assert.equal(code, 0, "second daemon stands down with exit 0 (peer owns the root)");
  assert.match(out(), /already owns this data root/, "the stand-down message names the peer");

  const lockAfter = await readLock(home);
  assert.equal(lockAfter.pid, rtA.pid, "the live holder's lock was not broken");
  const rtNow = JSON.parse(await fsp.readFile(path.join(home, "runtime.json"), "utf8"));
  assert.equal(rtNow.pid, rtA.pid, "runtime.json still names the first daemon");
  const res = await fetch(`http://127.0.0.1:${rtA.port}/api/status`, {
    headers: { "x-downloadx-token": rtA.token }, signal: AbortSignal.timeout(2000),
  });
  assert.ok(res.ok, "first daemon still healthy after being probed");
  await shutdownDaemon(rtA);
  await waitExit(first);
});

test("legacy lock (pid+startedAt only): live pid still yielded to, dead pid still broken", async () => {
  // Live unrelated pid, no credentials to probe: pre-P-19 behaviour stands.
  const homeLive = await freshHome("legacy-live");
  await writeLock(homeLive, { pid: process.pid, startedAt: new Date().toISOString() });
  const daemon = track(startDaemon(homeLive));
  const out = collect(daemon);
  const code = await waitExit(daemon, 20000);
  assert.equal(code, 0, "starter yields to a legacy lock naming a live pid");
  assert.match(out(), /already owns this data root/, "the stand-down message still points at the lock");
  assert.equal((await readLock(homeLive)).pid, process.pid, "the legacy lock was left untouched");
  await assert.rejects(() => fsp.readFile(path.join(homeLive, "runtime.json"), "utf8"),
    undefined, "no daemon may take the root from a yielded-to legacy lock");

  // Dead pid, no credentials: the stale-lock path is unchanged.
  const homeDead = await freshHome("legacy-dead");
  await writeLock(homeDead, { pid: await deadPid(), startedAt: new Date().toISOString() });
  const daemon2 = track(startDaemon(homeDead));
  const rt = await waitHealthy(homeDead);
  assert.ok(rt, "daemon broke the legacy dead-pid lock and became healthy");
  await shutdownDaemon(rt);
  await waitExit(daemon2);
});

process.on("exit", () => {
  // Belt and braces: a failed case must not leak a daemon process.
  for (const child of children) {
    if (child.exitCode === null && !child.killed) {
      try { child.kill(); } catch { /* already gone */ }
    }
  }
});

for (const [name, fn] of tests) {
  try { await fn(); console.log("  PASS ", name); }
  catch (err) { failures++; console.log("  FAIL ", name, "\n   ", (err && err.message) || err); }
}

for (const home of homes) await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
