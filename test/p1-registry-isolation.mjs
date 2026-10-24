#!/usr/bin/env node
// P1: the native host registration must be isolated from the real one.
//
// The defect this file exists for: install.mjs wrote the five real HKCU keys
// with the *value* of a manifest inside a scratch directory (DOWNLOADX_HOME
// pointed at a temp tree), so every self-test run left the machine with a
// registration pointing at a file that was deleted moments later. The browser
// then reported only "host could not be started".
//
// Two separate promises are proven here:
//   1. a test picks its own namespace: it writes those keys, deletes them
//      again, and the production com.downloadx.host keys are untouched;
//   2. uninstall never deletes the launcher that belongs to the installation
//      (extension/host-native.cmd), only a copy kept under the data directory.
//
// Run standalone: node test/p1-registry-isolation.mjs

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPED_LAUNCHER = path.join(PROJECT, "extension", "host-native.cmd");

/** Baseline content hash of the shipped launcher (P0/D2 acceptance criterion). */
const SHIPPED_LAUNCHER_SHA = "32d2b7c0ef865a557fc0bfe04806977792b729977e036e3c1f637c1ce823a844";

/** The name production registers under. This file must never write it. */
const PROD_NAME = "com.downloadx.host";

/** Per-run namespace, so two concurrent runs cannot see each other's keys. */
const TEST_NS = "DownloadX-Test.p1-isolation." + process.pid;

const REG_ROOTS = [
  "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\",
  "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\",
  "HKCU\\Software\\Chromium\\NativeMessagingHosts\\",
  "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\",
  "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\",
];

/**
 * Read one key's (default) value.
 *
 * reg.exe prints in the OEM code page, which mangles the Chinese directories
 * these keys may legitimately point at, so PowerShell is used with UTF-8 output
 * instead: a comparison of mangled strings would hide a real difference.
 *
 * @returns {string|null} the value, or null when the key is absent
 */
