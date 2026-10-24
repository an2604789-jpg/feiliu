// P0-D: 'get -o <existing file>' must obey overwriteExisting.
//
// The defect this guards against: src/cli.mjs resolved '-o' by asking only
// "is this a directory?", never "may I replace this file?". A foreground 'get'
// therefore wrote straight onto the requested path for every policy: with the
// default 'rename' the user's existing file was overwritten in place (no "(2)"
// copy, the old bytes gone), and with 'skip' it was overwritten instead of
// refused. Measured before the fix, all three policies produced one file of the
// origin's size and exit 0.
//
// Every case runs the real CLI as a child, with DOWNLOADX_HOME pointing at a
// throwaway directory, so the user's own %APPDATA%\downloadx and Downloads
// folder are never touched.
//
// Usage: node test/p0d-cli-overwrite.mjs

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { Suite, assert } from "./harness.mjs";
import { startOrigin, payloadFor } from "./origin.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const CLI = path.join(ROOT, "bin", "downloadx.mjs");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const suite = new Suite("p0d-cli-overwrite");
const workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-p0d-"));

/** Run the real CLI; resolves when it exits (killed at the deadline). */
function spawnCli(args, { home, timeoutMs = 120000 } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, DOWNLOADX_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); });
  });
  return { child, done };
}

async function runCli(args, opts) {
  return await spawnCli(args, opts).done;
}

/** A throwaway DOWNLOADX_HOME holding one settings file; never the real one. */
async function makeHome(name, settings) {
  const home = path.join(workRoot, "home-" + name);
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, "config.json"), JSON.stringify({
    categorizeByType: false,
    maxConnections: 4,
    ...settings,
  }), "utf8");
  return home;
}

