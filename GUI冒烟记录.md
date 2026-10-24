# GUI 冒烟记录

> 批次：P2-夜间批次，任务 B
> 记录时间：2026-10-16T13:18:42Z（本轮末次运行）
> 浏览器：**Microsoft Edge 155.0.4283.45**（headless=new，经 DevTools Protocol 驱动）
> 驱动方式：`test/gui-browser-run.mjs`，加载真实页面、真实点击、读回真实 DOM

---

## 0. 结论

**9 项全部通过，0 失败，0 跳过。** 页面是真实加载的，按钮是真实点击的，断言读的是渲染后的 DOM 文本，不是 API 返回码。

```
    PASS  GUI: a URL typed into the box becomes a task on screen
    PASS  GUI: Pause stops the transfer and Resume continues it
    PASS  GUI: a failing download explains itself and offers Retry  (15577ms)
    PASS  GUI: reloading the page keeps every task and its state  (15932ms)
    PASS  GUI: Delete removes the row and keeps the file on disk
    PASS  GUI: an unknown-length download shows bytes, never a fake percentage  (3827ms)
    PASS  GUI: a dragged row changes the persisted queue order  (910ms)
    PASS  GUI: settings saved from the form take effect
    PASS  GUI: the Discover tab lists a media stream and can queue it

  9 passed, 0 failed, 0 skipped
```

**未安装 Chrome，因此只在 Edge 上执行。** 未执行的部分见第 5 节。

---

## 1. 复现方式

```powershell
Set-Location 'C:\Users\Administrator\dhs\downloadx'
node test/run.mjs
```

浏览器用例在 `Browser GUI lifecycle` 分组内；未安装 Chrome/Edge 时会逐项记为该主机的 `SKIP`（附原因），不会记为 PASS。

---

## 2. 六项必需记录

| # | 要求 | 浏览器内实际操作 | 观察到的结果 | 状态 |
|---|---|---|---|---|
| 1 | **添加** | 在 `#urlInput` 中输入 URL，触发 `input` 事件，点击 `#btnAdd` | 列表出现 1 行，`.name` 显示文件名 | PASS |
| 2 | **暂停** | 行内 `button[data-a="pause"]` | 状态变为 `paused`；Detail 列显示「kept for resume」；按钮变为 `start` | PASS |
| 3 | **恢复** | 行内 `button[data-a="start"]` | 该行离开 `paused`；其余任务不受影响 | PASS |
| 4 | **删除** | 行内 `button[data-a="remove"]`，`window.confirm` 返回 false | 该行消失；**下载目录中的文件仍然存在** | PASS |
| 5 | **失败重试** | 源站返回 500 → 行内 `button[data-a="retry"]` | 行显示 `error` 且 Detail 有可读原因；点击后先变 `queued`，随后**该行**变为 `complete` | PASS |
| 6 | **刷新后状态不丢** | `Page.reload`（忽略缓存） | 任务数量一致；每个任务的 `名称=状态` 快照与刷新前**完全一致**；失败任务的错误文本仍在 | PASS |

第 5 项按任务名称（`tr[data-id]`）判定，等待的是**被重试的那一行**变为 `complete`，不是「列表里出现了某个 complete」。这是本轮修掉的一个真实缺陷，见第 4 节。

### 另有 3 项（任务 B 清单内的周边要求）

| 要求 | 操作 | 结果 | 状态 |
|---|---|---|---|
| 未知长度不显示伪造百分比 | 源站发 chunked（无 `Content-Length`） | 该行显示「N received · total length unknown」，**不含任何 `%`** | PASS |
| 队列排序入口可用 | 对真实行派发 `dragstart`/`dragover`/`drop`/`dragend` | 被拖的行落在目标行原位，**刷新后仍保持**（即已持久化，非前端重排） | PASS |
| Discover 页可发现并提交 | 切到 Discover 标签 → 输入页面 URL → `Find streams` → `Download` | 面板显示 candidate；按钮变为 `Queued` | PASS |

---

## 3. 本轮修复的 GUI 问题

