// Crash-safe transfer state.
//
// Design note (the one place this project deliberately follows IDM's approach):
// progress is kept per segment in its own small file rather than in one large
// state document. A crash can then only ever lose the segment being written,
// never the whole journal, and "rebuild" on startup is a directory read.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdirWithRetry } from "./util.mjs";

const SUBDIR = ".downloadx";
const STATE_FILE = "state.json";
const SEGMENT_DIR = "segments";
/**
 * Consecutive failed resume attempts, kept beside the segment records.
 *
 * Not a new top-level artefact: the counter lives INSIDE the transfer's own
 * journal (`<target>.downloadx/resume-failures.json`) so it shares the
 * journal's lifecycle exactly — see the downloader's RESUME_FAILURE_BUDGET
 * for the policy that reads and writes it.
 */
const RESUME_FAILURES_FILE = "resume-failures.json";

/**
 * Suffix of the file a ranged transfer is still writing.
 *
 * Distinct from the streaming path's ".partial" on purpose: the two strategies
 * must never mistake one another's work in progress for their own.
 */
export const STAGING_SUFFIX = ".downloadx-part";

export class TransferStore {
  /**
   * @param {string} targetPath the path the finished file must appear at
   * @param {{ writePath?: string }} [opts]
   *   Where the bytes are actually written. Defaults to targetPath, for callers
   *   that own that path outright. The segmented engine passes a staging path
   *   instead, so that an unfinished, cancelled or crashed transfer is never
   *   sitting at the final path looking finished.
   */
  constructor(targetPath, opts = {}) {
    this.targetPath = targetPath;
    this.writePath = opts.writePath ?? targetPath;
    // The journal is named after the *requested* path, not the write path:
    // it describes the transfer, and a resume must find it across runs.
    this.dir = `${targetPath}${SUBDIR.startsWith(".") ? "" : "-"}${SUBDIR}`;
    this.segmentDir = path.join(this.dir, SEGMENT_DIR);
    this.statePath = path.join(this.dir, STATE_FILE);
  }

  /** Is the file being written somewhere other than its final path? */
  get staged() {
    return this.writePath !== this.targetPath;
  }

  async init() {
    await mkdirWithRetry(this.segmentDir);
  }

  segmentFile(index) {
    return path.join(this.segmentDir, `${String(index).padStart(5, "0")}.json`);
  }

