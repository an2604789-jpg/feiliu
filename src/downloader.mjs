// Transfer orchestrator: picks the right strategy per URL and runs it.
//
// This is the layer the queue talks to. It owns:
//   * strategy selection (http / ftp / hls / dash);
//   * target path resolution (category folders, unique names, overwrite policy);
//   * progress fan-out to the queue;
//   * cancellation;
//   * post-processing (fragment stitching for streaming formats).

import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";

import { probe } from "./probe.mjs";
import { DownloadEngine } from "./engine.mjs";
import { resolveDirectory, uniquePath, categorize } from "./categories.mjs";
import { parseFtpUrl, FtpControl } from "./ftp.mjs";
import { resolvePlaylist } from "./hls.mjs";
import { parseMpd, selectTracks, listSegments, expandTemplate } from "./dash.mjs";
import { mergeTracks } from "./merge.mjs";
import { requestFollow, readBody, readBodyToFile, buildRequestHeaders, abortError, translateTaskError } from "./net.mjs";
import { RateLimiter, ChainLimiter } from "./rate.mjs";
import { SUBDIR as StoreSubdir, STAGING_SUFFIX as StoreStagingSuffix, TransferStore } from "./store.mjs";
import { filenameFromUrl, sanitizeName, formatBytes, ensureExtension, mkdirWithRetry } from "./util.mjs";
import { resolveSystemProxy, matchesNoProxy } from "./sysproxy.mjs";

/**
 * How many consecutive failed resume attempts one segment journal may cost
 * before the downloader stops trusting it — aria2's answer to the infinite
 * half-way loop, where a bad disk or a source that breaks on continuation
 * ranges fails, retries, resumes and fails again at the same offset for ever.
 * On the Nth consecutive failure the journal is discarded and the whole file
 * is taken again in one stream from byte zero (see #transferToTarget).
 *
 * The count is kept deliberately narrow so that nothing but that loop is
 * affected:
 *
 *   * An attempt counts only when it STARTED from an existing journal that
 *     held real progress and was not stale (see #willResumeFromJournal) and
 *     then failed. A fresh attempt that fails is the queue's ordinary retry
 *     business and never touches the budget.
 *   * A pause or cancel never counts: those are user actions, not evidence
 *     about the disk or the source.
 *   * A journal the engine itself already reset — a revision change (ETag /
 *     Last-Modified / size mismatch), a digest mismatch, a coverage gap —
 *     never counts: the engine discarded it, the next attempt starts from
 *     byte zero on its own, and the loop this budget exists for is already
 *     broken. This is what makes the stale-detection (ETag change) reset
 *     explicitly NOT a resume failure.
 *   * A resume that succeeds clears the count, so a normal pause -> resume
 *     cycle can never accumulate towards the budget.
 *
 * Where the count lives and how it recovers: inside the transfer's own
 * segment journal as `<target>.downloadx/resume-failures.json`, written
 * temp-then-rename (TransferStore.recordResumeFailure). It therefore shares
 * the journal's lifecycle — it survives a daemon restart exactly as long as
 * the partial bytes it describes do, and it disappears with the journal
 * whenever that generation is reset, by the engine, by a cancel, by a
 * successful transfer's cleanup, or by the budget-exhausted discard itself.
 * No new top-level on-disk artefact is introduced.
 */
export const RESUME_FAILURE_BUDGET = 3;

/**
 * P-18: decide which proxy one transfer uses, from proxyMode.
 *
 * proxyMode (system | manual | none) existed in config.mjs — defined,
 * validated, shown in the GUI — but nothing consumed it: "use system proxy"
 * read neither the system nor anything else. This function is the single
 * decision point; run() applies it to `prepared` and every strategy below
 * reads the result off the task instead of re-consulting Settings.
 *
 * Rules, fixed by the batch-7 ruling:
 *   * a per-task proxy (task.proxy, set by the API/CLI caller) beats every
 *     mode — it is that task's own explicit choice, exactly the precedence
 *     Settings already had;
 *   * manual → the Settings proxy (config.proxy), verbatim;
 *   * none   → no proxy at all, even if config.proxy is set;
 *   * system → the discovered system proxy (sysproxy.resolveSystemProxy:
 *     registry on Windows, env vars elsewhere), with config.proxy as the
 *     FALLBACK when discovery finds nothing. Rationale: "system" is also the
 *     DEFAULT mode, so a user who configured a manual proxy in Settings and
 *     left the mode alone must not lose their proxy just because their
 *     machine has no OS-level proxy configured — the explicit Settings value
 *     is honoured until the OS actually offers one. When discovery does find
 *     a proxy it WINS over config.proxy: the user asked for the system's
 *     answer, and the system just gave one.
 *
 * noProxy (Windows ProxyOverride / no_proxy env): when the target host is on
 * the system's own exclusion list, the transfer goes direct — the list is the
 * system's answer for this very question, and it applies before any fallback
 * (a fallback proxy the exclusion list never heard of would defeat the
 * exclusion). The host check uses the task's URL as filed; a redirect to a
 * different host keeps the chosen proxy, the same trade every download
 * manager that resolves once per task makes.
 *
 * Exported and pure (the discovery result is passed in) so the three modes
 * are unit-testable without a registry or an environment.
 *
 * @param {{taskProxy?:string, mode?:string, configured?:string, url?:string,
 *          systemProxy?:{http:string|null,https:string|null,noProxy:string[]}|null}} input
 * @returns {string|undefined} the proxy URL for this transfer, or undefined
 */
export function selectRunProxy({ taskProxy, mode, configured, url, systemProxy } = {}) {
  if (taskProxy) return taskProxy;
  const settings = String(configured || "");
  if (mode === "none") return undefined;
  if (mode === "manual") return settings || undefined;
  // "system" — and any value config.sanitize has not met before, which it
  // coerces to "system" anyway; being defensive here costs nothing.
  const sys = systemProxy || null;
  if (!sys) return settings || undefined;
  let host = "";
  let isHttps = false;
  try {
    const u = new URL(String(url || ""));
    host = u.hostname;
    isHttps = u.protocol === "https:";
  } catch { /* an unparseable URL never gets a proxy decision from the system list */ }
  if (host && matchesNoProxy(host, sys.noProxy)) return undefined;
  const chosen = isHttps ? (sys.https || sys.http) : (sys.http || sys.https);
  return chosen || settings || undefined;
}

/**
 * Comparison key for a filesystem path, per the current platform's default
 * semantics.
 *
 * Windows and macOS default volumes are case-insensitive, so "Case.bin" and
 * "case.BIN" name one file. A download manager that keys its output lock on the
 * raw string would let two tasks reserve both spellings and then write the same
 * file concurrently. On such platforms the key is case-folded; elsewhere the
 * path is used as-is, because there the two names really are different files
 * and folding them would block legitimate parallel downloads.
 *
 * This is ONLY a comparison key. The path handed back to callers — and every
 * byte written — keeps the spelling the user asked for.
 *
 * @param {string} p absolute or relative path
 * @returns {string} a stable key suitable for Map/Set lookups
 */
export function pathKey(p) {
  const abs = path.resolve(p);
  // win32 and darwin are case-insensitive by default; linux is case-sensitive.
  return process.platform === "win32" || process.platform === "darwin"
    ? abs.toLowerCase()
    : abs;
}

/**
 * The byte rate this task must respect, in bytes per second (0 = unlimited).
 *
 * A per-task value wins over the global Settings value, which is the order the
 * HTTP engine already used. Media downloads read neither before this, so
 * `--limit` and `speedLimit` applied to plain files and to nothing else.
 */
/**
 * Build the limiter a media transfer (HLS/DASH) should obey.
 *
 * Two caps compose: the downloader-wide one, which a schedule window or the
 * global setting drives and which several concurrent tasks share, and this
 * task's own one. Both must allow a byte before it is read, so the schedule is
 * a total across running downloads and a per-task value cannot spend another
 * task's allowance.
 *
 * The task bucket is registered so a later rate change still reaches it.
 *
 * @returns {{limiter:ChainLimiter, task:RateLimiter, release:()=>void}}
 */
function mediaLimiter(downloader, task) {
  const own = new RateLimiter(taskRateLimit(task, downloader.config));
  downloader.taskLimiters.add(own);
  return {
    limiter: new ChainLimiter([downloader.limiter, own]),
    task: own,
    release: () => downloader.taskLimiters.delete(own),
  };
}

export function taskRateLimit(task, config) {
  const explicit = Number(task?.speedLimit);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const global = Number(config?.get ? config.get("speedLimit") : config?.speedLimit);
  return Number.isFinite(global) && global > 0 ? global : 0;
}

/** Decide the transfer strategy from the URL and, when needed, the response. */
export function detectKind(url, opts = {}) {
  // BitTorrent first, before any refusal guard, so a magnet never reaches a
  // strategy that cannot speak it (P-3: magnet links used to fall through to
  // the http path and die with an empty error). magnet:?xt= and *.torrent
  // both delegate to the external aria2c engine (src/bt.mjs).
  if (/^magnet:\?xt=/i.test(url.trim())) return "bt";
  const lower = url.toLowerCase().split("?")[0];
  if (lower.endsWith(".torrent")) return "bt";
  // blob:/data:/javascript: are page-internal references, not network
  // resources. A MediaSource blob exists only inside the tab that minted it,
  // so no external downloader can ever fetch one — refusing here with the way
  // out beats queueing a task that can only die (observed: bilibili player
  // links, 2026-10-24). The browser "downloads" them only because it owns the
  // in-memory buffer.
  if (/^(blob|data|javascript|about):/i.test(url.trim())) {
    throw new Error(
      "blob:/data: 等是网页内存中的地址，任何下载器都无法直接下载。" +
      "视频请改用浏览器扩展的悬浮条抓取完整流；普通文件请复制其 http(s) 直链"
    );
  }
  if (lower.startsWith("ftp://")) return "ftp";
  if (lower.endsWith(".m3u8")) return "hls";
  if (lower.endsWith(".mpd")) return "dash";
  try {
    const u = new URL(url);
    if (/\.m3u8$/i.test(u.pathname)) return "hls";
    if (/\.mpd$/i.test(u.pathname)) return "dash";
  } catch { /* fall through */ }
  return "http";
}


/**
 * Cap a task's connection count by the per-host limit.
 *
 * The setting existed but nothing read it. It matters because several tasks
 * can target the same host, and a site that limits concurrent connections
 * per client will throttle or ban an over-eager client.
 */
