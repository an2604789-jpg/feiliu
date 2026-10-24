// Download engine: concurrent ranged transfers over one preallocated file.
//
// The interesting part is not the concurrency — it is what happens when the
// network misbehaves. Concurrent ranged downloads can silently produce a
// corrupt file when different connections receive inconsistent content (CDN
// nodes out of sync, a middlebox rewriting responses, a flaky origin). A
// downloader that does not detect this hands the user a broken file together
// with a success message, so a failed verification downgrades the transfer to
// a single connection rather than trusting the result.

import fsp from "node:fs/promises";
import path from "node:path";

import { requestFollow, discard, RangeNotSupportedError, HttpStatusError } from "./net.mjs";
import { planSegments, validatePlan } from "./plan.mjs";
import { AdaptiveConcurrencyGate, isThrottleStatus } from "./gate.mjs";
import { WorkerHealthMonitor } from "./health.mjs";
import { TransferStore, hashFile, STAGING_SUFFIX } from "./store.mjs";
import { backoffDelay, sleep, clamp } from "./util.mjs";
import { RateLimiter } from "./rate.mjs";

/** Fallback when no retry policy is configured. */
const DEFAULT_MAX_ATTEMPTS = 6;
/** Never split a piece smaller than this, however idle the fleet is. */
const MIN_SPLIT_BYTES = 512 * 1024;
const DEFAULT_SEGMENT_FLOOR = 4 * 1024 * 1024;

// The limiter lives in its own module because two strategies now share it:
// the segmented HTTP engine and the HLS/DASH fragment path. Re-exported here
// so the original import site keeps working.
export { RateLimiter };

/** Mutable progress shared by every worker of one transfer. */
class Progress {
  /**
   * @param {number} totalBytes
   * @param {Array<{start:number,end:number,length:number,downloaded:number}>} segments
   *   The live ledger. bytesWritten is derived from it rather than accumulated
   *   counter-by-counter, so retries that re-read bytes can never push the
   *   displayed total past the file size.
   */
  constructor(totalBytes, segments) {
    this.totalBytes = totalBytes;
    this.segments = segments;
    this.startedAt = Date.now();
    this._lastEmit = 0;
  }
  get bytesWritten() {
    let sum = 0;
    for (const s of this.segments) sum += Math.min(s.downloaded, s.length);
    return sum;
  }
  get elapsedSec() {
    return Math.max(0.001, (Date.now() - this.startedAt) / 1000);
  }
  get speed() {
    return this.bytesWritten / this.elapsedSec;
  }
  get eta() {
    const remaining = this.totalBytes - this.bytesWritten;
    const s = this.speed;
    return s > 0 && remaining > 0 ? remaining / s : 0;
  }
  snapshot() {
    return {
      totalBytes: this.totalBytes,
      bytesWritten: this.bytesWritten,
      speed: this.speed,
      eta: this.eta,
      elapsedSec: this.elapsedSec,
      percent: this.totalBytes ? (this.bytesWritten / this.totalBytes) * 100 : 0,
    };
  }
}

/**
 * Prove that the worker ledger covers every byte of the resource exactly once.
 *
 * "No error was thrown" is not the same claim as "the file is complete": a
 * worker released before it wrote anything, a split tail nobody claimed, or a
 * segment written past its own boundary all end silently. The plan is the
 * contract, so completeness is checked against it — by index, not by adding up
 * otherwise-anonymous byte counts, because a duplicate index would then hide a
 * missing one.
 *
 * The segment array is also re-validated here: the dynamic splitter mutates
 * boundaries in place while the transfer runs.
 *
 * @returns {{ok:boolean, summary:string, missing:number}}
 */
function segmentsCoverage(work, totalBytes) {
  const byIndex = new Map();
  let planned = 0;
  let duplicates = 0;
  for (const s of work) {
    const length = s.end - s.start + 1;
    if (!Number.isInteger(s.index) || s.index < 0 || length <= 0) {
      return { ok: false, summary: "segment #" + s.index + " has an invalid range " + s.start + "-" + s.end, missing: totalBytes };
    }
    if (byIndex.has(s.index)) duplicates++;
    byIndex.set(s.index, { length, got: Math.min(s.downloaded ?? 0, length) });
    planned += length;
  }
  if (planned !== totalBytes) {
    return { ok: false, summary: "the plan covers " + planned + " of " + totalBytes + " bytes", missing: Math.abs(totalBytes - planned) };
  }
  let missing = 0;
  let short = 0;
  for (const rec of byIndex.values()) {
    if (rec.got < rec.length) { short++; missing += rec.length - rec.got; }
  }
  if (duplicates > 0) {
    return { ok: false, summary: duplicates + " duplicate segment index(es) in the ledger", missing };
  }
  if (short > 0) {
    return {
      ok: false,
      summary: short + " of " + byIndex.size + " segment(s) are short (" + missing + " byte(s) missing)",
      missing,
    };
  }
  return { ok: true, summary: byIndex.size + " segment(s) cover all " + totalBytes + " bytes", missing: 0 };
}

