// Batch-4 regression: magnet/BT via external aria2c delegation.
//
// Covers the P-2/P-3 acceptance:
//   (a) detectKind: magnet:?xt= and *.torrent -> "bt", decided BEFORE the
//       human-refusal guard (which still fires for blob:/data: as before);
//   (b) a magnet task end-to-end: queued -> delegated to (fake) aria2c ->
//       console progress parsed (percentage marked approximate, "约 x%") ->
//       artefact landed at the policy-resolved path -> sha256 recorded;
//   (c) the rename policy applies to BT outputs like to any other task;
//   (d) the proxy follows the downloader's per-run decision only (P-22 批-8
//       re-pin: none mode drops the Settings proxy, manual forwards it);
//   (e) cancel kills the WHOLE process tree (taskkill /T semantics): the
//       hung aria2c AND its grandchild are gone, nothing is published, the
//       staging family is discarded;
//   (f) a missing aria2c fails the task with the human-readable P-3 message
//       (never an empty error);
//   (g) an aria2c that exits at startup fails the task with the exit code
//       and the console tail in the error;
//   (h) a .torrent URL is a BT task too, end to end.
//
// No real aria2c is needed even when one sits on PATH (批-8: the missing-arm
// pins a broken configured path, authoritative in findAria2c): the fixture
// test/fixtures/fake-aria2c.mjs imitates its console surface. Everything
// runs in an isolated DOWNLOADX_HOME (temp dir), no public network, no user
// Downloads, no D:/IAM/downloadx-data, and the process exits clean.
//
// Usage: node test/batch4-magnet.mjs

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FAKE_ARIA2C = path.join(HERE, "fixtures", "fake-aria2c.mjs");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** The exact deterministic body the fake aria2c writes in "ok" mode. */
function fakeBody() {
  const chunk = Buffer.from("downloadx fake aria2c payload" + String.fromCharCode(10), "utf8");
  const parts = [];
  for (let i = 0; i < 4096; i++) parts.push(chunk);
  return Buffer.concat(parts);
}

