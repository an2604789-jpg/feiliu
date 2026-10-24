// downloadx extension service worker.
//
// Two jobs:
//   1. relay clicks/commands and stream tasks (with HttpOnly cookies) to the native host (com.downloadx.host);
//   2. observe network requests/responses for downloadable media streams with LRU debouncing.

const HOST = "com.downloadx.host";
const PROTOCOL = 1;
const MEDIA_TYPES = /^(video|audio)\//i;
const MEDIA_EXT = /\.(m3u8|mpd|m4s|mp4|m4v|mkv|webm|flv|mov|avi|mp3|m4a|aac|flac|ogg|wav|ts)$/i;

const ANNOUNCE_COOLDOWN_MS = 30_000;
const LRU_MAX_CAPACITY = 100;
const recentAnnouncements = new Map();

let port = null;

/**
 * 格式化 Native Host 连接错误提示信息
 * @param {string} [detail] 错误详情
 * @returns {string}
 */
function hostError(detail) {
  const text = String(detail || "");
  if (!port) {
    return (
      "downloadx native host could not be started. Run " +
      "`node extension/install.mjs install --extension-id <id>` and reload the extension."
    );
  }
  return "downloadx native host failed: " + text;
}

/**
 * 建立或复用与 com.downloadx.host 的 Native Messaging 通道
 * @returns {chrome.runtime.Port|null}
 */
function connect() {
  if (port) return port;
  try {
    port = chrome.runtime.connectNative(HOST);
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      port = null;
      if (err) console.warn("downloadx:", hostError(err.message));
    });
    port.onMessage.addListener(() => {});
  } catch (err) {
    port = null;
    console.warn("downloadx:", hostError(err && err.message));
  }
  return port;
}

/**
 * 向 Native Host 发送带协议版本号 (protocol: 1) 的请求并等待响应
 * @param {Object} message 待发送的消息负载
 * @returns {Promise<Object>}
 */
function ask(message) {
  return new Promise((resolve) => {
    const p = connect();
    if (!p) {
      resolve({ ok: false, error: hostError() });
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (reply) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      p.onMessage.removeListener(onMessage);
      resolve(reply);
    };
    const onMessage = (reply) => finish(reply);
    p.onMessage.addListener(onMessage);
    try {
      p.postMessage(Object.assign({ protocol: PROTOCOL }, message));
    } catch (err) {
      finish({ ok: false, error: hostError(err && err.message) });
      return;
    }
    if (!settled) {
      timer = setTimeout(
        () => finish({ ok: false, error: "the native host did not answer in time" }),
        20000
      );
    }
  });
}

/**
 * 将下载任务发往 Native Host 并在需要时弹出系统通知
 * @param {Object} message 任务消息体
 * @param {{ quiet?: boolean, suppressErrorNotify?: boolean }} [options]
 *   suppressErrorNotify: 调用方要自己组织失败提示（浏览器接管的转交失败
 *   还要附带“浏览器下载已恢复”的说明）时，屏蔽这里的通用失败通知。
 * @returns {Promise<Object>}
 */
async function queue(message, { quiet = false, suppressErrorNotify = false } = {}) {
  const reply = await ask(message);
  if (!reply || reply.ok !== true) {
    const text = (reply && reply.error) || "unknown error";
    if (!suppressErrorNotify) {
      chrome.notifications?.create(
        {
          type: "basic",
          iconUrl: "icon.png",
          title: "飞流下载器",
          message: "Could not queue this download: " + text
        },
        () => void chrome.runtime.lastError
      );
    }
    console.warn("downloadx: queue failed:", text);
    return reply || { ok: false, error: "no reply" };
  }
  if (reply.pending) {
    chrome.notifications?.create(
      {
        type: "basic",
        iconUrl: "icon.png",
        title: "飞流下载器",
        message: "已挂起：在飞流窗口批准后开始下载（超时会自动入队）"
      },
      () => void chrome.runtime.lastError
    );
    return reply;
  }
  if (!quiet && !reply.duplicate) {
    const name =
      (reply.task && (reply.task.filename || reply.task.url)) ||
      message.title ||
      message.url;
    chrome.notifications?.create(
      {
        type: "basic",
        iconUrl: "icon.png",
        title: "飞流下载器",
        message: "Queued: " + String(name).slice(0, 200)
      },
      () => void chrome.runtime.lastError
    );
  } else if (!quiet && reply.duplicate) {
    // 同链接已有任务:host 的 duplicate 回复带已有任务状态,让用户知道
    // 这次点击没有创建新任务、该去哪里处理它。
    const status = reply.duplicateStatus || (reply.task && reply.task.status) || "unknown";
    const name = (reply.task && (reply.task.filename || reply.task.url)) || message.url;
    chrome.notifications?.create(
      {
        type: "basic",
        iconUrl: "icon.png",
        title: "飞流下载器",
        message:
          "Already in the downloadx queue (status: " + status + "): " +
          String(name).slice(0, 160)
      },
      () => void chrome.runtime.lastError
    );
  }
  return reply;
}

/**
 * 记录 URL 到容量为 100 的 LRU 缓存中，并清理过期或超量条目
 * @param {string} url 媒体 URL
 */
