/**
 * @file extension/content.js
 * @description DownloadX ISOLATED World 内容脚本：
 * 1. 保持既有顶层符号 (`seen`, `badge`, `hostProblem`, `checkHost`, `announce`, `guessKind`, `showBadge`, `render`) 100% 兼容；
 * 2. 注入或监听 `injected-sniffer.js` (MAIN World) 的流媒体与 DRM 嗅探消息；
 * 3. 采用 Closed Shadow DOM (`mode: "closed"`) 渲染深色毛玻璃悬浮条，支持 ResizeObserver 跟随播放器右上角、
 *    全屏穿透挂载 (`fullscreenchange`)、2.5 秒静止自动隐匿、DRM 禁用置灰提示及点击发送 `QUEUE_STREAM` 任务。
 */

/** @type {Set<string>} 已发现并通告过的流 URL 集合 */
const seen = new Set();

/** @type {HTMLElement|null} 悬浮条宿主容器（Shadow Host） */
let badge = null;

/** @type {string|null} Native Host / Daemon 连接异常描述 */
let hostProblem = null;

/** @type {ShadowRoot|null} 封闭式 Shadow Root 实例 */
let shadowRoot = null;

/** @type {{ bar?: HTMLElement, btn?: HTMLButtonElement, dot?: HTMLElement, label?: HTMLElement, tooltip?: HTMLElement }} */
let ui = {};

/** @type {HTMLVideoElement|null} 当前跟随的活跃 video 元素 */
let activeVideo = null;

/** @type {ResizeObserver|null} 跟踪活跃播放器尺寸变化的观察器 */
let videoResizeObserver = null;

/** @type { ReturnType<typeof setTimeout> | null } 鼠标静止 2.5 秒自动隐匿定时器 */
let autoHideTimer = null;

/** @type { ReturnType<typeof setTimeout> | null } 点击下载后 2 秒反馈恢复定时器 */
let feedbackTimer = null;

/** @type {boolean} 鼠标当前是否悬停在悬浮条上 */
let isHoveringBar = false;

/** @type {boolean} 当前页面视频是否受 DRM 硬件版权保护 */
let drmProtected = false;

/** @type {string|null} 检测到的 DRM KeySystem 标识 */
let drmKeySystem = null;

/** @type {"idle"|"queued"|"error"} 按钮交互反馈状态 */
let buttonFeedbackState = "idle";

/** @type {number} 鼠标静止自动隐匿超时毫秒数 */
const AUTO_HIDE_DELAY_MS = 2500;

/**
 * 当前页面嗅探到的流媒体聚合状态
 */
const streamState = {
  manifestUrl: "",
  videoUrl: "",
  audioUrl: "",
  directUrl: "",
  kind: "",
  mime: "",
  resolution: "",
  codecs: []
};

// ============================================================================
// 1. 既有核心函数与后台协议兼容 (checkHost / announce / guessKind)
// ============================================================================

/**
 * 检查后台 Service Worker、Native Host 及后台 Daemon 状态
 */
function checkHost() {
  try {
    chrome.runtime.sendMessage({ type: "ping" }, (reply) => {
      if (chrome.runtime.lastError) {
        hostProblem = "the extension lost contact with its background worker; reload the extension";
      } else if (!reply || reply.ok !== true) {
        hostProblem = (reply && reply.error) || "the downloadx native host is not registered";
      } else if (!reply.daemon || !reply.daemon.running) {
        hostProblem = "the downloadx daemon is not running; start it with downloadx.cmd";
      } else {
        hostProblem = null;
      }
      if (badge) render();
    });
  } catch {
    hostProblem = "the extension cannot reach its background worker";
  }
}

/**
 * 向后台通告发现的流媒体 URL，并唤醒悬浮条
 * @param {string} url 媒体直链或清单 URL
 * @param {string} [kind] 流类型 ("hls" | "dash" | "http")
 */
