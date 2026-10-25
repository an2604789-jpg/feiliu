// Batch-8 regression: the BT delegate consumes the SAME per-run proxy decision
// as every other strategy (P-22).
//
// The defect this guards against: bt.mjs built --all-proxy from
// `task.proxy || config.get("proxy")` on its own. The downloader's per-run
// selection (selectRunProxy, batch-7) had already collapsed proxyMode onto
// prepared.proxy — but the BT delegate kept a private fallback to the Settings
// value, so in mode "none" a configured proxy was resurrected behind the GUI's
// "直连=忽略一切代理" promise (the 11th straggler of the family batch-7
// cleaned in downloader.mjs), and a system-mode discovery never reached
// aria2c at all. Now bt.mjs forwards exactly task.proxy — which IS
// prepared.proxy, the selectRunProxy output — and has no proxy opinion of its
// own.
//
// What is proven here, on the real production path (real Config + real
// Downloader.run() → selectRunProxy → real runBt → spawned aria2c stand-in):
//   * none mode: the Settings proxy must NOT appear as --all-proxy;
//   * manual mode: the Settings proxy is forwarded as --all-proxy;
//   * system mode: the discovered proxy is forwarded (and outranks the
//     Settings fallback);
//   * system mode with no discovery: the Settings fallback flows through;
//   * a per-task proxy still wins, even in none mode;
//   * the transfer itself still lands: the delegate's success path (staging,
//     rename, hash, staging cleanup) is unaffected by the proxy change.
//
// The aria2c stand-in is a zero-dependency .mjs the engine runs under its own
// node interpreter (bt.mjs commandFor), records its full argv to a dump file,
// drops one payload file into --dir and exits 0. Everything runs in a
// throwaway DOWNLOADX_HOME: no public network, no real torrent swarm, no
// user Downloads, no %APPDATA%\downloadx, nothing under D:/IAM/downloadx-data.
//
// Usage: node test/batch8-tails.mjs

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NL = String.fromCharCode(10);

/** The proxy a stray fallback would resurrect (must never be used in none). */
const CONFIG_PROXY = "http://config-fallback:9";
/** The proxy a system-mode discovery would find (seeded, never dialed). */
const SYS_PROXY = "http://sys-disc:1";
/** The proxy a task may name for itself (outranks every mode). */
const TASK_PROXY = "http://task-proxy:7";

/** The aria2c stand-in: records argv, fakes a one-file completed download. */
const ARIA2C_STANDIN = [
  "// aria2c stand-in for batch8-tails: dump argv, land one file, exit 0.",
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "const args = process.argv.slice(2);",
  "try { fs.writeFileSync(process.env.DX_BT_ARGDUMP, JSON.stringify(args), 'utf8'); } catch { /* the test reads the dump */ }",
  "let dir = '.';",
  "for (const a of args) if (a.startsWith('--dir=')) dir = a.slice('--dir='.length);",
  "const out = path.join(dir, 'batch8-payload.bin');",
  "fs.writeFileSync(out, Buffer.from('batch8 tails payload'));",
  "console.log('download completed: ' + out);",
  "process.exit(0);",
].join(NL);

