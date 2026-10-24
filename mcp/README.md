# DownloadX MCP 接入说明（DX-A1，2026-10-24 更新至批-1 后语义）

把本机 DownloadX 下载引擎包成 **MCP server**，让 DSH / ZCode / Codex / Claude Code / Trae / Qoder
这类 agent 用同一份配置调用它下载。零运行时依赖：MCP 协议手写，`package.json` 里没有 `dependencies`。

**两条通道，同一份工具**：

| 通道 | 适用 | 地址/方式 |
|---|---|---|
| stdio | 本机 agent（客户端负责拉起 server 进程） | `node mcp/server.mjs`，见下文各家配置 |
| **HTTP（新增）** | 本机或**局域网内任意 agent** | `POST http://<host>:<port>/mcp`，Bearer 令牌；GUI「Agent 接入」页可一键复制 |

daemon 不用手动起：stdio 第一次工具调用会自启（`node bin/downloadx.mjs daemon`）；HTTP 端点由
daemon 自身提供（`/mcp`），daemon 没跑时先起 daemon。**同一数据根上只允许一个 daemon**
（单实例锁；第二个启动者会礼让退出并复用健康实例）。

| 文件 | 作用 |
|---|---|
| `mcp/server.mjs` | 工具实现 + stdio 入口。`handleMessage()` 是纯函数，daemon 的 `/mcp` 路由直接复用它 |
| `mcp/client.mjs` | 对 DownloadX HTTP API 的薄封装：读 `runtime.json`、只打环回地址、不跟随重定向 |
| `mcp/daemon.mjs` | `ensureDaemon()`：没有健康 daemon 就自己拉一个，最多等 15 秒 |

## 0. ZCode（本会话所属客户端）

`~/.zcode/cli/config.json` 的 `mcp.servers` 里加（已注册）：

```json
"downloadx": {
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["C:\\Users\\Administrator\\dhs\\downloadx\\mcp\\server.mjs"],
  "env": { "DOWNLOADX_HOME": "D:\\IAM\\downloadx-data" }
}
```

工具名为 `mcp__downloadx__downloadx_list` 这类形式；会话启动时自动连接。
配套技能 `downloadx-download`（`~/.agents/skills/downloadx-download/`）教 agent 何时用哪个工具与边界。

## 1. DSH（本机 GUI）

DSH 的 MCP 只能通过 profile patch 注册：把下面这段粘进
`C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml`。
**当前机器上已按此注册并在运行**（serverName "downloadx"，env 指向 `D:\IAM\downloadx-data`）。

```yaml
- insert:
    - id: mcp-downloadx
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: downloadx
        transport: stdio
        command: C:\Program Files\nodejs\node.exe
        args:
          - C:\Users\Administrator\dhs\downloadx\mcp\server.mjs
        env:
          DOWNLOADX_HOME: C:\Users\Administrator\AppData\Roaming\downloadx
        failOnStartupError: false
        toolCallTimeoutMs: 600000
```

三点必须知道：

1. **transport 只能是 `stdio` 或 `streamable-http`**，DSH 不支持 SSE / WebSocket。本 server 是 stdio。
2. 工具在 DSH 里显示为 **`mcp__downloadx__工具名`**（例如 `mcp__downloadx__downloadx_download`）。
3. **子进程的 env 是被清洗过的**，不是继承来的。需要什么（比如 `DOWNLOADX_HOME`）必须显式写进 `env`，
   否则 server 会用默认数据根 `%APPDATA%\downloadx`。

`toolCallTimeoutMs: 600000` 与工具里 `waitMs` 的上限一致：agent 最多阻塞 10 分钟等一个下载。

## 2. Codex / Claude Code / 通用 MCP 客户端

标准 `mcpServers` 配置，逐字可用（Windows 路径用双反斜杠）：

```json
{
  "mcpServers": {
    "downloadx": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\Administrator\\dhs\\downloadx\\mcp\\server.mjs"],
      "env": {
        "DOWNLOADX_HOME": "C:\\Users\\Administrator\\AppData\\Roaming\\downloadx"
      }
    }
  }
}
```