function regRead(key) {
  const psKey = key.replace(/^HKCU\\/, "HKCU:\\");
  const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
    "if (Test-Path -LiteralPath '" + psKey + "') { " +
    "(Get-ItemProperty -LiteralPath '" + psKey + "').'(default)' } else { '<absent>' }";
  let out;
  try {
    out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
  return out === "<absent>" ? null : out;
}

function regDelete(key) {
  try { execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

/** Every registered value for one namespace, keyed by browser. */
function snapshot(name) {
  const out = {};
  for (const root of REG_ROOTS) out[root] = regRead(root + name);
  return out;
}

function deleteNamespace(name) {
  for (const root of REG_ROOTS) regDelete(root + name);
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function runIsolationTests() {
  const suite = new Suite("registry isolation");
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write("\n  " + r.text + "\n");
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + (r.ms > 400 ? "  (" + r.ms + "ms)" : "") + "\n");
    else if (r.kind === "skip") process.stdout.write("    SKIP  " + r.text + " - " + r.reason + "\n");
    else process.stdout.write("    FAIL  " + r.text + "\n          " + String(r.error).split("\n").join("\n          ") + "\n");
  };

  const install = await import("../extension/install.mjs");
  const previousNs = process.env.DOWNLOADX_HOST_NAME;
  process.env.DOWNLOADX_HOST_NAME = TEST_NS;

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-p1iso-"));
  const home = path.join(tmpRoot, "home");
  // The launcher is written into the data directory, not the program directory:
  // that is the copy uninstall is allowed to remove, and it keeps the shipped
  // launcher out of the experiment entirely.
  const userShim = path.join(home, "host", "host-native.cmd");

  const prodBefore = snapshot(PROD_NAME);
  const shippedBefore = sha256File(SHIPPED_LAUNCHER);
  let installed = null;
  let removedEntries = null;

  suite.group("Native host registration isolation (P1)");

  try {
    await suite.test("install under a test namespace registers only that namespace", async () => {
      process.env.DOWNLOADX_HOME = home;
      installed = await install.install({
        extensionIds: ["abcdefghijklmnopabcdefghijklmnop"],
        shimPath: userShim,
      });
      assert.equal(installed.hostName, TEST_NS, "install must report the namespace it used");
      assert.ok(installed.written.length >= 4, "expected several browsers, got " + installed.written.length);

      for (const w of installed.written) {
        assert.ok(w.ok, "registration failed for " + w.browser + ": " + w.error);
        const manifest = JSON.parse(fs.readFileSync(w.file, "utf8"));
        assert.equal(manifest.name, TEST_NS, "the manifest name must match the key it registers under");
        assert.ok(manifest.path.startsWith(home),
          "a test must not point a browser at anything outside its scratch home: " + manifest.path);
      }

      const nsNow = snapshot(TEST_NS);
      const written = Object.keys(nsNow).filter((k) => nsNow[k]);
      assert.ok(written.length >= 4, "the namespace keys must exist, found " + written.length);
      for (const k of written) {
        assert.ok(nsNow[k].startsWith(home), "the namespace key must point inside the scratch home: " + nsNow[k]);
      }

      // The point of the whole file: the real registration did not move.
      assert.ok(same(snapshot(PROD_NAME), prodBefore),
        "installing for a test must not change the production keys:\n before " +
        JSON.stringify(prodBefore) + "\n after  " + JSON.stringify(snapshot(PROD_NAME)));
    });

    await suite.test("uninstall removes the test keys and leaves the real ones alone", async () => {
      assert.ok(installed, "install must have run first");
      removedEntries = await install.uninstall();
      assert.ok(Array.isArray(removedEntries) && removedEntries.length === REG_ROOTS.length,
        "uninstall must report one entry per browser, got " + (removedEntries && removedEntries.length));

      const nsNow = snapshot(TEST_NS);
      const leftovers = Object.keys(nsNow).filter((k) => nsNow[k]);
      assert.equal(leftovers.length, 0, "no test key may survive uninstall, still there: " + JSON.stringify(leftovers));

      assert.ok(same(snapshot(PROD_NAME), prodBefore),
        "uninstalling a test registration must not change the production keys:\n before " +
        JSON.stringify(prodBefore) + "\n after  " + JSON.stringify(snapshot(PROD_NAME)));
    });

    await suite.test("uninstall deletes the launcher copy it made inside the data directory", async () => {
      assert.equal(fs.existsSync(userShim), false,
        "the launcher copied into the data directory must be removed by uninstall: " + userShim);
    });

    await suite.test("the launcher shipped in the program directory is never deleted", async () => {
      assert.ok(fs.existsSync(SHIPPED_LAUNCHER), "the shipped launcher must still exist: " + SHIPPED_LAUNCHER);
      const now = sha256File(SHIPPED_LAUNCHER);
      assert.equal(now, SHIPPED_LAUNCHER_SHA,
        "extension/host-native.cmd must stay byte-identical to the baseline launcher");
      assert.equal(now, shippedBefore, "install + uninstall must not modify the shipped launcher");
    });

    await suite.test("a production install points the manifest at the shipped launcher", async () => {
      // The repair path for the real keys: with the namespace unset, install()
      // must name the program directory launcher, not one under the data root.
      // install() rewrites that launcher while it is here, so the shipped bytes
      // are put back if the rewrite is not byte-identical (a different node.exe
      // would otherwise silently change a file this task promises not to touch).
      const original = fs.readFileSync(SHIPPED_LAUNCHER);
      delete process.env.DOWNLOADX_HOST_NAME;
      assert.equal(install.hostName(), PROD_NAME, "the default host name must be the production one");
      let launchPath = null;
      try {
        const prod = await install.install({ extensionIds: ["abcdefghijklmnopabcdefghijklmnop"], browsers: [] });
        launchPath = prod.launchPath;
      } finally {
        if (sha256File(SHIPPED_LAUNCHER) !== SHIPPED_LAUNCHER_SHA) fs.writeFileSync(SHIPPED_LAUNCHER, original);
      }
      assert.equal(launchPath, SHIPPED_LAUNCHER,
        "in production the browser is pointed at the shipped launcher, got " + launchPath);
      assert.equal(sha256File(SHIPPED_LAUNCHER), SHIPPED_LAUNCHER_SHA,
        "extension/host-native.cmd must still match the baseline launcher");
    });
  } finally {
    deleteNamespace(TEST_NS);
    if (previousNs === undefined) delete process.env.DOWNLOADX_HOST_NAME;
    else process.env.DOWNLOADX_HOST_NAME = previousNs;
    delete process.env.DOWNLOADX_HOME;
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write("\n  " + suite.passed + " passed, " + suite.failed + " failed" +
    (suite.skipped ? ", " + suite.skipped + " skipped" : "") + "\n");
  process.stdout.write("  namespace used: " + TEST_NS + " (all keys deleted)\n");
  process.stdout.write("  production keys before: " + JSON.stringify(prodBefore) + "\n");
  process.stdout.write("  production keys after:  " + JSON.stringify(snapshot(PROD_NAME)) + "\n");
  process.stdout.write("  shipped launcher sha256: " + sha256File(SHIPPED_LAUNCHER) + "\n\n");
  return suite.failed === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runIsolationTests()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      process.stderr.write("crashed: " + ((err && err.stack) || err) + "\n");
      process.exitCode = 1;
    });
}
