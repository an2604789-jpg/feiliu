#!/usr/bin/env node
// P2 — the program version must come from package.json, not from a literal.
//
// Copies the project to a scratch directory, bumps ONLY that copy's package.json
// to 9.9.9, and asserts that every surface (CLI banner, "version", the daemon's
// runtime.json and /api/status) reports 9.9.9. The real project's package.json
// is hashed before and after and must be untouched.
//
//   node test/p2-version.mjs
//
// Environment: uses its own DOWNLOADX_HOME and download folder under the
// scratch tree; never touches %APPDATA%\downloadx or the user's Downloads.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, "..");
// The scratch tree lives inside this batch workspace, never under the user
// profile: copying the project into C:\Users\... would be an unrequested
// write outside the project and outside the batch root.
const BATCH_WORK = "D:\\IAM\\反馈\\最终验收批次-20261019\\修复批次-01\\work\\p2-upgrade";
const SCRATCH = process.env.P2_SCRATCH || BATCH_WORK;
const COPY = path.join(SCRATCH, "downloadx");
const HOME = path.join(SCRATCH, "p2-home");
const DOWNLOADS = path.join(SCRATCH, "p2-downloads");
const FAKE = "9.9.9";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write((ok ? "  [PASS] " : "  [FAIL] ") + name + (detail ? "  — " + detail : "") + "\n");
}
const sha = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the real project must NOT be modified by this test
const realPkg = path.join(PROJECT, "package.json");
const realPkgBefore = { sha: sha(realPkg), version: JSON.parse(fs.readFileSync(realPkg, "utf8")).version };
process.stdout.write("source package.json before: version=" + realPkgBefore.version + " sha256=" + realPkgBefore.sha + "\n");

// ---- fresh copy
await fsp.rm(SCRATCH, { recursive: true, force: true });
await fsp.mkdir(path.join(HOME), { recursive: true });
await fsp.mkdir(path.join(DOWNLOADS), { recursive: true });
fs.cpSync(PROJECT, COPY, {
  recursive: true,
  filter: (src) => !/[\\/](node_modules|Downloads|external-runs|\.git)$/.test(src)
    && !src.includes(path.sep + "external-runs" + path.sep),
});
process.stdout.write("copied project -> " + COPY + "\n");

// ---- bump the COPY only
const copyPkgPath = path.join(COPY, "package.json");
const copyPkg = JSON.parse(await fsp.readFile(copyPkgPath, "utf8"));
const copyVerBefore = copyPkg.version;
copyPkg.version = FAKE;
await fsp.writeFile(copyPkgPath, JSON.stringify(copyPkg, null, 2) + "\n", "utf8");
process.stdout.write("copy package.json: " + copyVerBefore + " -> " + JSON.parse(await fsp.readFile(copyPkgPath, "utf8")).version + "\n\n");

const env = { ...process.env, DOWNLOADX_HOME: HOME };
const run = (args, cwd = COPY) =>
  execFileSync(process.execPath, ["bin/downloadx.mjs", ...args], { cwd, env, encoding: "utf8", timeout: 120000 });

// ---- point the copy's default folder at the scratch dir (never the user's Downloads)
run(["config", "defaultDir=" + DOWNLOADS]);
run(["config", "categorizeByType=false"]);

// 1) "version"
const v1 = run(["version"]).trim();
check("node bin/downloadx.mjs version == " + FAKE, v1 === FAKE, "got " + JSON.stringify(v1));

// 2) help banner first line
const helpFirst = run(["help"]).split("\n")[0].trim();
check("help banner carries " + FAKE, helpFirst.includes("downloadx " + FAKE), "got " + JSON.stringify(helpFirst));

// 3) daemon runtime.json
let daemonOut = "";
const outPath = path.join(SCRATCH, "daemon-out.txt");
const errPath = path.join(SCRATCH, "daemon-err.txt");
const outFd = fs.openSync(outPath, "w");
const errFd = fs.openSync(errPath, "w");
const child = spawn(process.execPath, ["bin/downloadx.mjs", "daemon"], {
  cwd: COPY, env, stdio: ["ignore", outFd, errFd], windowsHide: true, detached: true,
});
child.unref();
const runtimePath = path.join(HOME, "runtime.json");
let runtime = null;
for (let i = 0; i < 100; i++) {
  await sleep(100);
  if (fs.existsSync(runtimePath)) {
    try { runtime = JSON.parse(await fsp.readFile(runtimePath, "utf8")); break; } catch { /* mid-rewrite */ }
  }
}
check("daemon wrote runtime.json", !!runtime, runtimePath);
if (runtime) check("runtime.json.version == " + FAKE, runtime.version === FAKE, "got " + JSON.stringify(runtime.version));

// 4) /api/status
let status = null;
if (runtime) {
  for (let i = 0; i < 40 && !status; i++) {
    try {
      const res = await fetch(runtime.url + "api/status", { headers: { "x-downloadx-token": runtime.token } });
      status = await res.json();
    } catch { await sleep(150); }
  }
}
check("/api/status reachable", !!status, runtime ? runtime.url + "api/status" : "no runtime");
if (status) check("/api/status version == " + FAKE, status.version === FAKE, "got " + JSON.stringify(status.version));

// 5) clean shutdown
try { run(["stop"]); } catch (e) { daemonOut += "stop error: " + e.message; }
let stopped = false;
for (let i = 0; i < 60; i++) {
  await sleep(100);
  if (!fs.existsSync(runtimePath)) { stopped = true; break; }
}
check("daemon stopped and removed runtime.json", stopped, stopped ? "" : "runtime.json still present");
if (fs.existsSync(outPath)) daemonOut += await fsp.readFile(outPath, "utf8");

// 6) the real project is untouched and still reports its own version
const realPkgAfter = { sha: sha(realPkg), version: JSON.parse(fs.readFileSync(realPkg, "utf8")).version };
check("real package.json unchanged", realPkgAfter.sha === realPkgBefore.sha,
  realPkgBefore.sha + " -> " + realPkgAfter.sha);
const realV = execFileSync(process.execPath, ["bin/downloadx.mjs", "version"], { cwd: PROJECT, env: { ...process.env, DOWNLOADX_HOME: HOME }, encoding: "utf8", timeout: 60000 }).trim();
check("real project still reports " + realPkgAfter.version, realV === realPkgAfter.version, "got " + JSON.stringify(realV));

// ---- summary
const failed = results.filter((r) => !r.ok);
process.stdout.write("\n  daemon stdout:\n" + daemonOut.split("\n").filter(Boolean).map((l) => "    " + l).join("\n") + "\n");
process.stdout.write("\n  " + (results.length - failed.length) + "/" + results.length + " checks passed\n");
if (failed.length) {
  process.stdout.write("  FAILED: " + failed.map((f) => f.name).join("; ") + "\n");
  process.exitCode = 1;
}
