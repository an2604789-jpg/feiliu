#!/usr/bin/env node
// Desktop integration tests for the Electron shell's daemon lifecycle.
//
// These tests exercise desktop/daemonManager.mjs — the exact module the Electron
// main process uses — under plain Node, each inside its own isolated data root
// (a temp DOWNLOADX_HOME). They never touch the user's real
// %APPDATA%\downloadx data, never start the capture proxy and never enqueue a
// download, so they are safe to run repeatedly and alongside a real daemon.
//
// Under the packaged app the Electron executable runs the daemon entry with
// ELECTRON_RUN_AS_NODE=1. Under plain Node that variable is harmless, so the
// same spawn path works here and the test covers the real startup code.
//
// Coverage (mapped to the acceptance criteria):
//   A. no daemon running   -> the app starts one, waits until the API is ready,
//                             marks it owned, and on quit shuts it down gracefully
//                             (process exits, runtime file removed => no orphan).
//   B. a healthy daemon is already running -> it is reused, a second daemon is
//                             never spawned, and closing the app must NOT stop it.
//   C. a stale runtime.json pointing at a dead pid -> treated as absent and
//                             replaced by a freshly owned, healthy daemon.
//
// Run: node test/desktop.mjs   (also wired as `npm run desktop:test`)

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Suite, assert } from "./harness.mjs";
import { DaemonManager, readRuntime } from "../desktop/daemonManager.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(__dirname, "..", "bin", "downloadx.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitFor(fn, what, timeoutMs = 30000, intervalMs = 200) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) { lastErr = err; }
    await sleep(intervalMs);
  }
  throw new Error("timed out waiting for " + what + (lastErr ? " (" + lastErr.message + ")" : ""));
}

async function statusOf(rt) {
  const res = await fetch(`http://127.0.0.1:${rt.port}/api/status`, {
    headers: { "x-downloadx-token": rt.token },
  });
  if (res.status !== 200) throw new Error("status endpoint returned " + res.status);
  return res.json();
}

/** Start an "external" daemon the way the CLI or a user would (not owned). */
function startExternalDaemon(home) {
  const env = { ...process.env, DOWNLOADX_HOME: home };
  // Model a normal CLI/user start rather than the Electron-as-Node path.
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn(process.execPath, [entry, "daemon", "--port", "0"], {
    windowsHide: true,
    stdio: "ignore",
    env,
  });
}

async function shutdownDaemon(rt) {
  try {
    await fetch(`http://127.0.0.1:${rt.port}/api/shutdown`, {
      method: "POST",
      headers: { "x-downloadx-token": rt.token },
    });
  } catch { /* already gone */ }
}

/** Obtain a pid that is guaranteed to have exited, to forge a stale runtime. */
function deadPid() {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true, stdio: "ignore" });
    c.on("exit", () => resolve(c.pid));
  });
}

const makeHome = () => fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-desktop-"));