function announce(url, kind) {
  if (!url || seen.has(url)) return;
  seen.add(url);

  const resolvedKind = kind || guessKind(url);
  if (!streamState.kind || resolvedKind === "hls" || resolvedKind === "dash") {
    streamState.kind = resolvedKind;
  }
  if (resolvedKind === "hls" || resolvedKind === "dash") {
    if (!streamState.manifestUrl) streamState.manifestUrl = url;
  } else if (!streamState.directUrl) {
    streamState.directUrl = url;
  }

  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
      chrome.runtime.sendMessage({ type: "media-found", url, kind: resolvedKind }, (reply) => {
        if (chrome.runtime.lastError) {
          hostProblem = "the extension cannot reach its background worker";
          showBadge();
          return;
        }
        if (reply && reply.ok === false) hostProblem = reply.error || "the download could not be queued";
        else if (reply && reply.duplicate) hostProblem = null;
        else hostProblem = null;
        if (reply && reply.throttled) return;
        showBadge();
      });
    }
  } catch {
    /* extension context went away */
  }
  showBadge();
}

/**
 * 根据 URL 后缀推断流媒体类型
 * @param {string} url 媒体 URL
 * @returns {"hls"|"dash"|"http"}
 */
function guessKind(url) {
  const u = String(url || "").split("?")[0].toLowerCase();
  if (u.endsWith(".m3u8")) return "hls";
  if (u.endsWith(".mpd")) return "dash";
  return "http";
}

/**
 * 判断 URL 是否只是流媒体的一个分片(.m4s/.ts 等)。
 * 与 background.js 的 SEGMENT_EXT_RE 保持一致:分片不是清单,永不单独上报。
 * @param {string} url 媒体 URL
 * @returns {boolean}
 */
function isSegmentUrl(url) {
  const u = String(url || "").split("?")[0].split("#")[0].toLowerCase();
  return /\.(m4s|ts|mts|m2ts)$/i.test(u);
}

// ============================================================================
// 2. Shadow DOM (mode: "closed") 悬浮条创建与渲染
// ============================================================================

/**
 * 计算悬浮条按钮上的 "[格式/分辨率]" 标签文本
 * @returns {string}
 */
function formatStreamBadgeTag() {
  const parts = [];
  let kindLabel = (streamState.kind || "").toUpperCase();
  // 分片按 http 上报后,若无清单、只有 .m4s 分片,标签仍应显示 DASH
  const hasSegmentTracks =
    (streamState.videoUrl && isSegmentUrl(streamState.videoUrl)) ||
    (streamState.audioUrl && isSegmentUrl(streamState.audioUrl));
  if (!kindLabel || kindLabel === "MSE" || (kindLabel === "HTTP" && hasSegmentTracks)) {
    if (streamState.manifestUrl) {
      kindLabel = guessKind(streamState.manifestUrl).toUpperCase();
    } else if (hasSegmentTracks) {
      kindLabel = "DASH";
    } else if (seen.size > 0) {
      const firstUrl = Array.from(seen)[0];
      kindLabel = guessKind(firstUrl).toUpperCase();
    } else {
      kindLabel = "HTTP";
    }
  }
  parts.push(kindLabel);

  let res = streamState.resolution;
  if (activeVideo && activeVideo.videoHeight > 0) {
    const h = activeVideo.videoHeight;
    if (h >= 2160) res = "4K";
    else if (h >= 1440) res = "2K";
    else if (h >= 1080) res = "1080P";
    else if (h >= 720) res = "720P";
    else if (h >= 480) res = "480P";
    else res = `${h}P`;
  }
  if (res) {
    parts.push(res);
  }

  return `[${parts.join("/")}]`;
}

/**
 * 确保 Closed Shadow DOM 悬浮条已初始化并挂载
 */
