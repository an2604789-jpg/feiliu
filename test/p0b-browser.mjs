// P0-B: real-Edge click-to-download closed loop, two scenarios.
//
// Batch 01 failed here for one reason: the click happened, but the daemon had
// already exited, so nothing was queued (ECONNREFUSED 127.0.0.1:9155). The
// point of this file is therefore to make daemon reachability a precondition
// that is *asserted*, not assumed - and then to drive the real extension with
// real mouse events.
//
// Nothing here is a protocol-level substitute: every download claim below is
// backed by a browser that actually rendered a badge and received a click.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import process from "node:process";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const PROJECT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const EXT_DIR = path.join(PROJECT, "extension");
const NODE = process.execPath;

const ROOT = process.env.P0B_ROOT
  || path.join("D:\\IAM", "反馈", "最终验收批次-20261019", "修复批次-02", "work");
const HOME = path.join(ROOT, "p0b-home");
const DOWNLOADS = path.join(ROOT, "p0b-downloads");
const EDGE_PROFILE = path.join(ROOT, "p0b-edge");
const OUT = process.env.P0B_OUT
  || path.join("D:\\IAM", "反馈", "最终验收批次-20261019", "修复批次-02", "测试输出", "p0b");
const CDP_PORT = Number(process.env.P0B_CDP_PORT || 9421);
const HOST_NAME = "com.downloadx.host";
const EDGE_KEY = "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\" + HOST_NAME;

// install.mjs registers every browser it finds, so all five keys are written
// by this scenario - not just Edge. Each one is read before the run and put
// back verbatim in the finally block: these are the production keys a real
// Edge needs, so they cannot be namespaced away here.
const HOST_KEYS = {
  Chrome: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME,
  Edge: EDGE_KEY,
  Chromium: "HKCU\\Software\\Chromium\\NativeMessagingHosts\\" + HOST_NAME,
  Brave: "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\" + HOST_NAME,
  Firefox: "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\" + HOST_NAME,
};

const results = [];
const evidence = { startedAt: new Date().toISOString(), scenarios: [], env: {} };
const log = (...a) => console.log(...a);

function record(name, ok, detail, extra) {
  results.push({ name, ok, detail, ...(extra || {}) });
  log((ok ? "    PASS  " : "    FAIL  ") + name + (detail ? "  - " + detail : ""));
  return ok;
}

// ---------------------------------------------------------------- fixture

async function startFixture() {
  const payload = randomBytes(512 * 1024);
  const sha = createHash("sha256").update(payload).digest("hex");
  const page = "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<title>p0b fixture</title></head><body><h1>p0b fixture</h1>" +
    "<video src=\"/payload.bin\" width=\"320\" height=\"180\"></video>" +
    "<script>fetch(\"/payload.bin\").catch(function(){});</script>" +
    "</body></html>";
  const srv = http.createServer((req, res) => {
    const u = String(req.url || "/").split("?")[0];
    if (u === "/" || u === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(page) });
      res.end(page);
      return;
    }
    if (u === "/payload.bin") {
      res.writeHead(200, { "content-type": "video/mp4", "content-length": payload.length, "accept-ranges": "bytes" });
      res.end(payload);
      return;
    }
    res.writeHead(404); res.end("no");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  return {
    port,
    pageUrl: "http://127.0.0.1:" + port + "/",
    url: "http://127.0.0.1:" + port + "/payload.bin",
    size: payload.length,
    sha256: sha,
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); setTimeout(r, 1200); }),
  };
}

// ---------------------------------------------------------------- daemon

// The daemon reads config.json once, at startup. Batch 01 wrote three files
// into the user's real Downloads because defaultDir was still unset when the
// daemon started, so the directory is pinned here, before every start.
async function pinConfig(home) {
  await fsp.mkdir(home, { recursive: true });
  const file = path.join(home, "config.json");
  let current = {};
  try { current = JSON.parse(await fsp.readFile(file, "utf8")); } catch { current = {}; }
  const merged = Object.assign({}, current, {
    defaultDir: DOWNLOADS,
    categorizeByType: false,
    overwriteExisting: "overwrite",
    maxConnections: 2,
    startQueueAutomatically: true,
  });
  await fsp.writeFile(file, JSON.stringify(merged, null, 2), "utf8");
  return file;
}

