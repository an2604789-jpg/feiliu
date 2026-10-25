#!/usr/bin/env node
// DownloadX MCP server: a thin, dependency-free Model Context Protocol endpoint
// over stdio that exposes the local download daemon to any agent.
//
// Protocol rules this file follows, because breaking any of them breaks the
// client rather than the server:
//   * stdout carries JSON-RPC messages only, one per line, newline-terminated.
//     No Content-Length framing, no banner, no log line.
//   * everything else -- warnings, stacks, timing -- goes to stderr.
//   * only tools are advertised. resources/prompts/sampling are not implemented
//     and are not claimed.
//
// The server owns no state: every call is translated into one or two requests
// against the daemon's HTTP API, whose contract is left untouched.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DxClient, DxError, sleep } from "./client.mjs";
import { ensureDaemon } from "./daemon.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

const SERVER_NAME = "downloadx";
const VERSION = readVersion();

/** Versions this server knows how to speak, newest first. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const PROTOCOL_VERSIONS = MCP_PROTOCOL_VERSIONS;

/** A declared size above this is refused unless the caller opts in. */
const LARGE_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** Upper bound for waitMs, matching the tool-call timeout in the docs. */
const MAX_WAIT_MS = 600000;

const TERMINAL = new Set(["complete", "error"]);

/** Schemes a download may use. file: and data: are refused explicitly.
 *  magnet: is allowed and delegates to the aria2c BT path (downloader
 *  detectKind routes magnet:?xt= to kind "bt"). */
const ALLOWED_SCHEMES = new Set(["http:", "https:", "ftp:", "magnet:"]);

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// --------------------------------------------------------------- arguments

/**
 * Validate a URL an agent asked to download.
 *
 * A bare host is accepted and given https, mirroring the CLI, because agents
 * routinely pass "example.com/file.bin". Everything else must name a scheme we
 * can actually transfer: file: and data: are refused here rather than allowed
 * to fail deeper in the stack, where the error would be less clear.
 *
 * @param {unknown} raw
 * @returns {string} absolute URL
 */
export function assertDownloadUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text) throw new DxError("url is required", { code: "EINVAL" });

  // A scheme without "//" (file:, data:, mailto:) has to be caught here: the
  // "add https:// if there is no scheme" rule below would otherwise turn
  // "data:text/plain,..." into a host named "data".
  // A scheme followed by digits is a host:port -- "example.com:8080/x" is a
  // bare host, not a scheme called "example.com".
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    const rest = text.slice(schemeMatch[0].length);
    if (!/^\d/.test(rest) && !ALLOWED_SCHEMES.has(scheme + ":")) {
      throw new DxError("refusing " + scheme + ": URLs; only http, https and ftp can be downloaded", {
        code: "EUNSUPPORTED_URL",
      });
    }
  }
  if (/^[a-z]:[\\/]/i.test(text)) {
    throw new DxError("refusing a local filesystem path: " + text, { code: "EUNSUPPORTED_URL" });
  }

  let withScheme = text;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(withScheme)) withScheme = "https://" + withScheme;

  let parsed;
  try { parsed = new URL(withScheme); }
  catch { throw new DxError("not a valid URL: " + text, { code: "EINVAL" }); }

  const scheme = parsed.protocol.toLowerCase();
  if (!ALLOWED_SCHEMES.has(scheme)) {
    throw new DxError("refusing " + scheme + " URLs; only http, https and ftp can be downloaded", {
      code: "EUNSUPPORTED_URL",
    });
  }
  return parsed.href;
}

/**
 * `dir` must be absolute: the daemon's working directory is not the caller's,
 * so a relative path would land somewhere neither side can predict.
 */
function assertAbsoluteDir(raw) {
  const text = String(raw).trim();
  if (!text) throw new DxError("dir must not be empty", { code: "EINVAL" });
  if (!path.isAbsolute(text)) {
    throw new DxError("dir must be an absolute path, got: " + text, { code: "EINVAL" });
  }
  return text;
}

/** A file name, not a path: separators would let the caller leave `dir`. */
function assertBareFilename(raw) {
  const text = String(raw).trim();
  if (!text) throw new DxError("filename must not be empty", { code: "EINVAL" });
  if (/[\\/]/.test(text) || text === "." || text === "..") {
    throw new DxError('filename must be a bare name without path separators, got: ' + text, { code: "EINVAL" });
  }
  return text;
}