function rememberAnnouncement(url) {
  if (!url) return;
  const now = Date.now();

  // 先删除再插入，保证 Map 迭代顺序即为最近最少使用 (LRU) 顺序
  if (recentAnnouncements.has(url)) {
    recentAnnouncements.delete(url);
  }
  recentAnnouncements.set(url, now);

  // 先淘汰超过 30 秒冷却期的过期记录
  if (recentAnnouncements.size > LRU_MAX_CAPACITY) {
    for (const [key, at] of recentAnnouncements) {
      if (now - at >= ANNOUNCE_COOLDOWN_MS) {
        recentAnnouncements.delete(key);
      }
    }
  }

  // 若仍超过容量上限 100，按 LRU 顺序淘汰最早写入的键
  while (recentAnnouncements.size > LRU_MAX_CAPACITY) {
    const oldestKey = recentAnnouncements.keys().next().value;
    if (oldestKey === undefined) break;
    recentAnnouncements.delete(oldestKey);
  }
}

/**
 * 基于容量为 100、TTL 为 30 秒的 LRU 缓存判断同一 URL 是否需要防抖拦截
 * @param {string} url 媒体 URL
 * @returns {boolean} 若在 30 秒冷却期内则返回 true（表示应拦截），否则记录并返回 false
 */
function throttleAnnouncement(url) {
  if (!url) return true;
  const now = Date.now();
  const seenAt = recentAnnouncements.get(url);
  if (seenAt !== undefined && now - seenAt < ANNOUNCE_COOLDOWN_MS) {
    // 命中缓存时刷新 LRU 位置
    recentAnnouncements.delete(url);
    recentAnnouncements.set(url, seenAt);
    return true;
  }
  rememberAnnouncement(url);
  return false;
}

// 自动上报的体积门槛:低于 1 MiB 的"媒体"几乎都是页面 UI 音效/通知音
// (实测:YouTube success.mp3 6636 字节被当成视频抓了 4 次)。
const AUTO_REPORT_MIN_BYTES = 1024 * 1024;

// 分片拒绝提示:单独下载一个分片只会得到一段打不开的碎片。
const SEGMENT_HINT = "这是流媒体的一个分片,请用页面悬浮条抓完整流";

// 只有清单扩展名才允许 hls/dash;分片(.m4s/.ts 等)一律按 http 处理。
const MANIFEST_HLS_EXT = ".m3u8";
const MANIFEST_DASH_EXT = ".mpd";

// 媒体分片扩展名。单独入队必然失败(B 站 m4s 以 kind:"dash" 入队后
// runDash 把分片当 MPD 拉,死在 8 MiB 上限),必须整流抓取。
const SEGMENT_EXT_RE = /\.(m4s|ts|mts|m2ts)(\?|#|$)/i;

/**
 * 判断 URL 是否只是流媒体的一个分片(而非可整流抓取的清单/完整文件)
 * @param {string} url
 * @returns {boolean}
 */
function isMediaSegmentUrl(url) {
  const clean = String(url || "").split("?")[0].split("#")[0].toLowerCase();
  return SEGMENT_EXT_RE.test(clean + "");
}

/**
 * 根据 URL 与 Content-Type 推断流媒体协议类型 ("hls" | "dash" | "http")。
 *
 * kind 判定收口:只有 .m3u8/.mpd 清单 URL(或经 content-type 确认为
 * mpegurl/dash+xml)才允许返回 hls/dash;.m4s/.ts 等分片与普通媒体一律
 * 返回 http——分片不是清单,交给 dash/hls 下载器只会失败。
 *
 * @param {string} url
 * @param {string} [contentType] 探测到的响应 Content-Type(没有时仅看 URL)
 * @returns {"hls"|"dash"|"http"}
 */
function inferStreamKind(url, contentType = "") {
  const clean = String(url || "").split("?")[0].split("#")[0].toLowerCase();
  const mime = String(contentType || "").toLowerCase();
  if (clean.endsWith(MANIFEST_HLS_EXT) || mime.includes("mpegurl")) return "hls";
  if (clean.endsWith(MANIFEST_DASH_EXT) || mime.includes("dash+xml")) return "dash";
  return "http";
}

/**
 * 判断 Content-Type 是否为流媒体清单(m3u8/mpd 家族)
 * @param {string} contentType
 * @returns {boolean}
 */
function isManifestContentType(contentType) {
  const mime = String(contentType || "").toLowerCase();
  return mime.includes("mpegurl") || mime.includes("dash+xml");
}

/**
 * 判断 Content-Type 是否为可下载媒体(自动上报门槛:仅 video/* 与 audio/*)
 * @param {string} contentType
 * @returns {boolean}
 */
function contentTypeIsMedia(contentType) {
  return /^(video|audio)\//i.test(String(contentType || "").split(";")[0].trim());
}

/**
 * 判断 Content-Type 是否明确排除了流媒体(页面 HTML/JSON/文本等)。
 * 仅在探测明确返回这类类型时拦截止入队;未知类型(含 octet-stream)不拦。
 * @param {string} contentType
 * @returns {boolean}
 */
function contentTypeBlocksStream(contentType) {
  const base = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (!base) return false;
  if (contentTypeIsMedia(base) || isManifestContentType(base)) return false;
  if (base === "application/octet-stream" || base === "binary/octet-stream") return false;
  if (base.startsWith("text/")) return true;
  return ["application/xhtml+xml", "application/json", "application/javascript",
    "application/x-www-form-urlencoded"].includes(base);
}

/**
 * 常见媒体 Content-Type 到文件扩展名的映射(入队扩展名按真实类型推导,
 * 修掉 audio/mpeg 的 success.mp3 被命名为 .mp4 的问题)
 * @param {string} contentType
 * @returns {string} 形如 ".mp4" 的扩展名,识别不出返回 ""
 */
function extForContentType(contentType) {
  const base = String(contentType || "").split(";")[0].trim().toLowerCase();
  const map = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "video/quicktime": ".mov",
    "video/x-msvideo": ".avi",
    "video/mpeg": ".mpeg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/aac": ".aac",
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/flac": ".flac",
    "audio/x-flac": ".flac",
    "application/vnd.apple.mpegurl": ".m3u8",
    "application/x-mpegurl": ".m3u8",
    "application/dash+xml": ".mpd"
  };
  return map[base] || "";
}

