#!/usr/bin/env node
// Node orchestrator for the Electron desktop window end-to-end test.
//
// It owns the moving parts that must live outside Electron:
//   * a deterministic local HTTP origin (slow /slow.bin for pause/resume, and a
//     /fail.bin that returns 500 until the orchestrator observes the failed
//     task and then flips to success so the UI Retry can recover),
//   * two sequential Electron runs of test/desktop-e2e-main.mjs against the
//     SAME isolated data root — a "seed" run that drives the UI and a "verify"
//     run that proves the queue and settings survived an app restart.
//
// Everything is local (127.0.0.1) and isolated (temp DOWNLOADX_HOME); the
// user's real %APPDATA%\downloadx is never touched.
//
// Automation-host notes:
//   DX_E2E_NO_SANDBOX=1 appends --no-sandbox for restricted Job hosts; the
//   shipped app keeps sandbox:true. ELECTRON_PATH overrides the executable.
//
// Run: node test/desktop-e2e.mjs   (npm run desktop:e2e)

import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { Suite, assert } from "./harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
// Electron is pointed at the in-dir test app (its package.json main is a
// CommonJS launcher that loads the ESM harness); pointing straight at the
// .mjs file or using a ../ main is not honoured on this Electron build.
const appDir = path.join(__dirname, "desktop-e2e-app");
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

function resolveElectron() {
  if (process.env.ELECTRON_PATH && fs.existsSync(process.env.ELECTRON_PATH)) return process.env.ELECTRON_PATH;
  try {
    const p = require("electron");
    if (p && fs.existsSync(p)) return p;
  } catch { /* fall through */ }
  const unpacked = path.join(projectRoot, "release", "win-unpacked", "DownloadX.exe");
  if (fs.existsSync(unpacked)) return unpacked;
  throw new Error("找不到 Electron 可执行文件；先执行 npm install 或 desktop:dir 构建。");
}

/** Deterministic local origin. Returns controls for fail-mode switching. */
function startOrigin(size = 16 * 1024 * 1024) {
  const body = Buffer.alloc(size, 0x5a);
  const mode = { fail: true };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const isFail = u.pathname === "/fail.bin";
    const fname = isFail ? "fail.bin" : "slow.bin";
    if (isFail && mode.fail) {
      res.writeHead(500, { "Content-Type": "text/plain", "Content-Length": "5" });
      res.end("boom!");
      return;
    }
    const send = (buf, code, extra) => {
      res.writeHead(code, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="' + fname + '"',
        ...extra,
      });
      res.end(buf);
    };
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    if (m) {
      const s = Number(m[1]);
      const e = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      const slice = body.subarray(s, e + 1);
      res.writeHead(206, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="' + fname + '"',
        "Content-Range": `bytes ${s}-${e}/${size}`,
        "Content-Length": slice.length,
        "Accept-Ranges": "bytes",
      });
      // fail.bin recovers immediately; slow.bin trickles so it can be paused.
      if (isFail) { res.end(slice); return; }
      let i = 0;
      const chunk = 256 * 1024;
      const tick = () => {
        if (i >= slice.length) { res.end(); return; }
        if (res.destroyed) return;
        res.write(slice.subarray(i, i + chunk));
        i += chunk;
        setTimeout(tick, 60);
      };
      tick();
      return;
    }
    if (isFail) { send(body, 200, { "Content-Length": size, "Accept-Ranges": "bytes" }); return; }
    // Full GET for slow.bin: trickle as well.
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="' + fname + '"',
      "Content-Length": size,
      "Accept-Ranges": "bytes",
    });
    let i = 0;
    const chunk = 256 * 1024;
    const tick = () => {
      if (i >= body.length) { res.end(); return; }
      if (res.destroyed) return;
      res.write(body.subarray(i, i + chunk));
      i += chunk;
      setTimeout(tick, 60);
    };
    tick();
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      resolve({
        base: "http://127.0.0.1:" + port,
        mode,
        close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r(undefined)); setTimeout(() => r(undefined), 1200); }),
      });
    });
  });
}

