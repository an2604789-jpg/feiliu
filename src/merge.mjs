// Track merging via ffmpeg.
//
// Adaptive streaming delivers video and audio as separate representations.
// Downloading only one of them produces a silent video or an audio-only file,
// which is why a download manager has to fetch both and mux them.
//
// ffmpeg is treated as optional: if it is missing or fails, the caller keeps
// the separate track files rather than losing the download.

import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

let cachedPath = null;
let probed = false;

/** Look for ffmpeg on PATH and in the usual Windows install locations. */
export function findFfmpegSync() {
  if (probed) return cachedPath;
  probed = true;
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates = [];

  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }
  if (process.env.FFMPEG_PATH) candidates.unshift(process.env.FFMPEG_PATH);

  for (const c of candidates) {
    try { if (existsSync(c)) { cachedPath = c; return cachedPath; } } catch { /* keep looking */ }
  }
  return null;
}

/** Async variant that also honours a per-call override. */
export async function findFfmpeg(explicit) {
  if (explicit) {
    try { await fsp.access(explicit); return explicit; } catch { return null; }
  }
  if (cachedPath) return cachedPath;
  const { execFile: exec } = await import("node:child_process");
  return await new Promise((resolve) => {
    exec("ffmpeg", ["-version"], { timeout: 8000, windowsHide: true }, (err) => {
      if (err) { probed = true; cachedPath = null; resolve(null); return; }
      cachedPath = "ffmpeg";
      probed = true;
      resolve(cachedPath);
    });
  });
}

/**
 * Mux one video and one audio file into \`outputPath\`.
 *
 * Streams are copied rather than re-encoded: the segments are already in their
 * final codecs, so a copy is both faster and lossless.
 *
 * @returns {Promise<{ok:boolean, output:string|null, error:string|null, ffmpeg:string|null}>}
 */

/**
 * Merge two fragmented-MP4 tracks without any external tool.
 *
 * Fragmented MP4 (what DASH and HLS-fMP4 deliver) can be joined by
 * concatenating boxes: one ftyp, a moov holding both traks and both trex
 * records, then the fragments interleaved by decode time. No sample data is
 * rewritten, so this is lossless and needs no re-encode.
 *
 * Returns null when the inputs are not fragmented MP4, so the caller can
 * fall back to ffmpeg for other containers (MPEG-TS, legacy MP4).
 *
 * @returns {Promise<{ok:boolean, output:string|null, error:string|null, method:string}|null>}
 */
export async function muxNatively({ videoPath, audioPath, outputPath }) {
  const { muxFilesStreaming } = await import("./mp4.mjs");
  return await muxFilesStreaming({ videoPath, audioPath, outputPath });
}

export async function mergeTracks({ videoPath, audioPath, outputPath, ffmpegPath, signal, timeoutMs = 600000, prefer = "native" }) {
  // Native first: no external dependency, lossless for fragmented MP4. A
  // caller can force ffmpeg with prefer: "ffmpeg" when the tracks are a
  // container the box-level muxer does not handle.
  if (prefer !== "ffmpeg") {
    const native = await muxNatively({ videoPath, audioPath, outputPath });
    if (native && native.ok) return { ...native, ffmpeg: null, remuxed: true };
    // null means "not fragmented MP4" -> fall through to ffmpeg.
    // An explicit error means the mux failed: report it only if ffmpeg is absent.
    if (native && !native.ok) {
      const ffmpegAvailable = await findFfmpeg(ffmpegPath);
      if (!ffmpegAvailable) return { ...native, ffmpeg: null };
    }
  }

  const ffmpeg = await findFfmpeg(ffmpegPath);
  if (!ffmpeg) {
    return { ok: false, output: null, error: "ffmpeg not found; keeping separate track files", ffmpeg: null };
  }
  if (!videoPath && !audioPath) {
    return { ok: false, output: null, error: "nothing to merge", ffmpeg };
  }
  // A single track needs no muxing, only a rename.
  if (!videoPath || !audioPath) {
    const only = videoPath || audioPath;
    try {
      await fsp.rm(outputPath, { force: true });
      await fsp.rename(only, outputPath);
      return { ok: true, output: outputPath, error: null, ffmpeg, remuxed: false };
    } catch (err) {
      return { ok: false, output: null, error: err.message, ffmpeg };
    }
  }

  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v:0?",
    "-map", "1:a:0?",
    "-c", "copy",
    "-movflags", "+faststart",
    outputPath,
  ];

  return await new Promise((resolve) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString().slice(0, 4000); });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    const onAbort = () => { try { child.kill(); } catch { /* gone */ } };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ok: false, output: null, error: err.message, ffmpeg });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve({ ok: true, output: outputPath, error: null, ffmpeg, remuxed: true });
      else resolve({ ok: false, output: null, error: "ffmpeg exited " + code + ": " + stderr.trim().split(String.fromCharCode(10)).slice(-2).join(" "), ffmpeg });
    });
  });
}

/** Duration in seconds via ffprobe, or null when it cannot be determined. */
export async function probeDuration(file, { ffmpegPath } = {}) {
  const ffmpeg = await findFfmpeg(ffmpegPath);
  if (!ffmpeg) return null;
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith(".exe") ? "ffprobe.exe" : "ffprobe"));
  return await new Promise((resolve) => {
    execFile(ffprobe, [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", file,
    ], { timeout: 30000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const n = Number(String(stdout).trim());
      resolve(Number.isFinite(n) ? n : null);
    });
  });
}

/** Concatenate segment files into one track file, in order. */
export async function concatParts(partPaths, outputPath) {
  const out = await fsp.open(outputPath, "w");
  try {
    for (const p of partPaths) {
      const data = await fsp.readFile(p);
      await out.write(data);
    }
  } finally {
    await out.close();
  }
  return (await fsp.stat(outputPath)).size;
}

/** Describe what the caller should do when a merge is not possible. */
export function describeOutcome({ videoPath, audioPath, mergeResult }) {
  if (mergeResult.ok) return { merged: true, output: mergeResult.output, note: null };
  const kept = [videoPath, audioPath].filter(Boolean);
  return {
    merged: false,
    outputs: kept,
    note: mergeResult.error || "tracks were kept separate",
  };
}
