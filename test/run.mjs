#!/usr/bin/env node
// Executable entry for the self-test suite.
//
// The exit code is set rather than forced, so the origin server and any
// sockets finish closing cleanly. Keep-alive connections from the global
// agent are destroyed explicitly: Node pools them by default since v19, and
// a pooled socket would otherwise hold the process open after the summary.
//
// After the main self-test, the batch-1, batch-2 and batch-4 regression
// suites (test/batch1-*.mjs, test/batch2-*.mjs, test/batch3-siteguards.mjs,
// test/sites/) run one by one as child processes. Each of those files is a self-contained
// script with its own mini runner, its own throwaway DOWNLOADX_HOME and its
// own "process must exit cleanly" guarantee — importing them here would run
// them at import time and let their exit-code bookkeeping collide with this
// process. A child process keeps all of that isolated while still folding
// every suite's pass/fail into this run's exit code, the same way the main
// suite's groups do.

import http from "node:http";
import https from "node:https";
import process from "node:process";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runSelfTest } from "./selftest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NL = String.fromCharCode(10);

// The batch-1 suites in the order their work packages landed. Each prints
// its own grouped output (same two-space indent convention as the main
// suite) and exits 0 only when every test inside it passed.
const BATCH1_SUITES = [
  "batch1-capture.mjs",
  "batch1-smallfixes.mjs",
  "batch1-credentials.mjs",
  "batch1-supervision.mjs",
  "batch1-approvals.mjs",
  "batch1-desktop-feedback.mjs",
  "batch1-gui.mjs",
  "batch1-singleton.mjs",
  "batch1-mcp-http.mjs",
];

// Batch-2 regression suites, same self-contained contract as batch-1:
// own runner, own throwaway DOWNLOADX_HOME, own clean-exit guarantee.
// mkdir-retry landed first (W4) and used to sit in the batch-1 list; the
// four below are the batch-2 work packages (render/stream/stop/takeover).
const BATCH2_SUITES = [
  "batch2-mkdir-retry.mjs",
  "batch2-render.mjs",
  "batch2-stream.mjs",
  "batch2-stop-semantics.mjs",
  "batch2-takeover.mjs",
];

// Batch-3 regression suites (P-1 pending lifecycle / P-5 redirect
// credentials / resume-failure budget), same self-contained contract.
const BATCH3_SUITES = [
  "batch3-pending.mjs",
  "batch3-redirect-credentials.mjs",
  "batch3-resume-budget.mjs",
];

// Batch-4: GPP crash guard (pure logic carved out of desktop/main.mjs) and
// the real-site fixtures under test/sites/. The site group follows the
// yt-dlp discipline: when the network is unreachable the whole group SKIPs
// (it prints the reason) and exits 0 — a skip is never counted as a failure
// here; only a real HTTP-level or characteristic mismatch fails it.
// The five 批-4 work packages (2026-10-25) join the same list: magnet/BT
// delegation, multi-queue groups, format conversion, the GUI additions and
// the EPERM canary. Each is the same self-contained contract: own runner,
// own throwaway DOWNLOADX_HOME, no D:/IAM/downloadx-data, clean exit.
const BATCH4_SUITES = [
  "batch4-magnet.mjs",
  "batch4-multiqueue.mjs",
  "batch4-convert.mjs",
  "batch4-gui.mjs",
  "batch4-eperm-canary.mjs",
  "batch3-siteguards.mjs",
  "sites/public-sites.mjs",
];

// Batch-5 (2026-10-25): the two landmark contracts from the Linux field
// report (P-6 explicit-dir landing + GUI reverse linkage, P-7 byte-based
// media progress), error transparency (P-8 attempts/retries, P-9 errno
// translation, P-10 aria2c tails) and the CLI/docs pair (P-11 doctor data
// root, P-12 README API shapes). Same self-contained contract as the lists
// above: own runner, own throwaway DOWNLOADX_HOME, clean exit.
const BATCH5_SUITES = [
  "batch5-landmark.mjs",
  "batch5-errortrans.mjs",
  "batch5-doctor.mjs",
];

// Batch-6 (2026-10-25): the proxy/approvals race and polish work packages —
// P-13..P-15+P-17 proxy fixes (dedup key, start(mode), async MITM leaf,
// CONNECT floor), P-16/P-20 scheduler display + systemd deployment docs, and
// the stop()-flush race regression (amplified reproducer for the intermittent
// batch1-approvals failure). Same self-contained contract as the lists above.
const BATCH6_SUITES = [
  "batch6-proxy.mjs",
  "batch6-polish.mjs",
  "batch6-approvals-race.mjs",
];