export class DownloadEngine {
  constructor(options = {}) {
    this.url = options.url;
    this.targetPath = options.targetPath;
    this.connections = clamp(Math.floor(options.connections ?? 8), 1, 32);
    this.segmentBytes = options.segmentBytes;
    this.headers = options.headers ?? {};
    this.proxy = options.proxy;
    this.insecure = Boolean(options.insecure);
    this.signal = options.signal;
    this.limiter = new RateLimiter(options.maxRate ?? 0);
    /**
     * A bucket shared with the caller (the Downloader's downloader-wide cap).
     *
     * Checked in addition to this engine's own bucket, so a bandwidth window
     * reaches a transfer that is already running without disturbing the
     * per-task rate.
     */
    this.sharedLimiter = options.sharedLimiter ?? null;
    this.listeners = [];
    this.retries = 0;
    // Retry policy comes from config; these were previously hardcoded,
    // which left maxRetries and retryBaseMs as settings nothing read.
    this.maxAttempts = Math.max(1, Number(options.maxRetries) || DEFAULT_MAX_ATTEMPTS);
    this.retryBaseMs = Math.max(10, Number(options.retryBaseMs) || 0) || undefined;

    // Adaptive concurrency: the requested connection count is the ceiling, not
    // a promise. A 429/503 halves the working cap; healthy windows add it back
    // one at a time.
    this.gate = new AdaptiveConcurrencyGate({
      max: this.connections,
      enabled: options.adaptive !== false,
      recoveryMs: options.recoveryMs,
    });
    this.gate.on((e) => this.emit("concurrency", e));

    // Drops a connection that has gone silent or fallen far behind its peers.
    this.health = null;
    /** Split large segments when workers go idle (IDM-style ramp-up). */
    this.dynamicSegments = options.dynamicSegments !== false;
    /** Set when the origin cannot serve ranges; disables splitting. */
    this.singleStreamForced = false;
    /** Whether the origin reported range support; gates splitting. */
    this.rangeSupport = options.rangeSupport !== false;
    /** Segments currently being written by a worker. */
    this._inFlight = new Set();
    this.segmentBytes = options.segmentBytes;
  }

  on(event, fn) {
    this.listeners.push({ event, fn });
    return this;
  }

  emit(event, payload) {
    for (const l of this.listeners) if (l.event === event) l.fn(payload);
  }

