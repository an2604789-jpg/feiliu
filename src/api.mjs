// HTTP API + static GUI host, plus the JSON-RPC-ish surface the browser
// extension and CLI both use.

import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";

import { paths } from "./paths.mjs";
import { taskView, STATUS } from "./task.mjs";
import { isExcepted } from "./rules.mjs";
import { TransferStore, STAGING_SUFFIX } from "./store.mjs";
import { VERSION } from "./version.mjs";
// The MCP tool layer is pure (handleMessage owns no state and starts no stdio
// loop on import), so the daemon can serve the same tool surface over HTTP
// for agents that reach this machine over the network.
import { handleMessage as mcpHandleMessage, MCP_PROTOCOL_VERSIONS } from "../mcp/server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUI_DIR = path.join(__dirname, "..", "gui");

/** Constant-time token check; a missing token never authorises. */
function tokenOk(expected, got) {
  if (!expected || !got) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(got));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Statuses that make a URL "already in progress" for duplicate detection.
 * Mirrors LIVE_TASK_STATUSES in extension/host.mjs: "error" and "complete"
 * are deliberately absent — a failed or finished download is a legitimate
 * reason to add the same URL again.
 */
const LIVE_TASK_STATUSES = new Set(["queued", "connecting", "downloading", "paused"]);

/** The live task for this URL, or null. */
function liveTaskFor(queue, url) {
  for (const t of queue.tasks.values()) {
    if (t.url === url && LIVE_TASK_STATUSES.has(t.status)) return t;
  }
  return null;
}

/**
 * queueId that marks an add as coming from the browser extension, the way
 * "clipboard" marks the clipboard watcher and "captured" the capture proxy.
 * While askBeforeAdd is on, these adds wait in the pending list instead of
 * entering the queue (daemon.mjs PendingManager).
 */
const EXTENSION_QUEUE_ID = "extension";

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/** Non-internal IPv4 addresses, for the Agent page's LAN reachability hints. */
function lanIPv4Addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > limit) throw new Error("request body too large");
    chunks.push(c);
  }
  if (!total) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Is this path there right now? @returns {Promise<boolean>} */
async function pathExists(target) {
  try { await fsp.lstat(target); return true; } catch { return false; }
}

/**
 * Remove one scratch path that a transfer of this kind owns.
 *
 * Only paths derived from the task's own target are ever passed in (journal,
 * staging file, .partial, media part/track directories), never anything from a
 * request. A symlink or a special file is left alone rather than followed.
 *
 * @returns {Promise<boolean>} whether something was removed
 */
