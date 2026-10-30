#!/usr/bin/env node
// Batch-9 engine regression (W2 施工包): 孤儿治理 / 剪贴板回环 / 打包排除 / yt-dlp chmod。
//
// What this guards:
//   (2a) src/ytdlp.mjs exports ytDlpAssetName; downloadYtDlp chmods the
//        landed artefact 0o755 (exercised for real through a loopback
//        "release server" into a temp DOWNLOADX_APPROOT); findYtDlp carries
//        the exists-but-not-executable self-heal (source-level pin — the
//        X_OK probe degrades to existence on Windows, so the heal branch
//        itself is POSIX-only and cannot fire on this machine);
//   (第3项) both yt-dlp spawns are detached on non-Windows, the delegate
//        records child.pid into task meta through the queue's existing
//        write-temp-then-rename persistence and clears it at terminal state,
//        reconcileOrphans is a pure exported function (live recorded pid of
//        a non-running task is killed and its field cleared; running tasks,
//        dead pids and pid-less records are left alone), and Daemon.init()
//        runs it once at startup — proven end to end: a queue.json seeded
//        with a live pid loses the process and the field, and the cleanup
//        is persisted back to queue.json;
//   (第10项) the clipboard handler skips loopback URLs (localhost /
//        127.0.0.0/8 / ::1) only in the not-pending else branch; with
//        ask-before-add on, a loopback URL still goes to the pending pen
//        (现状防回归); manual adds are never filtered — a loopback URL from
//        a non-clipboard source still enters the queue (local dev servers
//        are legitimate); a normal clipboard URL still queues;
//   (第11项) build.files carries "!**/*-bak" and "!**/*.bak-*", and no
//        backup file under desktop/ or extension/ escapes those two rules
//        (everything matching pre-task/p0c/bak-tray/.bak must end in -bak
//        or carry a .bak- marker); desktop/main.mjs.bak-tray-20261023 has
//        been renamed to end in -bak.
//
// Everything runs in throwaway DOWNLOADX_HOMEs under os.tmpdir(); the
// production data root is never touched; no window is opened; the only
// processes killed are ones this file spawned itself; no PowerShell is ever
// spawned (monitorClipboard=false + clipboardBridge=true keep the watcher
// unarmed). The process must exit cleanly.
//
// Usage: node test/batch9-engine.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Suite, assert as hassert } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NL = String.fromCharCode(10);

