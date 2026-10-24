// Magnet / BitTorrent downloads, delegated to an external aria2c.
//
// The core engine deliberately contains zero BT code (路线定稿 2026-10-24):
// speaking DHT/PEX/trackers is a project of its own, and aria2 already does it
// better than a from-scratch implementation ever would on this budget. The
// relationship is the same one ffmpeg has in merge.mjs — an optional external
// binary, probed on demand, missing means an honest human-readable failure,
// never an empty error (P-3: magnet links used to die with a blank message).
//
// What lives here:
//   * findAria2c — config.aria2cPath first, then PATH, then the usual Windows
//     install locations (the findFfmpeg pattern from src/merge.mjs:20).
//   * runBt — one delegated transfer: spawn aria2c into a staging directory
//     beside the reserved target, parse its console summary into progress,
//     land the artefact(s) under the existing rename policy, hash the result.
//   * killTree — cancel is a process-tree kill (the daemonManager
//     forceKillTree idea, desktop/daemonManager.mjs:106, reimplemented here
//     so src/ never depends on desktop/ and no new package enters).
//
// Cancellation semantics match the rest of the downloader: abort kills the
// aria2c tree but LEAVES the staging directory (with aria2's own *.aria2
// control files), so a paused task resumes where it stopped — aria2 resumes
// natively from its control file. api.mjs's cancel (which discards the whole
// <target>.downloadx journal family) is the only path that deletes it, and it
// works unmodified because the staging directory lives inside that family.

import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

import { SUBDIR as StoreSubdir } from "./store.mjs";
import { mkdirWithRetry, sanitizeName } from "./util.mjs";

/** P-3's closing sentence: what a user sees when aria2c is not installed. */
export const NO_ARIA2C_MESSAGE =
  "磁力链接需要 aria2c 支持:安装 aria2(github.com/aria2/aria2 releases)" +
  "或在设置中指定 aria2c.exe 路径";

let cachedAria2c = null;
let aria2cProbed = false;

/** Where aria2 typically ends up when installed without configuration. */
function commonAria2cLocations() {
  if (process.platform === "win32") {
    return [
      process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "aria2", "aria2c.exe") : null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "aria2", "aria2c.exe") : null,
      process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "scoop", "shims", "aria2c.exe") : null,
      process.env.ProgramData ? path.join(process.env.ProgramData, "chocolatey", "bin", "aria2c.exe") : null,
    ].filter(Boolean);
  }
  return ["/usr/local/bin/aria2c", "/usr/bin/aria2c", "/opt/homebrew/bin/aria2c"];
}

/**
 * Locate an aria2c executable.
 *
 * Order: the caller's explicit setting (config.aria2cPath, or any absolute
 * path), then every PATH entry, then the common install locations. The
 * explicit value is checked fresh on every call — a user fixing the setting
 * in the GUI must not be served a stale negative — while the ambient search
 * is cached after its first run, like findFfmpeg in src/merge.mjs.
 *
 * @param {string} [explicit] path from Settings; empty/undefined = search
 * @returns {Promise<string|null>} absolute path, or null when unavailable
 */
export async function findAria2c(explicit) {
  const wanted = String(explicit || "").trim();
  if (wanted) {
    try { await fsp.access(wanted); return wanted; } catch { return null; }
  }
  if (aria2cProbed) return cachedAria2c;
  const exe = process.platform === "win32" ? "aria2c.exe" : "aria2c";
  const candidates = [];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }
  candidates.push(...commonAria2cLocations());
  for (const c of candidates) {
    try { if (existsSync(c)) { cachedAria2c = c; break; } } catch { /* keep looking */ }
  }
  aria2cProbed = true;
  return cachedAria2c;
}

/** Test seam: forget the cached ambient probe (config changes do not need it). */
export function resetAria2cCache() {
  cachedAria2c = null;
  aria2cProbed = false;
}

/**
 * How to execute the resolved "aria2c" path.
 *
 * A real installation is an .exe (or a POSIX binary) and spawns directly. A
 * path ending in .mjs/.js (what the regression suite uses as its stand-in,
 * and what a user with a wrapper script might point at) runs under the same
 * Node interpreter that is running this process; .cmd/.bat wrappers go
 * through cmd.exe. No shell:true anywhere, so no quoting surface.
 *
 * @returns {{cmd:string, preArgs:string[]}}
 */