export function applyPerServerCap(url, requested, config, activeByHost) {
  const cap = Number(config?.get?.("maxConnectionsPerServer")) || 8;
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return Math.max(1, requested); }
  const inUse = (activeByHost && activeByHost.get(host)) || 0;
  const room = Math.max(1, cap - inUse);
  return Math.max(1, Math.min(requested, room));
}

/**
 * The completion marker beside a finished fragment: `<part>.ok`, holding the
 * exact byte length of the fully transferred body.
 *
 * Resume semantics for media fragments (HLS/DASH):
 *
 *   * A fragment counts as DONE only when its `.ok` marker exists AND the
 *     length recorded in it equals the fragment file's actual size. The old
 *     rule was "file exists with size > 0", which read a file a crash or
 *     cancel had truncated as finished and stitched short bytes into the
 *     final product; the marker closes that hole.
 *   * Anything else — no marker, unreadable marker, or a size mismatch (say
 *     the disk lost tail bytes after the marker was written) — is a PARTIAL
 *     artefact: it is unlinked and the fragment is fetched again from byte
 *     zero. Refetching whole fragments rather than resuming mid-fragment
 *     with Range keeps the guarantee simple and airtight: every stitched
 *     fragment is exactly the bytes the origin served for that URL, so the
 *     product of a cancelled-then-restarted transfer is byte-identical to a
 *     one-shot download.
 *   * `markPartComplete` writes the marker temp-then-rename, so a marker can
 *     only ever appear whole. No fsync of the fragment itself is needed for
 *     correctness: if the OS loses buffered bytes after a power cut, the
 *     recorded length no longer matches the file and the mismatch branch
 *     refetches it.
 */
const PART_OK_SUFFIX = ".ok";

/** Record that `partPath` now holds a complete body of `bytes` length. */
async function markPartComplete(partPath, bytes) {
  const tmp = partPath + PART_OK_SUFFIX + ".tmp";
  await fsp.writeFile(tmp, String(bytes), "utf8");
  await fsp.rename(tmp, partPath + PART_OK_SUFFIX);
}

/** Does `partPath` hold a complete fragment (marker present AND length matches)? */
async function partIsComplete(partPath) {
  try {
    const expected = Number((await fsp.readFile(partPath + PART_OK_SUFFIX, "utf8")).trim());
    const st = await fsp.stat(partPath);
    return Number.isInteger(expected) && expected >= 0 && st.size === expected;
  } catch {
    return false;
  }
}

/** Remove a partial fragment (and any stale marker) so it can be refetched. */
async function discardPartialPart(partPath) {
  await fsp.rm(partPath, { force: true }).catch(() => { /* best effort */ });
  await fsp.rm(partPath + PART_OK_SUFFIX, { force: true }).catch(() => { /* best effort */ });
}

/**
 * Fetch one media segment and stream it straight to disk at `partPath`.
 *
 * HLS and DASH downloads are long chains of small requests; a single dropped
 * connection partway through used to abort the whole transfer and discard
 * everything already fetched. On a real network that happens routinely, so
 * each segment is retried with exponential backoff before the transfer is
 * allowed to fail.
 *
 * The body never sits in memory: readBodyToFile() appends each chunk to the
 * fragment file as it arrives, so a fragment of any size costs one chunk of
 * RAM per in-flight request. The old buffered path capped fragments at
 * 64/128 MiB and failed anything larger no matter how much disk and RAM the
 * machine had; the only cap now is readBodyToFile's 1 GiB runaway fuse.
 *
 * Each attempt opens the file with "w" (truncate), so bytes from a half-done
 * attempt can never leak into a later one. The `.ok` marker is written only
 * after a body has streamed to its very end; a cancelled or crashed attempt
 * leaves an unmarked file behind, which the next run discards and refetches.
 *
 * A `limiter` is the transfer-wide token bucket, spent before each chunk is
 * written so a throttled transfer pulls from the socket only as fast as the
 * bucket allows.
 *
 * @returns {Promise<number>} bytes written (the fragment's full length)
 */
