#!/usr/bin/env node
// Native messaging host for the downloadx browser extension.
//
// Chrome/Edge speak a simple framing on stdio: a 4-byte little-endian length
// followed by that many bytes of UTF-8 JSON. Anything else on stdout corrupts
// the stream, so all logging goes to the daemon log file instead.
//
// The extension can ask this host to:
//   ping      -> is the daemon reachable?
//   add       -> queue a download
//   probe     -> inspect a URL (size, type, whether it is worth intercepting)
//   config    -> current settings
//   media     -> record a discovered media stream (for the grabber)

import process from "node:process";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { paths } from "../src/paths.mjs";

const MAX_MESSAGE = 32 * 1024 * 1024;
/**
 * Message protocol version. The extension sends the version it speaks so a
 * mismatch fails loudly with an actionable message instead of being
 * misinterpreted field by field.
 */
const PROTOCOL = 1;

function encode(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

function write(obj) {
  process.stdout.write(encode(obj));
}

/** Minimal logging: native hosts must not pollute stdout. */
async function logLine(message) {
  try {
    await fsp.appendFile(path.join(paths.logs, "extension.log"),
      new Date().toISOString() + " " + message + "\n");
  } catch { /* logging is best effort */ }
}

async function readRuntime() {
  try {
    const raw = JSON.parse(await fsp.readFile(paths.runtime, "utf8"));
    try { process.kill(raw.pid, 0); } catch { return null; }
    return raw;
  } catch { return null; }
}

/**
 * Task statuses that make a URL "already in progress" for dedup purposes.
 *
 * "error" is deliberately NOT live: a failed task is a legitimate reason to
 * download again, and treating it as live meant the extension could never
 * re-queue a failed URL (every retry answered duplicate:true and silently
 * did nothing). "complete" is not live for the same reason.
 */
export const LIVE_TASK_STATUSES = ["queued", "connecting", "downloading", "paused"];

/**
 * Pure part of the live-task lookup, exported for the batch-1 regression test.
 * @param {Array<{url: string, status: string}>} tasks
 * @param {string} url
 */
export function findLiveTaskIn(tasks, url) {
  const live = new Set(LIVE_TASK_STATUSES);
  return (tasks || []).find((t) => t && t.url === url && live.has(t.status)) || null;
}

/**
 * Reply for a URL that already has a live task: carries the existing task's
 * status so the extension can tell the user what is holding the URL.
 * @param {{url: string, status: string}} task
 */
export function duplicateReply(task) {
  return { ok: true, task, duplicate: true, duplicateStatus: task && task.status };
}

/**
 * Find an existing task for this URL that has not finished.
 *
 * The content script's badge and the webRequest observer can both fire for the
 * same URL, and the user can click "Get" more than once. Without this check
 * every repeat created another task and the queue filled with duplicates of one
 * download. Only live tasks count: a completed or failed task is a legitimate
 * reason to download again.
 */
async function findLiveTask(url) {
  const payload = await daemonCall("GET", "/api/tasks");
  return findLiveTaskIn(payload.tasks, url);
}

/** Queue a download, reusing a live task for the same URL when there is one. */
async function enqueue(message, { kind } = {}) {
  const duplicate = await findLiveTask(message.url);
  if (duplicate) return duplicateReply(duplicate);
  const payload = await daemonCall("POST", "/api/tasks", {
    url: message.url,
    filename: message.filename,
    referer: message.referer,
    cookies: message.cookies,
    headers: message.headers,
    kind: kind ?? message.kind,
    meta: message.meta,
    // Marks the add as extension-sourced, the way "clipboard" marks the
    // clipboard watcher. While the daemon's askBeforeAdd setting is on, these
    // adds wait in its pending list for the user to confirm (202 + pending)
    // instead of entering the queue directly; the daemon's own live-task
    // guard covers the same-URL race this host-side check can miss.
    queueId: "extension",
  });
  // askBeforeAdd: the daemon answers 202 with a pending record and no task.
  // Report the hold for what it is instead of letting the extension pretend a
  // task was created.
  if (payload.pending) {
    return { ok: true, pending: true, pendingId: payload.pending.id, duplicate: false };
  }
  return { ok: true, task: payload.task, duplicate: false };
}

async function daemonCall(method, route, body) {
  const rt = await readRuntime();
  if (!rt) {
    // The extension cannot tell "never started" from "crashed" on its own, so
    // say what the user can actually do about it.
    throw new Error("feiliu daemon is not running; start it with downloadx.cmd or `node bin/downloadx.mjs daemon`");
  }
  const headers = { "x-downloadx-token": rt.token };
  if (body) headers["content-type"] = "application/json";
  const res = await fetch("http://" + rt.host + ":" + rt.port + route, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  if (!res.ok) throw new Error(payload.error || ("HTTP " + res.status));
  return payload;
}

async function handle(message) {
  const type = message && message.type;
  // Older/hand-rolled callers may omit the version; only reject a version that
  // is present and different, so the plain CLI-style messages keep working.
  if (message && message.protocol !== undefined && message.protocol !== PROTOCOL) {
    throw new Error("unsupported protocol version " + message.protocol +
      " (this host speaks " + PROTOCOL + "); reload the extension");
  }
  switch (type) {
    case "ping": {
      const rt = await readRuntime();
      return { ok: !!rt, daemon: rt ? { url: rt.url, running: true, pid: rt.pid } : { running: false } };
    }
    case "add": {
      if (!message.url) throw new Error("url is required");
      return await enqueue(message);
    }
    case "probe": {
      if (!message.url) throw new Error("url is required");
      return await daemonCall("POST", "/api/probe", {
        url: message.url,
        headers: message.headers,
        rules: message.rules,
      });
    }
    case "status": {
      const rt = await readRuntime();
      if (!rt) return { daemon: { running: false } };
      const payload = await daemonCall("GET", "/api/status");
      return { daemon: { running: true, url: rt.url, pid: rt.pid }, status: payload };
    }
    case "config": {
      const payload = await daemonCall("GET", "/api/config");
      return { ok: true, config: payload.config };
    }
    case "list": {
      const payload = await daemonCall("GET", "/api/tasks");
      return { ok: true, tasks: payload.tasks };
    }
    case "add-stream":
    case "media": {
      // A page told us about a media stream; queue it as a stream download.
      // No implicit "hls": a URL without an explicit kind is treated as http,
      // and the downloader detects HLS/DASH from the manifest itself. Defaulting
      // to hls sent plain files down the manifest path.
      if (!message.url) throw new Error("url is required");
      return await enqueue(message, { kind: message.kind || "http" });
    }
    case "approve-pending": {
      // The takeover notification was clicked while askBeforeAdd held the
      // add: clicking means "yes", so approve it here instead of making the
      // user find the banner in the app window.
      if (!message.id) throw new Error("id is required");
      return await daemonCall("POST", "/api/pending/" + encodeURIComponent(message.id) + "/approve", {});
    }
    case "focus-app": {
      // Signal the desktop shell to raise its window (same file-signal
      // pattern the second-instance handshake uses; no daemon route needed).
      await fsp.writeFile(path.join(paths.root, "focus.show"), String(process.pid), "utf8");
      return { ok: true };
    }
    default:
      throw new Error("unknown message type: " + String(type) +
        " (expected ping, add, probe, media, list, config or status)");
  }
}

async function main() {
  let buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) break;
      const length = buffer.readUInt32LE(0);
      if (length > MAX_MESSAGE) { await logLine("oversized message: " + length); process.exit(1); }
      if (buffer.length < 4 + length) break;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      let message = null;
      try { message = JSON.parse(body.toString("utf8")); } catch { write({ ok: false, error: "invalid JSON" }); continue; }
      try {
        const result = await handle(message);
        write(Object.assign({ ok: true }, result));
      } catch (err) {
        await logLine("error: " + (err && err.message));
        write({ ok: false, error: (err && err.message) || String(err) });
      }
    }
  }
}

// Only run the stdio loop when launched as the native host (node .../host.mjs),
// not when a test imports this module for its pure exports. The browser always
// launches the .cmd shim, which runs exactly `node <full path to host.mjs>`.
const invokedAsHost =
  Array.isArray(process.argv) &&
  process.argv[1] &&
  import.meta.url.toLowerCase() ===
    pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase();

if (invokedAsHost) {
  main().catch(async (err) => { await logLine("fatal: " + (err && err.stack)); process.exit(1); });
}
