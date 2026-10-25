// Fake yt-dlp for the batch-8 regression (test/batch8-ytdlp.mjs).
//
// This machine has no real yt-dlp installed, and the regression must not need
// one (and must never touch the public internet): everything the integration
// does with the process is observable at the argv/console/filesystem level,
// which a plain Node script can imitate. It is spawned exactly the way
// src/ytdlp.mjs spawns a real yt-dlp (a console subprocess, no window), never
// run directly by a human.
//
// Shape is selected through the environment the parent test sets before the
// spawn (children inherit it):
//
//   DOWNLOADX_FAKE_YTDLP_MODE     "json" (default) | "instant-exit" |
//                                 "bad-json" | "hang" | "download-hang"
//   DOWNLOADX_FAKE_YTDLP_JSONFILE the -J JSON to print (test-controlled, so
//                                 the format URLs can point at the live test
//                                 origin whose port is dynamic)
//   DOWNLOADX_FAKE_YTDLP_ARGSFILE where to dump the argv this run received
//   DOWNLOADX_FAKE_YTDLP_PIDFILE  "hang"/"download-hang": {pid, childPid} so
//                                 the test can prove the WHOLE tree was killed
//
// Two surfaces are imitated:
//   * resolve mode (argv has -J): prints the JSON file, or dies, or hangs.
//   * delegate mode (argv has --newline/-o): prints --newline progress lines
//     and lands a deterministic body at the -o template (%(ext)s → mp4), the
//     way a real run produces "<title>.<ext>" in the staging directory.

import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const MODE = process.env.DOWNLOADX_FAKE_YTDLP_MODE || "json";

/** Dump argv for the parent's assertions (flags, -J/--newline, url, -o). */
async function dumpArgs() {
  const file = process.env.DOWNLOADX_FAKE_YTDLP_ARGSFILE;
  if (!file) return;
  try {
    await fsp.writeFile(file + ".tmp", JSON.stringify(process.argv.slice(2)), "utf8");
    await fsp.rename(file + ".tmp", file);
  } catch { /* the test treats a missing file as its own failure */ }
}

async function recordPids() {
  const file = process.env.DOWNLOADX_FAKE_YTDLP_PIDFILE;
  const grandchild = spawn(process.execPath, ["-e", "setTimeout(()=>{},120000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (file) {
    // A grandchild proves tree-kill: a pid-only kill orphans it.
    const payload = JSON.stringify({ pid: process.pid, childPid: grandchild.pid });
    try {
      await fsp.writeFile(file + ".tmp", payload, "utf8");
      await fsp.rename(file + ".tmp", file);
    } catch { /* the test polls for the file's existence */ }
  }
  return grandchild;
}

/** Deterministic delegate body, identical to what the test reconstructs. */
function delegateBody() {
  const chunk = Buffer.from("downloadx fake yt-dlp payload" + String.fromCharCode(10), "utf8");
  const parts = [];
  for (let i = 0; i < 4096; i++) parts.push(chunk);
  return Buffer.concat(parts); // 30 * 4096 = 122880 bytes
}

/** Standalone default: a single 720p format pointing at a closed port. */
const DEFAULT_JSON = {
  id: "fake-default",
  title: "Fake Video",
  extractor: "fake:default",
  duration: 12.5,
  ext: "mp4",
  http_headers: { "User-Agent": "fake-ytdlp-ua/1.0" },
  formats: [
    {
      format_id: "f0", url: "http://127.0.0.1:9/direct/65536", ext: "mp4",
      height: 720, vcodec: "avc1", acodec: "none", protocol: "https", filesize: 65536,
    },
  ],
};

/** The -o value's output path, the way yt-dlp expands %(ext)s. */
function outputFromTemplate(template) {
  const t = String(template || "");
  const expanded = t.includes("%(ext)s")
    ? t.replace("%(ext)s", "mp4")
    : t + ".mp4";
  return path.resolve(expanded);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await dumpArgs();
  const argv = process.argv.slice(2);

  // ---------------- version probe: yt-dlp --version -----------------------
  // 批-8 status arm: /api/status's capabilities.ytdlp asks the binary for
  // its version once per resolved path (src/ytdlp.mjs ytDlpVersion).
  if (argv.includes("--version")) {
    process.stdout.write("2026.10.26-fake\n");
    process.exit(0);
  }

  // ---------------- resolve mode: yt-dlp -J -------------------------------
  if (argv.includes("-J")) {
    if (MODE === "instant-exit") {
      process.stderr.write("fake-ytdlp: simulated startup failure (instant-exit mode)\n");
      process.exit(3);
    }
    if (MODE === "bad-json") {
      process.stdout.write("this is definitely not JSON\n");
      process.exit(0);
    }
    if (MODE === "hang") {
      // "hang" hangs the RESOLVE surface only ("download-hang" hangs the
      // delegate instead, after a normal resolve).
      await recordPids();
      process.stdout.write("[download] Destination: never\n");
      // Stay alive until the parent's timeout/cancel kills the tree.
      setInterval(() => { /* hanging on purpose */ }, 1000);
      return;
    }
    // "json": print the fixture JSON the test wrote (port numbers in the
    // format URLs must match the origin that is live right now).
    let obj = DEFAULT_JSON;
    const jsonFile = process.env.DOWNLOADX_FAKE_YTDLP_JSONFILE;
    if (jsonFile) {
      try { obj = JSON.parse(await fsp.readFile(jsonFile, "utf8")); } catch { /* default */ }
    }
    process.stdout.write(JSON.stringify(obj) + "\n");
    process.exit(0);
  }

  // ---------------- delegate mode: --newline -o <template> ----------------
  const oAt = argv.indexOf("-o");
  const template = oAt >= 0 ? argv[oAt + 1] : "";

  if (MODE === "instant-exit") {
    process.stderr.write("fake-ytdlp: simulated delegate failure (instant-exit mode)\n");
    process.exit(3);
  }
  if (MODE === "download-hang") {
    await recordPids();
    const out = outputFromTemplate(template);
    process.stdout.write("[download] Destination: " + out + "\n");
    process.stdout.write("[download]   1.0% of ~ 120.00KiB at  1.00KiB/s ETA 02:00\n");
    // Hang without writing anything: the cancel arm kills the tree.
    setInterval(() => { /* hanging on purpose */ }, 1000);
    return;
  }

  // "json" (delegate): a small, complete "download" with real --newline output.
  const out = outputFromTemplate(template);
  const data = delegateBody();
  process.stdout.write("[download] Destination: " + out + "\n");
  for (const pct of [0, 25, 50, 75, 100]) {
    process.stdout.write(
      "[download] " + pct.toFixed(1).padStart(5) + "% of ~ 120.00KiB at  96.00KiB/s ETA 00:01\n"
    );
    await sleep(15);
    if (pct === 100) {
      await fsp.writeFile(out + ".tmp", data);
      await fsp.rename(out + ".tmp", out);   // landed atomically, like yt-dlp
    }
  }
  process.stdout.write("[Merger] Merging formats into \"" + out + "\"\n");
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write("fake-ytdlp crashed: " + ((err && err.stack) || err) + "\n");
  process.exit(4);
});
