// Settings, with defaults that mirror what a download manager needs to be
// useful on first run.

import fsp from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { paths, ensureDirs } from "./paths.mjs";

export const DEFAULT_CONFIG = {
  version: 1,

  /** Where finished files go when the caller does not say. */
  defaultDir: "",

  /**
   * Accepted but unused. Earlier versions exposed a temporary staging root
   * here; nothing consumes it any more (staging always lands beside the target
   * file, which is what the staged publish in store.mjs requires). The field
   * stays so old config.json files still load and round-trip unchanged.
   */
  tempDir: "",

  /** Concurrency and segmentation. */
  maxConnections: 8,
  maxConnectionsPerServer: 8,
  segmentBytes: 8 * 1024 * 1024,
  maxConcurrentDownloads: 3,

  /**
   * Named queue groups, each with its own cap on in-flight downloads. The
   * scheduler (queue.pump) enforces each group's cap on top of
   * maxConcurrentDownloads, which stays the total gate — a group cap can only
   * narrow the global limit, never widen it. A queueId no group lists follows
   * the global limit alone.
   *
   * The default is exactly one group whose cap (32) can never bind below the
   * global limit — maxConcurrentDownloads itself clamps to 1..32 in sanitize
   * — so out of the box this is the old single-queue behaviour for every
   * queueId ("default" and internal sources like "clipboard" alike).
   */
  queues: [{ id: "default", name: "Default", concurrent: 32 }],

  /** Global speed limit in bytes/sec; 0 = unlimited. */
  speedLimit: 0,

  /** Retry policy. */
  maxRetries: 6,
  retryBaseMs: 500,

  /**
   * Networking. `proxy` is the manual proxy URL (may carry user:pass, which
   * the net layer turns into a Proxy-Authorization header — P-18); how it is
   * applied is decided by proxyMode, consumed for real by the downloader's
   * per-run selection (selectRunProxy in src/downloader.mjs, P-18/batch-7):
   *   * "manual" — always this proxy;
   *   * "none"   — never any proxy, even when this field is set;
   *   * "system" — the OS-configured proxy (registry on Windows, env vars
   *     elsewhere; src/sysproxy.mjs), with this field as the fallback when
   *     the OS has no proxy configured. Per-task proxies set by the API/CLI
   *     caller outrank the mode entirely.
   */
  proxy: "",
  proxyMode: "system",   // system | manual | none
  userAgent: "",          // empty = built-in default
  insecure: false,

  /**
   * Remote agent access. While false the daemon binds 127.0.0.1 only and the
   * Host guard refuses anything but loopback names. While true the daemon
   * binds every interface so MCP-over-HTTP clients on the LAN can reach
   * /mcp and /api — the token stays mandatory on every route, and enabling
   * this on an untrusted network exposes the downloader (and its write
   * locations) to whoever can reach the port.
   */
  remoteAccess: false,

  /** Behaviour. */
  monitorClipboard: true,

  /**
   * P-25: clipboard watching done by the desktop shell's in-process bridge
   * (desktop/main.mjs polls electron.clipboard and POSTs /api/tasks). While
   * true the daemon does not start its own PowerShell-polling ClipboardWatcher
   * — on this host every powershell.exe spawned from the daemon's lineage dies
   * in GUI initialisation (0xC0000142, desktop/main.mjs), so that watcher could
   * never read the clipboard anyway. The desktop shell PATCHes this true when
   * it starts the bridge; a daemon run without the desktop shell keeps the old
   * behaviour.
   */
  clipboardBridge: false,

  /**
   * Ask before adding. While on, adds whose source is the browser extension
   * or the clipboard watcher do not enter the queue directly: they sit in a
   * pending list (GET /api/pending) until approved (with optional
   * dir/filename/category overrides), rejected, or timed out. Manual adds
   * (CLI, GUI, plain API calls) are never held.
   */
  askBeforeAdd: true,

  /**
   * How long a pending add may wait for a decision before it is queued to
   * the default directory on its own. The timeout policy is deliberately
   * "queue it anyway": better to download something the user did not confirm
   * than to silently drop a link they acted on.
   */
  askBeforeAddTimeoutMs: 5 * 60 * 1000,

  /** Local capture proxy: off by default because it changes how traffic flows. */
  captureProxy: {
    enabled: false,
    port: 8597,
    mode: "tunnel",
    upstreamProxy: "",
    autoQueue: false,
    autoQueueConfidence: "high",
  },

  /** Optional explicit ffmpeg path; empty = search PATH. */
  ffmpegPath: "",
  /**
   * Optional explicit aria2c path; empty = search PATH then the usual
   * Windows install locations (see findAria2c in src/bt.mjs). Magnet/BT
   * downloads are delegated to this external engine — empty means "not
   * configured", and a missing binary fails those tasks with a readable
   * message instead of a silent no-op.
   */
  aria2cPath: "",
  /**
   * 批-8: optional explicit yt-dlp path; empty = search PATH then the app
   * root for the packaged binary (see findYtDlp in src/ytdlp.mjs). Consumed
   * by the smart fallback (an HTML page / a failed probe gets resolved to a
   * direct link) and by full-delegation tasks (kind "ytdlp").
   */
  ytdlpPath: "",
  /**
   * 批-8: when yt-dlp cannot be found anywhere, download the official release
   * binary into the app root (src/ytdlp.mjs::downloadYtDlp). Default false —
   * fetching and running an executable is the user's explicit decision, and
   * this flag IS the confirmation; nothing is ever downloaded while it is off.
   */
  ytdlpAutoDownload: false,
  categorizeByType: true,
  overwriteExisting: "rename",   // rename | overwrite | skip
  startQueueAutomatically: true,

  /** Categories: subfolder per file class (relative to the target dir). */
  categories: {
    video: ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "ts", "m2ts", "3gp"],
    audio: ["mp3", "m4a", "aac", "flac", "wav", "ogg", "wma", "opus", "ape"],
    archive: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "cab", "tgz"],
    document: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "epub", "mobi", "csv"],
    program: ["exe", "msi", "apk", "dmg", "deb", "rpm", "appx", "jar", "bin"],
    image: ["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "tiff", "ico", "heic"],
  },

  /**
   * Browser-download takeover (the extension's chrome.downloads.onCreated
   * relay). mode: "notify" asks per download via a system notification,
   * "auto" transfers without asking, "off" leaves the browser alone.
   * extensions is the takeover table: a download whose URL extension is
   * listed AND whose known size is above 1 MiB is a candidate.
   */
  takeover: {
    mode: "notify",
    extensions: [
      // 归档
      "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "cab", "tgz",
      // 程序
      "exe", "msi", "apk", "dmg", "deb", "rpm", "appx", "jar", "bin",
      // 视频
      "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "ts", "m2ts", "3gp",
      // 音频
      "mp3", "m4a", "aac", "flac", "wav", "ogg", "wma", "opus", "ape",
    ],
  },

  /** Hosts that should never be intercepted or auto-added. */
  exceptions: [
    "*.update.microsoft.com",
    "download.windowsupdate.com",
    "*.download.windowsupdate.com",
  ],
};

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export class Config extends EventEmitter {
  constructor(file = paths.config) {
    super();
    this.file = file;
    this.values = { ...DEFAULT_CONFIG };
  }

  static sanitize(values) {
    /** Number(x) with a fallback that only applies to NaN/undefined. */
    const num = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const clampInt = (v, lo, hi, fallback) => {
      const n = num(v, fallback);
      return Math.max(lo, Math.min(hi, Math.trunc(n)));
    };

    const c = { ...DEFAULT_CONFIG, ...values };
    c.maxConnections = Math.max(1, Math.min(32, Number(c.maxConnections) || 8));
    c.maxConnectionsPerServer = Math.max(1, Math.min(32, Number(c.maxConnectionsPerServer) || 8));
    c.segmentBytes = Math.max(64 * 1024, Number(c.segmentBytes) || 8 * 1024 * 1024);
    // An explicit 0 is a real value that must clamp to 1, not fall through to
    // the default: "|| 3" would silently turn "no concurrency" into three.
    c.maxConcurrentDownloads = clampInt(c.maxConcurrentDownloads, 1, 32, 3);
    // Queue groups (batch-4 W2). Validation mirrors the takeover-table style:
    // junk entries are dropped rather than fatal — a dropped group's tasks
    // simply follow the global limit — a duplicate id keeps the first
    // occurrence, a missing name falls back to the id, and a concurrent that
    // is absent or unparseable degrades to 32, the one value that can never
    // bind below the global cap, instead of surprising the user with a
    // tighter one. An explicit number is clamped to 1..32 like every other
    // concurrency knob. A missing, non-array or empty `queues` is the default
    // single group, so config.json files written before this field existed
    // keep today's behaviour untouched.
    const rawQueues = Array.isArray(c.queues) ? c.queues : [];
    const seenQueueIds = new Set();
    const cleanQueues = [];
    for (const raw of rawQueues) {
      if (cleanQueues.length >= 64) break;   // bound the table, like takeover.extensions
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      if (!id || id.length > 64 || seenQueueIds.has(id)) continue;
      seenQueueIds.add(id);
      const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
      const concurrent = raw.concurrent == null
        ? 32
        : clampInt(raw.concurrent, 1, 32, 32);
      cleanQueues.push({ id, name, concurrent });
    }
    c.queues = cleanQueues.length > 0 ? cleanQueues : [{ ...DEFAULT_CONFIG.queues[0] }];
    c.speedLimit = Math.max(0, Number(c.speedLimit) || 0);
    c.maxRetries = Math.max(0, Math.min(50, Number(c.maxRetries) || 6));
    c.retryBaseMs = Math.max(50, Number(c.retryBaseMs) || 500);
    if (!["system", "manual", "none"].includes(c.proxyMode)) c.proxyMode = "system";
    if (!["rename", "overwrite", "skip"].includes(c.overwriteExisting)) c.overwriteExisting = "rename";
    // aria2c path: a plain trimmed string or back to "not configured". Never
    // a number or an object from a hand-edited config.json — findAria2c would
    // then probe a nonsense path and BT tasks would fail confusingly.
    c.aria2cPath = typeof c.aria2cPath === "string" ? c.aria2cPath.trim() : "";
    // 批-8: the yt-dlp keys follow the same discipline as their aria2c and
    // remoteAccess counterparts — a plain trimmed string or back to "not
    // configured" (findYtDlp must not probe a nonsense path), and the
    // auto-download switch is explicit-true-only because it fetches and runs
    // a binary from the internet.
    c.ytdlpPath = typeof c.ytdlpPath === "string" ? c.ytdlpPath.trim() : "";
    c.ytdlpAutoDownload = c.ytdlpAutoDownload === true || c.ytdlpAutoDownload === "true";
    // Asking before adding is the safe default, so only an explicit false (or
    // its string form, which a hand-edited config.json may carry) turns it
    // off; a missing or malformed value keeps the default rather than
    // silently letting unattended adds through.
    c.askBeforeAdd = !(c.askBeforeAdd === false || c.askBeforeAdd === "false" || c.askBeforeAdd === 0);
    c.askBeforeAddTimeoutMs = clampInt(c.askBeforeAddTimeoutMs, 1000, 24 * 60 * 60 * 1000, 5 * 60 * 1000);
    // Remote access widens the blast radius (LAN-visible file writer), so the
    // same "explicit true only" rule as askBeforeAdd applies.
    c.remoteAccess = c.remoteAccess === true || c.remoteAccess === "true";
    // P-25 clipboard bridge: same "explicit true only" rule. A missing or
    // malformed value stays false, so a daemon run without the desktop shell
    // keeps watching the clipboard itself (or at least trying to) exactly as
    // before; only the desktop shell turning the bridge on writes a real true.
    c.clipboardBridge = c.clipboardBridge === true || c.clipboardBridge === "true";
    const cp = c.captureProxy || {};
    c.captureProxy = {
      enabled: Boolean(cp.enabled),
      port: Math.max(1024, Math.min(65535, Number(cp.port) || 8597)),
      mode: cp.mode === "mitm" ? "mitm" : "tunnel",
      upstreamProxy: typeof cp.upstreamProxy === "string" ? cp.upstreamProxy : "",
      autoQueue: Boolean(cp.autoQueue),
      autoQueueConfidence: ["high", "medium", "low"].includes(cp.autoQueueConfidence) ? cp.autoQueueConfidence : "high",
    };
    if (!c.defaultDir) c.defaultDir = process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "Downloads")
      : path.join(process.env.HOME || ".", "Downloads");
    // Browser takeover. The table accepts an array of extensions or one
    // comma-separated string (what a hand-edited config.json may carry);
    // tokens are trimmed, lower-cased and stripped of leading dots, junk
    // tokens are dropped, duplicates collapse. An empty table means "back to
    // the default table", not "take over everything".
    const TAKEOVER_MODES = ["notify", "auto", "off"];
    const rawTk = c.takeover && typeof c.takeover === "object" ? c.takeover : {};
    let tkExts = [];
    if (Array.isArray(rawTk.extensions)) {
      tkExts = rawTk.extensions;
    } else if (typeof rawTk.extensions === "string") {
      tkExts = rawTk.extensions.split(",");
    }
    const seenTk = new Set();
    const cleanTkExts = [];
    for (const raw of tkExts) {
      if (typeof raw !== "string") continue;
      const token = raw.trim().toLowerCase().replace(/^[.\s]+/, "");
      if (!/^[a-z0-9]{1,8}$/.test(token)) continue;
      if (seenTk.has(token)) continue;
      seenTk.add(token);
      cleanTkExts.push(token);
      if (cleanTkExts.length >= 256) break;
    }
    c.takeover = {
      mode: TAKEOVER_MODES.includes(rawTk.mode) ? rawTk.mode : "notify",
      extensions: cleanTkExts.length > 0 ? cleanTkExts : [...DEFAULT_CONFIG.takeover.extensions],
    };
    return c;
  }

  async load() {
    await ensureDirs();
    try {
      const raw = await fsp.readFile(this.file, "utf8");
      this.values = Config.sanitize(deepMerge(DEFAULT_CONFIG, JSON.parse(raw)));
    } catch (err) {
      if (err.code !== "ENOENT") {
        // A damaged config must not stop the daemon; keep defaults and say so.
        this.emit("warn", `config unreadable (${err.message}); using defaults`);
      }
      this.values = Config.sanitize({});
    }
    return this.values;
  }

  async save() {
    await ensureDirs();
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.values, null, 2), "utf8");
    await fsp.rename(tmp, this.file);
    this.emit("change", this.values);
  }

  get(key) { return this.values[key]; }

  async set(patch) {
    this.values = Config.sanitize(deepMerge(this.values, patch));
    await this.save();
    return this.values;
  }

  async reset() {
    this.values = Config.sanitize({});
    await this.save();
    return this.values;
  }
}