function clampWait(raw) {
  if (raw === undefined || raw === null || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new DxError("waitMs must be a number >= 0", { code: "EINVAL" });
  return Math.min(MAX_WAIT_MS, Math.round(n));
}

// ------------------------------------------------------------------ tools

const HEADERS_SCHEMA = {
  type: "object",
  description: "Extra request headers, e.g. {\"User-Agent\": \"...\"}.",
  additionalProperties: { type: "string" },
};

const WAIT_SCHEMA = {
  type: "integer",
  minimum: 0,
  maximum: MAX_WAIT_MS,
  description:
    "0 (default) returns as soon as the task exists; a value above 0 waits up to that many milliseconds " +
    "for a terminal state and then returns the full task view.",
};

/** Tool catalogue. Descriptions state when to use the tool and what it changes. */
export const TOOL_DEFINITIONS = [
  {
    name: "downloadx_download",
    description:
      "Queue a download in the local DownloadX daemon. Side effect: writes a file to disk and starts " +
      "downloading immediately. Use waitMs=0 (the default) for long files and poll with downloadx_status, " +
      "or waitMs>0 to block until the transfer ends. A file the origin declares larger than 2 GB is " +
      "refused unless allowLarge is true.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http, https or ftp URL of the file to download." },
        dir: { type: "string", description: "Absolute directory to save into. Defaults to the daemon's download directory." },
        filename: { type: "string", description: "Bare file name to save as. Defaults to the name from the URL or Content-Disposition." },
        headers: HEADERS_SCHEMA,
        cookies: { type: "string", description: "Raw Cookie header value. Avoid unless the site requires it: it is a credential." },
        referer: { type: "string", description: "Referer header to send." },
        connections: { type: "integer", minimum: 1, maximum: 32, description: "Parallel connections (1-32)." },
        speedLimit: { type: "integer", minimum: 0, description: "Byte-per-second cap; 0 means unlimited." },
        queueId: { type: "string", description: "Queue bucket to file the task under, e.g. \"agent\"." },
        waitMs: WAIT_SCHEMA,
        allowLarge: {
          type: "boolean",
          description: "Allow a file the origin declares larger than 2 GB. Default false: refuse instead of filling the disk.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "downloadx_list",
    description:
      "List tasks known to the daemon, newest first. Read-only. Use it to find a task id before calling " +
      "downloadx_status or downloadx_control.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Only tasks in this state: queued, connecting, downloading, paused, complete, error.",
        },
        limit: { type: "integer", minimum: 1, description: "Return at most this many tasks." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "downloadx_status",
    description:
      "Read one task. Read-only. With waitMs=0 it answers immediately; with waitMs>0 it polls internally " +
      "until the task finishes or the wait expires. On a terminal state the result includes the file path " +
      "and a freshly computed sha256.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task id, as returned by downloadx_download or downloadx_list." },
        waitMs: WAIT_SCHEMA,
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "downloadx_control",
    description:
      "Change the state of one task. Side effects: pause stops the transfer (progress is kept), resume " +
      "continues it, retry resets the attempt counter and starts it again, cancel removes the task and its " +
      "partial data from the queue.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task id to act on." },
        action: { type: "string", enum: ["pause", "resume", "retry", "cancel"], description: "What to do." },
      },
      required: ["taskId", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "downloadx_probe",
    description:
      "Ask the origin what a URL is (size, ranges, MIME, suggested name) without writing anything to disk. " +
      "Use it before a download to check the size or whether the server supports ranges.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http, https or ftp URL to inspect." },
        headers: HEADERS_SCHEMA,
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "downloadx_stream_inspect",
    description:
      "Inspect a page or stream URL for media streams (HLS/DASH) before downloading. Read-only: nothing is " +
      "queued and nothing is written. Use it when a URL is a player page rather than a file.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Page or stream URL to inspect." },
        headers: HEADERS_SCHEMA,
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

const TOOL_BY_NAME = new Map(TOOL_DEFINITIONS.map((t) => [t.name, t]));

// --------------------------------------------------------------- handlers

