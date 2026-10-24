# 飞流 FeiLiu

**飞流(FeiLiu)** 是一个零依赖的 Node.js 多线程下载器:并发分段引擎、断点续传、HLS/DASH 流媒体(含音视频合成)、磁力链接(经 aria2c)、格式转换、多队列、浏览器扩展嗅探与下载接管,并为 AI agent 提供 MCP 接口(stdio 与 HTTP)。

> 项目原名 downloadx,展示层已更名为飞流;内部标识符(native host、数据目录、MCP 工具名)沿用 downloadx 以保持兼容。

English summary below / 英文说明见文末。

---

## 特性

- **引擎**:HTTP/FTP 并发分段(1-32 连接)、每段独立日志崩溃安全、ETag/时间戳陈旧检测、摘要校验 + 跨段边界重读、数据异常自动降级单连接、自适应并发闸门(429/503 减半-恢复)、令牌桶限速(全局/分时段/每任务)、续传失败预算(3 败重下)
- **流媒体**:HLS/DASH 解析与下载、fMP4 box 级无损合成(可选 ffmpeg 兜底)、分片流式落盘(.part+.ok 断点)、AES-128 识别
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

## Linux / 服务器

纯 Node 实现,Linux 开箱即用(剪贴板监控自动降级):

```bash
DOWNLOADX_HOME=~/dx-data node bin/downloadx.mjs daemon
# GUI: 浏览器访问 http://127.0.0.1:<port>(token 见 ~/dx-data/runtime.json)
```

## MCP(agent 接入)

```json
{ "mcpServers": { "downloadx": {
    "command": "node",
    "args": ["<repo>/bin/../mcp/server.mjs"],
    "env": { "DOWNLOADX_HOME": "/path/to/data" } } } }
```

远程:daemon 开启 remoteAccess 后,`POST http://<host>:<port>/mcp`(Bearer token)。

---

## English

**FeiLiu** is a zero-dependency Node.js download manager: concurrent segmented transfers with per-segment crash-safe journals, integrity verification (origin digests + cross-segment boundary re-read), adaptive concurrency gating, resume-failure budget, HLS/DASH streaming with lossless fMP4 muxing, magnet links via external aria2c, HandBrake-style preset transcoding, multi-queue group concurrency, an MV3 browser extension (media sniffing via fetch/XHR/MSE hooks, download takeover), and MCP access for AI agents over stdio and HTTP with mandatory token auth.

```bash
git clone https://github.com/an2604789-jpg/feiliu.git && cd feiliu
node bin/downloadx.mjs daemon        # start the daemon
node bin/downloadx.mjs open          # open the web GUI
node test/run.mjs                    # 293 self-tests + 24 regression suites
```

Requires Node.js >= 20. Optional: ffmpeg (media mux/transcode), aria2c (magnets). MIT licensed.