function commandFor(binPath) {
  if (/\.(mjs|cjs|js)$/i.test(binPath)) return { cmd: process.execPath, preArgs: [binPath] };
  if (/\.(cmd|bat)$/i.test(binPath)) {
    // cmd's /s /c form takes ONE argument: quoted command followed by args.
    return { cmd: "cmd.exe", preArgs: ["/d", "/s", "/c"] };
  }
  return { cmd: binPath, preArgs: [] };
}

/**
 * Force-kill a process and everything it spawned.
 *
 * On Windows a plain child.kill() terminates only the direct child; aria2c
 * (and any helper it starts) would survive as orphans holding the staging
 * files locked. taskkill /T walks the tree; /F is forceful — this is only
 * ever called after the abort already decided the transfer is over, so there
 * is nothing graceful left to wait for. POSIX: the process group first, then
 * the pid, both best-effort.
 *
 * Only pids of processes WE spawned in this transfer are ever passed here.
 */
function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
      return;
    }
    try { process.kill(-pid, "SIGKILL"); } catch { /* no group / already gone */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    resolve();
  });
}

/** aria2 binary unit -> bytes ("MiB", "KiB", "B", ...). */
function unitBytes(unit) {
  switch (String(unit || "B").toUpperCase()) {
    case "KIB": return 1024;
    case "MIB": return 1024 ** 2;
    case "GIB": return 1024 ** 3;
    case "TIB": return 1024 ** 4;
    default: return 1;
  }
}

/**
 * Parse one aria2 console summary line into progress.
 *
 * With --summary-interval=1 aria2 prints a bracket line every second:
 *
 *   [#8c1a2b 12MiB/230MiB(5%) CN:8 DL:1.1MiB ETA:3m2s]
 *
 * Before the metadata is fetched the totals are unknown and the line looks
 * like "[#8c1a2b 0B/0B CN:5 DL:0B]" — no percentage segment, and none is
 * invented (the same rule the streaming HTTP path follows).
 *
 * The percentage is aria2's own accounting of a still-moving download, so it
 * is marked approximate everywhere it surfaces (approx / percentNote).
 *
 * @returns {{bytesWritten:number, totalBytes:number|null, percent:number|null,
 *            speed:number}|null} null when the line is not a summary
 */
export function parseAria2Summary(line) {
  const m = /^\[#([0-9a-fA-F]*)\s+(.*)\]\s*$/.exec(String(line).trim());
  if (!m) return null;
  const body = m[2];
  const frac = /^([\d.]+)(B|KiB|MiB|GiB|TiB)\/([\d.]+)(B|KiB|MiB|GiB|TiB)(?:\((\d+)%\))?/.exec(body);
  if (!frac) return null;
  const bytesWritten = Number(frac[1]) * unitBytes(frac[2]);
  const totalBytes = Number(frac[3]) * unitBytes(frac[4]);
  const dl = /DL:([\d.]+)(B|KiB|MiB|GiB|TiB)/.exec(body);
  const speed = dl ? Number(dl[1]) * unitBytes(dl[2]) : 0;
  const known = totalBytes > 0;
  return {
    bytesWritten,
    totalBytes: known ? totalBytes : null,
    percent: known && frac[5] !== undefined ? Number(frac[5]) : null,
    speed,
  };
}

/** The display name a magnet URI carries (dn=), decoded, or "". */
function magnetDisplayName(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get("dn") || "";
  } catch {
    return "";
  }
}

/** The info hash of a magnet URI (xt=urn:btih:...), or "". */
function magnetHash(url) {
  const m = /xt=urn:btih:([0-9a-zA-Z]+)/.exec(String(url));
  return m ? m[1] : "";
}

/**
 * The deterministic output name for a BT task, before aria2 reveals the
 * torrent's real contents: an explicit task.filename wins, then the magnet's
 * dn=, then a hash-derived name. For a .torrent URL the torrent file's own
 * basename (minus the extension) is the best available guess.
 */
function btFallbackName(task) {
  if (task.filename) return String(task.filename);
  const dn = magnetDisplayName(task.url);
  if (dn) return dn;
  const hash = magnetHash(task.url);
  if (hash) return "bt-" + hash.slice(0, 16);
  let base = "";
  try {
    const u = new URL(task.url);
    base = path.posix.basename(u.pathname).replace(/\.torrent$/i, "");
  } catch { base = ""; }
  return base || "bt-download";
}

/** rm with the same bounded retry store.mjs uses for locked Windows files. */
async function rmWithRetry(target) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fsp.rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err?.code !== "ENOTEMPTY" && err?.code !== "EBUSY" && err?.code !== "EPERM") return;
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
    }
  }
}

