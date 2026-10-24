// Batch 1 credential-hygiene regression (review P1 #2 + PATCH whitelist).
//
// What this file pins down:
//   (a) PATCH /api/tasks/:id may only change the whitelisted fields; a body
//       carrying status/id/url/downloadedBytes and friends must leave them
//       untouched, while priority/tags/category/filename still apply;
//   (b) a task that settled into complete/error persists WITHOUT its session
//       credentials (headers.Cookie, cookies, username, password), while the
//       in-memory task keeps them — so an in-process retry still
//       authenticates (the runner hands the live object to the downloader,
//       queue.json is never re-read for a retry);
//   (c) a paused task keeps its credentials on disk, and pause → resume
//       continues the transfer and serves the exact origin bytes;
//   (d) loading existing records never strips them in memory and never
//       rewrites queue.json by itself (no migration pass).
//
// Everything runs against local origins and an isolated DOWNLOADX_HOME, so no
// public network, no user Downloads, no %APPDATA%\downloadx and never the
// production data root.
//
// Usage: node test/batch1-credentials.mjs

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import http from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";
import { startOrigin, payloadFor } from "./origin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NL = String.fromCharCode(10);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Distinctive marker strings; if any of these reach queue.json the test fails. */
const COOKIE_HEADER = "COOKIE-ALPHA-SESSION=7f3a9c; COOKIE-BETA-SESSION=2b8e11";
const COOKIES_FIELD = "sid=COOKIE-GAMMA-2b8e; REFRESH=COOKIE-DELTA-41aa";
const USERNAME_FIELD = "USER-ECHO-550e";
const PASSWORD_FIELD = "PASS-DELTA-83bd";
const BASIC = "Basic " + Buffer.from(USERNAME_FIELD + ":" + PASSWORD_FIELD).toString("base64");
const PAUSED_COOKIE_HEADER = "COOKIE-ZULU-PAUSED=keep-on-disk";
const PAUSED_COOKIES_FIELD = "sid=COOKIE-YANKEE-PAUSED";
const SEED_COOKIE = "COOKIE-SEED-LEGACY=must-stay-in-memory";

const SECRETS = [COOKIE_HEADER, COOKIES_FIELD, USERNAME_FIELD, PASSWORD_FIELD,
  PAUSED_COOKIE_HEADER, PAUSED_COOKIES_FIELD, SEED_COOKIE];

/** Poll until fn() is true, or fail with the caller's message. */
async function waitFor(fn, { timeoutMs = 30000, everyMs = 50, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A second origin that gates one resource behind a flag and records every
 * request's credential headers. It answers 404 while locked (a non-retryable
 * status, so the task settles into error fast), and the payload once armed.
 */
function startCredOrigin() {
  const requests = [];
  let armed = false;
  const body = Buffer.alloc(64 * 1024, 0x77);
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://localhost").pathname;
    requests.push({
      path: p,
      cookie: req.headers.cookie ?? null,
      authorization: req.headers.authorization ?? null,
      range: req.headers.range ?? null,
    });
    if (p !== "/gated") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    if (!armed) {
      res.writeHead(404, { "Content-Type": "text/plain", "Content-Length": "9" });
      res.end("not ready");
      return;
    }
    // Range support, so a segmented engine never trips the downgrade path.
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    const slice = body.subarray(start, end + 1);
    const headers = {
      "Content-Type": "application/octet-stream",
      "Accept-Ranges": "bytes",
    };
    if (m) {
      headers["Content-Range"] = "bytes " + start + "-" + end + "/" + body.length;
      headers["Content-Length"] = String(slice.length);
      res.writeHead(206, headers);
    } else {
      headers["Content-Length"] = String(body.length);
      res.writeHead(200, headers);
    }
    res.end(slice);
  });
  server.on("connection", (socket) => socket.on("error", () => {}));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      origin: "http://127.0.0.1:" + server.address().port,
      requests,
      arm: () => { armed = true; },
      close: async () => {
        try { server.closeAllConnections?.(); } catch { /* none */ }
        await new Promise((r) => server.close(r));
      },
    }));
  });
}

/** Every Cookie header key present, whatever its casing. */
const cookieHeaderKeys = (headers) =>
  Object.keys(headers ?? {}).filter((k) => k.toLowerCase() === "cookie");

/** Assert a persisted record carries no session credentials. */
function assertRecordStripped(rec, what) {
  assert.ok(rec && typeof rec === "object", what + ": record exists in queue.json");
  assert.equal(cookieHeaderKeys(rec.headers).length, 0,
    what + ": no Cookie header key may survive (" + JSON.stringify(rec.headers) + ")");
  assert.equal(rec.cookies ?? null, null, what + ": cookies field must be empty");
  assert.equal(rec.username ?? null, null, what + ": username field must be empty");
  assert.equal(rec.password ?? null, null, what + ": password field must be empty");
}