/**
 * 从 URL 路径提取小写扩展名(含点),没有则返回 ""
 * @param {string} url
 * @returns {string}
 */
function extFromUrl(url) {
  const clean = String(url || "").split("?")[0].split("#")[0];
  const m = /\.([a-z0-9]{1,5})$/i.exec(clean);
  return m ? "." + m[1].toLowerCase() : "";
}

/**
 * 依据真实 Content-Type 纠正 URL 自带的文件名扩展名。
 * 只有探测确实给出可识别的媒体类型、且 URL basename 看起来是个普通文件名
 * 时才干预;其余情况返回 undefined,交由守护进程按 URL 自行推导。
 * @param {string} url
 * @param {string} contentType 探测到的 Content-Type
 * @returns {string|undefined}
 */
function correctedFilenameForUrl(url, contentType) {
  const ext = extForContentType(contentType);
  if (!ext) return undefined;
  const clean = String(url || "").split("?")[0].split("#")[0];
  let base = "";
  try {
    base = decodeURIComponent(clean.substring(clean.lastIndexOf("/") + 1) || "");
  } catch {
    return undefined;
  }
  if (!base || !/^[\w.\- ]{1,120}$/.test(base)) return undefined;
  if (base.toLowerCase().endsWith(ext)) return base;
  return base.replace(/\.[a-z0-9]{1,5}$/i, "") + ext;
}

/**
 * 悬浮条任务(QUEUE_STREAM)的文件名:标题 + 按真实 Content-Type/URL 推导的
 * 扩展名。修掉"三元两支同为 mp4"导致 audio/mpeg 存成 .mp4 的缺陷。
 * @param {string} title 页面标题(可为空)
 * @param {string} url 流 URL
 * @param {string} contentType 探测到的 Content-Type(可为空)
 * @returns {string|undefined} 无标题时返回 undefined
 */
function streamFilename(title, url, contentType) {
  const t = String(title || "").trim();
  if (!t) return undefined;
  const ext =
    extForContentType(contentType) || extFromUrl(url) || ".mp4";
  return t.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) + ext;
}

/**
 * 自动上报门槛决策:content-type 必须 video/* 或 audio/* 才认媒体;非用户
 * 主动时探测体积 <1MiB 不上报。探测不可用时自动路径放弃、用户路径照旧。
 * @param {{ userInitiated?: boolean, probeOk?: boolean, contentType?: string, totalBytes?: number|null }} info
 * @returns {{ report: boolean, reason?: string }}
 */
function evaluateMediaCandidate({ userInitiated = false, probeOk = false, contentType = "", totalBytes = null } = {}) {
  if (!probeOk) {
    return userInitiated
      ? { report: true }
      : { report: false, reason: "probe unavailable" };
  }
  if (userInitiated) {
    // 用户主动点击:只拦"明确不是媒体"的响应(页面 HTML/JSON 等);服务器
    // 未给 content-type 或给未知二进制类型时不误伤用户明确的意图。
    if (contentTypeBlocksStream(contentType)) {
      return { report: false, reason: "non-media content-type: " + (String(contentType || "unknown").split(";")[0]) };
    }
    return { report: true };
  }
  // 自动上报门槛:只认 video/*|audio/*,且探测体积 ≥1MiB。
  if (!contentTypeIsMedia(contentType)) {
    return { report: false, reason: "non-media content-type: " + (String(contentType || "unknown").split(";")[0]) };
  }
  if (Number.isFinite(totalBytes) && totalBytes < AUTO_REPORT_MIN_BYTES) {
    return { report: false, reason: "below auto-report threshold (" + totalBytes + " bytes)" };
  }
  return { report: true };
}

/**
 * 提取指定页面 URL 对应的全部 Cookie（包含带 HttpOnly 标志的鉴权 Cookie，如 B 站 SESSDATA）
 * 并序列化为标准 HTTP 请求头格式：`name1=val1; name2=val2`
 * @param {string} targetUrl 页面 URL 或媒体请求 URL
 * @returns {Promise<string>} 序列化后的 Cookie 字符串
 */
async function getSerializedCookies(targetUrl) {
  if (!targetUrl || !chrome.cookies || typeof chrome.cookies.getAll !== "function") {
    return "";
  }
  try {
    const cookies = await new Promise((resolve) => {
      try {
        const maybePromise = chrome.cookies.getAll({ url: targetUrl }, (res) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve([]);
            return;
          }
          resolve(Array.isArray(res) ? res : []);
        });
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.then((res) => resolve(Array.isArray(res) ? res : [])).catch(() => resolve([]));
        }
      } catch {
        resolve([]);
      }
    });

    if (!Array.isArray(cookies) || cookies.length === 0) {
      return "";
    }

    const seenPairs = new Set();
    const pairs = [];
    for (const c of cookies) {
      if (c && typeof c.name === "string" && c.name.length > 0) {
        const pair = `${c.name}=${c.value ?? ""}`;
        if (!seenPairs.has(pair)) {
          seenPairs.add(pair);
          pairs.push(pair);
        }
      }
    }
    return pairs.join("; ");
  } catch {
    return "";
  }
}

