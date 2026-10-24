# IDM 与 downloadx：功能对照

本文只写两侧都有实证的部分：
- **IDM 侧**：来自 [IDM-技术架构分析.md](../IDM-技术架构分析.md) 的逆向结论（本机 v6.42.60.3，Ghidra 静态分析 + 官方扩展源码 + 运行时状态文件）
- **downloadx 侧**：来自仓库源码与 166 项自测的实际结果，逐条核对过

标注约定：已实现并验证 / 部分实现有缺口 / 未实现

---

## 一、架构层面

| 维度 | IDM | downloadx | 关系 |
|---|---|---|---|
| 主程序位数 | **32 位 x86**（IDMan.exe 5.76 MB） | 64 位 Node.js | **不同**：IDM 的 32 位带来额外复杂度 |
| 浏览器桥接 | 64 位独立 DLL（IDMIECC64.dll 等），跨位数 IPC | 不需要（主程序已是 64 位） | **省掉了这一层** |
| 网络库链接 | 主 exe 只导入 7 个基础 DLL，**无 WS2_32/WININET/WINHTTP** | 用 Node 内置 http/https/tls | **不同**：IDM 动态加载以便替换 TLS 实现 |
| 自带 TLS 栈 | libcrypto.dll / libssl.dll（OpenSSL 裁剪版，2.1 MB） | 用系统 Node TLS | **不同**：IDM 为兜底自带一份 |
| 内核驱动 | IDMWFP.sys（WHQL 签名，当前运行中）+ IDMTDI.sys | 无，改用**本地捕获代理** | **不同实现，同类目标** |
| 进程模型 | 桌面 GUI 单进程 + 多辅助 exe | 守护进程 + CLI + 浏览器扩展 | **不同**：downloadx 是服务化设计 |
| 语言 | C++（体积优化，5.76 MB） | JavaScript（零依赖，364 KB 源码） | **不同取向** |

### 关键差异说明

**32 位 vs 64 位**：IDM 主程序是 32 位（历史包袱），所以必须为 64 位浏览器做独立的桥接 DLL。
downloadx 直接跑在 64 位 Node 上，**这一整层复杂度不存在**。

**驱动 vs 代理**：这是两者最大的实现分歧。

```
IDM:       浏览器扩展 ──┐
                       ├─→ WFP 内核驱动（截获所有 HTTP 流量）
           非浏览器程序 ┘

downloadx: 浏览器扩展 ──→ native messaging ──┐
                                             ├─→ 守护进程
           任意程序 ────→ 本地代理 :8597 ─────┘
```

IDM 的驱动能自动截获**不遵守系统代理**的程序；downloadx 的代理需要目标程序支持代理设置。
这是两者在覆盖面上的真实差距（详见第四节）。

---

## 二、下载引擎（核心相同点最多）

| 能力 | IDM | downloadx | 说明 |
|---|---|---|---|
| 分段方式 | 标准 HTTP Range | 标准 HTTP Range | **本质相同** |
| Range 格式串 | Range: bytes=%I64d-%I64d | Range: bytes=起点-终点 | **同样的协议** |
| 能力探测 | accept-ranges / content-length | 同样读这两个头 | 相同 |
| 区间校验 | Content-Range | 同 | 相同 |
| 并发数上限 | MaxConnectionsNumber: 32（本机实测） | maxConnections 上限 32 | **数值都一致** |
| 随机写入 | seek 到偏移写入同一文件 | handle.write(buf, 0, len, offset) | **同样的 pwrite 语义** |
| 小文件不分段 | 有 | 小于 1 MiB 用单连接 | 相同策略 |
| 临时目录可配置 | 有，且建议与目标不同盘 | tempDir 配置项 | 配置存在，未强制建议 |
| 大文件超 4GB | 提示需 NTFS | 无显式检查 | 未做 |

**结论**：引擎的协议层两者**没有任何私有差异**——都是并发 Range 请求 + 偏移写入。
这也印证了逆向时的结论：IDM 的分块没有任何私有协议。

---

## 三、断点续传与容错（IDM 更深）

