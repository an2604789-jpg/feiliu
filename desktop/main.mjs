// main.mjs — DownloadX 桌面版主进程
//
// 职责：
//   1. 应用生命周期与独立窗口（界面始终在 DownloadX 自己的窗口里，
//      不启动 Edge/Chrome 等外部浏览器，也不弹命令行窗口）。
//   2. 启动时确保本机 daemon 健康：已运行则复用、不重复启动；未运行则
//      由本进程以 ELECTRON_RUN_AS_NODE 方式拉起，退出时仅停止自己拉起的实例。
//   3. 安全：contextIsolation 开启、nodeIntegration 关闭；
//      仅允许导航到本机 daemon 源，拒绝任意弹窗与外部浏览器承载界面。
//   4. 崩溃监督（包4）：owned daemon 意外退出时由 DaemonManager 按退避
//      （2s/8s/30s，最多 3 次）自动重启；重启成功后重载窗口让渲染层拿到
//      新 token；3 次都失败则托盘气泡告知“下载服务已停止，请重启应用”。
//      复用的外部 daemon（owned=false）绝不重启。
//   5. 托盘反馈与队列控制（包6）：主进程订阅 daemon 的 SSE /api/events
//      （token 取自 runtime.json，断线按 2s/5s/15s 退避自动重连）；任务
//      complete 弹气泡“下载完成：<文件名>”、点击 shell.openPath 打开文件，
//      error 弹气泡“下载失败：<文件名>”、点击抬起主窗口；托盘菜单提供
//      暂停全部/恢复全部（POST /api/queue/pause|resume）、限速开关
//      （在 0 与上次非零值间切换并写回 config）、最近完成 3 条。
//      可单测的纯逻辑都在 ./tray-feed.mjs，本文件只做 Electron 接线。
//
// daemon 仅监听 127.0.0.1，令牌经 runtime.json 交换，不暴露公网。

import { app, BrowserWindow, ipcMain, shell, dialog, clipboard, Tray, Menu, nativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DaemonManager, dataRoot, readRuntime } from "./daemonManager.mjs";
import {
  createSseParser,
  classifyTaskEvent,
  pushRecent,
  planSpeedToggle,
  buildTrayMenuTemplate,
  loadTrayState,
  saveTrayState,
  RECENT_MAX,
  DEFAULT_TOGGLE_SPEED_LIMIT,
} from "./tray-feed.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ---------------------------------------------------------------------------
// Startup workarounds for this host. Everything here must run before
// app.whenReady(): command line switches and the userData path are read early.
//
// Why: on this machine Chromium's process sandbox fails to initialise and takes
// the whole app down before any window exists -- exit code 0x80000003, no
// output, nothing in the Windows event log. Diagnosed 2026-10-22: a five-line
// Electron application that contains no DownloadX code crashes the same way, so
// this is not a bug in this app. Revert by deleting the appendSwitch line once
// the host can start a plain Electron app again.
app.commandLine.appendSwitch("no-sandbox");

/** Launch diagnostics: a window that vanishes without a trace is undebuggable. */
function logLaunch(line) {
  try {
    const file = path.join(dataRoot(), "logs", "desktop-launch.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, new Date().toISOString() + " " + line + "\n");
  } catch { /* logging must never break startup */ }
}
logLaunch("startup pid=" + process.pid + " userData=" + (() => {
  try { return app.getPath("userData"); } catch { return "?"; }
})());
process.on("uncaughtException", (err) => logLaunch("uncaughtException: " + ((err && err.stack) || err)));

/** Can this process create files in the directory? Used to choose the profile dir. */
function isWritable(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); return true; }
  catch { return false; }
}

// Chromium keeps its profile -- and the file it uses for single-instance
// detection -- in userData, which defaults to %APPDATA%\downloadx. That is also
// the daemon's data root, so a locked-down %APPDATA% takes the window down with
// it ("Lock file can not be created: access denied"). Prefer a profile next to
// the application and fall back to the data root only if that is not writable.
try {
  const besideApp = path.join(__dirname, "..", "electron-profile");
  const inDataRoot = path.join(dataRoot(), "electron-profile");
  if (isWritable(besideApp)) app.setPath("userData", besideApp);
  else if (isWritable(inDataRoot)) app.setPath("userData", inDataRoot);
} catch (err) { logLaunch("userData override failed: " + err); }

/**
 * 健壮地解析应用图标绝对路径：
 * 依次尝试 desktop/icon.ico、源码根目录 build/icon.ico、以及打包资源目录。
 * 确保在源码开发态、解包版和便携版中均能稳定加载图标。
 */