function readRuntime(home) {
  try {
    const raw = fs.readFileSync(path.join(home, "runtime.json"), "utf8");
    const rt = JSON.parse(raw);
    return rt && rt.port && rt.token ? rt : null;
  } catch { return null; }
}

async function waitDaemonGone(home, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rt = readRuntime(home);
    if (!rt) return true;
    try {
      await fetch(`http://127.0.0.1:${rt.port}/api/status`, {
        headers: { "x-downloadx-token": rt.token },
        signal: AbortSignal.timeout(800),
      });
    } catch { return true; }
    await sleep(400);
  }
  return false;
}

function runElectron(exe, { phase, home, userData, resultFile, params }) {
  const switches = [];
  if (process.env.DX_E2E_NO_SANDBOX === "1") switches.push("--no-sandbox");
  switches.push("--user-data-dir=" + userData);
  const args = [
    ...switches,
    appDir,
    "--phase=" + phase,
    "--result=" + encodeURIComponent(resultFile),
    "--outdir=" + encodeURIComponent(params.outDir),
    "--slowurl=" + encodeURIComponent(params.slowUrl),
    "--pauseurl=" + encodeURIComponent(params.pauseUrl),
    "--failurl=" + encodeURIComponent(params.failUrl),
    "--count=" + String(params.expectedCount || 0),
  ];
  return spawn(exe, args, {
    cwd: projectRoot,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, DOWNLOADX_HOME: home },
  });
}

/** Wait for the child to exit while flipping the origin off fail-mode once the
 * failed task is observed through the daemon API. */
async function waitSeed(child, home, origin) {
  let flipped = false;
  while (isAlive(child.pid)) {
    await sleep(500);
    if (flipped) continue;
    const rt = readRuntime(home);
    if (!rt) continue;
    try {
      const r = await fetch(`http://127.0.0.1:${rt.port}/api/tasks`, {
        headers: { "x-downloadx-token": rt.token },
        signal: AbortSignal.timeout(1000),
      });
      const data = await r.json();
      const tasks = data.tasks || [];
      const failTask = tasks.find((t) => String(t.url || "").includes("/fail.bin"));
      if (failTask && failTask.status === "error") {
        origin.mode.fail = false;
        flipped = true;
      }
    } catch { /* daemon not ready yet */ }
  }
}

const waitExit = (child, timeoutMs = 150000) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), timeoutMs);
  child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
});

async function readJsonResult(file, timeoutMs = 150000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const txt = fs.readFileSync(file, "utf8");
      if (txt.trim()) return JSON.parse(txt);
    } catch { /* not written yet */ }
    await sleep(400);
  }
  throw new Error("result file was not produced: " + file);
}

