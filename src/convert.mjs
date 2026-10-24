// Format conversion via external ffmpeg, preset-only (批-4 W3).
//
// 路线定稿 2026-10-24:编解码永远交给 ffmpeg,自己写的只有安全封装。
// The design borrows two things from mature projects, patterns only — no
// dependency, no wheel:
//
//   * HandBrake 的"预设优先"哲学:预设是"为即时兼容性量身定制"的固定
//     参数组合,用户只选预设、绝不面对参数表单(参数表单=bug 农场)。
//     下面 PRESETS 的参数全部写死并逐条注释;调用方(kind:"convert" 的
//     任务)只携带 meta.preset 一个选择。
//   * fluent-ffmpeg 的教训:进度百分比是估算值且"可能非常不准"(官方
//     文档原话)。所以这里每一帧 percent 都带 approx:true /
//     percentNote:"约 N%",UI 只能说"约",不能承诺。
//
// What lives here (mirror of src/bt.mjs, the established delegation pattern):
//   * runConvert — one conversion task: reserve the output under the EXISTING
//     rename policy (Downloader.reserveTarget), spawn ffmpeg with
//     `-progress pipe:1`, parse the key=value blocks into progress, land the
//     artefact via 临时名→rename, hash it. Cancel = kill the process tree
//     (taskkill /T /F, the bt.mjs semantics), which abort/pause/cancel all
//     reach through the same AbortSignal every other strategy uses.
//   * The source file is an input, never an output: it is opened by ffmpeg
//     read-only, never moved, never deleted, never renamed over.
//
// Reused, not rebuilt: findFfmpeg + probeDuration from src/merge.mjs (the
// optional-binary convention: missing means an honest human-readable failure,
// never an empty error), mkdirWithRetry/sanitizeName from src/util.mjs, and
// the whole task lifecycle (queue states, retry, cancel cleanup) from
// Downloader.run()'s dispatch — a conversion is just a queued task.

import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

import { findFfmpeg, probeDuration } from "./merge.mjs";
import { SUBDIR as StoreSubdir } from "./store.mjs";
import { mkdirWithRetry, sanitizeName } from "./util.mjs";

/** What a user sees when ffmpeg is not installed (the P-3/bt.mjs precedent). */
export const NO_FFMPEG_MESSAGE =
  "格式转换需要 ffmpeg 支持:安装 ffmpeg(ffmpeg.org/download)" +
  "或在设置中指定 ffmpeg.exe 路径";

/**
 * 预设表 —— 全部参数写死,绝不向调用方暴露。
 *
 * Each entry: label (人话名), ext (输出扩展名), muxer (输出容器, ffmpeg -f —
 * 必须显式:产物先落在 `.partial` 临时名上,ffmpeg 无法从那个扩展名猜容器),
 * args (ffmpeg 输出段参数,拼在 `-i <source>` 之后、输出文件名之前)。
 * 为什么是这些值:
 */
export const PRESETS = {
  /** 通用 MP4:H.264+AAC 是唯一"到处都能播"的组合;CRF 23 是 x264 的
   * 官方默认质量;veryfast 换速度不换兼容性;+faststart 把 moov 挪到
   * 文件头,网页/播放器边下边播的前提。 */
  mp4: {
    label: "通用 MP4",
    ext: "mp4",
    muxer: "mp4",
    args: [
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
    ],
  },
  /** H.265 压缩:同画质约省一半空间,CRF 28 是 x265 常用的"可感知无损
   * 偏省"档;-tag:v hvc1 让 Apple 设备认得 HEVC-in-MP4;音轨降到 96k
   * (压缩预设里音轨也该省)。 */
  h265: {
    label: "H.265 压缩",
    ext: "mp4",
    muxer: "mp4",
    args: [
      "-c:v", "libx265", "-preset", "medium", "-crf", "28", "-tag:v", "hvc1",
      "-c:a", "aac", "-b:a", "96k",
      "-movflags", "+faststart",
    ],
  },
  /** 提取 MP3 音频:-vn 丢视频;libmp3lame 的 VBR 质量 -q:a 2 ≈ 190kbps,
   * 是"听不出差别"的常用档。 */
  mp3: {
    label: "提取 MP3 音频",
    ext: "mp3",
    muxer: "mp3",
    args: ["-vn", "-c:a", "libmp3lame", "-q:a", "2"],
  },
  /** 转 GIF 动图:12fps + 最宽 640 是聊天工具里"能发出去"的经验上限;
   * lanczos 缩放尽量保住线条;-loop 0 无限循环。GIF 没有音轨,音频自动丢弃。 */
  gif: {
    label: "转 GIF 动图",
    ext: "gif",
    muxer: "gif",
    args: ["-vf", "fps=12,scale=640:-1:flags=lanczos", "-loop", "0"],
  },
};

