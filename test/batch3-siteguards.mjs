#!/usr/bin/env node
// 批-4 回归：GPP（游戏加加）崩溃守卫（desktop/main.mjs）。
//
// desktop/main.mjs 顶层 import electron，普通 node 无法整体加载；守卫的纯
// 逻辑在文件里用标记对 // [gpp-guard-pure] begin/end 圈出。本测试从真实
// 发布文件里抠出这一段求值——测的就是 ship 的那段代码，不是复制品；标记
// 被挪走/删掉时提取失败，测试自身就会 FAIL。
//
// 覆盖：
//   1) 提取成功：标记对存在，段内可求值出 gppHit/gppAdvisory/两段文案；
//   2) 检出：P-4 的两个真实签名（事件日志 GPP64.dll+0x9e956、stderr
//      GAMEPP-IPC-OVERLAY）都命中；object 信号走 JSON 序列化路径同样命中；
//      大小写不敏感；
//   3) 不误报：普通 JS 异常 + 干净报告 + 近似词（gamepad）不命中；
//   4) 文案：命中 → 确定性指引原文（含“待修问题清单 P-4”）；未命中 →
//      常驻冲突源提示（同样指向 P-4，兜住“检测不到”的假阴性）；
//      render-process-gone 的 details 形状两种走向都不抛异常；
//   5) 真实报告路径：gppAdvisory(plain) 现场取 process.report 也不抛异常，
//      返回必为两段文案之一（本机是否检出不钉死——宿主相关的只验不炸）；
//   6) 接线（源码级断言）：uncaughtException 与 render-process-gone 两个
//      dialog.showErrorBox 调用体内都拼了 gppAdvisory(...)。
//
// 隔离：无数据根依赖、无网络、不启动任何进程；进程干净退出。
//
// Usage: node test/batch3-siteguards.mjs

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const MAIN_SRC = await fsp.readFile(path.join(ROOT, "desktop", "main.mjs"), "utf8");

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- 1) 从真实文件抠出纯逻辑段并求值 -----------------------------------

const blockMatch = MAIN_SRC.match(/\/\/ \[gpp-guard-pure\] begin[^\n]*\r?\n([\s\S]*?)\/\/ \[gpp-guard-pure\] end/);

/** 求值后的守卫对象；block 为 null 时保持 null，由测试 1 报 FAIL。 */
const guard = blockMatch
  ? new Function(
    blockMatch[1] +
    "\nreturn { gppHit, gppAdvisory, GPP_ADVISORY_DETECTED, GPP_ADVISORY_HINT };",
  )()
  : null;

test("marked pure block exists in desktop/main.mjs and evaluates", async () => {
  assert.ok(blockMatch, "desktop/main.mjs 里找不到 [gpp-guard-pure] 标记对");
  assert.ok(guard, "标记段求值失败");
  assert.equal(typeof guard.gppHit, "function");
  assert.equal(typeof guard.gppAdvisory, "function");
  assert.equal(typeof guard.GPP_ADVISORY_DETECTED, "string");
  assert.equal(typeof guard.GPP_ADVISORY_HINT, "string");
});