async function readRuntime(home) {
  try { return JSON.parse(await fsp.readFile(path.join(home, "runtime.json"), "utf8")); }
  catch { return null; }
}

async function api(rt, method, route, body) {
  const headers = { "x-downloadx-token": rt.token };
  if (body) headers["content-type"] = "application/json";
  const res = await fetch("http://" + rt.host + ":" + rt.port + route, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  return { status: res.status, payload };

}

async function startDaemon(home, tag) {
  await pinConfig(home);
  const outFile = path.join(OUT, "daemon-" + tag + ".out.log");
  const errFile = path.join(OUT, "daemon-" + tag + ".err.log");
  const out = fs.openSync(outFile, "a");
  const err = fs.openSync(errFile, "a");
  const child = spawn(NODE, [path.join(PROJECT, "bin", "downloadx.mjs"), "daemon"], {
    cwd: PROJECT,
    // DOWNLOADX_HOST_NAME is pinned to production: this scenario needs a real
    // Edge to reach the host, so a namespaced registration would prove nothing.
    env: Object.assign({}, process.env, { DOWNLOADX_HOME: home, DOWNLOADX_HOST_NAME: HOST_NAME }),
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + 40000;
  for (;;) {
    const rt = await readRuntime(home);
    if (rt) {
      try {
        const st = await api(rt, "GET", "/api/status");
        if (st.status === 200) return { rt, pid: child.pid, outFile, errFile };
      } catch { /* still binding */ }
    }
    if (Date.now() > deadline) {
      throw new Error("daemon did not become reachable within 40s (see " + outFile + ")");
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

function killPid(pid) {
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}

async function stopDaemon(home, pid) {
  const rt = await readRuntime(home);
  if (rt) { try { await api(rt, "POST", "/api/shutdown"); } catch { /* gone */ } }
  if (pid) killPid(pid);
  const deadline = Date.now() + 15000;
  for (;;) {
    if (!(await readRuntime(home))) return true;
    if (Date.now() > deadline) { if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} } return false; }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Prove the daemon process named by runtime.json is actually alive.
 *
 * Batch 01's failure was a daemon that had quietly exited while its
 * runtime.json still pointed at it. Reachability alone would not have caught
 * that, so the pid is checked directly before every click as well.
 */
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err && err.code === "EPERM"; }
}

/** Reachable over HTTP *and* the recorded pid is still running. */
async function assertDaemonReady(home, label) {
  const reach = await isDaemonReachable(home);
  const rt = reach.rt;
  const alive = rt ? pidAlive(rt.pid) : false;
  return { reachable: reach.reachable, alive, pid: rt ? rt.pid : null, port: rt ? rt.port : null, reason: reach.reason };
}

async function isDaemonReachable(home) {
  const rt = await readRuntime(home);
  if (!rt) return { reachable: false, reason: "no runtime.json" };
  try {
    const st = await api(rt, "GET", "/api/status");
    return st.status === 200
      ? { reachable: true, rt }
      : { reachable: false, reason: "HTTP " + st.status, rt };
  } catch (e) {
    return { reachable: false, reason: (e && e.code) || (e && e.message), rt };
  }
}

// ---------------------------------------------------------------- registry

/**
 * Read one key's (default) value, or null when it is absent.
 *
 * reg.exe prints in the OEM code page, which mangles any non-ASCII path. These
 * values are written back verbatim in the finally block below, so a mangled
 * read would silently corrupt a working registration - PowerShell is asked for
 * UTF-8 instead.
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

function regWrite(key, value) {
  execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], { stdio: "ignore" });
}

function regDelete(key) {
  try { execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" }); } catch { /* absent */ }
}

/**
 * Put every host registration this run may have written back to what it was.
 *
 * These are the *production* keys a real Edge needs, so the restore has to
 * happen on every exit path, not only the happy one. A finally block does not
 * run on Ctrl-C and does not run on an uncaught exception; leaving five keys
 * pointing at manifests inside the scratch ROOT is exactly the pollution this
 * batch exists to remove.
 *
 * @returns {number} how many keys were written or deleted
 */
function restoreHostRegistrations(previousReg, keys = HOST_KEYS) {
  let restored = 0;
  for (const [name, key] of Object.entries(keys)) {
    try {
      if (previousReg[name]) regWrite(key, previousReg[name]); else regDelete(key);
      restored++;
    } catch { /* best effort on the way out */ }
  }
  return restored;
}

/**
 * Arm the restore on every way this process can end.
 *
 * @returns {() => number} the restore itself, made idempotent so the normal
 *   finally block and the exit hook cannot write the keys twice
 */
function armHostRegistrationRestore(previousReg, keys = HOST_KEYS) {
  let done = false;
  const once = () => {
    if (done) return 0;
    done = true;
    return restoreHostRegistrations(previousReg, keys);
  };
  // Normal end, process.exit(), and a rejection nobody handled all land here.
  process.on("exit", once);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => { once(); process.exit(signal === "SIGINT" ? 130 : 143); });
  }
  // Restore first, then keep the failure visible instead of hiding it.
  process.on("uncaughtException", (err) => {
    process.stderr.write("\n  crashed: " + ((err && err.stack) || err) + "\n");
    once();
    process.exit(1);
  });
  return once;
}