export async function runDesktopE2e() {
  const suite = new Suite("desktop-e2e");
  const exe = resolveElectron();
  // Keep every writable path (user-data-dir, daemon data home, results,
  // downloads) INSIDE the project tree. The restricted automation host denies
  // Chromium lock/cache creation in %TEMP% and other profile dirs (0x5), which
  // makes the single-instance lock fail and the app exit before startup.
  const tmp = path.join(projectRoot, "test", ".e2e-work");
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(tmp, { recursive: true });
  const home = path.join(tmp, "home");
  const outDir = path.join(home, "downloads");
  const udd1 = path.join(tmp, "udd1");
  const udd2 = path.join(tmp, "udd2");
  await fsp.mkdir(outDir, { recursive: true });

  const origin = await startOrigin();
  const params = {
    outDir,
    slowUrl: origin.base + "/slow.bin",
    pauseUrl: origin.base + "/slow.bin?pause=1",
    failUrl: origin.base + "/fail.bin",
    expectedCount: 3,
  };
  const seedResultFile = path.join(tmp, "seed.json");
  const verifyResultFile = path.join(tmp, "verify.json");

  let seedResult = null;
  let verifyResult = null;
  let fatal = null;
  let seedChild = null;
  let verifyChild = null;
  let gone = false;

  try {
    // ---- phase 1: seed (drive the UI) ----
    seedChild = runElectron(exe, { phase: "seed", home, userData: udd1, resultFile: seedResultFile, params });
    seedChild.on("error", (e) => { fatal = e; });
    await waitSeed(seedChild, home, origin);
    const seedCode = await waitExit(seedChild);
    seedResult = await readJsonResult(seedResultFile);

    // ---- restart boundary: owned daemon must be gone ----
    gone = await waitDaemonGone(home);

    // ---- phase 2: verify (relaunch, read persisted state) ----
    verifyChild = runElectron(exe, { phase: "verify", home, userData: udd2, resultFile: verifyResultFile, params });
    verifyChild.on("error", (e) => { fatal = e; });
    const verifyCode = await waitExit(verifyChild);
    verifyResult = await readJsonResult(verifyResultFile);

    // ---- assertions ----
    suite.group("Electron desktop window end-to-end");
    await suite.test("E2E: seed phase ran and the app exited cleanly", async () => {
      assert.equal(fatal, null, fatal ? String(fatal) : "no spawn error");
      assert.equal(seedCode, 0, "seed Electron exit code must be 0");
      assert.ok(seedResult && seedResult.ok, "seed phase must report success: " + JSON.stringify(seedResult && seedResult.error));
    });
    await suite.test("E2E: a download added from the desktop UI completes", async () => {
      assert.equal(seedResult.steps.downloadComplete, true, "downloadComplete step");
    });
    await suite.test("E2E: pause and resume work from the desktop UI", async () => {
      assert.equal(seedResult.steps.pauseButton, true, "a pause action was offered");
      assert.equal(seedResult.steps.paused, true, "the task became paused");
      assert.equal(seedResult.steps.resumeComplete, true, "the resumed task completed");
    });
    await suite.test("E2E: a failing download is shown and Retry recovers it", async () => {
      assert.equal(seedResult.steps.failedShown, true, "the failure was shown with a retry action");
      assert.equal(seedResult.steps.retryComplete, true, "retry completed the task");
    });
    await suite.test("E2E: a setting changed in the UI is saved", async () => {
      assert.equal(seedResult.steps.settingSaved, true, "maxConnections=4 was persisted");
    });
    await suite.test("E2E: the owned daemon shut down when the app closed (no orphan)", async () => {
      assert.equal(gone, true, "the owned daemon must be gone before relaunch");
    });
    await suite.test("E2E: the queue and setting survive closing and reopening the app", async () => {
      assert.equal(verifyCode, 0, "verify Electron exit code must be 0");
      assert.ok(verifyResult && verifyResult.ok, "verify phase must report success: " + JSON.stringify(verifyResult && verifyResult.error));
      assert.equal(verifyResult.count, 3, "all three tasks must reappear");
      assert.deepEqual(verifyResult.snapshot, seedResult.snapshot, "task names and status must match the seed snapshot");
      assert.equal(verifyResult.maxConnections, 4, "the changed setting must survive the restart");
    });
    await suite.test("E2E: completed files were written into the chosen folder", async () => {
      const files = await fsp.readdir(outDir);
      assert.ok(files.some((f) => /slow\.bin/.test(f)), "slow.bin must exist on disk");
      assert.ok(files.some((f) => /fail\.bin/.test(f)), "fail.bin must exist on disk");
    });
  } catch (err) {
    fatal = err;
  } finally {
    // Make sure no Electron from this test (or its owned daemon tree) lingers.
    for (const child of [seedChild, verifyChild]) {
      try {
        if (child && isAlive(child.pid)) {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        }
      } catch { /* best effort */ }
    }
    await sleep(500);
    try { await origin.close(); } catch { /* best effort */ }
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  if (fatal && !(seedResult && seedResult.ok)) {
    suite.results.push({ kind: "fail", text: "orchestration crashed", error: String((fatal && fatal.stack) || fatal) });
    suite.failed++;
  }
  return suite;
}

async function main() {
  const suite = await runDesktopE2e();
  process.stdout.write("\n  Electron desktop window end-to-end\n");
  process.stdout.write(suite.report());
  process.exitCode = suite.failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write("\n  desktop e2e crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
}