/** process.kill(pid, 0) throws when the pid is gone; true while it lives. */
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Poll until fn() is truthy, else fail with the caller's text. */
async function waitFor(fn, { timeoutMs = 10000, everyMs = 25, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** A quiet live process we own: node -e "setTimeout 120s". Kill via killChild(). */
function spawnSleeper() {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
}
const sleepers = new Set();
function killChild(child) {
  if (!child || child.killed) return;
  sleepers.delete(child);
  try { if (process.platform === "win32") child.kill(); else child.kill("SIGKILL"); } catch { /* gone */ }
}

/** Recursive enumeration of one directory's files (relative names kept). */
async function walkFiles(dir) {
  const out = [];
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walkFiles(p));
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

async function main() {
  const suite = new Suite("batch9-engine");
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else if (r.kind === "skip") process.stdout.write("    SKIP  " + r.text + "  - " + r.reason + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  // Env keys this run fiddles with; every arm restores them.
  const ENV_KEYS = ["DOWNLOADX_HOME", "DOWNLOADX_APPROOT", "DOWNLOADX_YTDLP_RELEASE_BASE"];
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const restoreEnv = () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  const { ytDlpAssetName, downloadYtDlp, reconcileOrphans } = await import("../src/ytdlp.mjs");
  const { isLoopbackUrl } = await import("../src/daemon.mjs");
  const YTDLP_SRC = await fsp.readFile(path.join(ROOT, "src", "ytdlp.mjs"), "utf8");
  const DAEMON_SRC = await fsp.readFile(path.join(ROOT, "src", "daemon.mjs"), "utf8");

  try {
    // ------------------------------------------------------- 2a: chmod + 导出
    suite.group("2a: ytDlpAssetName 导出 + downloadYtDlp chmod + findYtDlp 自愈(源级钉)");

    await suite.test("ytDlpAssetName is exported and names the platform asset", () => {
      hassert.equal(typeof ytDlpAssetName, "function", "must be exported for the tests to derive from");
      hassert.match(ytDlpAssetName(), /^yt-dlp(\.exe|_linux)$/, "a known release asset name");
    });

    await suite.test("source pins: post-download chmod, findYtDlp self-heal, two detached spawns, pid record + clear", () => {
      // 2a:产物落盘后补执行位;旧副本自愈在 findYtDlp 的候选循环里。
      hassert.match(YTDLP_SRC, /await fsp\.chmod\(dest, 0o755\)/, "downloadYtDlp must chmod the artefact");
      hassert.match(YTDLP_SRC, /await fsp\.chmod\(c, 0o755\)/, "findYtDlp must heal a non-executable candidate");
      hassert.match(YTDLP_SRC, /fs\.constants\.X_OK/, "the heal keys off the X_OK probe");
      // 第3项:两处 spawn 都带 detached(仅非 Windows)。
      const detached = YTDLP_SRC.match(/detached: process\.platform !== "win32"/g) || [];
      hassert.equal(detached.length, 2, "both yt-dlp spawns must be detached on non-Windows, got " + detached.length);
      // 第3项:spawn 成功后 pid 进任务元数据;终态清字段。
      hassert.match(YTDLP_SRC, /ytdlpPid: child\.pid/, "the delegate records child.pid into task meta");
      hassert.match(YTDLP_SRC, /delete live\.meta\.ytdlpPid/, "terminal state clears the pid field");
      // 第3项:daemon 启动钩子调用一次 reconcileOrphans。
      hassert.match(DAEMON_SRC, /await reconcileOrphans\(this\.queue\.tasks\.values\(\)\)/,
        "Daemon.init() must run the orphan sweep once");
      hassert.match(DAEMON_SRC, /import \{ reconcileOrphans \} from "\.\/ytdlp\.mjs";/,
        "the hook imports the ytdlp export");
    });

    await suite.test("downloadYtDlp for real: loopback release server → app root, no .tmp left", async () => {
      const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b9-dl-"));
      const appRoot = path.join(home, "approot");
      await fsp.mkdir(appRoot, { recursive: true });
      process.env.DOWNLOADX_APPROOT = appRoot;
      const server = http.createServer((req, res) => {
        const body = Buffer.alloc(16 * 1024, 0x77);
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
        res.end(body);
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      try {
        process.env.DOWNLOADX_YTDLP_RELEASE_BASE = "http://127.0.0.1:" + server.address().port + "/ytdlp-releases/";
        const dest = await downloadYtDlp();
        hassert.equal(dest, path.join(appRoot, ytDlpAssetName()), "lands under the app root");
        const st = await fsp.stat(dest);
        hassert.equal(st.size, 16 * 1024, "the full body landed");
        const leftovers = (await fsp.readdir(appRoot)).filter((n) => n.endsWith(".tmp"));
        hassert.equal(leftovers.length, 0, "no .tmp sibling left behind (write-temp-then-rename)");
      } finally {
        server.close();
        restoreEnv();
        await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
      }
    });

    // ------------------------------------------- 第3项: reconcileOrphans 单测
    suite.group("第3项: reconcileOrphans 纯函数单测");

    await suite.test("a recorded live pid on a non-running task is killed and its field cleared", async () => {
      const child = spawnSleeper();
      sleepers.add(child);
      await waitFor(() => pidAlive(child.pid), { what: "the sleeper to come up" });
      const task = { id: "t-orphan-1", status: "paused", meta: { ytdlpPid: child.pid } };
      const report = await reconcileOrphans([task]);
      hassert.equal(report.probed, 1);
      hassert.ok(report.killed.includes(child.pid), "the recorded pid must be killed");
      hassert.deepEqual(report.cleared, ["t-orphan-1"], "the record must be cleared");
      await waitFor(() => !pidAlive(child.pid), { what: "the orphan to die" });
      hassert.equal("ytdlpPid" in task.meta, false, "meta.ytdlpPid must be gone");
    });

    await suite.test("a running task's pid is never touched (its delegate owns it)", async () => {
      const child = spawnSleeper();
      sleepers.add(child);
      await waitFor(() => pidAlive(child.pid), { what: "the sleeper to come up" });
      try {
        const task = { id: "t-orphan-2", status: "downloading", meta: { ytdlpPid: child.pid } };
        const report = await reconcileOrphans([task]);
        hassert.equal(report.probed, 0, "running statuses are skipped entirely");
        hassert.deepEqual(report.cleared, []);
        hassert.equal(pidAlive(child.pid), true, "the live process must survive");
        hassert.equal(task.meta.ytdlpPid, child.pid, "the field stays");
      } finally { killChild(child); }
    });

    await suite.test("a dead pid only clears the field (no kill, no throw)", async () => {
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
      await new Promise((r) => child.on("close", r));
      hassert.equal(pidAlive(child.pid), false, "precondition: the pid is free");
      const task = { id: "t-orphan-3", status: "error", meta: { ytdlpPid: child.pid } };
      const report = await reconcileOrphans([task]);
      hassert.equal(report.probed, 1);
      hassert.deepEqual(report.killed, [], "a dead pid must not be 'killed'");
      hassert.deepEqual(report.cleared, ["t-orphan-3"]);
      hassert.equal("ytdlpPid" in task.meta, false);
    });

    await suite.test("records without a usable pid are scanned and left alone", async () => {
      const report = await reconcileOrphans([
        { id: "t-plain", status: "complete", meta: {} },
        { id: "t-nullpid", status: "paused", meta: { ytdlpPid: null } },
        { id: "t-badpid", status: "paused", meta: { ytdlpPid: -4 } },
        { id: "t-nometa", status: "queued" },
      ]);
      hassert.equal(report.scanned, 4);
      hassert.equal(report.probed, 0);
      hassert.deepEqual(report.cleared, []);
      hassert.equal(report.killed.length, 0);
    });

    // ------------------------------------- 第3项: daemon 启动钩子端到端
    suite.group("第3项: Daemon.init 启动孤儿清理(端到端,种子 queue.json)");

    await suite.test("a seeded live pid in queue.json is killed, cleared and persisted at init", async () => {
      const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b9-hook-"));
      process.env.DOWNLOADX_HOME = home;
      let child = null;
      let daemon = null;
      try {
        // Seed queue.json through the queue's own persistence (same
        // write-temp-then-rename path the daemon later reads).
        const { Config } = await import("../src/config.mjs");
        const { QueueManager } = await import("../src/queue.mjs");
        const { paths } = await import("../src/paths.mjs");
        const cfg = new Config(paths.config);
        await cfg.load();
        await cfg.set({
          defaultDir: path.join(home, "out"),
          monitorClipboard: false,
          clipboardBridge: true,          // keep the PowerShell watcher unarmed
          proxyMode: "none",
          captureProxy: { enabled: false },
        });
        const q = new QueueManager({ config: cfg });
        await q.load();
        q.pauseAll();                      // no runner exists here; keep pump quiet
        const t = q.add({ url: "https://example.com/x.bin", filename: "x.bin", dir: path.join(home, "out") });
        child = spawnSleeper();
        sleepers.add(child);
        await waitFor(() => pidAlive(child.pid), { what: "the seeded orphan to come up" });
        q.apply(t.id, { meta: { ytdlpPid: child.pid } });
        await q.saveNow();
        const seeded = JSON.parse(await fsp.readFile(paths.queue, "utf8"));
        hassert.equal(seeded.tasks[0].meta.ytdlpPid, child.pid, "precondition: pid on disk");

        daemon = new (await import("../src/daemon.mjs")).Daemon();
        await daemon.init();
        hassert.equal(pidAlive(child.pid), false, "the startup hook must kill the recorded orphan");
        const after = JSON.parse(await fsp.readFile(paths.queue, "utf8"));
        hassert.equal("ytdlpPid" in after.tasks[0].meta, false, "the field must be cleared on disk");
        hassert.ok(daemon.log.tailLines(50).some((l) => l.includes("启动孤儿清理")),
          "the startup sweep must leave its log line");
      } finally {
        try { daemon && daemon.canary && daemon.canary.stop(); } catch { /* down */ }
        try { daemon && daemon.clipboard && daemon.clipboard.stop(); } catch { /* down */ }
        try { daemon && daemon.pending && daemon.pending.dispose(); } catch { /* down */ }
        if (child && pidAlive(child.pid)) killChild(child);
        restoreEnv();
        await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
      }
    });

    // ---------------------------------------------- 第10项: 剪贴板回环
    suite.group("第10项: 剪贴板回环(挂起路径不动,未挂起才拦,manual 不拦)");

    await suite.test("isLoopbackUrl judges hosts, not schemes, and never throws", () => {
      for (const good of [
        "http://localhost:8045/v1", "https://localhost/x",
        "http://127.0.0.1:8045/v1", "http://127.9.9.9/x", "https://127.0.0.1/",
        "http://[::1]:9000/x", "ftp://127.0.0.1/file.bin",
      ]) hassert.equal(isLoopbackUrl(good), true, good);
      for (const bad of [
        "https://example.com/x", "http://localhost.example.com/", "http://127.0.0.1.evil.com/",
        "http://10.0.0.1/x", "not a url", "", null,
      ]) hassert.equal(isLoopbackUrl(bad), false, String(bad));
    });

    // Both daemon arms share this: a daemon whose clipboard watcher is unarmed
    // and whose queue can never promote (pauseAll), so emitting "url" events
    // exercises the handler and nothing ever downloads.
    async function makeDaemon(home, { askBeforeAdd }) {
      process.env.DOWNLOADX_HOME = home;
      const { Config } = await import("../src/config.mjs");
      const { paths } = await import("../src/paths.mjs");
      const { Daemon } = await import("../src/daemon.mjs");
      const cfg = new Config(paths.config);
      await cfg.load();
      await cfg.set({
        defaultDir: path.join(home, "out"),
        monitorClipboard: false,
        clipboardBridge: true,            // the watcher must never arm in tests
        askBeforeAdd,
        proxyMode: "none",
        captureProxy: { enabled: false },
      });
      const daemon = new Daemon();
      await daemon.init();
      daemon.queue.pauseAll();            // queue.add must not start transfers
      return daemon;
    }
    async function teardownDaemon(daemon) {
      try { daemon.canary.stop(); } catch { /* down */ }
      try { daemon.clipboard.stop(); } catch { /* down */ }
      try { daemon.pending.dispose(); } catch { /* down */ }
    }

    await suite.test("pending enabled: clipboard loopback still goes to the pen (现状防回归)", async () => {
      const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b9-clip-a-"));
      let daemon = null;
      try {
        daemon = await makeDaemon(home, { askBeforeAdd: true });
        daemon.clipboard.emit("url", "http://127.0.0.1:8045/v1/files?h=1");
        hassert.equal(daemon.pending.list().length, 1, "the loopback URL waits in the pending pen");
        hassert.equal(daemon.pending.list()[0].queueId, "clipboard");
        hassert.equal(daemon.queue.tasks.size, 0, "nothing enters the queue behind ask-before-add");
      } finally {
        if (daemon) await teardownDaemon(daemon);
        restoreEnv();
        await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
      }
    });

    await suite.test("pending disabled: clipboard loopback is skipped with the log line; a normal URL still queues", async () => {
      const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b9-clip-b-"));
      let daemon = null;
      try {
        daemon = await makeDaemon(home, { askBeforeAdd: false });
        daemon.clipboard.emit("url", "http://127.0.0.1:8045/v1/files?h=2");
        hassert.equal(daemon.queue.tasks.size, 0, "the loopback URL must not enter the queue");
        hassert.equal(daemon.pending.list().length, 0, "and pending is off, so the pen stays empty too");
        hassert.ok(daemon.log.tailLines(50).some((l) => l.includes("剪贴板回环地址已跳过: http://127.0.0.1:8045/v1/files?h=2")),
          "the skip must be logged verbatim");
        // 正常 URL 行为不变(非回环 host 照旧入队)。
        daemon.clipboard.emit("url", "https://example.com/video.mp4?h=3");
        hassert.equal(daemon.queue.tasks.size, 1, "a normal clipboard URL still queues");
        hassert.equal([...daemon.queue.tasks.values()][0].url, "https://example.com/video.mp4?h=3");
      } finally {
        if (daemon) await teardownDaemon(daemon);
        restoreEnv();
        await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
      }
    });

    await suite.test("pending disabled: a manual loopback add still enters the queue (本地服务是正当用法)", async () => {
      const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b9-clip-c-"));
      let daemon = null;
      try {
        daemon = await makeDaemon(home, { askBeforeAdd: false });
        // The manual path never passes the clipboard handler: a plain queue.add
        // with a loopback URL must land untouched — this pins that the filter
        // lives in the clipboard branch only, not in queue.add itself.
        daemon.queue.add({ url: "http://127.0.0.1:9999/asset.bin", queueId: "default" });
        hassert.equal(daemon.queue.tasks.size, 1, "manual loopback adds are legitimate");
        hassert.equal([...daemon.queue.tasks.values()][0].url, "http://127.0.0.1:9999/asset.bin");
        // And the clipboard handler is still the one skipping its own source:
        daemon.clipboard.emit("url", "http://localhost:8045/v2?h=4");
        hassert.equal(daemon.queue.tasks.size, 1, "clipboard loopback still skipped beside it");
      } finally {
        if (daemon) await teardownDaemon(daemon);
        restoreEnv();
        await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
      }
    });

    // ------------------------------------------------ 第11项: 打包排除
    suite.group("第11项: 打包排除备份文件");

    await suite.test("build.files carries both new exclusion rules at the tail", async () => {
      const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, "package.json"), "utf8"));
      const files = pkg.build && pkg.build.files;
      hassert.ok(Array.isArray(files), "build.files must be a list");
      hassert.ok(files.includes("!**/*-bak"), "missing !**/*-bak");
      hassert.ok(files.includes("!**/*.bak-*"), "missing !**/*.bak-*");
      hassert.ok(files.indexOf("!**/*-bak") > files.indexOf("src/**/*"), "exclusions must sit after the includes");
    });

    await suite.test("desktop/ + extension/: no backup file escapes the two rules (all end in -bak or carry .bak-)", async () => {
      const looksLikeBackup = /pre-task|p0c|bak-tray|\.bak[\.\-_]|-bak/i;
      const offenders = [];
      for (const dir of ["desktop", "extension"]) {
        for (const file of await walkFiles(path.join(ROOT, dir))) {
          const base = path.basename(file);
          if (!looksLikeBackup.test(base)) continue;
          // The two new globs match exactly these two shapes; anything else
          // would ship in the app.
          if (base.endsWith("-bak") || /\.bak-/.test(base)) continue;
          offenders.push(path.relative(ROOT, file));
        }
      }
      hassert.deepEqual(offenders, [], "backup files not covered by !**/*-bak / !**/*.bak-*");
    });

    await suite.test("desktop/main.mjs.bak-tray-20261023 is renamed to the -bak ending", async () => {
      hassert.equal(fs.existsSync(path.join(ROOT, "desktop", "main.mjs.bak-tray-20261023")), false,
        "the old .bak-tray-<date> name must be gone");
      hassert.ok(fs.existsSync(path.join(ROOT, "desktop", "main.mjs.bak-tray-20261023-bak")),
        "the renamed backup must exist");
    });
  } finally {
    restoreEnv();
    for (const child of [...sleepers]) killChild(child);
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch9-engine crashed: " + ((err && err.stack) || err) + NL);
    process.exitCode = 1;
  });
