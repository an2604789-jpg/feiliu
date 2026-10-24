// Fake aria2c for the batch-4 magnet regression (test/batch4-magnet.mjs).
//
// This machine has no real aria2c installed, and the regression must not need
// one: everything Downloader->bt.mjs does with the process is observable at
// the console/argv/filesystem level, which a plain Node script can imitate.
// It is spawned exactly the way bt.mjs spawns a real aria2c (a console
// subprocess, no window), never run directly by a human.
//
// Shape is selected through the environment the parent test sets before the
// spawn (children inherit it):
//
//   DOWNLOADX_FAKE_ARIA2C_MODE     "ok" (default) | "instant-exit" | "hang"
//   DOWNLOADX_FAKE_ARIA2C_ARGSFILE where to dump the argv this run received
//   DOWNLOADX_FAKE_ARIA2C_PIDFILE  "hang" mode: {pid, childPid} so the test
//                                  can prove the WHOLE tree was killed
//
// "ok" imitates the console surface bt.mjs parses: the bracketed
// --summary-interval progress lines, the *.aria2 control file beside the
// in-flight data, and the final NOTICE "download completed:" line. The body
// it writes is deterministic so the test can compare byte-for-byte.
//
// "hang" also spawns a grandchild and records both pids: a kill that misses
// the tree leaves the grandchild alive, which is exactly the bug the
// taskkill /T semantics exist to prevent.

import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const MODE = process.env.DOWNLOADX_FAKE_ARIA2C_MODE || "ok";

/** Dump argv for the parent's assertions (proxy passthrough, flags, URI). */
async function dumpArgs() {
  const file = process.env.DOWNLOADX_FAKE_ARIA2C_ARGSFILE;
  if (!file) return;
  try {
    await fsp.writeFile(file + ".tmp", JSON.stringify(process.argv.slice(2)), "utf8");
    await fsp.rename(file + ".tmp", file);
  } catch { /* the test treats a missing file as its own failure */ }
}

function argValue(name) {
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(name + "=")) return a.slice(name.length + 1);
  }
  return null;
}

/** The URI operand: the one argv entry that is not an --option. */
function uriArg() {
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith("-") && !a.startsWith("/")) return a;
  }
  return "";
}

/** Output file name: the magnet's dn=, else a fixed torrent-ish name. */
function outputName(uri) {
  const m = /[?&]dn=([^&]+)/.exec(uri);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { /* keep fallback */ }
  }
  return "fake-torrent-file.bin";
}

/** Deterministic body, identical to what the test reconstructs. */
function body() {
  const chunk = Buffer.from("downloadx fake aria2c payload" + String.fromCharCode(10), "utf8");
  const parts = [];
  for (let i = 0; i < 4096; i++) parts.push(chunk);
  return Buffer.concat(parts); // 30 * 4096 = 122880 bytes
}

const summary = (done, total) => {
  const pct = Math.floor((done / total) * 100);
  const dl = 96 * 1024;
  const f = (b) => (b >= 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + "MiB" : Math.round(b / 1024) + "KiB");
  return `[#f10b2c ${f(done)}/${f(total)}(${pct}%) CN:16 DL:${f(dl)} ETA:1s]`;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await dumpArgs();

  if (process.argv.includes("--version")) {
    process.stdout.write("aria2 version 1.37.0\nfake-aria2c (downloadx test fixture)\n");
    process.exit(0);
  }

  if (MODE === "instant-exit") {
    process.stderr.write("fake-aria2c: simulated startup failure (instant-exit mode)\n");
    process.exit(3);
  }

  if (MODE === "hang") {
    // A grandchild proves tree-kill: a pid-only kill orphans it.
    const grandchild = spawn(process.execPath, ["-e", "setTimeout(()=>{},120000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const pidFile = process.env.DOWNLOADX_FAKE_ARIA2C_PIDFILE;
    if (pidFile) {
      const payload = JSON.stringify({ pid: process.pid, childPid: grandchild.pid });
      await fsp.writeFile(pidFile + ".tmp", payload, "utf8");
      await fsp.rename(pidFile + ".tmp", pidFile);
    }
    process.stdout.write(summary(1024 * 30, 1024 * 120) + "\n");
    process.stdout.write("[#f10b2c 30KiB/120KiB(25%) CN:16 DL:96KiB ETA:1s]\n");
    // Stay alive until the parent kills the tree.
    setInterval(() => { /* hanging on purpose */ }, 1000);
    return;
  }

  // ---- "ok": a small, complete download with real console output.
  const dir = argValue("--dir") || ".";
  const uri = uriArg();
  const name = outputName(uri);
  const target = path.join(dir, name);
  const data = body();
  const intervalArg = Number(argValue("--summary-interval"));
  const pace = Math.max(60, Math.min((Number.isFinite(intervalArg) ? intervalArg : 1) * 1000, 120));

  // aria2 creates the control file beside the data while the download runs.
  await fsp.writeFile(target + ".aria2", "fake control file\n", "utf8");

  const emit = (line) => process.stdout.write(line + "\n");
  emit("[#f10b2c 0B/0B CN:16 DL:0B]");          // metadata phase, no percent yet
  await sleep(pace);
  emit(summary(1024 * 30, data.length));
  await sleep(pace);
  emit(summary(1024 * 60, data.length));
  await sleep(pace);
  await fsp.writeFile(target + ".tmp", data);
  await fsp.rename(target + ".tmp", target);     // landed atomically, like aria2
  await fsp.rm(target + ".aria2", { force: true });
  emit(summary(data.length, data.length));
  emit(`2026-10-25 00:00:00.000000 NOTICE - download completed: ${target}`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write("fake-aria2c crashed: " + ((err && err.stack) || err) + "\n");
  process.exit(4);
});
