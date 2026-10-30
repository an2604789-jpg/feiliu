// yt-dlp integration: page-URL resolver + full-delegation engine (批-8).
//
// Two modes live here, one per problem the plain HTTP engine cannot solve:
//
//   * 解析器模式 (resolver) — a URL that probes as an HTML page (or whose
//     probe fails outright) may still be a video page. spawn
//     `yt-dlp -J --no-playlist <url>`, read the JSON, pick the direct link
//     the default "bestvideo*+bestaudio/best" expression resolves to, and
//     hand it back to downloader.mjs, which re-runs its existing HTTP engine
//     against that link. The engine stays yt-dlp-free; yt-dlp only answers
//     "what is the real file behind this page".
//
//   * 全程委托 (full delegation) — when the direct link itself fails after
//     retries are exhausted, the whole job goes to
//     `yt-dlp --newline -o "<staging>/<title>.%(ext)s" --no-playlist`:
//     console progress lines are parsed into the same progress frames every
//     other engine emits, cancel is a process-tree kill, and the finished
//     artefact lands under the existing rename policy. This is runBt's shape
//     (src/bt.mjs) for a second external binary; the orchestration helpers
//     (killTree, commandFor, moveTo family) are copied from there, not
//     imported, because src/bt.mjs is aria2c's module and must not grow a
//     second engine's concerns.
//
// The binary is optional and discovered on demand (findFfmpeg/findAria2c
// pattern): an explicit Settings path first, then PATH, then the packaged
// binary in the app root. Missing means an honest human-readable failure —
// never an empty error (the P-3 rule) — plus, when the user has opted in via
// Settings (ytdlpAutoDownload, default false), a one-time download of the
// official release binary into the app root.

import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { requestFollow, readBodyToFile, abortError } from "./net.mjs";
import { SUBDIR as StoreSubdir } from "./store.mjs";
import { ACTIVE } from "./task.mjs";
import { mkdirWithRetry, sanitizeName } from "./util.mjs";

/** What a user sees when yt-dlp is not installed and a page needs it. */
export const NO_YTDLP_MESSAGE =
  "网页视频解析需要 yt-dlp 支持:安装 yt-dlp(github.com/yt-dlp/yt-dlp releases)" +
  "或在设置中指定 yt-dlp 路径,或在设置中开启自动下载 yt-dlp(ytdlpAutoDownload)";

/**
 * Official release the optional auto-download fetches from.
 *
 * Read at CALL time, not import time: DOWNLOADX_YTDLP_RELEASE_BASE is a
 * mirror/test seam, and tests (and forks) set it per run — a module-load
 * constant would freeze the first value the process ever saw.
 */
function releaseBase() {
  return process.env.DOWNLOADX_YTDLP_RELEASE_BASE ||
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";
}

/**
 * The app root: src's parent directory, where a packaged yt-dlp binary ships.
 *
 * DOWNLOADX_APPROOT overrides it — a packaging/test seam, same spirit as
 * DOWNLOADX_HOME for the data root. Tests point it at a temp dir so the
 * regression never writes a (fake) binary into the real project root.
 */
