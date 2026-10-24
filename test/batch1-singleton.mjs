#!/usr/bin/env node
// 批-1 追加回归:daemon 数据根单实例锁(src/daemon.mjs acquireRootLock)。
//
// 背景:2026-10-24 真实事故——MCP 拉起的旧 daemon 与桌面版 daemon 共享一个数据根,
// 用户浏览器点击被旧 daemon 接走并在其内存里完成,桌面 GUI 连的另一个 daemon 永远
// 显示空列表。锁的语义:同一根上第二个 daemon 立即退出(exit 0,视作复用同伴);
// 崩溃遗留的陈旧锁由后来者打破。
//
// 1) 同一根上第二个 daemon 立即 exit 0,且不动 runtime.json,第一个仍健康;
// 2) 强杀第一个 daemon 后陈旧锁仍在,新 daemon 能打破陈旧锁正常就绪;
// 3) 优雅停机会清掉锁文件与 runtime.json。

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ENTRY = path.join(ROOT, "bin", "downloadx.mjs");

const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-singleton-"));

function startDaemon() {
  return spawn(process.execPath, [ENTRY, "daemon"], {
    env: { ...process.env, DOWNLOADX_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

// 45s:本机高负载下 daemon 就绪偶发超过 20s(批-2 附记九遗留项,断言不变,只放宽等待)。
async function waitHealthy(timeoutMs = 45000) {
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

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("second daemon on the same root stands down; first keeps serving", async () => {
  const a = startDaemon();
  const rtA = await waitHealthy();
  assert.ok(rtA, "first daemon became healthy");

  const b = startDaemon();
  const bExit = await Promise.race([
    new Promise((r) => b.once("exit", (code) => r(code))),
    new Promise((r) => setTimeout(() => r("timeout"), 15000)),
  ]);
  assert.equal(bExit, 0, "second daemon exits 0 (peer owns the root)");
  try { await fsp.access(path.join(home, "daemon.lock")); } catch {
    throw new Error("lock file missing while the holder is alive");
  }
  const rtNow = JSON.parse(await fsp.readFile(path.join(home, "runtime.json"), "utf8"));
  assert.equal(rtNow.pid, rtA.pid, "runtime.json still names the first daemon");
  const res = await fetch(`http://127.0.0.1:${rtA.port}/api/status`, {
    headers: { "x-downloadx-token": rtA.token }, signal: AbortSignal.timeout(2000),
  });
  assert.ok(res.ok, "first daemon still healthy");
  await killTree(rtA.pid);
});

test("stale lock is broken by the next starter after a crash", async () => {
  await new Promise((r) => setTimeout(r, 500));
  await fsp.access(path.join(home, "daemon.lock")); // 陈旧锁仍在(持有者被强杀)
  const c = startDaemon();
  const rtC = await waitHealthy();
  assert.ok(rtC, "third daemon broke the stale lock and became healthy");
  // 优雅停机:锁文件与 runtime.json 一并消失
  await fetch(`http://127.0.0.1:${rtC.port}/api/shutdown`, {
    method: "POST", headers: { "x-downloadx-token": rtC.token }, signal: AbortSignal.timeout(3000),
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  await assert.rejects(() => fsp.access(path.join(home, "daemon.lock")));
  await assert.rejects(() => fsp.readFile(path.join(home, "runtime.json"), "utf8"));
});

for (const [name, fn] of tests) {
  try { await fn(); console.log("  PASS ", name); }
  catch (err) { failures++; console.log("  FAIL ", name, "\n   ", (err && err.message) || err); }
}

await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
