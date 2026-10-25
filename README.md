# 飞流 FeiLiu

**飞流(FeiLiu)** 是一个零依赖的 Node.js 多线程下载器:并发分段引擎、断点续传、HLS/DASH 流媒体(含音视频合成)、磁力链接(经 aria2c)、格式转换、多队列、浏览器扩展嗅探与下载接管,并为 AI agent 提供 MCP 接口(stdio 与 HTTP)。

> 项目原名 downloadx,展示层已更名为飞流;内部标识符(native host、数据目录、MCP 工具名)沿用 downloadx 以保持兼容。

English summary below / 英文说明见文末。

---

## 特性

- **引擎**:HTTP/FTP 并发分段(1-32 连接)、每段独立日志崩溃安全、ETag/时间戳陈旧检测、摘要校验 + 跨段边界重读、数据异常自动降级单连接、自适应并发闸门(429/503 减半-恢复)、令牌桶限速(全局/分时段/每任务)、续传失败预算(3 败重下)
- **流媒体**:HLS/DASH 解析与下载、fMP4 box 级无损合成(可选 ffmpeg 兜底)、分片流式落盘(.part+.ok 断点)、AES-128 识别
- **内置/可选 yt-dlp**:1800+ 视频站解析(yt-dlp 未装时给出安装指引)
- **磁力/BT**:magnet:?xt= 与 .torrent 经外部 aria2c 委托,进度/取消/代理透传
- **格式转换**:HandBrake 式固定预设(通用 MP4/H.265 压缩/提取 MP3/GIF),进度标注"约",取消杀进程树,源文件永不改动
- **队列**:多队列分组并发、优先级/排序、ask-before-add 审批(扩展/剪贴板来源)、停机保存护栏
- **浏览器集成**(MV3 扩展):媒体嗅探(fetch/XHR/MSE 三劫持)、下载接管(询问/自动/关闭)、HttpOnly Cookie 透传、跨域重定向凭据剥离 + 认证绑定 CDN 匿名重试
- **Agent 接入**:MCP stdio + HTTP(`POST /mcp`,Bearer 令牌,`/.well-known/downloadx-mcp.json` 自动发现);六工具:download/status/list/control/probe/stream_inspect
- **桌面端**(Windows):Electron 独立窗口、托盘常驻、完成通知、崩溃自动重启 daemon
- **安全**:daemon 仅环回 + 令牌必验(恒时比较)、Host 头校验、DNS rebinding 防护、MCP 无 token 一律 401

## 快速开始

```bash
git clone https://github.com/an2604789-jpg/feiliu.git && cd feiliu
node bin/downloadx.mjs daemon        # 启动守护进程(数据目录 %APPDATA%\downloadx 或 $DOWNLOADX_HOME)
node bin/downloadx.mjs open          # 打开 Web GUI
# 或单次下载:
node bin/downloadx.mjs get "https://example.com/big.iso" -c 16
```

要求:Node.js >= 20。可选增强:ffmpeg(流媒体合成/转换)、aria2c(磁力)。

## 测试

```bash
node test/run.mjs                    # 全量:selftest 293 项 + 24 个回归套件
```

## 代理

代理相关配置在设置页的“网络与安全”区(`config.json` 的 `proxyMode` 与 `proxy`):

- **proxyMode 三态语义**:`system`(默认)=使用系统代理,自动读取系统/浏览器代理设置;`manual`=手动指定代理,始终用下方地址(即 `proxy` 字段);`none`=直连,忽略一切代理。
- **代理地址可携带鉴权凭据**:支持 `http://user:pass@host:port` 与 `socks5://user:pass@host:port` 两种形态,`user:pass` 是代理服务器的鉴权凭据(SOCKS5 走 RFC 1929 用户名/密码握手,HTTP 代理在 CONNECT 时携带 Proxy-Authorization);凭据中的特殊字符需按 URL 百分号编码书写。
- **BT(aria2c)在代理环境下的限制**:磁力链接与 .torrent 委托外部 aria2c 下载,任务或设置中的代理地址会以 `--all-proxy` 透传给 aria2c;但 BitTorrent 协议走 UDP(DHT、tracker)并向 peer 发起直连,在只放行 HTTP CONNECT 的出口(常见云桌面/公司网络)下会一直“零字节”——这是环境限制而非缺陷,需要 BT 可用时请放行 UDP/直连出网。
- **抓取代理(captureProxy)与 upstreamProxy 的关系**:抓取代理(默认关闭)自身出网时,显式配置的上游代理优先(`config.json` 的 `captureProxy.upstreamProxy`);未显式配置时遵循标准环境变量 `HTTPS_PROXY`/`ALL_PROXY`/`HTTP_PROXY`,并遵循 `NO_PROXY`(`*` 表示全部直连,前导点匹配子域)。抓取代理不读取系统/注册表代理设置。

## Linux / 服务器

纯 Node 实现,Linux 开箱即用(剪贴板监控自动降级):

```bash
DOWNLOADX_HOME=~/dx-data node bin/downloadx.mjs daemon
# GUI: 浏览器访问 http://127.0.0.1:<port>(token 见 ~/dx-data/runtime.json)
```

