# 媒体输出路径 / 限速 / 重定向凭据 / 媒体 TLS 施工记录

- 项目目录：`C:\Users\Administrator\dhs\downloadx`
- 批次：P2 后续（4 项）
- 施工日期：2026-10-17
- 结论：4 项均已实现并有回归测试覆盖；两条基线命令退出码均为 0。
  **未做独立验收判断，等待复测。**

---

## 1. 修改文件

### 产品代码

| 文件 | 改动 |
|---|---|
| `src/rate.mjs`（新增） | 从 `engine.mjs` 抽出的令牌桶限速器。修复 `want > rate` 时的死循环（`tokens` 上限为 `rate`，大块请求永远无法满足）；新增 `setRate()`；`rate` 仍可直接赋值以兼容 scheduler |
| `src/engine.mjs` | 改为从 `rate.mjs` 导入并重新导出 `RateLimiter`（原导入点不变），净删 22 行 |
| `src/net.mjs` | `readBody(res, limit, {limiter, signal, onBytes})`，限速施加在**读循环内**；新增 `CREDENTIAL_HEADERS`、`sameOrigin()`、`stripCredentialHeaders()`；`requestFollow` 在跨源跳转时剥离凭据头，并通过 `strippedHeaders` 报告被剥离的头名 |
| `src/downloader.mjs` | 新增 `taskRateLimit()`；`resolveTarget()` 支持 `meta.exactTarget`（跳过分类子目录与 `name (2)` 重命名）；HLS/DASH 全链路共用**每任务一个** limiter（主分片、EXT-X-MAP、音频 rendition、DASH 双轨与 init 段） |
| `src/cli.mjs` | `runMediaGet` 在 `-o` 被判定为完整文件路径（且未给 `--filename`）时设置 `meta.exactTarget` |
| `README.md` | 同步限速、输出路径、重定向凭据三节的实际行为 |

### 测试

| 文件 | 说明 |
|---|---|
| `test/media-e2e.mjs`（新增，1054 行） | 25 个测试 + 本地夹具（HLS / DASH / 重定向 / 自签 HTTPS） |
| `test/fixtures/localhost-selfsigned.crt`（新增） | 自签证书，CN=localhost，SAN 含 `127.0.0.1`，3650 天有效 |
| `test/fixtures/localhost-selfsigned.key`（新增） | 对应私钥，仅用于测试 |
| `test/selftest.mjs` | 挂载 4 个新分组（+4 行） |

---

## 2. 行为变化（用户可见）

1. `get <hls-url> -o C:\Downloads\movie.ts` 现在**恰好**写 `C:\Downloads\movie.ts`；
   此前落在 `C:\Downloads\video\movie.ts`，且仍退出 0。
   `-o <目录>` 的目录与分类行为不变。
2. `--limit` / Settings `speedLimit` 现在对 HLS/DASH 生效，且是**任务总带宽**：
   并发分片、DASH 双轨、HLS 独立音轨共用同一 bucket，不随并发倍增。
   实测 4 MiB @ `--limit 1M` → 1297 KiB/s（含 1s 初始突发额度）。
3. 跨源重定向不再转发 `Authorization` / `Cookie` / `Proxy-Authorization` /
   `X-Api-Key` 等凭据头；同源跳转保留全部头（含 `Referer` 与自定义头）。
4. 媒体 `--insecure` 端到端行为经测试固定；默认仍拒绝不受信任证书。

---

## 3. 命令、退出码与结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node test/run.mjs`（基线，改动前） | 0 | 212 passed, 0 failed（2m03s） |
| `node test/run.mjs`（最终） | 0 | **237 passed, 0 failed**（2m21s），+25 项 |
| `node test/acceptance.mjs`（基线，改动前） | 0 | 9 passed, 0 failed（43.4s） |
| `node test/acceptance.mjs`（最终） | 0 | **9 passed, 0 failed**（44.2s） |

结果文件：

- `test/acceptance-runs/2026-10-17T14-09-44-274Z/result.json`
- `test/acceptance-runs/2026-10-17T14-09-44-274Z/RESULT.md`

新测试单独运行：临时 runner 运行 `test/media-e2e.mjs`
→ 25 passed, 0 failed（19.9s，退出码 0）。

---

## 4. 新增测试清单（`test/media-e2e.mjs`）

- **Media output path（6）**
  精确路径落点及字节校验、目录 + 分类、目录 + 分类关闭、
  HLS 自动识别与 `--kind` 一致、DASH 自动识别与 `--kind` 精确路径一致、
  CLI 层 `-o <file>` 与 `-o <dir> --filename` 的分叉。
- **Media rate limiting（8）**
  背压（源流 pull 时间跨度 >= 1.0s 而非瞬间抽干）、大块不死锁、
  `--limit` 生效、Settings `speedLimit` 生效、8 并发不倍增、
  DASH 双轨共享、HLS 音频 rendition 共享、无限速时不节流。
- **Redirect credentials（6）**
  同源保留、跨源剥离（含 4 类凭据头）、链式回到原点不恢复、
  真实下载路径不泄漏、`sameOrigin` 的 scheme / host / 有效端口判定、
  `buildRequestHeaders` 产物正是被剥离对象。
- **Media TLS（5）**
  默认拒绝且零请求完成、`--insecure` HLS 全链（清单 + 分片 + init，
  字节校验且全部 `encrypted`）、`--insecure` DASH 全链（含无 `-k` 时拒绝）、
  CLI `-k` 路径、全局 TLS 环境未被污染。

---

## 5. 反向验证（证明测试非空转）

逐项回退修复后重跑新测试：

| 回退内容 | 结果 |
|---|---|
| `meta.exactTarget` 短路 + 媒体 limiter 置 0 | 8 failed（路径 3 项、限速 5 项） |
| 跨源剥离短路 | 3 failed（全部重定向相关） |
| `rejectUnauthorized` 强制 true | 3 failed（全部 `--insecure` 相关） |

---

## 6. 已知限制

- **限速断言用时间下界**：受初始 1 秒爆发额度影响，测试夹具均设计为
  「内容 > 4 × rate」；上界容差 1.6–1.7 倍，避免慢机器上误报。
  极端负载下时间下界仍可能被环境抖动影响。
- **DASH 限速测试的 `result.bytes`**：合成字节无法 mux，合并失败时报告的是
  单轨大小，故测试改为校验 origin 请求日志确认双轨均已拉取，
  而非依赖输出大小。
- **背压为单元级验证**：实测本机 loopback 内核缓冲可吸收 8 MiB，
  服务端观测不到客户端读侧背压；因此用「源流 pull 时间跨度」
  做确定性验证，未做进程级内存曲线断言。
- **TLS 夹具为仓库内自签证书**：仅用于测试，不代表产品信任链；
  测试内断言 `NODE_TLS_REJECT_UNAUTHORIZED` 与 `NODE_EXTRA_CA_CERTS`
  均未设置。
- **未覆盖**：HLS AES-128 加密分片的限速计时、真实公网 CDN 的重定向链。
- 未执行浏览器级验收（本批次不涉及）。