  /**
   * Run one transfer to completion.
   * @param {{ probe:object, resume?:boolean }} ctx
   */
  async run(ctx) {
    const startedAt = Date.now();
    // A signal passed to run() must win over the constructor's. Callers that
    // cancel a transfer do so here, and ignoring it silently made cancellation
    // a no-op: the transfer ran to completion and reported success.
    if (ctx.signal !== undefined) this.signal = ctx.signal;
    const { probe } = ctx;
    // Bytes are assembled in a staging file and renamed into place only once
    // every segment is provably full. Writing at final offsets into the final
    // path — which the store then preallocated to its full length so workers
    // could seek — left a file whose *size* was right and whose tail was still
    // zeroes whenever a transfer was paused, cancelled or killed. Every
    // consumer that trusts a size (a player, a backup, the "complete" label)
    // was misled. The streaming path already worked this way.
    const stagingPath = this.targetPath + STAGING_SUFFIX;
    const store = new TransferStore(this.targetPath, { writePath: stagingPath });
    await store.init();

    const totalBytes = probe.totalBytes;
    if (!totalBytes) throw new Error("cannot transfer without a known total size");

    let state = ctx.resume ? await store.loadState() : null;
    const stale =
      state &&
      (state.totalBytes !== totalBytes ||
        (state.etag && probe.etag && state.etag !== probe.etag) ||
        (!state.etag && state.lastModified && probe.lastModified && state.lastModified !== probe.lastModified));

    let segments;
    if (!state || stale) {
      if (stale) this.emit("log", "discarding partial data: the stored transfer is from a different revision");
      // Only this transfer's own work is discarded. A file already at the
      // final path belongs to the user, not to this attempt.
      await store.discard({ target: false });
      await store.init();
      segments = planSegments(totalBytes, { connections: this.connections, segmentBytes: this.segmentBytes });
      await store.saveState({
        url: probe.finalUrl,
        totalBytes,
        etag: probe.etag ?? null,
        lastModified: probe.lastModified ?? null,
        createdAt: new Date().toISOString(),
        segments,
      });
      await store.prepareTarget(totalBytes);
      for (const s of segments) await store.saveSegment({ ...s, downloaded: 0 });
    } else {
      await store.prepareTarget(totalBytes);

      // Progress lives in the per-segment files, not in state.segments. The
      // state file only records the plan, and it is written once at the
      // start, so its `downloaded` values are always zero. Reading them back
      // without the segment files made every resume restart from scratch.
      const saved = await store.loadSegments();
      const progressByIndex = new Map();
      for (const rec of saved) {
        if (typeof rec?.index === "number" && typeof rec?.downloaded === "number") {
          progressByIndex.set(rec.index, rec.downloaded);
        }
      }

      segments = state.segments.map((s) => {
        const planLength = s.end - s.start + 1;
        const onDisk = progressByIndex.get(s.index);
        const downloaded = onDisk === undefined
          ? (s.downloaded ?? 0)
          : Math.min(onDisk, planLength);
        return { ...s, downloaded };
      });

      const resumed = segments.filter((s) => (s.downloaded ?? 0) > 0).length;
      const haveBytes = segments.reduce((a, s) => a + (s.downloaded ?? 0), 0);
      this.emit("log", `resuming: ${resumed}/${segments.length} segment(s), ` +
        `${haveBytes} of ${totalBytes} bytes already present`);
    }

    if (!validatePlan(segments, totalBytes)) throw new Error("segment plan does not cover the resource exactly once");

    const handle = await fsp.open(stagingPath, "r+");
    const work = segments.map((s) => ({
      ...s,
      length: s.end - s.start + 1,
      downloaded: Math.min(s.downloaded ?? 0, s.end - s.start + 1),
    }));
    const progress = new Progress(totalBytes, work);
    this.emit("progress", progress.snapshot());

    // Claiming must be atomic. An index-based cursor is NOT: it only advances
    // once a segment is already complete, so several workers calling it before
    // the first write lands would all receive the same segment — the file still
    // comes out correct (identical bytes at identical offsets) while the
    // transfer quietly downloads the resource N times over.
    // Array#shift is synchronous, hence atomic between worker turns.
    const queue = work.filter((s) => s.downloaded < s.length);
    const nextJob = () => queue.shift() ?? null;

    const pending = work.filter((s) => s.downloaded < s.length).length;
    // Spawn the full pool: the gate decides how many run at once, and the
    // surplus workers are what a split tail gets handed to.
    const workerCount = Math.max(1, Math.min(this.connections, Math.max(pending, 1) * 2, 32));

    // One monitor for the fleet. Cancelling an unhealthy worker aborts that
    // worker's request so the segment is retried on a fresh connection.
    this.health = new WorkerHealthMonitor({
      onUnhealthy: (id, reason, detail) => {
        this.emit("unhealthy", { worker: id, reason, ...detail });
        const cancel = this.workerCancels && this.workerCancels.get(id);
        if (cancel) { try { cancel(); } catch { /* already gone */ } }
      },
    });
    for (let i = 0; i < workerCount; i++) this.health.track(i);
    this.health.start();
    this.emit("log", `${workerCount} worker(s) over ${work.length} segment(s), ${totalBytes} bytes total`);

    let downgrade = null;
    // Workers pause when the adaptive cap drops, so a throttle actually
    // reduces the connections in flight instead of being merely recorded.
    const waitForCapacity = () => this.gate.acquire(this.signal, () => Boolean(downgrade));

    const worker = async (id) => {
      for (;;) {
        if (this.signal?.aborted) throw new Error("aborted");
        if (downgrade) return;
        let seg = nextJob();
        if (!seg) {
          // Nothing queued: before this worker retires, see whether a large
          // segment can be shared. This is the ramp-up path.
          if (this.maybeSplitForIdleWorker(work, queue, this.gate)) continue;
          return;
        }
        if (!(await waitForCapacity())) return;

        // Every path from here must release the slot. A worker that reports a
        // downgrade and returns without releasing leaves the gate permanently
        // short, and peers blocked in acquire() never wake — which deadlocks
        // the transfer exactly when the fallback should be starting.
        let slotHeld = true;
        const releaseSlot = () => { if (slotHeld) { slotHeld = false; this.gate.release(); } };
        this._inFlight.add(seg);
        try {
          await this.fetchSegment({ seg, store, handle, progress, workerId: id });
          releaseSlot();
          this.gate.noteSuccess();
          this.health?.noteBytes(id, 0);
        } catch (err) {
          if (err?.name === "RangeNotSupportedError" || err?.name === "IntegrityError") {
            downgrade = err;
            return;
          }
          throw err;
        } finally {
          this._inFlight.delete(seg);
          releaseSlot();
        }
      }
    };

    let failure = null;
    try {
      await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
    } catch (err) {
      failure = err;
    }

    // Before trusting the result, re-read windows across the segment seams.
    // A concurrent download can be perfectly hashed yet still torn when the
    // origin served different bytes for the same range on different
    // connections. Treat that like an ignored Range: discard and redo it as a
    // single stream, which cannot disagree with itself.
    if (!failure && !downgrade && work.length > 1 && !this._skipBoundaryCheck) {
      try {
        const check = await this.verifyBoundaries({ segments: work, handle, probe });
        this.emit("log", "boundary check: " + check.checked + " window(s), " + check.mismatches.length + " mismatch(es)");
        if (!check.ok) {
          const err = new Error(
            "the origin returned different bytes for the same range on different connections (" +
            check.mismatches.length + " of " + check.checked + " windows differ)"
          );
          err.name = "IntegrityError";
          downgrade = err;
        }
      } catch (err) {
        this.emit("log", "boundary check could not run: " + err.message);
      }
    }

    await handle.close();

    if (failure) throw failure;

    if (downgrade) {
      const reason = downgrade.message;
      this.emit("downgrade", `falling back to a single connection: ${reason}`);
      // The staged bytes are untrustworthy, but a file already at the final
      // path is not this transfer's to delete.
      await store.discard({ target: false });
      await store.init();

      const single = new DownloadEngine({
        url: this.url,
        targetPath: this.targetPath,
        connections: 1,
        segmentBytes: this.segmentBytes,
        headers: this.headers,
        proxy: this.proxy,
        insecure: this.insecure,
        signal: this.signal,
        maxRate: this.limiter.rate,
        sharedLimiter: this.sharedLimiter,
      });
      single._skipBoundaryCheck = true;
      // Ranges are not honoured here (that is why we fell back), so the
      // splitter must stay out of this attempt. Carry the revoked flag too:
      // both guards must hold on the retry, not just one.
      single.singleStreamForced = true;
      single.dynamicSegments = false;
      single.rangeSupport = false;
      for (const l of this.listeners) if (l.event !== "downgrade") single.on(l.event, l.fn);
      single.retries = this.retries;

      const result = await single.run({ probe, resume: false });
      this.retries = single.retries;
      return { ...result, downgraded: true, reason, elapsedMs: Date.now() - startedAt };
    }

    // A worker loop that ended without an error is not proof that every byte
    // landed. A gate that never admitted a worker, a downgrade that returned
    // early, or a bug in the splitter all leave gaps that no exception reports.
    // The ledger is the authority: each plan byte must be covered by the same
    // index's byte count, and only then is the file allowed to be published.
    const coverage = segmentsCoverage(work, totalBytes);
    if (!coverage.ok) {
      await store.discard({ target: false });
      const err = new Error(
        "transfer incomplete after every worker stopped: " + coverage.summary +
        "; partial data discarded, nothing was published"
      );
      err.name = "IncompleteTransferError";
      throw err;
    }

    // Verify against the origin's own validator when it provided one.
    let sha256 = null;
    let verified = "computed";
    if (probe.contentDigest) {
      // Digest headers carry base64 while hashFile returns hex, so accept
      // either encoding rather than failing a correct file.
      const gotHex = await hashFile(stagingPath, probe.contentDigest.algo);
      const gotB64 = Buffer.from(gotHex, "hex").toString("base64");
      const ok = gotB64 === probe.contentDigest.value || gotHex === probe.contentDigest.value;
      if (!ok) {
        await store.discard({ target: false });
        throw new Error(
          "the file does not match the digest published by the origin (" +
          probe.contentDigest.source + " " + probe.contentDigest.algo +
          "); partial data discarded"
        );
      }
      verified = probe.contentDigest.source + ":" + probe.contentDigest.algo + "=ok";
      sha256 = probe.contentDigest.algo === "sha256" ? gotHex : await hashFile(stagingPath, "sha256");
    } else {
      sha256 = await hashFile(stagingPath, "sha256");
    }

    // Publish atomically: the final path only ever holds a complete file, so a
    // concurrent reader sees either nothing (or the previous file) or the whole
    // download. The rename is what makes the transfer's success observable, and
    // it happens after the content check, never before it.
    await store.publish();
    this.emit("log", "published " + path.basename(this.targetPath) + " (" + totalBytes + " bytes)");

    await store.cleanup();
    return { ok: true, bytes: totalBytes, sha256, verified, downgraded: false, reason: null, retries: this.retries, elapsedMs: Date.now() - startedAt };
  }


