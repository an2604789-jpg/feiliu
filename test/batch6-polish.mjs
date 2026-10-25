// Batch-6 polish regression: P-16 scheduler "next" display + P-20 deployment docs.
//
// P-16 (待修问题清单): scheduler.mjs nextFor() anchored a never-run schedule's
// "next" on `lastRun ?? 0`, i.e. the epoch, so `GET /api/scheduler` and
// /api/status listed "1970-01-01T..." as the next run time. The fix shows
// null until the schedule has actually fired once; the firing logic in tick()
// is untouched. Asserted here:
//   (a) a never-run schedule lists next = null, never an epoch string;
//   (b) a lastRun persisted as 0 (defensive, old data) also yields null;
//   (c) after one real tick() fire, next is a proper future time at the
//       schedule's own HH:MM;
//   (d) that next value survives a toJSON()/loadFrom() round-trip, so the
//       daemon restart path (daemon.mjs loadFrom) keeps it;
//   (e) disabled / time-less schedules still list next = null as before.
//
// P-20: the repo must ship the systemd template unit and document deployment:
//   (f) scripts/feiliu.service exists and is a real unit template
//       (User/WorkingDirectory/Environment=DOWNLOADX_HOME/ExecStart placeholders);
//   (g) README.md carries the "Linux 服务器部署" section: clone -> data root ->
//       systemd install with daemon-reload, plus the SSH-tunnel sentence.
//
// Everything runs on an isolated temp DOWNLOADX_HOME; no user data root, no
// network, no daemon process. Usage: node test/batch6-polish.mjs

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DAY_MS = 86_400_000;

const pad2 = (n) => String(n).padStart(2, "0");