| 能力 | IDM | downloadx | 说明 |
|---|---|---|---|
| 进度持久化粒度 | **每段独立落盘**（DwnlData/名称_ID/） | **每段独立 JSON**（文件名.downloadx/segments/） | **同思路** |
| 启动重建 | 日志显示"重建已下载的文件块..." | loadSegments() 读目录恢复 | 相同 |
| 原子更新 | 未直接观测到 | 写临时文件 + rename | 更明确 |
| 部分数据保留原名 | 是（保留 .zip 原名） | 用 .video.mp4 等中间名 | 命名策略不同 |
| 陈旧数据检测 | 有 ETag/时间戳机制 | validateResume() 比对 ETag/Last-Modified | 同类 |
| **数据损坏→降级单连接** | **有**（"started to download using one connection because of data corruption"） | 有（RangeNotSupportedError 触发） | **都实现了** |
| 降级触发条件 | 多连接数据不一致 | **已对齐**：忽略 Range + 跨段重读发现不一致 | ✅ **已覆盖** |
| 内容摘要校验 | 有组装后校验 | **已修**：解析 Digest/Content-Digest/Repr-Digest/Content-MD5，不匹配则丢弃 | ✅ **已对齐** |
| TLS 重试链 | **5 档**：SSL3→TLS1→SSL3old→TLS1.3→自带 OpenSSL，33 种 Restart type | **3 档**：系统默认→TLS1.2→TLS1.0 | **档位少** |
| 重试退避 | 有 | 指数退避 + 30% 抖动，上限 6 次 | 相当 |

### 这两处差距已修复

**1. `contentDigest` 死代码已修。** probe 现在解析四种标准摘要头
（`Digest` / `Content-Digest` / `Repr-Digest` / `Content-MD5`），
引擎比对 base64 或 hex 任一编码；**不匹配则丢弃文件并报错**，不会把坏文件交给用户。

**2. 降级触发条件已扩展到 IDM 的水平。** 除了「源站忽略 Range」，现在还会在分段完成后
**跨段重读短窗口**并与新请求比对。CDN 漂移导致的「哈希自洽但内容撕裂」现在能被抓到，
抓到后丢弃并降级为单连接重下——实测最终得到的是**某一个完整后端的内容**，而非两版混合。

### 实测证据

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 源站摘要不匹配 | 静默交付坏文件 | 报错 + 删除，无文件落盘 |
| CDN 漂移（4 连接） | 交付两版混合的撕裂文件 | 检测到不一致 → 单连接重下 → 得到完整一致版本 |
| 正常源站 | — | 边界校验 0 不一致，**不误报** |
---

## 四、流量捕获（最大分歧）

| 能力 | IDM | downloadx | 说明 |
|---|---|---|---|
| 浏览器扩展捕获 | Chrome/Edge/Firefox | MV3 扩展（Chrome/Edge/Firefox/Brave） | 相同 |
| 扩展与主程序通道 | **双通道**：WebSocket(127.0.0.1:1001) → native messaging 回退 | **单通道**：native messaging | IDM 多一条 WebSocket 回退 |
| 消息协议 | 紧凑**位置数组**（省带宽） | 标准 JSON（4 字节长度前缀 + JSON） | 取向不同 |
| 注册位置 | HKCU + HKLM，三家浏览器 | HKCU，五家浏览器 | 覆盖面相当 |
| **非浏览器程序截获** | **WFP 驱动，全自动** | **本地代理，需程序支持代理** | **真实差距** |
| HTTPS 可见性 | 驱动层直接可见 | tunnel 模式只见目标；mitm 模式解密（需装 CA） | 需用户决策 |
| 安装成本 | 需 EV 证书 + WHQL 认证 | 零签名 | **downloadx 优势** |
| 端口 | 1001（WebSocket） | 8597（默认，可配） | — |

**为什么 IDM 要驱动**：为了截获**不遵守系统代理**的程序（很多软件自己实现 HTTP 栈，直接连 443）。
这类流量代理看不见，只有内核层能拦。

**这是 downloadx 相对 IDM 唯一实质性缺失的能力。** 但代价是：EV 证书（约 300-600 美元每年）
+ 微软 Partner Center + HLK 测试 + WHQL 认证，且每次改驱动都要重走流程。

**旁证**：XDM（7,978 星）、AB Download Manager（18,467 星）等同类开源项目**都没有驱动**，
全部用"扩展 + 本地回环"方案。

---

## 五、媒体嗅探与流媒体