/**
 * 构建流媒体下载所需的防盗链与鉴权 HTTP 请求头
 * @param {string} pageUrl 当前播放页 URL
 * @param {string} [mediaUrl] 媒体资源 URL（当 pageUrl 缺失或跨域时辅助提取 Cookie）
 * @returns {Promise<{ "User-Agent": string, "Referer": string, "Origin": string, "Cookie": string }>}
 */
async function buildStreamHeaders(pageUrl, mediaUrl = "") {
  const effectivePageUrl = pageUrl || mediaUrl || "";
  let origin = "";
  try {
    if (effectivePageUrl) {
      origin = new URL(effectivePageUrl).origin;
    }
  } catch {
    origin = "";
  }

  let cookieHeader = await getSerializedCookies(effectivePageUrl);
  if (!cookieHeader && mediaUrl && mediaUrl !== effectivePageUrl) {
    cookieHeader = await getSerializedCookies(mediaUrl);
  }

  const userAgent =
    typeof navigator !== "undefined" && navigator.userAgent
      ? navigator.userAgent
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  const headers = {
    "User-Agent": userAgent,
    Referer: effectivePageUrl,
    Origin: origin,
    Cookie: cookieHeader
  };

  return headers;
}

/**
 * 处理来自 content.js 的 QUEUE_STREAM 消息，完成 HttpOnly Cookie 穿透并向 Native Host 发送 add-stream 任务
 * @param {Object} payload 前端传来的流媒体信息
 * @param {chrome.runtime.MessageSender} sender 消息发送方上下文
 * @returns {Promise<Object>}
 */
async function handleQueueStream(payload, sender) {
  const data = payload && typeof payload === "object" ? payload : {};
  const tab = sender && sender.tab ? sender.tab : null;
  const pageUrl = data.pageUrl || (tab && tab.url) || data.url || "";
  const streamUrl = data.url || pageUrl;

  if (!streamUrl) {
    return { ok: false, error: "missing stream url" };
  }

  // 分片不是清单:单独下载只会得到一段碎片,明确拒绝并引导整流抓取。
  if (isMediaSegmentUrl(streamUrl)) {
    return { ok: false, error: SEGMENT_HINT, segment: true };
  }

  const headers = await buildStreamHeaders(pageUrl, streamUrl);

  // 探测是尽力而为:拿得到 content-type 就用于 kind 确认、扩展名推导和
  // 非媒体拦截(页面 HTML/登录页不再被当媒体下回来)。
  const probe = await ask({ type: "probe", url: streamUrl, headers });
  const probeOk = Boolean(probe && probe.ok !== false && !probe.error);
  const contentType = probeOk ? probe.contentType || "" : "";
  if (probeOk && contentTypeBlocksStream(contentType)) {
    return {
      ok: false,
      error: "this URL is not media (content-type " + contentType.split(";")[0] + "); nothing was queued"
    };
  }

  // kind 只信清单 URL/清单 content-type,不信任页面侧上报的 kind。
  const kind = inferStreamKind(streamUrl, contentType || data.mime || "");
  const title = (data.title || (tab && tab.title) || "").trim();
  const filename = streamFilename(title, streamUrl, contentType);

  const nativePacket = {
    type: "add-stream",
    url: streamUrl,
    audioUrl: data.audioUrl || null,
    pageUrl,
    referer: pageUrl,
    title,
    filename,
    kind,
    headers,
    meta: {
      audioUrl: data.audioUrl || null,
      pageUrl,
      title,
      resolution: data.resolution || "",
      mime: contentType || data.mime || ""
    }
  };

  return queue(nativePacket, { quiet: false });
}

// ============================================================================
// 右键菜单、扩展图标与快捷键事件绑定（完整保留原有功能）
// ============================================================================

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "downloadx-link",
    title: "Download with downloadx",
    contexts: ["link", "video", "audio", "image"]
  });
  chrome.contextMenus.create({
    id: "downloadx-page",
    title: "Download this page with downloadx",
    contexts: ["page"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url =
    info.id === "downloadx-page"
      ? info.pageUrl || (tab && tab.url)
      : info.linkUrl || info.srcUrl;
  if (!url) return;
  // info.cookie 在 Chrome 的 OnClickData 里不存在,旧代码恒传 undefined,
  // 登录资源下回来是登录页。统一走 buildStreamHeaders 补齐 Cookie/Referer/UA。
  (async () => {
    const headers = await buildStreamHeaders((tab && tab.url) || "", url);
    await queue({ type: "add", url, referer: tab && tab.url, headers });
  })();
});

chrome.action.onClicked.addListener((tab) => {
  const url = tab && tab.url;
  if (!url) return;
  (async () => {
    const headers = await buildStreamHeaders(url, url);
    await queue({ type: "add", url, referer: tab.url, headers });
  })();
});

chrome.commands &&
  chrome.commands.onCommand &&
  chrome.commands.onCommand.addListener &&
  chrome.commands.onCommand.addListener((cmd) => {
    if (cmd !== "download-with-downloadx") return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.url) return;
      buildStreamHeaders(tab.url, tab.url).then((headers) => {
        queue({ type: "add", url: tab.url, referer: tab.url, headers });
      });
    });
  });

