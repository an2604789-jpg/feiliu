// desktop-e2e-main.mjs — Electron main-process harness for the desktop E2E.
//
// This file is executed BY Electron (not Node): `electron test/desktop-e2e-main.mjs`.
// It reuses the exact production pieces — desktop/daemonManager.mjs and
// desktop/preload.cjs — to show the real gui/index.html in a real Electron
// window, then drives that rendered UI with webContents.executeJavaScript (no
// remote-debugging port needed). It exists purely as a test harness; it is not
// part of the shipped app.
//
// Phases (selected with --phase=):
//   seed   : point config at an isolated folder, add a download that finishes,
//            pause/resume a slow one, fail then retry one, change a setting, and
//            write the resulting queue snapshot to the result file.
//   verify : relaunch against the same data root and report the persisted
//            queue snapshot and setting, proving they survived the restart.
//
// Result is written as JSON to --result= and the app then quits, which runs the
// same owned-daemon graceful shutdown the production main process uses.

import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonManager } from "../desktop/daemonManager.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const arg = (k, def = "") => {
  const prefix = "--" + k + "=";
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? decodeURIComponent(found.slice(prefix.length)) : def;
};

const phase = arg("phase");
const resultFile = arg("result");
const params = {
  outDir: arg("outdir"),
  slowUrl: arg("slowurl"),
  pauseUrl: arg("pauseurl"),
  failUrl: arg("failurl"),
  expectedCount: Number(arg("count", "0")),
};

const manager = new DaemonManager();
let finished = false;
let stopping = false;

const stageFile = resultFile ? path.join(path.dirname(resultFile), "stages.log") : null;
function stage(s) {
  try { if (stageFile) fs.appendFileSync(stageFile, Date.now() + " " + s + "\n"); } catch { /* ignore */ }
}
stage("module-evaluated phase=" + phase);

function finish(result) {
  stage("finish called ok=" + (result && result.ok));
  if (finished) return;
  finished = true;
  try { fs.writeFileSync(resultFile, JSON.stringify(result, null, 2)); } catch { /* reported below */ }
  setTimeout(() => app.quit(), 400);
}

const deadline = setTimeout(() => finish({ ok: false, phase, error: "phase " + phase + " timed out" }), 120000);

// Mirror the production shutdown: only stop the daemon this app started.
app.on("before-quit", (event) => {
  if (stopping) return;
  event.preventDefault();
  stopping = true;
  (async () => {
    try { await manager.stopOwned(); } catch { /* best effort */ }
    app.quit();
  })();
});

const sharedHelpers = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const token = () => window.__DOWNLOADX__.token;
  const waitFor = async (fn, what, ms = 90000) => {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < ms) {
      try { last = await fn(); } catch { last = null; }
      if (last) return last;
      await sleep(300);
    }
    throw new Error("timeout: " + what);
  };
  const readRows = () => [...document.querySelectorAll("#rows .task")].map((row) => {
    const pill = row.querySelector(".pill");
    const m = (pill.className.match(/pill\\s+([a-z]+)/) || []);
    return {
      id: row.dataset.id,
      name: norm(row.querySelector(".name") && row.querySelector(".name").textContent),
      status: m[1] || "",
      actions: [...row.querySelectorAll("button[data-a]")].map((b) => b.dataset.a),
    };
  });
  const find = (pred) => readRows().find(pred) || null;
  const snap = () => readRows().map((r) => r.name + "=" + r.status).sort();
  const addUrl = (u) => {
    const i = document.getElementById("urlInput");
    i.value = u;
    i.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("btnNew").click();
    document.getElementById("m-btnOk").click();
  };
  const click = (id, a) => {
    const row = document.querySelector('#rows .task[data-id="' + id + '"]');
    const b = row.querySelector('button[data-a="' + a + '"]');
    b.click();
  };
