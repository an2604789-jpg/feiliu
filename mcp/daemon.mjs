// Starting the daemon on demand, for callers that only have the MCP server.
//
// The rule this file exists to honour: the MCP server speaks JSON-RPC on its
// own stdout, so a daemon it starts must never share that channel. The child is
// spawned detached with stdio "ignore" and reports progress through the runtime
// file and its own log, exactly like `downloadx daemon` run by hand.
//
// Only src/paths.mjs is imported from the application. Pulling in src/cli.mjs
// would drag the whole CLI (engine, probe, downloader) into a process whose job
// is to relay JSON.

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { paths } from "../src/paths.mjs";
import { DxError, pidAlive, readRuntime, sleep, statusOk } from "./client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The executable entry point: the module that actually calls main(). */
const ENTRY = path.resolve(HERE, "..", "bin", "downloadx.mjs");

/** Last lines of the daemon log, used to explain a failed start. */
export async function logTail(lines = 20) {
  try {
    const text = await fsp.readFile(path.join(paths.logs, "downloadx.log"), "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/**
 * Wait until the runtime file describes a daemon that answers.
 *
 * @param {number} timeoutMs
 * @returns {Promise<object|null>} the runtime record, or null on timeout
 */
async function waitForRuntime(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(150);
    const runtime = await readRuntime();
    if (runtime && await statusOk(runtime)) return runtime;
  }
  return null;
}

/**
 * Return a runtime record for a live daemon, starting one if necessary.
 *
 * Reuse is decided by the API answering, not by the file existing: a runtime
 * file left behind by a killed daemon is the normal case after a crash, and
 * trusting it would send every tool call to a dead port. The pid is used for
 * the opposite question -- "the file is there and names a process, but is that
 * process still alive?" -- so a stale record is replaced instead of being
 * waited on.
 *
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{runtime: object, started: boolean}>}
 */
export async function ensureDaemon({ timeoutMs = 15000 } = {}) {
  const existing = await readRuntime();

  if (existing) {
    const alive = existing.pid === null ? true : pidAlive(existing.pid);
    if (alive) {
      // Give a just-started daemon a moment to finish binding before deciding
      // it is dead: the file is written after listen(), but a busy machine can
      // still be a few hundred milliseconds behind.
      for (let attempt = 0; attempt < 4; attempt++) {
        if (await statusOk(existing)) return { runtime: existing, started: false };
        await sleep(250);
      }
    }
  }

  const child = spawn(process.execPath, [ENTRY, "daemon"], {
    detached: true,
    // Never pipe the daemon's output into ours: stdout is the protocol channel.
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env },
  });
  // An error here means the spawn itself failed (bad execPath, permissions).
  child.on("error", () => { /* reported through the timeout below */ });
  child.unref();

  const runtime = await waitForRuntime(timeoutMs);
  if (runtime) return { runtime, started: true };

  const tail = await logTail(20);
  throw new DxError("the DownloadX daemon did not start within " + timeoutMs + " ms", {
    code: "daemon_unavailable",
    hint: "run: node bin/downloadx.mjs daemon",
    logTail: tail,
  });
}