function appRoot() {
  if (process.env.DOWNLOADX_APPROOT) return path.resolve(process.env.DOWNLOADX_APPROOT);
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

/** The ambient binary name (what PATH lookups and package managers use). */
function ytDlpBinName() {
  return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

/**
 * The release asset name for this platform, and the packaged root name.
 *
 * Exported so the tests derive their expectations from it instead of
 * hardcoding per-platform filenames (第6项:不要按平台写死 yt-dlp.exe /
 * yt-dlp_linux); the body and every call site stay unchanged.
 */
export function ytDlpAssetName() {
  return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp_linux";
}

let cachedPath = null;
let probed = false;
let autoDownloadTried = false;
let autoDownloadError = null;

/**
 * X_OK probe for one candidate path.
 *
 * Node maps fs.constants.X_OK to plain existence (F_OK) on Windows and to the
 * real execute permission on POSIX — exactly the split this module needs:
 * on Windows every existing file "is executable", on POSIX the exec bit is
 * judged honestly (the 2a self-heal in findYtDlp keys off this).
 */
async function executableOk(p) {
  try { await fsp.access(p, fs.constants.X_OK); return true; } catch { return false; }
}

/**
 * Locate a yt-dlp executable, producing no side effects except one: a
 * candidate that exists but is not executable gets a one-time 0o755 heal
 * (2a), so copies downloaded before the post-download chmod existed become
 * usable without a manual delete.
 *
 * Order is fixed by the batch-8 spec: the caller's explicit setting
 * (config.ytdlpPath) first, then every PATH entry, then the app root. An
 * explicit value that does not resolve keeps the search going (the spec's
 * arrow order is a search order, unlike findAria2c where the explicit path is
 * authoritative); the ambient search is cached after its first run, like
 * findFfmpeg in src/merge.mjs and findAria2c in src/bt.mjs.
 *
 * @param {string} [explicit] path from Settings; empty/undefined = search
 * @returns {Promise<string|null>} absolute path, or null when unavailable
 */
export async function findYtDlp(explicit) {
  const wanted = String(explicit || "").trim();
  if (wanted) {
    try { await fsp.access(wanted); return wanted; } catch { /* keep searching */ }
  }
  if (probed) return cachedPath;
  const exe = ytDlpBinName();
  const candidates = [];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }
  const root = appRoot();
  candidates.push(path.join(root, ytDlpAssetName()));
  // A non-Windows packaging may also ship the generic name; the release asset
  // name above stays the documented form.
  if (process.platform !== "win32") candidates.push(path.join(root, "yt-dlp"));
  for (const c of candidates) {
    try {
      if (!existsSync(c)) continue;
      // 2a 旧副本自愈:自动下载曾有不含执行位的落盘版本,一个"存在但不可
      // 执行"的候选补一次 0o755 后重验,而不是把一个 spawn 必然 EACCES 的
      // 路径交回给调用方。Windows 上 X_OK 退化为存在性检查(见下),这条
      // 自愈路径只在 POSIX 上真正触发。
      if (await executableOk(c)) { cachedPath = c; break; }
      try {
        await fsp.chmod(c, 0o755);
        if (await executableOk(c)) { cachedPath = c; break; }
      } catch { /* 无权修改或重验仍不过:继续找下一个候选 */ }
    } catch { /* keep looking */ }
  }
  probed = true;
  return cachedPath;
}

/** Test seam: forget the cached ambient probe and the auto-download memory. */
export function resetYtDlpCache() {
  cachedPath = null;
  probed = false;
  autoDownloadTried = false;
  versionCache.clear();
}

/** The recorded reason the last auto-download attempt failed, if it did. */
export function lastAutoDownloadError() {
  return autoDownloadError;
}

/**
 * The binary's own version string (`yt-dlp --version`), cached per path.
 *
 * Serves /api/status's capabilities.ytdlp for the settings badge (批-8 包2's
 * data source). A version probe is a subprocess, so the answer is remembered
 * for the process lifetime per resolved path — a config path change or an
 * auto-download install (different path) probes fresh; status polling stays
 * spawn-free after the first call. Any failure is an honest empty string:
 * the badge then says 已找到 without a version, never a lie.
 */
const versionCache = new Map();
export async function ytDlpVersion(binPath) {
  const key = String(binPath || "");
  if (!key) return "";
  if (versionCache.has(key)) return versionCache.get(key);
  let version = "";
  try {
    version = await new Promise((resolve) => {
      let settled = false;
      let out = "";
      const { cmd, preArgs } = commandFor(key);
      const child = spawn(cmd, [...preArgs, "--version"], {
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      // The probe may not hold a status call hostage: a hung binary dies by
      // tree-kill and reports "unknown".
      const timer = setTimeout(() => {
        killTree(child.pid).catch(() => {});
        finish("");
      }, 10_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c) => { out += c; });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", () => { /* version never speaks here */ });
      child.on("error", () => finish(""));
      child.on("close", (code) => finish(code === 0 ? (out.trim().split(/\r?\n/)[0] || "") : ""));
    });
  } catch {
    version = "";
  }
  versionCache.set(key, version);
  return version;
}

/**
 * Download the official yt-dlp release binary into the app root.
 *
 * Streams via the existing net.mjs requestFollow (P-10's streaming-to-disk
 * discipline: the body never sits in memory), writes to a .tmp sibling and
 * renames — a half-downloaded binary must never be discoverable as a real
 * one. A body smaller than 1 KiB is an error page or a stub, not a binary.
 *
 * @returns {Promise<string>} the installed binary's absolute path
 */
export async function downloadYtDlp({ signal } = {}) {
  const name = ytDlpAssetName();
  const url = releaseBase() + name;
  const dest = path.join(appRoot(), name);
  const tmp = dest + ".tmp";
  await mkdirWithRetry(appRoot());
  const res = await requestFollow(url, { signal, timeoutMs: 120_000 });
  const fh = await fsp.open(tmp, "w");
  let written;
  try {
    written = await readBodyToFile(res, fh, { signal });
  } finally {
    await fh.close();
  }
  if (written < 1024) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw new Error("下载的 yt-dlp 文件只有 " + written + " B,不是有效二进制(" + url + ")");
  }
  await fsp.rename(tmp, dest);
  // 2a:Linux 的 release 产物(PyInstaller ELF)不自带执行位,下载完成后补
  // 0o755,否则 spawn 直接 EACCES。Windows 上 chmod 只能翻只读位,无害;
  // 万一在怪异文件系统上失败,findYtDlp 的旧副本自愈会在下次探测时补上。
  try { await fsp.chmod(dest, 0o755); } catch { /* 不可改权限:留给自愈兜底 */ }
  return dest;
}

/**
 * Locate yt-dlp, optionally auto-downloading it when absent.
 *
 * The user-confirmation semantics live entirely in the flag: the download
 * only ever happens when the caller passes autoDownload=true, which
 * downloader.mjs derives from config.ytdlpAutoDownload — default false, so
 * nothing is fetched unless the user explicitly opted in (Settings). One
 * failed attempt is remembered for the process lifetime: a dead network must
 * not turn every queued task into a fresh multi-megabyte retry.
 *
 * @param {{ explicit?:string, autoDownload?:boolean, signal?:AbortSignal,
 *          onLog?:(message:string)=>void }} opts
 * @returns {Promise<string|null>} absolute path, or null when unavailable
 */
export async function ensureYtDlp({ explicit, autoDownload, signal, onLog } = {}) {
  let bin = await findYtDlp(explicit);
  if (bin) return bin;
  if (!autoDownload) return null;
  if (autoDownloadTried) return null;
  autoDownloadTried = true;
  try {
    onLog?.("未找到 yt-dlp,正在从官方发布地址下载到 " + appRoot() + " …");
    await downloadYtDlp({ signal });
    // The ambient probe cached its miss; re-search with the binary in place.
    resetYtDlpCache();
    bin = await findYtDlp(explicit);
    if (bin) {
      onLog?.("yt-dlp 自动下载完成:" + bin);
      return bin;
    }
    autoDownloadError = "下载完成但未能在 " + appRoot() + " 找到 " + ytDlpAssetName();
    onLog?.("yt-dlp 自动下载异常:" + autoDownloadError);
    return null;
  } catch (err) {
    autoDownloadError = String(err?.message || err);
    onLog?.("yt-dlp 自动下载失败:" + autoDownloadError);
    return null;
  }
}

/**
 * How to execute a resolved "yt-dlp" path — copied from src/bt.mjs:118.
 * A real installation is an .exe / POSIX binary and spawns directly; a
 * .mjs/.js path (the regression stand-in, or a user's wrapper) runs under
 * this process's Node; .cmd/.bat goes through cmd.exe. No shell:true anywhere.
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
 * Force-kill a process and everything it spawned — copied from src/bt.mjs:139.
 * A plain child.kill() on Windows terminates only the direct child; yt-dlp
 * (and ffmpeg, which it may have started for a merge) would survive as
 * orphans holding the staging files locked. taskkill /T walks the tree.
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

/**
 * 孤儿治理(第3项配套,纯函数):清理上一轮 daemon 崩溃时遗留的 detached
 * yt-dlp/ffmpeg 子进程。
 *
 * detached 之后子进程不再随 daemon 退出而被带走,唯一的回收点是下一次启动:
 * 每个委托子进程的 pid 都在 spawn 成功后写进了任务元数据(meta.ytdlpPid,
 * 经 queue 的 write-temp-then-rename 落盘),本函数按记录回收。
 *
 * 只动"我们记录了 pid 且任务非运行态"的条目:
 *   * meta.ytdlpPid 必须是正整数——这是本模块亲手 spawn 后记录的值;
 *   * 任务状态不是 connecting/downloading——运行中的任务的子进程是它自己
 *     的委托,归 AbortController 管不到这里;
 * 探活用 kill(pid,0):ESRCH = 已死(只清字段),EPERM = 活着但非本用户,
 * 也按活着处理。活着就杀:POSIX SIGKILL(经 killTree,连进程组一起),
 * Windows taskkill /T /F。清理后删掉 meta.ytdlpPid 字段并返回报告;落盘由
 * 调用方负责(daemon 启动钩子拿 queue.saveNow() 收尾)。
 *
 * @param {Iterable<object>} tasks 任务记录(通常 queue.tasks.values());
 *   记录对象会被原地修改(删 meta.ytdlpPid)。
 * @returns {Promise<{scanned:number, probed:number, killed:number[],
 *                    cleared:Array<string|null>}>}
 */
export async function reconcileOrphans(tasks) {
  const report = { scanned: 0, probed: 0, killed: [], cleared: [] };
  const list = tasks instanceof Map ? [...tasks.values()]
    : (tasks && typeof tasks[Symbol.iterator] === "function") ? [...tasks] : [];
  for (const t of list) {
    report.scanned++;
    const pid = t?.meta?.ytdlpPid;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (t?.status && ACTIVE.has(t.status)) continue;   // 运行中:不是孤儿
    report.probed++;
    let alive = false;
    try { process.kill(pid, 0); alive = true; }
    catch (err) { alive = err?.code === "EPERM"; }
    if (alive) {
      await killTree(pid);
      report.killed.push(pid);
    }
    try {
      if (t.meta && typeof t.meta === "object") delete t.meta.ytdlpPid;
    } catch { /* 冻结对象:字段清不掉也不影响杀进程 */ }
    report.cleared.push(t?.id ?? null);
  }
  return report;
}

// ---------------------------------------------------------------------------
// Resolution (-J)

const isHttpUrl = (u) => /^https?:\/\//i.test(String(u || ""));

/** Normalize one yt-dlp format entry; only http(s) direct links survive. */
function normalizeFormat(f) {
  if (!f || typeof f !== "object") return null;
  const url = typeof f.url === "string" ? f.url : "";
  if (!isHttpUrl(url)) return null;
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    formatId: f.format_id ?? null,
    url,
    ext: typeof f.ext === "string" ? f.ext : null,
    height: num(f.height),
    vcodec: typeof f.vcodec === "string" ? f.vcodec : null,
    acodec: typeof f.acodec === "string" ? f.acodec : null,
    protocol: typeof f.protocol === "string" ? f.protocol : null,
    filesize: num(f.filesize) ?? num(f.filesize_approx),
    abr: num(f.abr),
  };
}

