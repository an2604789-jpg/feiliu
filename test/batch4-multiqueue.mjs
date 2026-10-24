// Batch-4 W2 regression: queueId group concurrency (multi-queue minimal form).
//
// What this guards, requirement by requirement:
//   (a) config.queues is an array of {id, name, concurrent}; the default is
//       exactly one group whose cap can never bind below the global
//       maxConcurrentDownloads, so out of the box nothing changes;
//   (b) sanitize validates the table: unique ids, concurrent clamped 1..32,
//       junk entries dropped, missing names fall back to the id;
//   (c) queue.pump groups by queueId: each configured group's in-flight
//       count respects its own cap, the global maxConcurrentDownloads stays
//       the total gate, and a group the config does not list follows the
//       global limit;
//   (d) old queue.json / old config.json (no `queues` key anywhere) load and
//       schedule exactly as before, and queue.json on disk keeps its exact
//       previous shape — `queueId` was already a task field;
//   (e) pause / pauseAll / resumeAll inside a group keep working: a paused
//       task releases its group slot and the next queued task of that group
//       is promoted, never over the group cap.
//
// The scheduler is exercised with a fake runner: a promoted task sits in
// `connecting` (already an ACTIVE slot, exactly like a real transfer between
// promotion and its first byte) until the test settles it by hand. That keeps
// every assertion deterministic — no network, no origin, no timing.
//
// Isolation: throwaway DOWNLOADX_HOME per scenario (paths are resolved from
// the env on every call), nothing touches D:/IAM/downloadx-data or the user's
// real home. Each scenario flushes its debounced save before the next one
// switches the env, so no late timer can write into a foreign home.
//
// Usage: node test/batch4-multiqueue.mjs

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const suite = new Suite("batch4-multiqueue");
  const NL = String.fromCharCode(10);
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const { Config, DEFAULT_CONFIG } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { STATUS, ACTIVE } = await import("../src/task.mjs");

  const top = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b4-multiqueue-"));
  let seq = 0;

  /** A throwaway DOWNLOADX_HOME per scenario; paths.mjs resolves env per call. */
  const newHome = async (label) => {
    const dir = path.join(top, label);
    await fsp.mkdir(dir, { recursive: true });
    process.env.DOWNLOADX_HOME = dir;
    return dir;
  };

  /**
   * A QueueManager wired the way the daemon wires it, minus the network: the
   * "run" listener registers a runner handle (what pause/stop abort) and the
   * task stays in `connecting` — an ACTIVE slot — until the test settles it.
   */
  const makeQueue = async (label, { patch = null, configJson = null } = {}) => {
    const dir = await newHome(label);
    const config = new Config(path.join(dir, "config.json"));
    if (configJson) await fsp.writeFile(config.file, JSON.stringify(configJson), "utf8");
    await config.load();
    if (patch) await config.set(patch);
    const queue = new QueueManager({ config });
    await queue.load();
    queue.on("run", (id) => queue.registerRunner(id, { controller: new AbortController() }));
    return { dir, config, queue };
  };

  const add = (queue, queueId, priority) =>
    queue.add({ url: "http://127.0.0.1:1/b4-" + (++seq) + ".bin", queueId, priority }).id;

  const st = (queue, id) => queue.get(id).status;
  const activeIn = (queue, queueId) =>
    [...queue.tasks.values()].filter((t) => t.queueId === queueId && ACTIVE.has(t.status)).length;

  /** Settle like the real runner does: connecting -> downloading -> complete. */
  const settleComplete = (queue, id) => {
    queue.setStatus(id, STATUS.DOWNLOADING);
    queue.setStatus(id, STATUS.COMPLETE);
    queue.notifySettled(id);
  };

  try {
    // ------------------------------------------------ defaults and sanitize
    suite.group("config.queues 默认与 sanitize");

    await suite.test("default is exactly one group whose cap can never bind below the global", async () => {
      const expected = [{ id: "default", name: "Default", concurrent: 32 }];
      assert.deepEqual(Config.sanitize({}).queues, expected, "sanitize({}) queues");
      assert.deepEqual(Config.sanitize({ maxConcurrentDownloads: 5 }).queues, expected,
        "the default group must not mirror the global value (a later global bump would otherwise be capped)");
      assert.deepEqual(DEFAULT_CONFIG.queues, expected, "DEFAULT_CONFIG.queues");
      // Non-array and empty-table inputs fall back to that same single group,
      // which is what an old config.json (no `queues` key at all) yields.
      assert.deepEqual(Config.sanitize({ queues: "junk" }).queues, expected, "non-array queues");
      assert.deepEqual(Config.sanitize({ queues: [] }).queues, expected, "empty queues");
      assert.deepEqual(Config.sanitize({ queues: null }).queues, expected, "null queues");
    });

    await suite.test("sanitize enforces unique ids and clamps concurrent into 1..32", async () => {
      const out = Config.sanitize({ queues: [
        { id: "a", concurrent: 0 },          // explicit 0 clamps up to 1, like maxConcurrentDownloads
        { id: "b", concurrent: 99 },         // clamps down to 32
        { id: "c", concurrent: "5" },        // numeric string parses
        { concurrent: 2 },                   // no id: dropped
        { id: "", concurrent: 2 },           // empty id: dropped
        { id: 7, concurrent: 2 },            // non-string id: dropped
        "not-an-object",                     // dropped
        { id: "d" },                         // no concurrent: 32 (can never bind below global)
        { id: "e", concurrent: null },       // null concurrent: 32, not a surprise cap of 1
        { id: "a", concurrent: 8 },          // duplicate id: first wins
      ] }).queues;
      assert.deepEqual(out, [
        { id: "a", name: "a", concurrent: 1 },
        { id: "b", name: "b", concurrent: 32 },
        { id: "c", name: "c", concurrent: 5 },
        { id: "d", name: "d", concurrent: 32 },
        { id: "e", name: "e", concurrent: 32 },
      ], "junk dropped, duplicates first-wins, values clamped, name defaults to id");
    });

    await suite.test("the table is bounded and round-trips through config.json", async () => {
      const big = Array.from({ length: 70 }, (_, i) => ({ id: "q" + i, concurrent: 1 }));
      const capped = Config.sanitize({ queues: big }).queues;
      assert.equal(capped.length, 64, "the table is bounded like takeover.extensions");
      assert.equal(capped[capped.length - 1].id, "q63");

      const home = await newHome("cfg-roundtrip");
      const config = new Config(path.join(home, "config.json"));
      await config.load();
      await config.set({ queues: [
        { id: "slow", name: "慢速", concurrent: 2 },
        { id: "fast", concurrent: 8 },
      ] });
      const expected = [
        { id: "slow", name: "慢速", concurrent: 2 },
        { id: "fast", name: "fast", concurrent: 8 },
      ];
      assert.deepEqual(config.get("queues"), expected, "set() sanitizes and keeps the table");
      const again = new Config(path.join(home, "config.json"));
      await again.load();
      assert.deepEqual(again.get("queues"), expected, "the table survives a save/load round trip");
    });

    // ------------------------------------------------------ per-group caps
    suite.group("两组各自并发上限生效");

    await suite.test("each group runs at most its own cap while the other group is unaffected", async () => {
      const { queue, dir } = await makeQueue("two-groups", {
        patch: { maxConcurrentDownloads: 4, queues: [
          { id: "a", name: "A", concurrent: 2 },
          { id: "b", name: "B", concurrent: 2 },
        ] },
      });
      const a1 = add(queue, "a", 60), a2 = add(queue, "a", 50), a3 = add(queue, "a", 40);
      const b1 = add(queue, "b", 30), b2 = add(queue, "b", 20), b3 = add(queue, "b", 10);

      assert.equal(activeIn(queue, "a"), 2, "group a fills its two slots");
      assert.equal(activeIn(queue, "b"), 2, "group b fills its two slots");
      assert.equal(queue.activeCount, 4, "global gate (4) is fully used");
      assert.equal(st(queue, a1), STATUS.CONNECTING);
      assert.equal(st(queue, a2), STATUS.CONNECTING);
      assert.equal(st(queue, a3), STATUS.QUEUED, "the third a task waits on its group, not the global");
      assert.equal(st(queue, b3), STATUS.QUEUED);

      // A settled task frees its group slot only for its own group.
      settleComplete(queue, a1);
      assert.equal(st(queue, a3), STATUS.CONNECTING, "a's freed slot goes to a's next queued task");
      assert.equal(activeIn(queue, "a"), 2);
      assert.equal(activeIn(queue, "b"), 2, "group b is untouched by a's settle");
      settleComplete(queue, b1);
      assert.equal(st(queue, b3), STATUS.CONNECTING);
      assert.equal(queue.activeCount, 4);

      // Disk format: same shape as before W2 — version/order/tasks, with the
      // pre-existing queueId field carrying the group.
      await queue.saveNow();
      const raw = JSON.parse(await fsp.readFile(path.join(dir, "queue.json"), "utf8"));
      assert.equal(raw.version, 1, "queue.json version is unchanged");
      assert.ok(Array.isArray(raw.order) && raw.order.length === 6, "order array is unchanged");
      assert.equal(raw.tasks.length, 6);
      for (const rec of raw.tasks) {
        assert.ok(rec.queueId === "a" || rec.queueId === "b", "every record keeps its queueId");
      }
      const recA3 = raw.tasks.find((t) => t.id === a3);
      assert.equal(recA3.status, STATUS.CONNECTING, "statuses persist as before");
    });

    await suite.test("a spent group is skipped while other groups take their slots in the same pass", async () => {
      const { queue } = await makeQueue("skip-full-group", {
        patch: { maxConcurrentDownloads: 4, queues: [
          { id: "a", concurrent: 1 },
          { id: "b", concurrent: 2 },
        ] },
      });
      const a1 = add(queue, "a", 50), a2 = add(queue, "a", 45);
      const b1 = add(queue, "b", 40), b2 = add(queue, "b", 35);
      assert.equal(st(queue, a1), STATUS.CONNECTING);
      assert.equal(st(queue, a2), STATUS.QUEUED, "a is at its cap of 1");
      assert.equal(st(queue, b1), STATUS.CONNECTING, "the full group must not block b");
      assert.equal(st(queue, b2), STATUS.CONNECTING);
      assert.equal(queue.activeCount, 3, "one global slot is spare, but a has no group room");
      await queue.saveNow();
    });

    // -------------------------------------------------------- global gate
    suite.group("全局上限仍约束总量");

    await suite.test("the global cap binds even when every group still has room", async () => {
      const { queue } = await makeQueue("global-gate", {
        patch: { maxConcurrentDownloads: 3, queues: [
          { id: "a", concurrent: 2 },
          { id: "b", concurrent: 2 },
        ] },
      });
      const a1 = add(queue, "a", 30), a2 = add(queue, "a", 20), a3 = add(queue, "a", 5);
      const b1 = add(queue, "b", 25), b2 = add(queue, "b", 15);
      assert.equal(queue.activeCount, 3, "three global slots, three running tasks");
      assert.equal(activeIn(queue, "a"), 2, "a reached its group cap");
      assert.equal(activeIn(queue, "b"), 1, "b has group room but no global slot left");
      assert.equal(st(queue, b2), STATUS.QUEUED);
      assert.equal(st(queue, a3), STATUS.QUEUED);
      await queue.saveNow();
    });

    await suite.test("a group the config does not list follows the global limit", async () => {
      const { queue, config } = await makeQueue("unlisted-group", {
        patch: { maxConcurrentDownloads: 3, queues: [{ id: "a", concurrent: 1 }] },
      });
      assert.equal(queue.groupLimit("a"), 1, "configured group cap is the group's own");
      assert.equal(queue.groupLimit("not-listed"), 3, "unlisted group follows the global cap");
      assert.equal(queue.groupLimit("default"), 3, "default is unlisted here, so it too follows the global");

      const a1 = add(queue, "a", 50);
      const x1 = add(queue, "x", 40), x2 = add(queue, "x", 30), x3 = add(queue, "x", 20);
      assert.equal(st(queue, a1), STATUS.CONNECTING, "a runs its single slot");
      assert.equal(st(queue, x1), STATUS.CONNECTING);
      assert.equal(st(queue, x2), STATUS.CONNECTING, "x takes the remaining global slots");
      assert.equal(st(queue, x3), STATUS.QUEUED, "held back by the global gate, not a group cap");
      assert.equal(queue.activeCount, 3);
      assert.equal(config.get("queues").length, 1);
      await queue.saveNow();
    });

    // --------------------------------------------------- legacy on-disk data
    suite.group("旧 queue.json(无 queues 配置)加载行为不变");

    await suite.test("an old queue.json and old config.json load and schedule exactly as before", async () => {
      const home = await newHome("legacy");
      // An old config.json: written before `queues` existed — no such key.
      await fsp.writeFile(path.join(home, "config.json"), JSON.stringify({
        version: 1,
        maxConcurrentDownloads: 2,
        defaultDir: path.join(home, "out"),
      }), "utf8");
      // An old queue.json: same shape as always, queueId already a field.
      await fsp.writeFile(path.join(home, "queue.json"), JSON.stringify({
        version: 1,
        savedAt: "2026-10-24T00:00:00.000Z",
        order: ["legacy-3", "legacy-1", "legacy-2"],
        tasks: [
          { id: "legacy-1", url: "http://127.0.0.1:1/old1.bin", filename: "old1.bin",
            dir: path.join(home, "out"), status: "paused", queueId: "alpha", downloadedBytes: 123 },
          { id: "legacy-2", url: "http://127.0.0.1:1/old2.bin", filename: "old2.bin",
            dir: path.join(home, "out"), status: "queued", queueId: "beta", downloadedBytes: 0 },
          { id: "legacy-3", url: "http://127.0.0.1:1/old3.bin", filename: "old3.bin",
            dir: path.join(home, "out"), status: "complete", queueId: "default", downloadedBytes: 10 },
        ],
      }), "utf8");

      const config = new Config(path.join(home, "config.json"));
      await config.load();
      assert.equal(config.get("maxConcurrentDownloads"), 2, "old config value loads");
      assert.deepEqual(config.get("queues"), [{ id: "default", name: "Default", concurrent: 32 }],
        "the missing queues key becomes the default single group");
      const queue = new QueueManager({ config });
      await queue.load();
      queue.on("run", (id) => queue.registerRunner(id, { controller: new AbortController() }));

      assert.equal(queue.tasks.size, 3, "all three legacy tasks load");
      assert.deepEqual(queue.order, ["legacy-3", "legacy-1", "legacy-2"], "order is preserved");
      assert.equal(st(queue, "legacy-1"), STATUS.PAUSED, "paused stays paused");
      assert.equal(st(queue, "legacy-3"), STATUS.COMPLETE, "complete stays complete");
      assert.equal(queue.get("legacy-1").queueId, "alpha", "queueId is preserved verbatim");
      assert.equal(queue.get("legacy-1").downloadedBytes, 123, "bytes are not rewritten when no journal exists");
      // load() has never pumped by itself: a queued legacy task waits for the
      // first add/start/settle, exactly as before W2.
      assert.equal(st(queue, "legacy-2"), STATUS.QUEUED,
        "load leaves queued tasks queued (no load-time promotion, as before)");
      queue.start("legacy-2");   // what a user hitting Resume does
      assert.equal(st(queue, "legacy-2"), STATUS.CONNECTING,
        "an explicit start promotes it, under the global cap alone");

      // Pre-W2 equivalence: with no group configured beyond the default, the
      // global cap is the only limit for every queueId.
      assert.equal(queue.groupLimit("alpha"), 2, "unlisted legacy group follows the global");
      assert.equal(queue.groupLimit("default"), 32, "the default group's cap is the never-binding 32");
      const w = add(queue, "w", 40), x = add(queue, "x", 30), y = add(queue, "y", 20);
      assert.equal(queue.activeCount, 2, "the old global cap of 2 still binds every queueId together");
      // legacy-2 already holds one of the two global slots, so of the three
      // new tasks — each in its own unlisted group — exactly one runs.
      assert.equal(activeIn(queue, "w") + activeIn(queue, "x") + activeIn(queue, "y"), 1,
        "only the remaining global slot is filled, no group cap involved");
      assert.equal([w, x, y].filter((id) => st(queue, id) === STATUS.QUEUED).length, 2,
        "the overflow tasks wait on the global gate");
      await queue.saveNow();
    });

    await suite.test("a brand-new home (no config.json at all) schedules like the old single queue", async () => {
      const { queue } = await makeQueue("fresh-home");
      assert.equal(queue.capacity, 3, "default global concurrency");
      const t = [];
      for (let i = 0; i < 4; i++) t.push(add(queue, "default", 40 - i));
      assert.equal(queue.activeCount, 3, "three run, one waits — the pre-W2 behaviour");
      assert.equal(activeIn(queue, "default"), 3);
      assert.equal(t.filter((id) => st(queue, id) === STATUS.QUEUED).length, 1);
      await queue.saveNow();
    });

    // ------------------------------------------------------ pause / resume
    suite.group("组内暂停恢复不受影响");

    await suite.test("pause frees the group slot, resume refills it, never over the group cap", async () => {
      const { queue } = await makeQueue("pause-resume", {
        patch: { maxConcurrentDownloads: 4, queues: [{ id: "work", name: "Work", concurrent: 1 }] },
      });
      const w1 = add(queue, "work", 30), w2 = add(queue, "work", 20), w3 = add(queue, "work", 10);
      assert.equal(st(queue, w1), STATUS.CONNECTING, "group cap 1: only the first runs");
      assert.equal(st(queue, w2), STATUS.QUEUED);
      assert.equal(st(queue, w3), STATUS.QUEUED);

      // Pause hands the group slot to the next queued task of the same group.
      queue.pause(w1);
      assert.equal(st(queue, w1), STATUS.PAUSED);
      assert.equal(queue.running.has(w1), false, "pause must deregister the runner");
      queue.pump();   // in the wired system the aborted runner's settle path pumps
      assert.equal(st(queue, w2), STATUS.CONNECTING, "the freed slot goes to w2");
      assert.equal(activeIn(queue, "work"), 1, "still exactly one in flight for the group");

      queue.pause(w2);
      queue.pump();
      assert.equal(st(queue, w3), STATUS.CONNECTING);
      assert.equal(activeIn(queue, "work"), 1);

      // pauseAll drains the group; nothing is promoted while paused.
      queue.pauseAll();
      assert.equal(activeIn(queue, "work"), 0, "pauseAll drains the group");
      assert.equal(st(queue, w3), STATUS.PAUSED);
      queue.pump();
      assert.equal(queue.activeCount, 0, "no promotion while pausedAll");

      // resumeAll restarts the group under its own cap.
      queue.resumeAll();
      assert.equal(queue.activeCount, 1, "resumeAll respects the group cap of 1");
      const running = [w1, w2, w3].filter((id) => st(queue, id) === STATUS.CONNECTING);
      assert.equal(running.length, 1, "exactly one task runs after resumeAll");
      assert.equal(st(queue, running[0]), STATUS.CONNECTING);
      const queued = [w1, w2, w3].filter((id) => st(queue, id) === STATUS.QUEUED);
      assert.equal(queued.length, 2, "the rest wait on the group, not the global (global is 4)");
      await queue.saveNow();
    });
  } finally {
    await fsp.rm(top, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch4-multiqueue crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
