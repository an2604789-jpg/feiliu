#!/usr/bin/env node
// Registers (or removes) the downloadx native messaging host for the browsers
// it finds, and prints what a user must do next.
//
// Native messaging is per-browser and per-user: each browser reads a manifest
// from its own registry key pointing at a JSON file that names the host
// executable and the extension IDs allowed to talk to it.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { paths, ensureDirs } from "../src/paths.mjs";

/** Registry subkey and manifest name used in production. */
const HOST_NAME_DEFAULT = "com.downloadx.host";

/**
 * The name this host registers itself under.
 *
 * Production always uses HOST_NAME_DEFAULT. Tests set DOWNLOADX_HOST_NAME to
 * a namespace of their own, because the registry is per user and not per
 * DOWNLOADX_HOME: without it a scratch home still writes the five real keys,
 * which then point at manifests inside a temporary directory. That is the
 * defect that left every browser unable to reach the host after a test run.
 *
 * Resolved on every call rather than once at import time: install.mjs is also
 * spawned as a child process (status/install/uninstall), and a child has to
 * agree with its parent about the namespace.
 */
export function hostName() {
  const override = process.env.DOWNLOADX_HOST_NAME;
  if (override === undefined || override === "") return HOST_NAME_DEFAULT;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(override)) {
    // Deliberately fatal: falling back to the production name here would write
    // the real keys from a test run, which is the bug this exists to prevent.
    throw new Error("DOWNLOADX_HOST_NAME is not a usable native messaging host name: " + JSON.stringify(override));
  }
  return override;
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_SCRIPT = path.join(__dirname, "host.mjs");
const HOST_SHIM = path.join(__dirname, "host-native.cmd");

/**
 * What the browser is told to launch.
 *
 * A browser starts the native host with CreateProcess (Chromium passes the
 * manifest "path" straight to base::LaunchProcess), and CreateProcess can only
 * start PE images. A ".mjs" file is not one: Windows fails it with
 * ERROR_BAD_EXE_FORMAT (193 / Node's EFTYPE), the connection dies before a
 * single byte is exchanged, and the extension reports only "host could not be
 * started". The manifest has no "args" field either, so the path cannot be
 * "node.exe with an argument".
 *
 * The one thing CreateProcess reliably starts that can also carry node's
 * command line is a batch file. It is executed by cmd.exe, which the Windows
 * loader starts on its own for a ".cmd"/".bat" path: verified with a raw
 * CreateProcessW call (lpApplicationName NULL, as Chromium does) - the .mjs is
 * refused with 193 while the shim starts normally.
 *
 * install() therefore hands the browser HOST_SHIM on Windows and HOST_SCRIPT
 * everywhere else; the choice is made where the manifest is written.
 */

/** Absolute node.exe, so the shim does not depend on PATH. */
function resolveNodeExe() {
  const exe = process.execPath;
  if (!exe || !/node(\.exe)?$/i.test(path.basename(exe))) {
    throw new Error("could not determine the node executable from process.execPath (" + exe + ")");
  }
  return exe;
}

/**
 * Escape a path for a batch file.
 *
 * cmd.exe expands %VAR% in a batch line before the command ever sees it, so a
 * literal percent sign in an install path would silently corrupt the command.
 * The %% form is the documented escape.
 */
function batchQuote(value) {
  return '"' + String(value).replace(/%/g, "%%") + '"';
}

/**
 * Write the launcher the manifest points at.
 *
 * The batch file is deliberately ASCII-only: it references host.mjs through
 * "%~dp0" (the file's own directory) instead of repeating the install path.
 * A UTF-8 encoded path inside a .cmd is decoded by cmd.exe with the OEM code
 * page, which mangles any non-ASCII directory - that failure mode is real and
 * was observed while building this. "%~dp0" is expanded by cmd.exe itself from
 * the command line, so the non-ASCII directory never passes through the file.
 *
 * @returns {Promise<string>} path of the launcher
 */