/** A client for a daemon that is guaranteed to be answering. */
async function getClient() {
  const { runtime } = await ensureDaemon();
  return new DxClient(runtime);
}

/** sha256 of a file on disk, read as a stream: a 4 GB artefact must not be buffered. */
export async function sha256File(file) {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

/** `GET /api/tasks/:id/location`: the authoritative on-disk path. */
async function locationOf(client, id) {
  const res = await client.call("GET", "/api/tasks/" + encodeURIComponent(id) + "/location");
  return res.status === 200 ? res.payload : null;
}

/**
 * Attach the on-disk facts an agent needs but the task view does not carry.
 *
 * Only on a terminal state: while a transfer is running the path may still be
 * renamed under the overwrite policy, so reporting it early would be a guess.
 */
async function decorateTerminal(client, view) {
  const out = { ...view };
  const location = await locationOf(client, view.id).catch(() => null);
  if (location) {
    out.path = location.path;
    out.exists = location.exists;
  }
  if (location && location.path && location.exists) {
    try { out.sha256 = await sha256File(location.path); }
    catch (err) { out.sha256Error = err.message; }
  }
  return out;
}

/** GET one task, mapping a 404 to a code the agent can branch on. */
async function fetchTask(client, id) {
  const res = await client.call("GET", "/api/tasks/" + encodeURIComponent(id));
  if (res.status === 404) throw new DxError("no such task: " + id, { code: "ENOTASK", status: 404 });
  if (res.status !== 200 || !res.payload || !res.payload.task) {
    throw new DxError("the daemon answered HTTP " + res.status + " for task " + id, {
      code: "daemon_error",
      status: res.status,
    });
  }
  return res.payload.task;
}

/**
 * Poll one task until it reaches a terminal state or the wait expires.
 *
 * The interval starts at 250 ms and grows by half each round, capped at 2 s:
 * a fast local transfer is not delayed by a long first tick, and a long one
 * does not hammer the daemon.
 */
async function waitForTask(client, id, waitMs) {
  const started = Date.now();
  let delay = 250;
  for (;;) {
    const view = await fetchTask(client, id);
    if (TERMINAL.has(view.status)) return view;
    const elapsed = Date.now() - started;
    const remaining = waitMs - elapsed;
    if (remaining <= 0) return view;
    await sleep(Math.min(delay, remaining));
    delay = Math.min(2000, Math.round(delay * 1.5));
  }
}

/** The shape returned when a wait expired before the transfer finished. */
function runningPayload(view) {
  return {
    taskId: view.id,
    // "running" is what the protocol documents for "not finished, ask again".
    // taskStatus carries the daemon's exact word, which may be "queued".
    status: "running",
    taskStatus: view.status,
    percent: view.percent,
    downloadedBytes: view.downloadedBytes,
    totalBytes: view.totalBytes,
    speed: view.speed,
    filename: view.filename,
  };
}

async function toolDownload(args) {
  const url = assertDownloadUrl(args.url);
  const waitMs = clampWait(args.waitMs);

  const body = { url };
  if (args.dir !== undefined) body.dir = assertAbsoluteDir(args.dir);
  if (args.filename !== undefined) body.filename = assertBareFilename(args.filename);
  if (args.headers !== undefined) body.headers = args.headers;
  if (args.referer !== undefined) body.referer = String(args.referer);
  if (args.cookies !== undefined) body.cookies = String(args.cookies);
  if (args.queueId !== undefined) body.queueId = String(args.queueId);
  if (args.connections !== undefined) body.connections = Math.max(1, Math.min(32, Math.round(Number(args.connections) || 1)));
  if (args.speedLimit !== undefined) body.speedLimit = Math.max(0, Math.round(Number(args.speedLimit) || 0));

  const client = await getClient();

  // Size guard. The daemon starts downloading the moment a task is created, so
  // this has to happen before the POST, which means a probe. A probe that fails
  // is not fatal: origins that refuse HEAD usually still serve GET.
  if (args.allowLarge !== true) {
    let probed = null;
    try {
      probed = await client.call("POST", "/api/probe", { url, headers: body.headers });
    } catch (err) {
      // A redirect is the one failure not to shrug off: it means whatever is
      // listening on the daemon port is not the daemon, and the next request
      // would hand it the token again. Everything else (origin unreachable,
      // HEAD refused) is non-fatal and the download is still attempted.
      if (err instanceof DxError && err.code === "redirect_refused") throw err;
      probed = null;
    }
    const total = Number(probed && probed.payload && probed.payload.totalBytes);
    if (Number.isFinite(total) && total > LARGE_FILE_BYTES) {
      throw new DxError(
        "refusing a " + total + "-byte file (limit " + LARGE_FILE_BYTES + "); pass allowLarge=true to override",
        { code: "ETOOLARGE" },
      );
    }
  }

  const created = await client.call("POST", "/api/tasks", body);
  if (created.status !== 201 || !created.payload || !created.payload.task) {
    const message = (created.payload && created.payload.error) || "the daemon refused the task (HTTP " + created.status + ")";
    throw new DxError(message, { code: "ECREATE", status: created.status });
  }

  let view = created.payload.task;
  if (waitMs > 0) view = await waitForTask(client, view.id, waitMs);

  if (!TERMINAL.has(view.status)) return { payload: runningPayload(view), isError: false };

  const full = await decorateTerminal(client, view);
  return {
    payload: { taskId: view.id, ...full },
    isError: view.status === "error",
  };
}

async function toolList(args) {
  const client = await getClient();
  const query = new URLSearchParams();
  if (args.status !== undefined) query.set("status", String(args.status));
  if (args.limit !== undefined) query.set("limit", String(Math.max(1, Math.round(Number(args.limit) || 1))));
  const suffix = query.toString() ? "?" + query.toString() : "";
  const res = await client.call("GET", "/api/tasks" + suffix);
  if (res.status !== 200) {
    throw new DxError("the daemon answered HTTP " + res.status, { code: "daemon_error", status: res.status });
  }
  const tasks = Array.isArray(res.payload && res.payload.tasks) ? res.payload.tasks : [];
  return { payload: { tasks, count: tasks.length }, isError: false };
}

async function toolStatus(args) {
  const id = String(args.taskId ?? "").trim();
  if (!id) throw new DxError("taskId is required", { code: "EINVAL" });
  const waitMs = clampWait(args.waitMs);

  const client = await getClient();
  const view = waitMs > 0 ? await waitForTask(client, id, waitMs) : await fetchTask(client, id);

  if (!TERMINAL.has(view.status)) return { payload: runningPayload(view), isError: false };

  const full = await decorateTerminal(client, view);
  return { payload: { taskId: view.id, ...full }, isError: view.status === "error" };
}

async function toolControl(args) {
  const id = String(args.taskId ?? "").trim();
  const action = String(args.action ?? "").trim();
  if (!id) throw new DxError("taskId is required", { code: "EINVAL" });
  if (!["pause", "resume", "retry", "cancel"].includes(action)) {
    throw new DxError("action must be one of pause, resume, retry, cancel", { code: "EINVAL" });
  }

  const client = await getClient();
  const res = await client.call("POST", "/api/tasks/" + encodeURIComponent(id) + "/" + action);
  if (res.status === 404) throw new DxError("no such task: " + id, { code: "ENOTASK", status: 404 });
  if (res.status >= 400) {
    const message = (res.payload && res.payload.error) || "the daemon refused " + action + " (HTTP " + res.status + ")";
    throw new DxError(message, { code: "ECONTROL", status: res.status });
  }

  const payload = { taskId: id, action };
  const task = res.payload && res.payload.task;
  if (task) {
    payload.status = task.status;
    payload.task = task;
  } else {
    // cancel answers { ok, cancelled } because there is no task left to report.
    payload.status = "cancelled";
    payload.result = res.payload;
  }
  return { payload, isError: false };
}

async function toolProbe(args) {
  const url = assertDownloadUrl(args.url);
  const client = await getClient();
  const res = await client.call("POST", "/api/probe", { url, headers: args.headers });
  if (res.status !== 200) {
    throw new DxError("probe failed (HTTP " + res.status + ")", { code: "daemon_error", status: res.status });
  }
  return { payload: res.payload, isError: Boolean(res.payload && res.payload.error) };
}

async function toolStreamInspect(args) {
  const url = assertDownloadUrl(args.url);
  const client = await getClient();
  const res = await client.call("POST", "/api/inspect-stream", { url, headers: args.headers });
  if (res.status !== 200) {
    throw new DxError("stream inspection failed (HTTP " + res.status + ")", { code: "daemon_error", status: res.status });
  }
  return { payload: res.payload, isError: Boolean(res.payload && res.payload.error) };
}

const HANDLERS = {
  downloadx_download: toolDownload,
  downloadx_list: toolList,
  downloadx_status: toolStatus,
  downloadx_control: toolControl,
  downloadx_probe: toolProbe,
  downloadx_stream_inspect: toolStreamInspect,
};

// ------------------------------------------------------------- JSON-RPC

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Remove anything that looks like a credential from an outgoing message.
 *
 * The token is never put into a message on purpose; this is the belt to that
 * braces, so a future error path that embeds a URL or a header cannot leak it.
 */
export function sanitize(text) {
  return String(text)
    .replace(/(x-downloadx-token["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1[redacted]")
    .replace(/([?&]token=)[^&\s"']+/gi, "$1[redacted]");
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message: sanitize(message) } };
}

function negotiateVersion(requested) {
  if (typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested)) return requested;
  return PROTOCOL_VERSIONS[0];
}

/**
 * Check arguments against the tool's own schema.
 *
 * Only the constraints an agent gets wrong in practice are enforced: required
 * keys, primitive types, and enums. Anything deeper belongs in the handler,
 * where the error message can explain the actual value.
 *
 * @returns {string|null} a message, or null when the arguments are usable
 */
function validateArgs(tool, args) {
  const schema = tool.inputSchema;
  for (const key of schema.required || []) {
    if (!(key in args) || args[key] === undefined || args[key] === null) {
      return "missing required argument: " + key;
    }
  }
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    if (!(key in args) || args[key] === undefined) continue;
    const value = args[key];
    if (spec.type === "string" && typeof value !== "string") return key + " must be a string";
    if (spec.type === "boolean" && typeof value !== "boolean") return key + " must be a boolean";
    if (spec.type === "integer" && !Number.isInteger(value)) return key + " must be an integer";
    if (spec.type === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) {
      return key + " must be an object";
    }
    if (spec.enum && !spec.enum.includes(value)) return key + " must be one of " + spec.enum.join(", ");
    if (spec.type === "integer" && typeof spec.minimum === "number" && value < spec.minimum) {
      return key + " must be >= " + spec.minimum;
    }
  }
  return null;
}

async function callTool(params) {
  const name = params.name;
  if (typeof name !== "string" || !name) throw new RpcError(-32602, "tools/call needs a tool name");
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new RpcError(-32602, "unknown tool: " + name);

  const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
  if (typeof args !== "object" || Array.isArray(args)) throw new RpcError(-32602, "arguments must be an object");

  const problem = validateArgs(tool, args);
  if (problem) throw new RpcError(-32602, problem);

  try {
    const { payload, isError } = await HANDLERS[name](args);
    const result = { content: [{ type: "text", text: JSON.stringify(payload) }] };
    if (isError) result.isError = true;
    return result;
  } catch (err) {
    // A tool-level failure is reported inside the result, not as a protocol
    // error: the call was well formed, the download was not.
    if (err instanceof DxError) {
      const result = { content: [{ type: "text", text: JSON.stringify(err.toJSON()) }], isError: true };
      return result;
    }
    throw err;
  }
}

/**
 * Handle one decoded JSON-RPC message.
 *
 * Returns the response to send, or null when the message must not be answered
 * (a notification). Keeping this pure is what makes tools/list and tools/call
 * testable without a pipe.
 *
 * @param {any} msg
 * @returns {Promise<object|null>}
 */
export async function handleMessage(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return rpcError(null, -32600, "invalid request");

  const rawId = Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : undefined;
  const isNotification = rawId === undefined;
  const method = msg.method;

  if (typeof method !== "string" || !method) {
    return isNotification ? null : rpcError(rawId, -32600, "invalid request: method must be a string");
  }

  // Notifications are never answered, including the ones we do not implement.
  if (isNotification || method.startsWith("notifications/")) {
    return null;
  }

  try {
    switch (method) {
      case "initialize": {
        const requested = msg.params && msg.params.protocolVersion;
        return rpcResult(rawId, {
          protocolVersion: negotiateVersion(requested),
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: VERSION },
          instructions:
            "DownloadX downloads files on this machine through a local daemon. Call downloadx_download to " +
            "start a transfer, then downloadx_status (or waitMs) to follow it. Paths and sha256 are only " +
            "reported once a task reaches a terminal state.",
        });
      }
      case "ping":
        return rpcResult(rawId, {});
      case "tools/list":
        return rpcResult(rawId, { tools: TOOL_DEFINITIONS });
      case "tools/call": {
        if (!msg.params || typeof msg.params !== "object") throw new RpcError(-32602, "tools/call needs params");
        return rpcResult(rawId, await callTool(msg.params));
      }
      default:
        return rpcError(rawId, -32601, "method not found: " + method);
    }
  } catch (err) {
    if (err instanceof RpcError) return rpcError(rawId, err.code, err.message);
    const message = (err && err.message) || String(err);
    process.stderr.write("[downloadx-mcp] internal error: " + sanitize((err && err.stack) || message) + "\n");
    return rpcError(rawId, -32603, message);
  }
}

