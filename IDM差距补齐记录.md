# 低成本 IDM 差距补齐记录

> 批次：P2-夜间批次，任务 E
> 记录时间：2026-10-16
> 选取原则：任务书给出的五项中按顺序取最多两项，且每项都必须有对应回归测试和用户可见行为

---

## 0. 选取结果

任务书列出的候选按顺序为：

| 顺序 | 项目 | 本轮结论 | 理由 |
|---|---|---|---|
| 1 | URL 历史持久化 | **已实现** | 真实缺口；日常使用中重复输入/找回同一链接是最大的摩擦点 |
| 2 | GUI 队列拖动排序 | **已存在，本轮修好并补测** | 功能本来就有，但拖动结果会因缓存顺序而过期；本轮修复并首次提供浏览器级证据 |
| 3 | SOCKS5 代理 | **已实现** | 真实缺口；代码里完全没有 SOCKS 相关实现 |
| 4 | 下载前文件头类型预判 | **已存在** | `probe.suspiciousResponseWarning()` 已在用并有测试 |
| 5 | TLS 回退链补充 | **已存在** | `net.mjs` 的 `TLS_PROFILES` 已有三层回退 |

**本轮实际新做两项（第 1、3 项），并修复第 2 项的一个真实缺陷。** 第 4、5 项经核查已具备，不重复实现。

---

## 1. URL 历史持久化

### 用户可见行为

| 行为 | 说明 |
|---|---|
| 自动记录 | 任何进入队列的 URL 都会被记下（GUI 添加、CLI `add`、剪贴板、抓取、捕获、定时任务） |
| CLI 查看与搜索 | `downloadx history`、`downloadx history ubuntu` |
| GUI 查看与搜索 | 侧栏新增 **History** 标签，可输入关键字过滤 |
| 一键重下 | 每条历史右侧的 **Download again** 按钮 |
| 显式清除 | `downloadx history clear` 或 GUI 的 **Clear**（GUI 会先确认） |

### 存储

- 位置：`%APPDATA%\downloadx\history.jsonl`
- 形式：**追加式日志**（每行一条 JSON），崩溃最多丢最后一行，而不是整个文件；
- 上限：默认 500 条，超出后从最旧开始淘汰，并在文件明显超出时自动整理；
- 去重：同一 URL 只保留一条，再次使用会把它移到最前面。

### 安全处理（重要）

历史文件是**明文、用户会读、可能被贴进问题报告**的内容，所以写入前会做清理：

| 输入 | 落盘内容 |
|---|---|
| `https://h.test/f.iso?token=SECRET&arch=x86` | `https://h.test/f.iso?arch=x86&__redacted=1` |
| `https://h.test/f.iso?sig=abc&part=2` | `https://h.test/f.iso?part=2&__redacted=1` |
| `https://user:hunter2@h.test/private.bin` | `https://h.test/private.bin` |
| `https://h.test/f.iso?page=3#frag` | `https://h.test/f.iso?page=3` |

被清理的键包括 `token`、`access_token`、`auth`、`apikey`、`key`、`sig`、`signature`、`secret`、`password`、`session`、`sid`、`code`、`jwt`、`ticket` 等。

保留 `__redacted=1` 标记是**刻意的**：被清理过的 URL 重下时可能需要重新补上令牌，标记让用户能看出原因，而不是面对一个静默失败的下载。

### 回归测试

`test/run.mjs` 的 `URL history` 分组，5 项：

| 用例 | 覆盖 |
|---|---|
| 秘密不会写进历史文件 | 令牌、签名、口令的清理；文件与列表都检查 |
| 历史跨进程存活并按 URL 去重 | 重新 load、顺序保持、再使用提到最前、截断行不致命 |
| 历史文件有上限 | 超过上限后只保留最新 N 条；整理把文件重写为实际条目 |
| 清除是显式且有文件级效果 | `clear()` 真的删掉文件，不只是清空内存 |
| 守护进程记录并入队后能取回 | 真实 daemon 端到端；令牌不泄漏；路由仍要求鉴权；API 清除可用 |

### 本轮修的一个缺陷

**合批写入只落最后一条。** 追加是合批的（50 ms 内多次记录只写一次），但实现只写"当前这一条"，中间那些**直接丢失**——进程内看得到、重新加载就没了。改为维护待写队列，一次写完整批。这个缺陷是本轮新增的测试发现的，修复后重复运行稳定通过。

---

## 2. GUI 队列拖动排序（修复 + 首次提供浏览器证据）

### 功能本来就有

`POST /api/tasks/:id/move` 与 GUI 的 drag 事件处理都在，所以不是新功能。

### 本轮修的缺陷

**落在错误的位置。** drop 处理时把目标行换算成位置，用的是**缓存的** `state.tasks` 顺序，而不是屏幕上用户正在拖的那份。列表每 2 秒重渲染一次，新任务还会插到最前面，因此缓存顺序很容易已经过期——用户把行拖到第 2 位，结果出现在别处。

修复：位置从**当前渲染出的行**（`list.querySelectorAll("tr[data-id]")`）读取。同时失败时会提示「Reorder failed: ...」，而不是静默不动。

### 浏览器级证据（新增）

`GUI冒烟记录.md` 中「队列排序入口可用」一项，通过真实 Edge 派发 `dragstart`/`dragover`/`drop`/`dragend`：

- 拖动后行确实移动了位置；
- **刷新页面后顺序仍然保持**——证明是守护进程持久化的顺序，而不是前端重排；
- 用例按任务 ID 定位并等待列表连续三次读数一致后再拖，消除了竞态（修复前 3 次运行里失败 1 次，修复后连续 3 次通过）。