Claude Code：`claude mcp add-json downloadx '<上面的 JSON 内容>'`，或写进项目根的 `.mcp.json`。
Codex：写进 `~/.codex/config.toml` 的 `[mcp_servers.downloadx]`（`command` / `args` / `env` 同名同义）。
其它客户端只要是「command + args + env，stdio 传输」就照搬。

自检（不需要任何客户端，也不需要公网）：

```bat
node C:\Users\Administrator\dhs\downloadx\mcp\server.mjs --selftest
```

它在临时目录里起独立 daemon + 本地夹具，跑 initialize → tools/list → download → status，
断言文件落盘、sha256 与夹具一致、stdout 全程是合法 JSON-RPC。退出码 0/1。

## 3. 只有 shell 的 agent（兜底，不用 MCP）

```bat
node C:\Users\Administrator\dhs\downloadx\bin\downloadx.mjs get "https://example.com/big.iso" -o "D:\Downloads\big.iso"
node C:\Users\Administrator\dhs\downloadx\bin\downloadx.mjs add "https://example.com/a.mp4"
node C:\Users\Administrator\dhs\downloadx\bin\downloadx.mjs list --json
node C:\Users\Administrator\dhs\downloadx\bin\downloadx.mjs task <id> --json
node C:\Users\Administrator\dhs\downloadx\bin\downloadx.mjs status --json
```

`--json` 的三条输出都是**单行 JSON，可直接 `JSON.parse`**：

- `list --json` → `{"tasks":[taskView...],"count":n}`
- `task <id> --json` → `{"task":taskView}`；id 不存在时 **stderr** 一行
  `{"error":"no such task","code":"ENOTASK"}`，退出码 **2**
- `status --json` → `{"daemon":{"url":...},"queue":{...}}`

task id 支持唯一前缀（`task 644e178a --json` 也行，和表格里显示的 8 位一致）。JSON 里不会出现 token / cookie / password。

## 4. 工具一览

| 工具 | 入参 | 行为 |
|---|---|---|
| `downloadx_download` | `url`(必)、`dir`、`filename`、`headers`、`cookies`、`referer`、`connections`、`speedLimit`、`queueId`、`waitMs`、`allowLarge` | 建任务并开始下载；返回 `taskId`、`status`，终态附 `path`、`sha256` |
| `downloadx_list` | `status`、`limit` | 列任务，直接透传 daemon 的 taskView，不改字段名 |
| `downloadx_status` | `taskId`(必)、`waitMs` | 查单个任务；终态附 `path`、`sha256` |
| `downloadx_control` | `taskId`(必)、`action`=`pause`/`resume`/`retry`/`cancel` | 暂停、继续、重试、取消 |
| `downloadx_probe` | `url`(必)、`headers` | 只探测不落盘：大小、是否支持 Range、MIME、建议文件名 |
| `downloadx_stream_inspect` | `url`(必)、`headers` | 探测页面/流里的 HLS、DASH 候选，不落盘 |

**批-1 之后的新语义（agent 必读）**：

- **同 URL 在途 → 409**：对同一链接重复添加会得到 `409 {"error":"task already in queue","existingTaskId"}`。
  先 `downloadx_list` 查找再决定接管，而不是盲目重加。
- **blob:/data: 与媒体分片在 daemon 核心即被拒**（人话报错并指路悬浮条），不会留下莫名死任务。
- **无扩展名文件名自动按 Content-Type 补扩展名**（如 B 站 CDN 裸 token → `.mp4`）。
- **askBeforeAdd 对 agent 透明**：MCP 添加不带 `extension`/`clipboard` 来源标记，直接入队，
  不进入 GUI 的审批横幅。
- **单实例锁**：同一数据根第二个 daemon 启动即礼让退出（exit 0）——MCP 与桌面版/CLI 不会打架。

**waitMs 语义**（"等到下载完成"只在 MCP 层实现，HTTP API 一个字没改）：