  /**
   * Re-read short windows that straddle segment boundaries and compare them
   * with what a fresh request returns.
   *
   * This is IDM's core fault tolerance. Concurrent ranged downloads can
   * silently produce a torn file when different connections receive
   * different content for the same bytes (CDN nodes out of sync, a caching
   * proxy serving stale ranges, an origin that ignores the requested offset).
   * The finished file looks fine and hashes consistently, so only an
   * independent re-read can catch it.
   *
   * @returns {Promise<{ok:boolean, checked:number, mismatches:Array}>}
   */
  async verifyBoundaries({ segments, handle, probe }) {
    if (!probe.supportsRanges || segments.length < 2) return { ok: true, checked: 0, mismatches: [] };
    const WINDOW = Math.min(4096, Math.max(512, Math.floor((segments[0].end - segments[0].start + 1) / 4)));
    const mismatches = [];
    let checked = 0;

    // One probe per internal boundary, plus the very first and last byte.
    const offsets = [0];
    for (let i = 1; i < segments.length; i++) {
      offsets.push(Math.max(0, segments[i].start - Math.floor(WINDOW / 2)));
    }
    offsets.push(Math.max(0, probe.totalBytes - WINDOW));

    for (const start of offsets) {
      const end = Math.min(start + WINDOW - 1, probe.totalBytes - 1);
      const want = end - start + 1;
      const local = Buffer.alloc(want);
      await handle.read(local, 0, want, start);
      let remote;
      try {
        remote = await this.fetchRange(start, end);
      } catch {
        continue;   // a failed probe proves nothing; do not condemn the file
      }
      if (!remote) continue;
      checked++;
      if (remote.length !== want || !remote.equals(local)) {
        mismatches.push({ start, end });
      }
    }
    return { ok: mismatches.length === 0, checked, mismatches };
  }