async function removeScratch(target) {
  let st;
  try { st = await fsp.lstat(target); } catch { return false; }
  if (st.isDirectory()) { await fsp.rm(target, { recursive: true, force: true }); return true; }
  if (st.isFile()) { await fsp.rm(target, { force: true }); return true; }
  return false;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export class ApiServer {
  /** What the downloader resolved for a task: its target path and real kind. */
  #targets = new Map();
  /** taskId -> resolver that fires once that task's runner has stopped. */
  #settleWaiters = new Map();

  /**
   * @param {{ queue:any, config:any, downloader:any, scheduler?:any, log?:any }} deps
   */
  constructor(deps) {
    this.queue = deps.queue;
    this.config = deps.config;
    this.downloader = deps.downloader;
    this.scheduler = deps.scheduler ?? null;
    this.proxy = deps.proxy ?? null;
    this.ca = deps.ca ?? null;
    this.log = deps.log ?? null;
    this.history = deps.history ?? null;
    /** Pending approvals (askBeforeAdd); null when the host built no gate. */
    this.pending = deps.pending ?? null;
    this.token = randomBytes(24).toString("hex");
    this.server = null;
    this.events = new Set();
    this.startedAt = Date.now();
    this.#wireQueue();
  }

  /**
   * Publish one frame on the SSE stream. Queue/downloader events go through
   * here (via #wireQueue) and so do pending-approval events, so every
   * subscriber sees one uniform frame shape.
   */
  pushEvent(type, payload) {
    const frame = `data: ${JSON.stringify({ type, payload, at: Date.now() })}\n\n`;
    for (const res of this.events) {
      try { res.write(frame); } catch { this.events.delete(res); }
    }
  }

  #wireQueue() {
    const push = (type, payload) => this.pushEvent(type, payload);
    this.queue.on("added", (t) => push("added", t));
    this.queue.on("updated", (t) => push("updated", t));
    this.queue.on("removed", (p) => {
      // A removed task must not leave its resolved path behind in the map.
      this.#targets.delete(p.id);
      push("removed", p);
    });
    this.queue.on("reordered", (o) => push("reordered", { order: o }));
    this.downloader.on("progress", (p) => push("progress", p));
    this.downloader.on("resolved", (p) => {
      // Where this task's bytes are going. Cancel reads it to find the
      // journal, the staging file and the scratch directories the transfer owns.
      // Both halves matter: the resolved path (a rename changes it) and the
      // protocol actually used (an HLS task may have been added as "http").
      if (p && p.taskId && p.target) this.#targets.set(p.taskId, { target: p.target, kind: p.kind ?? null });
      push("resolved", p);
    });
    this.downloader.on("retry", (p) => push("retry", p));
    this.downloader.on("downgrade", (p) => push("downgrade", p));
    this.downloader.on("log", (p) => push("log", p));
  }

  /** Start the runner loop: turns queued tasks into actual transfers. */
  startRunner() {
    const runNext = async (taskId) => {
      const task = this.queue.get(taskId);
      if (!task) return;
      // Fires when this runner has stopped for good. Cancel waits on it: it
      // removes the files the transfer created, and that must not race a write.
      let settle;
      const settled = new Promise((resolve) => { settle = resolve; });
      this.#settleWaiters.set(taskId, settle);
      try {
        this.queue.setStatus(taskId, "downloading", { startedAt: Date.now(), error: null });
        this.queue.registerRunner(taskId, { controller: { abort: () => this.downloader.cancel(taskId) } });

        let lastEmit = 0;
        const onProgress = (p) => {
          const now = Date.now();
          if (now - lastEmit < 300) return;
          lastEmit = now;
          // queue.apply() schedules a debounced save, which is what makes the
          // reported byte count survive a restart. Without it the API answered
          // "0 bytes" for a transfer that was nearly finished when the process
          // died. The debounce (400 ms) still absorbs a fast local transfer.
          // A streamed response may not declare a length. Keep totalBytes null
          // and say the length is unknown, so the UI shows received bytes
          // instead of a percentage computed against a denominator we do not
          // have. A known total arriving later is still recorded.
          const known = p.lengthKnown === false ? null : (p.totalBytes ?? null);
          // apply(), not update(): progress carries runtime fields the PATCH
          // whitelist must not admit from clients.
          this.queue.apply(taskId, {
            downloadedBytes: Math.round(p.bytesWritten ?? 0),
            totalBytes: known,
            lengthKnown: p.lengthKnown === false ? false : true,
            speed: p.speed ?? 0,
          });
        };
        this.downloader.on("progress", onProgress);

        try {
          const result = await this.downloader.run(task);
          // A streamed transfer has no declared total, so the completed length
          // is what we actually received; the flag keeps the UI honest about
          // that. For everything else the total is the verified size.
          const streamed = result.lengthKnown === false;
          this.queue.apply(taskId, {
            status: "complete",
            downloadedBytes: result.bytes,
            totalBytes: streamed ? null : result.bytes,
            lengthKnown: !streamed,
            sha256: result.sha256 ?? null,
            filename: result.filename ?? task.filename,
            dir: result.dir ?? task.dir,
            category: result.category ?? task.category,
            speed: 0,
            finishedAt: Date.now(),
            error: null,
            meta: { ...(task.meta ?? {}), ...(result.meta ?? {}) },
          });
          this.log?.info(`completed ${result.filename} (${result.bytes} bytes)`);
        } finally {
          this.downloader.off?.("progress", onProgress);
          // Downloader is an EventEmitter subclass, so removal works.
          this.downloader.removeListener?.("progress", onProgress);
          this.queue.notifySettled(taskId);
        }
      } catch (err) {
        const aborted = /abort/i.test(err?.message ?? "");
        this.queue.apply(taskId, {
          status: aborted ? "paused" : "error",
          error: aborted ? null : (err?.message ?? String(err)),
          speed: 0,
          attempts: (task.attempts ?? 0) + 1,
        });
        if (!aborted) this.log?.error(`task failed: ${task.url}: ${err?.message}`);
        this.queue.notifySettled(taskId);
      } finally {
        // Only now is the transfer really over: the downloader has released
        // its sockets and its file handles, so a cancel's cleanup cannot race it.
        this.#settleWaiters.delete(taskId);
        settle();
      }
    };

    this.queue.on("run", (taskId) => { runNext(taskId).catch(() => {}); });
    return this;
  }

  /**
   * Cancel a task: stop the transfer and throw away what it had written.
   *
   * This is deliberately not pause. Pause aborts the runner and keeps the
   * segment journal and the .downloadx-part staging file so that `resume`
   * continues where it stopped; that path is untouched by this method. Cancel
   * is the user saying the download is not wanted at all, so the journal and
   * the staging file are removed with the same TransferStore.discard() the
   * engine itself uses for an abandoned attempt, the scratch paths a transfer
   * of this kind owns (Downloader.outputPathSet) go with them, and the task
   * leaves the queue.
   *
   * A finished download is never cancelled: the file is the user's, so the
   * answer is 409 and nothing is deleted. Cancelling an id that is already
   * gone answers 404 "no such task", exactly like every other task route.
   *
   * @param {string} id
   * @returns {Promise<{ status:number, body:object }>}
   */
  async #cancelTask(id) {
    const task = this.queue.get(id);
    if (!task) return { status: 404, body: { error: "no such task" } };
    const alreadyDone = {
      status: 409,
      body: {
        ok: false, cancelled: false, removed: false, id, status: task.status,
        error: "task is already complete; cancel does not delete a finished file",
      },
    };
    if (task.status === STATUS.COMPLETE) return alreadyDone;

    const resolved = this.#targets.get(id) ?? null;
    const target = resolved?.target
      ?? (task.dir && task.filename ? path.join(task.dir, task.filename) : null);
    // The kind the transfer really ran as, not the "http" a task carries until
    // a transfer proves otherwise: an HLS task added without an explicit kind
    // stayed "http", so cleanup picked the plain-transfer paths and left
    // <target>.parts/ behind.
    const kind = resolved?.kind ?? task.kind ?? "http";

    // 1. Stop it exactly the way pause does, so the abort path the engine and
    //    the downloader already implement is the one exercised here.
    const settled = this.#settleWaiters.get(id);
    this.queue.stop(id);
    if (settled) {
      // Bounded: a runner that refuses to stop must not hang the request.
      await Promise.race([settled, new Promise((r) => setTimeout(r, 10_000))]);
    }

    // The transfer can finish in the window between the status check above and
    // the abort landing. A published file is real, and not ours to delete.
    const after = this.queue.get(id);
    if (after && after.status === STATUS.COMPLETE) {
      return { ...alreadyDone, body: { ...alreadyDone.body, status: after.status } };
    }

    // 2. Discard the intermediate state. Every path below comes from code that
    //    already owns it: TransferStore for the segment journal and the staged
    //    assembly file, Downloader.outputPathSet for the scratch directories a
    //    transfer of this kind uses. The finished path is never removed.
    const discarded = [];
    if (target) {
      // The journal and the staged assembly file go through the engine's own
      // cleanup. Only what was actually there before is reported as discarded:
      // a path that never existed is not evidence of anything.
      const store = new TransferStore(target, { writePath: target + STAGING_SUFFIX });
      const present = [];
      for (const owned of [store.dir, target + STAGING_SUFFIX]) {
        if (await pathExists(owned)) present.push(owned);
      }
      await store.discard({ target: false });
      for (const owned of present) {
        if (!(await pathExists(owned))) discarded.push(owned);
      }
      // Scratch this kind of transfer owns, taken from the downloader's own
      // catalogue. The plain-transfer set is always included as well: a media
      // transfer still passes through .partial / .downloadx / .downloadx-part
      // on its way to the finished file, so both families are checked.
      const { Downloader } = await import("./downloader.mjs");
      for (const wanted of new Set([kind, "http"])) {
        for (const owned of Downloader.outputPathSet(target, wanted)) {
          if (path.resolve(owned) === path.resolve(target)) continue;
          if (await removeScratch(owned)) discarded.push(owned);
        }
      }
    }

    // 3. Out of the queue. The state machine has no "cancelled" state (and this
    //    fix does not invent one), so a cancelled task is simply gone rather
    //    than left behind as a paused entry the user has to clear by hand.
    const removed = this.queue.remove(id);
    this.#targets.delete(id);
    this.log?.info(`cancelled ${task.filename ?? id}`);
    return {
      status: 200,
      body: { ok: true, cancelled: true, removed, id, target, kind, discarded },
    };
  }

  // ------------------------------------------------------------------ routes

  async #handle(req, res, url) {
    const p = url.pathname;

    // Server-sent events carry no secrets; the token is still required so a
    // random local process cannot subscribe to the user's download activity.
    if (p === "/api/events") {
      if (!tokenOk(this.token, url.searchParams.get("token"))) return json(res, 401, { error: "bad token" });
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
      this.events.add(res);
      const keep = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closing */ } }, 20_000);
      req.on("close", () => { clearInterval(keep); this.events.delete(res); });
      return;
    }

    // MCP over HTTP: the same tool surface the stdio server exposes, served
    // statelessly for agents that reach this machine over the network (or do
    // not want to manage a child process). The token is mandatory on every
    // call; standard Bearer auth is accepted next to the daemon header so
    // remote MCP clients need nothing bespoke.
    if (p === "/mcp") {
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
      // Header-only on purpose: MCP clients can always set headers, and a
      // token in the query string tends to leak into intermediary logs.
      const provided = req.headers["x-downloadx-token"] || (bearer && bearer[1]);
      if (!tokenOk(this.token, provided)) return json(res, 401, { error: "bad token" });
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
        res.end(JSON.stringify({ error: "stateless MCP: POST one JSON-RPC message to /mcp" }));
        return;
      }
      let body;
      try { body = await readJsonBody(req, 1024 * 1024); }
      catch (err) { return json(res, 400, { error: err.message }); }
      const response = await mcpHandleMessage(body).catch((err) => ({
        jsonrpc: "2.0", id: null, error: { code: -32603, message: String((err && err.message) || err) },
      }));
      if (!response) { res.writeHead(202).end(); return; }
      return json(res, 200, response);
    }

    // Discovery descriptor for agents: how to reach and authenticate to the
    // MCP endpoint. Deliberately carries no secret — the token is issued by
    // the operator and still required on every call.
    if (p === "/.well-known/downloadx-mcp.json") {
      return json(res, 200, {
        server: "downloadx",
        version: VERSION,
        transport: "streamable-http (stateless)",
        endpoint: "/mcp",
        auth: { type: "bearer", acceptedHeaders: ["authorization", "x-downloadx-token"] },
        protocolVersions: MCP_PROTOCOL_VERSIONS,
        instructions: "POST JSON-RPC 2.0 messages (initialize, tools/list, tools/call) to the endpoint.",
      });
    }

    // Everything else under /api requires the token.
    if (p.startsWith("/api/")) {
      const provided = req.headers["x-downloadx-token"] || url.searchParams.get("token");
      if (!tokenOk(this.token, provided)) return json(res, 401, { error: "bad token" });

      const body = req.method === "POST" || req.method === "PATCH" ? await readJsonBody(req) : {};

      // ---- status
      if (p === "/api/status" && req.method === "GET") {
        const { findFfmpeg } = await import("./merge.mjs");
        return json(res, 200, {
          version: VERSION,
          uptimeMs: Date.now() - this.startedAt,
          queue: this.queue.stats,
          config: this.config.values,
          scheduler: this.scheduler?.view?.() ?? null,
          capabilities: {
            ffmpeg: await findFfmpeg(this.config.get("ffmpegPath") || undefined),
            clipboardWatch: this.config.get("monitorClipboard") !== false,
          },
          // Agent-integration surface: where the MCP entry points are and how
          // this daemon is bound, so the GUI's Agent page can render them.
          remoteAccess: this.config.get("remoteAccess") === true,
          boundHost: this.boundHost ?? "127.0.0.1",
          dataRoot: paths.root,
          mcpServerPath: path.join(__dirname, "..", "mcp", "server.mjs"),
          lanAddresses: lanIPv4Addresses(),
        });
      }

      // ---- tasks
      if (p === "/api/tasks" && req.method === "GET") {
        return json(res, 200, {
          tasks: this.queue.list({
            status: url.searchParams.get("status") ?? undefined,
            limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
          }),
        });
      }
      if (p === "/api/tasks" && req.method === "POST") {
        const url2 = String(body.url ?? "").trim();
        if (!url2) return json(res, 400, { error: "url is required" });
        // Same-URL in-flight guard: a URL that is already queued, connecting,
        // downloading or paused is refused with the existing task's id so the
        // client can point the user at it. Error and complete do not count —
        // re-adding a failed or finished URL is legitimate (and matches the
        // extension host's own dedup). This is a semantic change from the old
        // "always a second task" behaviour; see the API section in README.md.
        const live = liveTaskFor(this.queue, url2);
        if (live) {
          return json(res, 409, { error: "task already in queue", existingTaskId: live.id });
        }
        // askBeforeAdd: extension-sourced adds wait for an explicit approve
        // (with optional dir/filename/category overrides) instead of entering
        // the queue. Manual adds keep the old direct path.
        if (this.pending && this.pending.enabled && body.queueId === EXTENSION_QUEUE_ID) {
          const rec = this.pending.add({
            url: url2,
            filename: body.filename,
            dir: body.dir,
            category: body.category,
            kind: body.kind,
            headers: body.headers,
            referer: body.referer,
            cookies: body.cookies,
            queueId: body.queueId,
            meta: body.meta,
          });
          const view = this.pending.get(rec.id);
          return json(res, 202, { pending: this.pending.view(view), duplicate: rec.duplicate === true });
        }
        const task = this.queue.add({
          url: url2,
          filename: body.filename,
          dir: body.dir,
          category: body.category,
          kind: body.kind,
          connections: body.connections,
          headers: body.headers,
          referer: body.referer,
          cookies: body.cookies,
          username: body.username,
          password: body.password,
          speedLimit: body.speedLimit,
          priority: body.priority,
          queueId: body.queueId,
          meta: body.meta,
        });
        return json(res, 201, { task: taskView(task) });
      }

      const taskMatch = /^\/api\/tasks\/([^/]+)(?:\/(\w+))?$/.exec(p);
      if (taskMatch) {
        const id = decodeURIComponent(taskMatch[1]);
        const action = taskMatch[2];
        const task = this.queue.get(id);
        if (!task) return json(res, 404, { error: "no such task" });

        if (!action && req.method === "GET") return json(res, 200, { task: taskView(task) });
        if (!action && req.method === "PATCH") {
          return json(res, 200, { task: taskView(this.queue.update(id, body)) });
        }
        if (!action && req.method === "DELETE") {
          this.queue.remove(id, { deleteFile: url.searchParams.get("deleteFile") === "1" });
          return json(res, 200, { ok: true });
        }

        // ---- cancel: drop the in-flight transfer AND its intermediate state.
        // Kept out of the switch below on purpose: every other verb and action
        // must keep answering 405 "unsupported", not be swallowed by this branch.
        if (req.method === "POST" && action === "cancel") {
          const result = await this.#cancelTask(id);
          return json(res, result.status, result.body);
        }

        // ---- location: the resolved on-disk path of the task's file.
        // Read-only, used by the desktop shell to open the file or its folder.
        // The finished path is the authoritative one (it accounts for type
        // folders and "name (n).ext" renames); fall back to the live resolved
        // target for tasks still in progress. No credentials are returned.
        if (req.method === "GET" && action === "location") {
          const resolved = this.#targets.get(id) ?? null;
          const target = resolved?.target
            ?? (task.dir && task.filename ? path.join(task.dir, task.filename) : null);
          const exists = target ? await pathExists(target) : false;
          return json(res, 200, {
            path: target,
            dir: target ? path.dirname(target) : (task.dir || null),
            filename: target ? path.basename(target) : (task.filename || null),
            exists,
            status: task.status,
          });
        }

        switch (`${req.method} ${action}`) {
          case "POST start": this.queue.start(id); break;
          case "POST pause": this.queue.pause(id); break;
          case "POST resume": this.queue.start(id); break;
          case "POST retry":
            // apply(): retry bookkeeping resets runtime counters, which is not
            // a client PATCH and must bypass the update() whitelist.
            this.queue.apply(id, { attempts: 0, error: null });
            this.queue.start(id);
            break;
          case "POST move":
            if (typeof body.toIndex === "number") this.queue.reorder(id, body.toIndex);
            break;
          default: return json(res, 405, { error: `unsupported ${req.method} ${action ?? ""}` });
        }
        return json(res, 200, { task: taskView(this.queue.get(id)) });
      }

      // ---- bulk queue control
      if (p === "/api/queue" && req.method === "GET") return json(res, 200, this.queue.stats);
      if (p === "/api/queue/pause" && req.method === "POST") {
        this.queue.pauseAll();
        return json(res, 200, this.queue.stats);
      }
      if (p === "/api/queue/resume" && req.method === "POST") {
        this.queue.resumeAll();
        return json(res, 200, this.queue.stats);
      }
      if (p === "/api/queue/clear-completed" && req.method === "POST") {
        return json(res, 200, { removed: this.queue.clearCompleted() });
      }

      // ---- config
      if (p === "/api/config" && req.method === "GET") return json(res, 200, { config: this.config.values });
      if (p === "/api/config" && req.method === "PATCH") {
        const next = await this.config.set(body);
        return json(res, 200, { config: next });
      }
      if (p === "/api/config/reset" && req.method === "POST") {
        return json(res, 200, { config: await this.config.reset() });
      }

      // ---- browser-extension surface: probe a URL, then optionally add it
      if (p === "/api/probe" && req.method === "POST") {
        const target = String(body.url ?? "");
        if (!target) return json(res, 400, { error: "url is required" });
        if (isExcepted(target, body.rules ?? [], this.config.get("exceptions"))) {
          return json(res, 200, { excluded: true });
        }
        try {
          const { probe } = await import("./probe.mjs");
          const info = await probe(target, {
            headers: body.headers,
            proxy: this.config.get("proxy") || undefined,
            insecure: this.config.get("insecure"),
          });
          return json(res, 200, {
            excluded: false,
            ...info,
            category: (await import("./categories.mjs")).categorize(info.filename, this.config.get("categories")),
          });
        } catch (err) {
          return json(res, 200, { excluded: false, error: err.message });
        }
      }

      // ---- scheduler
      if (p === "/api/scheduler" && req.method === "GET") {
        return json(res, 200, { schedules: this.scheduler?.list?.() ?? [] });
      }
      if (p === "/api/scheduler" && req.method === "POST") {
        const created = this.scheduler?.add?.(body);
        return json(res, 201, { schedule: created });
      }
      const schedMatch = /^\/api\/scheduler\/([^/]+)$/.exec(p);
      if (schedMatch && req.method === "DELETE") {
        return json(res, 200, { ok: this.scheduler?.remove?.(decodeURIComponent(schedMatch[1])) ?? false });
      }

      // ---- site grabber: list or queue everything a page links to
      if (p === "/api/grab" && req.method === "POST") {
        const target = String(body.url ?? "");
        if (!target) return json(res, 400, { error: "url is required" });
        try {
          const { grabPage, grabAndQueue } = await import("./grabber.mjs");
          const opts = {
            headers: body.headers,
            proxy: this.config.get("proxy") || undefined,
            insecure: this.config.get("insecure"),
            mediaOnly: Boolean(body.mediaOnly),
            extensions: body.extensions,
            includeResources: body.includeResources,
          };
          if (body.queue === true) {
            const result = await grabAndQueue(target, this.queue, { ...opts, dir: body.dir });
            return json(res, 200, { queued: result.queued.length, page: result.page, items: result.queued.map((x) => ({ url: x.url, id: x.task ? x.task.id : null, error: x.error || null })) });
          }
          const page = await grabPage(target, opts);
          return json(res, 200, page);
        } catch (err) {
          return json(res, 200, { error: err.message });
        }
      }

      // ---- media sniffer: find stream candidates on a page
      if (p === "/api/sniff" && req.method === "POST") {
        const target = String(body.url ?? "");
        if (!target) return json(res, 400, { error: "url is required" });
        try {
          const { sniffPage } = await import("./sniffer.mjs");
          const result = await sniffPage(target, {
            headers: body.headers,
            proxy: this.config.get("proxy") || undefined,
            insecure: this.config.get("insecure"),
          });
          return json(res, 200, result);
        } catch (err) {
          return json(res, 200, { error: err.message, candidates: [] });
        }
      }

      // ---- inspect one stream before committing to it
      if (p === "/api/inspect-stream" && req.method === "POST") {
        const target = String(body.url ?? "");
        if (!target) return json(res, 400, { error: "url is required" });
        try {
          const { inspectStream } = await import("./sniffer.mjs");
          const info = await inspectStream(target, {
            headers: body.headers,
            proxy: this.config.get("proxy") || undefined,
            insecure: this.config.get("insecure"),
          });
          return json(res, 200, info);
        } catch (err) {
          return json(res, 200, { error: err.message });
        }
      }

      // ---- orderly shutdown, used by `downloadx stop`
      if (p === "/api/shutdown" && req.method === "POST") {
        json(res, 200, { ok: true, stopping: true });
        // Answer first, then stop: the caller must not see a broken pipe.
        setTimeout(() => this.onShutdownRequest && this.onShutdownRequest(), 60);
        return;
      }

      // ---- capture proxy: status, start/stop, captures, CA
      if (p === "/api/proxy/status" && req.method === "GET") {
        return json(res, 200, { proxy: this.proxy ? this.proxy.status() : { running: false }, ca: this.ca ? this.ca.describe() : null });
      }
      if (p === "/api/proxy/start" && req.method === "POST") {
        if (!this.proxy) return json(res, 503, { error: "proxy not available" });
        try {
          const info = await this.proxy.start();
          await this.config.set({ captureProxy: { ...this.config.get("captureProxy"), enabled: true, mode: body.mode || this.proxy.mode } });
          return json(res, 200, { ok: true, ...info });
        } catch (err) { return json(res, 500, { error: err.message }); }
      }
      if (p === "/api/proxy/stop" && req.method === "POST") {
        if (!this.proxy) return json(res, 503, { error: "proxy not available" });
        await this.proxy.stop();
        await this.config.set({ captureProxy: { ...this.config.get("captureProxy"), enabled: false } });
        return json(res, 200, { ok: true });
      }
      if (p === "/api/proxy/captures" && req.method === "GET") {
        return json(res, 200, { captures: this.proxy ? this.proxy.list({ limit: Number(url.searchParams.get("limit") || 100) }) : [] });
      }
      if (p === "/api/proxy/captures/clear" && req.method === "POST") {
        return json(res, 200, { removed: this.proxy ? this.proxy.clear() : 0 });
      }
      if (p === "/api/proxy/ca" && req.method === "POST") {
        if (!this.ca) return json(res, 503, { error: "certificate authority not available" });
        try {
          const info = await this.ca.ensure();
          return json(res, 200, info);
        } catch (err) { return json(res, 500, { error: err.message, code: err.code || null }); }
      }
      if (p === "/api/proxy/ca/destroy" && req.method === "POST") {
        if (!this.ca) return json(res, 503, { error: "certificate authority not available" });
        await this.proxy?.stop();
        await this.ca.destroy();
        return json(res, 200, { ok: true });
      }

      // ---- URL history: what was downloaded before, offered back
      if (p === "/api/history" && req.method === "GET") {
        if (!this.history) return json(res, 200, { entries: [], total: 0, available: false });
        const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 50;
        const entries = this.history.list({ q: url.searchParams.get("q") ?? "", limit });
        return json(res, 200, { entries, total: this.history.size, available: true });
      }
      if (p === "/api/history" && req.method === "DELETE") {
        if (!this.history) return json(res, 503, { error: "history is not available" });
        // Destructive and explicit: clearing history is never automatic.
        return json(res, 200, { removed: await this.history.clear() });
      }
      if (p === "/api/history" && req.method === "POST") {
        if (!this.history) return json(res, 503, { error: "history is not available" });
        const target = String(body.url ?? "").trim();
        if (!target) return json(res, 400, { error: "url is required" });
        const entry = this.history.record(target, {
          filename: body.filename, dir: body.dir, source: "api",
        });
        return json(res, 201, { entry });
      }

      // ---- pending approvals (askBeforeAdd): list, approve, reject
      if (p === "/api/pending" && req.method === "GET") {
        if (!this.pending) return json(res, 503, { error: "pending approvals are not available" });
        return json(res, 200, { pending: this.pending.list() });
      }
      const pendMatch = /^\/api\/pending\/([^/]+)\/(approve|reject)$/.exec(p);
      if (pendMatch && req.method === "POST") {
        if (!this.pending) return json(res, 503, { error: "pending approvals are not available" });
        const id = decodeURIComponent(pendMatch[1]);
        if (pendMatch[2] === "reject") {
          if (!this.pending.reject(id)) return json(res, 404, { error: "no such pending" });
          return json(res, 200, { ok: true, rejected: true, id });
        }
        // Approve: queue it through the same queue.add every other add uses
        // (history and persistence unchanged), with the caller's optional
        // dir/filename/category overrides applied.
        const r = this.pending.approve(id, {
          dir: body.dir,
          filename: body.filename,
          category: body.category,
        });
        if (r.kind === "not_found") return json(res, 404, { error: "no such pending" });
        if (r.kind === "conflict") {
          return json(res, 409, { error: "task already in queue", existingTaskId: r.existingTaskId });
        }
        return json(res, 201, { task: taskView(r.task), pendingId: id });
      }

      // ---- log tail
      if (p === "/api/log" && req.method === "GET") {
        // Logger 的方法名是 tailLines(logger.mjs);写成 tail 曾让此路由
        // 恒 500,GUI 日志页一直加载失败(批-3 验收发现,属既有 bug)。
        return json(res, 200, { lines: this.log?.tailLines?.(Number(url.searchParams.get("lines") ?? 200)) ?? [] });
      }

      return json(res, 404, { error: `no route for ${req.method} ${p}` });
    }

    // ---- static GUI
    return this.#serveStatic(req, res, p);
  }

  async #serveStatic(req, res, pathname) {
    let rel = pathname === "/" ? "/index.html" : pathname;
    // Block traversal before touching the filesystem.
    const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const file = path.join(GUI_DIR, safe);
    // Containment must be proved, not guessed from a string prefix: "…\gui" is
    // also a prefix of "…\gui2\x" (a sibling directory), and a `file` that
    // still carries ".." segments begins with the same characters while
    // resolving outside the root. path.relative answers exactly this; "" would
    // mean the file IS the root, which is not a servable file either.
    const relToRoot = path.relative(GUI_DIR, file);
    if (relToRoot === "" || relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const data = await fsp.readFile(file);
      // The GUI needs the token; inject it so the page can call the API.
      if (file.endsWith("index.html")) {
        const inject = `<script>window.__DOWNLOADX__=${JSON.stringify({ token: this.token, port: this.port })};</script>`;
        const html = data.toString("utf8").replace("</head>", `${inject}</head>`);
        res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
        res.end(html);
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  }

  async listen({ port = 0, host = "127.0.0.1" } = {}) {
    this.server = http.createServer((req, res) => {
      // DNS-rebinding guard. A rebinding attack resolves an attacker's domain
      // to 127.0.0.1, so the browser connects here — but the request still
      // carries the attacker's Host header, and the read-side API answers any
      // origin that can reach the socket. Only the addresses this server is
      // meant to be opened at may pass; everything else is refused before any
      // route (token check included) sees the request. The desktop window and
      // both CLI clients use 127.0.0.1, so nothing legitimate changes.
      // remoteAccess deliberately widens this to any Host: LAN MCP clients
      // name the machine by IP, and the mandatory token on every route — not
      // the Host header — is what keeps them out.
      const port0 = this.port ?? this.server.address()?.port;
      const allowRemote = this.config && this.config.get && this.config.get("remoteAccess") === true;
      if (!allowRemote) {
        const allowed = new Set([`127.0.0.1:${port0}`, `localhost:${port0}`, `[::1]:${port0}`]);
        if (!allowed.has(String(req.headers.host ?? "").toLowerCase())) {
          res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("forbidden");
          return;
        }
      }
      const url = new URL(req.url, `http://${host}`);
      this.#handle(req, res, url).catch((err) => {
        if (!res.headersSent) json(res, 500, { error: err?.message ?? "internal error" });
        else try { res.end(); } catch { /* already sent */ }
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, resolve);
    });
    this.port = this.server.address().port;
    this.boundHost = host;
    return { port: this.port, token: this.token, url: `http://${host}:${this.port}/` };
  }

  async close() {
    for (const res of this.events) { try { res.end(); } catch { /* already closed */ } }
    this.events.clear();
    if (!this.server) return;
    // Release idle keep-alive sockets first. server.close() only invokes its
    // callback once every connection has gone, so a client that queued a task
    // and is still holding its connection would block shutdown indefinitely —
    // the runtime file would never be removed and `stop` would report a
    // timeout while the daemon stayed alive.
    try { this.server.closeIdleConnections?.(); } catch { /* older runtimes */ }
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try { this.server.close(finish); } catch { finish(); }
      // Anything still connected after a grace period is not going to leave on
      // its own; drop it so shutdown completes.
      const timer = setTimeout(() => {
        try { this.server.closeAllConnections?.(); } catch { /* nothing to drop */ }
        finish();
      }, 1500);
      timer.unref?.();
    });
  }
}
