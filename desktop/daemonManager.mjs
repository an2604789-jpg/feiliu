// daemonManager.mjs
//
// 桌面版对 DownloadX 常驻服务（daemon）的生命周期管理。
//
// 设计要点（对应施工提示词的硬边界）：
//   * 启动前先做“存活 + API 健康”双重探测：已有健康 daemon 时直接复用，
//     绝不重复启动；复用的外部 daemon 在桌面版退出时不会被关闭（owned=false）。
//   * 只有桌面版自己拉起的 daemon 才标记 owned=true，并在退出时走优雅停机
//     （POST /api/shutdown，等待保存队列/续传数据后自然退出），超时才强杀。
//   * 崩溃监督（包4）：owned daemon 意外退出时按指数退避自动重启，
//     默认 2s / 8s / 30s、最多 3 次。每次重启前重跑与 ensure() 相同的
//     readRuntime + healthProbe 复查——退避期间若有别的实例已把 daemon
//     拉起，就改为复用（owned=false：绝不重启、也绝不关闭它），防双实例。
//     3 次尝试全部失败则彻底放弃并回调 onGivenUp（由桌面壳弹托盘气泡），
//     不再无限循环。daemon 稳定运行超过 stableMs 之后的再次崩溃重新开账。
//   * 打包后没有独立的 node.exe，使用 Electron 可执行文件并设置
//     ELECTRON_RUN_AS_NODE=1，让它以纯 Node 模式运行既有 bin/downloadx.mjs，
//     用户无需安装 Node.js。
//   * 子进程一律 windowsHide + stdio ignore，不弹黑色命令行窗口；诊断信息
//     来自 daemon 自己写入的日志文件。
//   * 服务只监听 127.0.0.1，令牌来自 runtime.json，仅回环可见。

import { spawn, execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 数据根目录，必须与 src/paths.mjs 保持一致。 */
export function dataRoot() {
  if (process.env.DOWNLOADX_HOME) return path.resolve(process.env.DOWNLOADX_HOME);
  const base = process.env.APPDATA || process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "downloadx");
}

const runtimeFile = () => path.join(dataRoot(), "runtime.json");
const logFile = () => path.join(dataRoot(), "logs", "downloadx.log");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 自动重启的指数退避序列（规格：2s / 8s / 30s，最多 3 次）。 */
export const DEFAULT_RESTART_BACKOFF_MS = [2000, 8000, 30000];
/** 一次成功运行被视为“稳定”的时长：稳定后的再次崩溃从第 1 档退避重新开始。 */
export const DEFAULT_STABLE_MS = 60_000;
/** 单次重启尝试里，等待新 daemon 就绪的上限。 */
export const DEFAULT_RESTART_TIMEOUT_MS = 20_000;

/** 读取 runtime.json，并校验其中的 pid 仍存活；任何异常都返回 null。 */
export async function readRuntime() {
  try {
    const raw = JSON.parse(await fsp.readFile(runtimeFile(), "utf8"));
    if (!raw || !raw.pid || !raw.port || !raw.token) return null;
    try { process.kill(raw.pid, 0); } catch { return null; } // 陈旧的 runtime 文件
    return raw;
  } catch {
    return null;
  }
}