function installHostFor(extensionId, home) {
  const out = execFileSync(NODE, [path.join(EXT_DIR, "install.mjs"), "install", "--extension-id", extensionId], {
    cwd: PROJECT,
    env: Object.assign({}, process.env, { DOWNLOADX_HOME: home }),
    encoding: "utf8",
  });
  return out;
}

// ---------------------------------------------------------------- CDP

async function cdpTargets() {
  const res = await fetch("http://127.0.0.1:" + CDP_PORT + "/json/list");
  return res.json();
}

async function waitForCdp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version");
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("CDP did not come up on port " + CDP_PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
}

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async open(url) {
    const ws = new WebSocket(url);
    const s = new Session(ws);
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && s.pending.has(m.id)) { s.pending.get(m.id)(m); s.pending.delete(m.id); }
    });
    await new Promise((res, rej) => {
      ws.addEventListener("open", res);
      ws.addEventListener("error", () => rej(new Error("CDP socket error")));
    });
    return s;
  }
  send(method, params) {
    return new Promise((resolve) => {
      const id = ++this.id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      return { __error: String(r.result.exceptionDetails.text || "evaluate failed") };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

const BADGE_STATE = "(() => {"
  + " const b = document.getElementById('__downloadx_badge__');"
  + " if (!b) return null;"
  + " const btns = [...b.querySelectorAll('button')];"
  + " const get = btns.find(x => ['Get','\\u2026','Queued','Already queued','Retry'].includes(x.textContent));"
  + " return { text: b.innerText, label: get ? get.textContent : null, disabled: get ? get.disabled : null };"
  + "})()";

const GET_RECT = "(() => {"
  + " const b = document.getElementById('__downloadx_badge__');"
  + " if (!b) return 'no badge';"
  + " const el = [...b.querySelectorAll('button')].find(x => x.textContent === 'Get');"
  + " if (!el) return 'no get button';"
  + " const r = el.getBoundingClientRect();"
  + " return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });"
  + "})()";

async function waitBadge(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await session.eval(BADGE_STATE);
    if (st && st.text && /Get|Queued|Retry/.test(st.text)) return st;
    if (Date.now() > deadline) return st || null;
    await new Promise((r) => setTimeout(r, 350));
  }
}

/** Real mouse input: moved -> pressed -> released. Never element.click(). */
async function realClick(session, x, y) {
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await new Promise((r) => setTimeout(r, 120));
  await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 90));
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

async function waitLabelSettled(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await session.eval(BADGE_STATE);
    if (st && st.label && ["Queued", "Already queued", "Retry"].includes(st.label)) return st;
    if (Date.now() > deadline) return st || null;
    await new Promise((r) => setTimeout(r, 350));
  }
}

