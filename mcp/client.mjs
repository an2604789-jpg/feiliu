// Thin HTTP client for the DownloadX daemon, used by the MCP server.
//
// Scope: read the runtime file, talk to one loopback host, send the token in a
// header. Nothing here imports the CLI or the download engine: an MCP server
// must not drag a whole download implementation into its own process.
//
// Two safety rules are enforced here rather than at the call sites, because
// every request must obey them:
//   * the base URL is always http://<loopback>:<port>; a runtime file that
//     points anywhere else is treated as unusable;
//   * redirects are never followed. The daemon has no reason to redirect, and
//     a 3xx is the classic way to walk a bearer token off the machine.

import fsp from "node:fs/promises";

import { paths } from "../src/paths.mjs";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** An error with a machine-readable code, safe to serialise to an agent. */
export class DxError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, status?: number, hint?: string, logTail?: string}} [opts]
   */
  constructor(message, { code = "dx_error", status = 0, hint = null, logTail = null } = {}) {
    super(message);
    this.name = "DxError";
    this.code = code;
    this.status = status;
    this.hint = hint;
    this.logTail = logTail;
  }

  /** The payload an agent sees. Never carries the token or a request header. */
  toJSON() {
    const out = { error: this.message, code: this.code };
    if (this.status) out.status = this.status;
    if (this.hint) out.hint = this.hint;
    if (this.logTail) out.logTail = this.logTail;
    return out;
  }
}

/**
 * Read and validate runtime.json.
 *
 * Returns null when the file is missing, unparsable, or describes an endpoint
 * this process must not talk to. The token is part of the result because the
 * caller has to authenticate, but it is never logged or echoed.
 *
 * @returns {Promise<{pid:number|null, host:string, port:number, token:string, url:string}|null>}
 */
export async function readRuntime() {
  let text;
  try { text = await fsp.readFile(paths.runtime, "utf8"); }
  catch { return null; }

  let raw;
  try { raw = JSON.parse(text); }
  catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const port = Number(raw.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  const host = String(raw.host || "127.0.0.1").trim();
  if (!LOOPBACK.has(host)) return null;

  if (typeof raw.token !== "string" || raw.token.length === 0) return null;

  const pid = Number(raw.pid);
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    host,
    port,
    token: raw.token,
    url: typeof raw.url === "string" && raw.url ? raw.url : "http://" + host + ":" + port,
  };
}

/**
 * Is this pid a live process?
 *
 * signal 0 performs the permission and existence checks without delivering
 * anything. EPERM means the process exists but belongs to somebody else, which
 * still counts as alive.
 *
 * @param {number|null} pid
 */
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err && err.code === "EPERM"; }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export { sleep };

/**
 * A client bound to one daemon instance.
 *
 * Construct with a runtime object (as returned by readRuntime) so tests can
 * point it at a server they started themselves.
 */
export class DxClient {
  /** @param {{host:string, port:number, token:string}} runtime */
  constructor(runtime) {
    this.runtime = runtime;
    this.base = "http://" + runtime.host + ":" + runtime.port;
  }

  /**
   * One request, no retries, no redirects.
   *
   * @param {"GET"|"POST"|"PATCH"|"DELETE"} method
   * @param {string} route path beginning with a slash
   * @param {object} [body] JSON body; omitted entirely when undefined
   * @returns {Promise<{status:number, payload:any}>}
   */
  async call(method, route, body) {
    const headers = { "x-downloadx-token": this.runtime.token };
    if (body !== undefined) headers["content-type"] = "application/json";

    let res;
    try {
      res = await fetch(this.base + route, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // A 3xx must be reported, not followed: following one could deliver the
        // token to whatever host the Location header names.
        redirect: "manual",
      });
    } catch (err) {
      const cause = (err && err.cause && (err.cause.code || err.cause.message)) || (err && err.message) || "unknown error";
      throw new DxError("the DownloadX daemon is not reachable at " + this.base + " (" + cause + ")", {
        code: "daemon_unreachable",
      });
    }

    if (REDIRECT_STATUS.has(res.status)) {
      let host = "";
      try { host = new URL(res.headers.get("location") || "", this.base).host; } catch { /* unusable Location */ }
      try { await res.body?.cancel?.(); } catch { /* already closed */ }
      throw new DxError(
        "refusing to follow a redirect from the daemon (HTTP " + res.status + (host ? " to " + host : "") + ")",
        { code: "redirect_refused", status: res.status },
      );
    }

    const text = await res.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; }
    catch { payload = { raw: text }; }
    return { status: res.status, payload };
  }
}

/**
 * Is the daemon behind this runtime object answering?
 *
 * Deliberately tolerant: any network error, timeout or non-200 means "no".
 *
 * @param {{host:string, port:number, token:string}} runtime
 * @param {number} [timeoutMs]
 */
export async function statusOk(runtime, timeoutMs = 1500) {
  try {
    const res = await fetch("http://" + runtime.host + ":" + runtime.port + "/api/status", {
      headers: { "x-downloadx-token": runtime.token },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain the body so the socket can be reused instead of lingering.
    try { await res.text(); } catch { /* ignore */ }
    return res.status === 200;
  } catch {
    return false;
  }
}
