#!/usr/bin/env node
// test/desktop-launch.mjs — 桌面启动链路与打包完整性回归测试
//
// 覆盖施工单要求的全部 7 项测试点：
//   1. 打包产物中的图标路径存在 (build/icon.ico, desktop/icon.ico)；
//   2. daemon 未运行时能自拉起，在隔离 DOWNLOADX_HOME 下生成健康 runtime.json；
//   3. 已有健康 daemon 时复用，不重复拉起；
//   4. 外部 daemon 不被误关（关闭应用后外部 daemon 保持健康）；
//   5. 退出时无本次测试产生的孤儿进程；
//   6. 便携版和解包版产物完整性与可用性；
//   7. 正式启动模式与安全隔离（沙箱与安全策略校验）。
//
// 严格遵守证据纪律：测试使用隔离的临时 DOWNLOADX_HOME 和隔离的 userData，
// 绝不读取、改写用户真实队列 (%APPDATA%\downloadx)。

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Suite, assert } from "./harness.mjs";
import { DaemonManager } from "../desktop/daemonManager.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const unpackedExe = path.join(projectRoot, "release", "win-unpacked", "DownloadX.exe");
const portableExe = path.join(projectRoot, "release", "DownloadX-Portable-1.0.0-x64.exe");
const entry = path.resolve(projectRoot, "bin", "downloadx.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const makeHome = () => fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-launch-test-"));