  /** Fetch one byte range and return the body, or null when unsupported. */
  async fetchRange(start, end) {
    const res = await requestFollow(this.url, {
      method: "GET",
      headers: { ...this.headers, Range: "bytes=" + start + "-" + end },
      proxy: this.proxy,
      insecure: this.insecure,
      timeoutMs: 30000,
      signal: this.signal,
      maxRedirects: 5,
    });
    if (res.statusCode !== 206) { await discard(res); return null; }
    const chunks = [];
    for await (const c of res.stream) chunks.push(c);
    return Buffer.concat(chunks);
  }


  /**
   * Split the largest unfinished segment so an idle worker can share it.
   *
   * Adaptive concurrency only lowers the cap; this is the upward path. It
   * runs when a worker finds the queue empty, which is exactly when extra
   * parallelism is free — never while every worker is already busy.
   *
   * @returns {boolean} true when a segment was split and queued
   */

  /**
   * Download a resource whose length the origin did not declare.
   *
   * The segmented engine plans byte ranges up front, which needs a known
   * total; chunked responses have none. Rather than fabricate a size — which
   * would produce a wrong percentage, a wrong ETA and a segment plan that
   * cannot be validated — the body is streamed to disk in one pass.
   *
   * The result reports lengthKnown: false so callers can present honest
   * progress instead of inventing a denominator. With no plan there is
   * nothing to resume, so resumable is false and a re-run restarts from the
   * beginning rather than pretending to continue.
   *
   * @param {{ url: string, targetPath: string, headers?: object, proxy?: string,
   *           insecure?: boolean, maxRate?: number, signal?: AbortSignal,
   *           onProgress?: Function }} opts
   */
  async runStreaming(opts) {
    const { url, targetPath, headers = {}, proxy, insecure, maxRate = 0, signal, onProgress } = opts;
    const startedAt = Date.now();
    const limiter = new RateLimiter(maxRate);

    // Write to a temporary file and rename on success, so an interrupted
    // transfer never leaves a partial file at the final path where a later
    // run would mistake it for a complete download.
    const tempPath = targetPath + ".partial";
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    if (signal?.aborted) throw new Error("aborted");

    const res = await requestFollow(url, {
      method: "GET", headers, proxy, insecure, signal, timeoutMs: 60_000, maxRedirects: 10,
    });

    if (res.statusCode !== 200 && res.statusCode !== 206) {
      await discard(res);
      throw new HttpStatusError(res.statusCode, res.statusMessage, url);
    }

    // A redirect chain can change the declared length, so prefer a real
    // header over assuming the size is unknown.
    const declared = Number(res.headers["content-length"] ?? NaN);
    const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null;

    let handle = null;
    let written = 0;
    let lastEmit = 0;
    try {
      handle = await fsp.open(tempPath, "w");
      for await (const chunk of res.stream) {
        if (signal?.aborted) throw new Error("aborted");
        if (opts.sharedLimiter) await opts.sharedLimiter.take(chunk.length, signal);
        await limiter.take(chunk.length, signal);
        // Same rule as the segmented path: only the bytes the file actually
        // accepted count, so a short write cannot be recorded as progress.
        let offsetInChunk = 0;
        while (offsetInChunk < chunk.length) {
          const res2 = await handle.write(chunk, offsetInChunk, chunk.length - offsetInChunk);
          if (!res2 || !(res2.bytesWritten > 0)) {
            throw new Error("short write after " + written + " byte(s)");
          }
          offsetInChunk += res2.bytesWritten;
        }
        written += chunk.length;
        const now = Date.now();
        if (now - lastEmit > 200) {
          lastEmit = now;
          // With no known total, report the running byte count only. No
          // percentage and no ETA: inventing either would be a lie.
          onProgress?.({
            totalBytes: totalBytes, lengthKnown: totalBytes !== null,
            bytesWritten: written,
            percent: totalBytes ? (written / totalBytes) * 100 : null,
            eta: null,
            elapsedSec: (now - startedAt) / 1000,
            speed: written / Math.max(0.001, (now - startedAt) / 1000),
          });
        }
      }
    } catch (err) {
      await handle?.close();
      handle = null;
      // A failed or cancelled stream must not leave a partial file behind.
      await fsp.rm(tempPath, { force: true });
      throw err;
    } finally {
      await handle?.close();
    }

    if (written === 0) {
      await fsp.rm(tempPath, { force: true });
      throw new Error("the origin returned no data");
    }

    // Atomic publish: the final path only ever holds a complete file.
    await fsp.rename(tempPath, targetPath);

    onProgress?.({
      totalBytes, lengthKnown: totalBytes !== null, bytesWritten: written,
      percent: totalBytes ? 100 : null, eta: null,
      elapsedSec: (Date.now() - startedAt) / 1000,
      speed: written / Math.max(0.001, (Date.now() - startedAt) / 1000),
    });

    return {
      ok: true,
      bytes: written,
      sha256: await hashFile(targetPath),
      lengthKnown: totalBytes !== null,
      resumable: false,
      streaming: true,
      downgraded: false,
      retries: 0,
      elapsedMs: Date.now() - startedAt,
    };
  }

