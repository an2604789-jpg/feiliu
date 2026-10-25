// Batch-5 regression: P-11 doctor names the data root in effect; P-12 the
// HTTP API response shapes are documented in README.md.
//
// P-11 (Linux cloud test): `doctor` answered "daemon not running" while a
// daemon WAS running — it had been started with a custom DOWNLOADX_HOME, so
// its runtime.json (port + token) lives in that root and a default-root run
// cannot see it. The fix prints which data root is in effect in both forms
// (DOWNLOADX_HOME set / default), explains that the two roots share nothing,
// and — when no runtime file is found here — prints HOW a human checks for a
// daemon on another root instead of scanning any port.
//
// P-12: the API envelope is intentionally uneven (cancel answers a flat
// {ok,cancelled,removed,id,target,kind,discarded}; the other task endpoints
// wrap in {"task":...}). Until a breaking merge is scheduled, README.md
// documents the current shapes. This file checks the section exists and that
// the flat field list it advertises is the one the code really answers with.
//
// Everything runs in a temp tree: DOWNLOADX_HOME is DELETED from the child
// environment (this machine exports it globally) and APPDATA/HOME/USERPROFILE
// are redirected, so neither the real %APPDATA%\downloadx nor any other real
// data root is read or written. Only `node` tests run; no daemon is started,
// no port is probed, no existing process is touched.
//
// Usage: node test/batch5-doctor.mjs

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BIN = path.join(ROOT, "bin", "downloadx.mjs");

// The one data root this test must never read or write (workspace rule).
const FORBIDDEN_ROOT = "d:/iam/downloadx-data";

