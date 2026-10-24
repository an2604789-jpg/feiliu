// P0-2: the native messaging host must actually be startable on Windows.
//
// The defect this file exists for: install.mjs wrote the manifest "path" as a
// bare ".mjs". A browser starts a native host with CreateProcess, which can
// only start PE images, so Windows refuses it with ERROR_BAD_EXE_FORMAT (193,
// Node's EFTYPE). Nothing in the browser reports that clearly - the extension
// only sees "host could not be started" - so the failure has to be pinned
// here, at the level where it actually happens.
//
// Every test states which layer it proves. Windows CreateProcess is checked
// end to end by the sibling script test\p0-native-host-createprocess.ps1,
// because node cannot make that call for a batch file (libuv refuses
// .cmd/.bat without a shell).

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { Suite, assert } from "./harness.mjs";

const PROJECT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const INSTALL = path.join(PROJECT, "extension", "install.mjs");

const isWindows = process.platform === "win32";

/** Send one native-messaging frame to a process and read the framed reply. */
function frame(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

function parseFrame(buffer) {
  const out = Buffer.from(buffer || []);
  if (out.length < 4) return null;
  const length = out.readUInt32LE(0);
  if (out.length < 4 + length) return null;
  try { return JSON.parse(out.subarray(4, 4 + length).toString("utf8")); } catch { return null; }
}

async function hashFile(file) {
  const h = createHash("sha256");
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file);
    rs.on("data", (c) => h.update(c));
    rs.once("end", resolve);
    rs.once("error", reject);
  });
  return h.digest("hex");
}