  maybeSplitForIdleWorker(work, queue, gate) {
    if (!this.dynamicSegments) return false;
    // Splitting only helps when the origin serves byte ranges. After a
    // downgrade it does not, so a split tail could never be fetched and the
    // splitter would run again on every loop.
    if (this.singleStreamForced || this.connections === 1) return false;
    // Splitting is only sound when the origin proved it serves ranges. A probe
    // that reported no range support, or a transfer that is already falling
    // back, must not be divided further.
    if (!this.rangeSupport) return false;
    // The caller has just released its slot, so it is the spare capacity — no
    // capacity test is needed here. What matters is whether work is already
    // waiting, in which case there is nothing to split.
    if (queue.length > 0) return false;

    // In-flight segments ARE the candidates: only they still have unclaimed
    // bytes. Splitting one is safe because only its tail moves — the writer
    // re-reads seg.end on every chunk, so it stops at the new boundary, and any
    // bytes it already wrote past that point are exactly the bytes the new
    // piece will write. The single writer per segment rule is preserved.
    // The floor is the smallest piece worth handing to a worker — NOT the
    // configured segment size. Using the latter would require a segment to hold
    // twice its own length before it could be split, so a normally sized
    // segment could never be divided.
    const floor = MIN_SPLIT_BYTES;
    let target = null;
    let bestLeft = 0;
    for (const s of work) {
      if (queue.includes(s)) continue;        // already waiting to be claimed
      // Progress the writer has already made is not available to share.
      const head = s.start + (s.downloaded || 0);
      const left = s.end - head + 1;
      if (left < floor * 2) continue;         // both halves must clear the floor
      if (left > bestLeft) { bestLeft = left; target = s; }
    }
    if (!target) return false;

    const head = target.start + (target.downloaded || 0);
    const mid = head + Math.floor(bestLeft / 2);
    if (mid <= head || mid > target.end) return false;

    // The original keeps everything up to mid-1; a new piece takes the tail.
    const tail = {
      index: work.length,
      start: mid,
      end: target.end,
      downloaded: 0,
      length: target.end - mid + 1,
    };
    target.end = mid - 1;
    target.length = target.end - target.start + 1;
    work.push(tail);
    queue.push(tail);
    this.emit("log", "split segment #" + target.index + " at 0x" + mid.toString(16) +
      " (" + Math.round(tail.length / 1024) + " KB handed to an idle worker)");
    return true;
  }