| 问题 | 用户可见现象 | 修复 | 验证用例 |
|---|---|---|---|
| **Retry/Resume 不起作用** | 点击后任务停在 `queued` 永远不动（`queue.start()` 只改状态，从不唤醒调度器） | `start()` 末尾调用 `pump()` | 用例 5、`Queue control` 分组 |
| **`percent` 为 null 时页面崩溃** | 未知长度任务渲染时 `null.toFixed()` 抛异常，整个列表空白 | 未知长度分支不画进度条，改显示已接收字节 | 未知长度用例 |
| **未知长度任务直接失败** | 守护进程对 chunked 响应报「cannot transfer without a known total size」 | 走单遍流式下载，如实报告字节数 | 未知长度用例 |
| **删除语义不明确** | `Del` 只删列表项，文件去向没有说明 | 弹确认框二选一；**保留文件**为默认答案 | 用例 4 |
| **失败任务没有明确的 Retry** | 只有 `Resume`，用户不知道它是否会清掉错误 | 失败行单独提供 `Retry` | 用例 5 |
| **无法指定文件名/目录/连接数** | 只能存到默认目录 | 添加栏增加折叠区，可填文件名、目录、连接数 | — |
| **两个任务写同一文件互相破坏** | 同一 URL 的第二个任务继承第一个的分段日志，交错写入，先完成者删除另一个仍在用的日志 → `ENOENT` | 按目标路径串行化传输 | selftest「two transfers aimed at one file...」 |
| **拖动排序落在错误位置** | drop 时用**缓存的**任务顺序换算目标位置，而列表每 2 秒重渲染、新任务还会插到最前，因此位置常已过期 | 改为读取屏幕上实际渲染的行顺序；失败时提示 `Reorder failed` | GUI「a dragged row changes the persisted queue order」 |
| **Settings 里设的代理不生效** | 下载路径只读任务级代理，从不回退到配置项，GUI 里设置代理后实际仍直连 | 所有请求路径改为 `task.proxy ?? config.proxy` | selftest「a download completes through a SOCKS5 proxy」 |
| **未知长度任务报「unknown length」后直接失败** | 守护进程对 chunked 响应返回「cannot transfer without a known total size」 | 走单遍流式下载（见上） | 未知长度用例 |

---

## 4. 安全边界未改动

- **令牌校验**：`/api/*` 与 `/api/events` 仍要求 `x-downloadx-token`，比较仍为定长常量时间；
- **SSE**：仍按令牌鉴权；事件流只推送任务与进度，不含 Cookie；
- **loopback**：服务仍只监听 `127.0.0.1`；
- 页面注入的令牌脚本位置未变，页面本身不落盘、不写日志。

---

## 5. 未执行 / 已知限制

**未执行：**

1. **未在 Chrome 上执行**——本机未安装 Chrome，只有 Edge 155.0.4283.45。脚本会自动选择已安装的浏览器，Chrome 存在时无需改动。
2. **未以有头（headed）模式人工操作**——全部经 CDP 在 `--headless=new` 下执行。渲染结果通过 DOM 断言核对，但没有肉眼截图。**未截取界面截图。**
3. **未用真实鼠标拖动**——`dragstart`/`drop` 等事件是派发到真实元素上的，但未经由操作系统级鼠标输入。

**已知限制：**

4. 浏览器用例依赖本机能启动 Chromium 系浏览器；在无图形界面的机器上只能记 `SKIP`。
5. `--headless=new` 与有头模式的渲染差异（字体度量、`position: fixed` 的合成）理论上可能影响布局，但不影响本记录中被断言的文本内容与状态。
6. 用例的时序依赖：列表每 2 秒轮询一次，因此用例按 `tr[data-id]` 定位而非行号，避免重排导致的错位。
7. 未覆盖：多窗口同时打开 GUI、浏览器缩放、暗色/亮色主题切换。

---

## 6. 附：修改文件

| 文件 | 改动 |
|---|---|
| `gui/index.html` | 状态渲染、未知长度进度、Retry 按钮、删除确认、添加栏折叠字段、SSE 进度处理 |
| `src/task.mjs` | `taskView()` 增加 `lengthKnown`，未知长度时 `percent` 为 `null` |
| `src/api.mjs` | 运行器记录 `lengthKnown`；未知长度完成后不伪造总长度 |
| `src/queue.mjs` | `start()` 唤醒调度器；显式启动覆盖「全部暂停」；启动时从分段日志恢复真实进度 |
| `src/downloader.mjs` | 未知长度走流式路径；按目标路径串行化传输 |
| `src/store.mjs` | 丢弃时只删普通文件，不再递归删除同名目录 |
| `src/net.mjs` | 新增 SOCKS5 支持（`socksConnect`/`isSocksProxy`）与 `buildRequestHeaders()` |
| `src/history.mjs` | 新增：URL 历史（追加式日志、凭据清理、上限与整理） |
| `src/cli.mjs` | 新增 `doctor` 与 `history` 命令 |
| `src/daemon.mjs` | 加载历史并在任务入队时记录；停止前 flush |