export async function writeHostShim({ shimPath = HOST_SHIM, nodeExe = null, hostScript = null } = {}) {
  const exe = nodeExe || resolveNodeExe();
  const script = hostScript || HOST_SCRIPT;
  const relative = path.relative(path.dirname(shimPath), script);

  // "%~dp0" already ends in a backslash and is always absolute. It is inserted
  // literally, never through batchQuote: the % in %~dp0 is a cmd.exe expansion,
  // and escaping it to %% would make the shim run a file literally named
  // "%~dp0host.mjs".
  const scriptArg = relative.startsWith("..")
    ? batchQuote(script)                       // genuinely elsewhere: spell it out
    : '"%~dp0' + relative + '"';               // stay relative, keep the path out of the file

  const lines = [
    "@echo off",
    "rem downloadx native messaging host launcher.",
    "rem The browser manifest must point at an executable; node cannot be given",
    "rem the script as an argument there, so this shim carries the command line.",
    // %* forwards whatever the browser passes (Chromium passes the manifest's
    // caller origin as the first argument).
    batchQuote(exe) + " " + scriptArg + " %*",
  ];
  await fsp.writeFile(shimPath, lines.join("\r\n") + "\r\n", "utf8");
  return shimPath;
}

/**
 * Start the registered launcher the way the browser does and read one framed
 * reply, so "usable" means "proven to work" instead of "the file is there".
 *
 * On Windows the browser calls CreateProcess on the manifest path. Node cannot
 * do that for a batch file (libuv refuses .cmd/.bat unless a shell is used,
 * and its shell path mangles non-ASCII argv), so the shim is started through
 * cmd.exe directly. That is the same program the Windows loader would pick for
 * a batch file, so the launcher logic under test is unchanged; only the way it
 * is entered differs.
 *
 * @returns {{ok:boolean, reason?:string, reply?:object, detail?:string}}
 */