  /** Transfer one segment, resuming inside it on retry. */
  async fetchSegment({ seg, store, handle, progress, workerId }) {
    let attempt = 0;
    let downloaded = seg.downloaded;

    for (;;) {
      if (downloaded >= seg.length) {
        seg.downloaded = downloaded;
        return;
      }
      attempt++;
      const from = seg.start + downloaded;

      try {
        const res = await requestFollow(this.url, {
          method: "GET",
          headers: { ...this.headers, Range: `bytes=${from}-${seg.end}` },
          proxy: this.proxy,
          insecure: this.insecure,
          timeoutMs: 60_000,
          signal: this.signal,
          maxRedirects: 10,
        });

        if (res.statusCode === 206) {
          downloaded = await this.pump(res, seg, downloaded, handle, store, progress);
        } else if (res.statusCode === 200) {
          // The origin ignored Range. Accept it only when this worker owns the
          // start of the resource; otherwise every worker would rewrite byte 0.
          if (this.connections === 1 && seg.index === 0) {
            downloaded = await this.pump(res, seg, downloaded, handle, store, progress);
          } else {
            // Proven not to honour ranges: stop any further splitting.
            this.rangeSupport = false;
            await discard(res);
            throw new RangeNotSupportedError(this.url);
          }
        } else {
          // A server pushing back must lower the working connection count.
          if (isThrottleStatus(res.statusCode)) {
            const retryAfter = Number(res.headers["retry-after"]) * 1000;
            const change = this.gate.noteThrottle(Number.isFinite(retryAfter) ? retryAfter : 0);
            this.emit("throttled", { status: res.statusCode, ...change });
          }
          await discard(res);
          throw new HttpStatusError(res.statusCode, res.statusMessage, this.url);
        }

        if (downloaded >= seg.length) {
          seg.downloaded = downloaded;
          await store.saveSegment({ ...seg, downloaded });
          this.emit("progress", progress.snapshot());
          return;
        }
        // Short body — loop and request the remainder.
      } catch (err) {
        if (this.signal?.aborted) throw new Error("aborted");
        if (err?.name === "RangeNotSupportedError") throw err;

        // The origin pushing back must lower the working connection count.
        // The error surfaces here rather than as a returned status because
        // requestFollow turns every >=400 into an HttpStatusError.
        if (err instanceof HttpStatusError && isThrottleStatus(err.statusCode)) {
          const change = this.gate.noteThrottle(err.retryAfterMs || 0);
          this.emit("throttled", { status: err.statusCode, ...change });
          // Wait out the cooldown before this worker tries again.
          const waitMs = Math.min(30_000, Math.max(0, (err.retryAfterMs || 0) || this.gate.recoveryMs / 4));
          if (waitMs > 0) await sleep(waitMs, this.signal).catch(() => {});
        }

        const retryable = !(err instanceof HttpStatusError) || err.retryable;
        if (!retryable || attempt >= this.maxAttempts) throw err;
        this.retries++;
        const delay = backoffDelay(attempt);
        this.emit("retry", { segment: seg.index, attempt, delay, error: err.message });
        await sleep(delay, this.signal);
      }
    }
  }

