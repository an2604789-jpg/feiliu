'use strict';
// bootstrap.cjs — the entry point Electron actually loads (package.json "main").
//
// Why this file exists (added 2026-10-31):
//
//   Some hosts export ELECTRON_RUN_AS_NODE=1 into their child processes (IDEs,
//   other Electron apps' tool calls, CI shells). electron.exe honours that
//   variable and runs as a plain Node interpreter instead of as an Electron
//   app, so desktop/main.mjs dies at its very first import with
//
//       SyntaxError: The requested module 'electron' does not provide an
//       export named 'BrowserWindow'
//
//   ...and the user gets no window at all. Reproduced on this machine from an
//   agent shell whose environment carried ELECTRON_RUN_AS_NODE=1; the same
//   binary printed "Node.js v24.22.0" for --version instead of "v45.0.0".
//
//   main.mjs cannot defend itself: its `import ... from "electron"` statements
//   are resolved by the loader before any of its own statements run. The guard
//   has to sit one level earlier — in this file, which only Electron loads as
//   the application entry.
//
// Behaviour: when the variable is set we relaunch the same binary with the same
// arguments and an environment without it, then exit 0. Otherwise we load the
// real entry. A relaunch marker keeps a mis-set environment from looping.

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

/** The variable Electron misreads as "run me as Node". */
const GUARD_VAR = "ELECTRON_RUN_AS_NODE";
/** Set on the relaunched child so a second launch can never bounce again. */
const MARKER_VAR = "FEILIU_BOOTSTRAP_RELAUNCHED";

/**
 * Decide whether this process must relaunch itself without the guard variable.
 *
 * Returns null when no relaunch is needed — either the variable is absent (the
 * normal case) or this process is already the relaunched child (the marker is
 * present, so the guard must not fire twice). Otherwise returns the exact
 * spawn recipe, with the variable removed rather than blanked: an empty value
 * still counts as "set" for Electron.
 *
 * Pure by construction (env in, plan out) so the decision is testable without
 * starting a 200 MB GUI process.
 */
function planRelaunch(env, execPath, argv) {
  if (!env || !env[GUARD_VAR]) return null;
  if (env[MARKER_VAR]) return null;
  const cleaned = Object.assign({}, env);
  delete cleaned[GUARD_VAR];
  cleaned[MARKER_VAR] = "1";
  return {
    command: execPath,
    args: Array.isArray(argv) ? argv.slice(1) : [],
    options: { env: cleaned, detached: true, stdio: "ignore" },
  };
}

/** Last-resort diagnostics: a window that never appears must leave a trace. */
function logLaunch(line) {
  try {
    const root = process.env.DOWNLOADX_HOME || path.join(process.env.APPDATA || __dirname, "downloadx");
    const file = path.join(root, "logs", "desktop-launch.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, new Date().toISOString() + " bootstrap: " + line + "\n");
  } catch { /* logging must never break startup */ }
}

function main() {
  const plan = planRelaunch(process.env, process.execPath, process.argv);
  if (plan) {
    logLaunch("relaunching without " + GUARD_VAR + " (inherited from the launching shell)");
    try {
      const child = spawn(plan.command, plan.args, plan.options);
      child.unref();
      process.exit(0);
    } catch (err) {
      logLaunch("relaunch failed: " + ((err && err.message) || err));
      process.exit(1);
    }
    return;
  }
  import("./main.mjs").catch((err) => {
    logLaunch("main.mjs failed to load: " + ((err && err.stack) || err));
    process.exit(1);
  });
}

module.exports = { planRelaunch, GUARD_VAR, MARKER_VAR };

// Electron sets process.type="browser" in the main process; a plain Node
// "require" of this file (the regression suite) sets neither, so main() stays
// off and the pure planner can be exercised without starting a GUI.
if (require.main === module || process.type === "browser") main();
