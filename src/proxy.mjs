// Local capture proxy.
//
// This is the user-mode alternative to a kernel filter driver (IDM uses a WHQL
// signed WFP driver for the same job). Point an application — or the system
// proxy setting — at this port and downloadx can see the traffic.
//
// Two modes:
//
//   tunnel  HTTPS is an opaque CONNECT tunnel; HTTP is fully visible. Needs no
//           setup and no trust changes. This is the default.
//   mitm    HTTPS is decrypted using a locally generated CA so responses can be
//           inspected. The CA must be installed by the user, which is an
//           explicit trust decision, so it is never enabled by default.
//
// Nothing is modified in flight: requests and responses are forwarded byte for
// byte. The proxy only observes and reports.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { EventEmitter } from "node:events";
import { URL } from "node:url";

import { categorize, extensionOf } from "./categories.mjs";
import { hostOf } from "./rules.mjs";

/** Content types that are never a "download" worth offering. */
const INLINE_TYPES = /^(text\/html|text\/css|text\/javascript|application\/javascript|application\/json|application\/xml|image\/svg|text\/xml|application\/manifest)/i;

/** Types that are almost always a file transfer. */
const BINARY_TYPES = /^(application\/(octet-stream|zip|x-msdownload|x-msdos-program|x-7z-compressed|x-rar|x-tar|pdf|x-apple-diskimage|vnd\.android\.package-archive)|video\/|audio\/|font\/)/i;

const DEFAULT_MAX_CAPTURE = 500;

/**
 * The proxy URL an upstream request should leave through, from the standard
 * environment variables (P-15, env half; the explicit wiring for what
 * NODE_USE_ENV_PROXY used to paper over — a Node >= 24 experiment that is
 * unset on most machines and on Windows).
 *
 * NO_PROXY is honoured first (comma-separated; "*" matches everything; a
 * leading "." or bare suffix matches the host and its subdomains).
 * Registry / system-proxy discovery is deliberately NOT here: that is the
 * proxyMode consumption work of P-18 (batch-7).
 *
 * @param {string} host the origin host, for NO_PROXY exclusion
 * @returns {string|null} a proxy URL, or null for a direct connection
 */
export function envProxyFor(host) {
  const noProxy = String(process.env.NO_PROXY || process.env.no_proxy || "");
  const target = String(host || "").toLowerCase();
  if (target && noProxy) {
    for (const raw of noProxy.split(",")) {
      let pat = raw.trim().toLowerCase();
      if (!pat) continue;
      if (pat === "*") return null;
      if (pat.startsWith(".")) pat = pat.slice(1);
      if (target === pat || target.endsWith("." + pat)) return null;
    }
  }
  const v = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.ALL_PROXY || process.env.all_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  return v ? String(v) : null;
}

/**
 * Decide whether a response is something the user would want to download.
 * Deliberately conservative: a false positive interrupts browsing, a false
 * negative is only a missed convenience.
 *
 * @returns {{ isDownload:boolean, reason:string, confidence:"high"|"medium"|"low" }}
 */
export function classifyResponse({ url, statusCode, headers }, opts = {}) {
  const minBytes = opts.minBytes ?? 256 * 1024;
  const contentType = String(headers["content-type"] || "").split(";")[0].trim();
  const disposition = String(headers["content-disposition"] || "");
  const length = Number(headers["content-length"] || NaN);
  const ext = extensionOf(url.split("?")[0]);

  if (statusCode >= 300 && statusCode < 400) return { isDownload: false, reason: "redirect", confidence: "low" };
  if (statusCode >= 400) return { isDownload: false, reason: "error status", confidence: "low" };
  if (headers["content-range"]) return { isDownload: false, reason: "partial content", confidence: "low" };

  // A server that says "attachment" is telling us outright.
  if (/attachment/i.test(disposition)) {
    return { isDownload: true, reason: "Content-Disposition: attachment", confidence: "high" };
  }

  // A file extension we know how to file away, with a non-trivial body.
  const category = categorize(url, opts.categories);
  if (category && (Number.isFinite(length) ? length >= 64 * 1024 : true) && !INLINE_TYPES.test(contentType)) {
    return { isDownload: true, reason: "downloadable file type (" + category + ")", confidence: "high" };
  }

  if (BINARY_TYPES.test(contentType)) {
    if (Number.isFinite(length) && length < minBytes) {
      return { isDownload: false, reason: "binary but small", confidence: "low" };
    }
    return { isDownload: true, reason: "binary content type " + contentType, confidence: "medium" };
  }

  if (INLINE_TYPES.test(contentType)) return { isDownload: false, reason: "inline document", confidence: "low" };

  // Unknown type with a large body: worth offering, but say it is a guess.
  if (Number.isFinite(length) && length >= minBytes) {
    return { isDownload: true, reason: "large response (" + Math.round(length / 1024) + " KB)", confidence: "low" };
  }
  return { isDownload: false, reason: "ordinary response", confidence: "low" };
}

