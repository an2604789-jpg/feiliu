// Small shared helpers: size math, formatting, filenames.

import fsp from "node:fs/promises";

export const KB = 1024;
export const MB = KB * 1024;
export const GB = MB * 1024;

/** Parse "10M" / "512k" / "1048576" into bytes. */
export function parseSize(input) {
  if (typeof input === "number") return input;
  const m = /^([\d.]+)\s*(k|kb|m|mb|g|gb)?$/i.exec(String(input ?? "").trim());
  if (!m) throw new Error(`invalid size: ${input}`);
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid size: ${input}`);
  const unit = (m[2] || "").toLowerCase();
  if (unit.startsWith("k")) return Math.round(n * KB);
  if (unit.startsWith("m")) return Math.round(n * MB);
  if (unit.startsWith("g")) return Math.round(n * GB);
  return Math.round(n);
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < KB) return `${n} B`;
  if (n < MB) return `${(n / KB).toFixed(1)} KB`;
  if (n < GB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / GB).toFixed(2)} GB`;
}

export const formatSpeed = (bps) => (bps > 0 ? `${formatBytes(bps)}/s` : "—");

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "--:--";
  const t = Math.round(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (x) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * mkdir with bounded retry for transient Windows denials.
 *
 * A live daemon was once observed failing mkdir with EPERM on every attempt
 * while fresh processes on the same machine succeeded against the same path
 * (kernel filter interference; 施工记录 附记七, 2026-10-24). Retrying absorbs
 * the transient form; the steady form still fails, and the rethrown error
 * then carries the recovery hint instead of a bare "operation not permitted"
 * that reads like a permissions misconfiguration.
 */
export async function mkdirWithRetry(dir) {
  const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "EAGAIN"]);
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fsp.mkdir(dir, { recursive: true });
      return;
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT.has(err?.code)) break;
      await sleep(40 * (attempt + 1));
    }
  }
  const e = new Error(
    "cannot create directory " + (lastErr?.path || dir) + " (" + (lastErr?.code || lastErr?.message) + ")" +
    "；已自动重试，持续失败多为安全软件/过滤驱动瞬时拦截，重启 DownloadX 后重试通常可恢复"
  );
  e.code = lastErr?.code || "EMKDIR";
  e.path = lastErr?.path || dir;
  throw e;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const onAbort = () => { clearTimeout(timer); reject(new Error("aborted")); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Device names Windows resolves to hardware, whatever case they are written in
 * and whatever extension follows: "con.txt" and "NUL.mp4" name a device, not a
 * file. COM0/LPT0 and newer SUP-ports are deliberately out — the historical
 * set below is what every Windows version refuses.
 */
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..+)?$/i;

/**
 * Extension implied by a response Content-Type, for URLs whose last path
 * segment carries none (CDN tokens like "o8xBaemb…/79MB" name a bilibili
 * segment but leave the file unopenable — Windows has nothing to associate).
 * Only concrete types map; application/octet-stream deliberately does not,
 * because guessing an extension there would be fabrication.
 */
const CONTENT_TYPE_EXTENSIONS = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/mp2t": "ts",
  "video/quicktime": "mov",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-7z-compressed": "7z",
  "application/gzip": "gz",
  "application/x-rar-compressed": "rar",
  "application/vnd.rar": "rar",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "text/html": "html",
  "text/plain": "txt",
  "application/json": "json",
};

/**
 * Append the Content-Type's extension when a target name has none.
 * A name that already ends in any short dot-suffix is kept as-is; the point
 * is only to rescue extension-less CDN names, never to second-guess the
 * server's own naming.
 */
export function ensureExtension(name, contentType) {
  const base = String(name || "").trim();
  if (!base || /\.[a-z0-9]{1,8}$/i.test(base)) return base;
  const ct = String(contentType || "").split(";")[0].trim().toLowerCase();
  const ext = CONTENT_TYPE_EXTENSIONS[ct];
  return ext ? `${base}.${ext}` : base;
}

/** Strip characters Windows refuses in file names. */
export function sanitizeName(name, fallback = "download") {
  // Trailing dots and spaces are stripped first: Windows silently deletes them
  // from a path component, so a kept "nul. " would still open the NUL device.
  const cleaned = String(name || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim();
  // The device name is what precedes the first dot, so "nul.mp4" is as
  // unusable as "nul". A "_" prefix keeps the user's text and makes the name
  // addressable; a longer word that merely starts like a device ("compact")
  // is untouched.
  const safe = RESERVED_DEVICE.test(cleaned) ? `_${cleaned}` : cleaned;
  return safe.slice(0, 180).replace(/[.\s]+$/, "") || fallback;
}

/** Last path segment of a URL, decoded, or "" when it is not usable. */
export function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(last);
  } catch {
    return "";
  }
}

/** RFC 6266 / 5987 Content-Disposition filename, when present. */
export function filenameFromDisposition(header) {
  if (!header) return "";
  const star = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (star) {
    const raw = star[1].trim().replace(/^"|"$/g, "");
    const m = /^([\w-]+)''(.*)$/.exec(raw);
    try {
      return m ? decodeURIComponent(m[2]) : decodeURIComponent(raw);
    } catch { /* fall through to the plain form */ }
  }
  const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(header);
  if (plain) return (plain[2] ?? plain[3] ?? "").trim();
  return "";
}

/** Exponential backoff with jitter, capped. */
export function backoffDelay(attempt, baseMs = 500, capMs = 30_000) {
  const raw = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(raw * (0.7 + Math.random() * 0.6));
}