| 能力 | IDM | downloadx | 说明 |
|---|---|---|---|
| 嗅探注入点 | document_start + 全帧 | document_start | 相同 |
| 劫持对象 | fetch / XMLHttpRequest / MediaSource.addSourceBuffer | 同三个 | **完全一致** |
| 监听标签 | video, audio, object, embed | video, audio, source | 少 object/embed |
| 关注响应头 | date, content-type, content-length | content-type + 扩展名 | 略简 |
| 支持的流格式 | HLS(.m3u8) + DASH(.mpd) | HLS + DASH | 相同 |
| HLS 主/媒体播放列表 | 有 | parseM3u8 支持两级 | 相同 |
| HLS 加密识别 | 未观测到 | EXT-X-KEY 方法/URI 解析 | 有 |
| HLS 初始化段 | 未观测到 | EXT-X-MAP 支持 | 有 |
| DASH SegmentTemplate | 有 | 支持 + SegmentTimeline（含 r 重复） | 相同 |
| DASH 多码率选择 | 有 | selectTracks 按带宽选 | 相同 |
| **音视频双轨合并** | 有 | **有**（ffmpeg 无损 mux） | 都支持 |
| 合并依赖 | **不用外部工具**（自实现 MP4 封装） | **需要 ffmpeg** | **真实差距** |
| 嗅探结果持久化 | 有 | 仅在内存（上限 500 条） | 重启丢失 |

**关于 ffmpeg 依赖**：XDM 的做法是自己在代码里实现 MP4 封装，所以**零外部依赖**。
downloadx 目前调 ffmpeg。好消息是：ffmpeg 缺失时会保留两个轨道文件并**如实报告**，不会假装成功。

---

## 六、批量下载与站点抓取

| 能力 | IDM | downloadx | 说明 |
|---|---|---|---|
| 页面资源收集 | 有（Grabber） | grabPage() 扫属性 + 内联脚本 | 相同思路 |
| 抓取项目存储 | Grabber\Projects\ 独立目录 | 无独立项目概念 | 未做 |
| 多层爬取 | 有 | 仅单页 | 未做 |
| 按类型过滤 | 有 | mediaOnly / extensions | 相同 |
| 批量添加 URL | 有 | CLI 支持多 URL | 相同 |
| 非 HTML 直下 | 有 | 识别为单资源直接入队 | 相同 |

---

## 七、队列、调度与限速

| 能力 | IDM | downloadx | 说明 |
|---|---|---|---|
| 并发任务上限 | 有 | maxConcurrentDownloads（默认 3） | 相同 |
| 队列排序 | 有 | reorder()，API 已暴露 | **GUI 未接** |
| 定时任务 | %APPDATA%\IDM\Scheduler\ | scheduler.mjs，HH:MM 触发 | 相同 |
| 限速 | psnSpeedLimit / Speed Limiter 令牌桶 | RateLimiter 令牌桶，跨 worker 共享 | **同机制** |
| 限速粒度 | 全局 | 全局 + **每任务覆盖** | downloadx 更细 |
| **分时段限速** | 有（计划限速） | **已修**：窗口内自动下发限速到 RateLimiter | ✅ **已对齐** |
| 每服务器连接上限 | 有 | **已修**：按主机累计活跃连接并封顶 | ✅ **已对齐** |
| 代理 | HTTP/FTP/SOCKS，含认证 | HTTP CONNECT 隧道 | **缺 SOCKS** |
| 队列持久化 | 有 | queue.json，崩溃后恢复为暂停态 | 相同 |

---

## 八、其他功能

| 能力 | IDM | downloadx | 说明 |
|---|---|---|---|
| 剪贴板监控 | MonitorUrlClipboard: 1 | ClipboardWatcher，已接入守护进程 | 相同 |
| 分类归档 | 按类型分目录 | categorize() 六个分类 | 相同 |
| 站点例外列表 | urlexclist.dat + ExceptionServers | rules.mjs glob 匹配 | 相同 |
| 站点级覆盖 | 有 | applyRule() 覆盖连接数/头/限速 | 相同 |
| URL 历史持久化 | UrlHistory.txt | 无（仅内存去重） | 未做 |
| 下载前类型预判 | CFormatParsing::PreCheckMpg 等（读文件头） | 仅用 content-type 响应头 | 未做 |
| FTP | 支持 | 支持（PASV/EPSV + REST 续传） | 相同 |
| FTP 主动模式 | 支持 | 不支持（设计选择） | 有意省略 |
| 磁力/BitTorrent | 不支持 | 不支持 | 都不做 |
| 多语言界面 | 约 15 种语言 | 仅英文 | 未做 |
| 界面形态 | 原生桌面 GUI（Windows） | Web GUI（浏览器访问） | 形态不同 |
| 权限隔离 | MediumILStart.exe + idmBroker.exe（UAC 边界） | 无（普通用户进程） | 未做 |
| 内存映射组装 | CreateFileMappingA | 无（流式读写） | 未做 |
| 宿主平台 | 仅 Windows | 跨平台（Node 所到之处） | downloadx 更广 |

