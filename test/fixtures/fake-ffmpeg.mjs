// Fake ffmpeg for the batch-4 convert regression (test/batch4-convert.mjs).
//
// The engine (src/convert.mjs) speaks to ffmpeg through two observable
// surfaces only — argv, and the `-progress pipe:1` key=value blocks on stdout
// plus the input banner on stderr — so a plain Node script can stand in for
// the real binary, exactly like test/fixtures/fake-aria2c.mjs does for BT.
// It is spawned the way convert.mjs spawns the real thing (a console
// subprocess via the same Node interpreter when the configured path ends in
// .mjs, no window), never run directly by a human.
//
// Shape is selected through the environment the parent test sets:
//
//   DOWNLOADX_FAKE_FFMPEG_MODE     "ok" (default) | "no-progress" |
//                                  "instant-exit" | "hang"
//   DOWNLOADX_FAKE_FFMPEG_ARGSFILE where to dump the argv this run received
//   DOWNLOADX_FAKE_FFMPEG_PIDFILE  "hang" mode: {pid, childPid} so the test
//                                  can prove the WHOLE tree was killed
//
// "ok" imitates the console surface convert.mjs parses: an input banner with
// a Duration on stderr, three complete -progress blocks on stdout (25%,
// 60%, end), and the output file itself. The body it writes is deterministic
// so the test can compare byte-for-byte.
//
// "no-progress" writes the file and the banner but never a progress block:
// the honest-no-percent arm (no percentage may be invented).
//
// "instant-exit" dies at startup with code 3 and a stderr line, like a
// broken ffmpeg install.
//
// "hang" also spawns a grandchild and records both pids: a kill that misses
// the tree leaves the grandchild alive, which is exactly the bug the
// taskkill /T semantics exist to prevent. It writes a half output file so
// the cancel arm can prove the temp is discarded.
//
// A probe-style call (-show_entries, what probeDuration sends when it
// manages to derive "ffprobe" from this path) is answered with a duration
// number, so the ffprobe denominator path works wherever the OS can exec a
// script directly.

import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const MODE = process.env.DOWNLOADX_FAKE_FFMPEG_MODE || "ok";
const NL = String.fromCharCode(10);

/** The deterministic body of a "converted" file (mirrors fake-aria2c). */
function body() {
  const chunk = Buffer.from("downloadx fake ffmpeg payload" + NL, "utf8");
  const parts = [];
  for (let i = 0; i < 2048; i++) parts.push(chunk);
  return Buffer.concat(parts); // 30 * 2048 = 61440 bytes
}

/** Dump argv for the parent's assertions (preset args, -progress, -y, -i). */
async function dumpArgs() {
  const file = process.env.DOWNLOADX_FAKE_FFMPEG_ARGSFILE;
  if (!file) return;
  try {
    await fsp.writeFile(file + ".tmp", JSON.stringify(process.argv.slice(2)), "utf8");
    await fsp.rename(file + ".tmp", file);
  } catch { /* the test treats a missing file as its own failure */ }
}

/** Value following a flag ("-i x" -> "x"), or null. */
function argAfter(flag) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf(flag);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
}

/**
 * The output operand. ffmpeg requires the output file as the LAST argument,
 * so the last argv entry that is not a flag is the output (the "-i" value is
 * never last: at least the output follows it).
 */
function outputArg() {
  const argv = process.argv.slice(2);
  const last = argv[argv.length - 1];
  return last && !last.startsWith("-") ? last : null;
}

/** Microseconds → ffmpeg's "HH:MM:SS.ffffff" clock spelling. */
function clock(us) {
  const totalSec = us / 1e6;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = (totalSec % 60).toFixed(6);
  const pad = (x, w) => String(x).padStart(w, "0");
  return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 9);
}

/** One -progress block, the exact shape real ffmpeg writes to pipe:1. */
function progressBlock(outTimeUs, done) {
  return [
    "frame=" + Math.round((outTimeUs / 1e6) * 25),
    "fps=25.0",
    "stream_0_0_q=28.0",
    "bitrate=999.9kbits/s",
    "total_size=" + Math.round((outTimeUs / 6e6) * body().length),
    "out_time_us=" + outTimeUs,
    "out_time_ms=" + outTimeUs,
    "out_time=" + clock(outTimeUs),
    "dup_frames=0",
    "drop_frames=0",
    "speed=1.00x",
    "progress=" + (done ? "end" : "continue"),
    "",
  ].join(NL);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await dumpArgs();

  // probeDuration's call shape: answer as ffprobe would (a bare duration).
  if (process.argv.includes("-show_entries")) {
    process.stdout.write("6.000000" + NL);
    process.exit(0);
  }

  if (process.argv.includes("-version")) {
    process.stdout.write("ffmpeg version 7.1.1-fake (downloadx test fixture)" + NL);
    process.exit(0);
  }

  if (MODE === "instant-exit") {
    process.stderr.write("fake-ffmpeg: simulated startup failure (instant-exit mode)" + NL);
    process.exit(3);
  }

  const input = argAfter("-i") || "unknown-input";
  // The input banner real ffmpeg prints on stderr before any progress: this
  // is the fallback denominator source (bannerDuration in src/convert.mjs).
  process.stderr.write(
    "Input #0, matroska,webm, from '" + input + "':" + NL +
    "  Duration: 00:00:06.00, start: 0.000000, bitrate: 1234 kb/s" + NL
  );

  if (MODE === "hang") {
    // A grandchild proves tree-kill: a pid-only kill orphans it.
    const grandchild = spawn(process.execPath, ["-e", "setTimeout(()=>{},120000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const pidFile = process.env.DOWNLOADX_FAKE_FFMPEG_PIDFILE;
    if (pidFile) {
      const payload = JSON.stringify({ pid: process.pid, childPid: grandchild.pid });
      await fsp.writeFile(pidFile + ".tmp", payload, "utf8");
      await fsp.rename(pidFile + ".tmp", pidFile);
    }
    // A half-written output, like a real encode interrupted mid-flight.
    const out = outputArg();
    if (out) await fsp.writeFile(out, body().subarray(0, 4096));
    process.stdout.write(progressBlock(1_500_000, false));
    // Stay alive until the parent kills the tree.
    setInterval(() => { /* hanging on purpose */ }, 1000);
    return;
  }

  // ---- "ok" / "no-progress": a small, complete conversion.
  const pace = 100;
  if (MODE !== "no-progress") {
    process.stdout.write(progressBlock(1_500_000, false));   // 25% of 6 s
    await sleep(pace);
    process.stdout.write(progressBlock(3_600_000, false));   // 60%
    await sleep(pace);
  }
  const out = outputArg();
  if (out) {
    // Land the file, temp-then-rename, the way a well-behaved writer does.
    await fsp.writeFile(out + ".tmp", body());
    await fsp.rename(out + ".tmp", out);
  }
  if (MODE !== "no-progress") {
    process.stdout.write(progressBlock(6_000_000, true));    // end = 100%
  }
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write("fake-ffmpeg crashed: " + ((err && err.stack) || err) + NL);
  process.exit(4);
});