/**
 * Can our plain HTTP engine fetch this format as a file?
 * Manifest protocols (HLS/DASH) and .m3u8 URLs point at playlists, not
 * bodies — downloading them would publish a text file as if it were media.
 */
function isDirectHttpFormat(f) {
  if (!f || !isHttpUrl(f.url)) return false;
  const proto = String(f.protocol || "https").toLowerCase();
  if (proto.startsWith("m3u8") || proto.startsWith("dash") || proto.startsWith("rtmp")) return false;
  if (/\.m3u8($|\?)/i.test(f.url)) return false;
  return true;
}

/** Shape the -J JSON into the fields this module's callers consume. */
function normalizeMediaInfo(obj) {
  if (!obj || typeof obj !== "object") throw new Error("yt-dlp 输出为空");
  // --no-playlist normally yields one entry; a playlist-shaped answer still
  // carries a first usable entry, which is the one we take.
  let entry = obj;
  if (obj._type === "playlist" && Array.isArray(obj.entries)) {
    entry = obj.entries.find((e) => e && typeof e === "object") || null;
    if (!entry) throw new Error("yt-dlp 返回的播放列表没有可用条目");
  }
  const formats = [];
  const pushAll = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const f of arr) {
      const n = normalizeFormat(f);
      if (n) formats.push(n);
    }
  };
  pushAll(entry.formats);
  if (formats.length === 0) {
    const self = normalizeFormat(entry);
    if (self) formats.push(self);
  }
  const requestedFormats = Array.isArray(entry.requested_formats)
    ? entry.requested_formats.map(normalizeFormat).filter(Boolean)
    : [];
  return {
    id: entry.id ?? null,
    title: typeof entry.title === "string" ? entry.title : "",
    extractor: typeof entry.extractor === "string" ? entry.extractor
      : (typeof obj.extractor === "string" ? obj.extractor : null),
    extractorKey: typeof entry.extractor_key === "string" ? entry.extractor_key : null,
    duration: Number.isFinite(entry.duration) ? entry.duration : null,
    ext: typeof entry.ext === "string" ? entry.ext : null,
    // Top-level url exists exactly when yt-dlp's own default selection
    // ("bestvideo*+bestaudio/best") resolved to a SINGLE file.
    url: typeof entry.url === "string" ? entry.url : null,
    height: Number.isFinite(entry.height) ? entry.height : null,
    vcodec: typeof entry.vcodec === "string" ? entry.vcodec : null,
    acodec: typeof entry.acodec === "string" ? entry.acodec : null,
    protocol: typeof entry.protocol === "string" ? entry.protocol : null,
    formatId: entry.format_id ?? null,
    httpHeaders: entry.http_headers && typeof entry.http_headers === "object"
      ? { ...entry.http_headers }
      : {},
    formats,
    requestedFormats,
  };
}