/** The preset an incomplete task asked for, or null (honest, never a guess). */
export function presetFor(name) {
  return PRESETS[String(name || "").trim()] ?? null;
}

/**
 * How to execute the resolved ffmpeg path (bt.mjs commandFor, same rules).
 *
 * A real install is an .exe and spawns directly; a path ending in .mjs/.js
 * (the regression fixture, or a user's wrapper) runs under the same Node
 * interpreter; .cmd/.bat goes through cmd.exe. No shell:true, so no quoting
 * surface.
 */
function commandFor(binPath) {
  if (/\.(mjs|cjs|js)$/i.test(binPath)) return { cmd: process.execPath, preArgs: [binPath] };
  if (/\.(cmd|bat)$/i.test(binPath)) return { cmd: "cmd.exe", preArgs: ["/d", "/s", "/c"] };
  return { cmd: binPath, preArgs: [] };
}

/**
 * Force-kill a process and everything it spawned (bt.mjs killTree semantics).
 *
 * On Windows child.kill() ends only the direct child; helpers ffmpeg starts
 * would survive as orphans holding the output file locked. taskkill /T walks
 * the tree; /F is forceful — this only ever runs after an abort already
 * decided the transfer is over. POSIX: the process group, then the pid.
 * Only pids of processes WE spawned in this conversion are ever passed here.
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
 * Parse one `key=value` line of an ffmpeg `-progress` block.
 *
 * ffmpeg writes a block of plain key=value lines to the pipe every update,
 * ending in `progress=continue|end`. The values we care about:
 *   out_time_us  — output media time in MICROseconds (the honest key;
 *                  out_time_ms carries the same µs value despite its name)
 *   total_size   — bytes written so far (informational only)
 *   speed        — "1.05x" encode speed factor (informational only)
 *   progress     — block terminator; "end" means ffmpeg flushed everything
 * @returns {{key:string, value:string}|null}
 */
export function parseProgressLine(line) {
  const m = /^([a-z_0-9]+)=(.*)$/.exec(String(line).trim());
  return m ? { key: m[1], value: m[2] } : null;
}

/** "HH:MM:SS.frac" → seconds, or null. */
function clockToSeconds(text) {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(text).trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * The input duration from ffmpeg's own stderr banner, or null.
 *
 * probeDuration (ffprobe) is tried first; this is the fallback for the case
 * where ffprobe is missing or unspawnable while ffmpeg itself runs — the
 * banner `Duration: 00:00:06.00, start: ...` arrives on stderr before the
 * first progress block, so the denominator is known before any percent is
 * computed. The FIRST match wins: it is the input's duration; later matches
 * would be output-stream guesses.
 */
export function bannerDuration(stderrText) {
  const m = /Duration:\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)/.exec(String(stderrText));
  return m ? clockToSeconds(m[1]) : null;
}

/** sha256 of one file, streamed (bt.mjs hashFile pattern). */
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

/** Default output name: the source's basename with the preset's extension. */
export function convertOutputName(sourcePath, preset) {
  const stem = path.basename(String(sourcePath)).replace(/\.[^.]{1,12}$/, "");
  return (stem || "convert") + "." + preset.ext;
}