// ============================================================================
// WebRequest 轻量嗅探兜底（容量 100、30 秒 TTL 的 LRU 防抖去重）
// ============================================================================

if (
  typeof chrome !== "undefined" &&
  chrome.webRequest &&
  chrome.webRequest.onBeforeRequest &&
  typeof chrome.webRequest.onBeforeRequest.addListener === "function"
) {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (!details || details.tabId === undefined || details.tabId < 0) return;
      if (details.method && details.method !== "GET" && details.method !== "HEAD") return;

      const rawUrl = details.url || "";
      if (!rawUrl || !rawUrl.startsWith("http")) return;

      const cleanPath = rawUrl.split("?")[0].split("#")[0];
      if (!MEDIA_EXT.test(cleanPath)) return;

      // 分片不是独立媒体:不向页面发嗅探通知,交给悬浮条整流抓取。
      if (isMediaSegmentUrl(rawUrl)) return;

      // LRU 防抖:同一 URL 30 秒内不重复通知前端
      if (throttleAnnouncement(rawUrl)) return;

      const kind = inferStreamKind(rawUrl);
      if (chrome.tabs && typeof chrome.tabs.sendMessage === "function") {
        try {
          chrome.tabs.sendMessage(
            details.tabId,
            {
              type: "stream-detected",
              url: rawUrl,
              kind
            },
            () => void (chrome.runtime && chrome.runtime.lastError)
          );
        } catch {
          // 忽略未加载 content script 的标签页
        }
      }
    },
    { urls: ["<all_urls>"] }
  );
}

// ============================================================================
// Runtime 消息总线 (ask / ping / media-found / QUEUE_STREAM)
// ============================================================================

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || !msg.type) return false;
  if (msg.type === "ask") {
    ask(msg.payload).then(respond);
    return true;
  }
  if (msg.type === "ping") {
    ask({ type: "ping" }).then(respond);
    return true;
  }
  if (msg.type === "QUEUE_STREAM") {
    handleQueueStream(msg.payload || msg, sender).then((r) => {
      if (!r || r.ok !== true) {
        respond({ ok: false, error: (r && r.error) || "unknown error" });
        return;
      }
      respond({ ok: true, duplicate: Boolean(r.duplicate), task: r.task || null });
    });
    return true;
  }
  if (msg.type === "media-found") {
    const tab = sender && sender.tab;
    const userInitiated = msg.origin === "user";
    const url = String(msg.url || "");
    if (!url) {
      respond({ ok: false, error: "missing url" });
      return true;
    }
    // 分片即使被页面侧当独立媒体上报,也不能入队:回复提示引导整流抓取,
    // content.js 会把它显示在悬浮条的错误提示里。
    if (isMediaSegmentUrl(url)) {
      respond({ ok: false, error: SEGMENT_HINT, segment: true });
      return true;
    }
    if (!userInitiated && throttleAnnouncement(url)) {
      respond({ ok: true, duplicate: false, throttled: true });
      return true;
    }
    (async () => {
      const headers = await buildStreamHeaders((tab && tab.url) || "", url);
      // 入队前 probe 复核:content-type 与体积以服务端为准,不信 URL 扩展名。
      const probe = await ask({ type: "probe", url, headers });
      const probeOk = Boolean(probe && probe.ok !== false && !probe.error);
      const gate = evaluateMediaCandidate({
        userInitiated,
        probeOk,
        contentType: probe && probe.contentType,
        totalBytes: probe && Number.isFinite(probe.totalBytes) ? probe.totalBytes : null
      });
      if (!gate.report) {
        respond({ ok: true, queued: false, skipped: gate.reason });
        return;
      }
      const kind = inferStreamKind(url, (probe && probe.contentType) || "");
      const r = await queue(
        {
          type: "media",
          url,
          kind,
          referer: tab && tab.url,
          headers,
          filename: correctedFilenameForUrl(url, (probe && probe.contentType) || ""),
          meta: msg.meta || {}
        },
        { quiet: true }
      );
      if (!r || r.ok !== true) {
        respond({ ok: false, error: (r && r.error) || "unknown error" });
        return;
      }
      if (userInitiated) rememberAnnouncement(url);
      respond({
        ok: true,
        queued: true,
        duplicate: Boolean(r.duplicate),
        duplicateStatus: r.duplicateStatus || null,
        throttled: false
      });
    })();
    return true;
  }
  return false;
});

// ============================================================================
// 浏览器下载接管 (chrome.downloads.onCreated → 转交飞流)
//
// 匹配表来自守护进程配置 config.takeover(gui 设置页"浏览器接管"):
//   mode: notify(默认,通知询问)/ auto(直接转交)/ off(不接管);
//   extensions: 接管扩展名表。
// 命中条件 = URL 扩展名在表中 且 已知大小 > 1 MiB。blob:/data: 及一切
// 非 http(s) URL 直接忽略;非 GET 忽略。转交 = chrome.downloads.cancel 暂停
// 浏览器下载 + 经既有 host 通道入队(带页面 Referer/Cookie,
// buildStreamHeaders);入队失败则通知并 chrome.downloads.resume 放开恢复。
// ============================================================================

/** 接管大小门槛:与 src/config.mjs 的接管表配套,严格大于 1 MiB 才命中。 */
const TAKEOVER_MIN_BYTES = 1024 * 1024;