const byHeightDesc = (a, b) =>
  (b.height ?? -1) - (a.height ?? -1) || (b.filesize ?? 0) - (a.filesize ?? 0);

/**
 * Pick the ONE format our direct-link engine will download — the single-file
 * mapping of yt-dlp's default "bestvideo*+bestaudio/best":
 *
 *   1. yt-dlp's own default selection already produced a single http(s) file
 *      (top-level url): that IS the expression's /best arm — take it.
 *   2. The selection asked for a video+audio pair (requested_formats), which
 *      a single direct link cannot deliver: fall back to the best single file
 *      that carries BOTH streams (the same fallback yt-dlp itself uses when
 *      it cannot merge). Best = highest height.
 *   3. No such file exists (the source is DASH-only): take the best video
 *      stream and say plainly in the note that the direct link carries no
 *      audio — the full-delegation fallback is the path to a merged file.
 *
 * @returns {{url:string, ext:string|null, height:number|null,
 *            formatId:string|null, vcodec:string|null, acodec:string|null,
 *            protocol:string|null, note:string|null}} picked
 */
export function pickFormat(info) {
  const top = {
    formatId: info.formatId, url: info.url, ext: info.ext, height: info.height,
    vcodec: info.vcodec, acodec: info.acodec, protocol: info.protocol,
  };
  if (isDirectHttpFormat(top)) return { ...top, note: null };

  const usable = info.formats.filter(isDirectHttpFormat);
  const progressive = usable
    .filter((f) => f.vcodec !== "none" && f.acodec !== "none")
    .sort(byHeightDesc)[0];
  if (progressive) {
    return { ...progressive, note: "该源音视频分离,已选择包含音轨的单文件直链" };
  }
  const video = usable.filter((f) => f.vcodec !== "none").sort(byHeightDesc)[0];
  if (video) {
    return { ...video, note: "该源音视频分离且无音视频合一的直链,此直链仅含视频画面(无音轨);完整文件由全程委托兜底产出" };
  }
  const audio = usable.filter((f) => f.acodec !== "none")
    .sort((a, b) => (b.abr ?? b.filesize ?? 0) - (a.abr ?? a.filesize ?? 0))[0];
  if (audio) {
    return { ...audio, note: "该源仅有音频可直链下载,此直链仅含音轨" };
  }
  throw new Error("yt-dlp 未返回可用的 http(s) 直链格式");
}