export function probeHost(launcherPath, { timeoutMs = 20000 } = {}) {
  if (!launcherPath || !fs.existsSync(launcherPath)) {
    return { ok: false, reason: "launcher not found: " + launcherPath };
  }
  const message = Buffer.from(JSON.stringify({ type: "ping", protocol: 1 }), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(message.length, 0);

  // A relative name plus cwd keeps the non-ASCII install directory out of the
  // argv, which cmd.exe receives in the console code page.
  const dir = path.dirname(launcherPath);
  const isBatch = /\.(cmd|bat)$/i.test(launcherPath);
  const isWin = process.platform === "win32";
  const comspec = process.env.ComSpec || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");

  const result = isBatch
    ? spawnSync(comspec, ["/d", "/s", "/c", path.basename(launcherPath)],
        { input: Buffer.concat([header, message]), cwd: dir, timeout: timeoutMs, windowsHide: true })
    : spawnSync(isWin ? process.execPath : launcherPath,
        isWin ? [launcherPath] : [],
        { input: Buffer.concat([header, message]), cwd: dir, timeout: timeoutMs, windowsHide: true });

  if (result.error) {
    return { ok: false, reason: "the host could not be started: " + (result.error.code || result.error.message) };
  }
  const out = result.stdout ? Buffer.from(result.stdout) : Buffer.alloc(0);
  if (out.length < 4) {
    const err = result.stderr ? Buffer.from(result.stderr).toString("utf8").trim().split("\n")[0] : "";
    return { ok: false, reason: "the host produced no reply (exit " + result.status + ")" + (err ? ": " + err : "") };
  }
  const length = out.readUInt32LE(0);
  if (out.length < 4 + length) {
    return { ok: false, reason: "the host reply was truncated (" + out.length + " of " + (4 + length) + " bytes)" };
  }
  let reply = null;
  try { reply = JSON.parse(out.subarray(4, 4 + length).toString("utf8")); }
  catch { return { ok: false, reason: "the host reply was not JSON: " + out.subarray(4, 4 + length).toString("utf8").slice(0, 120) }; }
  // What is being proven here is that the launcher starts node and that the
  // host parses a frame and frames a reply - not that a daemon is running.
  // "ping" deliberately answers ok:false when no daemon is up (that is a
  // correct, useful answer), so the shape of the reply is the evidence:
  // a well-formed frame carrying a "daemon" object.
  if (!reply || typeof reply !== "object" || !reply.daemon || typeof reply.daemon.running !== "boolean") {
    return { ok: false, reason: "the host answered but not with a ping reply: " + JSON.stringify(reply).slice(0, 160) };
  }
  return { ok: true, reply, detail: "daemon " + (reply.daemon.running ? "running" : "not running") };
}


/** Browsers we know how to register with. IDs are placeholders for
 *  unpacked/extensions loaded by the user; the allowed_origins list is written
 *  from whatever the user passes via --extension-id. */
const BROWSERS = [
  { name: "Chrome",   key: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts" },
  { name: "Edge",     key: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts" },
  { name: "Chromium", key: "HKCU\\Software\\Chromium\\NativeMessagingHosts" },
  { name: "Brave",    key: "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts" },
  { name: "Firefox",  key: "HKCU\\Software\\Mozilla\\NativeMessagingHosts" },
];

function regAdd(key, value) {
  execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], { stdio: "ignore" });
}

function regDelete(key) {
  try { execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

function regExists(key) {
  try { execFileSync("reg", ["query", key], { stdio: "ignore" }); return true; }
  catch { return false; }
}

/** Read the (default) value of a key, or null when it is absent. */
function regRead(key) {
  try {
    const out = execFileSync("reg", ["query", key, "/ve"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = /REG_SZ\s+(.+?)\s*$/m.exec(out);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Is the host usable right now?
 *
 * A registry key alone proves nothing: the manifest it points at may have been
 * deleted, may name a script that no longer exists, or may still carry the
 * placeholder extension id, in which case the browser will refuse every
 * connection and the user has no way to tell why.
 */
export function verifyRegistration(browser) {
  const key = browser.key + "\\" + hostName();
  const manifestPath = regRead(key);
  if (!manifestPath) return { registered: false, manifestPath: null, usable: false, reason: "no registry entry" };
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch { return { registered: true, manifestPath, usable: false, reason: "manifest file is missing or unreadable: " + manifestPath }; }
  if (!manifest.path || !fs.existsSync(manifest.path)) {
    return { registered: true, manifestPath, usable: false, reason: "host script not found: " + manifest.path };
  }
  const origins = manifest.allowed_origins || manifest.allowed_extensions || [];
  if (!origins.length || origins.every((o) => /EXTENSION_ID_NOT_SET/.test(o))) {
    return { registered: true, manifestPath, usable: false,
      reason: "no extension id registered; load the extension and re-run install --extension-id <id>" };
  }
  // Everything above only proves the manifest is well formed. A manifest can
  // name a path that exists and still be impossible to launch - that is
  // exactly the defect this check exists for, so the last step starts the host
  // for real and waits for its reply.
  const probe = probeHost(manifest.path);
  if (!probe.ok) {
    return { registered: true, manifestPath, usable: false,
      reason: "the registered host cannot be started: " + probe.reason, launchPath: manifest.path };
  }
  return { registered: true, manifestPath, usable: true, reason: null, allowedOrigins: origins,
    launchPath: manifest.path, launchDetail: probe.detail };
}

/** Which registry roots exist on this machine (a browser is "present" if its
 *  client key is there, even if the native-messaging subkey is not yet). */
export function detectBrowsers() {
  return BROWSERS.map((b) => {
    const parent = b.key.replace(/\\NativeMessagingHosts$/, "");
    return { ...b, present: regExists(parent), registered: regExists(b.key + "\\" + hostName()) };
  });
}

export async function install({ extensionIds = [], browsers = null, shimPath = null } = {}) {
  await ensureDirs();
  if (!extensionIds.length) {
    // Without a concrete ID the manifest is unusable; Chrome refuses any origin
    // that is not an installed extension. Keep an explicit placeholder so the
    // failure is visible rather than silent.
    extensionIds = ["EXTENSION_ID_NOT_SET"];
  }

  const hostDir = path.join(paths.root, "host");
  await fsp.mkdir(hostDir, { recursive: true });

  // The launcher must exist before any manifest names it. It normally lives in
  // the program directory (HOST_SHIM); a caller may redirect it, which is how a
  // test keeps the shipped launcher out of the picture entirely.
  const shim = shimPath || HOST_SHIM;
  let launchPath = process.platform === "win32" ? shim : HOST_SCRIPT;
  if (process.platform === "win32") {
    try { launchPath = await writeHostShim({ shimPath: shim }); }
    catch (err) {
      return { hostName: hostName(), hostScript: HOST_SCRIPT, launchPath: null, extensionIds,
        written: [], error: "could not write the host launcher: " + ((err && err.message) || err) };
    }
  }

  // Remember what was registered before, so uninstall can restore it instead
  // of leaving the browser with no host at all.
  await backupRegistrations();

  const isFirefox = (name) => name === "Firefox";
  const allowedChrome = extensionIds.filter((id) => id !== "EXTENSION_ID_NOT_SET")
    .map((id) => "chrome-extension://" + id + "/");
  const allowedFirefox = extensionIds.filter((id) => id !== "EXTENSION_ID_NOT_SET");

  const written = [];
  const targets = browsers ?? detectBrowsers().filter((b) => b.present || browsers);

  for (const b of targets) {
    const manifest = isFirefox(b.name)
      ? {
          name: hostName(),
          description: "downloadx native messaging host",
          path: launchPath,
          type: "stdio",
          allowed_extensions: allowedFirefox.length ? allowedFirefox : ["downloadx@example.invalid"],
        }
      : {
          name: hostName(),
          description: "downloadx native messaging host",
          path: launchPath,
          type: "stdio",
          allowed_origins: allowedChrome.length ? allowedChrome : ["chrome-extension://EXTENSION_ID_NOT_SET/"],
        };

    const file = path.join(hostDir, b.name + ".json");
    await fsp.writeFile(file, JSON.stringify(manifest, null, 2), "utf8");
    try { regAdd(b.key + "\\" + hostName(), file); } catch (err) {
      written.push({ browser: b.name, ok: false, error: err.message, file });
      continue;
    }
    written.push({ browser: b.name, ok: true, file });
  }

  return { hostName: hostName(), hostScript: HOST_SCRIPT, launchPath, extensionIds, written };
}

/** Where the pre-install registry values are kept. */
function backupFile() { return path.join(paths.root, "host", "registration-backup.json"); }

/**
 * Record the registry values that exist before this script overwrites them.
 *
 * The original uninstall simply deleted all five keys, which is not the same
 * as undoing an install: a user who had a working host registered before
 * running this ended up worse off than when they started. The first install
 * wins the backup so a re-install cannot overwrite the real original with one
 * of our own manifests.
 *
 * @returns {Promise<object>} the backup now on disk
 */
export async function backupRegistrations({ force = false } = {}) {
  const file = backupFile();
  if (!force) {
    try {
      const existing = JSON.parse(await fsp.readFile(file, "utf8"));
      if (existing && existing.entries) return existing;
    } catch { /* no usable backup yet */ }
  }
  const entries = {};
  for (const b of BROWSERS) {
    const key = b.key + "\\" + hostName();
    const value = regRead(key);
    entries[b.name] = value ? { key, value } : { key, value: null };
  }
  const backup = { createdAt: new Date().toISOString(), entries };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(backup, null, 2), "utf8");
  return backup;
}

/** Where a copy of the launcher would be kept if it lived with the user data. */
function userLauncherCopy() { return path.join(paths.root, "host", path.basename(HOST_SHIM)); }

/**
 * Delete the launcher copy under paths.root, and nothing else.
 *
 * The containment check is the whole point: the same file name also exists in
 * the program directory, and an unconditional rm there deleted part of the
 * installation.
 *
 * @returns {Promise<boolean>} true when a copy inside the data directory was removed
 */
async function removeUserLauncherCopy() {
  const root = path.resolve(paths.root);
  const target = path.resolve(userLauncherCopy());
  const rel = path.relative(root, target);
  // Anything not strictly inside the data directory is not ours to delete.
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  try { await fsp.rm(target, { force: true }); return true; } catch { return false; }
}

/**
 * Remove the registration, putting back whatever was there before.
 *
 * @returns {Promise<Array<{browser:string, ok:boolean, action:string}>>}
 */
export async function uninstall() {
  let backup = null;
  try { backup = JSON.parse(await fsp.readFile(backupFile(), "utf8")); } catch { backup = null; }

  const removed = [];
  for (const b of BROWSERS) {
    const key = b.key + "\\" + hostName();
    const original = backup && backup.entries && backup.entries[b.name];
    const removedNow = regDelete(key);
    // Restore the pre-install value when there was one and it is not ours.
    if (original && original.value && !isOwnManifest(original.value)) {
      try {
        regAdd(key, original.value);
        removed.push({ browser: b.name, ok: true, action: "restored", value: original.value });
        continue;
      } catch (err) {
        removed.push({ browser: b.name, ok: false, action: "restore-failed", error: err.message, value: original.value });
        continue;
      }
    }
    removed.push({ browser: b.name, ok: removedNow, action: removedNow ? "removed" : "absent" });
  }
  // Only a launcher copied into the data directory is ours to delete. The one
  // in the program directory belongs to the installation: removing it left a
  // re-install with nothing to point a manifest at and every browser start
  // failing with "host could not be started". The backup file stays so a later
  // uninstall can still restore the user's original registration.
  await removeUserLauncherCopy();
  return removed;
}

/** Is this registry value one of the manifests this script writes? */
function isOwnManifest(file) {
  const hostDir = path.join(paths.root, "host");
  return path.dirname(path.resolve(file)).toLowerCase() === path.resolve(hostDir).toLowerCase();
}

export function status() {
  return detectBrowsers().map((b) => {
    const v = verifyRegistration(b);
    return {
      browser: b.name,
      present: b.present,
      installed: b.registered,
      usable: v.usable,
      reason: v.reason,
      manifestPath: v.manifestPath,
      launchPath: v.launchPath,
      launchDetail: v.launchDetail,
      key: b.key + "\\" + hostName(),
    };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "status";
  const ids = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--extension-id") ids.push(args[++i]);
    else if (args[i].startsWith("--extension-id=")) ids.push(args[i].split("=")[1]);
  }

  if (cmd === "status") {
    process.stdout.write("  native messaging host: " + hostName() + "\n\n");
    for (const s of status()) {
      const mark = !s.installed ? "[ ]" : (s.usable ? "[x]" : "[!]");
      process.stdout.write("  " + mark + " " + s.browser.padEnd(10) + " " + s.key + "\n");
      if (!s.installed && s.present) {
        process.stdout.write("       the browser is installed but the host is not registered for it\n");
      }
      if (s.installed && !s.usable) process.stdout.write("       NOT USABLE: " + s.reason + "\n");
      if (s.usable && s.launchDetail) process.stdout.write("       started and answered ping; " + s.launchDetail + "\n");
      if (s.manifestPath) process.stdout.write("       manifest: " + s.manifestPath + "\n");
    }
    process.stdout.write("\n  [x] registered and started   [!] registered but not usable   [ ] absent\n");
    return 0;
  }

  if (cmd === "install") {
    const result = await install({ extensionIds: ids });
    if (result.error) {
      process.stderr.write("  " + result.error + "\n");
      return 1;
    }
    process.stdout.write("  host script:  " + result.hostScript + "\n");
    process.stdout.write("  browser runs: " + result.launchPath + "\n");
    for (const w of result.written) {
      process.stdout.write("  " + (w.ok ? "registered" : "FAILED   ") + " " + w.browser.padEnd(10) + " " + (w.error || w.file) + "\n");
    }
    if (!ids.length) {
      process.stdout.write(
        "\n  NEXT STEP (required): no --extension-id was given, so no extension can\n" +
        "  talk to this host yet.\n" +
        "    1. Open the browser extension page (chrome://extensions or edge://extensions).\n" +
        "    2. Enable Developer mode, choose Load unpacked, and pick:\n" +
        "         " + __dirname + "\n" +
        "    3. Copy the extension ID from its card.\n" +
        "    4. Re-run: node extension/install.mjs install --extension-id <that id>\n" +
        "    5. Reload the extension, then restart the browser.\n");
    } else {
      process.stdout.write("\n  NEXT STEP: load the extension unpacked from " + __dirname + ",\n" +
        "  reload it, then restart the browser so it picks up the host.\n");
    }
    return 0;
  }

  if (cmd === "uninstall") {
    for (const r of await uninstall()) {
      const label = r.action === "restored" ? "restored" : r.action === "restore-failed" ? "KEPT    "
        : r.ok ? "removed " : "absent  ";
      process.stdout.write("  " + label + " " + r.browser +
        (r.action === "restored" ? "  (previous registration put back)" : "") + "\n");
    }
    process.stdout.write("\n  This only removes the browser registration. Your queue, settings,\n" +
      "  logs and downloaded files are untouched:\n" +
      "    " + paths.root + "\n");
    return 0;
  }

  process.stderr.write("usage: node extension/install.mjs [status|install|uninstall] [--extension-id <id>]\n");
  return 2;
}

// Run only when invoked directly. Comparing URLs is unreliable on Windows
// (relative argv paths, drive letters, separators), so compare resolved file
// paths instead.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main()
    .then((code) => { process.exitCode = code || 0; })
    .catch((err) => {
      process.stderr.write(String((err && err.stack) || err) + "\n");
      process.exitCode = 1;
    });
}