  /** Write JSON via write-temp-then-rename so a crash never leaves a torn file. */
  static async atomicWrite(file, obj) {
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(obj), "utf8");
    await fsp.rename(tmp, file);
  }

  async saveState(state) {
    await TransferStore.atomicWrite(this.statePath, state);
  }

  async loadState() {
    try {
      return JSON.parse(await fsp.readFile(this.statePath, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      return null; // a damaged state file must not block a fresh attempt
    }
  }

  async saveSegment(seg) {
    await TransferStore.atomicWrite(this.segmentFile(seg.index), seg);
  }

  /** Read every segment record; unreadable ones are treated as absent. */
  async loadSegments() {
    let names = [];
    try {
      names = await fsp.readdir(this.segmentDir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(await fsp.readFile(path.join(this.segmentDir, name), "utf8")));
      } catch { /* treat as missing */ }
    }
    return out.sort((a, b) => a.index - b.index);
  }

  /**
   * Consecutive failed resume attempts recorded in this journal (0 when none).
   *
   * Storage and recovery semantics: the record is a file inside the segment
   * journal, written temp-then-rename like every other journal record, so a
   * crash can never leave a torn counter. It survives a daemon restart exactly
   * as long as the partial bytes it describes do, and it is removed together
   * with the journal by anything that resets the transfer to a fresh
   * generation — the engine's stale-revision (ETag / Last-Modified / size)
   * discard, a digest or coverage discard, a cancel, a successful transfer's
   * own cleanup, and the budget-exhausted discard itself. A fresh journal
   * therefore always starts counting from zero, and no state about one
   * download ever leaks into another.
   */
  async loadResumeFailures() {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(this.dir, RESUME_FAILURES_FILE), "utf8"));
      const n = Number(raw && raw.failures);
      return Number.isInteger(n) && n > 0 ? n : 0;
    } catch {
      return 0;   // absent, damaged or never written: no budget consumed
    }
  }

  /**
   * Record one more failed resume attempt and return the new count.
   *
   * The last error is kept (bounded) so the daemon-log line at exhaustion can
   * name the actual failure instead of a generic one.
   */
  async recordResumeFailure(lastError = null) {
    const failures = (await this.loadResumeFailures()) + 1;
    // The engine has always created the journal by the time a resume can fail,
    // but init() is idempotent and keeps the record from ENOENT on a raced
    // discard.
    await this.init();
    await TransferStore.atomicWrite(path.join(this.dir, RESUME_FAILURES_FILE), {
      failures,
      lastError: lastError == null ? null : String(lastError).slice(0, 500),
      updatedAt: new Date().toISOString(),
    });
    return failures;
  }

  /** Clear the counter: a resume that succeeded starts the budget over. */
  async clearResumeFailures() {
    await fsp.rm(path.join(this.dir, RESUME_FAILURES_FILE), { force: true }).catch(() => { /* already gone */ });
  }

  /** Create or truncate the file being written so offsets can be written out of order. */
  /**
   * Ensure the write file exists at the right size, without destroying data.
   *
   * Opening with "w+" truncates on open, so a resume wiped every byte already
   * downloaded and then reported success after re-fetching the whole file.
   * An existing file is opened "r+" and only extended; a new one is created.
   *
   * This reserves the *transfer's* file (this.writePath), never the published
   * path: preallocating the published path to its full length is exactly what
   * made an unfinished transfer look complete, because the length was right
   * while the tail was still zeroes.
   */
  async prepareTarget(totalBytes) {
    await mkdirWithRetry(path.dirname(this.writePath));
    let handle;
    try {
      handle = await fsp.open(this.writePath, "r+");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      handle = await fsp.open(this.writePath, "w+");
    }
    try {
      if (totalBytes > 0) {
        const size = (await handle.stat()).size;
        // Only grow. Shrinking here would discard completed work, and the
        // caller already decided this transfer matches the stored plan.
        if (size < totalBytes) await handle.truncate(totalBytes);
      }
    } finally {
      await handle.close();
    }
  }

  /**
   * Move the finished file to its final path in one atomic step.
   *
   * This is the only place the published path is created or replaced, and it
   * runs after the caller has proved the content is complete. A rename cannot
   * leave a half-written file visible: either the old state is intact or the
   * completed file is in place.
   *
   * The rename itself is retried on Windows' transient sharing violations
   * (renameWithRetry below): a real-time virus scanner often still holds the
   * staging file open at the exact moment the last byte lands, and IDM's own
   * documentation records that window as a real-world boundary. The design is
   * unchanged — still one rename that either fully happens or does not — only
   * repeated while the OS reports the target momentarily locked.
   */
  async publish() {
    if (!this.staged) return;
    await renameWithRetry(this.writePath, this.targetPath);
  }

  async exists() {
    return fs.existsSync(this.targetPath);
  }

  /**
   * Remove every trace of the transfer.
   *
   * Removal is retried briefly: a worker can still be finishing a write when a
   * discard is requested, so the directory may momentarily contain a new entry.
   * Failing the transfer over that would turn a cleanup race into a
   * user-visible error.
   *
   * The target is removed only when it is a regular file. removeQuietly uses
   * `recursive: true`, so pointing it at a directory would delete that
   * directory and everything inside it: a download named after a folder the
   * user already had would silently destroy the folder's contents.
   */
  async discard(opts = {}) {
    // The target is removed by default because a caller discarding a transfer
    // also owns whatever is at that path. A staged transfer must not: a
    // pre-existing file there was never touched by this transfer, and deleting
    // it would destroy data the user already had.
    const removeTarget = opts.target !== false;
    await removeQuietly(this.dir);
    if (this.staged) await removeFileOnly(this.writePath);
    if (removeTarget) await removeFileOnly(this.targetPath);
  }

  async cleanup() {
    await removeQuietly(this.dir);
  }
}

/** Remove a path, retrying while a concurrent writer is still landing. */
async function removeQuietly(target) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fsp.rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err.code !== "ENOTEMPTY" && err.code !== "EBUSY" && err.code !== "EPERM") return;
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
    }
  }
}

/**
 * Rename with the same backoff removeQuietly uses (8 attempts, 40ms steps).
 *
 * Windows answers rename with EPERM/EBUSY/ENOTEMPTY when something still holds
 * one of the two paths open — most often a real-time virus scanner finishing
 * its scan of the staged file at the moment of assembly. Those violations are
 * transient: a short escalating wait rides them out instead of failing a
 * transfer whose bytes are already complete and verified.
 *
 * `rename` and `wait` are seams for tests; production uses the real fs rename
 * and a timer. Unlike removeQuietly this does not swallow the last error:
 * publish is the step that makes the download observable, so a permanent
 * failure must surface as a failed transfer, never as a success whose file
 * silently never appears.
 */
export async function renameWithRetry(from, to, { rename, wait } = {}) {
  const doRename = rename ?? ((a, b) => fsp.rename(a, b));
  const sleep = wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await doRename(from, to);
      return;
    } catch (err) {
      if (err.code !== "ENOTEMPTY" && err.code !== "EBUSY" && err.code !== "EPERM") throw err;
      last = err;
      await sleep(40 * (attempt + 1));
    }
  }
  throw last;
}

/**
 * Remove a path only when it is a regular file.
 *
 * A directory or a symlink is left untouched: the transfer must fail loudly
 * rather than delete something the user did not ask it to touch.
 */
async function removeFileOnly(target) {
  let st = null;
  try { st = await fsp.lstat(target); }
  catch { return; }            // nothing there
  if (!st.isFile()) return;    // never recursively delete a directory
  await removeQuietly(target);
}

/** Whole-file digest, streamed so memory stays flat on large files. */
export async function hashFile(file, algo = "sha256") {
  const h = createHash(algo);
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file);
    rs.on("data", (c) => h.update(c));
    rs.once("end", resolve);
    rs.once("error", reject);
  });
  return h.digest("hex");
}

export { SUBDIR };
