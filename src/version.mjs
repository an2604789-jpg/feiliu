// Single source of truth for the program version.
//
// The version lives in package.json. Reading it here — instead of repeating a
// literal in cli/daemon/api — means bumping package.json alone is enough, and
// "downloadx version", the daemon's runtime.json and the /api/status payload
// can never disagree with the package they came from.
//
// Read synchronously and cached: callers import VERSION at module load, often
// from a hot path (every /api/status request), and package.json never changes
// while a process is running.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readVersion() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    if (pkg && typeof pkg.version === "string" && pkg.version.trim()) return pkg.version.trim();
    return "0.0.0";
  } catch {
    // A missing or malformed package.json must not take the whole CLI down;
    // an obviously-wrong placeholder is better than a crash.
    return "0.0.0";
  }
}

export const VERSION = readVersion();

export default VERSION;