// ---------------------------------------------------------------- edge

function edgeExe() {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("msedge.exe not found");
}

async function launchEdge(profile) {
  await fsp.mkdir(profile, { recursive: true });
  const child = spawn(edgeExe(), [
    "--user-data-dir=" + profile,
    "--remote-debugging-port=" + CDP_PORT,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--enable-unsafe-extension-debugging",
    "--disable-extensions-except=" + EXT_DIR,
    "--load-extension=" + EXT_DIR,
    "about:blank",
  ], {
    detached: true,
    stdio: "ignore",
    env: Object.assign({}, process.env, { DOWNLOADX_HOME: HOME }),
  });
  child.unref();
  return child.pid;
}

function killOwnEdge(profile) {
  // Only processes carrying THIS profile path - the user's own Edge is never a candidate.
  const ps = [
    "$m = Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*" + profile + "*' };",
    "foreach ($x in $m) { Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join(" ");
  try {
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { stdio: "ignore" });
  } catch { /* best effort */ }
}

async function findExtensionId(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  for (;;) {
    try {
      last = await cdpTargets();
      const sw = last.find((t) => t.url && t.url.startsWith("chrome-extension://") && /background\.js$/.test(t.url));
      if (sw) return sw.url.replace("chrome-extension://", "").replace(/\/.*$/, "");
    } catch { /* not ready */ }
    if (Date.now() > deadline) {
      throw new Error("extension service worker never appeared; targets=" + JSON.stringify(last.map((t) => t.type + " " + t.url)));
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---------------------------------------------------------------- scenarios

/**
 * Drive one full click-to-download cycle on an already-running Edge.
 *
 * @param {{fixture:object, home:string, expectSuccess:boolean, tag:string}} opts
 */
async function clickAndObserve({ fixture, home, tag }) {
  const targets = await cdpTargets();
  const page = targets.find((t) => t.type === "page" && !String(t.url).startsWith("edge://"))
    || targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target to drive");

  const session = await Session.open(page.webSocketDebuggerUrl);
  const observed = {};
  try {
    await session.send("Page.enable", {});
    await session.send("Runtime.enable", {});
    // A background (non-foreground) window does not deliver Input events;
    // this keeps the browser usable even when another window has focus.
    await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });

    // A fresh query per run: the extension keys its 30s cooldown on the URL, so
    // reusing one would let P0-C's de-dup state mask the click under test.
    const pageUrl = fixture.pageUrl + "?p0b=" + tag;
    const targetUrl = fixture.url + "?p0b=" + tag;

    await session.send("Page.navigate", { url: pageUrl });
    await new Promise((r) => setTimeout(r, 3000));
    observed.pageUrl = pageUrl;

    // Wait for the content script badge.
    const st = await waitBadge(session, 15000);
    observed.badgeBefore = st;
    if (!st || !st.text) throw new Error("the extension badge never appeared");
    observed.targetUrl = targetUrl;

    await session.eval("window.__p0bClicks = []; document.addEventListener('click', e => {"
      + " window.__p0bClicks.push(e.target && e.target.textContent); }, true); true");

    const rawRect = await session.eval(GET_RECT);
    if (typeof rawRect !== "string" || rawRect[0] !== "{") {
      throw new Error("the Get button was not found: " + JSON.stringify(rawRect));
    }
    const rect = JSON.parse(rawRect);
    observed.button = rect;

    await realClick(session, rect.x, rect.y);
    await new Promise((r) => setTimeout(r, 400));
    observed.deliveredClicks = await session.eval("window.__p0bClicks");

    // The button settles to one of: Queued / Already queued / Retry.
    observed.afterClick = await waitLabelSettled(session, 25000);
  } finally {
    session.close();
  }
  return observed;
}

async function waitTask(rt, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const res = await api(rt, "GET", "/api/tasks");
    const list = (res.payload && res.payload.tasks) || [];
    last = list.filter((t) => String(t.url).startsWith(url) || String(t.url) === url);
    if (last.length) {
      const done = last.find((t) => t.status === "complete" || t.status === "error");
      if (done) return last;
    }
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
}

function sha256File(file) {
  const h = createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

// ---------------------------------------------------------------- runner

async function main() {
  const started = Date.now();
  await fsp.mkdir(OUT, { recursive: true });
  await fsp.mkdir(DOWNLOADS, { recursive: true });

  const snap = { scenarios: [] };
  let fixture = null;
  let daemon = null;
  const previousReg = {};
  for (const [name, key] of Object.entries(HOST_KEYS)) previousReg[name] = regRead(key);
  // From here on every exit path - normal, exit(), SIGINT/SIGTERM/SIGHUP,
  // uncaughtException - puts the five production keys back verbatim.
  const restoreRegistrations = armHostRegistrationRestore(previousReg);
  const countEdge = () => Number(execFileSync("powershell",
    ["-NoProfile", "-Command", "(Get-Process msedge -ErrorAction SilentlyContinue | Measure-Object).Count"],
    { encoding: "utf8" }).trim());

  try {
    fixture = await startFixture();
    snap.fixture = { pageUrl: fixture.pageUrl, url: fixture.url, size: fixture.size, sha256: fixture.sha256 };
    log("  fixture: " + fixture.pageUrl + "  payload " + fixture.size + "B");

    // ---- Edge is started exactly ONCE ------------------------------
    // Restarting it between scenarios proved unreliable: the previous
    // browser still holds the user-data-dir lock while it shuts down, and
    // the second instance silently comes up without --remote-debugging-port.
    // Only the daemon state changes between scenarios, which is also the
    // more faithful reproduction of a user who leaves the browser open.
    snap.userEdgeProcessesBefore = countEdge();
    killOwnEdge(EDGE_PROFILE);
    await new Promise((r) => setTimeout(r, 2500));

    const edgePid = await launchEdge(EDGE_PROFILE);
    const version = await waitForCdp(60000);
    const extId = await findExtensionId(60000);
    Object.assign(snap, {
      edgeVersion: version.Browser,
      userAgent: version["User-Agent"],
      extensionId: extId,
      cdpPort: CDP_PORT,
      userDataDir: EDGE_PROFILE,
      edgePid,
    });
    log("  edge: " + version.Browser + "  extension " + extId + "  cdp " + CDP_PORT);

    installHostFor(extId, HOME);
    snap.nativeManifest = path.join(HOME, "host", "Edge.json");
    snap.nativeManifestPath = JSON.parse(await fsp.readFile(snap.nativeManifest, "utf8")).path;
    log("  native host registered -> " + snap.nativeManifestPath);

    // The native host is also proven to answer, so a later failure cannot be
    // blamed on the host failing to start.
    const hostProbe = execFileSync(NODE, [path.join(EXT_DIR, "install.mjs"), "status"], {
      cwd: PROJECT,
      env: Object.assign({}, process.env, { DOWNLOADX_HOME: HOME, DOWNLOADX_HOST_NAME: HOST_NAME }),
      encoding: "utf8",
    });
    fs.writeFileSync(path.join(OUT, "install-status-before.json"), hostProbe, "utf8");
    const edgeLine = hostProbe.split(/\r?\n/).find((l) => /\[x\]\s+Edge/.test(l));
    const probeLine = hostProbe.split(/\r?\n/).find((l) => /started and answered ping/.test(l));
    snap.installStatusEdge = edgeLine ? edgeLine.trim() : null;
    snap.installStatusProbe = probeLine ? probeLine.trim() : null;

    // =============================================================
    // Scenario 1: daemon already running -> click -> file lands
    // =============================================================
    log("");
    log("  --- scenario 1: daemon running ---");
    await stopDaemon(HOME, null);
    daemon = await startDaemon(HOME, "s1");

    const ready1 = await assertDaemonReady(HOME, "s1");
    snap.scenario1 = { daemonPort: ready1.port, daemonPid: ready1.pid, aliveBeforeClick: ready1.alive, reachableBeforeClick: ready1.reachable };
    log("  daemon pid " + ready1.pid + " port " + ready1.port + " alive=" + ready1.alive + " reachable=" + ready1.reachable);
    if (!ready1.alive || !ready1.reachable) {
      record("scenario 1: daemon alive and reachable before the click", false,
        "pid alive=" + ready1.alive + " reachable=" + ready1.reachable + " (" + (ready1.reason || "-") + ")");
    } else {
      record("scenario 1: daemon alive and reachable before the click", true, "pid " + ready1.pid + " port " + ready1.port);
    }

    const gui1 = await fetch(daemon.rt.url).then((r) => r.status).catch(() => 0);
    snap.scenario1.guiStatus = gui1;

    const obs1 = await clickAndObserve({ fixture, home: HOME, tag: "s1" });
    Object.assign(snap.scenario1, obs1);
    logger(obs1);

    const s1Tasks = await waitTask(daemon.rt, fixture.url, 60000);
    snap.scenario1.tasks = s1Tasks;
    const s1done = s1Tasks.find((t) => t.status === "complete");

    if (s1done) {
      const file = path.join(s1done.dir, s1done.filename);
      const exists = fs.existsSync(file);
      const size = exists ? fs.statSync(file).size : null;
      const sha = exists ? sha256File(file) : null;
      Object.assign(snap.scenario1, { taskId: s1done.id, file, size, sha256: sha });
      record("scenario 1: real click => task in daemon => file on disk with matching SHA-256",
        exists && size === fixture.size && sha === fixture.sha256,
        exists ? (size + "B sha=" + sha.slice(0, 16)) : "file missing");
    } else {
      record("scenario 1: real click => task in daemon => file on disk with matching SHA-256", false,
        "no completed task; tasks=" + JSON.stringify(s1Tasks.map((t) => ({ s: t.status, u: t.url }))));
    }

    // =============================================================
    // Scenario 2: daemon NOT running -> click -> explicit error, or auto-start
    // =============================================================
    log("");
    log("  --- scenario 2: daemon down ---");
    await stopDaemon(HOME, daemon.pid);
    daemon = null;
    await new Promise((r) => setTimeout(r, 1500));

    const ready2 = await assertDaemonReady(HOME, "s2");
    snap.scenario2 = { aliveBeforeClick: ready2.alive, reachableBeforeClick: ready2.reachable, reason: ready2.reason };
    log("  daemon alive=" + ready2.alive + " reachable=" + ready2.reachable + " (" + (ready2.reason || "-") + ")");
    record("scenario 2: daemon is genuinely down before the click", !ready2.reachable,
      "reachable=" + ready2.reachable + " (" + (ready2.reason || "-") + ")");

    const obs2 = await clickAndObserve({ fixture, home: HOME, tag: "s2" });
    Object.assign(snap.scenario2, obs2);
    logger(obs2);

    const reachAfter = await assertDaemonReady(HOME, "s2-after");
    const autoStarted = reachAfter.reachable;
    let s2tasks = [];
    if (autoStarted) {
      s2tasks = await waitTask(reachAfter.rt || (await readRuntime(HOME)), fixture.url, 60000);
      snap.scenario2.autoStartedPid = reachAfter.pid;
      snap.scenario2.autoStartedPort = reachAfter.port;
    }
    const s2done = s2tasks.find((t) => t.status === "complete");

    const afterLabel = (obs2.afterClick && obs2.afterClick.label) || null;
    const badgeText = (obs2.afterClick && obs2.afterClick.text) || "";
    const actionable = /daemon is not running|start it with|downloadx\.cmd|bin[\\/]downloadx\.mjs/i.test(badgeText);

    // A claim of success must be checked against the queue, not trusted from
    // the button text: "Already queued" also appears when the extension is
    // merely suppressing a duplicate announcement.
    let claimedQueued = afterLabel === "Queued" || afterLabel === "Already queued";

    snap.scenario2.afterLabel = afterLabel;
    snap.scenario2.autoStarted = autoStarted;
    snap.scenario2.claimedQueued = claimedQueued;
    snap.scenario2.tasks = s2tasks;

    if (autoStarted && s2done) {
      const file = path.join(s2done.dir, s2done.filename);
      const exists = fs.existsSync(file);
      const size = exists ? fs.statSync(file).size : null;
      const sha = exists ? sha256File(file) : null;
      Object.assign(snap.scenario2, { taskId: s2done.id, file, size, sha256: sha });
      record("scenario 2: with no daemon running, the product either auto-starts it or shows an actionable error", true,
        "design = host auto-starts the daemon; " + (exists ? size + "B sha=" + sha.slice(0, 16) : "file missing"));
      snap.scenario2.design = "host-auto-start";
    } else if (!autoStarted && (actionable || afterLabel === "Retry")) {
      record("scenario 2: with no daemon running, the product either auto-starts it or shows an actionable error", true,
        "design = user starts the daemon; UI says " + JSON.stringify(badgeText.slice(0, 200)));
      snap.scenario2.design = "user-starts-daemon";
    } else if (autoStarted) {
      record("scenario 2: with no daemon running, the product either auto-starts it or shows an actionable error", false,
        "daemon came back reachable but no task completed");
      snap.scenario2.design = "host-auto-start-incomplete";
    } else if (claimedQueued) {
      record("scenario 2: with no daemon running, the product either auto-starts it or shows an actionable error", false,
        "UI claimed " + afterLabel + " while no daemon was reachable - silent failure");
      snap.scenario2.design = "silent-failure";
    } else {
      record("scenario 2: with no daemon running, the product either auto-starts it or shows an actionable error", false,
        "no actionable error, no auto-start; label=" + afterLabel + " text=" + JSON.stringify(badgeText.slice(0, 200)));
      snap.scenario2.design = "unknown";
    }

    snap.scenario1.guiReachable = gui1 === 200;
  } finally {
    if (daemon) { try { await stopDaemon(HOME, daemon.pid); } catch { /* gone */ } }
    else { try { await stopDaemon(HOME, null); } catch { /* gone */ } }
    killOwnEdge(EDGE_PROFILE);
    if (fixture) await fixture.close();
    // Verbatim restore of every key this run could have touched. Same function
    // the exit hooks call, so an exception thrown below cannot skip it.
    restoreRegistrations();
    snap.userEdgeProcessesAfter = countEdge();
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;

  evidence.env = snap;
  evidence.finishedAt = new Date().toISOString();
  evidence.elapsedSeconds = Number(elapsed);
  evidence.results = results;
  await fsp.writeFile(path.join(OUT, "p0b-evidence.json"), JSON.stringify(evidence, null, 2), "utf8");

  log("");
  log("  " + passed + " passed, " + failed + " failed  (" + elapsed + "s)");
  log("  evidence: " + path.join(OUT, "p0b-evidence.json"));
  return failed === 0 ? 0 : 1;
}

function logger(obs) {
  log("    page      " + obs.pageUrl);
  log("    badge     " + JSON.stringify(String((obs.badgeBefore && obs.badgeBefore.text) || "").slice(0, 120)));
  log("    button    " + JSON.stringify(obs.button));
  log("    clicks    " + JSON.stringify(obs.deliveredClicks));
  log("    after     " + JSON.stringify(obs.afterClick && { label: obs.afterClick.label, disabled: obs.afterClick.disabled }));
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    process.stderr.write("\n  crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
}

export { main, startFixture, startDaemon, stopDaemon, isDaemonReachable, pinConfig,
  launchEdge, killOwnEdge, findExtensionId, waitForCdp, cdpTargets, Session,
  waitBadge, realClick, waitLabelSettled, BADGE_STATE, GET_RECT,
  regRead, regWrite, regDelete, restoreHostRegistrations, armHostRegistrationRestore,
  installHostFor, record, results, evidence,
  HOME, DOWNLOADS, EDGE_PROFILE, OUT, CDP_PORT, PROJECT, EXT_DIR, EDGE_KEY };