// -------------------------------------------------------------- stdio loop

/** Answer one raw line from stdin. Malformed JSON is a protocol-level error. */
async function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); }
  catch {
    writeMessage(rpcError(null, -32700, "parse error"));
    return;
  }

  const response = Array.isArray(msg)
    ? rpcError(null, -32600, "batched requests are not supported")
    : await handleMessage(msg);
  if (response) writeMessage(response);
}

function writeMessage(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

export function startStdio(input = process.stdin) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  // Calls are answered in order. JSON-RPC allows out-of-order responses, but a
  // single chain is easier to reason about and costs nothing at agent volumes.
  let chain = Promise.resolve();

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    chain = chain.then(() => handleLine(text)).catch((err) => {
      process.stderr.write("[downloadx-mcp] line failed: " + sanitize((err && err.stack) || err) + "\n");
    });
  });

  rl.on("close", () => {
    // The client closed the pipe: finish what is queued, then exit.
    chain.then(() => { process.exitCode = 0; });
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => { process.exitCode = 0; process.exit(); });
  }
  return rl;
}

// ---------------------------------------------------------------- selftest

/**
 * End-to-end check that needs nothing but this machine.
 *
 * A child of this same file is started with an isolated DOWNLOADX_HOME, which
 * forces the daemon auto-start path. The parent feeds it real protocol lines
 * and verifies the file it produced against the fixture bytes. No public
 * network access, no writes outside a scratch directory.
 */