async function waitFor(fn, { timeoutMs = 30000, everyMs = 50, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** process.kill(pid, 0) throws when the pid is gone; false while it lives. */
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const MAGNET_OK = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=fake-show";

async function main() {
  const suite = new Suite("batch4-magnet");
  const NL = String.fromCharCode(10);
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b4-magnet-"));
  const out = path.join(home, "out");
  await fsp.mkdir(out, { recursive: true });
  process.env.DOWNLOADX_HOME = home;

  const { detectKind } = await import("../src/downloader.mjs");
  const { findAria2c, resetAria2cCache, parseAria2Summary } = await import("../src/bt.mjs");
  const { Config } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { Downloader } = await import("../src/downloader.mjs");
  const { ApiServer } = await import("../src/api.mjs");

  const config = new Config(path.join(home, "config.json"));
  await config.load();
  await config.set({
    defaultDir: out,
    categorizeByType: false,
    overwriteExisting: "rename",
    proxy: "",
    proxyMode: "none",
    aria2cPath: FAKE_ARIA2C,
  });

  const queue = new QueueManager({ config });
  await queue.load();
  const downloader = new Downloader({ config, queue });
  const api = new ApiServer({
    queue, config, downloader,
    log: { info() {}, warn() {}, error() {}, tail: () => [] },
  }).startRunner();
  const listening = await api.listen({ port: 0 });

  const call = async (method, route, body) => {
    const headers = { "x-downloadx-token": listening.token };
    if (body) headers["content-type"] = "application/json";
    const res = await fetch("http://127.0.0.1:" + listening.port + route, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  };
  const taskById = async (id) => (await call("GET", "/api/tasks/" + id)).json.task ?? null;

  /** Downloader events, captured per task id for progress assertions. */
  const progressFrames = new Map();   // taskId -> [{...}]
  const resolvedTargets = new Map();  // taskId -> target
  downloader.on("progress", (p) => {
    if (!p || !p.taskId) return;
    if (!progressFrames.has(p.taskId)) progressFrames.set(p.taskId, []);
    progressFrames.get(p.taskId).push(p);
  });
  downloader.on("resolved", (p) => { if (p && p.taskId && p.target) resolvedTargets.set(p.taskId, p.target); });

  /** Set the fake's mode/files for one arm; returns a cleanup fn. */
  const armEnv = ({ mode = "ok", argsFile = null, pidFile = null } = {}) => {
    process.env.DOWNLOADX_FAKE_ARIA2C_MODE = mode;
    if (argsFile) process.env.DOWNLOADX_FAKE_ARIA2C_ARGSFILE = argsFile;
    else delete process.env.DOWNLOADX_FAKE_ARIA2C_ARGSFILE;
    if (pidFile) process.env.DOWNLOADX_FAKE_ARIA2C_PIDFILE = pidFile;
    else delete process.env.DOWNLOADX_FAKE_ARIA2C_PIDFILE;
    return () => {
      delete process.env.DOWNLOADX_FAKE_ARIA2C_MODE;
      delete process.env.DOWNLOADX_FAKE_ARIA2C_ARGSFILE;
      delete process.env.DOWNLOADX_FAKE_ARIA2C_PIDFILE;
    };
  };

  const addMagnet = async (url, filename) => {
    const added = await call("POST", "/api/tasks", { url, filename });
    assert.equal(added.status, 201, "add must be accepted: " + JSON.stringify(added.json));
    return added.json.task.id;
  };

  const waitComplete = async (id) => waitFor(async () => {
    const t = await taskById(id);
    if (!t) return false;
    if (t.status === "error") throw new Error("task failed: " + t.error);
    return t.status === "complete" ? t : false;
  }, { timeoutMs: 60000, what: "the BT task to complete" });

  const waitError = async (id) => waitFor(async () => {
    const t = await taskById(id);
    return t && t.status === "error" ? t : false;
  }, { timeoutMs: 60000, what: "the BT task to fail" });

  try {
    // ------------------------------------------------------ kind detection
    suite.group("detectKind: magnet/torrent are bt, before the refusal guard");

    await suite.test("magnet:?xt= and .torrent map to bt; others unchanged", async () => {
      assert.equal(detectKind(MAGNET_OK), "bt");
      assert.equal(detectKind("MAGNET:?xt=urn:btih:ABC"), "bt", "scheme match is case-insensitive");
      assert.equal(detectKind("magnet:?xt=urn:btih:ABC&dn=x"), "bt");
      assert.equal(detectKind("http://example.com/files/ubuntu-24.04.torrent"), "bt");
      assert.equal(detectKind("https://x.example/a/b.TORRENT?from=page"), "bt");
      // The families that already existed keep their answers.
      assert.equal(detectKind("http://example.com/file.bin"), "http");
      assert.equal(detectKind("ftp://example.com/file.bin"), "ftp");
      assert.equal(detectKind("https://cdn.example/playlist.m3u8"), "hls");
      assert.equal(detectKind("https://cdn.example/manifest.mpd"), "dash");
      // And the human-refusal guard still fires, with its own message.
      let refused = null;
      try { detectKind("blob:https://page/uuid"); } catch (err) { refused = err; }
      assert.ok(refused, "blob: must still be refused");
      assert.match(refused.message, /网页内存中的地址/);
    });

    await suite.test("console summary parsing: percent marked approximate, unknown totals honest", async () => {
      const meta = parseAria2Summary("[#f10b2c 0B/0B CN:16 DL:0B]");
      assert.ok(meta, "the metadata-phase line must parse");
      assert.equal(meta.totalBytes, null, "unknown totals stay null, no percent invented");
      assert.equal(meta.percent, null);
      const quarter = parseAria2Summary("[#f10b2c 30KiB/120KiB(25%) CN:16 DL:96KiB ETA:1s]");
      assert.ok(quarter);
      assert.equal(quarter.bytesWritten, 30 * 1024);
      assert.equal(quarter.totalBytes, 120 * 1024);
      assert.equal(quarter.percent, 25);
      assert.equal(quarter.speed, 96 * 1024);
      const mib = parseAria2Summary("[#8c1a2b 12.5MiB/1.2GiB(1%) CN:8 DL:1.1MiB ETA:3m2s]");
      assert.ok(mib);
      assert.equal(mib.bytesWritten, 12.5 * 1024 * 1024);
      assert.equal(mib.totalBytes, 1.2 * 1024 ** 3);
      assert.equal(parseAria2Summary("2026-10-25 NOTICE - download completed: /x"), null);
      assert.equal(parseAria2Summary("garbage"), null);
    });

    // ------------------------------------------- end to end with the fake
    suite.group("magnet task end to end (fake aria2c, ok mode)");

    let okCleanup = null;
    await suite.test("queued -> delegated -> progress(约) -> landed -> sha256", async () => {
      const argsFile = path.join(home, "args-ok.json");
      okCleanup = armEnv({ mode: "ok", argsFile });
      const id = await addMagnet(MAGNET_OK, "bt-ok.bin");

      const task = await waitComplete(id);
      assert.equal(task.kind, "bt", "the task must run (and report) as bt");
      assert.equal(task.filename, "bt-ok.bin");
      const target = resolvedTargets.get(id);
      assert.equal(target, path.join(out, "bt-ok.bin"), "resolved target must be the requested file");

      // Byte-for-byte against the deterministic fixture body, and the task's
      // recorded sha256 must be the hash of exactly those bytes.
      const body = fakeBody();
      const landed = await fsp.readFile(target);
      assert.equal(landed.length, body.length, "landed size");
      assert.equal(landed.equals(body), true, "landed bytes must be the fixture body");
      assert.equal(task.sha256, sha256(body), "recorded sha256 must match the landed bytes");
      assert.equal(task.downloadedBytes, body.length);
      assert.ok(task.totalBytes >= body.length, "total bytes recorded from the delegate");

      // Progress came from the delegate's console, parsed, percent marked 约.
      // The FINAL 100% frame is exact (it is the hashed, landed byte count),
      // so only the intermediate frames carry the approximation marker.
      const frames = progressFrames.get(id) || [];
      assert.ok(frames.length >= 2, "several progress frames expected, got " + frames.length);
      const pct = frames.filter((f) => typeof f.percent === "number");
      assert.ok(pct.length >= 2, "percentage frames expected");
      const running = pct.filter((f) => f.percent < 100);
      assert.ok(running.length >= 1, "at least one intermediate percentage frame");
      for (const f of running) {
        assert.equal(f.approx, true, "intermediate BT percent frames must be marked approximate");
        assert.match(f.percentNote, /^约 \d+%$/, "percent note must read 约 N%");
      }
      assert.ok(frames.some((f) => f.totalBytes === null && f.percent === null),
        "the metadata phase (unknown total) must be reported honestly");
      assert.ok(frames.some((f) => f.percent === 100), "a final 100% frame must be emitted");

      // The delegation actually spoke aria2c's CLI.
      const argv = JSON.parse(await fsp.readFile(argsFile, "utf8"));
      assert.ok(argv.includes(MAGNET_OK), "the magnet URI must be passed to aria2c");
      assert.ok(argv.some((a) => a.startsWith("--dir=")), "--dir must be passed");
      assert.ok(argv.includes("--console-log-level=notice"));
      assert.ok(argv.includes("--summary-interval=1"));

      // No staging leftovers after success.
      assert.equal(fs.existsSync(target + ".downloadx"), false, "journal family must be gone after success");
      okCleanup();
      okCleanup = null;
    });

    await suite.test("rename policy applies: a taken name lands beside, user file untouched", async () => {
      const taken = path.join(out, "dup-name.bin");
      const sentinel = Buffer.from("pre-existing user file, must not be touched");
      await fsp.writeFile(taken, sentinel);
      const cleanup = armEnv({ mode: "ok" });
      const id = await addMagnet(MAGNET_OK, "dup-name.bin");
      const task = await waitComplete(id);
      const target = resolvedTargets.get(id);
      assert.equal(target, path.join(out, "dup-name (2).bin"),
        "the rename policy must pick the (2) spelling");
      assert.equal(task.filename, "dup-name (2).bin");
      const landed = await fsp.readFile(target);
      assert.equal(landed.equals(fakeBody()), true, "the renamed artefact holds the bytes");
      assert.equal((await fsp.readFile(taken)).equals(sentinel), true, "user's file untouched");
      cleanup();
    });

    await suite.test("proxy follows the downloader's per-run decision only (P-22)", async () => {
      // 批-8 P-22 re-pin: runBt forwards exactly prepared.proxy (selectRunProxy's
      // output) and no longer resurrects config.proxy on its own. This suite
      // runs with proxyMode "none" (global config above), so a Settings proxy
      // must NOT reach aria2c — the GUI's "直连=忽略一切代理" promise — while
      // manual mode forwards the Settings value as --all-proxy. (The five-way
      // matrix, including per-task proxies and system discovery, lives in
      // test/batch8-tails.mjs.)
      const argsFile = path.join(home, "args-proxy.json");
      const cleanup = armEnv({ mode: "ok", argsFile });
      await config.set({ proxy: "http://127.0.0.1:9" });
      try {
        // none + Settings proxy: direct — no --all-proxy at all.
        const id = await addMagnet(MAGNET_OK, "bt-proxy-none.bin");
        await waitComplete(id);
        let argv = JSON.parse(await fsp.readFile(argsFile, "utf8"));
        assert.equal(argv.filter((a) => String(a).startsWith("--all-proxy=")).length, 0,
          "none mode must drop the Settings proxy: " + JSON.stringify(argv));

        // manual + Settings proxy: forwarded through the same decision chain.
        await config.set({ proxyMode: "manual" });
        const id2 = await addMagnet(MAGNET_OK, "bt-proxy-manual.bin");
        await waitComplete(id2);
        argv = JSON.parse(await fsp.readFile(argsFile, "utf8"));
        assert.ok(argv.includes("--all-proxy=http://127.0.0.1:9"),
          "manual mode must forward the Settings proxy: " + JSON.stringify(argv));
      } finally {
        await config.set({ proxy: "", proxyMode: "none" });
        cleanup();
      }
    });

    await suite.test("a .torrent URL is a BT task end to end", async () => {
      const cleanup = armEnv({ mode: "ok" });
      const id = await addMagnet("https://example.com/torrents/some-file.torrent");
      const task = await waitComplete(id);
      assert.equal(task.kind, "bt");
      const target = resolvedTargets.get(id);
      assert.equal(target, path.join(out, "some-file"),
        "fallback name is the torrent file's basename without the extension");
      const landed = await fsp.readFile(target);
      assert.equal(landed.equals(fakeBody()), true);
      cleanup();
    });

    // ------------------------------------------------------------- cancel
    suite.group("cancel kills the whole aria2c tree");

    await suite.test("hung delegate + grandchild die, nothing published, staging discarded", async () => {
      const pidFile = path.join(home, "hang-pids.json");
      const cleanup = armEnv({ mode: "hang", pidFile });
      const id = await addMagnet(MAGNET_OK, "hang.bin");

      // Wait until the delegate is up: the target resolved AND the pidfile
      // written by the fake.
      const target = await waitFor(() => resolvedTargets.get(id),
        { what: "the BT target to be resolved" });
      const pids = await waitFor(async () => {
        try { return JSON.parse(await fsp.readFile(pidFile, "utf8")); } catch { return false; }
      }, { what: "the fake to record its pids" });
      assert.ok(pidAlive(pids.pid), "the delegate must be alive before the cancel");
      assert.ok(pidAlive(pids.childPid), "the grandchild must be alive before the cancel");

      const r = await call("POST", "/api/tasks/" + id + "/cancel");
      assert.equal(r.status, 200, "expected 200, got " + r.status + " " + JSON.stringify(r.json));
      assert.equal(r.json.ok, true);
      assert.equal(r.json.kind, "bt", "cancel must report the kind the transfer ran as");

      // The point of the tree kill: BOTH pids gone.
      await waitFor(() => !pidAlive(pids.pid), { timeoutMs: 15000, what: "the delegate to be killed" });
      await waitFor(() => !pidAlive(pids.childPid),
        { timeoutMs: 15000, what: "the grandchild to be killed (tree, not pid-only)" });

      assert.equal(fs.existsSync(target), false, "a cancelled transfer must not publish a file");
      assert.equal(fs.existsSync(target + ".downloadx"), false, "the staging family must be discarded");
      assert.equal((await call("GET", "/api/tasks/" + id)).status, 404, "task leaves the queue");
      cleanup();
    });

    // ------------------------------------------------- startup failure / missing
    suite.group("delegate failures are human-readable (P-3 closed)");

    await suite.test("aria2c that exits at startup fails the task with code and tail", async () => {
      const cleanup = armEnv({ mode: "instant-exit" });
      const id = await addMagnet(MAGNET_OK, "instant.bin");
      const task = await waitError(id);
      assert.ok(task.error && task.error.length > 0, "the error must not be empty (P-3)");
      assert.match(task.error, /aria2c 委托失败/);
      assert.match(task.error, /退出码 3/);
      assert.match(task.error, /simulated startup failure/, "console tail must be carried into the error");
      cleanup();
    });

    await suite.test("missing aria2c fails with install guidance, immediately", async () => {
      // 批-8 hardening: a real aria2c on PATH (this machine grew one via
      // WinGet Links) must not color this arm. In findAria2c a CONFIGURED
      // path is authoritative — present-but-missing returns null without any
      // ambient search — so pinning a broken path makes "missing" true on
      // every machine (same technique as batch8-ytdlp's magnet guard).
      const brokenAria2c = path.join(home, "nope", "aria2c.exe");
      resetAria2cCache();
      assert.equal(await findAria2c(brokenAria2c), null,
        "a configured but missing path is authoritative-null");
      await config.set({ aria2cPath: brokenAria2c });
      try {
        const id = await addMagnet(MAGNET_OK, "missing.bin");
        const task = await waitError(id);
        assert.ok(task.error && task.error.length > 0, "the error must not be empty (P-3)");
        assert.match(task.error, /磁力链接需要 aria2c 支持/);
        assert.match(task.error, /github\.com\/aria2\/aria2/);
        assert.match(task.error, /指定 aria2c\.exe 路径/);
        assert.equal(fs.existsSync(path.join(out, "missing.bin")), false, "nothing may be published");
        assert.equal(fs.existsSync(path.join(out, "missing.bin") + ".downloadx"), false);
      } finally {
        await config.set({ aria2cPath: FAKE_ARIA2C });
        resetAria2cCache();
      }
    });
  } finally {
    await api.close().catch(() => {});
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch4-magnet crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
