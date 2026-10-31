#!/usr/bin/env node
// Native messaging host for the downloadx browser extension.
//
// Chrome/Edge speak a simple framing on stdio: a 4-byte little-endian length
// followed by that many bytes of UTF-8 JSON. Anything else on stdout corrupts
// the stream, so all logging goes to the daemon log file instead.
//
// The extension can ask this host to:
//   ping      -> is the daemon reachable?
//   add       -> queue a download
//   probe     -> inspect a URL (size, type, whether it is worth intercepting)
//   config    -> current settings
//   media     -> record a discovered media stream (for the grabber)

import process from "node:process";
import fsp from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile as execFileCb, spawn } from "node:child_process";

import { paths } from "../src/paths.mjs";

const MAX_MESSAGE = 32 * 1024 * 1024;
/**
 * Message protocol version. The extension sends the version it speaks so a
 * mismatch fails loudly with an actionable message instead of being
 * misinterpreted field by field.
 */
const PROTOCOL = 1;

function encode(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

function write(obj) {
  process.stdout.write(encode(obj));
}

/** Minimal logging: native hosts must not pollute stdout. */
async function logLine(message) {
  try {
    await fsp.appendFile(path.join(paths.logs, "extension.log"),
      new Date().toISOString() + " " + message + "\n");
  } catch { /* logging is best effort */ }
}

async function readRuntime() {
  try {
    const raw = JSON.parse(await fsp.readFile(paths.runtime, "utf8"));
    try { process.kill(raw.pid, 0); } catch { return null; }
    return raw;
  } catch { return null; }
}

/**
 * Task statuses that make a URL "already in progress" for dedup purposes.
 *
 * "error" is deliberately NOT live: a failed task is a legitimate reason to
 * download again, and treating it as live meant the extension could never
 * re-queue a failed URL (every retry answered duplicate:true and silently
 * did nothing). "complete" is not live for the same reason.
 */
export const LIVE_TASK_STATUSES = ["queued", "connecting", "downloading", "paused"];

/**
 * Pure part of the live-task lookup, exported for the batch-1 regression test.
 * @param {Array<{url: string, status: string}>} tasks
 * @param {string} url
 */
export function findLiveTaskIn(tasks, url) {
  const live = new Set(LIVE_TASK_STATUSES);
  return (tasks || []).find((t) => t && t.url === url && live.has(t.status)) || null;
}

/**
 * Reply for a URL that already has a live task: carries the existing task's
 * status so the extension can tell the user what is holding the URL.
 * @param {{url: string, status: string}} task
 */
export function duplicateReply(task) {
  return { ok: true, task, duplicate: true, duplicateStatus: task && task.status };
}

/**
 * Find an existing task for this URL that has not finished.
 *
 * The content script's badge and the webRequest observer can both fire for the
 * same URL, and the user can click "Get" more than once. Without this check
 * every repeat created another task and the queue filled with duplicates of one
 * download. Only live tasks count: a completed or failed task is a legitimate
 * reason to download again.
 */
async function findLiveTask(url) {
  const payload = await daemonCall("GET", "/api/tasks");
  return findLiveTaskIn(payload.tasks, url);
}

/** Queue a download, reusing a live task for the same URL when there is one. */
async function enqueue(message, { kind } = {}) {
  const duplicate = await findLiveTask(message.url);
  if (duplicate) return duplicateReply(duplicate);
  const payload = await daemonCall("POST", "/api/tasks", {
    url: message.url,
    filename: message.filename,
    referer: message.referer,
    cookies: message.cookies,
    headers: message.headers,
    kind: kind ?? message.kind,
    meta: message.meta,
    // Marks the add as extension-sourced, the way "clipboard" marks the
    // clipboard watcher. While the daemon's askBeforeAdd setting is on, these
    // adds wait in its pending list for the user to confirm (202 + pending)
    // instead of entering the queue directly; the daemon's own live-task
    // guard covers the same-URL race this host-side check can miss.
    queueId: "extension",
  });
  // askBeforeAdd: the daemon answers 202 with a pending record and no task.
  // Report the hold for what it is instead of letting the extension pretend a
  // task was created.
  if (payload.pending) {
    return { ok: true, pending: true, pendingId: payload.pending.id, duplicate: false };
  }
  return { ok: true, task: payload.task, duplicate: false };
}

async function daemonCall(method, route, body) {
  const rt = await readRuntime();
  if (!rt) {
    // The extension cannot tell "never started" from "crashed" on its own, so
    // say what the user can actually do about it.
    throw new Error("feiliu daemon is not running; start it with downloadx.cmd or `node bin/downloadx.mjs daemon`");
  }
  const headers = { "x-downloadx-token": rt.token };
  if (body) headers["content-type"] = "application/json";
  const res = await fetch("http://" + rt.host + ":" + rt.port + route, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  if (!res.ok) throw new Error(payload.error || ("HTTP " + res.status));
  return payload;
}

// ============================================================================
// focus-app 兜底拉起（批-10，用户实测痛点：通知点击没反应）
//
// 原链路：扩展 notifyTakeover 点击 → focus-app → 写 <数据根>/focus.show →
// desktop/main.mjs 每 700ms 轮询消费并拉窗。断点：GUI/桌面壳没运行时没人消费
// 这个文件，用户点了通知就石沉大海。修法：写完信号先短等待轮询它是否已被
// 消费；超时仍在即判定 desktop 未运行，从注册表/默认安装路径定位“已安装的”
// 飞流 GUI 拉起（detached + stdio ignore + --no-sandbox——本机未签名 Electron
// 必须），focus.show 原样留在盘上，留给 GUI 启动后的消费轮询接手。
// ============================================================================

/** 产品名（与 package.json build.productName 一致；NSIS 安装的 exe 名同它）。 */
export const GUI_EXE_NAME = "飞流下载器.exe";
/** 注册表 DisplayName / 安装目录名 / exe 文件名的匹配规则。 */
export const GUI_NAME_RE = /feiliu|飞流/i;

/** desktop 消费 focus.show 的最长等待与轮询步长（desktop 侧轮询周期 700ms）。 */
export const FOCUS_CONSUME_WAIT_MS = 3000;
export const FOCUS_CONSUME_POLL_MS = 250;

/**
 * 纯逻辑：%LOCALAPPDATA%\Programs 下的目录名里挑出飞流的安装目录。
 * 目录名来自 fsp.readdir（Unicode 安全，不受控制台代码页影响）。
 * @param {string[]} names
 */
export function pickInstalledGuiDir(names) {
  return (names || []).find((n) => GUI_NAME_RE.test(String(n))) || null;
}

function fileExists(p) {
  try { return !!p && fsSync.existsSync(p); } catch { return false; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function execFile(cmd, args) {
  return new Promise((resolve, reject) => {
    execFileCb(cmd, args, { encoding: "buffer", windowsHide: true }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

/**
 * reg.exe 输出的是控制台代码页（中文 Windows 为 GBK）而非 UTF-8；按 utf8 解码
 * 会把“飞流”变乱文导致永远匹配不上。优先用 GBK 解码，小 ICU 构建不支持时
 * 退回 utf8（此时退路是 LOCALAPPDATA 扫描，路径来自 readdir，不受影响）。
 */
/** 导出供回归：GBK 字节样例 → “飞流下载器” 的解码钉子（test/batch10-ui.mjs）。 */
export function decodeConsoleOutput(buf) {
  try { return new TextDecoder("gbk").decode(buf); }
  catch { return buf.toString("utf8"); }
}

/** reg query 子键枚举（输出按控制台代码页解码）。导出供诊断/探针复用。 */
export async function regQuerySubkeys(key) {
  const out = decodeConsoleOutput(await execFile("reg", ["query", key]));
  return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("HKEY_"));
}

/** reg query 单值读取；值不存在或键不可读返回 null。导出供诊断/探针复用。 */
export async function regQueryValue(key, name) {
  try {
    const out = decodeConsoleOutput(await execFile("reg", ["query", key, "/v", name]));
    const line = out.split(/\r?\n/).find((l) => l.includes(name) && l.includes("REG_"));
    if (!line) return null;
    const parts = line.trim().split(/\s{2,}/);
    return (parts[parts.length - 1] || "").trim() || null;
  } catch { return null; }   // 值不存在时 reg 退出码非 0，属正常
}

/**
 * 定位已安装的飞流 GUI exe；找不到返回 null（保持现行为）。
 * 先查 HKCU 卸载表（electron-builder NSIS 写在 per-user 键下），再兜底扫
 * %LOCALAPPDATA%\Programs。
 */
export async function locateInstalledGuiExe() {
  if (process.platform !== "win32") return null;
  const UNINSTALL = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
  try {
    for (const key of await regQuerySubkeys(UNINSTALL)) {
      const displayName = await regQueryValue(key, "DisplayName");
      if (!displayName || !GUI_NAME_RE.test(displayName)) continue;
      const loc = await regQueryValue(key, "InstallLocation");
      if (!loc) continue;
      const exe = path.join(loc, GUI_EXE_NAME);
      if (fileExists(exe)) return exe;
    }
  } catch { /* 注册表不可读就走兜底 */ }
  try {
    const programs = path.join(process.env.LOCALAPPDATA || "", "Programs");
    const dirs = await fsp.readdir(programs).catch(() => []);
    const dir = pickInstalledGuiDir(dirs);
    if (dir) {
      const exeDir = path.join(programs, dir);
      const files = await fsp.readdir(exeDir).catch(() => []);
      const exe = files.find((f) => GUI_NAME_RE.test(f) && f.toLowerCase().endsWith(".exe"));
      if (exe) {
        const full = path.join(exeDir, exe);
        if (fileExists(full)) return full;
      }
      const named = path.join(exeDir, GUI_EXE_NAME);
      if (fileExists(named)) return named;
    }
  } catch { /* 兜底也没有就放弃 */ }
  return null;
}

/**
 * focus.show 的消费等待与兜底拉起。同步等待期间 desktop 若活着，会在它自己的
 * 700ms 轮询里删掉该文件——那就算拉起成功，直接返回。超时仍在 = desktop 未
 * 运行：spawn 已安装的 GUI（detached、stdio ignore、--no-sandbox），focus.show
 * 留给新起的 GUI 消费。整个函数后台跑（不 await 在应答路径里），任何失败只记
 * 日志不外抛——原生宿主绝不能因此挂掉。
 */
async function raiseDesktopOrSpawn(focusFile) {
  try {
    const deadline = Date.now() + FOCUS_CONSUME_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(FOCUS_CONSUME_POLL_MS);
      if (!fileExists(focusFile)) return;   // desktop 已消费并拉窗，收工
    }
    await logLine("focus-app: focus.show unconsumed after " + FOCUS_CONSUME_WAIT_MS + "ms (desktop not running); trying installed GUI");
    const exe = await locateInstalledGuiExe();
    if (!exe) {
      await logLine("focus-app: installed GUI not found (non-Windows or not installed); focus.show left in place for later consumption");
      return;
    }
    const child = spawn(exe, ["--no-sandbox"], { detached: true, stdio: "ignore" });
    child.on("error", (err) => { logLine("focus-app: spawn failed: " + (err && err.message)); });
    child.unref();
    await logLine("focus-app: spawned installed GUI: " + exe);
  } catch (err) {
    try { await logLine("focus-app: fallback launch failed: " + ((err && err.message) || err)); } catch { /* best effort */ }
  }
}

async function handle(message) {
  const type = message && message.type;
  // Older/hand-rolled callers may omit the version; only reject a version that
  // is present and different, so the plain CLI-style messages keep working.
  if (message && message.protocol !== undefined && message.protocol !== PROTOCOL) {
    throw new Error("unsupported protocol version " + message.protocol +
      " (this host speaks " + PROTOCOL + "); reload the extension");
  }
  switch (type) {
    case "ping": {
      const rt = await readRuntime();
      return { ok: !!rt, daemon: rt ? { url: rt.url, running: true, pid: rt.pid } : { running: false } };
    }
    case "add": {
      if (!message.url) throw new Error("url is required");
      return await enqueue(message);
    }
    case "probe": {
      if (!message.url) throw new Error("url is required");
      return await daemonCall("POST", "/api/probe", {
        url: message.url,
        headers: message.headers,
        rules: message.rules,
      });
    }
    case "status": {
      const rt = await readRuntime();
      if (!rt) return { daemon: { running: false } };
      const payload = await daemonCall("GET", "/api/status");
      return { daemon: { running: true, url: rt.url, pid: rt.pid }, status: payload };
    }
    case "config": {
      const payload = await daemonCall("GET", "/api/config");
      return { ok: true, config: payload.config };
    }
    case "list": {
      const payload = await daemonCall("GET", "/api/tasks");
      return { ok: true, tasks: payload.tasks };
    }
    case "add-stream":
    case "media": {
      // A page told us about a media stream; queue it as a stream download.
      // No implicit "hls": a URL without an explicit kind is treated as http,
      // and the downloader detects HLS/DASH from the manifest itself. Defaulting
      // to hls sent plain files down the manifest path.
      if (!message.url) throw new Error("url is required");
      return await enqueue(message, { kind: message.kind || "http" });
    }
    case "approve-pending": {
      // The takeover notification was clicked while askBeforeAdd held the
      // add: clicking means "yes", so approve it here instead of making the
      // user find the banner in the app window.
      if (!message.id) throw new Error("id is required");
      return await daemonCall("POST", "/api/pending/" + encodeURIComponent(message.id) + "/approve", {});
    }
    case "focus-app": {
      // Signal the desktop shell to raise its window (same file-signal
      // pattern the second-instance handshake uses; no daemon route needed).
      const focusFile = path.join(paths.root, "focus.show");
      await fsp.writeFile(focusFile, String(process.pid), "utf8");
      // 断点修复（批-10）：desktop 未运行时没人消费 focus.show，点击等于白点。
      // 应答不等待——消费检测与兜底拉起后台跑（见 raiseDesktopOrSpawn）。
      void raiseDesktopOrSpawn(focusFile).catch(() => {});
      return { ok: true };
    }
    default:
      throw new Error("unknown message type: " + String(type) +
        " (expected ping, add, probe, media, list, config or status)");
  }
}

async function main() {
  let buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) break;
      const length = buffer.readUInt32LE(0);
      if (length > MAX_MESSAGE) { await logLine("oversized message: " + length); process.exit(1); }
      if (buffer.length < 4 + length) break;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      let message = null;
      try { message = JSON.parse(body.toString("utf8")); } catch { write({ ok: false, error: "invalid JSON" }); continue; }
      try {
        const result = await handle(message);
        write(Object.assign({ ok: true }, result));
      } catch (err) {
        await logLine("error: " + (err && err.message));
        write({ ok: false, error: (err && err.message) || String(err) });
      }
    }
  }
}

// Only run the stdio loop when launched as the native host (node .../host.mjs),
// not when a test imports this module for its pure exports. The browser always
// launches the .cmd shim, which runs exactly `node <full path to host.mjs>`.
const invokedAsHost =
  Array.isArray(process.argv) &&
  process.argv[1] &&
  import.meta.url.toLowerCase() ===
    pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase();

if (invokedAsHost) {
  main().catch(async (err) => { await logLine("fatal: " + (err && err.stack)); process.exit(1); });
}