async function main() {
  const suite = new Suite("batch8-tails");
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + (r.ms > 400 ? "  (" + r.ms + "ms)" : "") + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " + String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-batch8-tails-"));
  const out = path.join(home, "out");
  await fsp.mkdir(out, { recursive: true });
  process.env.DOWNLOADX_HOME = home;

  const aria2c = path.join(home, "aria2c-standin.mjs");
  await fsp.writeFile(aria2c, ARIA2C_STANDIN, "utf8");

  let dumpSeq = 0;
  /** Run one BT task and return the argv the stand-in saw. */
  const runBtArgs = async (downloader, task) => {
    const dump = path.join(home, "argv-" + (++dumpSeq) + ".json");
    process.env.DX_BT_ARGDUMP = dump;
    try {
      await downloader.run(task);
    } finally {
      delete process.env.DX_BT_ARGDUMP;
    }
    return JSON.parse(await fsp.readFile(dump, "utf8"));
  };
  const allProxy = (args) => {
    const hits = args.filter((a) => String(a).startsWith("--all-proxy="));
    return hits.length === 0 ? null : hits[0].slice("--all-proxy=".length);
  };

  const servers = []; // none — the stand-in never dials; kept for symmetry
  try {
    const { Config } = await import("../src/config.mjs");
    const { Downloader } = await import("../src/downloader.mjs");
    const sysproxy = await import("../src/sysproxy.mjs");

    const config = new Config(path.join(home, "config.json"));
    await config.load();
    await config.set({
      defaultDir: out,
      categorizeByType: false,
      overwriteExisting: "overwrite",
      maxRetries: 0,
      retryBaseMs: 50,
      aria2cPath: aria2c,
      proxy: CONFIG_PROXY,
    });
    const downloader = new Downloader({ config, queue: null });

    const magnet = "magnet:?xt=urn:btih:0000000000000000000000000000000000000000&dn=batch8-tails";
    const taskFor = (id, extra = {}) => ({
      id, url: magnet, kind: "bt", filename: id + ".bin", ...extra,
    });

    // ================================================== proxy source (P-22)
    suite.group("BT forwards the downloader's per-run proxy decision (P-22)");

    await suite.test("none mode: the Settings proxy must NOT reach aria2c", async () => {
      await config.set({ proxyMode: "none", proxy: CONFIG_PROXY });
      const args = await runBtArgs(downloader, taskFor("none-bt"));
      assert.equal(allProxy(args), null,
        "mode none means direct: no --all-proxy may exist, got " + allProxy(args));
      assert.ok(args.some((a) => String(a).startsWith("--dir=")), "the stand-in saw real aria2 args");
    });

    await suite.test("manual mode: the Settings proxy is forwarded as --all-proxy", async () => {
      await config.set({ proxyMode: "manual", proxy: CONFIG_PROXY });
      const args = await runBtArgs(downloader, taskFor("manual-bt"));
      assert.equal(allProxy(args), CONFIG_PROXY);
    });

    await suite.test("system mode: the discovered proxy is forwarded and outranks the fallback", async () => {
      // Seed the discovery cache exactly as resolveSystemProxy would leave it
      // (the downloader's own call inside run() then reads the 30s cache — no
      // real registry is touched on this machine).
      const seeded = await sysproxy.resolveSystemProxy({
        platform: "linux", force: true,
        env: { all_proxy: SYS_PROXY },
      });
      assert.equal(seeded.http, SYS_PROXY, "the seeded discovery must be in place");
      await config.set({ proxyMode: "system", proxy: CONFIG_PROXY });
      const args = await runBtArgs(downloader, taskFor("system-bt"));
      assert.equal(allProxy(args), SYS_PROXY,
        "the system discovery must ride --all-proxy, not the Settings fallback");
    });

    await suite.test("system mode with no discovery: the Settings fallback flows through", async () => {
      const seeded = await sysproxy.resolveSystemProxy({ platform: "linux", force: true, env: {} });
      assert.equal(seeded, null, "an empty environment discovers nothing");
      await config.set({ proxyMode: "system", proxy: CONFIG_PROXY });
      const args = await runBtArgs(downloader, taskFor("system-fallback-bt"));
      assert.equal(allProxy(args), CONFIG_PROXY);
    });

    await suite.test("a per-task proxy wins over every mode, none included", async () => {
      await config.set({ proxyMode: "none", proxy: CONFIG_PROXY });
      const args = await runBtArgs(downloader, taskFor("task-bt", { proxy: TASK_PROXY }));
      assert.equal(allProxy(args), TASK_PROXY);
      const hits = args.filter((a) => String(a).startsWith("--all-proxy="));
      assert.equal(hits.length, 1, "exactly one --all-proxy may be sent");
    });

    // =============================================== the transfer still lands
    suite.group("the delegate's own success path is untouched");

    await suite.test("the payload lands at the reserved target and staging is cleaned", async () => {
      await config.set({ proxyMode: "none", proxy: CONFIG_PROXY });
      const id = "landing-bt";
      const r = await downloader.run(taskFor(id));
      assert.equal(r.ok, true, "the BT run must succeed through the stand-in");
      assert.equal(r.meta.engine, "aria2c");
      const target = path.join(out, id + ".bin");
      assert.equal(fs.existsSync(target), true, "the payload must be published at the target");
      assert.equal((await fsp.readFile(target, "utf8")), "batch8 tails payload");
      assert.equal(r.sha256 !== null, true, "a single-file result is hashed");
      assert.equal(fs.existsSync(target + ".downloadx"), false, "success cleans its own staging family");
    });
  } finally {
    for (const s of servers) { try { s.close?.(); } catch { /* none */ } }
    delete process.env.DX_BT_ARGDUMP;
    delete process.env.DOWNLOADX_HOME;
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch8-tails crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