/** 守护进程配置没带 takeover 字段时的兜底表(与 src/config.mjs 默认值同源)。 */
const DEFAULT_TAKEOVER_EXTENSIONS = [
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "cab", "tgz",
  "exe", "msi", "apk", "dmg", "deb", "rpm", "appx", "jar", "bin",
  "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "ts", "m2ts", "3gp",
  "mp3", "m4a", "aac", "flac", "wav", "ogg", "wma", "opus", "ape"
];

/** 接管配置的本地缓存时长:每个下载创建事件都打一轮 native 往返太贵。 */
const TAKEOVER_CONFIG_TTL_MS = 60_000;

/** notify 模式的待决转交:service worker 随时可能被回收,落 chrome.storage.local。 */
const TAKEOVER_PENDING_KEY = "takeoverPending";
const TAKEOVER_PENDING_TTL_MS = 10 * 60_000;
const TAKEOVER_PENDING_MAX = 20;

let takeoverConfigCache = { at: 0, mode: "off", extensions: [] };

/**
 * 归一化接管扩展名表:接受数组或逗号分隔字符串,统一为小写、无前导点、
 * 去重、丢弃杂质的扩展名数组(与 src/config.mjs 的 sanitize 同规则)。
 * @param {string[]|string} input
 * @returns {string[]}
 */
