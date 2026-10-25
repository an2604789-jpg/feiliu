// Capability probe: what does this origin let us do?
//
// Two questions decide the whole download strategy:
//   1. Can the origin be split into concurrent ranged requests?
//   2. If not, can an interrupted transfer still be resumed?

import { requestFollow, discard, readBody, DEFAULT_UA } from "./net.mjs";
import { filenameFromDisposition, filenameFromUrl, sanitizeName } from "./util.mjs";

/** @typedef {{ finalUrl:string, supportsRanges:boolean, totalBytes:number|null, acceptRanges:string|null, etag:string|null, lastModified:string|null, filename:string, contentType:string|null, redirects:string[] }} Probe */

function parseContentRangeTotal(header) {
  const m = /bytes\s+\d+-\d+\/(\d+|\*)/i.exec(header || "");
  if (!m || m[1] === "*") return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Probe a URL. Ranged requests carry `Range: bytes=0-0`, the cheapest way to
 * learn both the total length and whether ranges are honoured.
 * @returns {Promise<Probe>}
 */

/**
 * Parse an origin-supplied integrity digest.
 *
 * The engine had a branch that verified the finished file against
 * "probe.contentDigest", but nothing produced that field, so the check could
 * never run. These are the standard headers that carry it:
 *
 *   Digest:         sha-256=<base64>      (RFC 3230)
 *   Content-Digest: sha-256=:<base64>:    (RFC 9530)
 *   Repr-Digest:    sha-256=:<base64>:    (RFC 9530)
 *   Content-MD5:    <base64>              (legacy, RFC 1864)
 *
 * Only algorithms Node can compute are accepted; anything else is ignored
 * rather than guessed at.
 * @returns {{ algo:"sha256"|"md5", value:string, source:string }|null}
 */
/** Public entry: same host probes never overlap. */
export async function probe(url, opts = {}) {
  if (opts.serialized === false) return probeWithRetry(url, opts);
  return withProbeLock(url, () => probeWithRetry(url, opts));
}


/**
 * Probe with retry on transient failures.
 *
 * The probe is the first request a task makes, so a transient 5xx or a
 * dropped connection here used to fail the entire download before a single
 * byte was fetched. Retrying is cheap: the probe carries no body.
 *
 * Only retryable conditions are retried (408/429/5xx and network errors).
 * A 404 or 403 is a definitive answer and is returned immediately.
 *
 * P-8: the retry loop's work is visible after the fact. The cloud field
 * report measured "~12s until error" and saw a task whose `retries` stayed 0
 * and whose error named no attempt count — six probe attempts and their
 * backoff had happened, and none of it showed. Now:
 *
 *   * a probe that EXHAUSTS its budget throws the last underlying error
 *     annotated with `attempts` (rounds actually made), `attemptErrors` (one
 *     line per failed round) and `backoffMs` (the total time spent waiting
 *     between rounds), so the downloader can say "after N attempts" and
 *     count the retries onto the task;
 *   * a probe that SUCCEEDS after failures reports the same numbers on its
 *     result object (only when more than one round was needed — a
 *     first-try success keeps the exact shape it always had).
 *
 * The underlying error is rethrown as-is (never wrapped) so statusCode,
 * code and name keep their meaning to every existing consumer.
 */
async function probeWithRetry(url, opts) {
  const maxAttempts = Math.max(1, Number(opts.maxRetries ?? 4));
  const baseMs = Math.max(10, Number(opts.retryBaseMs ?? 300));
  let lastErr;
  let attempts = 0;
  let backoffMs = 0;
  const attemptErrors = [];
  for (;;) {
    attempts++;
    try {
      const result = await probeOnce(url, opts);
      if (attempts > 1) {
        result.attempts = attempts;
        result.attemptErrors = attemptErrors;
        result.backoffMs = backoffMs;
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (err?.name === "AbortError" || opts.signal?.aborted) throw err;
      // A definitive HTTP answer is not worth retrying.
      const status = err?.statusCode;
      const retryable = status === undefined
        ? true
        : status === 408 || status === 429 || status >= 500;
      if (!retryable) throw err;
      attemptErrors.push(attemptSummary(err));
      if (attempts >= maxAttempts) break;
      const wait = err.retryAfterMs > 0 ? Math.min(30000, err.retryAfterMs) : baseMs * Math.pow(2, attempts - 1);
      const sleepMs = Math.min(wait, 5000);
      backoffMs += sleepMs;
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }
  lastErr.attempts = attempts;
  lastErr.backoffMs = backoffMs;
  lastErr.attemptErrors = attemptErrors;
  throw lastErr;
}

/** One line per failed probe attempt, bounded so tails stay readable. */
function attemptSummary(err) {
  const line = err?.statusCode !== undefined
    ? "HTTP " + err.statusCode
    : String(err?.code || err?.message || err);
  return line.slice(0, 120);
}

export function parseDigestHeaders(headers) {
  const ALGO_MAP = {
    "sha-256": "sha256",
    sha256: "sha256",
    md5: "md5",
  };

  const pick = (raw, source) => {
    for (const part of String(raw).split(",")) {
      const m = /^\s*([a-z0-9-]+)\s*=\s*:?([A-Za-z0-9+/=_-]+):?\s*$/i.exec(part);
      if (!m) continue;
      const algo = ALGO_MAP[m[1].toLowerCase()];
      if (!algo) continue;                  // unsupported algorithm
      const value = m[2].replace(/-/g, "+").replace(/_/g, "/");
      if (!value) continue;
      return { algo, value, source };
    }
    return null;
  };

  for (const header of ["content-digest", "repr-digest", "digest"]) {
    if (headers[header]) {
      const hit = pick(headers[header], header);
      if (hit) return hit;
    }
  }
  // Content-MD5 carries a bare base64 value.
  const md5 = headers["content-md5"];
  if (md5 && /^[A-Za-z0-9+/=]+$/.test(String(md5).trim())) {
    return { algo: "md5", value: String(md5).trim(), source: "content-md5" };
  }
  return null;
}

/** Extensions that should never arrive as a tiny text response. */
const BINARY_EXTS = new Set([
  "7z", "zip", "rar", "gz", "bz2", "xz", "tar", "exe", "msi", "dll", "iso",
  "pdf", "png", "jpg", "jpeg", "gif", "webp", "mp4", "mkv", "avi", "flac", "apk",
]);

/**
 * Flag a response that is almost certainly an error page rather than the file.
 *
 * Asking for a .zip and receiving 300 bytes of text/html means the origin
 * answered with a message, not a payload — usually an expired link, a login
 * wall, or a quota notice. Catching it before the transfer starts is far kinder
 * than downloading an HTML file named "archive.zip".
 *
 * @returns {string|null} a human-readable warning, or null when nothing is odd
 */
export function suspiciousResponseWarning(filename, contentType, size) {
  if (!(size > 0) || size > 512) return null;      // only tiny bodies qualify
  const ct = String(contentType || "").toLowerCase();
  if (!ct.includes("text/plain") && !ct.includes("text/html")) return null;

  const ext = String(filename || "").split(".").pop()?.toLowerCase() || "";
  if (!BINARY_EXTS.has(ext)) return null;

  return "the origin returned only " + size + " bytes of " + (ct.split(";")[0] || "text") +
    " for a ." + ext + " file; this looks like an error message rather than the file";
}


/**
 * One probe at a time per host.
 *
 * Firing several probes at the same origin in parallel is what gets a client
 * rate limited — large file hosts are especially sensitive to it. Probes are
 * short, so serialising them per host costs almost nothing and avoids the
 * problem entirely. The lock is reference counted so the map does not grow
 * without bound (the pattern follows Surge's lockProbeHost, MIT).
 */
const probeHostLocks = new Map();

function hostOfUrl(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return "unknown"; }
}

export async function withProbeLock(url, fn) {
  const host = hostOfUrl(url);
  let entry = probeHostLocks.get(host);
  if (!entry) {
    entry = { tail: Promise.resolve(), refs: 0 };
    probeHostLocks.set(host, entry);
  }
  entry.refs++;

  const previous = entry.tail;
  let release;
  entry.tail = new Promise((r) => { release = r; });

  await previous;
  try {
    return await fn();
  } finally {
    release();
    entry.refs--;
    if (entry.refs <= 0) probeHostLocks.delete(host);
  }
}

async function probeOnce(url, opts = {}) {
  const baseHeaders = { "User-Agent": DEFAULT_UA, "Accept-Encoding": "identity", ...(opts.headers || {}) };

  // Step 1 — read the headers without transferring a body.
  //
  // This used to be a plain GET whose body was "discarded". Draining a response
  // is not free: the origin has already committed to sending the whole file, so
  // probing a 128 MiB resource moved 128 MiB before a single segment was
  // fetched. HEAD transfers no body; when an origin rejects HEAD, fall back to
  // a one-byte ranged GET, which is bounded no matter how large the file is.
  let head = null;
  let headError = null;
  try {
    head = await requestFollow(url, {
      method: "HEAD",
      headers: baseHeaders,
      proxy: opts.proxy,
      insecure: opts.insecure,
      timeoutMs: opts.timeoutMs ?? 20_000,
      signal: opts.signal,
      maxRedirects: opts.maxRedirects,
    });
    await discard(head);
  } catch (err) {
    // A definitive HTTP answer from HEAD is the answer; retrying it as a GET
    // would just repeat the same refusal. Only a transport-level failure
    // (an origin that refuses HEAD entirely) justifies the ranged fallback.
    if (err && err.statusCode) throw err;
    headError = err;
    head = null;
  }

  if (!head) {
    head = await requestFollow(url, {
      method: "GET",
      headers: { ...baseHeaders, Range: "bytes=0-0" },
      proxy: opts.proxy,
      insecure: opts.insecure,
      timeoutMs: opts.timeoutMs ?? 20_000,
      signal: opts.signal,
      maxRedirects: opts.maxRedirects,
    });
  }

  const finalUrl = head.finalUrl;
  const acceptRanges = head.headers["accept-ranges"] ?? null;
  const contentLength = Number(head.headers["content-length"] ?? NaN);
  const etag = head.headers.etag ?? null;
  const lastModified = head.headers["last-modified"] ?? null;
  const contentType = head.headers["content-type"] ?? null;

  const dispositionName = filenameFromDisposition(head.headers["content-disposition"]);
  const urlName = filenameFromUrl(finalUrl) || filenameFromUrl(url);
  const filename = sanitizeName(dispositionName || urlName, "download.bin");


  // Step 2 — ranged GET to confirm range support and learn the true total.
  let supportsRanges = false;
  let totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;

  if (acceptRanges && /bytes/i.test(acceptRanges)) {
    supportsRanges = true;
  } else {
    const r = await requestFollow(url, {
      method: "GET",
      headers: { ...baseHeaders, Range: "bytes=0-0" },
      proxy: opts.proxy,
      insecure: opts.insecure,
      timeoutMs: opts.timeoutMs ?? 20_000,
      signal: opts.signal,
      maxRedirects: opts.maxRedirects,
    });
    if (r.statusCode === 206) {
      supportsRanges = true;
      const total = parseContentRangeTotal(r.headers["content-range"]);
      if (total !== null) totalBytes = total;
    }
    await discard(r);
  }

  // A single-byte body is not enough to call anything "splittable".
  if (supportsRanges && (!totalBytes || totalBytes <= 1)) supportsRanges = false;

  // An origin-supplied digest lets the engine verify the assembled file
  // instead of only self-reporting a hash.
  const contentDigest = parseDigestHeaders(head.headers);
  // Cheap sanity check: a tiny text body for a binary-looking name is an error page.
  const warning = suspiciousResponseWarning(
    filename, contentType, Number.isFinite(contentLength) ? contentLength : 0
  );

  return {
    finalUrl,
    contentDigest,
    warning,
    supportsRanges,
    totalBytes,
    acceptRanges,
    etag,
    lastModified,
    filename,
    contentType,
    redirects: head.redirects ?? [],
  };
}

/**
 * Ask the origin whether a byte already on disk still matches it.
 * A strong validator (ETag) that changed means the partial data is stale and
 * must be discarded rather than silently stitched into a corrupt file.
 * @returns {Promise<"match"|"mismatch"|"unknown">}
 */
export async function validateResume(probeResult, stored = {}) {
  if (probeResult.etag && stored.etag) {
    const strong = (t) => (t && !t.startsWith("W/") ? t : null);
    const a = strong(probeResult.etag);
    const b = strong(stored.etag);
    if (a && b) return a === b ? "match" : "mismatch";
    return "unknown";
  }
  if (probeResult.lastModified && stored.lastModified) {
    return probeResult.lastModified === stored.lastModified ? "match" : "mismatch";
  }
  return "unknown";
}