function ensureBadgeCreated() {
  if (typeof document === "undefined" || !document.createElement) return;
  if (badge && shadowRoot) return;

  badge = document.createElement("div");
  badge.id = "__downloadx_floating_host__";
  badge.style.cssText = [
    "position: fixed;",
    "top: 16px;",
    "right: 16px;",
    "z-index: 2147483647;",
    "pointer-events: none;",
    "margin: 0;",
    "padding: 0;",
    "border: 0;",
    "background: transparent;"
  ].join(" ");

  if (typeof badge.attachShadow === "function") {
    shadowRoot = badge.attachShadow({ mode: "closed" });
  } else {
    // 兼容极简测试桩环境
    shadowRoot = badge;
  }

  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .dx-bar {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-radius: 999px;
      background: rgba(15, 18, 28, 0.78);
      backdrop-filter: blur(14px) saturate(160%);
      -webkit-backdrop-filter: blur(14px) saturate(160%);
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.42), 0 1px 3px rgba(0, 0, 0, 0.25);
      color: #f8fafc;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.2;
      user-select: none;
      opacity: 1;
      transform: translateY(0);
      transition: opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1),
                  transform 0.25s cubic-bezier(0.4, 0, 0.2, 1),
                  background-color 0.2s ease,
                  border-color 0.2s ease;
      pointer-events: auto;
      position: relative;
    }
    .dx-bar.dx-hidden {
      opacity: 0 !important;
      pointer-events: none !important;
      transform: translateY(-4px);
    }
    .dx-btn {
      all: unset;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      cursor: pointer;
      color: #f8fafc;
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
    }
    .dx-bar:hover:not(.dx-drm) {
      background: rgba(24, 30, 46, 0.92);
      border-color: rgba(56, 189, 248, 0.5);
    }
    .dx-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #38bdf8;
      box-shadow: 0 0 8px rgba(56, 189, 248, 0.85);
      flex-shrink: 0;
    }
    .dx-bar.dx-queued {
      background: rgba(6, 78, 59, 0.88);
      border-color: rgba(52, 211, 153, 0.55);
    }
    .dx-bar.dx-queued .dx-dot {
      background: #34d399;
      box-shadow: 0 0 8px rgba(52, 211, 153, 0.85);
    }
    .dx-bar.dx-drm {
      background: rgba(39, 39, 42, 0.84);
      border-color: rgba(161, 161, 170, 0.28);
      color: #a1a1aa;
      cursor: not-allowed;
    }
    .dx-bar.dx-drm .dx-btn {
      color: #a1a1aa;
      cursor: not-allowed;
    }
    .dx-bar.dx-drm .dx-dot {
      background: #ef4444;
      box-shadow: 0 0 6px rgba(239, 68, 68, 0.7);
    }
    .dx-tooltip {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      background: rgba(15, 17, 25, 0.95);
      color: #fca5a5;
      border: 1px solid rgba(239, 68, 68, 0.35);
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
      opacity: 0;
      visibility: hidden;
      transform: translateY(-4px);
      transition: opacity 0.18s ease, transform 0.18s ease, visibility 0.18s;
      pointer-events: none;
    }
    .dx-bar.dx-drm:hover .dx-tooltip,
    .dx-bar.dx-error:hover .dx-tooltip {
      opacity: 1;
      visibility: visible;
      transform: translateY(0);
    }
  `;

  const bar = document.createElement("div");
  bar.className = "dx-bar";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dx-btn";

  const dot = document.createElement("span");
  dot.className = "dx-dot";

  const label = document.createElement("span");
  label.className = "dx-label";
  label.textContent = "飞流 抓取视频";

  const tooltip = document.createElement("div");
  tooltip.className = "dx-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.textContent = "该视频受 DRM 硬件版权保护，不支持抓取";

  btn.appendChild(dot);
  btn.appendChild(label);
  bar.appendChild(btn);
  bar.appendChild(tooltip);
  shadowRoot.appendChild(style);
  shadowRoot.appendChild(bar);

  ui = { bar, btn, dot, label, tooltip };

  if (typeof bar.addEventListener === "function") {
    bar.addEventListener("mouseenter", () => {
      isHoveringBar = true;
      revealFloatingBar();
    });
    bar.addEventListener("mouseleave", () => {
      isHoveringBar = false;
      scheduleAutoHide();
    });
  }

  if (typeof btn.addEventListener === "function") {
    btn.addEventListener("click", handleDownloadClick);
  }

  mountHostToAppropriateRoot();
}

/**
 * 显示悬浮条并刷新 UI 状态
 */
function showBadge() {
  ensureBadgeCreated();
  ensureActiveVideoBinding();
  mountHostToAppropriateRoot();
  revealFloatingBar();
  scheduleAutoHide();
  render();
}

/**
 * 渲染悬浮条当前状态（默认状态 / DRM 置灰禁用状态 / 2 秒入队成功反馈 / 错误提示）
 */
function render() {
  if (!ui.bar || !ui.btn || !ui.label || !ui.tooltip) return;

  ui.bar.classList.remove("dx-drm", "dx-queued", "dx-error");

  // 1. DRM 置灰禁用状态
  if (drmProtected) {
    ui.bar.classList.add("dx-drm");
    ui.btn.disabled = true;
    ui.btn.setAttribute("aria-disabled", "true");
    ui.btn.title = "该视频受 DRM 硬件版权保护，不支持抓取";
    ui.tooltip.textContent = "该视频受 DRM 硬件版权保护，不支持抓取";
    ui.label.textContent = `飞流 抓取视频 ${formatStreamBadgeTag()}`;
    return;
  }

  ui.btn.disabled = false;
  ui.btn.removeAttribute("aria-disabled");
  ui.btn.title = "";

  // 2. 点击下载后 2 秒成功反馈
  if (buttonFeedbackState === "queued") {
    ui.bar.classList.add("dx-queued");
    ui.label.textContent = "已添加至下载队列";
    return;
  }

  // 3. 守护进程或 Native Host 异常提示
  if (hostProblem) {
    ui.bar.classList.add("dx-error");
    ui.tooltip.textContent = hostProblem;
  }

  // 4. 默认状态："飞流 抓取视频 [格式/分辨率]"
  ui.label.textContent = `飞流 抓取视频 ${formatStreamBadgeTag()}`;
}

// ============================================================================
// 3. 全屏穿透 (fullscreenchange) 与 ResizeObserver 自适应播放器右上角定位
// ============================================================================

/**
 * 根据当前是否处于原生全屏状态，动态将 Shadow DOM 宿主节点移动至 fullscreenElement 或 document.body
 */
function mountHostToAppropriateRoot() {
  if (!badge || typeof document === "undefined") return;
  const fsElement =
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    null;

  const targetParent = fsElement || document.body || document.documentElement;
  if (targetParent && badge.parentNode !== targetParent) {
    targetParent.appendChild(badge);
  }
  updateFloatingBarPosition();
}

/**
 * 计算并更新悬浮条坐标，使其吸附在当前活跃 video 元素右上角（距上 16px、距右 16px）
 */
function updateFloatingBarPosition() {
  if (!badge || typeof document === "undefined") return;

  const fsElement =
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    null;

  if (fsElement && typeof fsElement.contains === "function" && fsElement.contains(badge)) {
    badge.style.position = "fixed";
    badge.style.top = "16px";
    badge.style.right = "16px";
    badge.style.left = "auto";
    return;
  }

  if (
    activeVideo &&
    typeof document.contains === "function" &&
    document.contains(activeVideo) &&
    typeof activeVideo.getBoundingClientRect === "function"
  ) {
    const rect = activeVideo.getBoundingClientRect();
    if (rect.width >= 120 && rect.height >= 80) {
      const viewportW = typeof window !== "undefined" ? window.innerWidth || 1920 : 1920;
      const topPx = Math.max(16, Math.round(rect.top + 16));
      const rightPx = Math.max(16, Math.round(viewportW - rect.right + 16));
      badge.style.position = "fixed";
      badge.style.top = `${topPx}px`;
      badge.style.right = `${rightPx}px`;
      badge.style.left = "auto";
      return;
    }
  }

  badge.style.position = "fixed";
  badge.style.top = "16px";
  badge.style.right = "16px";
  badge.style.left = "auto";
}

/**
 * 播放器区域鼠标移动时显示悬浮条并重置 2.5s 自动隐匿定时器
 */
function handleVideoMouseMove() {
  revealFloatingBar();
  scheduleAutoHide();
}

/**
 * 鼠标移出播放器区域时平滑淡出
 */
function handleVideoMouseLeave() {
  if (!isHoveringBar) {
    hideFloatingBar();
  }
}

/**
 * 为当前活跃的 <video> 元素绑定 ResizeObserver 与鼠标交互监听
 * @param {HTMLVideoElement} video
 */
function attachVideoListeners(video) {
  if (!video) return;

  if (typeof ResizeObserver !== "undefined") {
    if (!videoResizeObserver) {
      videoResizeObserver = new ResizeObserver(() => {
        updateFloatingBarPosition();
        render();
      });
    }
    try {
      videoResizeObserver.observe(video);
    } catch {
      // ignore
    }
  }

  if (typeof video.addEventListener === "function") {
    video.addEventListener("mousemove", handleVideoMouseMove, { passive: true });
    video.addEventListener("mouseenter", handleVideoMouseMove, { passive: true });
    video.addEventListener("mouseleave", handleVideoMouseLeave, { passive: true });
    video.addEventListener("loadedmetadata", () => {
      updateFloatingBarPosition();
      render();
    });
  }
}

/**
 * 解绑旧 <video> 元素的监听与 ResizeObserver
 * @param {HTMLVideoElement|null} video
 */
function detachVideoListeners(video) {
  if (!video) return;
  if (videoResizeObserver) {
    try {
      videoResizeObserver.unobserve(video);
    } catch {
      // ignore
    }
  }
  if (typeof video.removeEventListener === "function") {
    video.removeEventListener("mousemove", handleVideoMouseMove);
    video.removeEventListener("mouseenter", handleVideoMouseMove);
    video.removeEventListener("mouseleave", handleVideoMouseLeave);
  }
}

/**
 * 自动查找页面中的活跃 <video> 元素并绑定 ResizeObserver
 */
function ensureActiveVideoBinding() {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;
  const videos = Array.from(document.querySelectorAll("video"));
  if (videos.length === 0) return;

  let bestVideo = videos[0];
  let maxScore = -1;

  for (const v of videos) {
    const rect =
      typeof v.getBoundingClientRect === "function"
        ? v.getBoundingClientRect()
        : { width: 640, height: 360 };
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    const isPlaying = !v.paused && !v.ended;
    const score = isPlaying ? area * 2 + 1000 : area;
    if (score > maxScore) {
      maxScore = score;
      bestVideo = v;
    }
  }

  if (bestVideo && bestVideo !== activeVideo) {
    detachVideoListeners(activeVideo);
    activeVideo = bestVideo;
    attachVideoListeners(activeVideo);
  }

  updateFloatingBarPosition();
}

// ============================================================================
// 4. 自动隐匿机制 (鼠标移动显示，静止 >2.5s 或移出播放器淡出)
// ============================================================================

/**
 * 显示悬浮条
 */
function revealFloatingBar() {
  if (!ui.bar) return;
  ui.bar.classList.remove("dx-hidden");
}

/**
 * 平滑淡出隐藏悬浮条 (opacity: 0; pointer-events: none)
 */
function hideFloatingBar() {
  if (autoHideTimer) {
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }
  if (!ui.bar || isHoveringBar) return;
  ui.bar.classList.add("dx-hidden");
}

/**
 * 启动或重置 2.5 秒静止自动隐匿定时器
 */
function scheduleAutoHide() {
  if (autoHideTimer) {
    clearTimeout(autoHideTimer);
  }
  autoHideTimer = setTimeout(() => {
    if (!isHoveringBar) {
      hideFloatingBar();
    }
  }, AUTO_HIDE_DELAY_MS);
}

// ============================================================================
// 5. 点击下载与 QUEUE_STREAM 任务派发
// ============================================================================

/**
 * 点击悬浮条按钮后向 background.js 发送 QUEUE_STREAM 消息，并展示 2 秒入队成功反馈
 * @param {Event} [event]
 */
function handleDownloadClick(event) {
  if (event && typeof event.preventDefault === "function") {
    event.preventDefault();
    event.stopPropagation();
  }

  if (drmProtected) return;

  const pageUrl =
    typeof window !== "undefined" && window.location ? window.location.href : "";
  const primaryUrl =
    streamState.manifestUrl ||
    streamState.videoUrl ||
    streamState.directUrl ||
    (activeVideo &&
    activeVideo.currentSrc &&
    !String(activeVideo.currentSrc).startsWith("blob:")
      ? activeVideo.currentSrc
      : "") ||
    Array.from(seen)[0] ||
    pageUrl;

  // kind 收口:不再把 .m4s 映射为 dash——background 只信清单 URL/清单
  // content-type,分片会在后台被明确拒绝并提示用悬浮条抓完整流。
  const kind =
    streamState.kind && streamState.kind !== "mse"
      ? streamState.kind
      : guessKind(primaryUrl);

  const payload = {
    url: primaryUrl,
    audioUrl: streamState.audioUrl || null,
    pageUrl,
    title:
      typeof document !== "undefined" && document.title
        ? document.title.trim()
        : "DownloadX_Stream",
    kind,
    mime: streamState.mime || "",
    resolution: streamState.resolution || ""
  };

  // 显示 2 秒 "已添加至下载队列" 成功反馈
  buttonFeedbackState = "queued";
  render();
  if (feedbackTimer) {
    clearTimeout(feedbackTimer);
  }
  feedbackTimer = setTimeout(() => {
    buttonFeedbackState = "idle";
    render();
  }, 2000);

  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: "QUEUE_STREAM", payload }, (reply) => {
        if (chrome.runtime.lastError || reply === undefined) {
          // 若 background.js 尚未升级 QUEUE_STREAM 处理器（任务2前过渡态），优雅回退到既有 media-found 协议
          chrome.runtime.sendMessage(
            {
              type: "media-found",
              url: payload.url,
              kind: payload.kind,
              origin: "user",
              meta: { title: payload.title, audioUrl: payload.audioUrl }
            },
            (fallbackReply) => {
              if (chrome.runtime.lastError) {
                hostProblem =
                  chrome.runtime.lastError.message ||
                  "the extension cannot reach its background worker";
                return;
              }
              if (fallbackReply && fallbackReply.ok === false) {
                hostProblem = fallbackReply.error || "the download could not be queued";
              } else {
                hostProblem = null;
              }
            }
          );
          return;
        }
        if (reply && reply.ok === false) {
          hostProblem = reply.error || "the download could not be queued";
        } else {
          hostProblem = null;
        }
      });
    }
  } catch {
    hostProblem = "the extension cannot reach its background worker";
  }
}

// ============================================================================
// 6. MAIN World 消息接收与生命周期初始化
// ============================================================================

/**
 * 处理来自 injected-sniffer.js 或 background.js 的流媒体检测详情
 * @param {Object} detail
 */
function handleDetectedMediaDetail(detail) {
  if (!detail || typeof detail !== "object") return;

  if (detail.drmProtected) {
    drmProtected = true;
    if (detail.keySystem) {
      drmKeySystem = detail.keySystem;
    }
  }

  if (detail.resolution) {
    if (!streamState.resolution || detail.trackType === "video") {
      streamState.resolution = detail.resolution;
    }
  }

  if (detail.mime) {
    streamState.mime = detail.mime;
  }

  if (Array.isArray(detail.codecs) && detail.codecs.length > 0) {
    streamState.codecs = detail.codecs;
  }

  const url = typeof detail.url === "string" ? detail.url.trim() : "";
  if (url && !url.startsWith("blob:")) {
    // kind 收口:分片 URL 不再映射为 dash,只有清单 URL 才配得上 hls/dash
    const kind = detail.kind && detail.kind !== "mse" ? detail.kind : guessKind(url);
    const trackType = detail.trackType || "unknown";

    if (kind === "hls" || kind === "dash" || !streamState.kind) {
      streamState.kind = kind;
    }

    if (trackType === "manifest" || url.includes(".m3u8") || url.includes(".mpd")) {
      streamState.manifestUrl = url;
    } else if (trackType === "audio") {
      streamState.audioUrl = url;
    } else if (trackType === "video" || trackType === "segment") {
      streamState.videoUrl = url;
    } else {
      streamState.directUrl = url;
    }

    // 同步维护 seen 集合;仅清单与完整媒体直链可 announce,分片永不单独上报
    // (单独下载一个分片只会得到打不开的碎片)。
    if ((trackType === "manifest" || kind === "http") && !isSegmentUrl(url)) {
      announce(url, kind);
      return;
    } else {
      seen.add(url);
    }
  }

  showBadge();
}

/**
 * 动态注入 injected-sniffer.js 到页面主环境（作为 manifest world: "MAIN" 的双保险）
 */
function injectMainWorldSniffer() {
  try {
    if (
      typeof document === "undefined" ||
      typeof chrome === "undefined" ||
      !chrome.runtime ||
      typeof chrome.runtime.getURL !== "function"
    ) {
      return;
    }
    if (
      typeof document.getElementById === "function" &&
      document.getElementById("__downloadx_sniffer_script__")
    ) {
      return;
    }
    const root = document.head || document.documentElement;
    if (!root || typeof root.appendChild !== "function") return;
    const script = document.createElement("script");
    script.id = "__downloadx_sniffer_script__";
    script.src = chrome.runtime.getURL("injected-sniffer.js");
    script.async = false;
    script.onload = () => {
      if (typeof script.remove === "function") script.remove();
    };
    root.appendChild(script);
  } catch {
    // 忽略受限页面注入异常
  }
}

// 绑定全局事件监听（兼容浏览器与测试沙箱）
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("message", (event) => {
    if (!event || !event.data || typeof event.data !== "object") return;
    if (
      event.source &&
      event.source !== window &&
      event.source !== globalThis &&
      event.source.location !== window.location
    ) {
      return;
    }

    const { source, type, detail } = event.data;
    if (source && source !== "downloadx-injected-sniffer") return;

    if (type === "DRM_DETECTED") {
      drmProtected = true;
      drmKeySystem = (detail && detail.keySystem) || "Widevine/PlayReady";
      showBadge();
    } else if (type === "DOWNLOADX_MEDIA_DETECTED") {
      handleDetectedMediaDetail(detail || {});
    }
  });

  window.addEventListener("resize", updateFloatingBarPosition, { passive: true });
  window.addEventListener("scroll", updateFloatingBarPosition, { passive: true });
}

if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("fullscreenchange", mountHostToAppropriateRoot);
  document.addEventListener("webkitfullscreenchange", mountHostToAppropriateRoot);

  // 处理被播放器弹幕层/控制层遮挡时的鼠标区域移动唤醒与移出隐藏
  document.addEventListener(
    "mousemove",
    (e) => {
      if (!activeVideo || !badge || typeof activeVideo.getBoundingClientRect !== "function") {
        return;
      }
      const rect = activeVideo.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      if (inside) {
        revealFloatingBar();
        scheduleAutoHide();
      } else if (!isHoveringBar) {
        hideFloatingBar();
      }
    },
    { passive: true }
  );
}

if (
  typeof chrome !== "undefined" &&
  chrome.runtime &&
  chrome.runtime.onMessage &&
  typeof chrome.runtime.onMessage.addListener === "function"
) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "stream-detected" || msg.type === "DOWNLOADX_MEDIA_DETECTED") {
      handleDetectedMediaDetail({
        url: msg.url,
        kind: msg.kind || guessKind(msg.url),
        mime: msg.mime || "",
        trackType: msg.trackType || "unknown"
      });
    }
  });
}

if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
  const domObserver = new MutationObserver(() => {
    if (typeof document.querySelector === "function" && document.querySelector("video")) {
      ensureActiveVideoBinding();
      if (seen.size > 0 || streamState.videoUrl || streamState.manifestUrl || drmProtected) {
        updateFloatingBarPosition();
      }
    }
  });

  if (document.documentElement) {
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
  } else if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("DOMContentLoaded", () => {
      if (document.documentElement) {
        domObserver.observe(document.documentElement, { childList: true, subtree: true });
      }
      ensureActiveVideoBinding();
    });
  }
}

injectMainWorldSniffer();
checkHost();