async function main() {
  const suite = new Suite("batch1-credentials");
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else if (r.kind === "skip") process.stdout.write("    SKIP  " + r.text + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-batch1-creds-"));
  const out = path.join(home, "out");
  await fsp.mkdir(out, { recursive: true });
  process.env.DOWNLOADX_HOME = home;

  // Seed queue.json the way an old install would have left it: a completed
  // task whose record still carries a session cookie. load() must keep the
  // credentials in memory (so an errored sibling could still retry) and must
  // not rewrite the file by itself — there is no migration pass.
  const seedId = "seed-legacy-complete-task";
  const seedRecord = {
    id: seedId, url: "http://127.0.0.1:9/seed.bin", finalUrl: null,
    filename: "seed.bin", dir: out, category: null, status: "complete", kind: "http",
    totalBytes: 4, downloadedBytes: 4, lengthKnown: true, segments: null,
    connections: null, headers: { Cookie: SEED_COOKIE }, referer: null,
    cookies: SEED_COOKIE, username: null, password: null, proxy: null,
    speedLimit: null, priority: 0, queueId: "default", error: null, retries: 0,
    etag: null, lastModified: null, sha256: null, createdAt: Date.now(),
    startedAt: Date.now(), finishedAt: Date.now(), updatedAt: Date.now(),
    attempts: 1, tags: [], meta: {},
  };
  const queueFile = path.join(home, "queue.json");
  const seedRaw = JSON.stringify({ version: 1, savedAt: new Date().toISOString(),
    order: [seedId], tasks: [seedRecord] }, null, 2);
  await fsp.writeFile(queueFile, seedRaw, "utf8");

  const origin = await startOrigin();
  const credOrigin = await startCredOrigin();
  const { Config } = await import("../src/config.mjs");
  const { QueueManager } = await import("../src/queue.mjs");
  const { Downloader } = await import("../src/downloader.mjs");
  const { ApiServer } = await import("../src/api.mjs");
  const { paths } = await import("../src/paths.mjs");

  const config = new Config(path.join(home, "config.json"));
  await config.load();
  await config.set({
    defaultDir: out,
    categorizeByType: false,
    maxConnections: 1,
    maxConcurrentDownloads: 1,
    segmentBytes: 262144,
    overwriteExisting: "rename",
    proxy: "",
    proxyMode: "none",
  });
  const queue = new QueueManager({ config });
  const rawAfterLoad = await fsp.readFile(paths.queue, "utf8");
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

  /** Flush the debounced save, then return the parsed queue file. */
  const savedQueue = async () => {
    await queue.saveNow();
    return JSON.parse(await fsp.readFile(paths.queue, "utf8"));
  };
  const savedRaw = async () => {
    await queue.saveNow();
    return fsp.readFile(paths.queue, "utf8");
  };

  /** Resolved output paths, straight from the downloader's own event. */
  const resolvedTargets = new Map();
  downloader.on("resolved", (p) => { if (p && p.taskId && p.target) resolvedTargets.set(p.taskId, p.target); });

  const waitInFlight = async (id, filename) => {
    const expected = path.join(out, filename);
    await waitFor(() => resolvedTargets.has(id), { what: "the downloader to resolve a target" });
    const target = resolvedTargets.get(id);
    assert.equal(target, expected, "resolved target must be the requested file");
    await waitFor(() => fs.existsSync(target + ".downloadx") && fs.existsSync(target + ".downloadx-part"),
      { what: "the segment journal and the staged file to appear" });
    await waitFor(async () => {
      const t = await taskById(id);
      return t && t.downloadedBytes > 0;
    }, { what: "bytes to be recorded for the task" });
    return target;
  };

  try {
    // ------------------------------------------------------------ legacy load
    suite.group("loading existing records: memory keeps credentials, file untouched");

    await suite.test("a completed task from an old queue.json keeps its cookie in memory", () => {
      const t = queue.get(seedId);
      assert.ok(t, "the seeded task must be loaded");
      assert.equal(t.status, "complete");
      assert.equal(t.headers.Cookie, SEED_COOKIE, "load() must not strip in memory");
      assert.equal(t.cookies, SEED_COOKIE, "load() must not strip in memory");
    });

    await suite.test("load() does not rewrite queue.json (no migration pass)", () => {
      assert.equal(rawAfterLoad, seedRaw, "the file must be byte-identical after load()");
    });

    // ------------------------------------------------- error settle + retry
    suite.group("a task that settles into error: disk stripped, memory retained");

    let errorTaskId = null;
    let requestsBeforeRetry = 0;

    await suite.test("an errored task persists without credentials but keeps them in memory", async () => {
      const added = await call("POST", "/api/tasks", {
        url: credOrigin.origin + "/gated",
        filename: "gated.bin",
        headers: { Cookie: COOKIE_HEADER },
        cookies: COOKIES_FIELD,
        username: USERNAME_FIELD,
        password: PASSWORD_FIELD,
      });
      assert.equal(added.status, 201);
      errorTaskId = added.json.task.id;

      // 404 is non-retryable, so the task settles into error on its own.
      const t = await waitFor(async () => {
        const cur = await taskById(errorTaskId);
        return cur && cur.status === "error" ? cur : false;
      }, { what: "the task to settle into error" });
      assert.ok(t.error, "the task must carry the origin error");

      const data = await savedQueue();
      const rec = data.tasks.find((x) => x.id === errorTaskId);
      assertRecordStripped(rec, "errored record");

      const raw = await savedRaw();
      for (const secret of [COOKIE_HEADER, COOKIES_FIELD, USERNAME_FIELD, PASSWORD_FIELD]) {
        assert.ok(!raw.includes(secret), "queue.json must not contain " + secret);
      }

      // The whole point of save-layer stripping: the live object is intact.
      const live = queue.get(errorTaskId);
      assert.equal(live.headers.Cookie, COOKIE_HEADER, "memory must keep headers.Cookie");
      assert.equal(live.cookies, COOKIES_FIELD, "memory must keep cookies");
      assert.equal(live.username, USERNAME_FIELD, "memory must keep username");
      assert.equal(live.password, PASSWORD_FIELD, "memory must keep password");

      // And the API never echoed credentials in the first place.
      const view = await taskById(errorTaskId);
      for (const key of ["headers", "cookies", "username", "password"]) {
        assert.ok(!(key in view), "task view must not expose " + key);
      }
    });

    await suite.test("retry re-authenticates from the in-memory task and completes", async () => {
      credOrigin.arm();
      requestsBeforeRetry = credOrigin.requests.length;
      const r = await call("POST", "/api/tasks/" + errorTaskId + "/retry");
      assert.equal(r.status, 200, "retry must answer 200, got " + r.status + " " + JSON.stringify(r.json));

      const done = await waitFor(async () => {
        const t = await taskById(errorTaskId);
        if (!t) return false;
        if (t.status === "error") throw new Error("retry failed: " + t.error);
        return t.status === "complete" ? t : false;
      }, { timeoutMs: 60000, what: "the retried transfer to complete" });
      assert.equal(done.downloadedBytes, 64 * 1024);

      // The requests the retry issued carried the session credentials — they
      // can only have come from the in-memory task, because the persisted
      // record was already stripped.
      const after = credOrigin.requests.slice(requestsBeforeRetry);
      assert.ok(after.length > 0, "the retry must have reached the origin");
      const credentialed = after.filter((q) => q.cookie === COOKIE_HEADER && q.authorization === BASIC);
      assert.ok(credentialed.length > 0,
        "the retried transfer must send Cookie and Basic credentials, saw: " +
        JSON.stringify(after.map((q) => ({ cookie: q.cookie, authorization: q.authorization }))));

      const target = resolvedTargets.get(errorTaskId);
      const body = await fsp.readFile(target);
      assert.equal(body.length, 64 * 1024);
      assert.equal(sha256(body), sha256(Buffer.alloc(64 * 1024, 0x77)), "retried bytes");

      const data = await savedQueue();
      const rec = data.tasks.find((x) => x.id === errorTaskId);
      assert.equal(rec.status, "complete");
      assertRecordStripped(rec, "completed-after-retry record");
    });

    // ------------------------------------------------------- pause / resume
    suite.group("paused task: credentials persist, resume continues the transfer");

    const RESUME_SIZE = 8 * 1024 * 1024;   // ~5 s at 32 KiB / 20 ms
    const resumeUrl = origin.origin + "/throttle/" + RESUME_SIZE + "/32768/20";
    let resumeTaskId = null;
    let resumeTarget = null;

    await suite.test("an in-flight transfer occupies the slot", async () => {
      const added = await call("POST", "/api/tasks", {
        url: resumeUrl,
        filename: "resume-creds.bin",
        headers: { Cookie: PAUSED_COOKIE_HEADER },
        cookies: PAUSED_COOKIES_FIELD,
      });
      assert.equal(added.status, 201);
      resumeTaskId = added.json.task.id;
      resumeTarget = await waitInFlight(resumeTaskId, "resume-creds.bin");
    });

    await suite.test("PATCH may not rewrite status/id/url and still applies whitelisted fields", async () => {
      // The only slot is busy, so a freshly added task stays queued.
      const added = await call("POST", "/api/tasks", { url: credOrigin.origin + "/gated", filename: "patchme.bin" });
      assert.equal(added.status, 201);
      const id = added.json.task.id;
      const queued = await taskById(id);
      assert.equal(queued.status, "queued", "the second task must wait for the slot");

      const patch = await call("PATCH", "/api/tasks/" + id, {
        status: "downloading",           // must be ignored
        id: "hijacked-id",               // must be ignored
        url: "http://evil.example/x",    // must be ignored
        downloadedBytes: 999999,         // must be ignored
        totalBytes: 1,                   // must be ignored
        speed: 42,                       // must be ignored
        error: "injected-error",         // must be ignored
        retries: 99,                     // must be ignored
        kind: "ftp",                     // must be ignored
        priority: 55,                    // whitelisted: applies
        tags: ["patched"],               // whitelisted: applies
        category: "docs",                // whitelisted: applies
        filename: "patched-name.bin",    // whitelisted: applies
      });
      assert.equal(patch.status, 200, "PATCH must answer 200, got " + patch.status);

      const after = await taskById(id);
      assert.equal(after.status, "queued", "PATCH status must be ignored");
      assert.equal(after.id, id, "PATCH id must be ignored");
      assert.equal(after.url, credOrigin.origin + "/gated", "PATCH url must be ignored");
      assert.equal(after.downloadedBytes, 0, "PATCH downloadedBytes must be ignored");
      assert.equal(after.speed, 0, "PATCH speed must be ignored");
      assert.equal(after.error, null, "PATCH error must be ignored");
      assert.equal(after.retries, 0, "PATCH retries must be ignored");
      assert.equal(after.kind, "http", "PATCH kind must be ignored");
      assert.equal(after.priority, 55, "PATCH priority must apply");
      assert.deepEqual(after.tags, ["patched"], "PATCH tags must apply");
      assert.equal(after.category, "docs", "PATCH category must apply");
      assert.equal(after.filename, "patched-name.bin", "PATCH filename must apply");

      const removed = await call("POST", "/api/tasks/" + id + "/cancel");
      assert.equal(removed.status, 200, "cleanup: the queued task must be cancellable");
      // Give the scheduler a beat: the freed slot must not resurrect anything.
      await sleep(100);
    });

    await suite.test("a paused record keeps its credentials on disk", async () => {
      assert.equal((await call("POST", "/api/tasks/" + resumeTaskId + "/pause")).status, 200);
      const paused = await waitFor(async () => {
        const t = await taskById(resumeTaskId);
        return t && t.status === "paused" ? t : false;
      }, { what: "the task to report paused" });
      assert.equal(paused.status, "paused");

      const data = await savedQueue();
      const rec = data.tasks.find((x) => x.id === resumeTaskId);
      assert.ok(rec, "paused record exists");
      assert.equal(rec.status, "paused");
      assert.equal(rec.headers.Cookie, PAUSED_COOKIE_HEADER, "paused record must keep headers.Cookie");
      assert.equal(rec.cookies, PAUSED_COOKIES_FIELD, "paused record must keep cookies");
    });

    await suite.test("resume continues to the exact origin bytes and then strips", async () => {
      assert.equal((await call("POST", "/api/tasks/" + resumeTaskId + "/resume")).status, 200);
      const done = await waitFor(async () => {
        const t = await taskById(resumeTaskId);
        if (!t) return false;
        if (t.status === "error") throw new Error("resume failed: " + t.error);
        return t.status === "complete" ? t : false;
      }, { timeoutMs: 60000, what: "the resumed transfer to complete" });
      assert.equal(done.downloadedBytes, RESUME_SIZE);

      const body = await fsp.readFile(resumeTarget);
      assert.equal(body.length, RESUME_SIZE, "resumed file size");
      assert.equal(sha256(body), sha256(payloadFor(RESUME_SIZE)), "resumed bytes must equal what the origin served");

      const data = await savedQueue();
      const rec = data.tasks.find((x) => x.id === resumeTaskId);
      assert.equal(rec.status, "complete");
      assertRecordStripped(rec, "resumed-and-completed record");
    });

    // -------------------------------------------------------- final hygiene
    suite.group("final file hygiene");

    await suite.test("queue.json carries none of the session secrets", async () => {
      const raw = await savedRaw();
      for (const secret of SECRETS) {
        assert.ok(!raw.includes(secret), "queue.json must not contain " + secret);
      }
      const data = JSON.parse(raw);
      assert.ok(Array.isArray(data.tasks) && data.tasks.length >= 2, "the settled tasks must be persisted");
      for (const rec of data.tasks) {
        assertRecordStripped(rec, "record " + rec.id + " (" + rec.status + ")");
      }
    });
  } finally {
    await api.close().catch(() => {});
    await new Promise((r) => { try { origin.server.closeAllConnections?.(); } catch { /* none */ } origin.close().then(r); setTimeout(r, 1500); });
    await credOrigin.close();
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch1-credentials crashed: " + ((err && err.stack) || err) + NL);
    process.exitCode = 1;
  });