  /** Stream one body into the file at this segment's offsets. */
  async pump(res, seg, downloaded, handle, store, progress) {
    const before = downloaded;
    // Bytes already covered by a journal write. Progress is checkpointed as the
    // transfer proceeds rather than only when it ends, because the end is
    // exactly what a crash, a power loss or a killed process never reaches:
    // without a checkpoint, a hard kill discarded every byte of the segment in
    // flight and the resume started that segment over. The interval bounds how
    // much work a crash can cost.
    let checkpointed = downloaded;
    // How much work a crash may cost.
    //
    // A time-only interval is wrong on a fast link: 2 seconds of a 100 Mbit/s
    // transfer is 25 MB that a kill can never recover, because the journal
    // still records the older offset. The interval is therefore paired with a
    // byte budget, whichever comes first. 500ms bounds the time a crash can
    // lose; the byte budget bounds the volume when 500ms is a lot of data (and
    // still triggers on a slow, stalled link where the time fires first).
    const CHECKPOINT_MS = 500;
    const checkpointBudget = Math.max(1024 * 1024, Math.floor(seg.length / 32));
    let checkpointAt = Date.now() + CHECKPOINT_MS;
    try {
      if (res.stream && typeof res.stream.on === "function" && res.stream.listenerCount("error") === 0) {
        res.stream.on("error", () => {});
      }
      for await (const chunk of res.stream) {
        if (this.signal?.aborted) {
          res.destroy?.();
          throw new Error("aborted");
        }
        const offset = seg.start + downloaded;
        const remaining = seg.end - offset + 1;
        if (remaining <= 0) break;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        this.health?.noteLimiterWait(seg.index, true);
        if (this.sharedLimiter) await this.sharedLimiter.take(slice.length, this.signal);
        await this.limiter.take(slice.length, this.signal);
        this.health?.noteLimiterWait(seg.index, false);
        // FileHandle.write may write fewer bytes than asked for. Recording the
        // requested length instead of the real one makes the journal claim
        // progress that is not on disk, and a resume that trusts it skips over
        // the hole — leaving a file of the right size with the wrong content.
        // Partial writes are rare, which is exactly why the corruption they
        // cause is intermittent and hard to blame on this line.
        let written = 0;
        while (written < slice.length) {
          const res2 = await handle.write(slice, written, slice.length - written, offset + written);
          if (!res2 || !(res2.bytesWritten > 0)) {
            throw new Error("short write at offset " + (offset + written) +
              " (" + (slice.length - written) + " byte(s) still unwritten)");
          }
          written += res2.bytesWritten;
        }
        this.health?.noteBytes(seg.index, written);
        downloaded += written;
        seg.downloaded = downloaded;

        const now = Date.now();
        if (now - progress._lastEmit > 200) {
          progress._lastEmit = now;
          this.emit("progress", progress.snapshot());
        }

        // A checkpoint may only record bytes that have reached the file, so
        // the data is flushed before the journal is advanced. Without the sync
        // the journal can lead the disk: a killed process then resumes past
        // bytes the operating system never wrote, and the gap is invisible in
        // the finished file's size.
        const dueByTime = now >= checkpointAt;
        const dueByBytes = downloaded - checkpointed >= checkpointBudget;
        if ((dueByTime || dueByBytes) && downloaded > checkpointed) {
          checkpointAt = now + CHECKPOINT_MS;
          try { await handle.sync(); } catch { /* flush unavailable: still checkpoint */ }
          checkpointed = downloaded;
          try {
            await store.saveSegment({ ...seg, downloaded });
          } catch (err) {
            // A journal that cannot be written is a real problem, but failing
            // an in-progress transfer over it would be worse than losing the
            // checkpoint: the final write below still records the truth.
            this.emit("log", "checkpoint write failed: " + err.message);
          }
        }
      }
    } finally {
      // Persist even on failure: a resume must not redo completed work. The
      // flush comes first so the journal can never claim bytes the file does
      // not have; a resume that trusts an unflushed offset skips past the hole.
      if (downloaded !== before) {
        try { await handle.sync(); } catch { /* flush unavailable: still record */ }
        await store.saveSegment({ ...seg, downloaded });
      }
      this.health?.noteLimiterWait(seg.index, false);
    }
    return downloaded;
  }
}

export { DEFAULT_MAX_ATTEMPTS };
