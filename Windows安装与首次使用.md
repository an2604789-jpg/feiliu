# Windows 安装与首次使用

> 适用版本：DownloadX 桌面版 1.0.0（Electron）。
> **普通用户请直接看下面「桌面版」章节：双击即用，无需安装 Node.js。**
> 后半部分是开发者从源码运行命令行 / Web GUI 的说明。
> 文中不含任何真实 Cookie、令牌或私人 URL。

---

## 桌面版（普通用户推荐）

桌面版是一个独立的 Windows 窗口程序：界面始终在 DownloadX 自己的窗口内，
不依赖、也不会弹出 Edge/Chrome 等外部浏览器。下载引擎、daemon、队列、断点
续传、定时与持久化均沿用原项目实现，未重写下载核心。

### 一、三种运行方式

**方式 1：便携版（单文件，免安装，推荐）**

- 双击 `release\DownloadX-Portable-1.0.0-x64.exe`（约 96 MB）。
- 程序先自解压到临时目录，随后打开「DownloadX 下载管理器」窗口（首次约几秒）。
- 关窗即退出，不写注册表、不创建系统服务；可复制到任意目录或 U 盘使用。

**方式 2：解包版（目录直接运行）**

- 双击 `release\win-unpacked\DownloadX.exe`。

**方式 3：从源码运行 / 构建（开发者）**

```powershell
Set-Location 'C:\Users\Administrator\dhs\downloadx'
npm install --registry=https://registry.npmmirror.com
npm run desktop          # 开发态直接启动桌面窗口
npm run desktop:dir      # 产出解包版 release\win-unpacked\
npm run desktop:build    # 产出便携版 release\DownloadX-Portable-1.0.0-x64.exe
```

> 国内网络下 electron 下载慢时，可设置：
> `$env:ELECTRON_MIRROR="https://cdn.npmmirror.com/binaries/electron/"`
> 以及 `$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"`。

### 二、数据目录与升级

- 数据统一保存在 `%APPDATA%\downloadx\`，可用 `DOWNLOADX_HOME` 环境变量覆盖。
- 重新解压、升级或重装程序都不会清空该目录，队列与设置会保留。

### 三、后台服务（daemon）行为

- 启动时若检测到已在运行且健康的本机服务，窗口会**直接复用**，不重复启动。
- 若没有可用服务，则在后台自行拉起；关窗时仅停止**自己拉起的**实例，复用的
  既有服务保持运行。
- 服务只监听 `127.0.0.1`，以随机令牌校验本地请求，不暴露公网，令牌不入日志。

### 四、隐私与默认行为

- **默认不启动抓取代理、不安装浏览器扩展、不自动抓取其他应用流量**；这些功能
  需在对应页面手动开启。
- 「剪贴板监视」是 DownloadX 自有本地功能，可在「设置 → 自动行为」一键关闭，
  界面同时醒目标注抓取代理默认关闭。
- 界面只允许在本机服务地址内导航，外部重定向与弹窗一律拦截。

### 五、首次使用

1. 双击启动后，窗口顶部显示总览（进行中数量 / 总速度 / 已完成）。
2. 顶部输入框粘贴下载地址，回车或点「新建下载」，在对话框确认保存位置、连接数
   后开始。
3. 任务行提供暂停 / 继续、重试、取消、打开文件、打开文件夹、复制链接、移除等。
4. 左侧导航可切换全部 / 进行中 / 队列中 / 已完成 / 出错，以及设置、媒体嗅探、
   历史、定时、抓取代理、日志等页面。
5. 关窗后任务状态落盘；支持续传的服务器下次启动可从断点恢复。

---

---

## 命令行 / 源码方式（开发者）

以下章节描述从源码以命令行方式运行 daemon 与 Web GUI 的流程，桌面版普通用户
无需这些步骤。

## 1. 前提条件

| 项目 | 要求 | 检查命令 | 期望输出 |
|---|---|---|---|
| Node.js | **20 或更高**（开发与实测环境为 v24.19.0） | `node --version` | `v20.x` 以上 |
| 操作系统 | Windows 10 / 11 | — | — |
| ffmpeg | 可选 | `ffmpeg -version` | 有版本号即可 |

**ffmpeg 是可选的。** 只有「自适应视频（HLS/DASH）需要把音视频两条轨道合成一个文件」时才会用到它：

- 没有 ffmpeg：视频与音频会作为**两个独立文件**保留，界面和 CLI 会明确说明这一点，不会谎报成功；
- 有 ffmpeg：自动合成单文件。

检查工具链是否就绪：

```powershell
Set-Location 'C:\Users\Administrator\dhs\downloadx'
node bin/downloadx.mjs doctor
```

`doctor` 会逐项检查 Node、运行目录、下载目录、守护进程、API、native host 和 ffmpeg，**每一项不合格都会直接给出修复命令**。全部正常时退出码为 0。

---

## 2. 六步完成第一次下载

### 第 1 步：启动 daemon

```powershell
Set-Location 'C:\Users\Administrator\dhs\downloadx'
node bin/downloadx.mjs daemon
```

也可以双击仓库根目录的 `downloadx.cmd`。

输出示例：

```
  downloadx daemon
  gui:   http://127.0.0.1:14168/
  token: <本机随机令牌>
  pid:   38292

  Ctrl-C to stop.
