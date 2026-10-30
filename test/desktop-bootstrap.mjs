#!/usr/bin/env node
// 回归（2026-10-31，v1.2.0 之后）：ELECTRON_RUN_AS_NODE 引导守卫。
//
// 背景：某些宿主（IDE、别的 Electron 应用的子进程调用、CI shell）会把自己
// 的 ELECTRON_RUN_AS_NODE=1 传给子进程。electron.exe 见到它就以纯 Node 身份
// 运行，desktop/main.mjs 在第一条 import 上就死：
//   SyntaxError: The requested module 'electron' does not provide an export
//   named 'BrowserWindow'
// 用户看到的是"窗口永远不出现"。2026-10-31 在本机 agent shell 里复现（同一
// 会话里 electron.exe --version 返回 v24.22.0 而不是 45.0.0）。
//
// main.mjs 自己救不了自己——静态 import 先于任何语句求值，所以守卫前移到
// desktop/bootstrap.cjs（package.json 的 main）。本套件锁三件事：
//   1) 决策：何时 relaunch、何时不动（含防循环标记），且不污染入参 env；
//   2) 接线：package.json main 指向 bootstrap，bootstrap 委托 ./main.mjs，
//      且自己绝不 import electron（否则同样死于那个 import）；
//   3) 真实进程：带变量跑一次，确认计划真的把变量剔除；带变量+标记跑到底，
//      确认它走委托分支并留痕（不猜、不留白屏）。
//
// 隔离：临时 DOWNLOADX_HOME，不起 GUI、不起 daemon、不联网；进程干净退出。
//
// Usage: node test/desktop-bootstrap.mjs

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const requireHere = createRequire(import.meta.url);

const bootstrapPath = path.join(ROOT, "desktop", "bootstrap.cjs");
const BOOTSTRAP_SRC = await fsp.readFile(bootstrapPath, "utf8");
const PKG = JSON.parse(await fsp.readFile(path.join(ROOT, "package.json"), "utf8"));
const { planRelaunch, GUARD_VAR, MARKER_VAR } = requireHere(bootstrapPath);

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const run = (args, env) => new Promise((resolve) => {
  execFile(process.execPath, args, { cwd: ROOT, env, timeout: 60000, windowsHide: true },
    (err, stdout, stderr) => resolve({ code: err && typeof err.code === "number" ? err.code : (err ? 1 : 0), stdout, stderr }));
});

// ---------------------------------------------------------------------------
// 1) 决策：planRelaunch 是纯函数，测的就是 ship 的那一个
// ---------------------------------------------------------------------------

test("变量缺失：不 relaunch（正常启动路径）", () => {
  assert.equal(planRelaunch({}, "C:/e/electron.exe", ["e", "app"]), null);
  assert.equal(planRelaunch({ DOWNLOADX_HOME: "x" }, "C:/e/electron.exe", ["e", "app"]), null);
});

test("变量为空串：不 relaunch（cmd 'set VAR=' 的形态，Electron 当作未设）", () => {
  assert.equal(planRelaunch({ [GUARD_VAR]: "" }, "C:/e/electron.exe", ["e", "app"]), null);
});

test("变量存在：剔除该变量并带防循环标记，参数原样下传", () => {
  const plan = planRelaunch({ [GUARD_VAR]: "1", KEEP: "yes" }, "C:/e/electron.exe", ["e", "app", "--flag"]);
  assert.ok(plan, "应当计划一次 relaunch");
  assert.equal(plan.command, "C:/e/electron.exe");
  assert.deepEqual(plan.args, ["app", "--flag"]);
  assert.equal(Object.prototype.hasOwnProperty.call(plan.options.env, GUARD_VAR), false,
    "变量必须被删除，不能只是置空");
  assert.equal(plan.options.env[MARKER_VAR], "1");
  assert.equal(plan.options.env.KEEP, "yes", "无关变量必须原样保留");
  assert.equal(plan.options.detached, true);
  assert.equal(plan.options.stdio, "ignore");
});