/** 对 daemon 做一次真实的 API 健康检查（/api/status，需令牌）。 */
async function healthProbe(rt, timeoutMs = 1500) {
  if (!rt || !rt.port || !rt.token) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${rt.host || "127.0.0.1"}:${rt.port}/api/status`, {
      headers: { "x-downloadx-token": rt.token },
      signal: controller.signal,
    });
    if (res.status !== 200) return false;
    const data = await res.json();
    return Boolean(data && data.version);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 读取 daemon 日志末尾若干行，用于解释启动失败。 */
async function logTail(n = 14) {
  try {
    const text = await fsp.readFile(logFile(), "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-n).join("\n");
  } catch {
    return "";
  }
}

function waitForExit(child, ms) {
  return new Promise((resolve) => {
    if (child.killed) return resolve(true);
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, ms);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    child.once("exit", onExit);
  });
}

/** Windows 下强制结束进程树（仅在优雅停机超时后使用）。 */
function forceKillTree(pid) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ }
      return resolve();
    }
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
  });
}

export class DaemonManager {
  /**
   * @param {object} [opts]
   * @param {number[]} [opts.backoffMs]   重启退避序列（默认 2s/8s/30s，长度即最大尝试次数）。
   * @param {number}   [opts.stableMs]    稳定窗口：超过它之后的崩溃重新开始整个退避序列。
   * @param {number}   [opts.restartTimeoutMs] 单次重启等待就绪的上限。
   * @param {number}   [opts.pollMs]      就绪轮询周期。
   * @param {Function} [opts.spawnImpl]   测试注入：替代真实 spawn，返回 child 形状的对象。
   * @param {Function} [opts.killTreeImpl] 测试注入：替代 taskkill 进程树强杀。
   * @param {Function} [opts.onRestarted] 自动重启成功（或改为复用外部实例）时回调
   *   ({rt, owned, reused, attempt})。新 daemon 的 port/token 都是新的，桌面壳
   *   应据此重载窗口，让渲染层拿到注入的新 token。
   * @param {Function} [opts.onGivenUp]   退避次数用尽、彻底放弃时回调 ({attempts})。
   */
  // ---- 崩溃监督（包4）的字段声明 ----
  #spawnImpl;                  // 测试注入的 spawn 替代品
  #killTree;                   // 进程树强杀（真实为 taskkill，测试可注入）
  #state = "idle";             // idle|running|external|backoff|restarting|given-up|stopped
  #armed = false;              // true = 正在监督一个 owned 的健康 daemon
  #attempts = 0;               // 本轮故障已用掉的重启次数
  #healthySince = 0;           // 最近一次确认健康的时间（稳定窗口的起点）
  #restartTimer = null;        // 挂起的退避定时器
  #restartPromise = null;      // 进行中的重启（与 ensure() 互斥）
  #expectExit = false;         // 主动回收子进程期间抑制“意外退出”判定

  constructor({
    backoffMs = DEFAULT_RESTART_BACKOFF_MS,
    stableMs = DEFAULT_STABLE_MS,
    restartTimeoutMs = DEFAULT_RESTART_TIMEOUT_MS,
    pollMs = 200,
    spawnImpl = null,
    killTreeImpl = null,
    onRestarted = null,
    onGivenUp = null,
  } = {}) {
    this.child = null;
    this.owned = false;
    this.rt = null;
    this.exitInfo = null;
    this.stopping = false;
    this.backoffMs = [...backoffMs];
    this.stableMs = stableMs;
    this.restartTimeoutMs = restartTimeoutMs;
    this.pollMs = pollMs;
    this.onRestarted = onRestarted;
    this.onGivenUp = onGivenUp;
    this.#spawnImpl = spawnImpl;
    this.#killTree = killTreeImpl || forceKillTree;
    this.#state = "idle";
    this.#armed = false;         // true = 正在监督一个 owned 的健康 daemon
    this.#attempts = 0;          // 本轮故障已用掉的重启次数
    this.#healthySince = 0;      // 最近一次确认健康的时间（稳定窗口的起点）
    this.#restartTimer = null;   // 挂起的退避定时器
    this.#restartPromise = null; // 进行中的重启（与 ensure() 互斥）
    this.#expectExit = false;    // 主动回收子进程期间抑制“意外退出”判定
  }

  /** 监督状态机当前状态（测试/诊断用）。 */
  get state() { return this.#state; }

  /** 监督状态机快照（测试/诊断用）。 */
  get supervisionState() {
    return { state: this.#state, armed: this.#armed, attempts: this.#attempts };
  }

  /**
   * 既有 daemon 入口脚本 bin/downloadx.mjs 的绝对路径。
   * 桌面代码位于 desktop/ 下，入口在相邻的 bin/ 下；打包（asar:false）后
   * 该相对关系保持不变，因此开发态与打包态使用同一套解析。
   */
  entryScript() {
    return path.resolve(__dirname, "..", "bin", "downloadx.mjs");
  }

  /** 当前是否已有健康的 daemon（无论归谁所有）。 */
  async existingHealthy() {
    const rt = await readRuntime();
    if (await healthProbe(rt)) return rt;
    return null;
  }

  #spawnOwned() {
    const child = this.#spawnImpl ? this.#spawnImpl() : this.#spawnRealOwned();
    // “exit 之后只处理一次”：#considerRestart 以 this.child === child 去重。
    const onExit = (code, signal) => {
      this.exitInfo = { code, signal };
      this.#considerRestart(child);
    };
    const onError = (err) => {
      // Windows 上 spawn 失败（如文件损坏）可能只有 error 没有 exit。
      this.exitInfo = { code: -1, error: err };
      this.#considerRestart(child);
    };
    child.on("exit", onExit);
    child.on("error", onError);
    this.child = child;
    this.exitInfo = null;
    this.#expectExit = false;
  }

  #spawnRealOwned() {
    const entry = this.entryScript();
    if (!fs.existsSync(entry)) {
      throw new Error(
        "找不到下载核心程序文件：\n" + entry +
        "\n\n应用安装可能不完整，请重新安装 DownloadX。"
      );
    }
    // 让 Electron 可执行文件以纯 Node 模式运行既有 daemon 入口。
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    // stdio 忽略：daemon 自身把所有输出写入日志文件；挂载管道又在退出时
    // 关闭会触发 EPIPE，导致停机中途被杀（与 src/cli.mjs 中既有经验一致）。
    return spawn(process.execPath, [entry, "daemon", "--port", "0"], {
      windowsHide: true,
      stdio: "ignore",
      detached: false,
      env,
    });
  }

  /**
   * 确保有一个可用的 daemon。
   * @returns {Promise<{rt:object, owned:boolean, reused:boolean}>}
   */
  async ensure({ timeoutMs = 30000, onPhase = null } = {}) {
    // 与自动重启互斥：等在途的重启落地后再判断，绝不并发拉起第二个 daemon。
    if (this.#restartPromise) {
      try { await this.#restartPromise; } catch { /* 重启失败按无 daemon 处理 */ }
    }
    // 手动 ensure 视为一次全新开始：取消挂起的退避并清零计数（放弃状态也随之解除）。
    this.#cancelRestartTimer();
    this.#attempts = 0;

    // 1) 已有健康 daemon：直接复用，绝不再启动一个。
    //    若那正是我们自己自动重启出来的实例（pid 吻合），仍标记 owned=true，
    //    退出时照常优雅停机。
    const existing = await readRuntime();
    if (await healthProbe(existing)) {
      await this.#adoptRunning(existing);
      if (this.owned) return { rt: existing, owned: true, reused: false };
      return { rt: existing, owned: false, reused: true };
    }

    // 2) 没有可用 daemon，由桌面版拉起一个，并记录所有权。
    if (onPhase) onPhase("正在启动下载服务…");
    this.#spawnOwned();

    const startedAt = Date.now();
    let lastSeen = null;
    while (Date.now() - startedAt < timeoutMs) {
      await sleep(this.pollMs);

      // 子进程在启动阶段退出：直接给出可读错误而不是等满超时。
      // （初始启动失败不算“意外退出”，不进入自动重启——错误交还给用户。）
      if (this.exitInfo) {
        // 数据根锁让“同伴 daemon 赢得启动竞争”成为正常结局：我们拉起的子进程
        // 看到健康持有者会主动退出（exit 0）。此时 runtime.json 指向同伴，
        // 按复用处理而不是当作启动失败。
        const peer = await readRuntime();
        if (peer && (await healthProbe(peer))) {
          await this.#adoptRunning(peer);
          return { rt: peer, owned: this.owned, reused: !this.owned };
        }
        const tail = await logTail();
        throw new Error(
          "下载服务在启动过程中退出（退出码 " +
          (this.exitInfo.code ?? "unknown") +
          (this.exitInfo.signal ? "，信号 " + this.exitInfo.signal : "") +
          "）。\n\n可能原因：端口被占用、数据目录不可写或程序文件损坏。\n" +
          "诊断日志：" + logFile() +
          (tail ? "\n\n最近日志：\n" + tail : "")
        );
      }

      const rt = await readRuntime();
      if (rt && await healthProbe(rt)) {
        await this.#adoptRunning(rt);
        return { rt, owned: this.owned, reused: !this.owned };
      }
      lastSeen = rt;
    }

    // 3) 超时：回收我们刚拉起的进程，给出可操作的中文诊断。
    this.owned = true;
    await this.#disposeChild();
    const tail = await logTail();
    let hint = "";
    if (lastSeen && lastSeen.pid) {
      let alive = true;
      try { process.kill(lastSeen.pid, 0); } catch { alive = false; }
      hint = alive
        ? `进程（pid ${lastSeen.pid}）已存在，但 API 在 ${lastSeen.host}:${lastSeen.port} 上无响应。`
        : `runtime 文件指向的进程（pid ${lastSeen.pid}）已不存在。`;
    }
    throw new Error(
      "下载服务在 " + timeoutMs / 1000 + " 秒内没有就绪。\n" + hint +
      "\n请检查本机安全软件是否拦截，或稍后重试。\n" +
      "诊断日志：" + logFile() +
      (tail ? "\n\n最近日志：\n" + tail : "")
    );
  }

  /**
   * 把一个刚被确认健康的 runtime 收编为当前实例：
   *   - pid 正是我们拉起的子进程 → owned=true，进入 running 并武装监督；
   *   - pid 属于别的进程 → 复用外部实例（owned=false，绝不重启/关闭），
   *     若我们已抢先拉起了子进程则只回收自己的那个，避免双实例。
   */
  async #adoptRunning(rt) {
    if (this.child && this.child.pid === rt.pid) {
      if (!this.exitInfo) {
        this.rt = rt;
        this.owned = true;
        this.#armed = true;
        this.#healthySince = Date.now();
        this.#state = "running";
        return;
      }
      // 极端竞态：健康探测返回与武装监督之间的空档里子进程退出了。
      // 按一次意外退出进入退避，而不是继续守护一个已死的子进程。
      this.child = null;
      this.rt = null;
      this.owned = false;
      this.#armed = false;
      if (Date.now() - (this.#healthySince || 0) >= this.stableMs) this.#attempts = 0;
      this.#scheduleNextRestart();
      return;
    }
    // 期间出现了另一个健康 daemon：视为复用外部实例，不擅自关闭。
    if (this.child) await this.#disposeChild();
    this.rt = rt;
    this.owned = false;
    this.#armed = false;
    this.#state = "external";
  }

  /** 子进程退出事件：只对“我们拥有的、武装了监督的”意外退出启动重启流程。 */
  #considerRestart(deadChild) {
    if (this.child !== deadChild) return; // 重复/过期事件
    this.child = null;
    this.owned = false;
    if (!this.#armed || this.#expectExit || this.stopping) return;
    this.#armed = false;
    // 稳定运行过一段时间的崩溃开新账：退避序列从头计。
    if (Date.now() - (this.#healthySince || 0) >= this.stableMs) this.#attempts = 0;
    this.#scheduleNextRestart();
  }

  #cancelRestartTimer() {
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
  }

  /** 排下一次重启；次数用尽则彻底放弃并通知（不再无限循环）。 */
  #scheduleNextRestart() {
    if (this.stopping) return;
    if (this.#restartTimer) return; // 防重入
    if (this.#attempts >= this.backoffMs.length) {
      this.#giveUp();
      return;
    }
    const delay = this.backoffMs[this.#attempts];
    this.#attempts += 1;
    this.#state = "backoff";
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      this.#restartPromise = this.#attemptRestart()
        .catch(() => {
          // 重启流程自身的异常（如程序文件丢失）也计入失败，继续退避而非中断监督。
          this.#scheduleNextRestart();
        })
        .finally(() => { this.#restartPromise = null; });
    }, delay);
  }

  #giveUp() {
    this.#armed = false;
    this.#state = "given-up";
    const payload = { attempts: this.#attempts, backoffMs: [...this.backoffMs] };
    logDaemonEvent("supervision gave up after " + this.#attempts + " attempts");
    try {
      const r = this.onGivenUp && this.onGivenUp(payload);
      Promise.resolve(r).catch(() => { /* 通知失败不影响状态机 */ });
    } catch { /* 同上 */ }
  }

  #notifyRestarted(info) {
    const payload = { ...info, attempt: this.#attempts };
    logDaemonEvent("supervision restart #" + this.#attempts +
      " -> " + (info.owned ? "owned" : "adopted external"));
    try {
      const r = this.onRestarted && this.onRestarted(payload);
      Promise.resolve(r).catch(() => { /* 通知失败不影响状态机 */ });
    } catch { /* 同上 */ }
  }

  /**
   * 执行一次重启尝试：
   *   1) 防双实例复查——退避期间别的实例可能已把 daemon 拉起，先 readRuntime +
   *      healthProbe；健康则直接复用（owned=false），绝不 spawn 第二个。
   *   2) 否则 spawn 一个新 daemon 并等待就绪。成功 → owned、武装监督、通知；
   *      失败（启动中退出/超时）→ 回收子进程，排下一档退避或放弃。
   */
  async #attemptRestart() {
    if (this.stopping) return;
    this.#state = "restarting";

    const existing = await readRuntime();
    if (await healthProbe(existing)) {
      // 别的实例已经把服务恢复了：改为复用，绝不重启它。
      await this.#adoptRunning(existing);
      if (!this.stopping && this.state === "external") {
        this.#notifyRestarted({ rt: existing, owned: false, reused: true });
      }
      return;
    }
    if (this.stopping) return;

    this.#spawnOwned();
    const rt = await this.#awaitHealthy(this.restartTimeoutMs);
    if (this.stopping) {
      // 停机竞态：不等就绪了，直接回收自己刚拉起的进程。
      await this.#disposeChild();
      return;
    }
    if (!rt) {
      await this.#disposeChild();
      this.#scheduleNextRestart();
      return;
    }
    await this.#adoptRunning(rt);
    if (this.stopping) return;
    if (this.owned) {
      this.#notifyRestarted({ rt, owned: true, reused: false });
    } else {
      // 等待就绪期间被外部 daemon 抢先：#adoptRunning 已按 pid 归属裁决，
      // 并只回收了我们自己拉起的子进程。
      this.#notifyRestarted({ rt, owned: false, reused: true });
    }
  }

  /** 轮询等待刚 spawn 的子进程在 runtime.json 里变健康；失败/超时返回 null。 */
  async #awaitHealthy(timeoutMs) {
    const startedAt = Date.now();
    for (;;) {
      await sleep(this.pollMs);
      if (!this.child || this.exitInfo) return null; // 启动阶段就退出了
      const rt = await readRuntime();
      if (rt && await healthProbe(rt)) return rt;
      if (Date.now() - startedAt >= timeoutMs) return null;
    }
  }

  async #disposeChild() {
    const child = this.child;
    if (!child) return;
    this.#expectExit = true; // 主动回收，其后的 exit 不是“意外退出”
    try {
      const exited = await waitForExit(child, 1500);
      if (!exited) await this.#killTree(child.pid);
    } catch { /* 尽力清理 */ }
    finally {
      if (this.child === child) this.child = null;
      this.#expectExit = false;
    }
  }

  /**
   * 仅停止“由桌面版自己拉起”的 daemon；复用的外部实例一律不动。
   * 走 API 优雅停机，让其保存队列、续传状态、计划任务后自然退出。
   * 同时终止崩溃监督（取消挂起的退避定时器）。
   */
  async stopOwned() {
    if (this.stopping) return;
    this.stopping = true;

    // 先停掉监督：不再排新的重启，也不再通知。
    this.#cancelRestartTimer();
    this.#armed = false;
    if (this.#restartPromise) {
      try { await this.#restartPromise; } catch { /* 尽力而为 */ }
    }
    if (!this.owned) return;

    const rt = this.rt;
    const child = this.child;
    if (rt) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        await fetch(`http://${rt.host || "127.0.0.1"}:${rt.port}/api/shutdown`, {
          method: "POST",
          headers: { "x-downloadx-token": rt.token },
          signal: controller.signal,
        });
      } catch { /* 可能已退出 */ }
      finally { clearTimeout(timer); }
    }

    if (child) {
      const exited = await waitForExit(child, 9000);
      if (!exited) {
        // 优雅停机未在期限内结束，才结束进程树（含 ffmpeg 等子进程）。
        await this.#killTree(child.pid);
      }
    }
    this.child = null;
    this.owned = false;
    this.#state = "stopped";
  }
}

/** 监督流程自身的诊断日志（与 daemon 日志同目录，失败不影响流程）。 */
function logDaemonEvent(line) {
  try {
    const file = path.join(dataRoot(), "logs", "desktop-supervision.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, new Date().toISOString() + " " + line + "\n");
  } catch { /* 日志必须绝不影响监督 */ }
}
