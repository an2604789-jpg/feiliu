// tray-feed.mjs — 桌面托盘反馈的纯逻辑层（包6）。
//
// 这里放的是"可以被 node 直接单测"的部分：SSE 帧解析、任务事件分类、
// 最近完成列表、限速切换决策、托盘菜单模板、托盘状态落盘。
// 主进程 main.mjs 负责所有 Electron 侧接线（Tray、displayBalloon、shell），
// 本文件刻意不 import electron —— main.mjs 顶部有 app.commandLine 等启动
// 副作用，无法在普通 node 进程里加载，测试只能通过本模块覆盖纯逻辑。
// 零运行时依赖，仅 node 内置模块。

import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------- SSE 解析

/**
 * 增量 SSE 解析器：把任意切分的文本块喂给 push()，完整帧以回调送出。
 *
 * 协议面（src/api.mjs /api/events）：
 *   - 每帧形如 `data: {"type":..., "payload":..., "at":...}\n\n`；
 *   - 连接建立即发一帧 `{"type":"hello"}`（无 payload 字段）；
 *   - 每 20s 一条注释行 `: ping` 保活，必须忽略；
 *   - 断流由调用方负责重连。
 *
 * 帧可以跨 chunk 到达；一个 chunk 也可以携带多帧。JSON 解析失败或
 * 缺少字符串 type 的帧一律丢弃（不抛出——事件流坏了也不能砸掉主进程）。
 *
 * @param {(evt:{type:string, payload?:any, at?:number}) => void} onEvent
 * @returns {{ push(chunk:string): object, flush(): void }}
 */
export function createSseParser(onEvent) {
  let buf = "";

  const emit = (block) => {
    // 一个帧里允许多行 data:（SSE 规范用 \n 连接）；注释行与其余字段跳过。
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;               // keep-alive 注释
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) return;
    let evt;
    try { evt = JSON.parse(data.join("\n")); } catch { return; }  // 坏帧丢弃
    if (!evt || typeof evt !== "object" || typeof evt.type !== "string") return;
    onEvent(evt);
  };

  return {
    /** 喂入一块（可能任意小、任意切分）文本；返回自身便于链式调用。 */
    push(chunk) {
      buf += chunk;
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf);   // 空行 = 帧结束（CRLF 与 LF 都认）
        if (!m) break;
        emit(buf.slice(0, m.index));
        buf = buf.slice(m.index + m[0].length);
      }
      return this;
    },
    /** 流结束时把残留的不完整块按一帧尽力解析（daemon 总以空行收尾，此为兜底）。 */
    flush() {
      const rest = buf;
      buf = "";
      if (rest.trim()) emit(rest);
    },
  };
}

// ---------------------------------------------------------------- 事件分类

/**
 * 把一条 SSE 事件分类为"需要打扰用户"的完成/失败，其余返回 null。
 *
 * 只认 `updated` 事件（队列状态跃迁走 queue.update/setStatus 的 emit，
 * payload 是 taskView：含 id/status/filename/dir/error）。去重规则：
 *   - 同一任务重复推来的同状态帧不触发（progress 每 300ms 一条 updated，
 *     完成后的无关 PATCH 也会再推 complete 帧）；
 *   - 首次见到的任务若直接就是 complete/error，不触发——那是订阅建立前
 *     的历史结果，不该在启动瞬间轰炸用户。
 * seen 由调用方持有（Map<taskId, 上次状态>），跨重连保留。
 *
 * @param {{type:string, payload?:any}} evt
 * @param {Map<string,string>} seen
 * @returns {{kind:"complete"|"error", task:object}|null}
 */
export function classifyTaskEvent(evt, seen) {
  if (!evt || evt.type !== "updated") return null;
  const task = evt.payload;
  if (!task || typeof task.id !== "string" || task.id === "" ||
      typeof task.status !== "string") return null;
  if (!seen.has(task.id)) {
    seen.set(task.id, task.status);
    return null;
  }
  const prev = seen.get(task.id);
  seen.set(task.id, task.status);
  if (prev === task.status) return null;
  if (task.status === "complete") return { kind: "complete", task };
  if (task.status === "error") return { kind: "error", task };
  return null;
}

// ---------------------------------------------------------------- 最近完成

/** 托盘"最近完成"保留条数（规格：3 条）。 */
export const RECENT_MAX = 3;

/**
 * 把一条完成记录插到队首（同 id 去重），最多保留 max 条。不改动入参。
 * entry 形如 { id, filename, dir }——dir+filename 是气泡/菜单点击时
 * daemon 不可达的兜底路径，权威路径点击时再问 /api/tasks/:id/location。
 */
export function pushRecent(list, entry, max = RECENT_MAX) {
  if (!entry || typeof entry.id !== "string") {
    return Array.isArray(list) ? list.slice(0, max) : [];
  }
  const rest = (Array.isArray(list) ? list : []).filter((x) => x && x.id !== entry.id);
  return [entry, ...rest].slice(0, Math.max(1, max));
}

// ---------------------------------------------------------------- 限速开关

/** 从未设置过非零限速时的兜底档位：2 MiB/s。 */
export const DEFAULT_TOGGLE_SPEED_LIMIT = 2 * 1024 * 1024;