```

**这个窗口必须保持打开**：daemon 是实际执行下载的进程，关掉窗口下载就停了（已下载的部分会保留，下次可继续）。

### 第 2 步：打开 GUI

另开一个窗口：

```powershell
npm run gui
```

或者直接在浏览器里打开上一步打印的 `http://127.0.0.1:<端口>/` 地址。

### 第 3 步：注册 native host（扩展要用才需要）

如果只是用 GUI 或命令行，**可以跳过这一步**。

```powershell
node extension/install.mjs status     # 先看当前状态
node extension/install.mjs install --extension-id <扩展ID>
```

`--extension-id` 的取值方法：

1. 浏览器打开 `chrome://extensions`（Edge 为 `edge://extensions`）；
2. 打开右上角「开发者模式」；
3. 「加载已解压的扩展程序」→ 选择 `C:\Users\Administrator\dhs\downloadx\extension`；
4. 扩展卡片上会显示一串由字母组成的 ID，把它填进上面命令的 `<扩展ID>`；
5. 重新加载扩展，并**重启浏览器**（浏览器只在启动时读取注册表）。

`status` 的输出用三种标记区分状态：

```
  [x] Chrome     ...  注册了，并且可用
  [!] Edge       ...  注册了，但不可用（会打印具体原因和修复命令）
  [ ] Chromium   ...  没有注册
```

### 第 4 步：验证一次下载

在 GUI 顶部的输入框粘贴一个 URL，按回车或点 **Add**。任务会立刻出现在列表里，状态依次是 `queued → connecting → downloading → complete`。

命令行等价做法：

```powershell
node bin/downloadx.mjs add https://example.com/big.iso
node bin/downloadx.mjs list
```

### 第 5 步：确认结果

完成后列表会显示文件大小和 SHA-256 前 12 位。文件在：

- GUI 里「Settings → Default folder」显示的目录（默认 `%USERPROFILE%\Downloads`）；
- 或在添加任务时于「Save as / folder / connections」里单独指定的目录。

### 第 6 步：停止 daemon

```powershell
node bin/downloadx.mjs stop
```

在 daemon 窗口按 `Ctrl-C` 效果相同。

停止时正在进行的任务会被标记为 `paused`，**已下载的字节不会丢失**；下次启动 daemon 后点 **Resume** 即可从断点继续。

---

## 3. 运行时目录

所有状态都在一个数据根目录下。默认位置：

```
%APPDATA%\downloadx
```

（`%APPDATA%` 通常是 `C:\Users\<用户名>\AppData\Roaming`。）

可以用环境变量改写：

```powershell
$env:DOWNLOADX_HOME = 'D:\downloadx-data'
```

| 路径 | 内容 | 删除的后果 |
|---|---|---|
| `%APPDATA%\downloadx\config.json` | 设置（默认目录、并发数、代理等） | 恢复出厂设置，**下载的文件不受影响** |
| `%APPDATA%\downloadx\queue.json` | 任务列表与顺序 | 任务列表清空，**已下载的文件不受影响** |
| `%APPDATA%\downloadx\tasks\` | 抓取器（grabber）的项目数据 | 丢失抓取项目 |
| `%APPDATA%\downloadx\logs\downloadx.log` | 运行日志（2 MiB 轮转，保留 1 份历史） | 丢失诊断信息 |
| `%APPDATA%\downloadx\runtime.json` | daemon 的端口与令牌，每次启动重写，停止时删除 | 客户端找不到 daemon |
| `%APPDATA%\downloadx\schedules.json` | 定时动作（定时暂停/恢复等） | 定时设置丢失 |
| `%APPDATA%\downloadx\host\` | 写给各浏览器的 native host 清单（仅在注册过之后才存在） | 扩展无法连接，重新 `install` 即可 |

**下载文件本身不在这个目录里**，而在 `defaultDir`（默认 `%USERPROFILE%\Downloads`）或你指定的目录。

### 分段续传状态

每个未完成下载会在**目标文件旁边**建立一个同名目录：

```
<文件名>.downloadx/
  state.json          分段计划（大小、ETag、段边界）
  segments/00000.json 每段已下载的字节数
```

这是断点续传的依据。传输完成后该目录会自动删除；如果要彻底放弃某个下载，可以连同半成品文件一起删掉。

---

## 4. 诊断

```powershell
node bin/downloadx.mjs doctor
```

输出示例（**真实输出，令牌已省略**）：

```
  downloadx doctor

  [ok]  node            v24.19.0
  [ok]  runtime dir     C:\Users\Administrator\AppData\Roaming\downloadx
  [ok]  download folder C:\Users\Administrator\Downloads
  [ok]  daemon          running at http://127.0.0.1:6172/ (pid 59404)
  [ok]  api             responding; 0 task(s), 0 active
  [ok]  ffmpeg          ffmpeg
  [ok]  native host     usable for Firefox

  everything needed to download is working.
  no cookie, token or private URL is shown here.