/**
 * Run one format-conversion task through ffmpeg.
 *
 * Called from Downloader.run()'s dispatch for kind "convert". The task
 * carries its whole intent in meta: { sourcePath, preset } (HandBrake:
 * a preset IS the configuration — there is nothing else to carry).
 *
 * Lifecycle alignment, by construction:
 *   * the output goes through downloader.reserveTarget(), so the overwrite
 *     policy (rename/skip/overwrite), the per-path FIFO lock and the claim
 *     registry apply to conversions exactly as to downloads;
 *   * ffmpeg writes to `<target>.partial` — a path in the plain-transfer
 *     output set (Downloader.outputPathSet), so the api.mjs cancel path
 *     cleans a cancelled conversion with no changes of its own — then the
 *     finished file lands via rename (临时名→rename, the store.mjs staging
 *     convention);
 *   * progress rides the same progressCb every strategy uses; the percent is
 *     out_time_us / 总时长 and is ALWAYS an estimate (fluent-ffmpeg's
 *     warning), so every frame carries approx:true + "约 N%";
 *   * cancel/pause abort the signal → killTree(pid): the ffmpeg tree dies,
 *     nothing is published, and the source is untouched.
 *
 * @param {{downloader:object, task:object, controller:AbortController,
 *          progressCb:Function}} opts
 * @returns {Promise<{ok:boolean, bytes:number, target:string, filename:string,
 *                    dir:string, category:string|null, sha256:string|null,
 *                    meta:object}>}
 */