export async function runDesktopTests() {
  const suite = new Suite("desktop-shell");
  const tempDirs = [];
  const externals = [];
  const managers = [];

  suite.group("Desktop daemon lifecycle (isolated data roots)");

  // ---------- A: no daemon -> owned start -> graceful stop, no orphan ----------
  await suite.test("Desktop: starts an owned daemon when none is running and stops it cleanly", async () => {
    const home = await makeHome();
    tempDirs.push(home);
    process.env.DOWNLOADX_HOME = home;
    assert.equal(await readRuntime(), null, "a fresh data root must have no runtime");

    const mgr = new DaemonManager();
    managers.push(mgr);
    const r = await mgr.ensure({ timeoutMs: 30000 });

    assert.equal(r.owned, true, "a daemon started by the app must be owned");
    assert.equal(r.reused, false, "it must not be reported as reused");
    assert.ok(r.rt && r.rt.pid, "a runtime descriptor must be returned");
    assert.equal(r.rt.host, "127.0.0.1", "the daemon must bind to loopback only");
    assert.equal(isAlive(r.rt.pid), true, "the owned process must be alive");
    const status = await statusOf(r.rt);
    assert.ok(status.version, "the API must answer with a version");

    const ownedPid = r.rt.pid;
    await mgr.stopOwned();
    await waitFor(() => !isAlive(ownedPid), "the owned daemon to exit after stopOwned", 15000);
    await waitFor(async () => (await readRuntime()) === null, "the runtime file to be removed on graceful shutdown", 10000);
  });

  // ---------- B: healthy external daemon -> reuse, never stop it ----------
  await suite.test("Desktop: reuses a healthy daemon, never spawns a second one, and never stops it", async () => {
    const home = await makeHome();
    tempDirs.push(home);
    process.env.DOWNLOADX_HOME = home;

    const ext = startExternalDaemon(home);
    externals.push(ext);
    const rt = await waitFor(async () => {
      const r = await readRuntime();
      if (r && isAlive(r.pid)) {
        try { await statusOf(r); return r; } catch { /* not ready yet */ }
      }
      return null;
    }, "the external daemon to become healthy", 30000);
    const externalPid = rt.pid;

    const mgr = new DaemonManager();
    managers.push(mgr);
    const r = await mgr.ensure();

    assert.equal(r.reused, true, "an existing healthy daemon must be reused");
    assert.equal(r.owned, false, "a reused daemon must not be owned");
    assert.equal(r.rt.pid, externalPid, "the app must attach to the existing pid");
    assert.equal(mgr.child, null, "reusing must not spawn a second child process");

    // Closing the app must leave the external daemon untouched.
    await mgr.stopOwned();
    await sleep(1200);
    assert.equal(isAlive(externalPid), true, "stopOwned must not terminate an external daemon");

    // Test harness cleanup: ask the external daemon to stop and confirm it exits.
    await shutdownDaemon(r.rt);
    await waitFor(() => !isAlive(externalPid), "the external daemon to exit when explicitly shut down", 15000);
  });

  // ---------- C: stale runtime -> replaced with a fresh owned daemon ----------
  await suite.test("Desktop: treats a stale runtime as absent and starts a fresh owned daemon", async () => {
    const home = await makeHome();
    tempDirs.push(home);
    process.env.DOWNLOADX_HOME = home;

    const dead = await deadPid();
    await fsp.writeFile(path.join(home, "runtime.json"), JSON.stringify({
      pid: dead,
      port: 59999,
      host: "127.0.0.1",
      token: "deadbeefdeadbeefdeadbeefdeadbeef",
      url: "http://127.0.0.1:59999/",
      startedAt: new Date().toISOString(),
      version: "1.0.0",
    }));
    assert.equal(await readRuntime(), null, "a runtime pointing at a dead pid must be ignored");

    const mgr = new DaemonManager();
    managers.push(mgr);
    const r = await mgr.ensure();

    assert.equal(r.owned, true, "with no live daemon the app must start one (owned)");
    assert.notEqual(r.rt.pid, dead, "the new daemon must not reuse the dead pid");
    assert.equal(isAlive(r.rt.pid), true, "the new daemon must be alive");
    assert.equal(r.rt.host, "127.0.0.1", "it must stay on loopback");
    const status = await statusOf(r.rt);
    assert.ok(status.version, "the replacement daemon must be healthy");

    const ownedPid = r.rt.pid;
    await mgr.stopOwned();
    await waitFor(() => !isAlive(ownedPid), "the replacement daemon to exit cleanly", 15000);
  });

  // Defensive cleanup so a failure never leaves daemons or temp dirs behind.
  for (const m of managers) {
    try { await m.stopOwned(); } catch { /* best effort */ }
  }
  for (const c of externals) {
    try { c.kill(); } catch { /* already gone */ }
  }
  await sleep(800);
  for (const d of tempDirs) {
    await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  }

  return suite;
}

async function main() {
  const suite = await runDesktopTests();
  process.stdout.write("\n  desktop shell integration\n");
  process.stdout.write(suite.report());
  process.exitCode = suite.failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write("\n  desktop tests crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
}
