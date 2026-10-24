// Browser-level GUI verification over the Chrome DevTools Protocol.
//
// The acceptance criteria say an API returning 200 is not interface evidence.
// This drives a real Chromium browser: it loads the actual page, clicks the
// actual buttons and reads the DOM back. Node 22+ ships a global WebSocket, so
// this needs no browser-automation dependency.
//
// The browser is only an observation surface. Every assertion is about what a
// user would see or about the task state, never about a bare HTTP status.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

import { assert } from "./harness.mjs";

/** Browsers this host can drive, most preferred first. */
const CANDIDATES = [
  { name: "Edge", paths: [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ]},
  { name: "Chrome", paths: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ]},
];

/** Find an installed Chromium browser, or null when there is none. */
export function findBrowser() {
  for (const b of CANDIDATES) {
    for (const p of b.paths) {
      try { if (fs.existsSync(p)) return { name: b.name, path: p }; } catch { /* keep looking */ }
    }
  }
  return null;
}

/** Ask the DevTools endpoint for the WebSocket URL of the page target. */
async function pageTarget(port, deadlineMs = 20000) {
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < deadlineMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("no DevTools page target on port " + port + (lastErr ? ": " + lastErr.message : ""));
}

/** A minimal CDP client: send a command, await its result. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      let msg = null;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("DevTools websocket failed to open")), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("CDP command timed out: " + method));
        }
      }, 30000);
    });
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error("page threw: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result ? r.result.value : undefined;
  }

  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

/**
 * Launch a browser with the DevTools endpoint enabled.
 *
 * @returns {{proc:import('node:child_process').ChildProcess, port:number, profile:string, close:Function}}
 */
export async function launchBrowser({ browser, port = 9333 } = {}) {
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-gui-profile-"));
  const proc = spawn(browser.path, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + profile,
    "about:blank",
  ], { stdio: "ignore", windowsHide: true });

  proc.on("error", () => {});
  // The port must be live before anything can connect.
  await pageTarget(port);

  return {
    proc,
    port,
    profile,
    async close() {
      try { proc.kill(); } catch { /* already gone */ }
      await new Promise((r) => setTimeout(r, 400));
      await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Wait until fn() returns truthy, or throw with `what`. */
export async function waitFor(fn, what, timeoutMs = 20000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("timed out waiting for " + what + (last === null ? "" : " (last: " + JSON.stringify(last) + ")"));
}

/**
 * An origin that can be told to misbehave, so a failure state can be produced
 * on purpose rather than hoped for.
 */
export async function startGuiOrigin({ size = 1 * 1024 * 1024 } = {}) {
  const body = Buffer.alloc(size, 0x5a);
  const state = { mode: "ok", requests: 0, rangedRequests: 0 };
  const srv = http.createServer((req, res) => {
    state.requests++;
    if (state.mode === "fail") {
      res.writeHead(500, { "Content-Type": "text/plain", "Content-Length": "5" });
      res.end("boom!");
      return;
    }
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    if (m) {
      state.rangedRequests++;
      const s = Number(m[1]);
      const e = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      const slice = body.subarray(s, e + 1);
      res.writeHead(206, {
        "Content-Range": `bytes ${s}-${e}/${size}`,
        "Content-Length": slice.length,
        "Accept-Ranges": "bytes",
      });
      // Trickle so the transfer is slow enough to pause mid-flight.
      let i = 0;
      const chunk = Math.max(4096, Math.floor(slice.length / 24));
      const tick = () => {
        if (i >= slice.length) { res.end(); return; }
        if (res.destroyed) return;
        res.write(slice.subarray(i, i + chunk));
        i += chunk;
        setTimeout(tick, 25);
      };
      tick();
      return;
    }
    res.writeHead(200, {
      "Content-Length": size, "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="gui-probe.bin"',
    });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: "http://127.0.0.1:" + srv.address().port + "/download.bin",
    slowUrl: "http://127.0.0.1:" + srv.address().port + "/slow.bin",
    state,
    body,
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r(undefined)); setTimeout(() => r(undefined), 1500); }),
  };
}

export { Cdp, pageTarget };
