// preload.cjs
//
// 在 contextIsolation=true、nodeIntegration=false、sandbox=true 的前提下，
// 仅通过 contextBridge 暴露“UI 完成任务所必需”的最小桌面能力白名单。
// 渲染页面（含 daemon 提供的 GUI）拿不到 Node、require、child_process 等。
//
// 沙箱 preload 运行在 CommonJS 环境，因此本文件使用 .cjs 与 require。

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("downloadx", {
  /** 让 GUI 识别自己运行在桌面容器中（浏览器打开时不显示桌面专属按钮）。 */
  isDesktop: true,
  platform: process.platform,

  /** 启动 / 复用后台下载服务，返回 { ok, url, owned, reused } 或 { ok:false, message }。 */
  ensureDaemon: () => ipcRenderer.invoke("daemon:ensure"),

  /** 用系统默认程序打开已下载文件。参数必须是绝对路径。 */
  openPath: (target) => ipcRenderer.invoke("shell:openPath", String(target ?? "")),

  /** 在资源管理器中定位并选中文件（打开所在文件夹）。 */
  showItem: (target) => ipcRenderer.invoke("shell:showItem", String(target ?? "")),

  /** 弹出“选择文件夹”对话框，返回所选目录绝对路径或 null。 */
  pickDirectory: (current) => ipcRenderer.invoke("dialog:pickDir", current ? String(current) : null),

  /** 复制文本到系统剪贴板（用于复制下载链接）。 */
  copyText: (text) => ipcRenderer.invoke("clip:write", String(text ?? "")),

  /** 在资源管理器中打开日志所在目录（启动失败诊断用）。 */
  revealLog: () => ipcRenderer.invoke("shell:revealLog"),

  /**
   * 任务卡右键菜单（批-10）：传入 { status }，主进程按状态构建原生菜单并
   * 弹出，返回被点击的动作名（无点击/菜单关闭返回 null）。动作名与 GUI 行内
   * 按钮 data-a 一致，由渲染进程回放到 onAction 单一入口。
   * @param {{ status: string }} info
   * @returns {Promise<string|null>}
   */
  taskActions: (info) => ipcRenderer.invoke("menu:taskActions", info && typeof info === "object"
    ? { status: String(info.status ?? "") } : { status: "" }),
});