async function main() {
  const suite = new Suite("batch6-polish");
  const NL = String.fromCharCode(10);
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-batch6-"));
  process.env.DOWNLOADX_HOME = home;

  try {
    const { Scheduler } = await import("../src/scheduler.mjs");

    /** A scheduler whose queue records every action instead of touching files. */
    const makeScheduler = () => new Scheduler({
      queue: {
        resumeAll() { this.calls.push("resume"); },
        pauseAll() { this.calls.push("pause"); },
        clearCompleted() { this.calls.push("clear"); },
        add() { this.calls.push("add"); },
        calls: [],
      },
      config: null,
      log: { info() {}, warn() {}, error() {} },
    });

    suite.group("P-16: scheduler next for a never-run schedule");

    await suite.test("never-run schedule lists next = null, not an epoch 1970 time", () => {
      const sched = makeScheduler();
      const s = sched.add({ at: "03:07", action: "pause", name: "never-ran" });
      const row = sched.list().find((x) => x.id === s.id);
      assert.equal(row.next, null, "next must be null before the first run");
      // The regression this guards: next used to be nextOccurrence(at, epoch).
      assert.notEqual(row.next, new Date(0).toISOString(), "next must not be the epoch ISO");
      assert.ok(!String(row.next).includes("1970"), "next must not mention 1970");
    });

    await suite.test("a lastRun of 0 in persisted data also yields null (defensive)", () => {
      const sched = makeScheduler();
      sched.loadFrom({
        schedules: [{ id: "s-zero", at: "09:30", action: "resume", enabled: true }],
        lastRun: [["s-zero", 0]],
      });
      const row = sched.list().find((x) => x.id === "s-zero");
      assert.equal(row.next, null, "a 0 lastRun must not resurrect the 1970 display");
    });

    suite.group("P-16: scheduler next after the schedule has fired once");

    await suite.test("after one tick fire, next is a future time at the schedule's HH:MM", () => {
      const sched = makeScheduler();
      const now = new Date();
      const at = pad2(now.getHours()) + ":" + pad2(now.getMinutes());
      const s = sched.add({ at, action: "pause", name: "fired-once" });

      // One real firing through tick(): the trigger path stays authoritative.
      const fired = sched.tick(now);
      assert.ok(fired.includes(s.id), "the schedule must fire on its own HH:MM");
      assert.equal(sched.lastRun.get(s.id), now.getTime(), "tick must record the run time");
      assert.deepEqual(sched.queue.calls, ["pause"], "the pause action must have run once");

      const row = sched.list().find((x) => x.id === s.id);
      assert.ok(row.next, "after a run, next must be a real time, not null");
      const next = new Date(row.next);
      assert.ok(!Number.isNaN(next.getTime()), "next must parse as a date: " + row.next);
      assert.equal(next.getHours() * 60 + next.getMinutes(),
        now.getHours() * 60 + now.getMinutes(), "next must sit at the schedule's own HH:MM");
      const delta = next.getTime() - now.getTime();
      assert.ok(delta > 0, "next must be in the future, got " + row.next);
      assert.ok(delta <= DAY_MS, "next must be within one day, got " + row.next);
    });

    await suite.test("the fired schedule's next survives a toJSON/loadFrom round-trip", () => {
      const sched = makeScheduler();
      const now = new Date();
      const at = pad2(now.getHours()) + ":" + pad2(now.getMinutes());
      const s = sched.add({ at, action: "resume", name: "persisted" });
      sched.tick(now);
      const before = sched.list().find((x) => x.id === s.id).next;

      // daemon.mjs restart path: schedules + lastRun come back from disk.
      const revived = makeScheduler().loadFrom(JSON.parse(JSON.stringify(sched.toJSON())));
      const row = revived.list().find((x) => x.id === s.id);
      assert.equal(row.next, before, "next must be identical after a loadFrom restart");
      assert.ok(row.next && !row.next.includes("1970"), "the revived next must stay sane");
    });

    await suite.test("disabled and time-less schedules still list next = null", () => {
      const sched = makeScheduler();
      const off = sched.add({ at: "05:00", action: "pause", enabled: false });
      const noTime = sched.add({ at: null, action: "clear-completed" });
      assert.equal(sched.list().find((x) => x.id === off.id).next, null);
      assert.equal(sched.list().find((x) => x.id === noTime.id).next, null);
    });

    suite.group("P-20: systemd unit template and README deployment section");

    await suite.test("scripts/feiliu.service exists as a filled-in-place unit template", () => {
      const unit = path.join(ROOT, "scripts", "feiliu.service");
      assert.equal(fs.existsSync(unit), true, "the unit file must ship in the repo");
      const text = fs.readFileSync(unit, "utf8");
      assert.match(text, /^\[Unit\]/m, "must have a [Unit] section");
      assert.match(text, /^\[Service\]/m, "must have a [Service] section");
      assert.match(text, /^\[Install\]/m, "must have an [Install] section");
      assert.match(text, /^User=/m, "must set User=");
      assert.match(text, /^WorkingDirectory=/m, "must set WorkingDirectory=");
      assert.match(text, /^Environment=DOWNLOADX_HOME=/m, "must export DOWNLOADX_HOME");
      assert.match(text, /^ExecStart=.*daemon/m, "must start the daemon");
      assert.match(text, /<USER>/, "must keep the username placeholder visible");
      assert.match(text, /daemon-reload/, "must document the reload command in comments");
    });

    await suite.test("README documents clone -> DOWNLOADX_HOME -> systemd in three steps", () => {
      const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
      assert.match(readme, /Linux 服务器部署/, "the deployment section heading must exist");
      assert.match(readme, /git clone .*feiliu\.git/, "step 1: clone");
      assert.match(readme, /mkdir -p ~\/dx-data/, "step 2: create the DOWNLOADX_HOME data root");
      assert.match(readme, /scripts\/feiliu\.service/, "step 3: reference the shipped unit file");
      assert.match(readme, /systemctl daemon-reload/, "the reload command must be present");
      assert.match(readme, /systemctl enable --now feiliu/, "the enable command must be present");
      assert.match(readme, /DOWNLOADX_HOME/, "the data root env must be named");
      assert.match(readme, /ssh -L /, "the SSH tunnel access must be mentioned");
    });
  } finally {
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch6-polish crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