```

出问题时的输出（同样是真实输出：

```
  [!!]  download folder C:\...\not-a-dir\sub is not writable  -> change it in the GUI Settings, or with: downloadx config defaultDir=<path>
  [--]  daemon          not running  -> start it with: node bin/downloadx.mjs daemon   (or downloadx.cmd)
```

标记含义：

| 标记 | 含义 | 是否计入失败 |
|---|---|---|
| `[ok]` | 正常 | 否 |
| `[--]` | 尚不需要（例如 daemon 还没启动过） | 否 |
| `[!!]` | 有问题，后面一定有修复命令 | 是（退出码 1） |

`doctor` **不会**打印 Cookie、令牌或私人 URL。

### 其他常用诊断命令

```powershell
node bin/downloadx.mjs status     # daemon 与队列概况
node bin/downloadx.mjs list       # 任务列表
node bin/downloadx.mjs doctor     # 全链路检查
node extension/install.mjs status # native host 注册详情
```

日志在这里：

```
%APPDATA%\downloadx\logs\downloadx.log
```

---

## 5. 升级

1. 用新版本覆盖程序文件（`bin/`、`src/`、`gui/`、`extension/`、`*.cmd`、`package.json`）；
2. 重新注册 native host（清单里写有 host.mjs 的路径，覆盖后路径可能变化）：

   ```powershell
   node extension/install.mjs install --extension-id <扩展ID>
   ```

3. 重启 daemon：`node bin/downloadx.mjs stop`，再 `node bin/downloadx.mjs daemon`。

**升级不会动用户数据。** `config.json`、`queue.json` 和未完成的续传状态都会保留；配置项有默认值兜底，旧配置缺少新字段时会自动补上。如果新版引入的字段影响了行为，`doctor` 和 GUI Settings 会显示出实际生效的值。

---

## 6. 卸载

### 只卸载浏览器集成

```powershell
node extension/install.mjs uninstall
```

这会删除各浏览器注册表键 `HKCU\Software\<浏览器>\NativeMessagingHosts\com.downloadx.host`，并**明确打印**用户数据仍然保留。

### 完全卸载

```powershell
# 1. 停止 daemon
node bin/downloadx.mjs stop

# 2. 移除浏览器注册
node extension/install.mjs uninstall

# 3. 删除程序文件
Remove-Item -Recurse -Force 'C:\Users\Administrator\dhs\downloadx'

# 4. 如确认不再需要，再删除用户数据（可选，不可恢复）
Remove-Item -Recurse -Force "$env:APPDATA\downloadx"
```

### 边界说明

| 内容 | 卸载程序文件后 | 说明 |
|---|---|---|
| 程序文件 | **被删除** | 第 3 步 |
| 浏览器注册表键 | **被删除** | 第 2 步 |
| `%APPDATA%\downloadx\`（配置、队列、日志、续传状态） | **保留** | 需手动删除，见第 4 步 |
| 已下载的文件 | **保留** | 从不在卸载范围内 |
| 半成品文件与 `.downloadx` 续传目录 | **保留** | 位于下载目录，需自行清理 |

出于这个理由，卸载**不会**自动删除任何用户数据：误删一个正在续传的 20 GB 文件是比多留一个目录严重得多的错误。

### 卸载脚本不会做的事

- 不会请求管理员权限；
- 不会删除 `%APPDATA%\downloadx`；
- 不会删除任何已下载的文件或半成品；
- 不会修改系统代理、防火墙或任何系统级设置；
- 不会触碰仓库之外的 `.dsh` 数据。

---

## 7. 常见问题

**daemon 起来后窗口关掉了。**
下载随之停止，已下载的字节保留。重新运行 `node bin/downloadx.mjs daemon`，在 GUI 里点 **Resume** 即可继续。

**GUI 打开是空白页。**
说明 daemon 没在运行。先启动 daemon，再用它打印的地址访问；直接打开 `gui/index.html` 文件是**不能用**的，页面需要 daemon 注入访问令牌。

**扩展点了没反应。**
按顺序检查：`node bin/downloadx.mjs doctor`（daemon 是否在跑）→ `node extension/install.mjs status`（是否为 `[x]`）→ 是否重启过浏览器。扩展的页面角标也会直接显示原因和下一步。

**视频下载下来没有声音。**
HLS/DASH 常把音频放在单独的轨道里，需要 ffmpeg 把两条轨道合成一个文件。没有 ffmpeg 时 downloadx 会**保留两个轨道文件**并把任务标记为失败（而不是交出一个没有声音的文件）。装好 ffmpeg 后重试即可；在任务行上点 **Retry** 会重新下载并合成。

**下载很慢。**
在 Settings 里调大「Connections per download」（上限 32）。部分站点会限制单 IP 连接数，此时调大反而更慢，可以试着调到 4～8。