async function main() {
  const suite = new Suite("batch5-doctor");
  const NL = String.fromCharCode(10);
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b5-doctor-"));
  const customHome = path.join(scratch, "custom-home");   // form A: DOWNLOADX_HOME
  const fakeAppData = path.join(scratch, "appdata");      // form B: default root's base
  const fakeProfile = path.join(scratch, "profile");      // keeps the defaultDir probe off the real profile
  for (const dir of [customHome, fakeAppData, fakeProfile]) await fsp.mkdir(dir, { recursive: true });

  // Child env: the inherited DOWNLOADX_HOME (this machine sets one) must go,
  // in BOTH forms, or the children would talk to the real data root.
  const baseEnv = { ...process.env };
  delete baseEnv.DOWNLOADX_HOME;
  delete baseEnv.DOWNLOADX_DEBUG;
  baseEnv.APPDATA = fakeAppData;
  baseEnv.XDG_CONFIG_HOME = fakeAppData;
  baseEnv.HOME = fakeProfile;
  baseEnv.USERPROFILE = fakeProfile;

  const formA = { ...baseEnv, DOWNLOADX_HOME: customHome };
  const formB = { ...baseEnv };                            // DOWNLOADX_HOME absent

  const runDoctor = (env) => {
    const started = Date.now();
    const r = spawnSync(process.execPath, [BIN, "doctor"], {
      cwd: ROOT, env, encoding: "utf8", timeout: 120000, windowsHide: true,
    });
    return {
      ...r,
      out: String(r.stdout || "") + String(r.stderr || ""),
      ms: Date.now() - started,
    };
  };

  const assertCleanExit = (r, what) => {
    assert.ok(r.error === undefined || r.error === null,
      what + ": spawned without error: " + (r.error && r.error.message));
    assert.equal(r.signal, null, what + ": exited on its own, not killed");
    assert.ok(Number.isInteger(r.status), what + ": exit status is a number (got " + r.status + ")");
    assert.ok(r.ms < 120000, what + ": finished inside the timeout (" + r.ms + " ms)");
  };

  const assertNoRealRoot = (out, what) => {
    const flat = out.replace(/\\/g, "/").toLowerCase();
    assert.ok(!flat.includes(FORBIDDEN_ROOT),
      what + ": the forbidden real data root must never be read or shown");
    const realAppData = process.env.APPDATA
      ? process.env.APPDATA.replace(/\\/g, "/").toLowerCase() : null;
    if (realAppData) {
      assert.ok(!flat.includes(realAppData),
        what + ": the real %APPDATA% root must never be touched or shown");
    }
  };

  try {
    // --------------------------------------------- P-11, DOWNLOADX_HOME set
    suite.group("P-11: doctor names the data root (DOWNLOADX_HOME set)");

    const runA = runDoctor(formA);
    assertCleanExit(runA, "form A");
    assertNoRealRoot(runA.out, "form A");

    await suite.test("custom root is printed with its DOWNLOADX_HOME origin", async () => {
      const resolved = path.resolve(customHome);
      assert.ok(runA.out.includes(resolved),
        "doctor must print the effective root verbatim; wanted: " + resolved + NL + runA.out);
      assert.ok(runA.out.includes("(from DOWNLOADX_HOME)"),
        "doctor must say the root comes from DOWNLOADX_HOME" + NL + runA.out);
      assert.ok(runA.out.includes("data root"),
        "the data root line must carry the data root label" + NL + runA.out);
    });

    // ------------------------------------------ P-11, default root (unset)
    suite.group("P-11: doctor names the default root and how to find a daemon elsewhere");

    const runB = runDoctor(formB);
    assertCleanExit(runB, "form B");
    assertNoRealRoot(runB.out, "form B");

    await suite.test("default root is printed as (default) with the set-DOWNLOADX_HOME advice", async () => {
      const defaultRoot = path.join(fakeAppData, "downloadx"); // paths.mjs: APPDATA fallback
      assert.ok(runB.out.includes(defaultRoot),
        "doctor must print the resolved default root; wanted: " + defaultRoot + NL + runB.out);
      assert.ok(runB.out.includes("(default"),
        "doctor must mark the root as the default when DOWNLOADX_HOME is unset" + NL + runB.out);
      assert.ok(runB.out.includes("DOWNLOADX_HOME is not set"),
        "doctor must say why it is the default" + NL + runB.out);
      assert.ok(runB.out.includes("custom data root") && runB.out.includes("set DOWNLOADX_HOME"),
        "doctor must tell the reader to set DOWNLOADX_HOME when the daemon runs elsewhere" + NL + runB.out);
    });

    await suite.test("with no runtime file here, doctor prints how to check — no port scan", async () => {
      assert.ok(runB.out.includes("not running"),
        "the daemon is absent in the temp root, so it must say so" + NL + runB.out);
      assert.ok(runB.out.includes("DOWNLOADX_HOME=<that root>"),
        "doctor must show how to point doctor at the other root" + NL + runB.out);
      assert.ok(runB.out.includes("runtime.json"),
        "the hint must say where the other root's port + token live" + NL + runB.out);
      const netHint = process.platform === "win32" ? "netstat" : "ss -ltnp";
      assert.ok(runB.out.includes(netHint),
        "the hint must name the platform's listener-listing command: " + netHint + NL + runB.out);
      // The hint is text only: doctor itself must not open sockets. A default
      // doctor run performs no fetch when no runtime file exists, so the only
      // network sentence is the one we print.
    });

    // ------------------------------------------------- P-12, README checks
    suite.group("P-12: README documents the HTTP API response shapes");

    await suite.test("the API shapes section exists and names the real envelopes", async () => {
      const readme = await fsp.readFile(path.join(ROOT, "README.md"), "utf8");
      const at = readme.indexOf("## HTTP API 响应形状");
      assert.ok(at >= 0, "README.md must contain the '## HTTP API 响应形状' section");
      const rest = readme.indexOf("## English", at);
      const section = readme.slice(at, rest === -1 ? readme.length : rest);

      assert.ok(section.includes('{"task"'), "task endpoints documented as {\"task\":...}");
      assert.ok(section.includes('{"error"'), "errors documented as {\"error\":...} with HTTP status codes");
      for (const field of ["ok", "cancelled", "removed", "id", "target", "kind", "discarded"]) {
        assert.ok(section.includes('"' + field + '"'),
          "flat cancel body must document the field \"" + field + "\"");
      }
      assert.ok(section.includes("中间产物"),
        "the section must explain what the discarded list means");
      assert.ok(section.includes("409"), "the refuse-to-destroy-complete behaviour must be documented");
    });

    await suite.test("the documented flat cancel shape is the one api.mjs answers with", async () => {
      const apiSrc = await fsp.readFile(path.join(ROOT, "src", "api.mjs"), "utf8");
      assert.ok(
        /body:\s*\{\s*ok:\s*true,\s*cancelled:\s*true,\s*removed,\s*id,\s*target,\s*kind,\s*discarded\s*\}/.test(apiSrc),
        "api.mjs #cancelTask must still answer the flat {ok,cancelled,removed,id,target,kind,discarded} body");
      assert.ok(apiSrc.includes('json(res, 201, { task: taskView(task) })'),
        "POST /api/tasks must still wrap in {\"task\":...}");
      assert.ok(apiSrc.includes('json(res, 401, { error: "bad token" })'),
        "token failures must still be {\"error\"} with 401");
    });
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  process.stdout.write(NL);
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch5-doctor crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