test("已带标记：不再 relaunch（同一个环境绝不会无限弹窗口）", () => {
  assert.equal(planRelaunch({ [GUARD_VAR]: "1", [MARKER_VAR]: "1" }, "C:/e/electron.exe", ["e", "app"]), null);
});

test("纯函数：不改写入参 env", () => {
  const env = { [GUARD_VAR]: "1" };
  planRelaunch(env, "C:/e/electron.exe", ["e", "app"]);
  assert.equal(env[GUARD_VAR], "1", "入参 env 被就地修改了");
  assert.equal(env[MARKER_VAR], undefined);
});

// ---------------------------------------------------------------------------
// 2) 接线：ship 的入口链路
// ---------------------------------------------------------------------------

test("package.json main 指向 desktop/bootstrap.cjs", () => {
  assert.equal(PKG.main, "desktop/bootstrap.cjs",
    "main 必须指向守卫，否则 Electron 依然直接加载 main.mjs");
});

test("bootstrap 把工作交给 ./main.mjs（ESM 动态 import）", () => {
  assert.match(BOOTSTRAP_SRC, /import\("\.\/main\.mjs"\)/, "找不到对 ./main.mjs 的委托");
});

test("bootstrap 自己绝不 import/require electron（同一个坑不能再踩一次）", () => {
  const lines = BOOTSTRAP_SRC.split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .filter((l) => /require\(|^\s*import\s/.test(l));
  const offenders = lines.filter((l) => /["']electron["']/.test(l));
  assert.deepEqual(offenders, [], "bootstrap 里出现了 electron 的导入：" + offenders.join(" | "));
});

// ---------------------------------------------------------------------------
// 3) 真实进程：带变量跑，计划真的把变量剔了
// ---------------------------------------------------------------------------

test("真实进程：子进程继承 ELECTRON_RUN_AS_NODE=1 时，计划里已无该变量", async () => {
  const script = 'const p=require(' + JSON.stringify(bootstrapPath) + ').planRelaunch(process.env,"C:/fake/electron.exe",["electron.exe","app"]);' +
    'process.stdout.write(JSON.stringify(p));';
  const env = { ...process.env, [GUARD_VAR]: "1" };
  delete env[MARKER_VAR];
  const r = await run(["-e", script], env);
  assert.equal(r.code, 0, "子进程失败：" + r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.ok(plan, "子进程里没有计划 relaunch");
  assert.equal(plan.command, "C:/fake/electron.exe");
  assert.equal(Object.prototype.hasOwnProperty.call(plan.options.env, GUARD_VAR), false);
  assert.equal(plan.options.env[MARKER_VAR], "1");
});

test("真实进程：带变量+标记跑到底 → 走委托分支并留痕，不静默白屏", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-bootstrap-"));
  const env = { ...process.env, DOWNLOADX_HOME: home, [GUARD_VAR]: "1", [MARKER_VAR]: "1" };
  const r = await run([bootstrapPath], env);
  assert.equal(r.code, 1, "普通 node 里 main.mjs 必然加载失败（electron 模块不存在），退出码应为 1");
  const log = await fsp.readFile(path.join(home, "logs", "desktop-launch.log"), "utf8").catch(() => "");
  assert.match(log, /bootstrap: main\.mjs failed to load/, "没有把启动失败写进 desktop-launch.log：" + JSON.stringify(log));
  await fsp.rm(home, { recursive: true, force: true });
});

for (const [name, fn] of tests) {
  try { await fn(); process.stdout.write("  PASS  " + name + "\n"); }
  catch (err) { failures++; process.stdout.write("  FAIL  " + name + "\n   " + ((err && err.message) || err) + "\n"); }
}

process.stdout.write(failures ? failures + " failed\n" : "all passed\n");
process.exit(failures ? 1 : 0);