function readReg(key) {
  try {
    const out = execFileSync("reg", ["query", key, "/ve"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = /REG_SZ\s+(.+?)\s*$/m.exec(out);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

/**
 * This file writes real HKCU keys, because that is the layer the defect lived
 * in. It never writes the production ones: everything goes under its own
 * namespace, which is deleted again when the suite finishes. A key that
 * outlives its manifest is precisely what broke the browsers before.
 */
const TEST_HOST_NS = "DownloadX-Test.com.downloadx.host";

/** The five keys under one namespace. `ns` is never com.downloadx.host here. */
function regKeys(ns) {
  return {
    Chrome: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + ns,
    Edge: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\" + ns,
    Chromium: "HKCU\\Software\\Chromium\\NativeMessagingHosts\\" + ns,
    Brave: "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\" + ns,
    Firefox: "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\" + ns,
  };
}

/** Delete every key of one namespace; absent keys are not an error. */
function deleteKeys(ns) {
  for (const key of Object.values(regKeys(ns))) {
    try { execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" }); } catch { /* never created */ }
  }
}

export async function runNativeHostTests(suite, ctx = {}) {
  const install = await import("../extension/install.mjs");
  // Point install.mjs at the scratch namespace before anything installs. Set
  // on the environment so the spawned `reg`-driven children agree with it too.
  const previousNs = process.env.DOWNLOADX_HOST_NAME;
  process.env.DOWNLOADX_HOST_NAME = TEST_HOST_NS;
  const REG_KEYS = regKeys(TEST_HOST_NS);
  // A crash between here and the cleanup would otherwise leave keys behind.
  process.on("exit", () => { deleteKeys(TEST_HOST_NS); });
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-p0host-"));

  // install() writes into DOWNLOADX_HOME; every test gets its own so one
  // cannot see another's manifests.
  const withHome = async (fn) => {
    const home = await fsp.mkdtemp(path.join(tmpRoot, "home-"));
    const previous = process.env.DOWNLOADX_HOME;
    process.env.DOWNLOADX_HOME = home;
    try { return await fn(home); }
    finally {
      if (previous === undefined) delete process.env.DOWNLOADX_HOME;
      else process.env.DOWNLOADX_HOME = previous;
    }
  };

  suite.group("Native host launcher (P0-2)");

  await suite.test("the manifest never points the browser at a .mjs", async () => {
    await withHome(async () => {
      const result = await install.install({ extensionIds: ["abcdefghijklmnopabcdefghijklmnop"] });
      assert.ok(result.written.length >= 4, "expected several browsers, got " + result.written.length);
      for (const w of result.written) {
        const manifest = JSON.parse(fs.readFileSync(w.file, "utf8"));
        assert.ok(!/\.mjs$/i.test(manifest.path),
          "the browser cannot start a .mjs directly, but the " + w.browser + " manifest points at " + manifest.path);
        assert.ok(fs.existsSync(manifest.path), "the manifest path must exist: " + manifest.path);
        if (isWindows) {
          assert.match(manifest.path, /\.cmd$/i,
            "on Windows the manifest must name the batch launcher, got " + manifest.path);
        }
      }
    });
  });

  await suite.test("the launcher is a batch file that carries node and the script", async () => {
    await withHome(async () => {
      const result = await install.install({ extensionIds: ["abcdefghijklmnopabcdefghijklmnop"] });
      if (!isWindows) { assert.ok(true, "not applicable off Windows"); return; }
      const body = fs.readFileSync(result.launchPath, "utf8");
      assert.ok(body.split(/\r?\n/)[0].trim() === "@echo off", "a .cmd must start with @echo off");
      assert.ok(body.includes(path.basename(process.execPath)),
        "the launcher must name node explicitly so it does not depend on PATH: " + body);
      // "%~dp0" is how the script is found without repeating (and thus
      // re-encoding) a possibly non-ASCII install path inside the batch file.
      assert.ok(body.includes("%~dp0"), "the script should be referenced through %~dp0: " + body);
      assert.ok(!body.includes("%%~dp0"), "%~dp0 must not be escaped to %%~dp0: " + body);
      assert.match(body, /%\*/, "the launcher must forward the browser's arguments (%*)");
    });
  });

  await suite.test("the launcher runs the real host and answers a native messaging frame", async () => {
    await withHome(async () => {
      const result = await install.install({ extensionIds: ["abcdefghijklmnopabcdefghijklmnop"] });
      const probe = install.probeHost(result.launchPath);
      assert.ok(probe.ok, "the launcher must start the host: " + probe.reason);
      assert.ok(probe.reply && probe.reply.daemon, "the host must answer with a daemon object");
      assert.equal(probe.reply.daemon.running, false, "no daemon is running in this test");
    });
  });

  await suite.test("status proves the host starts instead of trusting the file", async () => {
    // The regression: a manifest whose path exists but which cannot be
    // executed was reported usable, so the user saw a green status and a
    // browser that could not connect.
    await withHome(async (home) => {
      const result = await install.install({ extensionIds: ["abcdefghijklmnopabcdefghijklmnop"] });
      const manifestFile = path.join(home, "host", "Edge.json");
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));

      // Point the manifest at a file that exists but is not executable on
      // Windows: a non-PE file with an innocuous name.
      const broken = path.join(home, "host", "not-an-executable.exe");
      fs.writeFileSync(broken, "this is text, not a PE image\n", "utf8");
      const brokenManifest = JSON.parse(JSON.stringify(manifest));
      brokenManifest.path = broken;
      // Remove the healthy launcher so this manifest is the only one under test.
      const before = readReg(REG_KEYS.Edge);
      try {
        fs.writeFileSync(manifestFile, JSON.stringify(brokenManifest, null, 2), "utf8");
        const entry = install.status().find((s) => s.browser === "Edge");
        assert.ok(entry, "Edge must appear in the status list");
        assert.equal(entry.installed, true, "the registry entry is still there");
        assert.equal(entry.usable, false,
          "a manifest naming a file that cannot be executed must NOT be reported usable");
        assert.match(entry.reason, /cannot be started/i, "the reason must say the host cannot start: " + entry.reason);
      } finally {
        fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
        if (before) { /* unchanged */ }
      }
    });
  });

  await suite.test("a healthy registration reports the daemon state it actually found", async () => {
    await withHome(async () => {
      await install.install({ extensionIds: ["abcdefghijklmnopabcdefghijklmnop"] });
      const usable = install.status().filter((s) => s.usable);
      assert.ok(usable.length >= 4, "every registered browser should be usable, got " + usable.length);
      for (const s of usable) {
        assert.ok(s.launchDetail, s.browser + " must report what the probe found");
        assert.match(s.launchDetail, /daemon (running|not running)/,
          "the probe result must be shown to the user: " + s.launchDetail);
      }
    });
  });

  await suite.test("uninstall puts back the registration it replaced", async () => {
    await withHome(async () => {
      // Pretend something else was registered before this batch ran.
      const marker = path.join(tmpRoot, "previous-host.json");
      fs.writeFileSync(marker, "{}", "utf8");
      const before = {};
      for (const [name, key] of Object.entries(REG_KEYS)) before[name] = readReg(key);

      let ownFileA = null, ownFileB = null;
      try {
        const first = await install.install({ extensionIds: ["abcdefghijklmnopabcdefghijklmnop"] });
        ownFileA = first.written.find((w) => w.browser === "Edge");
        // Simulate a pre-existing third-party registration, then install again.
        execFileSync("reg", ["add", REG_KEYS.Edge, "/ve", "/t", "REG_SZ", "/d", marker, "/f"], { stdio: "ignore" });
        await fsp.rm(path.join(process.env.DOWNLOADX_HOME, "host", "registration-backup.json"), { force: true });
        await install.install({ extensionIds: ["abcdefghijklmnopabcdefghijklmnop"] });

        const removed = await install.uninstall();
        const edge = removed.find((r) => r.browser === "Edge");
        assert.equal(edge.action, "restored", "a pre-existing registration must be restored, got " + JSON.stringify(edge));
        assert.equal(readReg(REG_KEYS.Edge), marker, "the original registry value must be back");
      } finally {
        // Put the machine back the way this test found it.
        for (const [name, key] of Object.entries(REG_KEYS)) {
          if (before[name]) execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", before[name], "/f"], { stdio: "ignore" });
          else { try { execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" }); } catch { /* absent */ } }
        }
      }
    });
  });

  await suite.test("a downloaded file from the host path has the expected bytes", async () => {
    // Byte-level proof that the launcher does not corrupt stdio: the host
    // frames real download bytes through the same pipe the browser reads.
    const daemonHome = await fsp.mkdtemp(path.join(tmpRoot, "daemon-"));
    const previousHome = process.env.DOWNLOADX_HOME;
    process.env.DOWNLOADX_HOME = daemonHome;
    const http = await import("node:http");
    const body = Buffer.alloc(96 * 1024, 0x5a);
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Length": body.length, "Accept-Ranges": "bytes" });
      res.end(body);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const url = "http://127.0.0.1:" + srv.address().port + "/payload.bin";

    let daemon = null;
    try {
      const { Daemon } = await import("../src/daemon.mjs");
      daemon = await new Daemon({ port: 0 }).init();
      const runtime = await daemon.start();
      const dlDir = path.join(daemonHome, "out");
      await fsp.mkdir(dlDir, { recursive: true });
      await daemon.config.set({ defaultDir: dlDir, categorizeByType: false, maxConnections: 2, overwriteExisting: "overwrite", askBeforeAdd: false });

      const installResult = await install.install({ extensionIds: ["abcdefghijklmnopabcdefghijklmnop"] });

      // Everything below must be asynchronous. The daemon lives in this very
      // process, so a spawnSync (which the probeHost helper uses) would block
      // the event loop the host needs in order to reach that daemon.
      const ask = (message) => new Promise((resolve, reject) => {
        const child = spawn(process.env.ComSpec || "cmd.exe",
          ["/d", "/s", "/c", path.basename(installResult.launchPath)],
          { cwd: path.dirname(installResult.launchPath), windowsHide: true });
        const chunks = [];
        const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } reject(new Error("launcher did not answer within 30s")); }, 30000);
        child.stdout.on("data", (c) => chunks.push(c));
        child.on("error", (err) => { clearTimeout(timer); reject(new Error("launcher failed: " + err.message)); });
        child.on("close", () => { clearTimeout(timer); resolve(parseFrame(Buffer.concat(chunks))); });
        child.stdin.on("error", () => { /* the child may exit before we finish writing */ });
        child.stdin.end(frame(message));
      });

      const ping = await ask({ type: "ping", protocol: 1 });
      assert.ok(ping && ping.daemon, "the launcher must start the host and answer: " + JSON.stringify(ping));
      assert.equal(ping.daemon.running, true, "the host must see the running daemon");

      const added = await ask({ type: "add", protocol: 1, url });
      assert.ok(added && added.ok === true, "the host must queue the download: " + JSON.stringify(added));

      const deadline = Date.now() + 40000;
      let view = null;
      for (;;) {
        const res = await fetch("http://127.0.0.1:" + runtime.port + "/api/tasks/" + added.task.id,
          { headers: { "x-downloadx-token": runtime.token } });
        view = (await res.json()).task;
        if (view.status === "complete" || view.status === "error") break;
        if (Date.now() > deadline) throw new Error("the task did not settle");
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.equal(view.status, "complete", "the task must complete: " + (view && view.error));
      const landed = path.join(dlDir, view.filename);
      assert.ok(fs.existsSync(landed), "the file must exist at " + landed);
      assert.equal(await hashFile(landed), createHash("sha256").update(body).digest("hex"),
        "the bytes received through the launcher must match the origin exactly");
    } finally {
      if (daemon) await daemon.stop();
      if (previousHome === undefined) delete process.env.DOWNLOADX_HOME;
      else process.env.DOWNLOADX_HOME = previousHome;
      await new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r(undefined)); setTimeout(() => r(undefined), 1500); });
      await fsp.rm(daemonHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  // Remove the namespace keys (they point into tmpRoot, deleted next) and put
  // the environment back. The production keys were never named by this file.
  deleteKeys(TEST_HOST_NS);
  if (previousNs === undefined) delete process.env.DOWNLOADX_HOST_NAME;
  else process.env.DOWNLOADX_HOST_NAME = previousNs;

  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
}

// Standalone entry: node test/p0-native-host.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  const suite = new Suite("native host");
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write("\n  " + r.text + "\n");
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + (r.ms > 400 ? "  (" + r.ms + "ms)" : "") + "\n");
    else if (r.kind === "skip") process.stdout.write("    SKIP  " + r.text + " - " + r.reason + "\n");
    else process.stdout.write("    FAIL  " + r.text + "\n          " + String(r.error).split("\n").join("\n          ") + "\n");
  };
  runNativeHostTests(suite).then(() => {
    process.stdout.write("\n  " + suite.passed + " passed, " + suite.failed + " failed" +
      (suite.skipped ? ", " + suite.skipped + " skipped" : "") + "\n\n");
    process.exitCode = suite.failed ? 1 : 0;
  }).catch((err) => {
    process.stderr.write("crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
}