- `0`（默认）：立刻返回，不阻塞对话；`status` 是任务当时的真实状态（通常 `queued`）。
- `>0`：内部轮询 `GET /api/tasks/:id`（250 ms 起，退避上限 2 s），等到 `complete` / `error` 或超时。
- 到终态：返回完整 taskView，外加 `GET /api/tasks/:id/location` 的 `path`，并对磁盘上存在的文件**流式**算 `sha256`。
- 没等到：返回 `{"taskId","status":"running","taskStatus","percent","downloadedBytes","totalBytes",...}`，
  `isError` 为 false —— 这不是错误，再来问一次即可。`taskStatus` 是 daemon 的原话（可能仍是 `queued`）。

**安全边界（写在代码里，不是约定）**：

- `url` 只接受 `http` / `https` / `ftp`；`file:`、`data:`、本地盘符路径直接拒绝。
- 源站声明的体积超过 **2 GB** 直接拒绝，除非显式传 `allowLarge: true`。
- 对 daemon 的请求一律 `http://127.0.0.1:<port>`，`redirect: "manual"`：遇到 3xx 直接报错，不跟。
- token 每次从 `runtime.json` 现读，只放请求头；不进日志、不进 stdout、不进错误消息。

## 5. 能力边界（必读，别误报 bug）

**MCP 直连拿不到浏览器登录态。** 它只是 daemon 的遥控器，daemon 发请求时不带浏览器的 cookie 罐。

- 带 HttpOnly cookie 的站点（B 站大会员、Netflix 之类）：**只能由用户在 Chrome 里点扩展悬浮条投递**，
  下载在浏览器会话里发起，登录态才在。
- agent 想下这类流，两条路：① 先让用户投递，再用 `downloadx_list` 接管；
  ② 显式把 cookie 传给 `downloadx_download` 的 `cookies` 参数 —— **有泄漏风险，不推荐**。
- 同理：`downloadx_probe` / `downloadx_stream_inspect` 探到的结果取决于 daemon 能看到的公开页面，
  登录后才有的清晰度/线路它看不到。

## 6. HTTP 通道（远程 agent / 不限本机）

daemon 自身提供状态化无会话的 MCP Streamable HTTP 端点：

- **端点**：`POST http://<host>:<port>/mcp`，每次一条 JSON-RPC 消息，JSON 应答；
  `GET /mcp` 返回 405（无服务端主动流）。
- **认证**：每个请求必须带 `Authorization: Bearer <token>` 或 `x-downloadx-token: <token>`；
  令牌在 daemon 数据根的 `runtime.json`（GUI「Agent 接入」页可一键复制）。
- **自动发现**：`GET http://<host>:<port>/.well-known/downloadx-mcp.json` 返回端点与认证描述
  （不含令牌）。
- **远程访问开关**：默认关闭，daemon 只绑 127.0.0.1 且拒绝非环回 Host。GUI「Agent 接入」页
  开启 `remoteAccess` 并重启后，daemon 绑定 0.0.0.0，局域网内 agent 可达——令牌仍是每请求必需。
  请只在可信网络开启。
- 与 stdio 通道的工具完全一致（同一个 `handleMessage`）。

## 7. 排错

| 现象 | 处理 |
|---|---|
| 工具返回 `daemon_unavailable` | 附 `hint` 和 `logTail`（daemon 日志最后 20 行）；手动跑 `node bin/downloadx.mjs daemon` 看报错 |
| 工具返回 `redirect_refused` | 有东西在 daemon 端口上做重定向，通常是代理或端口被别的进程占了；检查 `runtime.json` 的端口 |
| 工具返回 `ETOOLARGE` | 源站声明超过 2 GB；确认要下再传 `allowLarge: true` |
| 客户端连不上 server | stdout 被别的东西污染了；`console.log` 一律不许用，日志走 stderr |
| 想在别的数据目录上跑 | 改 `env.DOWNLOADX_HOME`；不写就用 `%APPDATA%\downloadx` |