function normalizeTakeoverExtensions(input) {
  let list = [];
  if (Array.isArray(input)) list = input;
  else if (typeof input === "string") list = input.split(",");
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const token = raw.trim().toLowerCase().replace(/^[.\s]+/, "");
    if (!/^[a-z0-9]{1,8}$/.test(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * 浏览器下载是否接管、以何种方式接管的判定(纯函数,回归套件直接测)。
 *
 * 判定顺序:blob:/data: 与一切非 http(s) URL 忽略;mode=off 忽略;仅 GET;
 * URL 扩展名必须命中接管表;大小必须已知且 > 1 MiB(onCreated 时大小未知
 * 的下载不接管,避免误抢,浏览器自行继续)。缺省配置(mode 未给出)按
 * 默认 notify 处理,与 src/config.mjs Config.sanitize({}) 的口径一致。
 *
 * @param {{url?:string, method?:string, fileSize?:number, totalBytes?:number}} item
 *   chrome.downloads.DownloadItem 的相关子集
 * @param {{mode?:string, extensions?:string[]|string}} cfg 接管配置
 * @returns {{act:"ignore"|"pass"|"notify"|"transfer", reason?:string}}
 */
function evaluateTakeover(item, cfg) {
  const url = String((item && item.url) || "");
  const colon = url.indexOf(":");
  const scheme = colon > 0 ? url.slice(0, colon).toLowerCase() : "";
  if (scheme === "blob" || scheme === "data") {
    return { act: "ignore", reason: "blob/data URL is ignored" };
  }
  if (scheme !== "http" && scheme !== "https") {
    return { act: "ignore", reason: "not an http(s) URL" };
  }
  const mode =
    cfg && ["notify", "auto", "off"].includes(cfg.mode) ? cfg.mode : "notify";
  if (mode === "off") return { act: "ignore", reason: "takeover mode off" };
  const method = String((item && item.method) || "GET").toUpperCase();
  if (method !== "GET") {
    return { act: "ignore", reason: "method " + method + " is not GET" };
  }
  let table = normalizeTakeoverExtensions(cfg && cfg.extensions);
  if (table.length === 0) table = DEFAULT_TAKEOVER_EXTENSIONS;
  const ext = (extFromUrl(url) || "").replace(/^\./, "");
  if (!ext) return { act: "pass", reason: "URL has no extension" };
  if (!table.includes(ext)) {
    return { act: "pass", reason: "." + ext + " is not in the takeover table" };
  }
  const size = resolveTakeoverSize(item);
  if (!(size > TAKEOVER_MIN_BYTES)) {
    return {
      act: "pass",
      reason:
        size > 0
          ? "size " + size + " is not above 1 MiB"
          : "size unknown at onCreated"
    };
  }
  return mode === "auto" ? { act: "transfer" } : { act: "notify" };
}

/**
 * 解析 DownloadItem 的已知大小:fileSize 优先,totalBytes 兜底,
 * 两者都无效(0/-1/未知)返回 0,表示"大小未知"。
 * @param {{fileSize?:number, totalBytes?:number}} item
 * @returns {number}
 */
function resolveTakeoverSize(item) {
  const fs = Number(item && item.fileSize);
  if (Number.isFinite(fs) && fs > 0) return fs;
  const tb = Number(item && item.totalBytes);
  if (Number.isFinite(tb) && tb > 0) return tb;
  return 0;
}

/**
 * 通知里展示的下载名:onCreated 时 filename 通常为空,退回 URL basename。
 * @param {{filename?:string, url?:string}} item
 * @returns {string}
 */
function takeoverDisplayName(item) {
  const f = String((item && item.filename) || "").split(/[\\/]/).pop();
  if (f) return f;
  const clean = String((item && item.url) || "").split("?")[0].split("#")[0];
  const base = clean.substring(clean.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(base) || clean;
  } catch {
    return base || clean;
  }
}

/**
 * 拉取(带 TTL 缓存)守护进程的接管配置。守护进程不可达时,转交注定失败,
 * 该 TTL 窗口内按 off 处理:零通知、零 cancel,浏览器下载不受打扰。
 * @returns {Promise<{mode:string, extensions:string[]}>}
 */
async function getTakeoverConfig() {
  const now = Date.now();
  if (now - takeoverConfigCache.at < TAKEOVER_CONFIG_TTL_MS) {
    return takeoverConfigCache;
  }
  const reply = await ask({ type: "config" });
  if (reply && reply.ok === true && reply.config && typeof reply.config === "object") {
    const tk =
      reply.config.takeover && typeof reply.config.takeover === "object"
        ? reply.config.takeover
        : {};
    const mode = ["notify", "auto", "off"].includes(tk.mode) ? tk.mode : "notify";
    let extensions = normalizeTakeoverExtensions(tk.extensions);
    if (extensions.length === 0) extensions = [...DEFAULT_TAKEOVER_EXTENSIONS];
    takeoverConfigCache = { at: now, mode, extensions };
  } else {
    takeoverConfigCache = { at: now, mode: "off", extensions: [] };
  }
  return takeoverConfigCache;
}

/** chrome.storage.local.get 的 Promise 包装,异常一律回退空对象。 */
function storageGetLocal(key) {
  return new Promise((resolve) => {
    const area =
      typeof chrome !== "undefined" &&
      chrome.storage &&
      chrome.storage.local &&
      typeof chrome.storage.local.get === "function"
        ? chrome.storage.local
        : null;
    if (!area) return resolve({});
    let settled = false;
    const done = (items) => {
      if (settled) return;
      settled = true;
      resolve(items && typeof items === "object" ? items : {});
    };
    try {
      const maybe = area.get(key, done);
      if (maybe && typeof maybe.then === "function") {
        maybe.then(done, () => done({}));
      }
    } catch {
      done({});
    }
  });
}

/** chrome.storage.local.set 的 Promise 包装(尽力而为,失败静默)。 */
function storageSetLocal(key, value) {
  return new Promise((resolve) => {
    const area =
      typeof chrome !== "undefined" &&
      chrome.storage &&
      chrome.storage.local &&
      typeof chrome.storage.local.set === "function"
        ? chrome.storage.local
        : null;
    if (!area) return resolve(false);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(true);
    };
    try {
      const maybe = area.set({ [key]: value }, done);
      if (maybe && typeof maybe.then === "function") maybe.then(done, done);
    } catch {
      done();
    }
  });
}

/**
 * 记录一条 notify 模式的待决转交(通知点击 = 转交)。MV3 service worker
 * 在通知弹出后随时可能被回收,内存映射会丢,必须落 storage。
 * @param {string} notificationId
 * @param {{id:number, url:string, referrer?:string, filename?:string}} item
 */
async function rememberPendingTakeover(notificationId, item) {
  const data = await storageGetLocal(TAKEOVER_PENDING_KEY);
  const raw = data && data[TAKEOVER_PENDING_KEY];
  const map = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const now = Date.now();
  for (const k of Object.keys(map)) {
    const at = map[k] && map[k].at;
    if (!Number.isFinite(at) || now - at > TAKEOVER_PENDING_TTL_MS) delete map[k];
  }
  map[notificationId] = {
    at: now,
    item: {
      id: item.id,
      url: item.url,
      referrer: item.referrer || "",
      filename: item.filename || ""
    }
  };
  const keys = Object.keys(map);
  while (keys.length > TAKEOVER_PENDING_MAX) {
    let oldest = keys[0];
    for (const k of keys) if (map[k].at < map[oldest].at) oldest = k;
    delete map[oldest];
    keys.splice(keys.indexOf(oldest), 1);
  }
  await storageSetLocal(TAKEOVER_PENDING_KEY, map);
}

/** chrome.downloads.cancel 的 Promise 包装(尽力而为,已完成的下载取消失败无所谓)。 */
function cancelBrowserDownload(id) {
  return new Promise((resolve) => {
    const api =
      typeof chrome !== "undefined" && chrome.downloads && typeof chrome.downloads.cancel === "function"
        ? chrome.downloads
        : null;
    if (!api) return resolve(false);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(true);
    };
    try {
      // 回调式与 Promise 式(MV3)都要收口,谁先到算谁。
      const maybe = api.cancel(id, () => {
        void (chrome.runtime && chrome.runtime.lastError);
        done();
      });
      if (maybe && typeof maybe.then === "function") maybe.then(done, done);
    } catch {
      done();
    }
  });
}

/** chrome.downloads.resume 的 Promise 包装:转交失败时放开浏览器下载恢复。 */
function resumeBrowserDownload(id) {
  return new Promise((resolve) => {
    const api =
      typeof chrome !== "undefined" && chrome.downloads && typeof chrome.downloads.resume === "function"
        ? chrome.downloads
        : null;
    if (!api) return resolve(false);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(true);
    };
    try {
      const maybe = api.resume(id, () => {
        void (chrome.runtime && chrome.runtime.lastError);
        done();
      });
      if (maybe && typeof maybe.then === "function") maybe.then(done, done);
    } catch {
      done();
    }
  });
}

/** 接管路径的系统通知(固定通知 id,便于点击回查与清理)。 */
function notifyTakeover(notificationId, message, detail) {
  if (!chrome.notifications || typeof chrome.notifications.create !== "function") return;
  chrome.notifications.create(
    notificationId,
    {
      type: "basic",
      iconUrl: "icon.png",
      title: "downloadx 浏览器接管",
      message: detail
        ? message + ": " + String(detail).slice(0, 160)
        : message
    },
    () => void chrome.runtime.lastError
  );
}