function resolveAppIcon() {
  const candidates = [
    path.join(__dirname, "icon.ico"),
    path.join(__dirname, "..", "build", "icon.ico"),
    path.join(process.resourcesPath || "", "app", "build", "icon.ico"),
    path.join(process.resourcesPath || "", "build", "icon.ico"),
    path.join(process.resourcesPath || "", "icon.ico"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

// [gpp-guard-pure] begin
// —— 纯逻辑段（批-4，P-4 崩溃守卫）。勿引入 electron/节点专用依赖：
// test/batch3-siteguards.mjs 会把这一整段从本文件抠出来单独求值测试，
// 改这里的同时要保证该测试仍然通过。
//
// 背景（待修问题清单 P-4）：游戏加加（GamePP，注入 DLL 名 GPP64.dll）注入
// 本进程后，应用打开 ~5s 即 0xc0000005 闪退；事件日志出错模块
// GPP64.dll+0x9e956，stderr 充斥 GAMEPP-IPC-OVERLAY。用户侧已确认退出
// 游戏加加后稳定。
//
// 检测方式与局限（纯 JS、零原生依赖）：Windows 不向 JS 暴露本进程模块
// 列表，所以只能扫"拿得到的文本信号"——报错对象本身（堆栈/消息）、
// process.report 诊断报告（其 nativeStack 帧在 Windows 上形如
// "GPP64.dll+0x9e956"，且报告内含环境变量段，一石二鸟）。这些信号只有在
// 注入物恰好出现在报错路径上时才可见：注入了但没报错 → 检测不到；
// 报错与注入无关 → 也检测不到。因此检测命中给确定性指引，未命中也常驻
// 提示常见冲突源，把"检测不到"的假阴性兜住。
const GPP_ADVISORY_DETECTED =
  "检测到游戏加加(GamePP)注入,已知会导致崩溃;请退出游戏加加后重启本应用(详见 待修问题清单 P-4)";
const GPP_ADVISORY_HINT =
  "常见冲突源提示:游戏加加/GamePP(GPP64.dll)等注入型工具已知会导致本应用崩溃;若本机装有此类工具,请退出后重启本应用(详见 待修问题清单 P-4)";

/** 在可得的文本信号里找 GPP64/GamePP 痕迹（大小写不敏感）。 */
function gppHit(...texts) {
  let hay = "";
  for (const t of texts) {
    if (t == null) continue;
    if (typeof t === "string") hay += "\n" + t;
    else if (t instanceof Error) hay += "\n" + (t.stack || t.message || String(t));
    else {
      try { hay += "\n" + JSON.stringify(t); } catch { /* 循环引用等，跳过 */ }
    }
  }
  return /gpp64|gamepp/i.test(hay);
}

/**
 * 崩溃/异常对话框要追加的 GPP 附注：命中给确定性指引，否则常驻提示。
 * @param {*} signal 报错对象或事件详情（Error/string/object 均可）
 * @param {*} [report] 诊断报告；不传则现场取 process.report.getReport()
 *   （测试传入构造的报告以求确定性）。报告不可得时按未检出处理。
 */
function gppAdvisory(signal, report) {
  let hit = false;
  try {
    const rpt = report === undefined && typeof process !== "undefined" &&
      process.report && typeof process.report.getReport === "function"
      ? process.report.getReport()
      : report;
    hit = gppHit(signal, rpt);
  } catch { /* 按未检出处理 */ }
  return hit ? GPP_ADVISORY_DETECTED : GPP_ADVISORY_HINT;
}
// [gpp-guard-pure] end

// 捕获未处理异常，避免窗口创建前原生/JS异常静默退出。
// P-4：文案追加 GPP 附注（检出 → 确定性指引；未检出 → 常驻冲突源提示）。
process.on("uncaughtException", (err) => {
  try {
    dialog.showErrorBox("飞流下载器 未捕获异常", ((err && err.stack) || String(err)) + "\n\n" + gppAdvisory(err));
  } catch {}
});

process.on("unhandledRejection", (reason) => {
  try {
    dialog.showErrorBox("飞流下载器 异步异常", (reason && reason.stack) || String(reason));
  } catch {}
});

// daemon 崩溃监督回调（函数声明会被提升，可在此先引用）：
//   * onRestarted：自动重启成功（或退避复查时改为复用外部实例）后，
//     新 daemon 的 pid/port/token 全是新签发的——token 由 daemon 注入
//     它服务的 GUI 页面（src/api.mjs 的 window.__DOWNLOADX__），所以必须
//     整页 loadURL 重载，渲染层才能拿到新 token；expectedOrigin 同步切换。
//   * onGivenUp：3 次退避重启全部失败，托盘气泡告知，不再无限循环。
const manager = new DaemonManager({
  onRestarted: handleDaemonRestarted,
  onGivenUp: handleDaemonGivenUp,
});
let mainWindow = null;
let expectedOrigin = null;
let cleanupDone = false;
let booting = false;

// 监听渲染进程异常，防止渲染器崩溃时主进程静默退出或僵死。
// P-4：文案追加 GPP 附注（GPP64 注入的崩溃正是渲染进程被带崩的形态之一）。
app.on("render-process-gone", (_event, _webContents, details) => {
  if (details.reason !== "clean-exit") {
    try {
      dialog.showErrorBox(
        "飞流下载器 渲染进程异常",
        `渲染进程退出：reason=${details.reason}, exitCode=${details.exitCode ?? "n/a"}` + "\n\n" + gppAdvisory(details),
      );
    } catch {}
  }
});

// 单实例：避免多个桌面窗口重复管理同一个后台服务（托盘常驻后这一条尤其关键，
// 否则每双击一次就多一个永不退出的实例）。
//
// Chromium 自带的 requestSingleInstanceLock() 在这台机器上恒为 false
// （process_singleton_win.cc 建锁文件被拒 0x5），既不能拿它当判据，也不能因它
// 失败就退出（那会变成"双击没反应、也不报错"）。所以这里自己实现：
//   - userData 下写 instance.lock，内容是主实例 PID
//   - 锁里的 PID 还活着 → 已有实例在跑：写 instance.show 信号文件让它抬起窗口，
//     本进程立即退出
//   - 锁里的 PID 已死、或就是本进程 → 接管，正常启动
const instanceLock = (() => {
  const dir = (() => { try { return app.getPath("userData"); } catch { return __dirname; } })();
  const lockFile = path.join(dir, "instance.lock");
  const showFile = path.join(dir, "instance.show");
  const readPid = () => {
    try {
      const pid = Number(fs.readFileSync(lockFile, "utf8").trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch { return null; }
  };
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (err) { return err.code === "EPERM"; }
  };
  const holder = readPid();
  if (holder && holder !== process.pid && alive(holder)) {
    try { fs.writeFileSync(showFile, String(process.pid), "utf8"); } catch { /* best effort */ }
    logLaunch("already running as pid " + holder + "; asked it to raise its window, exiting");
    return { primary: false, lockFile, showFile };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockFile, String(process.pid), "utf8");
  } catch (err) {
    logLaunch("instance lock write failed (running anyway): " + err);
  }
  return { primary: true, lockFile, showFile };
})();

if (!instanceLock.primary) {
  app.exit(0);
}
{
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(createWindow).catch((err) => {
    dialog.showErrorBox("飞流下载器 启动失败", (err && err.stack) || String(err));
  });

  // 托盘常驻模式下，窗口全部关闭（含隐藏）不退出；真正退出走托盘菜单。
  app.on("window-all-closed", () => { /* keep running in tray */ });

  // 第二个实例把 instance.show 写出来后，由这里把窗口抬起来。轮询比 fs.watch 稳。
  app.whenReady().then(() => {
    setInterval(() => {
      try {
        if (fs.existsSync(instanceLock.showFile)) {
          fs.unlinkSync(instanceLock.showFile);
          logLaunch("show requested by another instance");
          showMainWindow();
        }
      } catch { /* 信号处理失败不影响主流程 */ }
      // 扩展侧"focus-app"(通知点击)信号:拉起主窗并切到任务列表。
      // 与 instance.show 同一文件信号模式,复用同一个轮询周期。
      try {
        const focusFile = path.join(dataRoot(), "focus.show");
        if (fs.existsSync(focusFile)) {
          fs.unlinkSync(focusFile);
          logLaunch("focus requested (extension notification click)");
          showMainWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.executeJavaScript("try{setNavView('all');render();}catch(e){}")
              .catch(() => { /* 页面未就绪时忽略 */ });
          }
        }
      } catch { /* 同上 */ }
    }, 700);
  }).catch(() => {});

  // 退出前优雅停止“自己拉起”的 daemon（保存队列/续传状态）；
  // 复用的外部 daemon 不受影响。
  app.on("before-quit", (event) => {
    if (cleanupDone) return;
    event.preventDefault();
    (async () => {
      stopEventFeed();   // 断开 SSE、取消重连定时器，不拖住退出
      try { await manager.stopOwned(); }
      catch { /* 退出阶段尽力而为 */ }
      try {
        const holder = Number(fs.readFileSync(instanceLock.lockFile, "utf8").trim());
        if (holder === process.pid) fs.unlinkSync(instanceLock.lockFile);
      } catch { /* 锁文件清理失败不阻塞退出 */ }
      cleanupDone = true;
      app.quit();
    })();
  });
}

function createWindow() {
  const appIcon = resolveAppIcon();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: "#f4f6fa",
    title: "飞流下载器",
    autoHideMenuBar: true,
    show: true,
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // 在本宿主环境下，Chromium 沙箱令牌会与系统第三方钩子模块（如 GPP64.dll）
      // 冲突引发 0xc0000005 ACCESS_VIOLATION 崩溃；关闭 renderer 进程沙箱令牌，
      // 但坚决维持 contextIsolation: true 与 nodeIntegration: false，
      // 并在主进程限制导航和外部弹窗，确保同等强度的安全边界。
      sandbox: false,
      spellcheck: false,
      webSecurity: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  // 只允许在本机 daemon 源内导航，任何跨站导航一律阻止（界面不交给外部浏览器）。
  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    if (!expectedOrigin) { event.preventDefault(); return; }
    try {
      const u = new URL(navigationUrl);
      if (u.origin !== expectedOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });

  // 拒绝一切 window.open 弹窗：界面始终停留在本窗口。
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // 外部重定向也只允许停留在本机 daemon 源。
  mainWindow.webContents.on("will-redirect", (event, url) => {
    if (!expectedOrigin) return;
    try {
      const u = new URL(url);
      if (u.origin !== expectedOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.loadFile(path.join(__dirname, "splash.html"));
  // IDM 式常驻：点 X = 最小化到托盘，不退出。真正退出走托盘菜单的"退出"。
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
      return;
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  createTray();
}

// ---------------------------------------------------------------- tray (IDM-style resident)

/** True while we are really quitting (tray menu); a plain window close just hides. */
let quitting = false;
let tray = null;

function resolveTrayIcon() {
  const candidates = [
    path.join(__dirname, "icon.ico"),
    path.join(__dirname, "..", "build", "icon.ico"),
    path.join(process.resourcesPath || "", "app", "build", "icon.ico"),
    path.join(process.resourcesPath || "", "build", "icon.ico"),
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return undefined;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  const icon = resolveTrayIcon();
  tray = new Tray(icon || path.join(__dirname, "..", "build", "icon.png"));
  tray.setToolTip("飞流下载管理器（后台运行中）");
  tray.on("double-click", showMainWindow);
  // 气泡点击（包6）：完成类气泡打开文件，其余（失败/服务停止）抬主窗口。
  // Windows 上所有气泡共用一个 balloon-click，靠 lastBalloon 区分这次点击
  // 指哪条气泡；读过即清，避免旧动作串到新气泡上。
  tray.on("balloon-click", () => {
    const act = trayFeed.lastBalloon;
    trayFeed.lastBalloon = null;
    onBalloonClick(act);
  });
  initTrayFeed().catch(() => { /* 菜单初建失败不影响托盘存在 */ });
}

/**
 * 重建托盘菜单。菜单是状态的函数：daemon 配置（限速值）、最近完成列表、
 * 开机自启勾选都取当前值重画。daemon 不可达时相关项禁用而非隐藏。
 * 调用点：托盘初建、daemon 就绪/重启、有任务完成、限速切换后。
 */
async function rebuildTrayMenu() {
  if (!tray) return;
  const rt = manager.rt;
  let hasDaemon = Boolean(rt && rt.port && rt.token);
  if (hasDaemon) {
    // 限速值每次都向 daemon 要最新的：用户随时可能在界面里改，托盘缓存会撒谎。
    const cfg = await fetchDaemonJson("/api/config");
    if (cfg && cfg.config) {
      const limit = Math.max(0, Number(cfg.config.speedLimit) || 0);
      trayFeed.speedLimit = limit;
      if (limit > 0) trayFeed.lastNonZero = limit;
    } else {
      hasDaemon = false;
    }
  }
  const template = buildTrayMenuTemplate({
    hasDaemon,
    recentCompleted: trayFeed.recent,
    speedLimit: trayFeed.speedLimit ?? 0,
    openAtLogin: (() => { try { return app.getLoginItemSettings().openAtLogin; } catch { return false; } })(),
  });
  tray.setContextMenu(Menu.buildFromTemplate(template.map(toMenuItem)));
}

/** 模板项 → Electron 菜单项：separator/checkbox/submenu 保留形状，click 统一走 id。 */
function toMenuItem(item) {
  if (item.type === "separator") return { type: "separator" };
  const out = { label: item.label, enabled: item.enabled !== false };
  if (item.type === "checkbox") {
    out.type = "checkbox";
    out.checked = Boolean(item.checked);
  }
  if (item.submenu) out.submenu = item.submenu.map(toMenuItem);
  else out.click = (menuItem) => handleMenuAction(item.id, Boolean(menuItem && menuItem.checked));
  return out;
}

/** 菜单 id → 动作。旧菜单的三项（显示主界面/开机自启/退出）行为原样保留。 */
function handleMenuAction(id, checked) {
  if (typeof id === "string" && id.startsWith("open:")) {
    const taskId = id.slice(5);
    const entry = trayFeed.recent.find((r) => r && r.id === taskId) || null;
    openTaskFile(taskId, entry).catch((err) =>
      logLaunch("open recent item failed: " + (err && err.message ? err.message : err)));
    return;
  }
  switch (id) {
    case "show":
      showMainWindow();
      break;
    case "pause-all":
      daemonPost("/api/queue/pause").catch((err) =>
        logLaunch("pause-all failed: " + (err && err.message ? err.message : err)));
      break;
    case "resume-all":
      daemonPost("/api/queue/resume").catch((err) =>
        logLaunch("resume-all failed: " + (err && err.message ? err.message : err)));
      break;
    case "speed-toggle":
      toggleSpeedLimit().catch((err) =>
        logLaunch("speed toggle failed: " + (err && err.message ? err.message : err)));
      break;
    case "autostart":
      app.setLoginItemSettings({ openAtLogin: Boolean(checked), args: ["--no-sandbox", "--hidden"] });
      logLaunch("login-item set to " + Boolean(checked));
      break;
    case "quit":
      logLaunch("quit requested from tray");
      quitting = true;
      app.quit();
      break;
    default:
      break; // recent-empty 等占位项没有动作
  }
}

// ---------------------------------------------------------------- daemon 事件流 → 托盘反馈（包6）

/** 断线重连退避序列；连上即清零，之后封顶在最后一档。 */
const FEED_RECONNECT_MS = [2000, 5000, 15000];

const trayFeed = {
  seen: new Map(),        // taskId -> 上一次见到的状态（跨重连保留，防重复弹泡）
  recent: [],             // 最近完成 [{id, filename, dir}]，最新在前
  speedLimit: null,       // 最近一次从 daemon 读到的 speedLimit（null=未知）
  lastNonZero: 0,         // 上次非零限速值，持久化于数据根 desktop-tray.json
  abort: null,            // 当前 SSE 连接的 AbortController
  generation: 0,          // 连接代次：重连/退出作废旧回调，保证只有一条活连接
  reconnectTimer: null,
  stopped: true,
  backoffIdx: 0,
  lastBalloon: null,      // 最近一条气泡被点击时该做什么（读后即清）
};

function trayStateDir() {
  return dataRoot();
}

/** 托盘反馈初始化：载入上次非零限速，先画一版菜单（daemon 未就绪时相关项禁用）。 */
async function initTrayFeed() {
  const st = await loadTrayState(trayStateDir());
  trayFeed.lastNonZero = st.lastNonZeroSpeedLimit || trayFeed.lastNonZero;
  await rebuildTrayMenu();
}

/**
 * 带 token 的 daemon GET（限速配置、任务权威路径）。超时/任何失败返回 null，
 * 由调用方自行降级——托盘功能绝不能因为一次请求失败而崩掉。
 */
async function fetchDaemonJson(route) {
  const rt = (manager.rt && manager.rt.port && manager.rt.token)
    ? manager.rt
    : (await readRuntime());
  if (!rt || !rt.port || !rt.token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`http://${rt.host || "127.0.0.1"}:${rt.port}${route}`, {
      headers: { "x-downloadx-token": rt.token },
      signal: controller.signal,
    });
    if (res.status !== 200) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 托盘发起的 daemon POST（暂停全部/恢复全部）。失败时气泡提示。 */
async function daemonPost(route) {
  const rt = (manager.rt && manager.rt.port && manager.rt.token)
    ? manager.rt
    : (await readRuntime());
  if (!rt || !rt.port || !rt.token) {
    showTrayBalloon("warning", "下载服务不可用，无法执行该操作");
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`http://${rt.host || "127.0.0.1"}:${rt.port}${route}`, {
      method: "POST",
      headers: { "x-downloadx-token": rt.token },
      signal: controller.signal,
    });
    if (res.status !== 200) throw new Error("HTTP " + res.status);
    return true;
  } catch (err) {
    showTrayBalloon("warning", "操作失败：" + (err && err.message ? err.message : err));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 限速开关：点击时以 daemon 当前配置为准（不信任缓存——用户随时可能在
 * 界面里改），在 0 与上次非零值之间切换并 PATCH /api/config 写回；
 * 上次非零值落盘 desktop-tray.json（写临时再改名），下次启动仍可恢复。
 */
async function toggleSpeedLimit() {
  const cfg = await fetchDaemonJson("/api/config");
  if (!cfg || !cfg.config) {
    showTrayBalloon("warning", "下载服务不可用，无法切换限速");
    return;
  }
  const current = Math.max(0, Number(cfg.config.speedLimit) || 0);
  const plan = planSpeedToggle(current, trayFeed.lastNonZero, DEFAULT_TOGGLE_SPEED_LIMIT);
  const rt = (manager.rt && manager.rt.port && manager.rt.token)
    ? manager.rt
    : (await readRuntime());
  if (!rt || !rt.port || !rt.token) {
    showTrayBalloon("warning", "下载服务不可用，无法切换限速");
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`http://${rt.host || "127.0.0.1"}:${rt.port}/api/config`, {
      method: "PATCH",
      headers: { "x-downloadx-token": rt.token, "content-type": "application/json" },
      body: JSON.stringify({ speedLimit: plan.next }),
      signal: controller.signal,
    });
    if (res.status !== 200) throw new Error("HTTP " + res.status);
    const body = await res.json();
    trayFeed.speedLimit = Math.max(0, Number((body && body.config && body.config.speedLimit) ?? plan.next) || 0);
    if (plan.remember > 0) trayFeed.lastNonZero = plan.remember;
    await saveTrayState(trayStateDir(), { lastNonZeroSpeedLimit: trayFeed.lastNonZero });
    await rebuildTrayMenu();   // 菜单文案立即反映新状态
  } catch (err) {
    showTrayBalloon("warning", "限速切换失败：" + (err && err.message ? err.message : err));
  } finally {
    clearTimeout(timer);
  }
}

// ---- 剪贴板进程内桥（P-25） -----------------------------------------------

// [clipboard-bridge-pure] begin
// —— 纯逻辑段（P-25 剪贴板桥）。勿引入 electron/节点专用依赖：
// test/batch8-bridge.mjs 会把这一整段从本文件抠出来单独求值测试，
// 改这里的同时要保证该测试仍然通过。
//
// 语义与 src/clipboard.mjs 的 ClipboardWatcher.check() 完全一致：空文本或
// 与上次相同 → 不动作、last 不变；否则 last 前进为本次全文（即使首行不是
// URL），首行 trim 后匹配 ^(https?|ftp)://\S+$ 才投递。桌面桥与 daemon 侧
// watcher 必须共用同一套去重/正则语义，同一次复制的行为才不会分叉。
const CLIPBOARD_URL_RE = /^(https?|ftp):\/\/\S+$/i;

/** 桥接轮询周期（毫秒），与 src/clipboard.mjs ClipboardWatcher 的默认 1500 相同。 */
const CLIPBOARD_POLL_MS = 1500;

/**
 * 回环地址判定（第10项收口加固，与 src/util.mjs 的 isLoopbackUrl 语义一致）。
 * 桌面桥不 import src（避免把 daemon 拉进 GUI 进程），故在此本地实现；
 * batch8-bridge 用例钉住两边 host 集一致（localhost / 127.0.0.0/8 / ::1）。
 */
function isLoopbackCandidate(u) {
  let host = "";
  try {
    host = new URL(String(u || "")).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch { return false; }
  if (host === "localhost" || host === "::1") return true;
  return /^127(\.\d+){3}$/.test(host);
}

/**
 * 一次剪贴板轮询的决策（纯函数，回归套件直接测）。
 * 回环 URL 一律不投递（post:null）——API 侧还有同源守卫兜底（api.mjs 422），
 * 这里是源头第一道：本地 dev server 链接不该一复制就变成下载任务。
 * @param {string} text 本次读到的剪贴板全文
 * @param {string} last 上次记录的全文
 * @returns {{ post: string|null, nextLast: string }}
 */
function planClipboardPoll(text, last) {
  const t = typeof text === "string" ? text : "";
  const prev = typeof last === "string" ? last : "";
  if (!t || t === prev) return { post: null, nextLast: prev };
  const candidate = (t.split(/\r?\n/)[0] || "").trim();
  const post = CLIPBOARD_URL_RE.test(candidate) && !isLoopbackCandidate(candidate) ? candidate : null;
  return { post, nextLast: t };
}
// [clipboard-bridge-pure] end

// 背景：daemon 自带的 ClipboardWatcher 经 execFile 派生 powershell.exe 读剪贴
// 板，而本机 0xC0000142 谱系（见下方 shell:openPath 一带的注释、附记十二/十八）
// 下这一血统的 GUI 子进程初始化必败——该 watcher 实际上从未读到过剪贴板。桌面
// 主进程自己持有 electron.clipboard（进程内、零子进程），于是由这里代劳：
//   * daemon ensure 成功后启动 1.5s 轮询（纯决策见 [clipboard-bridge-pure] 段）；
//   * 发现新 URL → POST /api/tasks {url, queueId:"clipboard"}；token/port 每次
//     现取 runtime.json（daemon 重启后 token 必换，复用旧值只会 401）；
//   * 同时 PATCH /api/config {clipboardBridge:true} 落盘，daemon 侧的启动守卫
//     （src/daemon.mjs）据此不再起那条必败的 PowerShell 轮询。
const clipboardBridge = {
  timer: null,      // 轮询 interval（unref，不阻退出）
  last: "",         // 上次读到的剪贴板全文（与 ClipboardWatcher.last 同义）
  started: false,
};

/** 启动桥接轮询；重复调用幂等（daemon:ensure 可能多次成功）。 */
function startClipboardBridge() {
  if (clipboardBridge.started) return;
  clipboardBridge.started = true;
  // "本桌面的剪贴板由我接管"要落盘告知 daemon：daemon 之后（含重启后）不再
  // 起 PowerShell watcher。失败只记日志——桥接照常跑，下次桌面启动会再 PATCH。
  enableClipboardBridgeOnDaemon();
  clipboardBridge.timer = setInterval(() => {
    pollClipboardOnce().catch((err) =>
      logLaunch("clipboard bridge poll failed: " + (err && err.message ? err.message : err)));
  }, CLIPBOARD_POLL_MS);
  clipboardBridge.timer.unref?.();
}

/** 一次轮询：读剪贴板 → 纯决策 → 投递。任何一步失败都不中断轮询循环。 */
async function pollClipboardOnce() {
  let text = "";
  try {
    text = clipboard.readText() || "";
  } catch {
    return;   // 剪贴板暂不可读（锁屏/被占用）：本周期放弃，下周期再试
  }
  const plan = planClipboardPoll(text, clipboardBridge.last);
  clipboardBridge.last = plan.nextLast;
  if (plan.post) await postClipboardTask(plan.post);
}

/** 带 token 的 daemon POST /api/tasks；token/port 现取，失败记日志不抛出。 */
async function postClipboardTask(url) {
  const rt = (manager.rt && manager.rt.port && manager.rt.token)
    ? manager.rt
    : (await readRuntime());
  if (!rt || !rt.port || !rt.token) {
    logLaunch("clipboard bridge: daemon runtime unavailable, dropped " + url);
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`http://${rt.host || "127.0.0.1"}:${rt.port}/api/tasks`, {
      method: "POST",
      headers: { "x-downloadx-token": rt.token, "content-type": "application/json" },
      body: JSON.stringify({ url, queueId: "clipboard" }),
      signal: controller.signal,
    });
    if (res.status === 201 || res.status === 202) {
      logLaunch("clipboard bridge: queued " + url);
      return true;
    }
    // 409 = 同链接已在队列（API 的 live guard），与 daemon 侧 watcher 的
    // existing 去重同义：静默即可，不该打扰用户。
    logLaunch("clipboard bridge: POST /api/tasks -> HTTP " + res.status + " for " + url);
    return false;
  } catch (err) {
    logLaunch("clipboard bridge: POST failed: " + (err && err.message ? err.message : err));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** PATCH /api/config {clipboardBridge:true}：让 daemon 侧启动守卫（P-25）生效。 */
async function enableClipboardBridgeOnDaemon() {
  const rt = (manager.rt && manager.rt.port && manager.rt.token)
    ? manager.rt
    : (await readRuntime());
  if (!rt || !rt.port || !rt.token) {
    logLaunch("clipboard bridge: cannot PATCH config, daemon runtime unavailable");
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`http://${rt.host || "127.0.0.1"}:${rt.port}/api/config`, {
      method: "PATCH",
      headers: { "x-downloadx-token": rt.token, "content-type": "application/json" },
      body: JSON.stringify({ clipboardBridge: true }),
      signal: controller.signal,
    });
    if (res.status !== 200) throw new Error("HTTP " + res.status);
    logLaunch("clipboard bridge: daemon config.clipboardBridge=true");
    return true;
  } catch (err) {
    logLaunch("clipboard bridge: PATCH config failed: " + (err && err.message ? err.message : err));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---- SSE 订阅与重连 -------------------------------------------------------

function startEventFeed(rt) {
  trayFeed.stopped = false;
  scheduleFeedConnect(0, rt || null);
}

function stopEventFeed() {
  trayFeed.stopped = true;
  trayFeed.generation += 1;
  if (trayFeed.abort) { try { trayFeed.abort.abort(); } catch { /* 已断 */ } trayFeed.abort = null; }
  if (trayFeed.reconnectTimer) {
    clearTimeout(trayFeed.reconnectTimer);
    trayFeed.reconnectTimer = null;
  }
}

/** daemon 重启成功（新 port/token）后弃旧连接，立即用新 rt 重连。 */
function kickEventFeed(rt) {
  trayFeed.generation += 1;   // 旧连接的回调与重连排程全部作废
  if (trayFeed.abort) { try { trayFeed.abort.abort(); } catch { /* 已断 */ } trayFeed.abort = null; }
  if (trayFeed.reconnectTimer) {
    clearTimeout(trayFeed.reconnectTimer);
    trayFeed.reconnectTimer = null;
  }
  if (trayFeed.stopped || quitting) return;
  scheduleFeedConnect(0, rt || null);
}

function nextFeedBackoff() {
  const ms = FEED_RECONNECT_MS[Math.min(trayFeed.backoffIdx, FEED_RECONNECT_MS.length - 1)];
  trayFeed.backoffIdx += 1;
  return ms;
}

function scheduleFeedConnect(delayMs, rt) {
  if (trayFeed.stopped || quitting) return;
  if (trayFeed.reconnectTimer) clearTimeout(trayFeed.reconnectTimer);
  trayFeed.reconnectTimer = setTimeout(() => {
    trayFeed.reconnectTimer = null;
    connectEventFeed(rt).catch((err) =>
      logLaunch("event feed connect crashed: " + (err && err.message ? err.message : err)));
  }, delayMs);
}

/**
 * 建立一条 SSE 连接并消费到断流为止。断流（daemon 停止/网络抖动）后按
 * 退避重连；重连前重读 runtime.json——daemon 重启后 port/token 都会换，
 * 旧 token 对新 daemon 一律 401，所以不能复用旧连接参数。
 */
async function connectEventFeed(rt) {
  if (trayFeed.stopped || quitting) return;
  if (!rt || !rt.port || !rt.token) rt = await readRuntime();
  if (trayFeed.stopped || quitting) return;
  if (!rt || !rt.port || !rt.token) {
    scheduleFeedConnect(nextFeedBackoff(), null);   // 尚无可用 daemon：稍后再试
    return;
  }
  const gen = ++trayFeed.generation;
  const abort = new AbortController();
  if (trayFeed.abort) { try { trayFeed.abort.abort(); } catch { /* 已断 */ } }
  trayFeed.abort = abort;

  const connectTimer = setTimeout(() => abort.abort(), 10_000);   // 建连超时
  try {
    const res = await fetch(
      `http://${rt.host || "127.0.0.1"}:${rt.port}/api/events?token=${encodeURIComponent(rt.token)}`,
      { signal: abort.signal, headers: { accept: "text/event-stream" } },
    );
    clearTimeout(connectTimer);   // 已收到响应头，建连超时不再适用
    if (res.status !== 200 || !res.body) throw new Error("HTTP " + res.status);
    trayFeed.backoffIdx = 0;      // 连上了，退避清零
    trayFeed.speedLimit = null;   // 换了 daemon（可能全新），配置缓存作废
    rebuildTrayMenu().catch(() => {});
    logLaunch("event feed connected: " + (rt.host || "127.0.0.1") + ":" + rt.port);

    const parser = createSseParser((evt) => {
      if (gen === trayFeed.generation) handleFeedEvent(evt);
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.flush();
  } catch (err) {
    // 主动弃连（退出/换了新 daemon 代次）不重连；其余断流都退避重连。
    if (abort.signal.aborted && gen !== trayFeed.generation) return;
    logLaunch("event feed ended: " + (err && err.message ? err.message : err));
  } finally {
    clearTimeout(connectTimer);
    if (trayFeed.abort === abort) trayFeed.abort = null;
  }
  if (!trayFeed.stopped && !quitting && gen === trayFeed.generation) {
    scheduleFeedConnect(nextFeedBackoff(), null);
  }
}

// ---- 事件 → 气泡/菜单 -----------------------------------------------------

function handleFeedEvent(evt) {
  const hit = classifyTaskEvent(evt, trayFeed.seen);
  if (!hit) return;
  const { kind, task } = hit;
  const name = (task.filename && String(task.filename)) || task.id || "未知文件";
  if (kind === "complete") {
    trayFeed.recent = pushRecent(
      trayFeed.recent,
      { id: task.id, filename: name, dir: task.dir ? String(task.dir) : "" },
      RECENT_MAX,
    );
    rebuildTrayMenu().catch(() => {});   // “最近完成”立即更新
    trayFeed.lastBalloon = { action: "open-task", taskId: task.id, dir: task.dir || "", filename: name };
    showTrayBalloon("info", "下载完成：" + name);
  } else {
    trayFeed.lastBalloon = { action: "raise-window" };
    showTrayBalloon("error", "下载失败：" + name);
  }
}

function showTrayBalloon(iconType, content) {
  try {
    if (!tray) return;
    tray.displayBalloon({ title: "飞流下载器", iconType, content });
  } catch (err) {
    logLaunch("tray balloon failed: " + (err && err.message ? err.message : err));
  }
}

/** 气泡点击分派：完成 → 打开文件（打不开再抬窗兜底）；其余 → 抬主窗口。 */
function onBalloonClick(act) {
  if (act && act.action === "open-task") {
    openTaskFile(act.taskId, act)
      .then((opened) => { if (!opened) showMainWindow(); })
      .catch(() => showMainWindow());
    return;
  }
  showMainWindow();
}

/**
 * 打开任务的最终文件：先问 daemon 要权威路径 /api/tasks/:id/location
 * （它考虑了分类子目录与“名称 (n).ext”改名），daemon 不可达时退回事件
 * 里带的 dir+filename。文件已不存在则退而打开所在目录。
 * 返回是否真的打开了东西。
 */
async function openTaskFile(taskId, fallbackEntry) {
  const cfg = await fetchDaemonJson("/api/tasks/" + encodeURIComponent(taskId) + "/location");
  if (cfg && cfg.path && cfg.exists) {
    const err = await shell.openPath(cfg.path);
    if (!err) return true;
    logLaunch("openPath failed for " + cfg.path + ": " + err);
    return false;
  }
  if (cfg && cfg.dir) {
    const err = await shell.openPath(cfg.dir);
    if (!err) return true;
  }
  if (fallbackEntry && fallbackEntry.dir && fallbackEntry.filename) {
    const p = path.join(fallbackEntry.dir, fallbackEntry.filename);
    const err = await shell.openPath(p);
    if (!err) return true;
    logLaunch("fallback openPath failed for " + p + ": " + err);
  }
  return false;
}

// 开机自启以 --hidden 启动：只起托盘和 daemon，不弹主界面。
if (process.argv.includes("--hidden")) {
  app.whenReady().then(() => {
    if (mainWindow) mainWindow.hide();
  }).catch(() => {});
}
// 用户没带 --hidden 时，首次点 X 之前窗口正常显示。

// ---------------------------------------------------------------- daemon 崩溃监督（包4）

/**
 * DaemonManager 自动重启成功（或改为复用外部实例）后回调。
 * 重启后的 runtime.json 是新 pid/port/token：expectedOrigin 变化时同步切换
 * 导航白名单；并整页重载窗口。重载是无条件的——新 daemon 必然签发了新
 * token（src/api.mjs 每次 listen 生成），即便端口恰好复用，旧页面里的
 * token 也已失效，必须重载才能让渲染层拿到注入的新 token。
 */
async function handleDaemonRestarted({ rt, owned, reused, attempt } = {}) {
  if (!rt || !rt.port) return;
  const origin = `http://${rt.host || "127.0.0.1"}:${rt.port}`;
  const originChanged = origin !== expectedOrigin;
  expectedOrigin = origin;
  logLaunch("daemon restarted: attempt=" + attempt +
    " result=" + (owned ? "owned" : "adopted-external") +
    " origin=" + origin + " changed=" + originChanged);
  // 新 daemon 新 token：事件流立即切到新连接，菜单按新配置重画。
  kickEventFeed(rt);
  rebuildTrayMenu().catch(() => {});
  if (quitting) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      await mainWindow.loadURL(rt.url);
    } catch (loadErr) {
      logLaunch("reload after daemon restart failed: " + (loadErr && loadErr.message ? loadErr.message : loadErr));
    }
  }
}

/** 3 次退避重启全部失败：托盘气泡告知用户，监督就此止步（不再无限循环）。 */
function handleDaemonGivenUp({ attempts } = {}) {
  logLaunch("daemon supervision gave up after " + attempts + " restart attempts");
  trayFeed.lastBalloon = null;   // 点击这条气泡只抬窗，别串到旧的任务动作
  try {
    if (tray) tray.displayBalloon({
      title: "飞流下载器",
      iconType: "info",
      content: "下载服务已停止，请重启应用",
    });
  } catch (err) {
    logLaunch("tray balloon failed: " + (err && err.message ? err.message : err));
  }
  try {
    if (tray) tray.setToolTip("飞流（下载服务已停止，请重启应用）");
  } catch { /* 尽力而为 */ }
}

// ---------------------------------------------------------------- IPC

ipcMain.handle("daemon:ensure", async () => {
  // 并发去抖：启动期间只允许一次实际拉起。
  if (booting) {
    const rt = manager.rt;
    if (rt && expectedOrigin) return { ok: true, url: rt.url, owned: manager.owned, reused: !manager.owned };
  }
  booting = true;
  try {
    const { rt, owned, reused } = await manager.ensure();
    expectedOrigin = `http://${rt.host || "127.0.0.1"}:${rt.port}`;
    // daemon 就绪即订阅事件流（托盘气泡/最近完成的数据源）并重画菜单——
    // 必须放在 loadURL 之前：即便界面加载失败，daemon 也是活的，托盘反馈
    // 不该跟着界面陪葬。
    startEventFeed(rt);
    rebuildTrayMenu().catch(() => {});
    // P-25：daemon 就绪后剪贴板改由本进程桥接（背景与接线见
    // startClipboardBridge 一节）——daemon 不再依赖必败的 PowerShell 派生。
    startClipboardBridge();
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        await mainWindow.loadURL(rt.url);
      } catch (loadErr) {
        return { ok: false, message: "界面加载失败：" + (loadErr.message || loadErr) + "\n服务地址：" + rt.url };
      }
    }
    return { ok: true, url: rt.url, owned, reused, version: rt.version };
  } catch (err) {
    return { ok: false, message: (err && err.message) || String(err) };
  } finally {
    booting = false;
  }
});

/** 校验 IPC 传入的目标路径：必须是非空绝对路径。 */
function assertLocalPath(target) {
  if (typeof target !== "string" || !target.trim()) {
    throw new Error("路径为空");
  }
  if (!path.isAbsolute(target)) {
    throw new Error("不是绝对路径：" + target);
  }
  return target;
}

// Opening folders / revealing files uses Electron's IN-PROCESS shell APIs only.
// Why no child process: on this machine every explorer.exe (or pwsh→explorer)
// spawned from this app's ancestry dies silently with 0xC0000142 — GUI DLL
// init fails for the whole lineage, intermediaries included (verified
// 2026-10-25: app→powershell→explorer opens nothing, zero errors). The
// earlier verdict that shell.showItemInFolder was "silently broken" came from
// the GamePP-injection era; with GamePP gone the in-process API opens windows
// reliably (verified twice tonight). If it ever regresses, first suspect an
// injector (GamePP/GPP64) is back, not this code.

ipcMain.handle("shell:openPath", async (_event, target) => {
  const p = assertLocalPath(target);
  logLaunch("shell:openPath " + p);
  if (!fs.existsSync(p)) throw new Error("文件不存在：" + p);
  // 无扩展名文件 Windows 无法关联程序,shell 只会弹"服务器运行失败"这类
  // 谜语对话框;在这里用人话拦下,并给出可操作的出路。
  if (!path.extname(p)) {
    throw new Error(
      "该文件没有扩展名，Windows 不知道用什么程序打开（常见于从页面/接口直下的数据）。" +
      "可手动重命名补上扩展名（视频段多为 .mp4），或改用悬浮条重新抓取完整流。"
    );
  }
  // 目录与 showItem 同病(shell.openPath 对目录也可能静默失败):explorer 打开目录。
  if (fs.statSync(p).isDirectory()) {
    shell.openPath(p);
    return { ok: true };
  }
  const err = await shell.openPath(p);
  if (err) throw new Error(String(err));
  return { ok: true };
});

ipcMain.handle("shell:showItem", async (_event, target) => {
  let p = assertLocalPath(target);
  logLaunch("shell:showItem " + p);
  // 规范化:"E:\Downloads\." 这类路径先归一,避免 /select 参数带尾缀歧义。
  p = path.resolve(p);
  if (!fs.existsSync(p)) throw new Error("文件不存在：" + p);
  // Electron 的 shell.showItemInFolder 在本机会静默无效(SHOpenFolderAndSelectItems
  // 无错误可查,2026-10-24 真机实测:IPC 到达、文件存在、Explorer 不开、无任何反馈)。
  // explorer /select,<path> 单参数形式实测可靠;目录则直接打开目录本身。
  if (fs.statSync(p).isDirectory()) {
    shell.openPath(p);
  } else {
    shell.showItemInFolder(p);
  }
  return { ok: true };
});

ipcMain.handle("dialog:pickDir", async (_event, current) => {
  const options = {
    title: "选择保存位置",
    properties: ["openDirectory", "createDirectory"],
  };
  if (current && typeof current === "string" && path.isAbsolute(current)) {
    options.defaultPath = current;
  }
  const result = await dialog.showOpenDialog(mainWindow, options);
  if (result.canceled || !result.filePaths || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("clip:write", async (_event, text) => {
  clipboard.writeText(typeof text === "string" ? text : String(text ?? ""));
  return { ok: true };
});

ipcMain.handle("shell:revealLog", async () => {
  const log = path.join(dataRoot(), "logs", "downloadx.log");
  if (fs.existsSync(log)) {
    // 同 showItem:showItemInFolder 本机静默无效,用 explorer /select。
    shell.showItemInFolder(log);
  } else {
    const dir = path.join(dataRoot(), "logs");
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  }
  return { ok: true };
});

// [task-menu-fallback] begin
// gui/index.html [ui-pure] 段 taskMenuItems 的同语义兜底副本:仅当运行期从
// gui/index.html 提取该段失败(文件缺失/标记丢失)时才启用。两侧语义由
// test/batch10-ui.mjs 用同一批状态逐项比对钉死,改任一侧必须同步另一侧。
function taskMenuItemsFallback(status){
  const items = [];
  if (status==="downloading" || status==="connecting" || status==="queued") items.push({ action:"pause", label:"暂停" });
  if (status==="paused") items.push({ action:"start", label:"继续" });
  if (status==="error") items.push({ action:"retry", label:"重试" });
  if (status!=="complete") items.push({ action:"cancel", label:"取消" });
  if (status==="complete"){
    items.push({ action:"openFile", label:"打开文件" });
    items.push({ action:"showFolder", label:"打开文件夹" });
  }
  items.push({ action:"copyLink", label:"复制下载链接" });
  items.push({ action:"remove", label:"删除" });
  return items;
}
// [task-menu-fallback] end

// 运行期从 gui/index.html 提取 [ui-pure] 段求值(菜单可见性的唯一权威实现)。
// 失败不致命:回退到上面的同语义兜底副本,右键菜单照常可用。
let taskMenuItems = null;
function loadTaskMenuItems() {
  try {
    const html = fs.readFileSync(path.join(__dirname, "..", "gui", "index.html"), "utf8");
    const m = /\/\/ \[ui-pure\] begin[^\n]*\r?\n([\s\S]*?)\/\/ \[ui-pure\] end/.exec(html);
    if (!m) throw new Error("找不到 [ui-pure] 标记段");
    const fn = new Function(m[1] + "\n;return taskMenuItems;")();
    if (typeof fn !== "function") throw new Error("[ui-pure] 段求值结果不是函数");
    taskMenuItems = fn;
    logLaunch("taskMenu: [ui-pure] taskMenuItems loaded from gui/index.html");
  } catch (err) {
    taskMenuItems = null;
    logLaunch("taskMenu: [ui-pure] 提取失败，使用内置兜底副本：" + ((err && err.message) || err));
  }
}
loadTaskMenuItems();

// 任务卡右键菜单(批-10):渲染进程只发上下文 { status },Electron Menu 在主进程
// 构建;点击回传动作名(GUI onAction 的动作名),关闭未点则回 null。
ipcMain.handle("menu:taskActions", async (_event, info) => {
  const status = info && typeof info === "object" && typeof info.status === "string" ? info.status : "";
  const build = taskMenuItems || taskMenuItemsFallback;
  const items = build(status);
  if (!items || !items.length) return null;
  let clicked = null;
  const menu = Menu.buildFromTemplate(items.map((it) => ({
    label: String(it.label || ""),
    click: () => { clicked = String(it.action || ""); },
  })));
  await new Promise((resolve) => {
    try {
      menu.popup({ window: mainWindow || undefined, callback: resolve });
    } catch {
      resolve();   // 无窗口可附着等异常:不当场炸,按“未点击”处理
    }
  });
  return clicked;
});