if (guard) {
  const CLEAN_REPORT = { env: { PATH: "C:\\Windows;C:\\Program Files\\gamepad" }, nativeStack: [] };

  test("detects the P-4 event-log signature GPP64.dll+offset", async () => {
    assert.equal(guard.gppHit("出错模块: GPP64.dll+0x9e956, 异常代码 0xc0000005"), true);
    assert.equal(guard.gppHit("aborted at gpp64.dll+0x1"), true, "大小写不敏感");
  });

  test("detects the P-4 stderr signature GAMEPP-IPC-OVERLAY", async () => {
    assert.equal(guard.gppHit("stderr: GAMEPP-IPC-OVERLAY initialize failed"), true);
    assert.equal(guard.gppHit(new Error("init failed in GamePP overlay")), true, "Error 走堆栈/消息路径");
  });

  test("object signals go through JSON and still hit", async () => {
    assert.equal(guard.gppHit({ nativeStack: [{ symbol: "GPP64.dll+0x9e956" }] }), true);
    assert.equal(guard.gppAdvisory({ reason: "crashed" }, { env: {}, nativeStack: [{ symbol: "GPP64.dll+0x9e956" }] }),
      guard.GPP_ADVISORY_DETECTED, "report 里带模块帧时报确定性文案");
  });

  test("no false positive on ordinary errors / near words", async () => {
    assert.equal(guard.gppHit(new RangeError("Maximum call stack size exceeded"), CLEAN_REPORT), false);
    assert.equal(guard.gppHit("ordinary crash without injection", CLEAN_REPORT), false);
    assert.equal(guard.gppHit(null, undefined, 42, CLEAN_REPORT), false, "null/数字信号不炸也不误报");
  });

  test("advisory texts: hit => verbatim guidance, miss => standing hint, both cite P-4", async () => {
    assert.equal(guard.GPP_ADVISORY_DETECTED,
      "检测到游戏加加(GamePP)注入,已知会导致崩溃;请退出游戏加加后重启本应用(详见 待修问题清单 P-4)");
    assert.ok(guard.GPP_ADVISORY_DETECTED.includes("待修问题清单 P-4"));
    assert.ok(guard.GPP_ADVISORY_HINT.includes("游戏加加"), "常驻提示必须点名常见冲突源");
    assert.ok(guard.GPP_ADVISORY_HINT.includes("待修问题清单 P-4"), "常驻提示同样指向 P-4");
    assert.equal(guard.gppAdvisory(new Error("aborted at GPP64.dll+0x9e956"), CLEAN_REPORT),
      guard.GPP_ADVISORY_DETECTED);
    assert.equal(guard.gppAdvisory({ reason: "oom", exitCode: 5 }, CLEAN_REPORT),
      guard.GPP_ADVISORY_HINT, "render-process-gone details 形状:未检出走常驻提示");
  });

  test("live report path never throws and returns one of the two texts", async () => {
    const out = guard.gppAdvisory(new Error("plain failure"));
    assert.ok(out === guard.GPP_ADVISORY_DETECTED || out === guard.GPP_ADVISORY_HINT,
      "真实 process.report 路径应返回两段文案之一,实得: " + out);
    assert.equal(guard.gppAdvisory("x", "not-a-report-object"), guard.GPP_ADVISORY_HINT,
      "报告形状异常时按未检出处理、不抛");
  });
}

// ---- 6) 接线：两个崩溃对话框都要拼上附注（源码级断言） -------------------

test("uncaughtException dialog appends gppAdvisory (source-level)", async () => {
  // 2026-10-25 起展示层更名为"飞流下载器"(desktop/main.mjs 对话框标题随更名)，
  // 断言随标题更新；gppAdvisory 必须仍在 showErrorBox 调用体内。
  const re = /dialog\.showErrorBox\(\s*"飞流下载器 未捕获异常"[\s\S]{0,400}?gppAdvisory\(/;
  assert.ok(re.test(MAIN_SRC),
    "uncaughtException 的 showErrorBox 调用体内未见 gppAdvisory(...)");
});

test("render-process-gone dialog appends gppAdvisory (source-level)", async () => {
  const re = /dialog\.showErrorBox\(\s*\n?\s*"飞流下载器 渲染进程异常"[\s\S]{0,600}?gppAdvisory\(/;
  assert.ok(re.test(MAIN_SRC),
    "render-process-gone 的 showErrorBox 调用体内未见 gppAdvisory(...)");
});

for (const [name, fn] of tests) {
  try { await fn(); process.stdout.write("  PASS  " + name + "\n"); }
  catch (err) { failures++; process.stdout.write("  FAIL  " + name + "\n   " + ((err && err.message) || err) + "\n"); }
}

process.stdout.write(failures ? failures + " failed\n" : "all passed\n");
process.exit(failures ? 1 : 0);