### Linux 服务器部署(systemd 开机自启)

```bash
# 1. clone 仓库
git clone https://github.com/an2604789-jpg/feiliu.git ~/downloadx && cd ~/downloadx

# 2. 建数据根(DOWNLOADX_HOME,路径自定,与下一步保持一致)
mkdir -p ~/dx-data

# 3. 安装 systemd 服务:先编辑 scripts/feiliu.service,把其中的
#    用户名 / 仓库路径 / 数据根三处 <...> 占位替换为实际值,然后:
sudo cp scripts/feiliu.service /etc/systemd/system/
sudo systemctl daemon-reload          # 每次改动单元文件后都重跑这条重载命令
sudo systemctl enable --now feiliu    # 设开机自启并立即启动
journalctl -u feiliu -f               # 跟踪日志
```

远程访问推荐走 SSH 隧道:本机执行 `ssh -L 18080:127.0.0.1:<daemon端口> user@服务器`,浏览器开 `http://127.0.0.1:18080` 即可,daemon 保持仅本机绑定、公网零暴露(端口与 token 见数据根下 `runtime.json`)。

## MCP(agent 接入)

```json
{ "mcpServers": { "downloadx": {
    "command": "node",
    "args": ["<repo>/bin/../mcp/server.mjs"],
    "env": { "DOWNLOADX_HOME": "/path/to/data" } } } }
```

远程:daemon 开启 remoteAccess 后,`POST http://<host>:<port>/mcp`(Bearer token)。

## HTTP API 响应形状

所有 `/api/*` 请求都要求令牌:请求头 `x-downloadx-token: <token>`(或 `?token=`),值见数据根下 `runtime.json`。错误一律返回 `{"error":"..."}` 加对应 HTTP 状态码(401 令牌无效、400 缺参数、404 任务不存在、405 方法/动作不支持、409 冲突;个别响应会附加定位字段,如重复添加任务时 409 附带 `existingTaskId`)。本节仅文档化现状,不改任何返回形状。

**任务类端点**返回包裹对象 `{"task":{...}}`:

| 端点 | 成功响应 |
| --- | --- |
| `POST /api/tasks` | `201 {"task":{...}}`;askBeforeAdd 开启时的扩展来源任务返回 `202 {"pending":{...},"duplicate":bool}`(暂不入队,等待审批) |
| `GET /api/tasks` | `200 {"tasks":[...]}` |
| `GET /api/tasks/:id` | `200 {"task":{...}}` |
| `PATCH /api/tasks/:id` | `200 {"task":{...}}` |
| `POST /api/tasks/:id/start\|pause\|resume\|retry\|move` | `200 {"task":{...}}` |
| `DELETE /api/tasks/:id`(可加 `?deleteFile=1` 连文件一起删) | `200 {"ok":true}` |

**取消** `POST /api/tasks/:id/cancel` 返回扁平对象(与其余任务端点的 `{"task":...}` 包裹不同),取消后任务从队列移除:

```json
{
  "ok": true,
  "cancelled": true,
  "removed": true,
  "id": "t-123",
  "target": "D:/videos/movie.mp4",
  "kind": "http",
  "discarded": ["D:/videos/movie.mp4.downloadx", "D:/videos/movie.mp4.downloadx-part"]
}
```

- `target` 是传输实际使用的输出路径(含重名自动改名后的路径);`kind` 是传输实际运行的协议(`http`/`hls`/`dash`/`ftp`)。
- `discarded` 列出**本次取消真正删除的中间产物**:分段日志(`*.downloadx`)、暂存装配文件(`*.downloadx-part`)、媒体分片目录(`*.parts`)等。只有取消前确实存在、取消后已被删除的路径才会列入;最终成品文件永远不会被 cancel 删除,也永远不会出现在 `discarded` 中。客户端可用它向用户证明删掉了什么。
- 对已完成任务的 cancel 返回 `409`,响应 `{"ok":false,"cancelled":false,"removed":false,"id":...,"status":"complete","error":"task is already complete; cancel does not delete a finished file"}`,文件保留;对不存在的任务返回 `404 {"error":"no such task"}`,与其他任务端点一致。

其余端点(status、queue、config、probe、grab、sniff 等)的返回形状以 `src/api.mjs` 为准。

---

## English

**FeiLiu** is a zero-dependency Node.js download manager: concurrent segmented transfers with per-segment crash-safe journals, integrity verification (origin digests + cross-segment boundary re-read), adaptive concurrency gating, resume-failure budget, HLS/DASH streaming with lossless fMP4 muxing, magnet links via external aria2c, HandBrake-style preset transcoding, multi-queue group concurrency, an MV3 browser extension (media sniffing via fetch/XHR/MSE hooks, download takeover), and MCP access for AI agents over stdio and HTTP with mandatory token auth.

```bash
git clone https://github.com/an2604789-jpg/feiliu.git && cd feiliu
node bin/downloadx.mjs daemon        # start the daemon
node bin/downloadx.mjs open          # open the web GUI
node test/run.mjs                    # 293 self-tests + 27 regression suites
```

Requires Node.js >= 20. Optional: ffmpeg (media mux/transcode), aria2c (magnets). MIT licensed.