/** Copy a file or a whole tree (cross-volume fallback for rename). */
async function copyTree(src, dest) {
  const st = await fsp.lstat(src);
  if (st.isDirectory()) {
    await mkdirWithRetry(dest);
    for (const ent of await fsp.readdir(src, { withFileTypes: true })) {
      await copyTree(path.join(src, ent.name), path.join(dest, ent.name));
    }
    return;
  }
  await fsp.copyFile(src, dest);
}

/** Move src to dest, falling back to copy+remove across volumes. */
async function moveTo(src, dest) {
  try {
    await fsp.rename(src, dest);
    return;
  } catch (err) {
    if (err?.code !== "EXDEV" && err?.code !== "EPERM" && err?.code !== "EACCES") throw err;
  }
  await copyTree(src, dest);
  await rmWithRetry(src);
}

/** Recursive byte size of a landed artefact. */
async function treeSize(p) {
  const st = await fsp.lstat(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const ent of await fsp.readdir(p, { withFileTypes: true })) {
    total += await treeSize(path.join(p, ent.name));
  }
  return total;
}

/** sha256 of one file, streamed (the downloader's private hashFile pattern). */
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

/**
 * Run one BT/magnet transfer through aria2c.
 *
 * Called from Downloader.run()'s dispatch for kind "bt". The orchestration
 * intentionally reuses the downloader's own machinery instead of building a
 * parallel one:
 *
 *   * reserveTarget() applies the existing overwrite policy (rename / skip /
 *     overwrite), the per-path FIFO lock and the claim registry, so a BT
 *     task collides with — and yields to — every other task by the same
 *     rules as an HTTP one;
 *   * the staging area lives at <target>.downloadx/bt-stage, i.e. inside the
 *     journal family the cancel path already discards, so api.mjs's cancel
 *     cleans a BT task with no changes of its own;
 *   * aria2's *.aria2 control files inside the staging area ARE the resume
 *     state: abort (pause) keeps them, and the next run points aria2c at the
 *     same directory again.
 *
 * @param {{downloader:object, task:object, controller:AbortController,
 *          progressCb:Function}} opts
 * @returns {Promise<{ok:boolean, bytes:number, target:string, filename:string,
 *                    dir:string, category:string|null, sha256:string|null,
 *                    downgraded:boolean, retries:number, elapsedMs:number,
 *                    meta:object}>}
 */