// Batch-7 (2026-10-25): P-18 proxyMode real consumption + proxy authentication
// (sysproxy discovery, selectRunProxy, Proxy-Authorization on both proxy hops),
// P-19 daemon.lock pid-reuse identity probe, and the P-18 documentation copy
// (GUI hints + README proxy section). Same self-contained contract as the
// lists above: own runner, own throwaway DOWNLOADX_HOME, clean exit.
const BATCH7_SUITES = [
  "batch7-proxyauth.mjs",
  "batch7-lockguard.mjs",
  "batch7-docs.mjs",
];

// Batch-8 (2026-10-26): yt-dlp integration (resolver + full delegation, fake
// binary), GUI yt-dlp settings/badge/detail overlay, CI vendoring regression,
// P-22 BT proxy straggler, and P-24/P-25 keepalive + clipboard bridge. Same
// self-contained contract as the lists above: own runner, own throwaway
// DOWNLOADX_HOME, clean exit.
const BATCH8_SUITES = [
  "batch8-ytdlp.mjs",
  "batch8-gui.mjs",
  "batch8-ci.mjs",
  "batch8-tails.mjs",
  "batch8-bridge.mjs",
];

// Batch-9 (2026-10-31, after v1.2.0): the ELECTRON_RUN_AS_NODE bootstrap guard.
// Hosts that export ELECTRON_RUN_AS_NODE=1 to their children turn electron.exe
// into a plain Node interpreter, so main.mjs dies on its first import and the
// window never appears. desktop/bootstrap.cjs is now the packaged entry; this
// suite locks the relaunch decision, the entry wiring and the fail-loud log.
const BATCH9_SUITES = [
  "desktop-bootstrap.mjs",
  // 批-9 修复批(2026-10-31):代理隧道 agent:false 移除的 e2e 守卫(batch9-net),
  // 引擎四项(chmod 自愈/杀树与孤儿/剪贴板回环/打包排除)的回归(batch9-engine)。
  // batch9-rate.mjs 是一次性限速实测留档,220MB 跑约 2 分钟,不进常规全量。
  "batch9-net.mjs",
  "batch9-engine.mjs",
];

/** Run one regression suite file as a child process; resolve its exit code. */
function runRegressionSuite(label, file) {
  return new Promise((resolve) => {
    process.stdout.write(NL + "  " + label + ": " + file + NL);
    const child = spawn(process.execPath, [path.join(HERE, file)], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", (err) => {
      process.stdout.write("  suite failed to start: " + (err && err.message) + NL);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code === 0 ? 0 : (code ?? 1)));
  });
}

async function runBatch1() {
  let failed = 0;
  let total = 0;
  const groups = [
    ["Batch-1 regression", BATCH1_SUITES],
    ["Batch-2 regression", BATCH2_SUITES],
    ["Batch-3 regression", BATCH3_SUITES],
    ["Batch-4 regression", BATCH4_SUITES],
    ["Batch-5 regression", BATCH5_SUITES],
    ["Batch-6 regression", BATCH6_SUITES],
    ["Batch-7 regression", BATCH7_SUITES],
    ["Batch-8 regression", BATCH8_SUITES],
    ["Batch-9 regression", BATCH9_SUITES],
  ];
  for (const [label, files] of groups) {
    for (const file of files) {
      const code = await runRegressionSuite(label, file);
      if (code !== 0) failed++;
    }
    total += files.length;
  }
  process.stdout.write(NL + "  batch1+batch2+batch3+batch4+batch5+batch6+batch7+batch8+batch9 suites: " + (total - failed) +
    " passed, " + failed + " failed" + NL);
  return failed === 0 ? 0 : 1;
}

process.stdout.write("\n  downloadx self-test\n");

runSelfTest()
  .then(async (code) => {
    // Batch-1 suites run even when the main suite failed, so one full run
    // still reports every failing group instead of hiding the tail.
    const batch1Code = await runBatch1();
    http.globalAgent.destroy();
    https.globalAgent.destroy();
    process.exitCode = code || batch1Code;
  })
  .catch((err) => {
    process.stderr.write("\n  self-test crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
