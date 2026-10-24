#!/usr/bin/env node
// 批-4 回归：真实站点最小 fixture（yt-dlp 纪律）。
//
// 目的：对两个用户实际会碰的公开站点（bilibili.com / github.com）各取一个
// 公开页面，用 DownloadX 自己的 HTTP 客户端（src/net.mjs requestFollow，
// 与真实下载同一条代码路径）做只读 GET 断言——响应头与页面特征字段没变、
// 我们的客户端在今天仍能正常与之握手。这是"引擎对真实世界"的最小回归，
// 不是抓取器测试：不登录、不带任何凭据/Cookie、不碰媒体流（不去 m4s/HLS/
// DASH，只 GET 文档页本身）。
//
// yt-dlp 纪律（网络测试不许把 CI 打成筛子）：
//   * 只取正文前 ~64KB（读到上限即 discard 断流，不把整页拉下来）；
//   * 每站点总预算 15s（连接+响应头+前缀正文，超时视为不可达）；
//   * 网络不可达（DNS/连接/TLS/重置/超时等传输层失败）→ 整组 SKIP，
//     打印原因，退出码 0——不计失败；站点给了明确 HTTP 错误状态
//     （HttpStatusError）或特征断言不匹配 → 记 FAIL，这是 fixture 的本职。
//   * 断言刻意取最稳的特征（200 + text/html + 品牌字样），不钉布局细节。
//
// 隔离：DOWNLOADX_HOME 指向临时目录（防御性——net.mjs 本身不读数据根），
// 绝不读写 D:/IAM/downloadx-data；不启动任何带窗口的程序；进程干净退出。
//
// Usage: node test/sites/public-sites.mjs

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

// 防御性隔离：即使被引入的模块未来去读数据根，也只能落到临时目录。
const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-sites-"));
process.env.DOWNLOADX_HOME = home;

// Windows 上动态 import 绝对路径必须是 file:// URL（否则 ERR_UNSUPPORTED_ESM_URL_SCHEME）。
const { requestFollow, discard, HttpStatusError } = await import(pathToFileURL(path.join(ROOT, "src", "net.mjs")).href);

const PREFIX_BYTES = 64 * 1024;   // “只取前 ~64KB”的上限
const BUDGET_MS = 15_000;         // 每站点总预算（连接+响应头+前缀正文）

// 两个公开页的最小特征表。断言只钉最稳的字段：状态码、内容类型、品牌字样。
const SITES = [
  {
    name: "bilibili.com homepage",
    url: "https://www.bilibili.com/",
    contentTypePrefix: "text/html",
    bodyMarker: /bilibili/i,
  },
  {
    name: "github.com homepage",
    url: "https://github.com/",
    contentTypePrefix: "text/html",
    bodyMarker: /github/i,
  },
];

/**
 * 只读 GET 某站点首页，返回 { statusCode, headers, finalUrl, prefix, redirects }。
 * prefix 是正文前 ~64KB（读到上限即断流）；整个操作受 15s 总预算约束。
 * 抛出的错误按性质分两类：HttpStatusError = 网络已通、站点给了明确错误状态；
 * 其它（连接/DNS/TLS/重置/超时）= 传输层不可达。
 */
async function probeSite(site) {
  const signal = AbortSignal.timeout(BUDGET_MS);
  const res = await requestFollow(site.url, { timeoutMs: BUDGET_MS, signal });
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of res.stream) {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= PREFIX_BYTES) break;   // 拿够前缀就停，别把整页拉下来
    }
  } finally {
    await discard(res);                   // 主动断流：告诉源站别再发了
  }
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    finalUrl: res.finalUrl,
    redirects: res.redirects,
    prefix: Buffer.concat(chunks).subarray(0, PREFIX_BYTES).toString("utf8"),
  };
}

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- 先全部探测：任何一站传输层失败 → 整组 SKIP（原因写明） -----------

const probes = new Map();
let skipReason = null;
for (const site of SITES) {
  try {
    probes.set(site.name, await probeSite(site));
  } catch (err) {
    if (err instanceof HttpStatusError) {
      // 网络是通的、站点给了明确错误状态 → 这不是“不可达”，记为失败证据。
      probes.set(site.name, err);
    } else {
      skipReason = site.name + ": " + ((err && err.message) || String(err)) +
        (err && err.cause ? " (cause: " + err.cause + ")" : "");
      break;   // 传输层失败即整组跳过，后面的站点不必再试
    }
  }
}

if (skipReason) {
  process.stdout.write("  SKIP  sites group: 网络不可达(" + skipReason + ")" +
    "——按 yt-dlp 纪律整组跳过,不计失败\n");
  await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  process.stdout.write("  sites group skipped (network unreachable)\n");
  process.exit(0);
}

// ---- 网络可用：逐站点断言 ----------------------------------------------

for (const site of SITES) {
  const probe = probes.get(site.name);
  test(site.name + " answers 200 text/html over our own client", async () => {
    assert.ok(probe instanceof Error === false,
      "站点给了明确 HTTP 错误: " + ((probe && probe.message) || probe));
    assert.equal(probe.statusCode, 200,
      "expected 200, got " + probe.statusCode + " finalUrl=" + probe.finalUrl);
    const ct = String(probe.headers["content-type"] || "");
    assert.ok(ct.toLowerCase().startsWith(site.contentTypePrefix),
      "content-type 应以 " + site.contentTypePrefix + " 开头,实得: " + ct);
  });

  test(site.name + " still shows its characteristic marker in the first 64KB", async () => {
    assert.ok(probe instanceof Error === false,
      "站点给了明确 HTTP 错误: " + ((probe && probe.message) || probe));
    assert.ok(site.bodyMarker.test(probe.prefix),
      "前 64KB 未命中特征 " + site.bodyMarker + "(页面结构改版或被劫持/风控页替换?)");
  });
}

for (const [name, fn] of tests) {
  try { await fn(); process.stdout.write("  PASS  " + name + "\n"); }
  catch (err) { failures++; process.stdout.write("  FAIL  " + name + "\n   " + ((err && err.message) || err) + "\n"); }
}

await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
process.stdout.write(failures ? failures + " failed" : "all passed");
process.stdout.write("\n");
process.exit(failures ? 1 : 0);