export async function runBt({ downloader, task, controller, progressCb }) {
  const signal = controller.signal;
  const started = Date.now();

  const configured = String(downloader.config.get("aria2cPath") || "").trim();
  const aria2c = await findAria2c(configured || undefined);
  if (!aria2c) throw new Error(NO_ARIA2C_MESSAGE);
  if (signal.aborted) {
    const { abortError } = await import("./net.mjs");
    throw abortError();
  }

  // Resolve the output path under the existing policy. The name is the best
  // guess available before the torrent metadata arrives; what aria2 actually
  // produces is moved onto this reserved path at completion, so the policy
  // decision (and the claim registry entry) stays authoritative.
  const filename = sanitizeName(btFallbackName(task), "bt-download");
  const reserved = await downloader.reserveTarget({ ...task, signal, filename });
  const { target, dir, category, release } = reserved;
  try {
    downloader.emit("resolved", {
      taskId: task.id, target, filename: path.basename(target), dir, category,
      kind: "bt", totalBytes: null,
    });
    downloader.emit("log", {
      taskId: task.id,
      message: "BT: 已委托 aria2c 处理 " + task.url + "（外部引擎 " + path.basename(aria2c) + "）",
    });

    // Staging inside the journal family: same volume as the target (so the
    // landing is a rename, not a copy) and cleaned by the existing cancel
    // path (<target>.downloadx is in the plain-transfer output set).
    const stage = path.join(target + StoreSubdir, "bt-stage");
    await mkdirWithRetry(stage);

    const args = [
      "--dir=" + stage,
      "--console-log-level=notice",
      "--summary-interval=1",
      // The staging area is ours alone and starts consistent with the *.aria2
      // control files, so aria2 never needs its own second-level renaming.
      "--allow-overwrite=true",
      "--auto-file-renaming=false",
      // A download manager downloads; it does not park on the swarm seeding
      // after 100%. Zero seed time = the task completes when the file does.
      "--seed-time=0",
    ];
    const proxy = String(task.proxy || downloader.config.get("proxy") || "").trim();
    if (proxy) args.push("--all-proxy=" + proxy);
    args.push(task.url);

    const { cmd, preArgs } = commandFor(aria2c);
    // For .cmd wrappers the whole command travels as one /c argument.
    const argv = preArgs.length === 3 && preArgs[2] === "/c"
      ? [...preArgs.slice(0, 2), `"${aria2c}" ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`]
      : [...preArgs, ...args];

    let stdoutTail = [];
    let stderrTail = [];
    let completedNoticePath = null;

    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(cmd, argv, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const keep = (arr, chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;
          arr.push(t);
          if (arr.length > 40) arr.shift();
        }
      };
      let stdoutBuf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk;
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          keep(stdoutTail, t);
          const parsed = parseAria2Summary(t);
          if (parsed) {
            progressCb({
              totalBytes: parsed.totalBytes,
              bytesWritten: parsed.bytesWritten,
              speed: parsed.speed,
              percent: parsed.percent,
              lengthKnown: parsed.totalBytes !== null,
              // aria2's percentage is its own running accounting of a moving
              // target; the UI must be able to say "约 42%", never promise it.
              approx: true,
              percentNote: parsed.percent !== null ? `约 ${parsed.percent}%` : null,
            });
          } else {
            const done = /download completed:\s*(.+?)\s*$/.exec(t);
            if (done) completedNoticePath = done[1];
          }
        }
      });
      let stderrBuf = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderrBuf += chunk;
        const lines = stderrBuf.split(/\r?\n/);
        stderrBuf = lines.pop();
        keep(stderrTail, ...lines.map((l) => l.trim()).filter(Boolean));
      });

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve(value);
      };
      const onAbort = () => { killTree(child.pid).catch(() => {}); };
      signal.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        // The binary vanished between findAria2c and spawn (or is not
        // executable): that is the same "aria2c unavailable" situation.
        const e = err?.code === "ENOENT" ? new Error(NO_ARIA2C_MESSAGE) : err;
        finish(e);
      });
      child.on("close", (code, signalName) => {
        if (signal.aborted) {
          import("./net.mjs").then(({ abortError }) => finish(abortError())).catch(() => finish(new Error("aborted")));
          return;
        }
        if (code === 0) {
          finish(null, { code: 0 });
          return;
        }
        const tail = [...stdoutTail, ...stderrTail].slice(-15).join(" | ");
        finish(new Error(
          "aria2c 委托失败（退出码 " + (code === null ? "signal " + signalName : code) + "）" +
          (tail ? "：" + tail : "：(无输出)")
        ));
      });
    });

    // Landing: whatever aria2 produced in the staging area moves onto the
    // reserved target under the policy that reserved it.
    const entries = (await fsp.readdir(stage, { withFileTypes: true }))
      .filter((e) => !e.name.toLowerCase().endsWith(".aria2"));
    if (entries.length === 0) {
      throw new Error("aria2c 报告成功但产物目录为空" +
        (completedNoticePath ? "（声称完成于 " + completedNoticePath + "）" : ""));
    }

    let landed = target;
    let fileCount = 1;
    if (entries.length === 1) {
      await moveTo(path.join(stage, entries[0].name), target);
    } else {
      // A multi-file torrent: everything it produced is the artefact. The
      // reserved target becomes the folder that holds the whole set.
      await mkdirWithRetry(target);
      for (const e of entries) {
        await moveTo(path.join(stage, e.name), path.join(target, e.name));
      }
      fileCount = entries.length;
    }

    const bytes = await treeSize(landed);
    const isFile = fileCount === 1 && entries[0].isFile();
    const sha256 = isFile ? await hashFile(landed) : null;
    progressCb({ totalBytes: bytes, bytesWritten: bytes, speed: 0, percent: 100, lengthKnown: true });

    // Success cleans its own staging family, exactly like the segmented
    // engine cleans its journal. (A failure or an abort keeps it: the *.aria2
    // control files inside are what a retry or a resume continues from.)
    await rmWithRetry(target + StoreSubdir);

    return {
      ok: true,
      bytes,
      target: landed,
      filename: path.basename(landed),
      dir,
      category,
      sha256,
      downgraded: false,
      retries: 0,
      elapsedMs: Date.now() - started,
      meta: {
        engine: "aria2c",
        aria2c: path.basename(aria2c),
        fileCount,
        // Directory-shaped results are not hashed: summing a per-file hash
        // chain would look like a checksum and be nothing of the sort.
        sha256Note: isFile ? null : "多文件种子未计算汇总哈希",
        approx: true,
        result,
      },
    };
  } finally {
    release();
  }
}