/**
 * The top `n` formats by height, for the GUI's quality display (批-8 spec:
 * put the first 5 into task.meta).
 */
export function topFormats(info, n = 5) {
  return [...info.formats]
    .sort(byHeightDesc)
    .slice(0, n);
}

/**
 * Resolve one URL with `yt-dlp -J --no-playlist` (60s budget by default).
 *
 * @param {string} binPath absolute yt-dlp path
 * @param {string} url the page/direct URL to inspect
 * @param {{signal?:AbortSignal, timeoutMs?:number}} [opts]
 * @returns {Promise<object>} normalized media info (see normalizeMediaInfo)
 */
export async function resolveMedia(binPath, url, { signal, timeoutMs = 60_000 } = {}) {
  if (signal?.aborted) throw abortError();
  const { cmd, preArgs } = commandFor(binPath);
  const argv = [...preArgs, "-J", "--no-playlist", url];

  const stdout = await new Promise((resolve, reject) => {
    let settled = false;
    let out = "";
    let errText = "";
    const child = spawn(cmd, argv, {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      // 第3项:detached 让子进程自成进程组——Linux 的 kill(-pid) 只对组长
      // 有效,没有它杀树杀不到孙进程;Windows 走 taskkill /T(按父子关系
      // 杀树),不需要 detached。
      detached: process.platform !== "win32",
    });

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(value);
    };
    // The budget is the spawn's lifetime: a hung extractor dies by tree-kill,
    // so no orphan keeps the pipe open after the caller gave up.
    const timer = setTimeout(() => {
      killTree(child.pid).catch(() => {});
      finish(new Error("yt-dlp 解析超时（" + Math.round(timeoutMs / 1000) + "s）"));
    }, timeoutMs);
    const onAbort = () => {
      killTree(child.pid).catch(() => {});
      finish(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { errText += c; });
    child.on("error", (err) => {
      // The binary vanished between discovery and spawn (or is not
      // executable): the same "yt-dlp unavailable" situation.
      finish(err?.code === "ENOENT" ? new Error(NO_YTDLP_MESSAGE) : err);
    });
    child.on("close", (code, signalName) => {
      if (signal?.aborted) { finish(abortError()); return; }
      if (code !== 0) {
        const tail = (errText || out).trim().split(/\r?\n/).filter(Boolean)
          .slice(-6).join(" | ").slice(0, 400);
        finish(new Error(
          "yt-dlp 退出码 " + (code === null ? "signal " + signalName : code) +
          (tail ? "：" + tail : "")
        ));
        return;
      }
      finish(null, out);
    });
  });

  let obj;
  try {
    obj = JSON.parse(stdout);
  } catch {
    throw new Error("yt-dlp -J 输出不是合法 JSON（开头: " + stdout.trim().slice(0, 120) + "）");
  }
  return normalizeMediaInfo(obj);
}