/**
 * 限速开关决策：当前非零 → 关闭并记住当前值；当前为零 → 恢复上次非零值；
 * 连上次非零值都没有 → 用兜底档位。纯函数，不碰 config。
 *
 * @returns {{next:number, remember:number}}
 */
export function planSpeedToggle(current, lastNonZero, fallback = DEFAULT_TOGGLE_SPEED_LIMIT) {
  const cur = Math.max(0, Math.trunc(Number(current) || 0));
  if (cur > 0) return { next: 0, remember: cur };
  const last = Math.max(0, Math.trunc(Number(lastNonZero) || 0));
  if (last > 0) return { next: last, remember: last };
  const fb = Math.max(0, Math.trunc(Number(fallback) || 0));
  return { next: fb, remember: fb };
}

/** 速率的人类可读形式：B/s、KB/s（一位小数）、MB/s（一位小数）。 */
export function humanSpeed(bytesPerSec) {
  const n = Math.max(0, Number(bytesPerSec) || 0);
  const trim = (x) => String(Math.round(x * 10) / 10);
  if (n >= 1024 * 1024) return trim(n / (1024 * 1024)) + " MB/s";
  if (n >= 1024) return trim(n / 1024) + " KB/s";
  return Math.trunc(n) + " B/s";
}

/** 托盘限速菜单项文案：点得出来的状态必须看得见。 */
export function speedLimitLabel(limit) {
  const n = Math.max(0, Number(limit) || 0);
  return n > 0
    ? "限速：" + humanSpeed(n) + "（点击关闭）"
    : "限速：不限制（点击开启）";
}

// ---------------------------------------------------------------- 菜单模板

/**
 * 托盘右键菜单模板（纯数据）。main.mjs 把 id 映射为真实动作：
 *   show → 抬主窗口；pause-all/resume-all → POST /api/queue/pause|resume；
 *   speed-toggle → planSpeedToggle + PATCH /api/config；
 *   open:<taskId> → location 权威路径 + shell.openPath；
 *   autostart → setLoginItemSettings；quit → 退出。
 * daemon 不可用时（hasDaemon=false）所有需要服务的项都禁用而非隐藏，
 * 让用户知道功能存在、只是当前不可用。
 *
 * @param {{hasDaemon?:boolean, recentCompleted?:Array, speedLimit?:number,
 *          openAtLogin?:boolean, recentMax?:number}} state
 */
export function buildTrayMenuTemplate({
  hasDaemon = false,
  recentCompleted = [],
  speedLimit = 0,
  openAtLogin = false,
  recentMax = RECENT_MAX,
} = {}) {
  const recent = (Array.isArray(recentCompleted) ? recentCompleted : [])
    .filter((x) => x && typeof x.id === "string" && x.id !== "")
    .slice(0, Math.max(0, recentMax));
  const recentItems = recent.length
    ? recent.map((r) => ({ id: "open:" + r.id, label: r.filename || r.id, enabled: hasDaemon }))
    : [{ id: "recent-empty", label: "（暂无完成记录）", enabled: false }];
  return [
    { id: "show", label: "显示主界面" },
    { type: "separator" },
    { id: "pause-all", label: "暂停全部", enabled: hasDaemon },
    { id: "resume-all", label: "恢复全部", enabled: hasDaemon },
    { id: "speed-toggle", label: speedLimitLabel(speedLimit), enabled: hasDaemon },
    { type: "separator" },
    { id: "recent", label: "最近完成", enabled: hasDaemon && recent.length > 0, submenu: recentItems },
    { type: "separator" },
    { id: "autostart", label: "开机自启", type: "checkbox", checked: Boolean(openAtLogin) },
    { type: "separator" },
    { id: "quit", label: "退出" },
  ];
}

// ------------------------------------------------------- 托盘状态落盘

/** 托盘状态文件名（位于数据根，与 desktop-launch.log 等同目录）。 */
export const TRAY_STATE_FILE = "desktop-tray.json";

function sanitizeTrayState(raw, fallback) {
  const base = fallback && typeof fallback === "object" ? fallback : { lastNonZeroSpeedLimit: 0 };
  if (!raw || typeof raw !== "object") return { ...base };
  const n = Math.max(0, Math.trunc(Number(raw.lastNonZeroSpeedLimit) || 0));
  return { lastNonZeroSpeedLimit: n };
}

/**
 * 读托盘状态；缺失/损坏一律回退默认值，绝不抛出（状态文件坏了不能砸托盘）。
 */
export async function loadTrayState(dir, fallback = { lastNonZeroSpeedLimit: 0 }) {
  try {
    const text = await fsp.readFile(path.join(dir, TRAY_STATE_FILE), "utf8");
    return sanitizeTrayState(JSON.parse(text), fallback);
  } catch {
    return sanitizeTrayState(null, fallback);
  }
}

/**
 * 原子保存托盘状态：写临时文件后改名（工作区纪律：write-temp-then-rename，
 * 与 src/config.mjs 的 save 同一思路），进程中途被杀也不会留下半个状态。
 */
export async function saveTrayState(dir, state) {
  const file = path.join(dir, TRAY_STATE_FILE);
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fsp.rename(tmp, file);
  return file;
}
