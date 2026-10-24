/**
 * @file extension/injected-sniffer.js
 * @description DownloadX 页面主环境 (MAIN World) 多维流媒体嗅探与 DRM 熔断注入脚本。
 * 负责拦截 window.fetch、XMLHttpRequest、HTMLMediaElement.prototype.play、
 * MediaSource.prototype.addSourceBuffer 以及 EME DRM API，并通过 window.postMessage
 * 向 ISOLATED World 中的 content.js 广播结构化流媒体元数据。
 */

(() => {
  // 防止重复注入执行
  if (window.__DOWNLOADX_SNIFFER_INSTALLED__) {
    return;
  }
  Object.defineProperty(window, "__DOWNLOADX_SNIFFER_INSTALLED__", {
    value: true,
    writable: false,
    configurable: false
  });

  /** @type {string} 消息来源标识，供 content.js 校验 */
  const MESSAGE_SOURCE = "downloadx-injected-sniffer";

  /** @type {Set<string>} 已广播的流特征集合，防止高频分片重复轰炸 postMessage */
  const reportedSignatures = new Set();
  const MAX_SIGNATURES = 500;

  /** @type {boolean} 当前页面是否已触发 DRM 硬件保护熔断 */
  let pageDrmProtected = false;

  /** @type {string|null} 检测到的 DRM KeySystem 名称 */
  let detectedKeySystem = null;

  /** @type {Set<string>} 已捕获的 MSE SourceBuffer MIME/Codecs 配置 */
  const mseMimeTypes = new Set();

  /** @type {WeakMap<XMLHttpRequest, { url: string, method: string }>} XHR 实例元数据映射 */
  const xhrMetaMap = new WeakMap();

  /**
   * 常见受保护的商业 DRM KeySystem 匹配正则
   * 涵盖 Widevine (com.widevine.alpha)、PlayReady (com.microsoft.playready*)、FairPlay (com.apple.fps*)、ClearKey 等
   */
  const DRM_KEY_SYSTEM_RE = /widevine|playready|fairplay|com\.widevine\.alpha|com\.microsoft\.playready|com\.apple\.fps|org\.w3\.clearkey/i;

  /**
   * 流媒体 URL 路径特征匹配正则（匹配 .m3u8, .mpd, .m4s, .mp4, .aac, .flv, .ts 等）
   */
  const STREAM_EXT_RE = /\.(m3u8|mpd|m4s|mp4|m4v|m4a|aac|flv|webm|ts)(\?|#|$)/i;

  /**
   * 媒体响应 Content-Type 匹配正则
   */
  const MEDIA_MIME_RE = /^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|octet-stream))/i;

  /**
   * 将相对路径或 URL 对象规范化为绝对 HTTP(S) URL
   * @param {string|URL|Request} input 原始 URL 输入
   * @returns {string|null} 规范化后的绝对 URL，非 http/https/blob 则返回 null
   */
  function normalizeUrl(input) {
    try {
      let raw = "";
      if (typeof input === "string") {
        raw = input.trim();
      } else if (input && typeof input.url === "string") {
        raw = input.url.trim();
      } else if (typeof URL !== "undefined" && input instanceof URL) {
        raw = input.href;
      }
      if (!raw || raw.startsWith("data:")) return null;
      const base =
        typeof window !== "undefined" && window.location && window.location.href
          ? window.location.href
          : "https://localhost/";
      const parsed = new URL(raw, base);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "blob:") {
        return null;
      }
      return parsed.href;
    } catch {
      return null;
    }
  }

  /**
   * 根据 URL 与 MIME Type 推断流媒体协议类型 (kind) 与轨道类型 (trackType)
   * @param {string} url 规范化后的 URL
   * @param {string} [mime=""] 响应或 SourceBuffer 的 Content-Type / MIME
   * @returns {{ kind: "hls"|"dash"|"http"|"mse", trackType: "manifest"|"video"|"audio"|"segment"|"unknown" } | null}
   */
  function classifyMedia(url, mime = "") {
    const cleanPath = (url || "").split("?")[0].split("#")[0].toLowerCase();
    const lowerMime = (mime || "").toLowerCase();

    // 1. HLS 清单识别
    if (
      cleanPath.endsWith(".m3u8") ||
      lowerMime.includes("vnd.apple.mpegurl") ||
      lowerMime.includes("x-mpegurl")
    ) {
      return { kind: "hls", trackType: "manifest" };
    }

    // 2. DASH 清单识别
    if (cleanPath.endsWith(".mpd") || lowerMime.includes("dash+xml")) {
      return { kind: "dash", trackType: "manifest" };
    }

    // 3. fMP4 / DASH 分轨媒体段 (.m4s) 或带音视频标识的分片。
    //    分片不是清单,kind 一律按 http 报给 content.js(收口原则:只有
    //    .m3u8/.mpd 清单才配得上 hls/dash);trackType 仍区分音轨/视频轨,
    //    供悬浮条展示与 audioUrl 关联。分片不会单独入队。
    if (cleanPath.endsWith(".m4s") || /[/_-](video|audio)[/_-].*\.(m4s|mp4)/i.test(cleanPath)) {
      let trackType = "segment";
      if (
        lowerMime.startsWith("audio/") ||
        /audio|mp4a|aac|opus|ec-3|ac-3|30280|30216|30232/i.test(url)
      ) {
        trackType = "audio";
      } else if (
        lowerMime.startsWith("video/") ||
        /video|avc1|hev1|hvc1|vp09|av01/i.test(url)
      ) {
        trackType = "video";
      }
      return { kind: "http", trackType };
    }

    // 4. 直链视频或音频 (MP4 / WebM / FLV / M4A / AAC)
    if (/\.(mp4|m4v|webm|flv)$/i.test(cleanPath)) {
      return { kind: "http", trackType: "video" };
    }
    if (/\.(m4a|aac|mp3|ogg|opus)$/i.test(cleanPath)) {
      return { kind: "http", trackType: "audio" };
    }

    // 5. 根据响应头 Content-Type 判定(同样不产生 dash:分片不是清单)
    if (lowerMime.startsWith("video/")) {
      return { kind: "http", trackType: "video" };
    }
    if (lowerMime.startsWith("audio/")) {
      return { kind: "http", trackType: "audio" };
    }

    return null;
  }

  /**
   * 尝试从 URL 参数或当前活跃 video 元素推断视频分辨率标签（如 4K / 1080P / 720P）
   * @param {string} url 媒体 URL
   * @param {HTMLVideoElement} [videoEl] 关联的 video 元素
   * @returns {string} 分辨率描述字符串
   */
  function inferResolution(url = "", videoEl = null) {
    if (videoEl && videoEl.videoHeight > 0) {
      const h = videoEl.videoHeight;
      if (h >= 2160) return "4K";
      if (h >= 1440) return "2K";
      if (h >= 1080) return "1080P";
      if (h >= 720) return "720P";
      if (h >= 480) return "480P";
      return `${h}P`;
    }

    const lower = url.toLowerCase();
    if (/2160p|4k|qn=120|qn=125|qn=126|qn=127|_2160/i.test(lower)) return "4K";
    if (/1440p|2k|qn=116|_1440/i.test(lower)) return "2K";
    if (/1080p|qn=80|qn=112|_1080/i.test(lower)) return "1080P";
    if (/720p|qn=64|_720/i.test(lower)) return "720P";
    if (/480p|qn=32|_480/i.test(lower)) return "480P";
    return "";
  }

  /**
   * 向 ISOLATED World 的 content.js 发送结构化消息
   * @param {"DOWNLOADX_MEDIA_DETECTED"|"DRM_DETECTED"} type 消息类型
   * @param {Object} detail 负载详情
   */
  function postToContentScript(type, detail) {
    try {
      window.postMessage(
        {
          source: MESSAGE_SOURCE,
          type,
          detail: {
            ...detail,
            drmProtected: Boolean(detail.drmProtected || pageDrmProtected),
            keySystem: detail.keySystem || detectedKeySystem || null,
            timestamp: Date.now()
          }
        },
        "*"
      );
    } catch {
      // 忽略跨域或序列化异常
    }
  }

  /**
   * 广播发现的媒体流（带防抖签名去重）
   * @param {Object} params
   * @param {string} params.url 媒体 URL
   * @param {string} [params.mime=""] MIME 类型
   * @param {"hls"|"dash"|"http"|"mse"} [params.kind] 协议类型
   * @param {"manifest"|"video"|"audio"|"segment"|"unknown"} [params.trackType] 轨道类型
   * @param {string} [params.resolution=""] 分辨率
   */
  function emitMediaDetected({ url, mime = "", kind, trackType, resolution = "" }) {
    if (!url || url.startsWith("blob:")) return;

    const classification = classifyMedia(url, mime);
    const finalKind = kind || (classification && classification.kind);
    const finalTrackType = trackType || (classification && classification.trackType) || "unknown";
    if (!finalKind) return;

    // 对分片 URL 按去查询参数路径或基础签名去重，避免同一流成百上千个分片刷屏
    const signatureKey = `${finalKind}:${finalTrackType}:${url.split("&range=")[0].split("?range=")[0]}`;
    if (reportedSignatures.has(signatureKey)) return;

    if (reportedSignatures.size >= MAX_SIGNATURES) {
      const oldest = reportedSignatures.values().next().value;
      reportedSignatures.delete(oldest);
    }
    reportedSignatures.add(signatureKey);

    postToContentScript("DOWNLOADX_MEDIA_DETECTED", {
      url,
      mime: mime || Array.from(mseMimeTypes).join(" | "),
      kind: finalKind,
      trackType: finalTrackType,
      resolution: resolution || inferResolution(url),
      codecs: Array.from(mseMimeTypes),
      drmProtected: pageDrmProtected
    });
  }

  /**
   * 触发 DRM 熔断事件并通知 Content Script
   * @param {string} keySystem 检测到的 DRM 系统标识
   * @param {string} [reason=""] 触发来源描述
   */
  function triggerDrmProtection(keySystem, reason = "") {
    const ks = String(keySystem || "unknown-drm");
    const isFirstDetection = !pageDrmProtected || detectedKeySystem !== ks;
    pageDrmProtected = true;
    detectedKeySystem = ks;

    if (isFirstDetection) {
      const href =
        typeof window !== "undefined" && window.location ? window.location.href : "";
      // 1. 广播专门的 DRM_DETECTED 事件
      postToContentScript("DRM_DETECTED", {
        url: href,
        mime: Array.from(mseMimeTypes).join(" | "),
        kind: "dash",
        drmProtected: true,
        keySystem: ks,
        reason
      });
      // 2. 同步发送带 drmProtected: true 的 DOWNLOADX_MEDIA_DETECTED 事件
      postToContentScript("DOWNLOADX_MEDIA_DETECTED", {
        url: href,
        mime: Array.from(mseMimeTypes).join(" | "),
        kind: "dash",
        drmProtected: true,
        keySystem: ks,
        reason
      });
    }
  }

  // ============================================================================
  // 1. 拦截 window.fetch
  // ============================================================================
  if (typeof window.fetch === "function") {
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const reqUrl = normalizeUrl(args[0]);
      if (reqUrl && STREAM_EXT_RE.test(reqUrl)) {
        emitMediaDetected({ url: reqUrl });
      }

      const response = await Reflect.apply(originalFetch, this, args);

      try {
        const finalUrl = normalizeUrl((response && response.url) || reqUrl);
        const contentType =
          (response &&
          response.headers &&
          typeof response.headers.get === "function"
            ? response.headers.get("content-type")
            : "") || "";

        if (finalUrl && (STREAM_EXT_RE.test(finalUrl) || MEDIA_MIME_RE.test(contentType))) {
          emitMediaDetected({ url: finalUrl, mime: contentType });
        }
      } catch {
        // 忽略 opaque response 等读取异常
      }

      return response;
    };
  }

  // ============================================================================
  // 2. 拦截 XMLHttpRequest.prototype.open & send
  // ============================================================================
  if (typeof XMLHttpRequest !== "undefined" && XMLHttpRequest.prototype) {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      const normUrl = normalizeUrl(url);
      if (normUrl) {
        xhrMetaMap.set(this, { url: normUrl, method: String(method || "GET") });
        if (STREAM_EXT_RE.test(normUrl)) {
          emitMediaDetected({ url: normUrl });
        }
      }
      return Reflect.apply(originalOpen, this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      if (typeof this.addEventListener === "function") {
        this.addEventListener(
          "readystatechange",
          function () {
            if (this.readyState === 2 || this.readyState === 4) {
              try {
                const meta = xhrMetaMap.get(this);
                const finalUrl = normalizeUrl(this.responseURL || (meta && meta.url));
                if (!finalUrl) return;
                const contentType =
                  typeof this.getResponseHeader === "function"
                    ? this.getResponseHeader("content-type") || ""
                    : "";
                if (STREAM_EXT_RE.test(finalUrl) || MEDIA_MIME_RE.test(contentType)) {
                  emitMediaDetected({ url: finalUrl, mime: contentType });
                }
              } catch {
                // 忽略跨域头部读取错误
              }
            }
          },
          { passive: true }
        );
      }
      return Reflect.apply(originalSend, this, args);
    };
  }

  // ============================================================================
  // 3. Hook MediaSource.prototype.addSourceBuffer 与 HTMLMediaElement.prototype.play
  // ============================================================================
  if (typeof MediaSource !== "undefined" && MediaSource.prototype) {
    const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mimeType) {
      if (typeof mimeType === "string" && mimeType.trim()) {
        const cleanMime = mimeType.trim();
        mseMimeTypes.add(cleanMime);

        // 广播捕获到的 MSE 编解码器配置（如 video/mp4; codecs="avc1..." 或 audio/mp4; codecs="mp4a..."）
        postToContentScript("DOWNLOADX_MEDIA_DETECTED", {
          url: "",
          mime: cleanMime,
          kind: "mse",
          trackType: cleanMime.toLowerCase().startsWith("audio/") ? "audio" : "video",
          codecs: Array.from(mseMimeTypes),
          drmProtected: pageDrmProtected
        });
      }
      return Reflect.apply(originalAddSourceBuffer, this, [mimeType]);
    };
  }

  if (typeof HTMLMediaElement !== "undefined" && HTMLMediaElement.prototype) {
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      try {
        // 检查当前元素是否已绑定 mediaKeys (DRM)
        if (this.mediaKeys) {
          triggerDrmProtection(
            detectedKeySystem || "HTMLMediaElement.mediaKeys",
            "video.mediaKeys present on play()"
          );
        }

        const mediaSrc = normalizeUrl(this.currentSrc || this.src);
        const isVideo =
          typeof HTMLVideoElement !== "undefined" && this instanceof HTMLVideoElement;
        const isAudio =
          typeof HTMLAudioElement !== "undefined" && this instanceof HTMLAudioElement;
        const resolution = isVideo ? inferResolution(mediaSrc || "", this) : "";

        if (mediaSrc && !mediaSrc.startsWith("blob:")) {
          const classified = classifyMedia(mediaSrc);
          emitMediaDetected({
            url: mediaSrc,
            mime: "",
            kind: (classified && classified.kind) || "http",
            trackType: isAudio ? "audio" : "video",
            resolution
          });
        } else if (resolution) {
          // 即使当前是 blob: URL，也向 content.js 同步当前播放器的实际分辨率与 MSE 状态
          postToContentScript("DOWNLOADX_MEDIA_DETECTED", {
            url: "",
            mime: Array.from(mseMimeTypes).join(" | "),
            kind: "mse",
            trackType: "video",
            resolution,
            codecs: Array.from(mseMimeTypes),
            drmProtected: pageDrmProtected
          });
        }
      } catch {
        // 忽略钩子内部错误，保证宿主播放器正常播放
      }
      return Reflect.apply(originalPlay, this, args);
    };
  }

  // ============================================================================
  // 4. DRM 检测与熔断机制 (Widevine / PlayReady / FairPlay)
  // ============================================================================
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.requestMediaKeySystemAccess === "function"
  ) {
    const originalRequestMediaKeySystemAccess =
      navigator.requestMediaKeySystemAccess.bind(navigator);

    navigator.requestMediaKeySystemAccess = async function (
      keySystem,
      supportedConfigurations
    ) {
      const ks = String(keySystem || "");
      if (DRM_KEY_SYSTEM_RE.test(ks)) {
        triggerDrmProtection(ks, "navigator.requestMediaKeySystemAccess");
      }
      const access = await originalRequestMediaKeySystemAccess(
        keySystem,
        supportedConfigurations
      );
      if (ks) {
        triggerDrmProtection(ks, "navigator.requestMediaKeySystemAccess resolved");
      }
      return access;
    };
  }

  if (
    typeof HTMLMediaElement !== "undefined" &&
    HTMLMediaElement.prototype &&
    typeof HTMLMediaElement.prototype.setMediaKeys === "function"
  ) {
    const originalSetMediaKeys = HTMLMediaElement.prototype.setMediaKeys;
    HTMLMediaElement.prototype.setMediaKeys = function (mediaKeys) {
      if (mediaKeys) {
        triggerDrmProtection(
          detectedKeySystem || "EME-MediaKeys",
          "HTMLMediaElement.prototype.setMediaKeys"
        );
      }
      return Reflect.apply(originalSetMediaKeys, this, [mediaKeys]);
    };
  }

  // 监听媒体元素的 encrypted 事件（CENC/cbcs 加密流初始化时触发）
  if (typeof window.addEventListener === "function") {
    window.addEventListener(
      "encrypted",
      (event) => {
        const initDataType = event && event.initDataType ? event.initDataType : "cenc";
        triggerDrmProtection(
          detectedKeySystem || `EME-${initDataType}`,
          "HTMLMediaElement encrypted event"
        );
      },
      true
    );
  }
})();