// ---------------------------------------------------------------------------
// Full delegation (--newline download)

/**
 * Parse one `yt-dlp --newline` progress line into a progress frame.
 *
 * Known totals:  `[download]  42.3% of    5.83MiB at    1.20MiB/s ETA 00:03`
 * Estimated:     `[download]  42.3% of ~  10.00MiB at    1.20MiB/s ETA 00:03`
 * Unknown total: `[download] 2.53MiB at    1.05MiB/s ETA 00:05`
 *
 * The percentage is yt-dlp's own accounting of a moving download, so every
 * frame it produces is marked approximate by the caller (约 x%), the same
 * contract the aria2c delegate follows.
 *
 * @returns {{percent:number|null, bytesWritten:number|null,
 *            totalBytes:number|null, speed:number}|null} null when the line
 *          carries no progress numbers (Destination/Merger/… lines)
 */
export function parseYtdlpProgress(line) {
  const m = /^\[download\]\s+(.*)$/.exec(String(line).trim());
  if (!m) return null;
  const body = m[1];
  const unit = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
  const bytesOf = (n, u) => Math.round(Number(n) * unit[u]);
  const total = /of\s+(~?)\s*([\d.]+)\s*(B|KiB|MiB|GiB|TiB)/.exec(body);
  const totalBytes = total ? bytesOf(total[2], total[3]) : null;
  const speedM = /at\s+([\d.]+)\s*(B|KiB|MiB|GiB|TiB)\/s/.exec(body);
  const speed = speedM ? bytesOf(speedM[1], speedM[2]) : 0;
  const pct = /^([\d.]+)%/.exec(body);
  let percent = null;
  let bytesWritten = null;
  if (pct) {
    percent = Number(pct[1]);
    if (totalBytes !== null) bytesWritten = Math.round(totalBytes * percent / 100);
  } else {
    const plain = /^([\d.]+)\s*(B|KiB|MiB|GiB|TiB)(?:\s|$)/.exec(body);
    if (plain) bytesWritten = bytesOf(plain[1], plain[2]);
  }
  if (percent === null && bytesWritten === null) return null;
  return { percent, bytesWritten, totalBytes, speed };
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
 * Run one full delegation: yt-dlp does the extraction AND the download.
 *
 * Called from downloader.mjs when the direct link produced by a successful
 * resolve failed with its retries exhausted (and for tasks that declare
 * kind "ytdlp" explicitly). The orchestration mirrors runBt (src/bt.mjs):
 *
 *   * reserveTarget() applies the overwrite policy, the per-path FIFO lock
 *     and the claim registry, so a delegated task collides with — and yields
 *     to — every other task by the same rules as an HTTP one;
 *   * the staging area lives at <target>.downloadx/ytdlp-stage, inside the
 *     journal family the existing cancel path already discards;
 *   * cancel kills the whole process tree (yt-dlp may have spawned ffmpeg);
 *     abort/pause semantics match the BT delegate: the staging family is
 *     kept for a retry, api.mjs's cancel discards it.
 *
 * @param {{downloader:object, task:object, controller:AbortController,
 *          progressCb:Function, resolveInfo?:object|null}} opts
 * @returns {Promise<{ok:boolean, bytes:number, target:string, filename:string,
 *                    dir:string, category:string|null, sha256:string|null,
 *                    downgraded:boolean, retries:number, elapsedMs:number,
 *                    meta:object}>}
 */
export async function runYtDlp({ downloader, task, controller, progressCb, resolveInfo = null }) {
  const signal = controller.signal;
  const started = Date.now();

  // The fallback chain hands over the binary it already ensured; an explicit
  // kind="ytdlp" task discovers (or auto-downloads) its own.
  let bin = resolveInfo?.bin || null;
  if (!bin) {
    bin = await ensureYtDlp({
      explicit: String(downloader.config.get("ytdlpPath") || "").trim(),
      autoDownload: downloader.config.get("ytdlpAutoDownload") === true,
      signal,
      onLog: (m) => downloader.emit("log", { taskId: task.id, message: m }),
    });
    if (!bin) throw new Error(NO_YTDLP_MESSAGE);
  }
  if (signal.aborted) throw abortError();

  // The chain also hands over its resolve result; an explicit kind resolves
  // here. Either way title/ext name the reserved output.
  let info = resolveInfo?.info || null;
  let picked = resolveInfo?.picked || null;
  if (!info) {
    info = await resolveMedia(bin, task.url, { signal });
    picked = pickFormat(info);
  }
  const title = sanitizeName(info.title || "", "yt-dlp-download");
  const ext = picked?.ext || info.ext || "mp4";
  // An explicit task filename (API/CLI caller) wins; the auto-derived name is
  // the resolved title plus the picked extension.
  const filename = task.filename
    ? sanitizeName(task.filename, "download.bin")
    : sanitizeName(`${title}.${ext}`, "yt-dlp-download");

  const reserved = await downloader.reserveTarget({ ...task, signal, filename });
  const { target, dir, category, release } = reserved;
  try {
    downloader.emit("resolved", {
      taskId: task.id, target, filename: path.basename(target), dir, category,
      kind: "ytdlp", totalBytes: null,
    });
    downloader.emit("log", {
      taskId: task.id,
      message: "yt-dlp: 已委托全程下载 " + task.url + "（外部引擎 " + path.basename(bin) + "）",
    });

    // Staging inside the journal family: same volume as the target (rename,
    // not copy) and cleaned by the existing cancel path.
    const stage = path.join(target + StoreSubdir, "ytdlp-stage");
    await mkdirWithRetry(stage);

    const outTemplate = path.join(stage, title + ".%(ext)s");
    const args = ["--newline", "--no-playlist", "-o", outTemplate];
    // Same courtesy as the BT delegate (P-10): forward the decided proxy so
    // yt-dlp never silently follows an ambient env proxy instead of ours.
    const proxy = String(task.proxy || "").trim();
    if (proxy) args.push("--proxy", proxy);
    args.push(task.url);

    const { cmd, preArgs } = commandFor(bin);
    // For .cmd wrappers the whole command travels as one /c argument.
    const argv = preArgs.length === 3 && preArgs[2] === "/c"
      ? [...preArgs.slice(0, 2), `"${bin}" ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`]
      : [...preArgs, ...args];

    let stdoutTail = [];
    let stderrTail = [];

    await new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(cmd, argv, {
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        // 第3项:detached 让子进程自成进程组——Linux 的 kill(-pid) 只对
        // 组长有效,没有它杀树杀不到孙进程;Windows 走 taskkill /T(按父子
        // 关系杀树),不需要 detached。
        detached: process.platform !== "win32",
      });
      // 第3项配套:spawn 成功后把 pid 记进任务元数据。落盘走 queue 的现有
      // 持久化(apply → 400ms 防抖 save → write-temp-then-rename 写
      // queue.json),daemon 崩溃后启动时的 reconcileOrphans 由此找到上一轮
      // detached 的孤儿;任务到终态(完成/失败/取消)在下面的 finally 清字段。
      try {
        const q = downloader?.queue;
        if (q && typeof q.apply === "function" && task?.id) {
          q.apply(task.id, {
            meta: { ...(q.get?.(task.id)?.meta || task.meta || {}), ytdlpPid: child.pid },
          });
        }
      } catch { /* 元数据是尽力而为:不能因此打断下载 */ }

      const keep = (arr, chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;
          arr.push(t);
          if (arr.length > 40) arr.shift();
        }
      };
      const emitProgress = (t) => {
        const p = parseYtdlpProgress(t);
        if (!p) return;
        progressCb({
          totalBytes: p.totalBytes,
          bytesWritten: p.bytesWritten ?? 0,
          speed: p.speed,
          percent: p.percent,
          lengthKnown: p.totalBytes !== null,
          // yt-dlp's percentage is its own running accounting of a moving
          // target; the UI must be able to say "约 42%", never promise it.
          approx: true,
          percentNote: p.percent !== null ? `约 ${Math.floor(p.percent)}%` : null,
        });
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
          emitProgress(t);
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
        const e = err?.code === "ENOENT" ? new Error(NO_YTDLP_MESSAGE) : err;
        finish(e);
      });
      child.on("close", (code, signalName) => {
        // Same channel as the BT delegate: the console tails ride every
        // non-success exit as err.btTail, which #finalTaskError merges into
        // task.meta.tail — no downloader.mjs changes needed for that.
        const btTail = { stdout: [...stdoutTail], stderr: [...stderrTail] };
        if (signal.aborted) {
          const e = abortError();
          e.btTail = btTail;
          finish(e);
          return;
        }
        if (code === 0) {
          finish(null, { code: 0 });
          return;
        }
        const tail = [...stdoutTail, ...stderrTail].slice(-15).join(" | ");
        const err = new Error(
          "yt-dlp 委托失败（退出码 " + (code === null ? "signal " + signalName : code) + "）" +
          (tail ? "：" + tail : "：(无输出)")
        );
        err.btTail = btTail;
        finish(err);
      });
    });

    // Landing: whatever yt-dlp produced in the staging area moves onto the
    // reserved target under the policy that reserved it. Scratch suffixes
    // (.part/.ytdl/.temp) only survive a failed run; a successful one leaves
    // the finished artefact(s).
    const entries = (await fsp.readdir(stage, { withFileTypes: true }))
      .filter((e) => !/\.(part|ytdl|temp)$/i.test(e.name));
    if (entries.length === 0) {
      throw new Error("yt-dlp 报告成功但产物目录为空");
    }

    let landed = target;
    let fileCount = 1;
    if (entries.length === 1) {
      await moveTo(path.join(stage, entries[0].name), target);
    } else {
      // Multiple artefacts (rare here, but playlists can yield them): the
      // reserved target becomes the folder holding the set, like runBt does.
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
    // engine cleans its journal — and with it any journal a failed direct
    // attempt left behind for this same target.
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
        engine: "yt-dlp",
        ytdlp: path.basename(bin),
        title: info.title || null,
        extractor: info.extractor || null,
        duration: info.duration ?? null,
        approx: true,
        // Why the direct link gave up, when this run is the fallback arm.
        directError: resolveInfo?.directError || null,
        pickedFormat: picked ? {
          formatId: picked.formatId, ext: picked.ext, height: picked.height,
          vcodec: picked.vcodec, acodec: picked.acodec, protocol: picked.protocol,
          note: picked.note,
        } : null,
        formats: topFormats(info, 5),
        sha256Note: isFile ? null : "多文件产物未计算汇总哈希",
      },
    };
  } finally {
    // 第3项配套:任务到终态(完成/失败/取消)清 pid 字段。取消走
    // queue.remove,任务已不在,get() 落空,自然跳过;这里删除的是活记录上
    // 的字段,再经 apply 走现有 write-temp-then-rename 持久化。仍留着 pid 的
    // 只有"daemon 本身崩了"一种情形——交给启动时的 reconcileOrphans。
    try {
      const q = downloader?.queue;
      const live = q?.get?.(task?.id);
      if (q && live?.meta && typeof live.meta === "object" && "ytdlpPid" in live.meta) {
        delete live.meta.ytdlpPid;
        q.apply(task.id, { meta: live.meta });
      }
    } catch { /* 元数据是尽力而为 */ }
    release();
  }
}