---

## 九、汇总

### 相同或等价（17 项）

HTTP Range 分段下载 / 并发数上限 32 / 偏移随机写入 / 小文件不分段 /
每段独立进度持久化 / 启动重建分段状态 / 陈旧数据检测 / 数据异常降级单连接 /
指数退避重试 / 令牌桶限速 / 队列并发上限加持久化 / 定时调度 /
分类归档加站点规则 / 剪贴板监控 / HLS 与 DASH 解析加音视频合并 /
浏览器扩展嗅探（同三个劫持点）/ FTP 含续传

### downloadx 有而 IDM 没有（4 项）

跨平台（Linux/macOS） / 命令行加脚本化（15 个子命令加 HTTP API） /
每任务独立限速 / 零安装成本（无需驱动签名与许可）

### IDM 有而 downloadx 没有（8 项真实差距）

| # | 能力 | 影响 | 补充难度 |
|---|---|---|---|
| 1 | **WFP 驱动级别捕获**（截获不遵守代理的程序） | 中 | 极高（需 WHQL） |
| 2 | **不依赖 ffmpeg 的 MP4 封装** | 中 | 高 |
| 3 | 多语言界面（15 种） | 低 | 中 |
| 4 | 更完整的 TLS 重试链（5 档 vs 3 档） | 低 | 低 |
| 5 | URL 历史持久化 | 低 | 低 |
| 6 | 下载前文件头类型预判 | 低 | 低 |
| 7 | SOCKS 代理 | 低 | 低 |
| 8 | 主动模式 FTP | 极低 | 低 |

### downloadx 内部缺口（已从 6 项修到 2 项）

| # | 问题 | 状态 |
|---|---|---|
| 1 | maxConnectionsPerServer 引擎从不读取 | **已修**（按主机计数封顶 + 回归测试） |
| 2 | scheduler 的 speedLimit 从未应用 | **已修**（窗口内下发到 RateLimiter + 回归测试） |
| 3 | contentDigest 校验分支永不触发 | **已修**（解析四种摘要头，不匹配则丢弃 + 回归测试） |
| 4 | 降级仅覆盖「忽略 Range」 | **已修**（跨段重读检测不一致 + 回归测试） |
| 动态分段 | 有 | **已修**：空闲 worker 切分在飞段尾部 | ✅ **已对齐** |
| 6 | GUI 未接队列拖动排序（API 已就绪） | 待办 |

---

## 九点五、从开源同类借鉴的设计

见 [借鉴笔记.md](借鉴笔记.md)。本轮从 Surge（MIT，3,597★）吸收了四项：
自适应并发闸门、工作线程健康检查、探测可疑响应告警、同主机探测串行化。
这四项都是 IDM 具备而 downloadx 原先缺失的**稳定性**能力。

## 十、一句话结论

**相同点**：下载引擎的协议层、续传设计、容错思路、浏览器嗅探手法**本质一致**——
逆向出来的关键设计（每段独立状态、偏移写入、降级重下、MediaSource 劫持）在 downloadx 里都有对应实现。

**差异点**：
- IDM 用**内核驱动**换取"全自动截获任意程序"；downloadx 用**本地代理**换取"零签名安装"
- IDM 的**容错与兼容性打磨了二十年**（5 档 TLS、33 种重启类型）；downloadx 覆盖了主干但边界更窄
- IDM 是**成熟的商业产品**；downloadx 是**功能对标的学习实现**，有 6 处配置或代码未接线的缺口

**最该补的三项**（按性价比）：
1. ~~修掉 3 处死配置与死代码~~ —— **已完成**（外加把降级触发扩展到多连接不一致）
2. 自实现 MP4 封装（去掉 ffmpeg 依赖，向 XDM 看齐）
3. 接上动态分段（`splitSegment` 已实现但引擎未调用）