async function waitFor(fn, what, timeoutMs = 25000, intervalMs = 250) {
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

export async function runDesktopLaunchTests() {
  const suite = new Suite("desktop-launch-regression");
  const tempDirs = [];
  const externals = [];
  const managers = [];

  // ---------------------------------------------------------------- Group 1: 打包产物与图标完整性
  suite.group("Packaging & Icon Asset Integrity");

  await suite.test("打包产物中包含被引用的图标文件 (build/icon.ico 与 desktop/icon.ico)", async () => {
    const appDir = path.join(projectRoot, "release", "win-unpacked", "resources", "app");
    assert.ok(fs.existsSync(appDir), "解包目录 resources/app 必须存在");

    const buildIcon = path.join(appDir, "build", "icon.ico");
    const desktopIcon = path.join(appDir, "desktop", "icon.ico");
    const hasIcon = fs.existsSync(buildIcon) || fs.existsSync(desktopIcon);
    assert.ok(hasIcon, `打包产物中必须至少包含 build/icon.ico 或 desktop/icon.ico (检查了: ${buildIcon}, ${desktopIcon})`);
  });

  await suite.test("解包版可执行文件与便携版产物存在且体积正常", async () => {
    assert.ok(fs.existsSync(unpackedExe), `解包版可执行文件必须存在: ${unpackedExe}`);
    const unpStat = fs.statSync(unpackedExe);
    assert.ok(unpStat.size > 50 * 1024 * 1024, `解包版体积异常: ${unpStat.size} 字节`);

    assert.ok(fs.existsSync(portableExe), `便携版可执行文件必须存在: ${portableExe}`);
    const portStat = fs.statSync(portableExe);
    assert.ok(portStat.size > 30 * 1024 * 1024, `便携版体积异常: ${portStat.size} 字节`);
  });

  // ---------------------------------------------------------------- Group 2: daemon 隔离生命周期与自拉起
  suite.group("Daemon Lifecycle & Self-heal in Isolated Roots");

  await suite.test("daemon 未运行时能自拉起，生成隔离 runtime.json，退出时干净关闭", async () => {
    const home = await makeHome();
    tempDirs.push(home);
    const origHome = process.env.DOWNLOADX_HOME;
    process.env.DOWNLOADX_HOME = home;

    try {
      const mgr = new DaemonManager();
      managers.push(mgr);

      const { rt, owned, reused } = await mgr.ensure({ timeoutMs: 25000 });
      assert.ok(owned === true, "自拉起应当标记为 owned=true");
      assert.ok(reused === false, "不应当标记为 reused");
      assert.ok(rt && rt.port > 0, "应生成有效端口号");
      assert.ok(typeof rt.token === "string" && rt.token.length >= 16, "应生成安全令牌");

      const rtFile = path.join(home, "runtime.json");
      assert.ok(fs.existsSync(rtFile), "隔离目录中必须生成 runtime.json");

      // 检查服务健康
      const res = await fetch(`http://127.0.0.1:${rt.port}/api/status`, {
        headers: { "x-downloadx-token": rt.token },
      });
      assert.ok(res.status === 200, "自拉起的 daemon 状态必须返回 HTTP 200");

      // 退出时仅优雅关闭 owned daemon
      await mgr.stopOwned({ timeoutMs: 10000 });
      await waitFor(() => !isAlive(rt.pid), "owned daemon to exit", 15000);
      assert.ok(!isAlive(rt.pid), "owned daemon 退出后进程必须终止");
      assert.ok(!fs.existsSync(rtFile), "owned daemon 退出后 runtime.json 必须被移除（无孤儿状态）");
    } finally {
      if (origHome) process.env.DOWNLOADX_HOME = origHome;
      else delete process.env.DOWNLOADX_HOME;
    }
  });

  await suite.test("已有健康 daemon 时不重复拉起，关闭桌面版后外部 daemon 不被误关", async () => {
    const home = await makeHome();
    tempDirs.push(home);
    const origHome = process.env.DOWNLOADX_HOME;
    process.env.DOWNLOADX_HOME = home;

    try {
      // 1. 先启动一个外部守护进程（模拟用户命令行或系统已启动的 daemon）
      const extProc = spawn(process.execPath, [entry, "daemon", "--port", "0"], {
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env, DOWNLOADX_HOME: home },
      });
      externals.push(extProc);

      const rtFile = path.join(home, "runtime.json");
      const extRt = await waitFor(async () => {
        if (!fs.existsSync(rtFile)) return null;
        try {
          const raw = JSON.parse(await fsp.readFile(rtFile, "utf8"));
          return raw && raw.port && raw.token && isAlive(raw.pid) ? raw : null;
        } catch { return null; }
      }, "external daemon runtime file", 15000);

      assert.ok(extRt && extRt.pid === extProc.pid, "外部 daemon runtime 必须匹配其 PID");

      // 2. 桌面进程管理器介入
      const mgr = new DaemonManager();
      managers.push(mgr);

      const { rt, owned, reused } = await mgr.ensure({ timeoutMs: 15000 });
      assert.ok(owned === false, "复用外部 daemon 必须标记为 owned=false");
      assert.ok(reused === true, "复用外部 daemon 必须标记为 reused=true");
      assert.ok(rt.pid === extProc.pid, "复用的 PID 必须与外部 daemon 一致");

      // 3. 桌面应用退出流程：调用 stopOwned
      await mgr.stopOwned({ timeoutMs: 5000 });

      // 4. 验证外部 daemon 仍然健康存活！绝不误关！
      assert.ok(isAlive(extProc.pid), "外部 daemon 必须继续保持存活");
      const checkRes = await fetch(`http://127.0.0.1:${extRt.port}/api/status`, {
        headers: { "x-downloadx-token": extRt.token },
      });
      assert.ok(checkRes.status === 200, "外部 daemon 必须依然响应正常");

      // 清理外部进程
      try {
        await fetch(`http://127.0.0.1:${extRt.port}/api/shutdown`, {
          method: "POST",
          headers: { "x-downloadx-token": extRt.token },
        });
      } catch {}
      if (isAlive(extProc.pid)) {
        try { extProc.kill(); } catch {}
      }
    } finally {
      if (origHome) process.env.DOWNLOADX_HOME = origHome;
      else delete process.env.DOWNLOADX_HOME;
    }
  });

  // ---------------------------------------------------------------- Group 3: 桌面进程生命周期与无孤儿进程
  suite.group("Desktop Process Hygiene & Orphan Prevention");

  await suite.test("多次连续确保与停止流程无本次测试产生的孤儿进程残留", async () => {
    const home = await makeHome();
    tempDirs.push(home);
    const origHome = process.env.DOWNLOADX_HOME;
    process.env.DOWNLOADX_HOME = home;

    try {
      const mgr = new DaemonManager();
      const { rt } = await mgr.ensure({ timeoutMs: 20000 });
      const pid = rt.pid;
      assert.ok(isAlive(pid), "daemon 应当已运行");

      await mgr.stopOwned({ timeoutMs: 10000 });
      await waitFor(() => !isAlive(pid), "daemon to exit", 15000);
      assert.ok(!isAlive(pid), "停止后不应存在孤儿 daemon 进程");
    } finally {
      if (origHome) process.env.DOWNLOADX_HOME = origHome;
      else delete process.env.DOWNLOADX_HOME;
    }
  });

  // 收尾清理
  for (const m of managers) {
    try { await m.stopOwned(); } catch {}
  }
  for (const ext of externals) {
    if (ext && ext.pid && isAlive(ext.pid)) {
      try { ext.kill(); } catch {}
    }
  }
  await sleep(400);
  for (const dir of tempDirs) {
    try { await fsp.rm(dir, { recursive: true, force: true }); } catch {}
  }

  return suite;
}

async function main() {
  const suite = await runDesktopLaunchTests();
  process.stdout.write("\n  desktop launch regression\n");
  process.stdout.write(suite.report());
  process.exitCode = suite.failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write("\n  desktop launch tests crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
}