export class CaptureProxy extends EventEmitter {
  /**
   * @param {{ port?:number, host?:string, mode?:"tunnel"|"mitm", ca?:object,
   *           maxCapture?:number, config?:any, upstreamProxy?:string }} opts
   */
  constructor(opts = {}) {
    super();
    this.host = opts.host || "127.0.0.1";
    this.port = opts.port ?? 0;
    this.mode = opts.mode === "mitm" ? "mitm" : "tunnel";
    this.ca = opts.ca || null;              // CA or { leafFor(host) } / legacy { getLeaf(host) }
    this.maxCapture = opts.maxCapture ?? DEFAULT_MAX_CAPTURE;
    this.config = opts.config;
    this.upstreamProxy = opts.upstreamProxy || null;
    this.captures = [];
    this.server = null;
    this.stats = { requests: 0, captured: 0, tunnels: 0, mitm: 0, errors: 0, bytes: 0 };
    /** Live sockets, so stop() can end tunnels that would otherwise keep the
     *  listener open forever (server.close waits for connections to finish). */
    this.sockets = new Set();
    this.startedAt = null;
    this.seen = new Set();                  // de-duplicate identical offers
  }

  get enabled() { return Boolean(this.server); }

  /**
   * Start listening.
   *
   * @param {("tunnel"|"mitm")} [mode] optional mode switch (P-14). Applied
   *        BEFORE the listener exists: #onConnect reads this.mode per
   *        connection, so the mode must be in place before the first CONNECT
   *        arrives — that is the whole point of accepting it here. The old
   *        signature took no argument, which made POST /api/proxy/start's
   *        mode field a no-op until a daemon restart.
   * @returns {Promise<{host:string,port:number,mode:string}>}
   */
  async start(mode) {
    if (mode !== undefined && mode !== "tunnel" && mode !== "mitm") {
      throw new Error('proxy mode must be "tunnel" or "mitm", got ' + JSON.stringify(mode));
    }
    if (mode !== undefined) this.mode = mode;
    if (this.server) return { host: this.host, port: this.port, mode: this.mode };
    this.server = http.createServer((req, res) => this.#onRequest(req, res));
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    this.server.on("connect", (req, socket, head) => this.#onConnect(req, socket, head));
    this.server.on("clientError", (err, socket) => {
      this.stats.errors++;
      try { socket.destroy(); } catch { /* already gone */ }
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => resolve(undefined));
    });
    this.port = this.server.address().port;
    this.startedAt = Date.now();
    this.emit("started", { host: this.host, port: this.port, mode: this.mode });
    return { host: this.host, port: this.port, mode: this.mode };
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    // Close the listener, then end every live connection. Without this a single
    // open CONNECT tunnel keeps close() pending indefinitely.
    const closed = new Promise((r) => server.close(() => r(undefined)));
    for (const socket of this.sockets) {
      try { socket.destroy(); } catch { /* already gone */ }
    }
    this.sockets.clear();
    await closed;
    this.emit("stopped", {});
  }

  // ------------------------------------------------------------- plain HTTP

  #onRequest(req, res) {
    this.stats.requests++;
    let target;
    try {
      // A proxy request carries an absolute URI; an origin-form request means
      // the client is talking to us directly.
      target = req.url.startsWith("http://") || req.url.startsWith("https://")
        ? new URL(req.url)
        : new URL(req.url, "http://" + (req.headers.host || "localhost"));
    } catch {
      this.stats.errors++;
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("downloadx proxy: malformed request target");
      return;
    }

    const isHttps = target.protocol === "https:";
    const transport = isHttps ? https : http;
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    headers.host = target.host;

    const upstream = transport.request({
      host: target.hostname,
      port: Number(target.port || (isHttps ? 443 : 80)),
      method: req.method,
      path: target.pathname + target.search,
      headers,
    }, (upRes) => {
      // Observe before forwarding: the decision must not delay the client.
      this.#observe({ url: target.toString(), method: req.method, statusCode: upRes.statusCode, headers: upRes.headers });

      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
      upRes.on("data", (c) => { this.stats.bytes += c.length; });
      upRes.on("error", () => { this.stats.errors++; try { res.destroy(); } catch { /* gone */ } });
    });

    upstream.on("error", (err) => {
      this.stats.errors++;
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("downloadx proxy upstream error: " + err.message);
      } else {
        try { res.destroy(); } catch { /* gone */ }
      }
    });
    req.pipe(upstream);
  }

  // ---------------------------------------------------- CONNECT (HTTPS)

  #onConnect(req, clientSocket, head) {
    this.stats.tunnels++;
    const [host, portText] = String(req.url).split(":");
    const port = Number(portText || 443);

    if (this.mode === "mitm" && this.ca) {
      // Async since P-15 (leaf signing). Not awaited: this is an event
      // handler. Every failure path inside answers the client socket; the
      // catch is a last-resort belt so nothing escapes as unhandled.
      this.#mitmConnect(host, port, clientSocket, head).catch(() => {
        try { clientSocket.destroy(); } catch { /* gone */ }
      });
      return;
    }

    // Tunnel mode: open a raw pipe. The proxy learns the destination but not
    // the content, which is exactly the trade-off of not installing a CA.
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    // Errors tear the pair down; a normal close is left alone so buffered
    // bytes can still drain (destroying on 'close' drops the tail).
    const teardown = () => {
      try { upstream.destroy(); } catch { /* gone */ }
      try { clientSocket.destroy(); } catch { /* gone */ }
    };
    upstream.on("error", () => { this.stats.errors++; teardown(); });
    clientSocket.on("error", teardown);
  }

  /**
   * Leaf material for a MITM'd host (P-15).
   *
   * Resolution order:
   *   1. ca.leafFor(host) — the full path: an in-memory/disk hit is instant
   *      (the fast case leafForSync used to cover alone), a MISS signs a new
   *      leaf with openssl and persists it. Awaited by #mitmConnect before
   *      any TLS socket exists.
   *   2. ca.getLeaf(host) — the legacy wrapper shape around leafForSync
   *      (read-only). Kept so wiring that pre-generates leaves keeps working;
   *      a thenable is awaited, so an async getLeaf works too.
   */
  async #leafFor(host) {
    if (this.ca && typeof this.ca.leafFor === "function") return this.ca.leafFor(host);
    if (this.ca && typeof this.ca.getLeaf === "function") {
      const r = this.ca.getLeaf(host);
      return (r && typeof r.then === "function") ? await r : r;
    }
    throw new Error("the CA object exposes no leaf source");
  }

  async #mitmConnect(host, port, clientSocket, head) {
    // Signing an unseen host shells out to openssl (hundreds of ms); a client
    // that gives up meanwhile must not turn the late writes into an unhandled
    // error event.
    clientSocket.on("error", () => { try { clientSocket.destroy(); } catch { /* gone */ } });
    let leaf;
    try {
      // P-15: the old code called the synchronous read-only lookup here, which
      // threw for every host nobody had pre-generated a certificate for —
      // hence the all-hosts 502 in the field. The async path signs on demand.
      leaf = await this.#leafFor(host);
    } catch (err) {
      this.stats.errors++;
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    if (clientSocket.destroyed) return;
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: leaf.key,
      cert: leaf.cert,
      ALPNProtocols: ["http/1.1"],
    });
    tlsSocket.on("error", () => { this.stats.errors++; try { tlsSocket.destroy(); } catch { /* gone */ } });

    // Parse HTTP over the decrypted stream by handing it to a one-off server.
    const inner = http.createServer((innerReq, innerRes) => {
      this.stats.mitm++;
      this.#forwardMitm(host, port, innerReq, innerRes);
    });
    inner.on("clientError", () => { try { tlsSocket.destroy(); } catch { /* gone */ } });
    inner.emit("connection", tlsSocket);
    if (head && head.length) tlsSocket.unshift(head);
  }

  #forwardMitm(host, port, req, res) {
    const headers = { ...req.headers, host: host + (port === 443 ? "" : ":" + port) };
    const fail = (err) => {
      this.stats.errors++;
      if (!res.headersSent) { res.writeHead(502, { "Content-Type": "text/plain" }); res.end("downloadx proxy: " + err.message); }
      else try { res.destroy(); } catch { /* gone */ }
    };
    const send = (extra) => {
      const upstream = https.request({
        host, port, method: req.method, path: req.url, headers,
        rejectUnauthorized: false,   // the client's trust decision is theirs; we only observe
        ...extra,
      }, (upRes) => {
        this.#observe({ url: "https://" + host + req.url, method: req.method, statusCode: upRes.statusCode, headers: upRes.headers, decrypted: true });
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
      });
      upstream.on("error", fail);
      req.pipe(upstream);
    };

    // P-15: MITM used to dial the origin directly and lean on
    // NODE_USE_ENV_PROXY (a Node >= 24 experiment, unset on most machines and
    // on Windows) for the machine's proxy. Now the upstream request leaves
    // through the explicitly configured upstream, else the standard env
    // vars. Registry/system-proxy discovery is the proxyMode work of P-18
    // (batch-7) and is deliberately not read here.
    const proxyUrl = this.upstreamProxy || envProxyFor(host);
    if (!proxyUrl) {
      send({});
      return;
    }
    const p = new URL(proxyUrl);
    const connect = http.request({
      host: p.hostname,
      port: Number(p.port || 80),
      method: "CONNECT",
      path: host + ":" + port,
      headers: { Host: host + ":" + port },
      agent: false,
    });
    connect.once("connect", (cres, socket) => {
      if (cres.statusCode !== 200) {
        socket.destroy();
        fail(new Error("upstream proxy CONNECT failed: HTTP " + cres.statusCode + " for " + host));
        return;
      }
      socket.setNoDelay(true);
      // TLS over the tunnel, mirroring net.mjs's httpsOverTunnel ownership
      // rule: the raw socket to the proxy is destroyed with the TLS side, or
      // a finished request leaves a live connection (and a live event loop
      // reference) behind.
      const tlsSocket = tls.connect({ socket, servername: host, rejectUnauthorized: false });
      tlsSocket.on("error", () => {});
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try { tlsSocket.destroy(); } catch { /* gone */ }
        try { socket.destroy(); } catch { /* gone */ }
      };
      // Every terminal path: the client response closed (body drained, or
      // destroyed by the error handler above) ends the tunnel with it.
      res.once("close", release);
      tlsSocket.once("close", () => { try { socket.destroy(); } catch { /* gone */ } });
      send({ createConnection: () => tlsSocket });
    });
    connect.once("error", fail);
    connect.end();
  }

  // ------------------------------------------------------------- capture

  #observe(record) {
    const verdict = classifyResponse(record, { categories: this.config?.get?.("categories") });
    if (!verdict.isDownload) return;

    const key = record.url.split("#")[0];
    if (this.seen.has(key)) return;
    this.seen.add(key);

    const entry = {
      id: "cap_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7),
      url: record.url,
      host: hostOf(record.url),
      method: record.method,
      statusCode: record.statusCode,
      contentType: String(record.headers["content-type"] || "").split(";")[0].trim() || null,
      contentLength: Number(record.headers["content-length"] || 0) || null,
      filename: filenameFromHeaders(record.headers, record.url),
      category: categorize(record.url, this.config?.get?.("categories")),
      reason: verdict.reason,
      confidence: verdict.confidence,
      decrypted: Boolean(record.decrypted),
      at: Date.now(),
    };
    this.captures.unshift(entry);
    if (this.captures.length > this.maxCapture) this.captures.length = this.maxCapture;
    this.stats.captured++;
    this.emit("capture", entry);
  }

  list({ limit = 100, since = 0 } = {}) {
    return this.captures.filter((c) => c.at > since).slice(0, limit);
  }

  clear() {
    const n = this.captures.length;
    this.captures.length = 0;
    this.seen.clear();
    return n;
  }

  status() {
    return {
      running: this.enabled,
      host: this.host,
      port: this.port,
      mode: this.mode,
      startedAt: this.startedAt,
      stats: { ...this.stats },
      caReady: Boolean(this.ca),
    };
  }
}

/** Best-effort filename from Content-Disposition, else the URL path. */
export function filenameFromHeaders(headers, url) {
  const cd = String(headers["content-disposition"] || "");
  const star = /filename\*\s*=\s*([^;]+)/i.exec(cd);
  if (star) {
    const raw = star[1].trim().replace(/^"|"$/g, "");
    const m = /^([\w-]+)''(.*)$/.exec(raw);
    try { return decodeURIComponent(m ? m[2] : raw); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(cd);
  if (plain) return (plain[2] ?? plain[3] ?? "").trim();
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(last) || "download";
  } catch { return "download"; }
}