async function runSelftest() {
  const { startOrigin, payloadFor } = await import("../test/origin.mjs");

  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok });
    process.stdout.write((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "\n          " + detail : "") + "\n");
  };

  const root = await fsp.mkdtemp(path.join(path.resolve(process.env.TEMP || process.env.TMP || "/tmp"), "dx-mcp-selftest-"));
  const home = path.join(root, "home");
  const out = path.join(root, "out");
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(out, { recursive: true });

  const origin = await startOrigin();
  const size = 512 * 1024;
  const expectedSha = createHash("sha256").update(payloadFor(size)).digest("hex");

  let child = null;
  const stderrChunks = [];
  const badLines = [];
  /** Set once the child exists; the selftest sends lines through it. */
  let send = async () => { throw new Error("the MCP child was never started"); };

  try {
    child = spawn(process.execPath, [SELF], {
      env: { ...process.env, DOWNLOADX_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));

    let seq = 0;
    const pending = new Map();
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); }
      catch { badLines.push(line); return; }
      if (!msg || msg.jsonrpc !== "2.0") { badLines.push(line); return; }
      const waiter = pending.get(msg.id);
      if (waiter) { pending.delete(msg.id); waiter(msg); }
    });

    send = (method, params) => {
      const id = ++seq;
      const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      child.stdin.write(line + "\n");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("timeout waiting for " + method)); }, 60000);
        pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      });
    };

    // 1. initialize
    const init = await send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "downloadx-selftest", version: VERSION },
    });
    const initOk = Boolean(init.result && init.result.serverInfo && init.result.serverInfo.name === SERVER_NAME &&
      init.result.protocolVersion === "2025-06-18" && init.result.capabilities && init.result.capabilities.tools);
    record("initialize negotiates the protocol version", initOk, initOk ? "" : JSON.stringify(init));

    // 2. tools/list
    const list = await send("tools/list", {});
    const tools = (list.result && list.result.tools) || [];
    const names = tools.map((t) => t.name);
    const required = ["downloadx_download", "downloadx_list", "downloadx_status", "downloadx_control", "downloadx_probe"];
    const missing = required.filter((n) => !names.includes(n));
    record("tools/list exposes the 6 required tools", missing.length === 0,
      missing.length ? "missing: " + missing.join(", ") : names.join(", "));

    // 3. download with a real wait
    const url = origin.origin + "/range/" + size;
    const call = await send("tools/call", {
      name: "downloadx_download",
      arguments: { url, dir: out, filename: "mcp-selftest.bin", waitMs: 5000 },
    });
    const downloadResult = parseToolResult(call);
    record("downloadx_download returns a terminal task", Boolean(downloadResult && downloadResult.status === "complete"),
      JSON.stringify(downloadResult));

    // 4. the file on disk is the fixture's bytes
    const target = downloadResult && downloadResult.path;
    const present = Boolean(target && fs.existsSync(target));
    const actualSha = present ? await sha256File(target) : "";
    record("the downloaded file exists and matches the fixture sha256",
      present && actualSha === expectedSha,
      present ? "path=" + target + " sha256=" + actualSha : "no file at " + String(target));

    // 5. downloadx_status agrees
    const statusCall = await send("tools/call", {
      name: "downloadx_status",
      arguments: { taskId: downloadResult && downloadResult.taskId, waitMs: 0 },
    });
    const statusResult = parseToolResult(statusCall);
    record("downloadx_status reports the same terminal state and path",
      Boolean(statusResult && statusResult.status === "complete" && statusResult.path === target),
      JSON.stringify(statusResult));

    // 6. stdout stayed a pure protocol channel
    record("every stdout line was a valid JSON-RPC message", badLines.length === 0,
      badLines.length ? "offending lines: " + badLines.slice(0, 3).join(" | ") : "");

    // 7. an unknown method is refused with -32601
    const bogus = await send("resources/list", {});
    record("an unknown method is refused with -32601", Boolean(bogus.error && bogus.error.code === -32601),
      JSON.stringify(bogus.error || null));
  } catch (err) {
    record("selftest ran to completion", false, (err && err.message) || String(err));
  } finally {
    // Stop the daemon this run started, by asking it: killing the child would
    // leave the detached daemon running against a deleted scratch directory.
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(home, "runtime.json"), "utf8"));
      if (raw && raw.port && raw.token) {
        await fetch("http://" + (raw.host || "127.0.0.1") + ":" + raw.port + "/api/shutdown", {
          method: "POST",
          headers: { "x-downloadx-token": raw.token },
          redirect: "manual",
        }).catch(() => null);
        await sleep(300);
      }
    } catch { /* no daemon was started */ }

    if (child) { try { child.kill(); } catch { /* already gone */ } }
    try { origin.server.closeAllConnections?.(); } catch { /* older runtime */ }
    await new Promise((resolve) => { origin.close(() => resolve(undefined)); setTimeout(resolve, 1000); });
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});

    const stderrText = stderrChunks.join("");
    if (stderrText.trim()) process.stdout.write("\n  server stderr:\n    " + stderrText.trim().split(/\r?\n/).join("\n    ") + "\n");
  }

  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write("\n  " + (results.length - failed) + " passed, " + failed + " failed\n\n");
  return failed === 0 ? 0 : 1;

  /** The result payload of a tools/call response, or null. */
  function parseToolResult(response) {
    if (!response || !response.result || !Array.isArray(response.result.content)) return null;
    const text = response.result.content[0] && response.result.content[0].text;
    try { return JSON.parse(text); } catch { return null; }
  }
}

// ------------------------------------------------------------------- main

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SELF);

if (isEntryPoint) {
  if (process.argv.includes("--selftest")) {
    runSelftest()
      .then((code) => { process.exitCode = code; })
      .catch((err) => {
        process.stderr.write("[downloadx-mcp] selftest crashed: " + ((err && err.stack) || err) + "\n");
        process.exitCode = 1;
      });
  } else {
    startStdio();
  }
}