async function makeOutDir(name) {
  const dir = path.join(workRoot, "out-" + name);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

const SENTINEL = Buffer.from("DO-NOT-TOUCH-" + "s".repeat(200));
const SENTINEL_SHA = sha256(SENTINEL);

/** The file a user already has at the requested path. */
async function plantSentinel(file) {
  await fsp.writeFile(file, SENTINEL);
  return SENTINEL_SHA;
}

/**
 * Wait until a name starting with 'prefix' appears and return every such name.
 * Used to catch the engine's scratch files while a transfer is still running:
 * they exist only for the duration of the transfer.
 */
async function waitForNames(dir, prefix, { timeoutMs = 40000, everyMs = 60 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let names = [];
    try { names = await fsp.readdir(dir); } catch { /* not created yet */ }
    const hit = names.filter((n) => n.startsWith(prefix));
    if (hit.length) return hit;
    await sleep(everyMs);
  }
  return [];
}

const origin = await startOrigin();

try {
  const SIZE = 64 * 1024;
  const PAYLOAD_SHA = sha256(payloadFor(SIZE));
  const url = origin.origin + "/range/" + SIZE;

  // ---- the three policies, on a target that already exists -----------------
  suite.group("three policies x existing target");

  await suite.test("rename: the user's file survives and the artefact lands beside it", async () => {
    const home = await makeHome("rename", { overwriteExisting: "rename" });
    const dir = await makeOutDir("rename");
    const target = path.join(dir, "user.bin");
    await plantSentinel(target);

    const r = await runCli(["get", url, "-o", target, "-q"], { home });
    assert.equal(r.code, 0, "rename must succeed, stderr was: " + r.err.trim());

    assert.equal(sha256(await fsp.readFile(target)), SENTINEL_SHA,
      "the file the user already had must be byte-identical after a rename-policy download");
    const beside = path.join(dir, "user (2).bin");
    assert.ok(fs.existsSync(beside), "rename must produce 'user (2).bin', saw: " +
      JSON.stringify(await fsp.readdir(dir)));
    assert.equal(sha256(await fsp.readFile(beside)), PAYLOAD_SHA, "the artefact itself must be correct");
    assert.match(r.out, /user \(2\)\.bin/, "the summary must report the path it actually wrote, got: " + r.out.trim());
  });

  await suite.test("skip: refuses with ALREADY_EXISTS, exit non-zero, nothing written", async () => {
    const home = await makeHome("skip", { overwriteExisting: "skip" });
    const dir = await makeOutDir("skip");
    const target = path.join(dir, "user.bin");
    await plantSentinel(target);
    const before = (await fsp.readdir(dir)).sort();

    const r = await runCli(["get", url, "-o", target, "-q"], { home });
    assert.notEqual(r.code, 0, "skip must fail, not overwrite");
    assert.match(r.err, /ALREADY_EXISTS/, "the refusal must be identifiable, stderr was: " + r.err.trim());
    assert.match(r.err, /exist/i, "and it must say the file exists");
    assert.equal(sha256(await fsp.readFile(target)), SENTINEL_SHA, "the protected file must be untouched");
    assert.deepEqual((await fsp.readdir(dir)).sort(), before, "skip must not create anything either");
  });

  await suite.test("overwrite: replaces the existing file", async () => {
    const home = await makeHome("overwrite", { overwriteExisting: "overwrite" });
    const dir = await makeOutDir("overwrite");
    const target = path.join(dir, "user.bin");
    await plantSentinel(target);

    const r = await runCli(["get", url, "-o", target, "-q"], { home });
    assert.equal(r.code, 0, "overwrite must succeed, stderr was: " + r.err.trim());
    const after = await fsp.readFile(target);
    assert.notEqual(sha256(after), SENTINEL_SHA, "overwrite must actually replace the old bytes");
    assert.equal(sha256(after), PAYLOAD_SHA, "and what replaced them must be the downloaded payload");
    assert.deepEqual((await fsp.readdir(dir)).sort(), ["user.bin"], "overwrite must not leave a second copy");
  });

  await suite.test("no scratch is left beside the user's file after a rename", async () => {
    const dir = path.join(workRoot, "out-rename");
    const mine = (await fsp.readdir(dir)).filter((n) => n.startsWith("user.bin."));
    assert.deepEqual(mine, [], "the journal/staging must belong to the (2) name, saw: " + mine.join(", "));
  });

  // ---- where the derived paths go -----------------------------------------
  suite.group("position-derived paths follow the final name");

  await suite.test("the journal and staging of a renamed transfer hang on '(2)', not on the user's file", async () => {
    const home = await makeHome("derived", { overwriteExisting: "rename", maxConnections: 1 });
    const dir = await makeOutDir("derived");
    const target = path.join(dir, "user.bin");
    await plantSentinel(target);

    // A trickling origin (4 KB every 10 ms) keeps the transfer alive long
    // enough to observe its scratch files.
    const slowUrl = origin.origin + "/throttle/" + (2 * 1024 * 1024) + "/4096/10";
    const { child, done } = spawnCli(["get", slowUrl, "-o", target, "-q"], { home });
    const seen = await waitForNames(dir, "user (2).bin");
    try { child.kill(); } catch { /* already gone */ }
    await done;
    await sleep(150);

    assert.ok(seen.length, "the transfer never showed a scratch file under 'user (2).bin'; " +
      "the directory held: " + JSON.stringify(await fsp.readdir(dir)));
    const wrong = (await fsp.readdir(dir)).filter((n) => n.startsWith("user.bin."));
    assert.deepEqual(wrong, [], "no scratch may be derived from the user's own name, saw: " + wrong.join(", "));
    assert.equal(sha256(await fsp.readFile(target)), SENTINEL_SHA,
      "an interrupted renamed transfer must not have written into the user's file");
  });

  // ---- resume must not be blocked by its own leftovers --------------------
  suite.group("an interrupted transfer resumes under its own name");

  await suite.test("a leftover journal of the same URL does not push the resume to 'name (2)'", async () => {
    const home = await makeHome("resume", { overwriteExisting: "rename", maxConnections: 1 });
    const dir = await makeOutDir("resume");
    const target = path.join(dir, "resume.bin");
    const slowUrl = origin.origin + "/throttle/" + (2 * 1024 * 1024) + "/4096/10";

    const first = spawnCli(["get", slowUrl, "-o", target, "-q"], { home });
    // Wait for the staging file, not merely the journal: the resume case is
    // defined by BOTH halves being present (see isResumingSelf in
    // src/downloader.mjs), and the journal directory is created first.
    const seen = await waitForNames(dir, "resume.bin.downloadx-part");
    try { first.child.kill(); } catch { /* gone */ }
    await first.done;
    await sleep(150);
    assert.ok(seen.length, "the interrupted transfer left no staging file; the directory held: " +
      JSON.stringify(await fsp.readdir(dir)));
    assert.ok(fs.existsSync(target + ".downloadx"),
      "the journal must still be there, saw: " + JSON.stringify(await fsp.readdir(dir)));
    assert.ok(fs.existsSync(target + ".downloadx-part"),
      "the staging file must still be there, saw: " + JSON.stringify(await fsp.readdir(dir)));

    const state = JSON.parse(await fsp.readFile(path.join(target + ".downloadx", "state.json"), "utf8"));
    assert.equal(state.url, slowUrl, "the journal must name the URL being resumed");

    const second = await runCli(["get", slowUrl, "-o", target, "-q"], { home });
    assert.equal(second.code, 0, "the resume must succeed, stderr was: " + second.err.trim());
    const names = await fsp.readdir(dir);
    assert.ok(names.includes("resume.bin"), "the resume must keep the requested name, saw: " + names.join(", "));
    assert.ok(!names.some((n) => /^resume \(2\)/.test(n)),
      "a transfer must not be renamed by its own unfinished scratch, saw: " + names.join(", "));
    const size = (await fsp.stat(target)).size;
    assert.ok(size > 0 && size <= 2 * 1024 * 1024, "the resumed file must hold the payload, got " + size + " bytes");
  });

  // ---- the streaming path (unknown length) --------------------------------
  suite.group("unknown-length streaming path");

  await suite.test("streaming rename writes beside the existing file", async () => {
    const home = await makeHome("stream-rename", { overwriteExisting: "rename" });
    const dir = await makeOutDir("stream-rename");
    const target = path.join(dir, "stream.bin");
    await plantSentinel(target);

    const r = await runCli(["get", origin.origin + "/chunked/" + SIZE, "-o", target, "-q"], { home });
    assert.equal(r.code, 0, "the streaming path must obey rename, stderr: " + r.err.trim());
    assert.equal(sha256(await fsp.readFile(target)), SENTINEL_SHA, "the existing file must be untouched");
    assert.equal(sha256(await fsp.readFile(path.join(dir, "stream (2).bin"))), PAYLOAD_SHA,
      "the streamed bytes must land in 'stream (2).bin'");
  });

  await suite.test("streaming skip refuses without touching the file", async () => {
    const home = await makeHome("stream-skip", { overwriteExisting: "skip" });
    const dir = await makeOutDir("stream-skip");
    const target = path.join(dir, "stream.bin");
    await plantSentinel(target);

    const r = await runCli(["get", origin.origin + "/chunked/" + SIZE, "-o", target, "-q"], { home });
    assert.notEqual(r.code, 0, "skip must refuse on the streaming path too");
    assert.match(r.err, /ALREADY_EXISTS/, "stderr was: " + r.err.trim());
    assert.equal(sha256(await fsp.readFile(target)), SENTINEL_SHA, "the file must be untouched");
    assert.deepEqual((await fsp.readdir(dir)).sort(), ["stream.bin"], "nothing else may appear");
  });

  // ---- the HLS/DASH path --------------------------------------------------
  suite.group("media path (HLS) obeys the same policy");

  await suite.test("HLS + skip refuses with [ALREADY_EXISTS] and leaves the file byte-identical", async () => {
    const home = await makeHome("hls-skip", { overwriteExisting: "skip" });
    const dir = await makeOutDir("hls-skip");
    const target = path.join(dir, "stream.ts");
    await plantSentinel(target);

    const r = await runCli(
      ["get", origin.origin + "/hls/master.m3u8", "-o", target, "--kind", "hls", "-q"], { home });
    assert.notEqual(r.code, 0, "skip must refuse a media target too");
    assert.match(r.err, /\[ALREADY_EXISTS\]/,
      "the media path must carry the same [CODE] prefix as the HTTP path, stderr was: " + r.err.trim());
    assert.equal(sha256(await fsp.readFile(target)), SENTINEL_SHA, "the protected file must be untouched");
    assert.deepEqual((await fsp.readdir(dir)).sort(), ["stream.ts"], "and no track file may be left behind");
  });

  // ---- --dry-run must stay read-only --------------------------------------
  suite.group("--dry-run");

  await suite.test("--dry-run decides the name but writes no file at all", async () => {
    const home = await makeHome("dry", { overwriteExisting: "rename" });
    const dir = await makeOutDir("dry");
    const target = path.join(dir, "user.bin");
    await plantSentinel(target);

    const r = await runCli(["get", url, "-o", target, "--dry-run"], { home });
    assert.equal(r.code, 0, "--dry-run must succeed, stderr: " + r.err.trim());
    assert.deepEqual((await fsp.readdir(dir)).sort(), ["user.bin"],
      "a dry run must not create the '(2)' artefact it reports");
    assert.equal(sha256(await fsp.readFile(target)), SENTINEL_SHA, "and must not touch the existing file");
    assert.match(r.err + r.out, /user \(2\)\.bin/, "it should still say where the artefact would land");
  });

  // ---- D5: a mkdir failure must name the path the user typed --------------
  suite.group("mkdir failure message (D5)");

  await suite.test("the error names the requested path, not an internal long-path spelling", async () => {
    const home = await makeHome("mkdir", {});
    const bad = "Z:/npm-nonexistent-dir/a.bin";
    const r = await runCli(["get", url, "-o", bad, "-q"], { home });
    assert.equal(r.code, 1, "an unwritable destination must exit 1, got " + r.code);
    assert.ok(r.err.includes(bad), "the message must contain '" + bad + "', got: " + r.err.trim());
    assert.ok(!/mkdir '\?\?'/.test(r.err), "the internal spelling must be gone, got: " + r.err.trim());
  });

  await suite.test("the same readable message covers the HLS/DASH folder creation", async () => {
    // The media strategies create their own folder in runMediaGet(); a failure
    // there used to leak Node's internal long-path spelling just the same.
    const home = await makeHome("mkdir-media", {});
    const badDir = "Z:/npm-nonexistent-dir/hls-out/";
    const r = await runCli(["get", origin.origin + "/hls/master.m3u8", "-o", badDir, "--kind", "hls", "-q"], { home });
    assert.equal(r.code, 1, "an unwritable destination must exit 1, got " + r.code);
    assert.ok(r.err.includes(badDir), "the message must contain '" + badDir + "', got: " + r.err.trim());
    assert.ok(!/mkdir '\?\?'/.test(r.err), "the internal spelling must be gone, got: " + r.err.trim());
  });

  // ---- one rule, two callers ---------------------------------------------
  suite.group("the policy lives in one function");

  await suite.test("chooseOutputName answers rename / skip / overwrite / resume on its own", async () => {
    const { chooseOutputName } = await import("../src/downloader.mjs");
    const taken = new Set(["C:\\tmp\\a.bin", "c:\\tmp\\a.bin", "C:\\tmp\\a (2).bin", "c:\\tmp\\a (2).bin"]);
    const isTaken = async (p) => taken.has(p) || taken.has(p.toLowerCase());
    const requested = "C:\\tmp\\a.bin";

    const renamed = await chooseOutputName({ requested, policy: "rename", isTaken });
    assert.equal(renamed.target, "C:\\tmp\\a (3).bin", "rename must pick the first free '(n)' name");
    assert.equal(renamed.renamed, true);

    let skipErr = null;
    try { await chooseOutputName({ requested, policy: "skip", isTaken }); } catch (err) { skipErr = err; }
    assert.ok(skipErr && skipErr.code === "ALREADY_EXISTS", "skip must refuse a taken name");

    const over = await chooseOutputName({ requested, policy: "overwrite", isTaken });
    assert.equal(over.target, requested, "overwrite keeps the requested path");

    const resumed = await chooseOutputName({
      requested, policy: "rename", isTaken, isResuming: async () => true,
    });
    assert.equal(resumed.target, requested, "a resuming transfer keeps its own name");
    assert.equal(resumed.renamed, false);
  });

  await suite.test("both callers really call that one function", async () => {
    const dl = await fsp.readFile(path.join(ROOT, "src", "downloader.mjs"), "utf8");
    const cli = await fsp.readFile(path.join(ROOT, "src", "cli.mjs"), "utf8");
    assert.ok(dl.includes("export async function chooseOutputName("), "the rule must be exported from downloader.mjs");
    assert.equal((dl.match(/await chooseOutputName\(\{/g) || []).length, 1,
      "the daemon must call it from exactly one place (#pickName)");
    assert.ok(cli.includes("await chooseOutputName({"), "the CLI must call the same function");
  });
} finally {
  await origin.close();
  await fsp.rm(workRoot, { recursive: true, force: true });
}

process.stdout.write(suite.report());
process.exit(suite.failed ? 1 : 0);