`;

const seedPage = `
(async () => {
  const P = __PARAMS__;
  const out = { ok: false, phase: "seed", steps: {}, error: null };
  try {
    ${sharedHelpers}
    const t = token();
    const patch = async (body) => {
      const r = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-downloadx-token": t },
        body: JSON.stringify(body),
      });
      return r.status;
    };
    document.querySelector('.nav-item[data-view="all"]').click();

    const sc = await patch({
      defaultDir: P.outDir,
      categorizeByType: false,
      overwriteExisting: "overwrite",
      maxConnections: 2,
      maxConcurrentDownloads: 2,
      monitorClipboard: false,
    });
    out.steps.config = sc === 200;

    // 1) a normal download that completes.
    addUrl(P.slowUrl);
    const d1 = await waitFor(() => find((r) => /slow\\.bin/.test(r.name) && r.status === "complete"), "first download completes");
    out.steps.downloadComplete = !!d1;

    // 2) a second, slow download: pause then resume.
    addUrl(P.pauseUrl);
    const running = await waitFor(
      () => find((r) => r.actions.includes("pause") && (r.status === "downloading" || r.status === "connecting")),
      "a running task offers pause"
    );
    out.steps.pauseButton = !!running;
    click(running.id, "pause");
    const paused = await waitFor(() => {
      const r = find((x) => x.id === running.id);
      return r && r.status === "paused" ? r : null;
    }, "task becomes paused");
    out.steps.paused = !!paused;
    click(running.id, "start");
    const resumed = await waitFor(() => {
      const r = find((x) => x.id === running.id);
      return r && r.status === "complete" ? r : null;
    }, "resumed task completes");
    out.steps.resumeComplete = !!resumed;

    // 3) a download that fails (origin is in fail mode), then retry until it
    //    completes. The orchestrator flips the origin back to ok after the
    //    failure is observed, so retry in a loop until recovery.
    addUrl(P.failUrl);
    const failed = await waitFor(() => find((r) => r.status === "error"), "a task reaches error");
    out.steps.failedShown = !!failed && failed.actions.includes("retry");
    const errId = failed.id;
    let recovered = null;
    for (let i = 0; i < 20 && !recovered; i++) {
      const cur = find((x) => x.id === errId);
      if (cur && cur.status === "error") click(errId, "retry");
      await sleep(2000);
      recovered = find((x) => x.id === errId && x.status === "complete");
    }
    out.steps.retryComplete = !!recovered;

    // 4) change a setting from the settings page.
    document.querySelector('.nav-item[data-view="page:settings"]').click();
    await sleep(400);
    document.getElementById("cfg-maxConnections").value = "4";
    document.getElementById("btnSaveCfg").click();
    await waitFor(() => /设置已保存|已保存/.test(document.getElementById("toast").textContent), "settings saved toast");
    const cfg = await (await fetch("/api/config", { headers: { "x-downloadx-token": t } })).json();
    out.steps.settingSaved = cfg.config.maxConnections === 4;
    document.querySelector('.nav-item[data-view="all"]').click();

    await sleep(1500);
    out.snapshot = snap();
    out.count = readRows().length;
    out.ok = Object.values(out.steps).every(Boolean);
  } catch (e) {
    out.ok = false;
    out.error = String((e && e.message) || e);
  }
  return out;
})()
`;

const verifyPage = `
(async () => {
  const P = __PARAMS__;
  const out = { ok: false, phase: "verify", error: null };
  try {
    ${sharedHelpers}
    const t = token();
    await waitFor(() => readRows().length >= P.expectedCount, "the persisted queue reappears", 40000);
    // Give the SSE-driven list a moment to settle.
    await sleep(800);
    const cfg = await (await fetch("/api/config", { headers: { "x-downloadx-token": t } })).json();
    out.snapshot = snap();
    out.count = readRows().length;
    out.maxConnections = cfg.config.maxConnections;
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = String((e && e.message) || e);
  }
  return out;
})()
`;

async function waitForUi(win) {
  const wc = win.webContents;
  for (let i = 0; i < 100; i++) {
    try {
      const ready = await wc.executeJavaScript(
        "!!(window.__DOWNLOADX__ && window.__DOWNLOADX__.token) && !!document.getElementById('ovActive')"
      );
      if (ready) return;
    } catch { /* page still navigating */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("GUI never became ready");
}

app.whenReady().then(async () => {
  let win = null;
  try {
    stage("ready: ensure daemon");
    const { rt } = await manager.ensure({ timeoutMs: 40000 });
    stage("daemon ready port=" + rt.port);
    win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 780,
      webPreferences: {
        preload: path.join(__dirname, "..", "desktop", "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    stage("window created");
    await win.loadURL(rt.url);
    stage("loadURL done");
    await waitForUi(win);
    stage("UI ready");
    const code = (phase === "seed" ? seedPage : verifyPage).replace("__PARAMS__", JSON.stringify(params));
    const result = await win.webContents.executeJavaScript(code, true);
    stage("page script returned");
    clearTimeout(deadline);
    finish(result || { ok: false, phase, error: "empty result" });
  } catch (err) {
    stage("ready catch: " + String((err && err.message) || err));
    clearTimeout(deadline);
    finish({ ok: false, phase, error: String((err && err.stack) || err) });
  }
}).catch((err) => {
  stage("whenReady rejected: " + String((err && err.message) || err));
  clearTimeout(deadline);
  finish({ ok: false, phase, error: "app failed to start: " + String((err && err.stack) || err) });
});