---

## 3. SOCKS5 代理

### 用户可见行为

```powershell
# 每条命令都可以用
downloadx get https://example.com/big.iso --proxy socks5://127.0.0.1:1080
downloadx add https://example.com/big.iso --proxy socks5://user:pass@127.0.0.1:1080
```

也可以在 GUI 的 **Settings → Proxy** 里设置一次，作用于所有下载。

- 支持 `socks5://` 与 `socks5h://`，大小写不敏感；
- 支持用户名/口令认证（RFC 1929）；
- `http://` 与 `https://` 目标都能走 SOCKS5（SOCKS5 是透明 TCP 中继，TLS 握手在其上完成）；
- 目标主机名以**域名**形式交给代理解析（`socks5h` 行为），本地解析不了的名字也能用；
- 代理口令只用于代理握手，**不会转发给目标服务器**。

### 实现位置

`src/net.mjs`：`socksConnect()` 与 `isSocksProxy()`。**没有引入任何依赖**，按 RFC 1928 / RFC 1929 实现（约 80 行），符合零运行时依赖约束。失败会给出可读原因：

| 情况 | 报错 |
|---|---|
| 目标不可达 | `socks5 proxy could not reach the destination: connection refused` |
| 需要口令但 URL 里没有 | `the socks5 proxy requires a username and password; put them in the proxy URL` |
| 认证被拒 | `socks5 authentication was rejected` |
| 代理拒绝所有方法 | `socks5 proxy refused every offered auth method` |
| 代理 URL 写错 | `socks5 proxy needs host:port` |

### 回归测试

`test/run.mjs` 的 `SOCKS5 proxy` 分组，7 项。测试用**真实的最小 SOCKS5 服务器**（约 70 行，含认证分支），不是打桩：

| 用例 | 覆盖 |
|---|---|
| 只认 SOCKS，不误认 HTTP 代理 | scheme 判定，含大小写与空值 |
| 通过 SOCKS5 完成一次下载 | 端到端字节级校验；代理确实被使用；目标地址正确 |
| 用户名/口令认证被执行 | 凭据送到代理；**且未转发给目标**（断言目标没收到 `Proxy-Authorization`） |
| 拒绝所有方法时明确报错 | 不无限重试 |
| 需要口令但未提供时说清缺什么 | 报错可操作 |
| 目标不可达时说明原因 | 回复码被翻译成文字 |
| 代理 URL 格式错误时明确拒绝 | 不静默失败 |

### 本轮修的两个缺陷

1. **`Settings → Proxy` 完全不生效。** 下载路径只读 `task.proxy`，从不回退到配置里的代理——在 GUI 里设置代理，实际下载仍然直连。现在 11 处调用点都改为 `task.proxy ?? config.proxy`。
2. **只提供 "no auth" 方法。** 需要认证的代理会回 `no acceptable methods`，用户看不出缺的是凭据。现在同时提供两种方法，由代理选择，并给出明确提示。

---

## 4. 未做的两项（已存在，不重复实现）

### 4.1 下载前文件头类型预判

`src/probe.mjs` 的 `suspiciousResponseWarning()` 已实现：请求 `.zip` 却收到 300 字节的 `text/html` 时给出警告。已有单元测试（`test/selftest.mjs`，「a tiny text body for a binary name is flagged as suspicious」）。

本轮**未改动**，因为需求已满足。

### 4.2 TLS 回退链

`src/net.mjs` 的 `TLS_PROFILES` 已有三层：

```
system-default → tls>=1.2 → tls>=1.0
```

`isTlsFailure()` 判定后只在 TLS 类错误上回退。已有测试覆盖。

本轮**未改动**。TLS 默认校验保持不变，`--insecure` 仍需显式启用（本轮没有放宽任何校验）。

---

## 5. 每项的验证方式

```powershell
Set-Location 'C:\Users\Administrator\dhs\downloadx'

node test/run.mjs          # 含 URL history / SOCKS5 / Browser GUI 分组
node test/acceptance.mjs   # 基线，必须仍然全绿
node test/large-file.mjs   # 任务 C 的套件，必须仍然全绿
```

三套件结果见第 6 节。

---

## 6. 本轮三套件最终结果

| 命令 | 结果 | 耗时 |
|---|---|---|
| `node test/run.mjs` | **206 passed, 0 failed** | 约 135 s |
| `node test/acceptance.mjs` | **9 passed, 0 failed** | 约 41 s |
| `node test/large-file.mjs` | **6 passed, 0 failed, 0 skipped** | 约 34 s |

以上为改动完成后的最终一次运行，三条命令退出码均为 0。

---

## 7. 已知限制

1. **URL 历史不含请求头。** 只记录 URL 与文件名，不记录当时的 Referer/Cookie。重下一个需要登录的链接时，认证信息需要由扩展或调用方重新提供。
2. **历史无时间范围过滤。** 只有关键字过滤，没有「仅最近 7 天」之类的条件。
3. **SOCKS5 只实现了 `CONNECT`。** 不支持 `BIND` 与 `UDP ASSOCIATE`（下载不需要）。不支持 SOCKS4/4a。
4. **SOCKS5 未与系统代理设置联动。** `proxyMode: "system"` 只影响 HTTP 代理的取值；SOCKS 需要显式填写。
5. **GUI 排序只在同一次拖放内生效。** 没有键盘可访问的排序方式（无障碍待补）。
6. **未覆盖**：代理链（多跳）、需要 PAC 脚本的场景、历史同步到多台机器。