/**
 * 执行转交:cancel 暂停浏览器下载 → 经既有 host 通道入队(页面
 * Referer/Cookie 走 buildStreamHeaders);入队失败则通知并 resume
 * 放开浏览器下载恢复。
 * @param {{id:number, url:string, referrer?:string, filename?:string}} item
 * @returns {Promise<Object>} host 的入队应答
 */
async function transferBrowserDownload(item) {
  const downloadId = item.id;
  const url = String(item.url || "");
  const pageUrl = String(item.referrer || "");
  await cancelBrowserDownload(downloadId);
  const headers = await buildStreamHeaders(pageUrl || url, url);
  const reply = await queue(
    {
      type: "add",
      url,
      referer: pageUrl,
      headers,
      meta: { source: "browser-takeover", pageUrl }
    },
    { suppressErrorNotify: true }
  );
  if (!reply || reply.ok !== true) {
    const resumed = await resumeBrowserDownload(downloadId);
    notifyTakeover(
      "downloadx-takeover-failed-" + downloadId,
      "转交飞流失败" +
        (resumed ? ",已恢复浏览器下载" : ",浏览器下载无法恢复,请在页面重新下载"),
      (reply && reply.error) || "unknown error"
    );
  }
  return reply;
}

// MV3 的浏览器事件监听必须顶层同步注册才能在 worker 重启后仍收到事件,
// 所以 downloads/notifications 监听在这里常驻;"off 不监听"落实为:off 模式
// 下处理函数第一跳就返回,零通知、零 cancel、零 native 消息。
if (
  typeof chrome !== "undefined" &&
  chrome.downloads &&
  chrome.downloads.onCreated &&
  typeof chrome.downloads.onCreated.addListener === "function"
) {
  chrome.downloads.onCreated.addListener((item) => {
    (async () => {
      try {
        if (!item || item.id === undefined) return;
        const cfg = await getTakeoverConfig();
        if (cfg.mode === "off") return;
        const decision = evaluateTakeover(item, cfg);
        if (decision.act === "ignore" || decision.act === "pass") return;
        if (decision.act === "transfer") {
          await transferBrowserDownload(item);
          return;
        }
        // notify 模式:只询问,不打断浏览器下载;点击通知才执行转交。
        const notificationId = "downloadx-takeover-" + item.id;
        notifyTakeover(notificationId, "转交飞流? " + takeoverDisplayName(item));
        await rememberPendingTakeover(notificationId, item);
      } catch (err) {
        console.warn("downloadx: takeover check failed:", err && err.message);
      }
    })();
  });
}

if (
  typeof chrome !== "undefined" &&
  chrome.notifications &&
  chrome.notifications.onClicked &&
  typeof chrome.notifications.onClicked.addListener === "function"
) {
  chrome.notifications.onClicked.addListener((notificationId) => {
    (async () => {
      try {
        const data = await storageGetLocal(TAKEOVER_PENDING_KEY);
        const map = (data && data[TAKEOVER_PENDING_KEY]) || {};
        const entry = map[notificationId];
        if (!entry || !entry.item) return;
        delete map[notificationId];
        await storageSetLocal(TAKEOVER_PENDING_KEY, map);
        chrome.notifications &&
          typeof chrome.notifications.clear === "function" &&
          chrome.notifications.clear(notificationId, () => void chrome.runtime.lastError);
        if (Date.now() - entry.at > TAKEOVER_PENDING_TTL_MS) return;
        const reply = await transferBrowserDownload(entry.item);
        // 点击通知即"批准":若 askBeforeAdd 把它挂起了,就地放行,再把
        // DownloadX 窗口拉到前台并切到任务列表——用户点完通知应该立刻
        // 看到下载在进行,而不是自己去翻窗口。
        if (reply && reply.pending && reply.pendingId) {
          await ask({ type: "approve-pending", id: reply.pendingId });
        }
        await ask({ type: "focus-app" });
      } catch (err) {
        console.warn("feiliu: takeover click failed:", err && err.message);
      }
    })();
  });
}

// Batch-1 回归测试(test/batch1-capture.mjs)在带 chrome 桩的沙箱里执行本
// 文件,通过这个全局读取纯函数。仅在测试探针显式置位时挂载,真实
// service worker 里不会创建任何全局。
if (typeof globalThis !== "undefined" && globalThis.__DOWNLOADX_BATCH1_TEST_PROBE__ === true) {
  globalThis.__downloadxBatch1Hooks = {
    inferStreamKind,
    isMediaSegmentUrl,
    isManifestContentType,
    contentTypeIsMedia,
    contentTypeBlocksStream,
    extForContentType,
    extFromUrl,
    correctedFilenameForUrl,
    streamFilename,
    evaluateMediaCandidate,
    AUTO_REPORT_MIN_BYTES,
    SEGMENT_HINT
  };
}

// 包4回归测试(test/batch2-takeover.mjs)用同一沙箱手法读取接管纯函数与
// 缓存复位钩子;同样只在测试探针显式置位时挂载。
if (typeof globalThis !== "undefined" && globalThis.__DOWNLOADX_BATCH2_TEST_PROBE__ === true) {
  globalThis.__downloadxBatch2Hooks = {
    evaluateTakeover,
    normalizeTakeoverExtensions,
    resolveTakeoverSize,
    takeoverDisplayName,
    DEFAULT_TAKEOVER_EXTENSIONS,
    TAKEOVER_MIN_BYTES,
    TAKEOVER_PENDING_TTL_MS,
    __resetTakeoverConfigCacheForTest: () => {
      takeoverConfigCache = { at: 0, mode: "off", extensions: [] };
    }
  };
}