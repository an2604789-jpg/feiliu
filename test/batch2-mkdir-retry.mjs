#!/usr/bin/env node
// 批-2 回归:mkdirWithRetry(util.mjs)——瞬时占用退避 + 失败信息带恢复指引。
//
// 背景(施工记录 附记七):一个运行中的 daemon 曾对 mkdir 稳定 EPERM,而同机新进程
// 全部成功;GUI 当时把它翻译成"没有写入权限",误导用户以为权限配置问题。
// 可瞬时复现的 EPERM 在单测里造不出来,这里验证可测的两件事:
// 1) 正常路径一次成功、目录确实创建;
// 2) 不可恢复错误(父级是文件 → ENOTDIR,非瞬时码)立即失败,且错误信息
//    带目录路径与"重启 DownloadX"恢复指引——这是用户真正要看到的差异。

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { mkdirWithRetry } = await import(new URL("../src/util.mjs", import.meta.url).href);

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("creates a nested directory that did not exist", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dx-mkdir-"));
  const target = path.join(root, "a", "b", "c");
  await mkdirWithRetry(target);
  const st = await fsp.stat(target);
  assert.ok(st.isDirectory(), "directory exists");
  await fsp.rm(root, { recursive: true, force: true });
});

test("idempotent on an existing directory", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dx-mkdir-"));
  await mkdirWithRetry(root);
  await mkdirWithRetry(root);   // must not throw
  await fsp.rm(root, { recursive: true, force: true });
});

test("non-transient failure is immediate and carries the recovery hint", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dx-mkdir-"));
  const blocker = path.join(root, "blocker");
  await fsp.writeFile(blocker, "x", "utf8");       // a FILE where a dir must go
  await assert.rejects(
    () => mkdirWithRetry(path.join(blocker, "child")),
    (err) => {
      assert.match(err.message, /重启 DownloadX/, "hint present");
      assert.match(err.message, /blocker/, "path present");
      return true;
    },
  );
  await fsp.rm(root, { recursive: true, force: true });
});

for (const [name, fn] of tests) {
  try { await fn(); console.log("  PASS ", name); }
  catch (err) { failures++; console.log("  FAIL ", name, "\n   ", (err && err.message) || err); }
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