export async function runConvert({ downloader, task, controller, progressCb }) {
  const signal = controller.signal;
  const started = Date.now();
  const meta = task.meta ?? {};

  // ---- intent validation: fail with human words, never an empty error.
  const presetName = String(meta.preset || "").trim();
  const preset = presetFor(presetName);
  if (!preset) {
    throw new Error(
      "未知转换预设 \"" + presetName + "\";可用预设:" +
      Object.keys(PRESETS).map((k) => k + "(" + PRESETS[k].label + ")").join("、")
    );
  }
  const sourcePath = String(meta.sourcePath || "").trim();
  if (!sourcePath) {
    throw new Error("转换任务缺少源文件路径(meta.sourcePath)");
  }
  let sourceStat = null;
  try {
    sourceStat = await fsp.stat(sourcePath);
  } catch {
    throw new Error("转换的源文件不存在或不可读:" + sourcePath);
  }
  if (!sourceStat.isFile()) {
    throw new Error("转换的源文件不是普通文件:" + sourcePath);
  }
  if (signal.aborted) {
    const { abortError } = await import("./net.mjs");
    throw abortError();
  }

  // ---- engine availability: the merge.mjs convention, reused not rebuilt.
  const configured = String(downloader.config.get("ffmpegPath") || "").trim();
  const ffmpeg = await findFfmpeg(configured || undefined);
  if (!ffmpeg) throw new Error(NO_FFMPEG_MESSAGE);

  // ---- output placement: the EXISTING policy machinery, output beside the
  // source by default (a conversion lands next to what it converts; a task
  // that names a dir overrides that, and categories apply as to any task).
  const filename = sanitizeName(
    task.filename || convertOutputName(sourcePath, preset),
    "convert." + preset.ext,
  );
  const reserved = await downloader.reserveTarget({
    ...task,
    dir: task.dir || path.dirname(sourcePath),
    signal,
    filename,
  });
  const { target, dir, category, release } = reserved;
  try {
    // ffmpeg would happily read and write the same file, destroying the
    // source mid-read. The rename policy normally side-steps this (the
    // existing source makes the name "taken"), but "overwrite" would not —
    // so the identity check is explicit and happens before any spawn.
    // (One volume, one spelling: case-insensitive on Windows, exact elsewhere.)
    const sameFile = (a, b) => {
      const x = path.resolve(a), y = path.resolve(b);
      return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
    };
    if (sameFile(target, sourcePath)) {
      throw new Error(
        "转换输出与源文件是同一个文件(" + target + ");请换一个文件名或目录,源文件不会被覆盖"
      );
    }

    downloader.emit("resolved", {
      taskId: task.id, target, filename: path.basename(target), dir, category,
      kind: "convert", totalBytes: null,
    });
    downloader.emit("log", {
      taskId: task.id,
      message: "转换:" + path.basename(sourcePath) + " → " + preset.label +
        "（外部引擎 " + path.basename(ffmpeg) + "）",
    });

    // ---- denominator first: ffprobe when it exists, the banner otherwise.
    // Either way the percent built on it is an estimate and says so.
    // probeDuration can THROW on Windows/Node ≥ 20 (spawn of the derived
    // ffprobe path fails synchronously with EFTYPE when the "path" is not an
    // executable — a configured .mjs wrapper, say); any failure here just
    // means "no ffprobe denominator", and the banner fallback below takes over.
    let durationSec = null;
    try {
      durationSec = await probeDuration(sourcePath, { ffmpegPath: ffmpeg });
    } catch { /* banner fallback */ }
    let durationSource = durationSec !== null ? "ffprobe" : null;

    // `<target>.partial` is in the plain-transfer output path set, so it is
    // already claimed by reserveTarget and discarded by the cancel path.
    const tempOut = target + ".partial";

    // A journal in spirit, not for resuming (an encode cannot resume) but for
    // NAMING: it records that the temp beside this target belongs to a
    // conversion of this source, so a re-run of the same task keeps the same
    // name instead of being renamed to "name (2)" by its own leftover (the
    // segmented engine's state.json plays exactly this role for downloads;
    // Downloader.#isResumingSelf reads this file for kind "convert"). Written
    // temp-then-rename; removed with the whole family on success; discarded
    // by the existing cancel path, which owns this directory.
    const journalDir = target + StoreSubdir;
    const journal = path.join(journalDir, "convert.json");
    await mkdirWithRetry(journalDir);
    {
      const rec = JSON.stringify({
        kind: "convert", url: task.url || null, sourcePath, preset: presetName,
      });
      await fsp.writeFile(journal + ".tmp", rec, "utf8");
      await fsp.rename(journal + ".tmp", journal);
    }

    const args = [
      "-hide_banner", "-nostats",     // keep stderr to the banner + errors
      "-progress", "pipe:1",          // machine-readable progress on stdout
      "-y",                           // our staging name alone: safe to redo
      "-i", sourcePath,
      ...preset.args,
      // The container is named by the preset, never guessed: the output is
      // staged under ".partial", an extension ffmpeg cannot infer a muxer
      // from ("Unable to choose an output format" on a real run).
      "-f", preset.muxer,
      tempOut,
    ];
    const { cmd, preArgs } = commandFor(ffmpeg);

    let stderrTail = [];
    let stderrAll = "";               // bounded: only until the banner matched
    const spawnConvert = () => new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(cmd, [...preArgs, ...args], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Block-assembling parser: a frame is emitted at each progress= line,
      // the cadence ffmpeg itself chooses (about once a second on real runs).
      let block = { outTimeUs: null, totalSize: null, speedX: null };
      const emitFrame = (ended) => {
        const outUs = block.outTimeUs;
        if (durationSec === null) {
          const banner = bannerDuration(stderrAll);
          if (banner !== null) {
            durationSec = banner;
            durationSource = "banner";
          }
        }
        const known = durationSec !== null && durationSec > 0;
        const percent = known && outUs !== null && outUs >= 0
          ? Math.min(100, (outUs / 1e6 / durationSec) * 100)
          : null;
        // The duration-as-bytes mapping is what keeps the EXISTING lifecycle
        // honest for conversions: the queue's percent math
        // (downloadedBytes/totalBytes) then carries the conversion ratio, and
        // the settled task's numbers are replaced by the real output size.
        progressCb({
          totalBytes: known ? Math.round(durationSec * 1e6) : null,
          bytesWritten: outUs ?? 0,
          speed: 0,                     // no bytes/sec exists mid-encode
          percent: percent === null ? null : Math.floor(percent),
          lengthKnown: known,
          approx: true,
          percentNote: percent === null ? null : "约 " + Math.floor(percent) + "%",
          progressEnd: ended === true,
        });
        block = { outTimeUs: null, totalSize: null, speedX: null };
      };

      let stdoutBuf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk;
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop();
        for (const line of lines) {
          const kv = parseProgressLine(line);
          if (!kv) continue;
          if (kv.key === "progress") {
            emitFrame(kv.value === "end");
          } else if (kv.key === "out_time_us" || kv.key === "out_time_ms") {
            // both carry microseconds; the first seen in the block wins
            if (block.outTimeUs === null) block.outTimeUs = Number(kv.value);
          } else if (kv.key === "total_size") {
            block.totalSize = Number(kv.value);
          } else if (kv.key === "speed") {
            const m = /^([\d.]+)x/.exec(kv.value);
            if (m) block.speedX = Number(m[1]);
          }
        }
      });

      let stderrBuf = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderrBuf += chunk;
        const lines = stderrBuf.split(/\r?\n/);
        stderrBuf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          stderrTail.push(t);
          if (stderrTail.length > 40) stderrTail.shift();
          if (stderrAll.length < 8192) stderrAll += t + "\n";
        }
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
        // The binary vanished between findFfmpeg and spawn: same "ffmpeg
        // unavailable" situation, same human words.
        const e = err?.code === "ENOENT" ? new Error(NO_FFMPEG_MESSAGE) : err;
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
        const tail = stderrTail.slice(-15).join(" | ");
        finish(new Error(
          "ffmpeg 转换失败（退出码 " + (code === null ? "signal " + signalName : code) + "）" +
          (tail ? "：" + tail : "：(无输出)")
        ));
      });
    });

    let result;
    try {
      result = await spawnConvert();
    } catch (err) {
      // A failed conversion's half-written temp has no resume value (unlike
      // a partial download there is no journal to continue from), so it is
      // removed; an ABORT keeps it, exactly like every paused strategy keeps
      // its intermediate state — and the cancel path discards it.
      if (!signal.aborted) await fsp.rm(tempOut, { force: true }).catch(() => {});
      // Node ≥ 20 throws spawn setup errors synchronously ("spawn EFTYPE" and
      // friends) when the configured path is not an executable at all — raw
      // errno words are not a report a user can act on.
      if (/^spawn (EFTYPE|EACCES|EINVAL|EISDIR)$/.test(String(err?.message || ""))) {
        const e = new Error(
          "配置的 ffmpeg 无法执行(" + ffmpeg + "," + err.message +
          ");请检查设置中的 ffmpeg 路径指向可执行文件"
        );
        e.code = err.code;
        throw e;
      }
      throw err;
    }

    // ---- landing: 临时名→rename onto the policy-reserved target.
    let outStat = null;
    try { outStat = await fsp.stat(tempOut); } catch { /* handled below */ }
    if (!outStat || !outStat.isFile() || outStat.size === 0) {
      throw new Error(
        "ffmpeg 报告成功但产物缺失或为空:" + tempOut +
        (result.code === 0 ? "" : "（退出码 " + result.code + "）")
      );
    }
    try {
      await fsp.rename(tempOut, target);
    } catch (err) {
      if (err?.code !== "EPERM" && err?.code !== "EACCES" && err?.code !== "EXDEV") throw err;
      // Windows can refuse rename onto a watched/locked destination: copy
      // beside it and remove the temp, the bt.mjs moveTo fallback.
      await fsp.copyFile(tempOut, target);
      await fsp.rm(tempOut, { force: true });
    }

    const bytes = (await fsp.stat(target)).size;
    const sha256 = await hashFile(target);
    // The final frame is exact — it is the hashed, landed byte count.
    progressCb({ totalBytes: bytes, bytesWritten: bytes, speed: 0, percent: 100, lengthKnown: true });

    // Success cleans its own journal family, exactly like the segmented
    // engine cleans its journal (bounded retry: bt.mjs rmWithRetry pattern
    // for transiently locked Windows files).
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await fsp.rm(journalDir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (err?.code !== "ENOTEMPTY" && err?.code !== "EBUSY" && err?.code !== "EPERM") break;
        await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
      }
    }

    return {
      ok: true,
      bytes,
      target,
      filename: path.basename(target),
      dir,
      category,
      sha256,
      meta: {
        engine: "ffmpeg",
        ffmpeg: path.basename(ffmpeg),
        preset: presetName,
        presetLabel: preset.label,
        sourcePath,
        sourceBytes: sourceStat.size,
        // 进度是估算:时长来自 ffprobe 或 ffmpeg banner,百分比只说"约"。
        durationSec: durationSec !== null ? Math.round(durationSec * 100) / 100 : null,
        durationSource,
        durationBasedProgress: true,
        approx: true,
        elapsedMs: Date.now() - started,
      },
    };
  } finally {
    release();
  }
}