async function fetchMediaPartToFile(url, partPath, { headers, proxy, insecure, signal, limiter, maxRetries = 4, retryBaseMs = 500 } = {}) {
  let lastErr;
  let attempts = 0;
  let backoffMs = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts++;
    if (signal?.aborted) throw abortError();
    try {
      const res = await requestFollow(url, {
        headers, proxy, insecure, signal, timeoutMs: 60_000,
      });
      // "w" truncates: every attempt, first or retry, starts at byte zero.
      const fh = await fsp.open(partPath, "w");
      let written;
      try {
        written = await readBodyToFile(res, fh, { limiter, signal });
      } finally {
        await fh.close();
      }
      await markPartComplete(partPath, written);
      return written;
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw err;
      let retryable = true;
      if (err && err.statusCode !== undefined) {
        retryable = err.statusCode === 408 || err.statusCode === 429 || err.statusCode >= 500;
      }
      if (!retryable || attempt === maxRetries) break;
      const wait = Math.min(8000, (err && err.retryAfterMs) || retryBaseMs * Math.pow(2, attempt));
      backoffMs += wait;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  // P-8: a fragment that burned its whole retry budget must not fail the
  // task as if it had been tried once. Same annotation contract as
  // probeWithRetry: the downloader's final-error layer turns these into the
  // "after N attempts" message and the task's retries count.
  if (lastErr && typeof lastErr === "object" && !signal?.aborted) {
    lastErr.attempts = attempts;
    lastErr.backoffMs = backoffMs;
  }
  throw lastErr;
}
/**
 * Decide the final name for one requested output path, honouring
 * `overwriteExisting`.
 *
 * This lives at module scope — not inside the class — because TWO callers must
 * agree on it: the daemon's #pickName() and the foreground CLI's `get -o`
 * path. The defect this closes was exactly a second, parallel reading of the
 * policy: src/cli.mjs wrote straight to the requested path for every policy, so
 * under the default `rename` the user's existing file was overwritten in place
 * instead of the artefact landing beside it, and under `skip` it was overwritten
 * instead of refused.
 *
 * The caller supplies the predicates rather than this function touching the
 * filesystem itself, because the daemon must answer "is that name taken?" from
 * its live claim registry *and* the disk, while the CLI (one foreground
 * transfer, no registry) only has the disk.
 *
 * @param {object} opts
 * @param {string} opts.requested absolute path the transfer asked for
 * @param {string} opts.policy the `overwriteExisting` setting: rename|skip|overwrite
 * @param {(p:string)=>Promise<boolean>} opts.isTaken is this path, or anything
 *        derived from it, claimed or already on disk?
 * @param {(p:string)=>Promise<boolean>} [opts.isResuming] is the path the
 *        unfinished transfer for this URL already started? (see isResumingSelf)
 * @param {(p:string)=>string|null} [opts.claimOf] the live claim on this path,
 *        if any; when supplied, an overwrite never takes a path in use
 * @returns {Promise<{target:string,requested:string,renamed:boolean}>}
 */
export async function chooseOutputName({ requested, policy, isTaken, isResuming, claimOf }) {
  const wanted = path.resolve(requested);
  const mode = policy === "skip" || policy === "overwrite" ? policy : "rename";

  // A resumed transfer keeps the name it already started under.
  //
  // A paused or interrupted segmented transfer leaves its journal directory
  // and its pre-allocated staging file beside the target. On resume the very
  // same transfer asks for that same name again, and the collision policy used
  // to read those files as "somebody else already took this name": with the
  // default `rename` policy the resumed transfer was handed "name (2).ext"
  // — correct bytes under a name the user never asked for — and with `skip`
  // it failed against its own staging file. Both are wrong for the same
  // reason, so the check belongs here, before the policy runs.
  //
  // The probe is deliberately narrow: staging AND a journal that names THIS
  // transfer's URL. Staging alone lets a sibling task's leftover scratch pass as
  // ours, and the journal alone would adopt a paused transfer of a different
  // URL that happens to share the name.
  if (mode !== "overwrite" && isResuming && await isResuming(wanted)) {
    return { target: wanted, requested: wanted, renamed: false };
  }

  if (mode === "rename") {
    // uniquePath probes candidate spellings; on a case-insensitive volume a
    // different spelling of an existing name is the same file, so the predicate
    // has to judge by `pathKey`, not by string identity.
    const target = await uniquePath(wanted, isTaken, pathKey);
    return { target, requested: wanted, renamed: target !== wanted };
  }

  if (mode === "skip") {
    if (await isTaken(wanted)) {
      throw Object.assign(
        new Error("file already exists and overwriteExisting is skip: " + wanted),
        { code: "ALREADY_EXISTS", path: wanted },
      );
    }
    return { target: wanted, requested: wanted, renamed: false };
  }

  // overwrite may replace a file on disk, but never a path another transfer is
  // using right now: that would corrupt its artefact.
  const live = claimOf ? claimOf(wanted) : null;
  if (live) {
    throw Object.assign(
      new Error("output path is in use by another transfer: " + live),
      { code: "TARGET_BUSY", path: live },
    );
  }
  return { target: wanted, requested: wanted, renamed: false };
}

/**
 * Is `requested` the target of a transfer for `url` that never finished?
 *
 * True only when both halves of the segmented engine's progress are present
 * beside the path — the staging file it assembled so far and the journal that
 * describes the transfer — and the journal names this URL. Shared with the CLI
 * so re-running `get -o <same path>` after an interruption resumes instead of
 * being handed "name (2).ext" by its own leftovers.
 *
 * @param {string} requested absolute final path
 * @param {string} url the URL this transfer is fetching
 */
export async function isResumingSelf(requested, url) {
  const wanted = path.resolve(requested);
  try {
    await fsp.access(wanted + StoreStagingSuffix);
  } catch {
    return false;
  }
  let state;
  try {
    state = JSON.parse(await fsp.readFile(path.join(wanted + StoreSubdir, "state.json"), "utf8"));
  } catch {
    return false;
  }
  const mine = String(url || "");
  return Boolean(state && state.url) && mine !== "" && state.url === mine;
}

export class Downloader extends EventEmitter {
  /** @param {{ config:any, queue?:any }} opts */
  constructor({ config, queue = null }) {
    super();
    this.config = config;
    this.queue = queue;
    this.maxRetries = Math.max(1, Number(config.get("maxRetries")) || 4);
    this.retryBaseMs = Math.max(50, Number(config.get("retryBaseMs")) || 500);
    this.active = new Map();   // taskId -> { controller, engine }
    /**
     * The cap a schedule (or the Settings value) imposes on EVERY transfer this
     * downloader starts or is already running.
     *
     * The scheduler used to write `downloader.limiter.rate`, but no such
     * property existed on a real Downloader, so a bandwidth window only ever
     * fired a log line. It also has to be one shared bucket: a per-task copy
     * would let two concurrent downloads move twice the scheduled rate.
     */
    this.limiter = new RateLimiter(0);
    /** Per-task buckets, so one running task keeps its own live allowance. */
    this.taskLimiters = new Set();
    /** Live connection count per host, so the per-server cap is enforced. */
    this.activeByHost = new Map();
    /**
     * One transfer per target file, expressed as a promise chain per path.
     *
     * Transfer state (the .downloadx segment journal) lives beside the target,
     * so two transfers aiming at the same file share it: the second inherits
     * the first's progress, they write interleaved offsets, and whichever
     * finishes first deletes the state directory out from under the other. The
     * observable result was an ENOENT on a segment file and a failed download
     * that had actually transferred most of its bytes.
     *
     * Serialising by target path is the only sound answer: the two transfers
     * are the same download, and running them together cannot be made correct.
     */
    this.targetLocks = new Map();
    /**
     * Names already handed to an in-flight task, by absolute path.
     *
     * The file itself may not exist yet — DASH writes "<target>.video.mp4" and
     * only creates the requested name at the very end, so a second task
     * resolving the same request would see a free name and pick the same
     * "movie (2).mp4" as the first. Keeping the claim in memory closes that
     * window without creating a placeholder file (which would truncate a real
     * file under the overwrite policy before a single byte arrived).
     */
    this.reservedNames = new Map();     // absolute path -> claim token
    /** Claim key -> the task that owns it, so a task can take over its own. */
    this.claimOwners = new Map();
    /** Claim key -> the spelling that was actually claimed. */
    this.claimPaths = new Map();
    /**
     * Serialises "is this set of paths free?" + "claim it".
     *
     * Checking and claiming must be one atomic step. Two tasks whose base names
     * differ may still collide on a derived path (task A writes "x.ts", task B
     * asks for "x.ts.parts"), and per-base locks cannot see each other, so both
     * would test "free" and both would claim. This mutex covers only the brief
     * test-and-claim, never the transfer itself.
     */
    this.claimMutexTail = Promise.resolve();
    /**
     * Retry events observed during each task's CURRENT run (P-8): the
     * segmented engine emits one per segment re-attempt, and the final task
     * error / the task's `retries` field must be able to state how much
     * retrying actually happened (the field report measured a task that
     * retried six times and still reported retries=0). Set when a run starts,
     * counted in #segmentEngine, read by #finalTaskError / the success path,
     * deleted when the run settles. Never persisted.
     */
    this.runRetryCounts = new Map();
  }

  /** Run `fn` with the claim registry held; always released. */
  async #withClaimLock(fn) {
    const previous = this.claimMutexTail;
    let releaseNext;
    this.claimMutexTail = new Promise((resolve) => { releaseNext = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      releaseNext();
    }
  }

  /**
   * Does any path in `set` collide with a claim or a file on disk?
   *
   * A transfer's own intermediate state is not a collision. While a segmented
   * transfer is paused or resumable, it legitimately owns the staging file and
   * the journal directory; treating them as "somebody else's file" made the
   * resume of that very transfer fail with TARGET_BUSY. The test is whether the
   * path belongs to the transfer being reserved, which is exactly what the
   * target's own name prefix identifies.
   */
  async #anyTaken(set, target = null) {
    for (const p of set) {
      if (this.reservedNames.has(pathKey(p))) return { taken: true, path: p, by: "claim" };
      try {
        await fsp.access(p);
        if (target && isOwnTransferState(p, target)) continue;
        return { taken: true, path: p, by: "disk" };
      } catch { /* free */ }
    }
    return { taken: false, path: null, by: null };
  }

  /**
   * Claim every path in `set` for `token`; caller must hold the claim mutex.
   *
   * `owner` records which task the claim belongs to. The same task may be
   * asked to reserve its own output again (a resume re-enters the same path,
   * and a retried task re-runs with the same id), and a claim that names the
   * owner can be taken over instead of being reported as somebody else's.
   */
  #claimAll(set, token, owner) {
    for (const p of set) {
      this.reservedNames.set(pathKey(p), token);
      this.claimPaths.set(pathKey(p), p);
      if (owner) this.claimOwners.set(pathKey(p), owner);
    }
  }

  /** Release every path this token claimed. Idempotent. */
  #releaseClaims(token) {
    for (const [p, owner] of [...this.reservedNames]) {
      if (owner === token) {
        this.reservedNames.delete(p);
        this.claimOwners.delete(p);
        this.claimPaths.delete(p);
      }
    }
  }



  /**
   * Acquire the output lock for one path.
   *
   * A FIFO queue per path, not a promise chain. The chain could not represent
   * "this waiter left without ever holding the lock": a timeout had to complete
   * its own slot to unblock the queue, and doing so also dropped the map entry
   * that belonged to the *current holder* — after which a new arrival started
   * from an empty queue and could hold the same path at the same time as the
   * original owner. An explicit queue makes "waiting", "holding" and "left"
   * distinct states, so a waiter can leave without touching anyone else's claim.
   *
   * Cancellation is honoured while waiting: a task that is cancelled must stop
   * promptly instead of sitting here until the holder releases or the ten
   * minute default expires.
   *
   * @param {string} target absolute path
   * @param {{ waitMs?:number, signal?:AbortSignal }} [options]
   * @returns {Promise<() => void>} idempotent release
   */
  async lockTarget(target, { waitMs = 10 * 60 * 1000, signal } = {}) {
    const key = pathKey(target);
    let entry = this.targetLocks.get(key);
    if (!entry) {
      entry = { holder: false, queue: [] };
      this.targetLocks.set(key, entry);
    }
    // Fast path: nobody holds it and nobody is waiting.
    if (!entry.holder && entry.queue.length === 0) {
      entry.holder = true;
      return this.#makeRelease(key, entry);
    }

    if (signal?.aborted) throw abortError();

    // A plain deferred. `settled` records the decision so a grant that races
    // with a timeout/cancel cannot be handed back twice.
    let decideOk, decideFail;
    const granted = new Promise((resolve, reject) => { decideOk = resolve; decideFail = reject; });
    const waiter = { settled: false, reject: null, grant: null };

    let timer = null;
    let onAbort = null;
    let settledBy = null;                          // "grant" | "timeout" | "abort"
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (onAbort && signal) { signal.removeEventListener("abort", onAbort); onAbort = null; }
    };

    waiter.grant = (release) => {
      if (settledBy) { release(); return; }        // arrived too late: pass it on
      settledBy = "grant";
      cleanup();
      decideOk(release);
    };

    /** Leave the queue without ever having held the lock. */
    const leave = (err) => {
      if (settledBy) return;
      settledBy = err.code === "ABORT_ERR" ? "abort" : "timeout";
      const at = entry.queue.indexOf(waiter);
      if (at >= 0) entry.queue.splice(at, 1);
      // Drop the map entry only when this waiter was the last interest AND no
      // one holds the path. Deleting it while a holder exists detached the
      // lock from its owner, which let a later arrival acquire the same path
      // concurrently — the mutex hole this queue replaces.
      if (!entry.holder && entry.queue.length === 0 && this.targetLocks.get(key) === entry) {
        this.targetLocks.delete(key);
      }
      cleanup();
      decideFail(err);
    };
    waiter.reject = leave;

    entry.queue.push(waiter);

    if (signal) {
      onAbort = () => leave(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (Number.isFinite(waitMs) && waitMs > 0) {
      timer = setTimeout(() => {
        const err = new Error("another transfer is still writing " + target +
          "; giving up after " + waitMs + " ms");
        err.code = "TARGET_BUSY";
        leave(err);
      }, waitMs);
    }

    const release = await granted;
    return release;
  }

  /** Hand the lock to the next waiter, or clear the holder flag. */
  #makeRelease(key, entry) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (;;) {
        const next = entry.queue.shift();
        if (!next) break;
        // Hand the holder slot straight to the next live waiter. The flag is
        // never cleared in between, so there is no instant where a fresh
        // arrival could see the path as free.
        if (next.grant) { next.grant(this.#makeRelease(key, entry)); return; }
      }
      entry.holder = false;
      if (entry.queue.length === 0 && this.targetLocks.get(key) === entry) {
        this.targetLocks.delete(key);
      }
    };
  }

  /**
   * Every path a transfer may create, write, rename away or delete.
   *
   * Kept as one pure function and used BOTH for collision decisions and (by
   * construction) as the definition of what each strategy touches, so this list
   * cannot drift away from the code that actually writes the files. A path that
   * is in here must be claimed for the whole transfer; a path that is not here
   * must not be written by any strategy.
   *
   * @param {string} target absolute final path
   * @param {"hls"|"dash"|"http"|"ftp"} kind
   * @returns {string[]} absolute paths, target first
   */
  static outputPathSet(target, kind) {
    const base = path.resolve(target);
    const set = [base];
    if (kind === "hls") {
      // Fragment scratch, a separate audio rendition (HLS packs it as MPEG-TS),
      // its own scratch and the mux output.
      set.push(
        base + ".parts",
        base + ".audio.ts",
        base + ".audioparts",
        base + ".merged.mp4",
      );
    } else if (kind === "dash") {
      // Per-track scratch plus the surviving track files when the mux fails.
      set.push(
        base + ".tracks",
        base + ".video.mp4",
        base + ".audio.m4a",
      );
    } else {
      // The segmented engine and the streaming path both keep state beside the
      // target: the per-segment journal directory, the streaming temp file, and
      // the staging file the segmented engine assembles before it renames it
      // into place. The staging file is a real claimed path: a second task
      // aiming at the same name would otherwise write the same staging file and
      // corrupt both transfers.
      set.push(base + ".partial", base + StoreSubdir, base + StoreStagingSuffix);
    }
    return set.map((p) => path.resolve(p));
  }

  /**
   * Is `p` an intermediate file this transfer owns for `target`?
   *
   * The journal directory, the staging file and the streaming temp file all
   * live beside the target under names derived from it, so they are identified
   * by prefix rather than by a registry that a crashed process would lose.
   */
  static isOwnTransferState(p, target) {
    const base = path.resolve(target);
    const candidate = path.resolve(p);
    return candidate.startsWith(base + ".");
  }

  /**
   * The deterministic path a task asks for, before any collision policy runs.
   *
   * This — not the post-policy target — is what the lock is keyed on. Under the
   * `rename` policy two concurrent tasks would otherwise each resolve their own
   * "movie (2).ts" against the same starting state, and one would clobber the
   * other. Keying on the requested path serialises them, so the second sees the
   * first one's file and picks "movie (3).ts".
   *
   * @returns {Promise<{ dir:string, filename:string, category:string|null }>}
   */
  async requestedBase(task, filename) {
    const category = task.category ?? categorize(filename, this.config.get("categories"));
    if (task.meta && task.meta.exactTarget) {
      const base = task.dir || this.config.get("defaultDir") || ".";
      return { dir: path.resolve(base), filename, category };
    }
    const dir = resolveDirectory({ filename, dir: task.dir, category, config: this.config.values });
    return { dir, filename, category };
  }

  /**
   * Reserve an output path and hold the reservation until released.
   *
   * Resolution (policy included) happens *inside* the lock, so the path a task
   * writes is the path it holds — there is no window where a task locks A and
   * writes B. Every caller must wrap its whole transfer in try/finally and
   * release, including the paths that throw during resolution.
   *
   * @returns {Promise<{target:string, filename:string, dir:string, category:string|null,
   *                    exact:boolean, renamed:boolean, requested:string, release:()=>void}>}
   */
  async reserveTarget(task, opts = {}) {
    const signal = opts.signal ?? task.signal;
    const safeName = sanitizeName(
      task.filename || filenameFromUrl(task.finalUrl || task.url),
      "download.bin"
    );
    const base = await this.requestedBase(task, safeName);
    // The lock is keyed on the platform comparison key, so "Case.bin" and
    // "case.BIN" — one file on Windows — are the same lock.
    const lockKey = pathKey(path.join(base.dir, base.filename));
    // fail-fast policies must not join the FIFO at all. Two spellings of one
    // path (or a live derived path) share this lock key, so a queued waiter is
    // by definition blocked behind somebody, and the policy answer is already
    // decided: overwrite must refuse, skip must report the collision. Queueing
    // first and judging after the holder released would turn "busy" into
    // "waited, then took the path", which is a different contract. The probe
    // runs inside the claim registry so it cannot race a concurrent claim.
    const verdict = await this.#withClaimLock(
      () => this.#prelockVerdict(base, safeName, task.id ?? null));
    if (verdict.refusal) this.#throwLiveRefusal(verdict.refusal);
    // Waiting for the output path is part of the task: a cancel must end it
    // here rather than after the holder finishes or the default timeout fires.
    const release = await this.lockTarget(lockKey, { ...opts, signal });
    const token = Symbol("claim");
    let claimed = false;
    try {
      if (signal?.aborted) throw abortError();
      // Directory creation can fail too (permissions, a file where a folder
      // should be); that must release the lock rather than strand it.
      await mkdirWithRetry(base.dir);

      // Choose the final name AND claim its whole path set in one atomic step.
      // The name search has to see other tasks' claims, and the claim has to
      // happen before anyone else can pass the same test, otherwise two tasks
      // whose paths overlap could both decide the path is free.
      const resolved = await this.#withClaimLock(async () => {
        const picked = await this.#pickName(base, task, safeName);
        const kind = this.#kindOf(task);
        const set = Downloader.outputPathSet(picked.target, kind);
        // Another task may already hold a derived name of this target (it asked
        // for "movie.ts.parts" while we want "movie.ts"). Refuse rather than
        // share: two transfers writing one path cannot both be right.
        const clash = await this.#anyTaken(set, picked.target);
        if (clash.taken && clash.path !== picked.target) {
          const err = new Error("output path is in use by another transfer: " + clash.path);
          err.code = "TARGET_BUSY";
          err.path = clash.path;
          throw err;
        }
        this.#claimAll(set, token, task.id ?? null);
        claimed = true;
        return { ...picked, pathSet: set };
      });

      let released = false;
      return {
        ...resolved,
        release: () => {
          if (released) return;
          released = true;
          if (claimed) this.#releaseClaims(token);
          claimed = false;
          release();
        },
      };
    } catch (err) {
      if (claimed) this.#releaseClaims(token);
      release();
      throw err;
    }
  }

  /** The strategy this task will use, for path-set purposes. */
  #kindOf(task) {
    const kind = String(task.kind || "").toLowerCase();
    if (kind === "hls" || kind === "dash" || kind === "ftp") return kind;
    return "http";
  }

  /**
   * Decide, before the FIFO, whether another transfer owns this target.
   *
   * Two different situations share the same "somebody claimed this path"
   * signal, and they must not be conflated:
   *
   *   * another task owns it — skip/overwrite already know the answer
   *     (ALREADY_EXISTS / TARGET_BUSY) and must not queue behind the holder;
   *   * this same task owns it — a resume or a retry re-enters reserveTarget()
   *     while the previous run of that task may not have released its claim
   *     yet. That is not another transfer.
   *
   * The second case is resolved by DROPPING the stale reservation here, not by
   * ignoring it: the claim registry must never carry an owner that no longer
   * has a live run. The output lock below still serialises this re-entry behind
   * the previous run of the same task, so dropping the claim cannot open a
   * window where two writers hold one path.
   *
   * A path that only exists on disk is not reported here: skip is entitled to
   * the ALREADY_EXISTS answer the in-lock check gives, and that check runs for
   * every policy anyway.
   *
   * The caller runs this inside #withClaimLock, so no claim can slip in between
   * the answer and the reservation it permits.
   *
   * @returns {{refusal?:{policy:string, live:string, owner:string|null}, released?:boolean}}
   */
  #prelockVerdict(base, filename, taskId) {
    const policy = this.config.get("overwriteExisting");
    if (policy !== "skip" && policy !== "overwrite") return {};
    const requested = path.resolve(base.dir, filename);
    const live = this.#claimedSetFor(requested);
    if (!live) return {};
    const key = pathKey(live);
    const owner = this.claimOwners.get(key) ?? null;
    // This task's own previous run left the claim behind: release it, so the
    // retry reserves the path again instead of inheriting a dead owner.
    if (taskId !== null && owner === taskId) {
      const stale = this.reservedNames.get(key);
      if (stale) this.#releaseClaims(stale);
      return { released: true };
    }
    // One pathKey + two contracts, decided by the actual spelling:
    //
    //   identical spelling -> the pre-existing behaviour: queue on the output
    //     lock and apply the policy afterwards. overwrite takes the name once
    //     the holder releases; skip answers immediately (the holder's file will
    //     be on disk anyway, so waiting cannot change the answer).
    //   different spelling  -> a case variant: answered without queueing, so a
    //     second writer never silently replaces a live artefact it cannot see.
    //
    // pathKey() is used as-is; the spelling test is a plain comparison of the
    // resolved paths, not a second normalisation.
    const claimedSpelling = this.claimPaths.get(key) ?? null;
    const sameSpelling = claimedSpelling !== null && path.resolve(claimedSpelling) === requested;
    if (sameSpelling && policy === "overwrite") return {};
    return { refusal: { policy, live, owner } };
  }

  /** Throw the policy-specific refusal for a live target. */
  #throwLiveRefusal({ policy, live }) {
    if (policy === "skip") {
      throw Object.assign(
        new Error("file already exists and overwriteExisting is skip: " + live),
        { code: "ALREADY_EXISTS", path: live },
      );
    }
    // overwrite may replace an old file, but never a path another transfer is
    // using right now: that would corrupt its artefact.
    throw Object.assign(
      new Error("output path is in use by another transfer: " + live),
      { code: "TARGET_BUSY", path: live },
    );
  }

  /**
   * Choose a final name honouring the overwrite policy.
   *
   * Runs inside the claim registry, so the "is it taken?" test and the later
   * claim see the same world. The decision itself is chooseOutputName() — the
   * same function the foreground CLI calls — so a queued task and
   * `get -o <existing file>` cannot answer the policy differently.
   *
   * @returns {Promise<{target:string,filename:string,dir:string,category:string|null,
   *                    exact:boolean,renamed:boolean,requested:string}>}
   */
  async #pickName(base, task, filename) {
    const category = base.category;
    const requested = path.resolve(base.dir, filename);
    const decided = await chooseOutputName({
      requested,
      policy: this.config.get("overwriteExisting"),
      isTaken: (p) => this.#pathSetTaken(p),
      isResuming: (p) => this.#isResumingSelf(p, task),
      claimOf: (p) => this.#claimedSetFor(p),
    });
    return {
      target: decided.target,
      filename: path.basename(decided.target),
      dir: base.dir,
      category,
      exact: Boolean(task.meta && task.meta.exactTarget),
      renamed: decided.renamed,
      requested,
    };
  }

  /**
   * Is `requested` the target of a transfer THIS task already has in progress?
   *
   * The test itself is isResumingSelf() at module scope, shared with the CLI;
   * this wrapper only supplies the task's URL. A conversion is the one case
   * with its own rule: it keeps no segment journal (an encode cannot resume
   * mid-stream), so its "same task was here" evidence is the ffmpeg temp at
   * `<requested>.partial` plus the convert journal that names this task —
   * written by runConvert, read here. Without this, a paused-then-resumed
   * conversion was renamed to "name (2).ext" by its own leftover temp, which
   * then stayed orphaned beside the output.
   */
  async #isResumingSelf(requested, task) {
    if (String(task.kind || "").toLowerCase() === "convert") {
      try {
        await fsp.access(requested + ".partial");
      } catch {
        return false;
      }
      let rec;
      try {
        rec = JSON.parse(await fsp.readFile(path.join(requested + StoreSubdir, "convert.json"), "utf8"));
      } catch {
        return false;
      }
      return Boolean(rec && rec.kind === "convert" && rec.url && rec.url === (task.url || ""));
    }
    return isResumingSelf(requested, task.url);
  }

  /** Is the requested name, or any derived name of it, claimed or on disk? */
  async #pathSetTaken(requested) {
    const kinds = ["hls", "dash", "http"];
    for (const kind of kinds) {
      for (const p of Downloader.outputPathSet(requested, kind)) {
        if (this.reservedNames.has(pathKey(p))) return true;
        try { await fsp.access(p); return true; } catch { /* free */ }
      }
    }
    return false;
  }

  /** If `requested` is claimed by a live transfer, return that claimed path. */
  #claimedSetFor(requested) {
    for (const kind of ["hls", "dash", "http"]) {
      for (const p of Downloader.outputPathSet(requested, kind)) {
        if (this.reservedNames.has(pathKey(p))) return p;
      }
    }
    return null;
  }

  /**
   * Resolve where a task's output goes, honouring categories and naming policy.
   *
   * A task may name an exact file (`meta.exactTarget`, set by
   * `get -o <full path>`). That is an explicit instruction about the directory
   * and file name, so it bypasses the category subfolder: `get -o
   * C:/dl/movie.ts <hls-url>` must not write `C:/dl/video/movie.ts` while
   * reporting success, because the same command with a plain HTTP URL writes
   * exactly where it was told.
   *
   * It does NOT bypass the overwrite policy. An exact path says where the file
   * goes, not that an existing file there may be destroyed: with the default
   * `rename` policy the artefact lands beside the old one, and with `skip` the
   * task fails and the old bytes stay untouched.
   *
   * The policy itself lives in #pickName(), which reserveTarget() runs inside
   * the claim registry so "choose a name" and "claim it" cannot be split.
   */
  async resolveTarget(task) {
    const filename = sanitizeName(
      task.filename || filenameFromUrl(task.finalUrl || task.url),
      "download.bin"
    );
    const base = await this.requestedBase(task, filename);
    await mkdirWithRetry(base.dir);
    return await this.#withClaimLock(() => this.#pickName(base, task, filename));
  }

  /**
   * Test probe: the decision reserveTarget() makes before it queues.
   *
   * Exposed so the tests can prove the "no FIFO entry" property directly
   * rather than inferring it from latency alone.
   *
   * @returns {Promise<"skip"|"overwrite"|null>}
   */
  async livePolicyVerdict(task) {
    const filename = sanitizeName(
      task.filename || filenameFromUrl(task.finalUrl || task.url),
      "download.bin"
    );
    const base = await this.requestedBase(task, filename);
    const verdict = await this.#withClaimLock(() => this.#prelockVerdict(base, filename, null));
    return verdict.refusal ? verdict.refusal.policy : null;
  }

  /** Cancel an in-flight transfer. Partial state stays for a later resume. */
  cancel(taskId) {
    const entry = this.active.get(taskId);
    if (!entry) return false;
    try { entry.controller.abort(); } catch { /* already done */ }
    return true;
  }

  /**
   * Run one task to completion.
   * @returns {Promise<{ok:boolean, bytes:number, target:string, sha256:string|null}>}
   */
  async run(task) {
    const controller = new AbortController();
    // A caller that owns its cancellation (the foreground CLI aborts on
    // SIGINT) must be able to stop a transfer it started. The CLI used to
    // pass no signal and run() built its own controller, so Ctrl-C on a media
    // download had no effect on the transfer itself.
    const external = task.signal;
    let unlinkExternal = null;
    if (external) {
      const forward = () => controller.abort();
      if (external.aborted) controller.abort();
      else {
        external.addEventListener("abort", forward, { once: true });
        unlinkExternal = () => external.removeEventListener("abort", forward);
      }
    }
    this.active.set(task.id, { controller });
    const progressCb = (p) => this.emit("progress", { taskId: task.id, ...p });

    // Resolve the request context once, here, so every strategy sends the same
    // thing. The task carries referer/cookies/credentials when it came from the
    // browser extension or the API; dropping them produced a login page saved
    // as if it were the file.
    const prepared = { ...task, headers: buildRequestHeaders(task) };

    // A proxy set in Settings applies to every transfer unless this task names
    // its own — and since P-18, HOW that decision is made is the proxyMode
    // switch (see selectRunProxy for the exact rules): manual = Settings,
    // none = direct, system = OS discovery with Settings as the fallback.
    // The discovery only runs in system mode, so manual/none starts cost no
    // registry query, and resolveSystemProxy's own 30s cache keeps a burst of
    // tasks from spawning reg.exe per download.
    const proxyMode = this.config.get("proxyMode") || "system";
    prepared.proxy = selectRunProxy({
      taskProxy: prepared.proxy,
      mode: proxyMode,
      configured: this.config.get("proxy") || "",
      url: prepared.url,
      systemProxy: proxyMode === "system" ? await resolveSystemProxy() : null,
    });

    // P-8: this run's retry tally starts at zero. Segment engines wired by
    // #segmentEngine count their "retry" events into it, and #finalTaskError
    // (or the success path below) turns it into task.retries and the
    // "after N attempts" message.
    this.runRetryCounts.set(task.id, 0);

    try {
      const kind = prepared.kind && prepared.kind !== "http" ? prepared.kind : await detectKind(prepared.url);
      // Record the protocol actually in use on the task itself. A task added
      // without an explicit kind kept "http" for ever, so every later reader
      // that reasons from the task (cancellation cleanup, for one) picked the
      // wrong family of scratch paths. The copy handed to the strategy below
      // carries the same value.
      task.kind = kind;
      prepared.kind = kind;
      let result;
      if (kind === "ftp") result = await this.runFtp(prepared, controller, progressCb);
      else if (kind === "hls") result = await this.runHls(prepared, controller, progressCb);
      else if (kind === "dash") result = await this.runDash(prepared, controller, progressCb);
      // BT is delegated to the external aria2c engine (loaded dynamically so
      // this module's static surface is untouched); a missing aria2c fails
      // the task there with the human-readable P-3 message, never an empty
      // error.
      else if (kind === "bt") {
        const { runBt } = await import("./bt.mjs");
        result = await runBt({ downloader: this, task: prepared, controller, progressCb });
      }
      // Format conversion is delegated the same way, to the preset-only
      // ffmpeg wrapper (src/convert.mjs). The task carries its whole intent
      // in meta ({ sourcePath, preset } — HandBrake philosophy: a preset IS
      // the configuration), so nothing here inspects ffmpeg or its arguments.
      // Progress/cancel/retry ride the same controller/progressCb lifecycle
      // every other strategy uses, and the source file is never touched.
      else if (kind === "convert") {
        const { runConvert } = await import("./convert.mjs");
        result = await runConvert({ downloader: this, task: prepared, controller, progressCb });
      } else result = await this.runHttp(prepared, controller, progressCb);
      // Retries that still ended in SUCCESS belong on the task record too
      // (P-8): a probe that needed three rounds, or a transfer whose segments
      // were re-fetched, is visible work, not a silent hiccup.
      const tallied = this.runRetryCounts.get(task.id) ?? 0;
      const probeRetries = Math.max(0, (Number(result?.probeAttempts) || 1) - 1);
      if (tallied + probeRetries > 0) {
        task.retries = (Number(task.retries) || 0) + tallied + probeRetries;
      }
      return result;
    } catch (err) {
      // P-8/P-9: the last thing a strategy throws becomes the task's final
      // error here — translated by underlying code, attempt-qualified, with
      // the retries counted onto the task. See #finalTaskError.
      throw this.#finalTaskError(task, err, { url: prepared.url });
    } finally {
      if (unlinkExternal) unlinkExternal();
      this.active.delete(task.id);
      this.runRetryCounts.delete(task.id);
    }
  }

  /**
   * The task's FINAL error: translated, attempt-qualified and counted
   * (P-8/P-9).
   *
   * This is the single place a strategy's failure becomes what api.mjs writes
   * into task.error. Rules:
   *
   *   * an aborted transfer is a user action, not a diagnosis — its identity
   *     (message "aborted" / code ABORT_ERR) is preserved unchanged, because
   *     api.mjs decides pause-vs-error from the message;
   *   * the underlying errno is translated per P-9 by translateTaskError
   *     (net.mjs): 域名解析失败 / 连接被拒绝 / 连接超时或被重置 name the
   *     failing host:port, the proxy CONNECT family keeps its own wording,
   *     unknown codes keep their text with the target host appended;
   *   * failures that exhausted real attempts (the probe loop's budget, a
   *     media fragment's retries, engine segment retries) say so —
   *     "after N attempts(退避合计 Xs): <底层原因>" — and the retries land on
   *     task.retries, which until this change stayed 0 for every failure
   *     (the field report's complaint);
   *   * a BT delegate's console tails (P-10) ride the error as .btTail and
   *     are merged into task.meta.tail HERE, where the original task object
   *     (not the strategy's `prepared` copy) is in reach, so a failed or
   *     cancelled BT task shows what aria2c actually said.
   *
   * The error object is mutated and rethrown, never wrapped, so code, name
   * and statusCode keep their meaning to every upstream consumer.
   */
  #finalTaskError(task, err, { url } = {}) {
    if (!err || typeof err !== "object") return err;
    if (err.btTail) {
      task.meta = { ...(task.meta || {}), tail: err.btTail };
    }
    const message = String(err.message || "");
    const aborted = err.code === "ABORT_ERR" || err.name === "AbortError" || /abort/i.test(message);
    if (aborted) return err;
    const segmentRetries = this.runRetryCounts.get(task.id) ?? 0;
    const errAttempts = Math.max(1, Number(err.attempts) || 1);
    const retriesObserved = (errAttempts - 1) + segmentRetries;
    if (retriesObserved > 0) {
      task.retries = (Number(task.retries) || 0) + retriesObserved;
    }
    const translated = translateTaskError(err, { url });
    if (translated !== null) err.message = translated;
    // The attempt prefix is only honest where attempts were really made
    // against THIS failure: the probe/media loops that exhausted their own
    // budget (err.attempts), or a network-flavoured error after the engine
    // had already been retrying segments. A definitive first-shot answer
    // (a 404, a taken output path) gets no "after 1 attempt" noise.
    const prefixAttempts = err.attempts !== undefined
      ? errAttempts
      : (translated !== null && segmentRetries > 0 ? segmentRetries + 1 : 1);
    if (prefixAttempts > 1) {
      const backoff = Number(err.backoffMs) > 0
        ? "(退避合计 " + (Number(err.backoffMs) / 1000).toFixed(1) + "s)"
        : "";
      err.message = "after " + prefixAttempts + " attempts" + backoff + ": " + err.message;
    }
    return err;
  }

  // ------------------------------------------------------------------ HTTP

  async runHttp(task, controller, progressCb) {
    const info = await probe(task.url, {
      headers: task.headers, proxy: task.proxy,
      insecure: task.insecure ?? this.config.get("insecure"), signal: controller.signal,
      // Transient failures at probe time must not fail the whole task.
      maxRetries: this.config.get("maxRetries"),
      retryBaseMs: this.config.get("retryBaseMs"),
    });
    // Reserve the output inside one protected step: the collision policy runs
    // under the lock, so the path written is the path held. Transfer state
    // lives beside the file, so two transfers aiming at the same path would
    // otherwise share a segment journal, interleave their offsets and delete
    // each other's state.
    // CDN URLs whose last segment is a bare token produce extension-less
    // names; the probed Content-Type is the only honest hint at what the file
    // is, so append its extension before reserving (nothing opens otherwise).
    const reserved = await this.reserveTarget({
      ...task,
      signal: controller.signal,
      filename: ensureExtension(task.filename || info.filename, info.contentType),
    });
    const { target, filename, dir, category } = reserved;
    const releaseTarget = reserved.release;
    try {
      this.emit("resolved", { taskId: task.id, target, filename, dir, category, totalBytes: info.totalBytes });
      const result = await this.#transferToTarget({ task, info, target, filename, dir, category, controller, progressCb });
      // P-8: how many rounds the probe actually needed rides the result, so
      // run() can put the retries on task.retries even when the transfer
      // then succeeds. Absent when the probe answered on its first round.
      return info.attempts ? { ...result, probeAttempts: info.attempts } : result;
    } finally {
      releaseTarget();
    }
  }

  /** The transfer itself, once a target path is reserved for this task. */
  async #transferToTarget({ task, info, target, filename, dir, category, controller, progressCb }) {
    // A response that declares no length cannot be turned into a byte-range
    // plan, so the segmented engine used to fail the task outright with
    // "cannot transfer without a known total size". Chunked responses are
    // common, so stream it in one pass instead and report the running byte
    // count. No percentage is invented: the denominator is genuinely unknown.
    if (!info.totalBytes) {
      const engine = new DownloadEngine({ url: task.url, targetPath: target, connections: 1 });
      engine.on("progress", progressCb);
      engine.on("log", (m) => this.emit("log", { taskId: task.id, message: m }));
      // The streaming path is a download like any other: a schedule window must
      // throttle it too. runStreaming() reads the cap exclusively from
      // opts.sharedLimiter, so leaving it out here made the window a no-op for
      // every chunked response (measured: 515 KiB/s against a 64 KiB/s window).
      const lim = mediaLimiter(this, task);
      try {
        const result = await engine.runStreaming({
          url: task.url,
          targetPath: target,
          headers: task.headers,
          proxy: task.proxy,
          insecure: task.insecure ?? this.config.get("insecure"),
          // Per-task bucket only: the downloader-wide bucket rides in
          // sharedLimiter so a live window change still reaches this transfer.
          maxRate: 0,
          sharedLimiter: lim.limiter,
          signal: controller.signal,
          // Without this the streaming path emitted no progress at all, so a
          // caller (and the GUI) saw a silent download until it finished.
          onProgress: progressCb,
        });
        return { ...result, target, filename, dir, category, lengthKnown: false, totalBytes: null };
      } finally {
        lim.release();
      }
    }

    // Enforce the per-host connection limit, counting what other tasks on the
    // same host are already using. The setting existed but nothing read it.
    const host = (() => { try { return new URL(task.url).hostname.toLowerCase(); } catch { return ""; } })();
    const requested = task.connections ?? this.config.get("maxConnections");
    const connections = applyPerServerCap(task.url, requested, this.config, this.activeByHost);
    this.activeByHost.set(host, (this.activeByHost.get(host) || 0) + connections);

    // The engine owns a bucket per transfer; the downloader-wide bucket is
    // chained in front of it so a schedule window also throttles plain HTTP.
    const engine = this.#segmentEngine({ task, info, target, connections, controller, progressCb });

    try {
      // Resume-failure budget (aria2-style, see RESUME_FAILURE_BUDGET): an
      // attempt that continues an existing journal and then fails is counted;
      // RESUME_FAILURE_BUDGET of them in a row end the journal and the whole
      // file is taken again from byte zero.
      const store = new TransferStore(target, { writePath: target + StoreStagingSuffix });
      const resumed = await this.#willResumeFromJournal(store, info);
      let result;
      try {
        result = await engine.run({ probe: info, resume: true });
      } catch (err) {
        // Pauses and cancels are user actions, not evidence against the source.
        if (controller.signal.aborted) throw err;
        // Fresh attempts keep the queue's ordinary retry semantics. And when
        // the engine has ALREADY discarded the journal (stale revision, digest
        // mismatch, coverage gap, its own downgrade path), the half-way loop
        // this budget guards against is already broken — the next attempt
        // starts from byte zero on its own, so it is not counted either.
        if (!resumed || !(await store.loadState())) throw err;
        const lastError = (err && err.message) || String(err);
        const failures = await store.recordResumeFailure(lastError);
        if (failures < RESUME_FAILURE_BUDGET) throw err;
        // Budget exhausted: this journal is a provable dead end (bad disk, or
        // a source that refuses/corrupts continuation ranges). Discard every
        // segment byte and take the whole file again in ONE stream from byte
        // zero — deliberately single-connection, for the same reason as the
        // engine's own downgrade: continuation ranges just failed three times
        // in a row, so the one strategy with a clean record is a fresh stream
        // from the start. The "downgrade" event is the channel daemon.mjs
        // already forwards to the daemon log, so the exhaustion is recorded
        // there as exactly one line.
        this.emit("downgrade", {
          taskId: task.id,
          message: "resume failed " + failures + "x in a row (last: " + String(lastError).slice(0, 200) +
            "); resume budget exhausted, discarding partial state and restarting the whole file",
        });
        await store.discard({ target: false });
        // Runs inside the same per-host accounting scope above (1 connection
        // is always within the `connections` already reserved for this task).
        const restart = this.#segmentEngine({ task, info, target, connections: 1, controller, progressCb });
        const fresh = await restart.run({ probe: info, resume: false });
        return {
          ...fresh, target, filename, dir, category,
          resumeBudgetExhausted: true, resumeFailures: failures,
        };
      }
      // A resume that carried the transfer to completion clears the budget.
      // The engine's success cleanup removes the whole journal (the counter
      // with it); the explicit clear keeps the reset true on any path that
      // would keep the journal alive.
      if (resumed) await store.clearResumeFailures();
      return { ...result, target, filename, dir, category };
    } finally {
      const left = (this.activeByHost.get(host) || 0) - connections;
      if (left > 0) this.activeByHost.set(host, left);
      else this.activeByHost.delete(host);
    }
  }

  /**
   * One segmented engine wired to this downloader's events.
   *
   * Shared by a transfer's first attempt and its budget-exhausted restart, so
   * both report progress, retries, downgrades and log lines identically.
   *
   * @param {{task:object, info:object, target:string, connections:number,
   *          controller:AbortController, progressCb:Function}} opts
   */
  #segmentEngine({ task, info, target, connections, controller, progressCb }) {
    const engine = new DownloadEngine({
      url: task.url,
      targetPath: target,
      connections,
      segmentBytes: this.config.get("segmentBytes"),
      // Only allow splitting when the origin said it serves ranges.
      rangeSupport: info.supportsRanges !== false,
      headers: task.headers,
      proxy: task.proxy,
      insecure: task.insecure ?? this.config.get("insecure"),
      maxRate: task.speedLimit ?? this.config.get("speedLimit"),
      sharedLimiter: this.limiter,
      maxRetries: this.config.get("maxRetries"),
      retryBaseMs: this.config.get("retryBaseMs"),
      signal: controller.signal,
    });
    engine.on("progress", progressCb);
    engine.on("retry", (r) => {
      // P-8: every segment re-attempt is counted for this run, so the task's
      // final error and its `retries` field can state how much retrying the
      // engine actually did (the events already flow to the daemon log and
      // SSE; this makes them part of the task record too).
      const n = this.runRetryCounts.get(task.id);
      if (n !== undefined) this.runRetryCounts.set(task.id, n + 1);
      this.emit("retry", { taskId: task.id, ...r });
    });
    engine.on("downgrade", (m) => this.emit("downgrade", { taskId: task.id, message: m }));
    engine.on("log", (m) => this.emit("log", { taskId: task.id, message: m }));
    return engine;
  }

  /**
   * Would engine.run() continue this target's journal — for budget purposes?
   *
   * Mirrors the engine's own decision as closely as possible without touching
   * it: a journal is "resumed" when state.json exists, is not stale against
   * the fresh probe (same total size; ETag, or Last-Modified when no ETag),
   * and at least one segment record shows real progress. Everything else —
   * no journal, a journal the engine is about to discard as a different
   * revision, or a journal with no progress — is a fresh attempt and never
   * consumes the resume-failure budget. The stale arm is what makes an
   * ETag-change reset explicitly not a resume failure.
   *
   * @param {TransferStore} store the journal beside this transfer's target
   * @param {object} probe the fresh probe result for this attempt
   * @returns {Promise<boolean>}
   */
  async #willResumeFromJournal(store, probe) {
    const state = await store.loadState();
    if (!state) return false;
    const stale =
      state.totalBytes !== probe.totalBytes ||
      (state.etag && probe.etag && state.etag !== probe.etag) ||
      (!state.etag && state.lastModified && probe.lastModified && state.lastModified !== probe.lastModified);
    if (stale) return false;
    const saved = await store.loadSegments();
    for (const rec of saved) {
      if (typeof rec?.downloaded === "number" && rec.downloaded > 0) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------- FTP

  async runFtp(task, controller, progressCb) {
    const { host, port, path: remotePath, username, password } = parseFtpUrl(task.url);
    const ctl = new FtpControl({
      host, port, username, password,
      timeoutMs: 30_000, signal: controller.signal,
    });
    await ctl.connect();
    try {
      await ctl.login(username, password);
      await ctl.binary();

      const size = await ctl.size(remotePath);
      if (size === null) throw new Error(`FTP server did not report a size for ${remotePath}; cannot resume safely`);
      const mtime = await ctl.mdtm(remotePath);

      const baseName = task.filename || path.posix.basename(remotePath) || "download.bin";
      // Same rule as HTTP: reserve under the lock, so the policy (rename/skip)
      // is decided once and the chosen name stays protected. FTP resumes by
      // reading the local file's size, so two transfers sharing a path would
      // each believe they own the whole offset range.
      const reserved = await this.reserveTarget({ ...task, signal: controller.signal, filename: baseName });
      const { target, filename, dir, category } = reserved;
      const releaseTarget = reserved.release;
      try {
      this.emit("resolved", { taskId: task.id, target, filename, dir, category, totalBytes: size });

      // Resume from the bytes already on disk when the local file is shorter.
      let have = 0;
      try { have = (await fsp.stat(target)).size; } catch { have = 0; }
      if (have > size) have = 0;

      const handle = await fsp.open(target, have > 0 ? "r+" : "w+");
      if (have === 0) await handle.truncate(size);
      await handle.close();

      const data = await ctl.passive(controller.signal);
      const restReply = have > 0 ? await ctl.command(`REST ${have}`) : { code: 350 };
      if (have > 0 && restReply.code !== 350) {
        this.emit("log", { taskId: task.id, message: "server refused REST; restarting transfer" });
        have = 0;
      }

      const retr = ctl.command(`RETR ${remotePath}`);
      const fh = await fsp.open(target, "r+");
      let written = have;
      const written0 = have;
      const started = Date.now();

      try {
        const stream = data;
        const pending = [];
        for await (const chunk of stream) {
          if (controller.signal.aborted) { stream.destroy?.(); throw new Error("aborted"); }
          pending.push(fh.write(chunk, 0, chunk.length, written));
          written += chunk.length;
          if (Date.now() - started > 200) {
            progressCb({
              totalBytes: size, bytesWritten: written,
              speed: (written - written0) / Math.max(0.001, (Date.now() - started) / 1000),
              percent: size ? (written / size) * 100 : 0,
            });
          }
        }
        await Promise.all(pending);
      } finally {
        await fh.close();
      }

      const reply = await retr;
      if (reply.code !== 226 && reply.code !== 250) {
        throw new Error(`FTP RETR failed: ${reply.code} ${reply.text}`);
      }
      progressCb({ totalBytes: size, bytesWritten: written, speed: 0, percent: 100 });
      const sha256 = await hashFile(target);
      return { ok: true, bytes: written, target, filename, dir, category, sha256, downgraded: false, retries: 0, elapsedMs: Date.now() - started, mtime };
      } finally {
        releaseTarget();
      }
    } finally {
      ctl.close();
    }
  }

  // ------------------------------------------------------------------- HLS

  async runHls(task, controller, progressCb) {
    const { playlist, url: mediaUrl, variants, chosen } = await resolvePlaylist(task.url, {
      headers: task.headers, proxy: task.proxy,
      insecure: task.insecure ?? this.config.get("insecure"), signal: controller.signal,
      variantIndex: task.meta?.variantIndex,
    });
    if (!playlist.isMedia) throw new Error("HLS playlist contained no media segments");
    this.emit("log", { taskId: task.id, message: `HLS: ${playlist.segments.length} segments, ${formatBytes(playlist.duration)}` });

    const baseName = task.filename
      || sanitizeName(filenameFromUrl(mediaUrl).replace(/\.m3u8$/i, "") + ".ts", "stream.ts");
    // One transfer per output path: the segment scratch directory is keyed on
    // the target, so two HLS transfers sharing one would stitch each other's
    // fragments into the file. Reservation resolves the name under the lock.
    const reserved = await this.reserveTarget({ ...task, signal: controller.signal, filename: baseName });
    const { target, filename, dir, category } = reserved;
    const releaseTarget = reserved.release;
    // Announce the resolved path here too, not only on the plain-http path.
    // Without it nothing knew the real output name of a media transfer, so a
    // rename (name (2).ts) was invisible to anything cleaning up after it.
    this.emit("resolved", { taskId: task.id, target, filename, dir, category, kind: "hls", totalBytes: null });
    // One bucket for the whole task, chained with the downloader-wide one.
    // Fragment workers, the init segment and a separate audio rendition all
    // draw from it, so "-l 2M" means 2 MB/s for the download rather than 2 MB/s
    // multiplied by however many requests happen to be in flight.
    // Created before the try so the finally below can release it on every path.
    const lim = mediaLimiter(this, task);
    const limiter = lim.limiter;
    try {

    const partDir = `${target}.parts`;
    await mkdirWithRetry(partDir);

    const concurrency = Math.max(1, Math.min(task.connections ?? this.config.get("maxConnections"), 16));
    const segments = playlist.segments;
    // Fragments are independent: use the segmented engine on each, but with
    // modest concurrency to stay polite to the CDN.
    // 批-5/P-7：进度按**字节**口径报告——segBytes 累计已写分片字节（含独立
    // 音轨阶段），分片数另以 segmentsDone/segmentsTotal 暴露；不再把
    // segments.length 塞进 totalBytes（实测 64=分片数曾被当成字节数展示）。
    let segBytes = 0;
    let completed = 0;
    let firstMapWritten = false;
    const reportProgress = () => progressCb({
      totalBytes: null, lengthKnown: false, percent: null, speed: 0,
      bytesWritten: segBytes,
      segmentsDone: completed, segmentsTotal: segments.length,
    });

    const downloadOne = async (seg, index) => {
      const partPath = path.join(partDir, `${String(index).padStart(6, "0")}.part`);
      // A part counts as done only when its completion marker and its length
      // agree (see partIsComplete): the old "size > 0" test mistook a file a
      // crash had truncated for a finished fragment and stitched short bytes
      // into the product. Anything unmarked is discarded and fetched again,
      // so a resumed transfer produces exactly the bytes a one-shot run would.
      if (await partIsComplete(partPath)) {
        completed++;
        segBytes += (await fsp.stat(partPath)).size;
        reportProgress();
        return partPath;
      }
      await discardPartialPart(partPath);

      // Retry per segment: a dropped connection on one fragment must not
      // discard the whole playlist download. The body streams straight into
      // the .part file, so fragment size costs nothing in memory.
      const written = await fetchMediaPartToFile(seg.uri, partPath, {
        headers: task.headers,
        proxy: task.proxy ?? undefined,
        insecure: task.insecure ?? this.config.get("insecure"),
        signal: controller.signal,
        limiter,
        maxRetries: this.maxRetries,
        retryBaseMs: this.retryBaseMs,
      });
      completed++;
      segBytes += written;
      reportProgress();
      return partPath;
    };

    const indexes = segments.map((_, i) => i);
    const queue = indexes.slice();
    const worker = async () => {
      for (;;) {
        if (controller.signal.aborted) throw new Error("aborted");
        const i = queue.shift();
        if (i === undefined) return;
        await downloadOne(segments[i], i);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    // Stitch: init segment first, then every part in order. Positions are
    // tracked explicitly because the init segment is STREAMED through the same
    // output handle (no whole-segment buffer), so each part must be told
    // where the previous one ended.
    const out = await fsp.open(target, "w");
    let outPos = 0;
    try {
      if (playlist.mapUri) {
        const res = await requestFollow(playlist.mapUri, {
          headers: task.headers, proxy: task.proxy,
          insecure: task.insecure ?? this.config.get("insecure"), signal: controller.signal,
        });
        // The init segment is part of the same download, so it is throttled
        // too — and streamed into the output instead of buffered.
        outPos += await readBodyToFile(res, out, { limiter, signal: controller.signal, position: outPos });
        firstMapWritten = true;
      }
      for (let i = 0; i < segments.length; i++) {
        const partPath = path.join(partDir, `${String(i).padStart(6, "0")}.part`);
        const data = await fsp.readFile(partPath);
        await out.write(data, 0, data.length, outPos);
        outPos += data.length;
      }
    } finally {
      await out.close();
    }

    let finalTarget = target;
    let mergeMeta = { merged: false, mergeNote: null, separateTracks: null };

    // A master playlist may carry audio as its own rendition. Fetching only the
    // video variant would produce a silent file, so the audio rendition is
    // downloaded too and the two are muxed when ffmpeg is available.
    const audioGroup = chosen && chosen.AUDIO ? chosen.AUDIO : null;
    if (audioGroup && !(task.meta && task.meta.videoOnly)) {
      const audioUri = await this.#resolveHlsAudioRendition(task.url, audioGroup, task, controller);
      if (audioUri) {
        this.emit("log", { taskId: task.id, message: "HLS: separate audio rendition found, fetching it" });
        const audioRes = await resolvePlaylist(audioUri, {
          headers: task.headers, proxy: task.proxy,
          insecure: task.insecure ?? this.config.get("insecure"), signal: controller.signal,
        });
        if (audioRes.playlist.isMedia && audioRes.playlist.segments.length) {
          const audioPath = target + ".audio.ts";
          const audioParts = target + ".audioparts";
          await mkdirWithRetry(audioParts);
          let done = 0;
          const audioTotal = audioRes.playlist.segments.length;
          const aq = audioRes.playlist.segments.map((s, i) => ({ s, i }));
          const aw = async () => {
            for (;;) {
              if (controller.signal.aborted) throw new Error("aborted");
              const job = aq.shift();
              if (!job) return;
              const p = path.join(audioParts, String(job.i).padStart(6, "0") + ".part");
              // Same completion rule as the video parts: marker AND length.
              if (await partIsComplete(p)) {
                done++;
                segBytes += (await fsp.stat(p)).size;
                progressCb({
                  totalBytes: null, lengthKnown: false, percent: null, speed: 0,
                  bytesWritten: segBytes,
                  segmentsDone: done, segmentsTotal: audioTotal,
                });
                continue;
              }
              await discardPartialPart(p);
              // An audio rendition is more bytes of the same task: same
              // bucket, streamed to disk like every other fragment — and now
              // retried too, where it used to be a single attempt per part.
              // P-7：字节口径累计（含视频阶段已写分片），分片数另列字段。
              const written = await fetchMediaPartToFile(job.s.uri, p, {
                headers: task.headers,
                proxy: task.proxy,
                insecure: task.insecure ?? this.config.get("insecure"),
                signal: controller.signal,
                limiter,
                maxRetries: this.maxRetries,
                retryBaseMs: this.retryBaseMs,
              });
              done++;
              segBytes += written;
              progressCb({
                totalBytes: null, lengthKnown: false, percent: null, speed: 0,
                bytesWritten: segBytes,
                segmentsDone: done, segmentsTotal: audioTotal,
              });
            }
          };
          await Promise.all(Array.from({ length: Math.min(concurrency, 8) }, aw));
          const aOut = await fsp.open(audioPath, "w");
          try {
            const aParts = (await fsp.readdir(audioParts)).filter((f) => f.endsWith(".part")).sort();
            for (const p of aParts) await aOut.write(await fsp.readFile(path.join(audioParts, p)));
          } finally {
            await aOut.close();
          }
          await fsp.rm(audioParts, { recursive: true, force: true });

          const merged = await mergeTracks({
            videoPath: target,
            audioPath,
            outputPath: target + ".merged.mp4",
            ffmpegPath: this.config.get("ffmpegPath") || undefined,
            signal: controller.signal,
          });
          if (merged.ok) {
            await fsp.rm(target, { force: true });
            await fsp.rename(merged.output, target);
            await fsp.rm(audioPath, { force: true });
            mergeMeta = { merged: Boolean(merged.remuxed), mergeNote: null, separateTracks: null };
          } else {
            mergeMeta = { merged: false, mergeNote: merged.error, separateTracks: [target, audioPath] };
          }
        }
      }
    }

    const total = (await fsp.stat(finalTarget)).size;
    await fsp.rm(partDir, { recursive: true, force: true });
    const sha256 = await hashFile(finalTarget);
    return {
      ok: true, bytes: total, target: finalTarget, filename, dir, category, sha256,
      downgraded: false, retries: 0, elapsedMs: 0,
      meta: {
        segments: segments.length, variants, initSegment: firstMapWritten,
        merged: mergeMeta.merged, mergeNote: mergeMeta.mergeNote,
        separateTracks: mergeMeta.separateTracks,
      },
    };
    } finally {
      lim.release();
      releaseTarget();
    }
  }

  /** Look up the audio rendition URI for an HLS audio group in the master. */
  async #resolveHlsAudioRendition(masterUrl, groupId, task, controller) {
    try {
      const res = await requestFollow(masterUrl, {
        headers: task.headers, proxy: task.proxy,
        insecure: task.insecure ?? this.config.get("insecure"), signal: controller.signal,
      });
      const text = (await readBody(res)).toString("utf8");
      const re = /#EXT-X-MEDIA:([^\n]+)/g;
      let m;
      while ((m = re.exec(text))) {
        const attrs = {};
        const attrRe = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
        let a;
        while ((a = attrRe.exec(m[1]))) {
          let v = a[2];
          if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
          attrs[a[1]] = v;
        }
        if (attrs["GROUP-ID"] === groupId && attrs.TYPE === "AUDIO" && attrs.URI) {
          return new URL(attrs.URI, masterUrl).toString();
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ DASH

  /**
   * Download a DASH manifest.
   *
   * Adaptive manifests almost always split video and audio into separate
   * representations. Fetching only the video yields a silent file, so both
   * tracks are downloaded and then muxed with ffmpeg; if ffmpeg is missing the
   * two track files are kept and the outcome says so.
   */
  async runDash(task, controller, progressCb) {
    const res = await requestFollow(task.url, {
      headers: task.headers, proxy: task.proxy,
      insecure: task.insecure ?? this.config.get("insecure"), signal: controller.signal,
    });
    const xml = (await readBody(res)).toString("utf8");
    const mpd = parseMpd(xml, task.url);

    const tracks = selectTracks(mpd, {
      videoId: task.meta && task.meta.representationId,
      audioId: task.meta && task.meta.audioRepresentationId,
      includeAudio: !(task.meta && task.meta.videoOnly),
    });
    if (!tracks.video && !tracks.audio) throw new Error("DASH manifest has no usable representation");

    const baseName = task.filename
      || sanitizeName(filenameFromUrl(task.url).replace(/\.mpd$/i, "") + ".mp4", "stream.mp4");
    // Same rule as HLS: the per-track scratch directory is keyed on the target,
    // and the name is resolved under the lock so a concurrent task cannot pick
    // the same unique name.
    const reserved = await this.reserveTarget({ ...task, signal: controller.signal, filename: baseName });
    const { target, filename, dir, category } = reserved;
    const releaseTarget = reserved.release;
    // Same reason as HLS: the resolved name of a DASH transfer must be
    // observable, including a rename, or cleanup after a cancel looks at the
    // wrong paths.
    this.emit("resolved", { taskId: task.id, target, filename, dir, category, kind: "dash", totalBytes: null });
    // One bucket for the whole task, chained with the downloader-wide one.
    // Video and audio are fetched in sequence, but each with its own worker
    // pool; a per-pool bucket would let the two together move twice the rate.
    // Created before the try so the finally below can release it on every path.
    const lim = mediaLimiter(this, task);
    const limiter = lim.limiter;
    try {

    const workDir = target + ".tracks";
    await mkdirWithRetry(workDir);

    const absolute = (u) => {
      try { return new URL(u, task.url).toString(); } catch { return u; }
    };
    const concurrency = Math.max(1, Math.min(task.connections || this.config.get("maxConnections"), 16));
    // 批-5/P-7：进度按字节口径报告——trackBytes 跨视频/音频轨累计已写分片
    // 字节，分片数另以 segmentsDone/segmentsTotal 暴露；不再把分片数当
    // totalBytes（P-7 实测 64=分片数被展示成字节数）。
    let trackBytes = 0;

    /** Fetch every segment of one representation into a single file. */
    const fetchTrack = async (rep, label) => {
      const segUrls = listSegments(mpd, rep, { segmentCount: (task.meta && task.meta.segmentCount) || 0 });
      if (!segUrls.length) {
        throw new Error("DASH " + label + " representation produced no segments (SegmentList is unsupported)");
      }
      const trackDir = path.join(workDir, label);
      await mkdirWithRetry(trackDir);

      let completed = 0;
      const reportTrack = () => progressCb({
        totalBytes: null, lengthKnown: false, percent: null, speed: 0,
        bytesWritten: trackBytes,
        segmentsDone: completed, segmentsTotal: segUrls.length,
      });
      const queue = segUrls.map((u, i) => ({ u, i }));
      const worker = async () => {
        for (;;) {
          if (controller.signal.aborted) throw new Error("aborted");
          const job = queue.shift();
          if (!job) return;
          const partPath = path.join(trackDir, String(job.i).padStart(6, "0") + ".part");
          // Same completion rule as the HLS parts: marker AND length must
          // agree, otherwise the partial file is discarded and refetched.
          if (await partIsComplete(partPath)) {
            completed++;
            trackBytes += (await fsp.stat(partPath)).size;
            reportTrack();
            continue;
          }
          await discardPartialPart(partPath);
          const written = await fetchMediaPartToFile(absolute(job.u), partPath, {
            headers: task.headers,
            proxy: task.proxy ?? undefined,
            insecure: task.insecure ?? this.config.get("insecure"),
            signal: controller.signal,
            limiter,
            maxRetries: this.maxRetries,
            retryBaseMs: this.retryBaseMs,
          });
          completed++;
          trackBytes += written;
          reportTrack();
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));

      const trackPath = target + "." + label + (rep.mimeType && rep.mimeType.includes("audio") ? ".m4a" : ".mp4");
      // .ok completion markers (and their .tmp) never end in ".part", so the
      // stitch below still sees exactly the fragment files.
      const parts = (await fsp.readdir(trackDir)).filter((f) => f.endsWith(".part")).sort();
      const out = await fsp.open(trackPath, "w");
      let outPos = 0;
      try {
        if (rep.initialization) {
          // The initialization attribute is a DASH template in its own right.
          const initTemplate = expandTemplate(rep.initialization, {
            number: Number((rep.segmentTemplate && rep.segmentTemplate.startNumber) || 1),
            representationId: rep.id,
            bandwidth: rep.bandwidth,
          });
          const initUrl = initTemplate.startsWith("http") ? initTemplate : absolute(initTemplate);
          const ir = await requestFollow(initUrl, {
            headers: task.headers, proxy: task.proxy,
            insecure: task.insecure ?? this.config.get("insecure"), signal: controller.signal,
          });
          // Streamed into the track file (throttled with the same bucket),
          // not buffered: an init segment can be as large as any fragment.
          outPos += await readBodyToFile(ir, out, { limiter, signal: controller.signal, position: outPos });
        }
        for (const p of parts) {
          const data = await fsp.readFile(path.join(trackDir, p));
          await out.write(data, 0, data.length, outPos);
          outPos += data.length;
        }
      } finally {
        await out.close();
      }
      await fsp.rm(trackDir, { recursive: true, force: true });
      return { rep, path: trackPath, segments: segUrls.length };
    };

    const videoTrack = tracks.video ? await fetchTrack(tracks.video, "video") : null;
    const audioTrack = tracks.audio ? await fetchTrack(tracks.audio, "audio") : null;

    const mergeResult = await mergeTracks({
      videoPath: videoTrack ? videoTrack.path : null,
      audioPath: audioTrack ? audioTrack.path : null,
      outputPath: target,
      ffmpegPath: this.config.get("ffmpegPath") || undefined,
      signal: controller.signal,
    });

    // Track files live beside the target so they survive the scratch cleanup.
    // Once muxed they are redundant; when merging failed they are the result.
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (mergeResult.ok && mergeResult.remuxed) {
      if (videoTrack) await fsp.rm(videoTrack.path, { force: true });
      if (audioTrack) await fsp.rm(audioTrack.path, { force: true });
    }

    const finalPath = mergeResult.ok ? target : (videoTrack || audioTrack).path;
    const total = (await fsp.stat(finalPath)).size;

    if (!mergeResult.ok) {
      // Both tracks downloaded, but the mux failed (usually ffmpeg missing or
      // the segments not being valid media). Report the real output path and
      // say plainly that the requested file was not produced.
      this.emit("log", {
        taskId: task.id,
        message: "DASH merge failed (" + mergeResult.error + "); keeping separate track files",
      });
    }

    return {
      ok: true,
      bytes: total,
      target: finalPath,
      filename: path.basename(finalPath),
      dir,
      category,
      sha256: await hashFile(finalPath),
      downgraded: false,
      retries: 0,
      elapsedMs: 0,
      meta: {
        representation: tracks.video ? tracks.video.id : null,
        audioRepresentation: tracks.audio ? tracks.audio.id : null,
        segments: (videoTrack ? videoTrack.segments : 0) + (audioTrack ? audioTrack.segments : 0),
        duration: mpd.mediaPresentationDuration,
        merged: mergeResult.ok && Boolean(mergeResult.remuxed),
        mergeNote: mergeResult.ok ? null : mergeResult.error,
        separateTracks: mergeResult.ok ? null : [videoTrack && videoTrack.path, audioTrack && audioTrack.path].filter(Boolean),
      },
    };
    } finally {
      lim.release();
      releaseTarget();
    }
  }
}

async function hashFile(file) {
  const h = createHash("sha256");
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file);
    rs.on("data", (c) => h.update(c));
    rs.once("end", resolve);
    rs.once("error", reject);
  });
  return h.digest("hex");
}
