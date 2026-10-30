// HTTP(S) transport: redirects, proxy tunnelling, and a layered TLS fallback.
//
// The fallback chain exists because a single handshake profile is not always
// enough in the wild: older origins and middleboxes reject modern parameters,
// and losing the whole transfer at that point would be needless.

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { URL } from "node:url";
import { createConnection } from "node:net";

export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TLS_PROFILES = [
  { label: "system-default", opts: {} },
  { label: "tls>=1.2", opts: { minVersion: "TLSv1.2" } },
  { label: "tls>=1.0", opts: { minVersion: "TLSv1", maxVersion: "TLSv1.3" } },
];

export class HttpStatusError extends Error {
  constructor(statusCode, statusMessage, url, extra = {}) {
    super(`HTTP ${statusCode} ${statusMessage || ""} for ${url}`.trim());
    this.name = "HttpStatusError";
    this.statusCode = statusCode;
    this.retryAfterMs = extra.retryAfterMs || 0;
    this.retryable = statusCode === 408 || statusCode === 429 || statusCode >= 500;
  }
}

/** Raised when the origin ignores Range and answers 200 to a ranged request. */
export class RangeNotSupportedError extends Error {
  constructor(url) {
    super(`origin ignored Range and returned 200 for ${url}`);
    this.name = "RangeNotSupportedError";
  }
}

/**
 * P-17: how long an HTTP proxy's CONNECT handshake may take.
 *
 * The phase used to ride the caller's request timeoutMs verbatim, so an
 * aggressive caller budget could cut a healthy-but-slow proxy handshake
 * before it finished (the 2026-10-25 cloud runs saw first-CONNECT drops on
 * DASH/inspect under what amounted to a ~5s window, with every retry
 * succeeding — the budget, not the proxy, was the failure). 15s is a floor,
 * not the new budget: a caller with a longer request timeout keeps it, and a
 * shorter one no longer starves CONNECT. SOCKS keeps its own budget in
 * socksConnect(). A CONNECT failure here is a plain transport error to the
 * retry/translation layers above (probe annotates `attempts`, the engine
 * prefixes "after N attempts"), so raising the floor costs retry patience,
 * never visibility.
 */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Errno values the local disk side of this process can raise. The
 * unknown-code arm of translateTaskError() must NOT append a network target
 * to them: in "EPERM: operation not permitted, open 'C:\\...'" the failing
 * link is the disk, and naming the download's host would point the user at
 * the wrong layer entirely.
 */
const FILESYSTEM_ERRNOS = new Set([
  "EACCES", "EPERM", "EBUSY", "ENOENT", "ENOTDIR", "ENOTEMPTY", "EISDIR",
  "EEXIST", "ENOSPC", "EMFILE", "ENFILE", "ENAMETOOLONG", "EROFS", "EXDEV",
]);

/**
 * The endpoint a failed request was talking to, from whichever layer still
 * knows it (P-9).
 *
 * Node's own errors are preferred over the caller's URL: a DNS failure names
 * the host it could not resolve (err.hostname), a refused connection carries
 * address and port (err.port), and "connect ECONNREFUSED 127.0.0.1:9" spells
 * the endpoint out in the message. The caller's URL is the last resort —
 * after redirects it may no longer be the host that refused us, but it is
 * still the host the user asked for.
 */
function errorHostPort(err, url) {
  let host = String(err?.hostname || "");
  let port = err?.port === undefined || err?.port === null ? "" : String(err.port);
  if (!host || !port) {
    const m = /connect [A-Z_]+ (\[[^\]]+\]|[^\s:]+):(\d+)/.exec(String(err?.message || ""));
    if (m) {
      if (!host) host = m[1];
      if (!port) port = m[2];
    }
  }
  if ((!host || !port) && url) {
    try {
      const u = new URL(url);
      if (!host) host = u.hostname;
      if (!port) port = u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
    } catch { /* the caller's context was not a URL */ }
  }
  return { host, port };
}

/**
 * Translate a transport-level failure into the final, human-facing task
 * error (P-9).
 *
 * The cloud field report (2026-10-25) showed every connection failure
 * surfacing as an opaque English sentence that does not even exist in this
 * repository. The download path's own errors are errno-coded, so the last
 * thing a task throws can — and should — be normalized here:
 *
 *   ENOTFOUND / EAI_AGAIN -> "域名解析失败:<host>"
 *   ECONNREFUSED          -> "连接被拒绝:<host>:<port>"
 *   ETIMEDOUT / ECONNRESET-> "连接超时或被重置:<host>"
 *   proxy CONNECT non-200 -> the existing "proxy CONNECT failed: HTTP <code>
 *                            for <host>" family (kept, not re-worded)
 *   any other errno-shaped code (EPIPE, EHOSTUNREACH, ERR_SSL_*,
 *   undici's UND_ERR_*) -> original text, with the target host appended
 *
 * @returns {string|null} the translated message, or null when the error must
 *          keep its message unchanged — a cancellation (api.mjs decides
 *          pause-vs-error from the message), an application-semantic failure
 *          (TARGET_BUSY, ALREADY_EXISTS already name their situation, and
 *          their `code` is a contract, not an errno), or anything with no
 *          underlying code and no host to name.
 */
export function translateTaskError(err, { url } = {}) {
  if (!err || typeof err !== "object") return null;
  if (err.name === "AbortError" || err.code === "ABORT_ERR") return null;
  if (err.code === "TARGET_BUSY" || err.code === "ALREADY_EXISTS") return null;
  const message = String(err.message || "");
  const code = String(err.code || "");
  // The proxy CONNECT family keeps its own wording (P-9 says keep it); if an
  // older message lacks the host, append it rather than re-wording.
  if (err.name === "ProxyConnectError" || /^proxy CONNECT failed: HTTP \d+/.test(message)) {
    return message.includes(" for ") ? message : message + " for " + errorHostPort(err, url).host;
  }
  const { host, port } = errorHostPort(err, url);
  if (!host) return null;          // nothing to anchor a translation to
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "域名解析失败:" + host;
  if (code === "ECONNREFUSED") return "连接被拒绝:" + host + (port ? ":" + port : "");
  if (code === "ETIMEDOUT" || code === "ECONNRESET") return "连接超时或被重置:" + host;
  if (code && /^[A-Z][A-Z0-9_]*$/.test(code) && !FILESYSTEM_ERRNOS.has(code)) {
    return message + "（目标 " + host + "）";
  }
  return null;
}

/**
 * P-18: Proxy-Authorization from credentials embedded in the proxy URL.
 *
 * The proxy URL has always accepted user:pass (the SOCKS path parses them)
 * but the HTTP CONNECT never sent them, so an authenticated proxy answered
 * 407 to every tunnel and the download died — the manual Settings proxy was
 * unusable on any network that requires a login.
 *
 * Credential discipline: this function only ever RETURNS the finished header
 * value; it does not log, throw with the URL embedded, or leak the raw
 * user:pass anywhere. An unparseable URL yields null (no header), not an
 * error echoing the credential. Every failure message further down the proxy
 * paths names the proxy HOST, never the URL it came from.
 *
 * @param {string} proxyUrl a proxy URL that may carry user:pass
 * @returns {string|null} "Basic …" or null when there is nothing to send
 */
export function proxyAuthHeader(proxyUrl) {
  try {
    const p = new URL(proxyUrl);
    if (!p.username && !p.password) return null;
    const cred = decodeURIComponent(p.username || "") + ":" + decodeURIComponent(p.password || "");
    return "Basic " + Buffer.from(cred, "utf8").toString("base64");
  } catch {
    return null;
  }
}

function proxyConnect(proxyUrl, host, port, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    // A bad proxy URL must not reject with Node's ERR_INVALID_URL, whose
    // `input` carries the full URL — credentials included (see
    // proxyAuthHeader for the discipline). The message names no URL at all.
    let p;
    try {
      p = new URL(proxyUrl);
    } catch {
      reject(new Error("invalid proxy URL"));
      return;
    }
    const connectHeaders = { Host: `${host}:${port}`, "Proxy-Connection": "keep-alive" };
    const auth = proxyAuthHeader(proxyUrl);
    if (auth) connectHeaders["Proxy-Authorization"] = auth;
    const req = http.request({
      host: p.hostname,
      port: Number(p.port || 80),
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: connectHeaders,
      agent: false,
    });
    const onAbort = () => req.destroy(new Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("proxy CONNECT timeout")));
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        // P-9: the tunnel target names the failure. "HTTP 403" alone says
        // neither which origin was being reached nor that it was the proxy
        // (not the origin) that refused — both facts are in the caller's
        // hands right here. The error keeps its own message family; the
        // translation layer (translateTaskError) recognizes it by name and
        // passes it through untouched.
        const err = new Error(`proxy CONNECT failed: HTTP ${res.statusCode} for ${host}`);
        err.name = "ProxyConnectError";
        reject(err);
        return;
      }
      socket.setNoDelay(true);
      resolve(socket);
    });
    req.once("error", reject);
    req.end();
  });
}

/**
 * Open a TCP connection through a SOCKS5 proxy (RFC 1928), with optional
 * username/password authentication (RFC 1929).
 *
 * Implemented here rather than pulled in as a dependency: it is about eighty
 * lines of a well-specified protocol, and the project has no runtime
 * dependencies by design.
 *
 * @param {string} proxyUrl   socks5://[user:pass@]host:port
 * @param {string} host       destination host (a name is sent as a name, so the
 *                            proxy resolves it; that is what makes SOCKS useful
 *                            for hosts the client cannot resolve itself)
 * @param {number} port       destination port
 * @param {{ timeoutMs?:number, signal?:AbortSignal }} [opts]
 * @returns {Promise<import('node:net').Socket>} a connected socket
 */
function socksConnect(proxyUrl, host, port, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const url = new URL(proxyUrl);
  const proxyHost = url.hostname;
  const proxyPort = Number(url.port || 1080);
  const username = decodeURIComponent(url.username || "");
  const password = decodeURIComponent(url.password || "");
  if (!proxyHost || !proxyPort) return Promise.reject(new Error("socks5 proxy needs host:port"));

  return new Promise((resolve, reject) => {
    // The file scope has no `net` import for this path; require it lazily so a
    // build without SOCKS use does not pay for it.
    const socket = createConnection({ host: proxyHost, port: proxyPort });
    let settled = false;
    let buffer = Buffer.alloc(0);
    let stage = "greeting";

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already gone */ }
      reject(err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      socket.removeListener("data", onData);
      socket.removeListener("error", fail);
      socket.removeListener("timeout", onTimeout);
      socket.setNoDelay(true);
      resolve(socket);
    };
    const onTimeout = () => fail(new Error("socks5 proxy timed out during " + stage));

    socket.once("connect", () => {
      // Greeting: version 5, and the methods we are willing to use. Both "no
      // auth" and "username/password" are always offered, because the proxy
      // chooses: offering only "no auth" made a proxy that requires a
      // credential answer "no acceptable methods", which tells the user nothing
      // about what is actually missing. The credential itself is only sent if
      // the proxy selects method 0x02.
      const methods = username ? [0x00, 0x02] : [0x02, 0x00];
      socket.write(Buffer.from([0x05, methods.length, ...methods]));
    });
    socket.once("error", fail);
    socket.setTimeout(timeoutMs, onTimeout);

    // A SOCKS session is a small state machine: greeting reply, then either an
    // auth exchange or straight to the connect reply. Replies can arrive in
    // fragments, so everything goes through one buffer.
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (stage === "greeting") {
          if (buffer.length < 2) return;
          const [, method] = buffer;
          buffer = buffer.subarray(2);
          if (method === 0xff) return fail(new Error("socks5 proxy refused every offered auth method"));
          if (method === 0x02) {
            if (!username) {
              return fail(new Error(
                "the socks5 proxy requires a username and password; put them in the proxy URL, " +
                "for example socks5://user:pass@host:port"));
            }
            stage = "auth";
            const u = Buffer.from(username, "utf8");
            const p = Buffer.from(password, "utf8");
            socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
            continue;
          }
          if (method !== 0x00) return fail(new Error("socks5 proxy chose unsupported method " + method));
          stage = "connect";
          writeConnect();
          continue;
        }

        if (stage === "auth") {
          if (buffer.length < 2) return;
          const [, status] = buffer;
          buffer = buffer.subarray(2);
          if (status !== 0x00) return fail(new Error("socks5 authentication was rejected"));
          stage = "connect";
          writeConnect();
          continue;
        }

        // connect reply: ver, rep, rsv, atyp, addr..., port
        if (buffer.length < 4) return;
        const [, reply, , atyp] = buffer;
        let addrLen;
        if (atyp === 0x01) addrLen = 4;
        else if (atyp === 0x04) addrLen = 16;
        else if (atyp === 0x03) {
          if (buffer.length < 5) return;
          addrLen = 1 + buffer[4];
        } else return fail(new Error("socks5 proxy sent an unknown address type " + atyp));
        const total = 4 + addrLen + 2;
        if (buffer.length < total) return;
        buffer = buffer.subarray(total);
        if (reply !== 0x00) return fail(new Error("socks5 proxy could not reach the destination: " + SOCKS_REPLY[reply]));
        return succeed();
      }
    };

    function writeConnect() {
      const addr = Buffer.from(host, "utf8");
      if (addr.length > 255) return fail(new Error("host name is too long for socks5"));
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port, 0);
      // ATYP 0x03 sends the name for the proxy to resolve.
      socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, addr.length]), addr, portBuf]));
    }

    socket.on("data", onData);
    opts.signal?.addEventListener("abort", () => fail(new Error("aborted")), { once: true });
  });
}

/** Human-readable SOCKS5 reply codes. */
const SOCKS_REPLY = {
  0x01: "general failure",
  0x02: "connection not allowed by the proxy's rules",
  0x03: "network unreachable",
  0x04: "host unreachable",
  0x05: "connection refused",
  0x06: "TTL expired",
  0x07: "command not supported",
  0x08: "address type not supported",
};

/** Does this proxy URL ask for SOCKS? */
export function isSocksProxy(proxyUrl) {
  return /^socks(5|5h)?:\/\//i.test(String(proxyUrl || ""));
}

/** An Error carrying the marker the rest of the code uses for cancellation. */
export function abortError() {
  const err = new Error("aborted");
  err.code = "ABORT_ERR";
  return err;
}

/**
 * Stop an in-flight body the moment the caller's signal fires.
 *
 * Registered per response and detached from every exit path (end, close,
 * error, explicit discard), so a completed transfer leaves no listener behind
 * and a long-lived signal does not accumulate handlers across fragments.
 *
 * @param {import("node:stream").Readable} res
 * @param {AbortSignal} [signal]
 */
function attachBodyAbort(res, signal) {
  if (!signal || typeof res?.on !== "function") return;
  if (signal.aborted) { res.destroy(abortError()); return; }
  const onAbort = () => {
    try { res.destroy(abortError()); } catch { /* already gone */ }
  };
  const detach = () => {
    signal.removeEventListener("abort", onAbort);
    res.removeListener("end", detach);
    res.removeListener("close", detach);
    res.removeListener("error", detach);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  res.once("end", detach);
  res.once("close", detach);
  res.once("error", detach);
  // discard() uses this to detach when a response is abandoned unread.
  Object.defineProperty(res, "_detachBodyAbort", { value: detach, enumerable: false, configurable: true });
}

/**
 * Speak HTTPS over a socket a proxy has already opened — and own that socket.
 *
 * `tls.connect({ socket })` wraps the socket but does not take ownership of it.
 * When the TLS session is torn down the TLS side closes, and the underlying TCP
 * connection to the proxy is left open and still referenced by the event loop,
 * so a *completed* transfer kept `node` alive indefinitely. Measured on a
 * CONNECT proxy: two requests left two live sockets to the proxy and the
 * process never exited, while the plain HTTPS path leaked nothing.
 *
 * Releasing the TLS socket alone is not enough; the raw socket has to be
 * destroyed too, which is what `release` does (idempotent, safe on any path).
 *
 * @returns {{req: import('node:http').ClientRequest, release: () => void}}
 */
function httpsOverTunnel(rawSocket, u, port, headerBag, method, insecure, tlsOpts) {
  const tlsSocket = tls.connect({
    socket: rawSocket,
    servername: u.hostname,
    ALPNProtocols: ["http/1.1"],
    rejectUnauthorized: !insecure,
    ...tlsOpts,
  });
  // A failed handshake must not surface as an unhandled 'error' event; the
  // request below reports it to the caller.
  tlsSocket.on("error", () => {});

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { tlsSocket.destroy(); } catch { /* already gone */ }
    try { rawSocket.destroy(); } catch { /* already gone */ }
  };

  const req = https.request({
    host: u.hostname,
    port,
    path: u.pathname + u.search,
    method,
    headers: headerBag,
    createConnection: () => tlsSocket,
    rejectUnauthorized: !insecure,
  });
  return { req, release };
}

function dispatchOnce(url, opts, tlsOpts) {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const port = Number(u.port || (isHttps ? 443 : 80));
  const headerBag = { ...opts.headers };

  return new Promise((resolve, reject) => {
    let req;
    let releaseTunnel = null;
    const onAbort = () => { releaseTunnel?.(); req?.destroy(abortError()); };
    const finish = (fn) => (arg) => { opts.signal?.removeEventListener("abort", onAbort); fn(arg); };

    const handle = (res) => {
      // The request-phase abort listener is about to be detached by finish(),
      // but the body has not been read yet. Dropping the signal here is what
      // made a cancel wait for the next chunk: the request was already
      // "responded", so nothing was watching the signal any more, and a stalled
      // body only noticed the abort when more data arrived or the request timed
      // out. Re-arm it against the response stream instead.
      attachBodyAbort(res, opts.signal);
      resolve({
        statusCode: res.statusCode,
        statusMessage: res.statusMessage,
        headers: res.headers,
        stream: res,
        destroy: () => res.destroy(),
      });
    };

    // Every tunnelled (proxied) request owns a raw socket the TLS layer does
    // not close for it. releaseTunnel is wired to each terminal path — body
    // finished, request error, timeout, abort — because a single missed path
    // is enough to keep the process alive for ever.
    const attachTunnel = (tunnel) => {
      releaseTunnel = tunnel.release;
      req = tunnel.req;
      req.once("response", (res) => {
        // The response stream only closes once the body is fully read or the
        // caller drops it, which is exactly when the tunnel can go.
        res.once("close", () => releaseTunnel?.());
        finish(handle)(res);
      });
      req.once("error", (err) => { releaseTunnel?.(); finish(reject)(err); });
      req.setTimeout(opts.timeoutMs, () => {
        releaseTunnel?.();
        req.destroy(new Error("request timeout"));
      });
    };

    if (opts.proxy && isSocksProxy(opts.proxy)) {
      // SOCKS5 is a transparent TCP relay, so both schemes take the same path:
      // open the connection through the proxy, then speak TLS or HTTP over it.
      socksConnect(opts.proxy, u.hostname, port, { timeoutMs: opts.timeoutMs, signal: opts.signal })
        .then((socket) => {
          if (isHttps) {
            attachTunnel(httpsOverTunnel(socket, u, port, headerBag, opts.method, opts.insecure, tlsOpts));
          } else {
            req = http.request({
              host: u.hostname,
              port,
              path: u.pathname + u.search,
              method: opts.method,
              headers: headerBag,
              createConnection: () => socket,
            });
            req.once("response", finish(handle));
            req.once("error", finish(reject));
            req.setTimeout(opts.timeoutMs, () => req.destroy(new Error("request timeout")));
          }
          req.end(opts.body);
        })
        .catch(finish(reject));
      return;
    }

    if (opts.proxy) {
      const p = new URL(opts.proxy);
      if (isHttps) {
        proxyConnect(opts.proxy, u.hostname, port, Math.max(Number(opts.timeoutMs) || 0, CONNECT_TIMEOUT_MS), opts.signal)
          .then((socket) => {
            attachTunnel(httpsOverTunnel(socket, u, port, headerBag, opts.method, opts.insecure, tlsOpts));
            req.end();
          })
          .catch(finish(reject));
        return;
      }
      req = http.request({
        host: p.hostname,
        port: Number(p.port || 80),
        path: url,
        method: opts.method,
        // The plain-HTTP-through-proxy hop needs the proxy's own credential
        // just like CONNECT does (P-18): an authenticated proxy refuses the
        // absolute-URI request with 407 without it. This header addresses the
        // proxy, never the origin, so it rides outside headerBag.
        headers: (() => {
          const h = { ...headerBag, Host: u.host };
          const auth = proxyAuthHeader(opts.proxy);
          if (auth) h["Proxy-Authorization"] = auth;
          return h;
        })(),
      });
    } else if (isHttps) {
      req = https.request({
        host: u.hostname,
        port,
        path: u.pathname + u.search,
        method: opts.method,
        headers: headerBag,
        rejectUnauthorized: !opts.insecure,
        ...tlsOpts,
      });
    } else {
      req = http.request({
        host: u.hostname,
        port,
        path: u.pathname + u.search,
        method: opts.method,
        headers: headerBag,
      });
    }

    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // A transport reset must never surface as an unhandled 'error' event.
    // The request/response path still reports the failure to the caller.
    req.on("socket", (socket) => {
      if (socket && typeof socket.on === "function" && socket.listenerCount("error") === 0) {
        socket.on("error", () => {});
      }
    });
    req.once("response", finish(handle));
    req.once("error", finish(reject));
    req.setTimeout(opts.timeoutMs, () => req.destroy(new Error("request timeout")));
    req.end(opts.body);
  });
}

/** A TLS-level failure is worth one retry under a looser profile. */
function isTlsFailure(err) {
  const code = err?.code || "";
  const msg = String(err?.message || "");
  return (
    /^(ERR_SSL|ERR_TLS|EPROTO|ECONNRESET|ECONNREFUSED)/.test(code) ||
    /handshake|SSL|TLS|socket hang up|disconnected/i.test(msg)
  );
}

/**
 * One request with automatic TLS-profile fallback (no redirect handling).
 * @returns {Promise<{statusCode:number, headers:object, stream:import('node:stream').Readable, tlsProfile:string}>}
 */
export async function request(url, opts = {}) {
  const options = {
    // Honour the caller's method: a HEAD that silently became a GET made the
    // origin transfer a whole body just to read headers.
    method: opts.method ? String(opts.method).toUpperCase() : "GET",
    headers: { "User-Agent": DEFAULT_UA, "Accept-Encoding": "identity", ...(opts.headers || {}) },
    timeoutMs: opts.timeoutMs ?? 30_000,
    proxy: opts.proxy,
    insecure: opts.insecure,
    signal: opts.signal,
    body: opts.body,
  };
  let lastErr;
  for (const profile of TLS_PROFILES) {
    try {
      const res = await dispatchOnce(url, options, profile.opts);
      res.tlsProfile = profile.label;
      return res;
    } catch (err) {
      lastErr = err;
      if (!isTlsFailure(err) || options.signal?.aborted) break;
    }
  }
  throw lastErr;
}

/**
 * Turn a task's request context into the headers a request must carry.
 *
 * The queue, the API and the native host all accept referer/cookies/credentials
 * and persist them on the task, but nothing ever put them on the wire: a
 * download that needed a session cookie was sent unauthenticated and the origin
 * answered with a login page, which the engine would happily save as the file.
 * This is the single place that decides what goes on the wire, so every
 * strategy (segmented HTTP, streaming, probe, media fragments) agrees.
 *
 * Cookies are never returned for logging; callers must not echo this object.
 *
 * @param {{ headers?:object, referer?:string, cookies?:string,
 *           username?:string, password?:string, userAgent?:string }} task
 * @returns {object} headers to merge over the defaults
 */
export function buildRequestHeaders(task = {}) {
  const out = { ...(task.headers || {}) };
  const has = (name) => Object.keys(out).some((k) => k.toLowerCase() === name);
  if (task.referer && !has("referer")) out.Referer = task.referer;
  if (task.cookies && !has("cookie")) out.Cookie = task.cookies;
  if (task.userAgent && !has("user-agent")) out["User-Agent"] = task.userAgent;
  // Explicit credentials become a Basic header; the FTP path uses them directly.
  if (task.username && task.password && !has("authorization")) {
    out.Authorization = "Basic " + Buffer.from(task.username + ":" + task.password, "utf8").toString("base64");
  }
  return out;
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date. */
export function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(300000, seconds * 1000);
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, Math.min(300000, when - Date.now()));
  return 0;
}

/** Drain and release a response we are not going to read. */
/**
 * Release a response we are not going to read.
 *
 * This used to drain the body with resume(). Draining is not free — it waits
 * for the origin to finish sending, which on a large resource means the whole
 * file crosses the network before the caller proceeds. Destroying the stream
 * instead tells the origin to stop, which is what "discard" should mean.
 */
export async function discard(res) {
  try {
    if (!res.stream) return;
    try { res.stream._detachBodyAbort?.(); } catch { /* best effort */ }
    if (typeof res.stream.on === "function" && res.stream.listenerCount("error") === 0) {
      res.stream.on("error", () => {});
    }
    // Stop reading immediately; do not wait for an end that may never come.
    res.stream.destroy();
    res.socket?.destroy?.();
  } catch { /* the socket is going away regardless */ }
}

/**
 * Headers that carry a credential and must never follow a redirect to a
 * different origin.
 *
 * `Authorization` and `Cookie` are the obvious two. `Proxy-Authorization`
 * belongs to the hop to the proxy, not to the origin at all, so it is included
 * for the same reason. The rest are common private spellings of the same idea
 * (an API key or a bearer token in a custom header); a download manager that
 * accepts `-H "X-Api-Key: ..."` must not hand that header to whatever host the
 * origin redirects to.
 */
export const CREDENTIAL_HEADERS = Object.freeze([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
  "x-amz-security-token",
  "x-goog-api-key",
]);

/**
 * Do two URLs share an origin? Scheme, host and effective port must all match.
 *
 * The port is the *effective* one: https://a/ and https://a:443/ are the same
 * origin, and http://a:8080/ and http://a:9090/ are not.
 */
export function sameOrigin(a, b) {
  let left, right;
  try { left = new URL(a); } catch { return false; }
  try { right = new URL(b); } catch { return false; }
  const portOf = (u) => u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
  return left.protocol === right.protocol
    && left.hostname.toLowerCase() === right.hostname.toLowerCase()
    && portOf(left) === portOf(right);
}

/**
 * Drop credential headers from a header bag.
 * @returns {{headers:object, removed:string[]}} the surviving headers and what was removed
 */
export function stripCredentialHeaders(headers) {
  const removed = [];
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (CREDENTIAL_HEADERS.includes(name.toLowerCase())) removed.push(name);
    else out[name] = value;
  }
  return { headers: out, removed };
}

/**
 * Reduce a Referer header to its origin (scheme://host[:port]) for a redirect
 * hop that leaves the origin the request started from.
 *
 * Why keep it at all, and why trim it: the web convention for this is the
 * browser-default referrer policy `strict-origin-when-cross-origin` — a
 * cross-origin request still carries a Referer, but only the origin, never
 * the path or query. The full URL can hold exactly what credentials protect
 * (session ids in the query, private folder names in the path), and the host
 * at the other end of a redirect was chosen by the origin, not by the user,
 * so it receives what a browser would send and nothing more. A Referer that
 * cannot be parsed into a URL is dropped outright instead of forwarded: it
 * cannot be downgraded, and passing it through unchanged would leak what
 * this policy exists to hide.
 *
 * @param {object} headers the header bag about to travel to the next hop
 * @returns {{headers:object, changed:boolean}} the bag to send on, and
 *          whether the Referer differed (an untouched bag is reused as-is)
 */
function refererOriginOnly(headers) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === "referer");
  if (!key) return { headers, changed: false };
  let origin = "";
  try { origin = new URL(String(headers[key])).origin; } catch { /* unparseable */ }
  const out = { ...headers };
  if (!origin || origin === "null") delete out[key];
  else out[key] = origin;
  return { headers: out, changed: out[key] !== headers[key] };
}

/**
 * Request with redirect following.
 *
 * Redirect bodies are discarded so the underlying socket is released instead
 * of leaking until GC, and credentials are dropped the moment the chain leaves
 * the origin they were granted for: an HTTP redirect is exactly the shape of an
 * open-redirect, and forwarding a session cookie to a host that merely answered
 * 302 hands an attacker the credential the user never gave them. The Referer is
 * treated the way a browser's default policy treats it: on a hop that leaves
 * the origin it is reduced to its origin (`strict-origin-when-cross-origin`),
 * so a foreign host learns where the download came from, not the URL of the
 * page it came from.
 *
 * @returns {Promise<{statusCode:number, headers:object, stream:any, finalUrl:string, redirects:string[], tlsProfile:string, strippedHeaders:string[]}>}
 */
export async function requestFollow(url, opts = {}) {
  const maxRedirects = opts.maxRedirects ?? 10;
  const redirects = [];
  /** Every credential header removed along the way, for the caller to log. */
  const strippedHeaders = [];
  let current = url;
  // The origin the caller actually asked for. Every later hop is compared
  // against this, so a chain that leaves and comes back still does not regain
  // credentials it was stripped of.
  const credentialOrigin = url;
  let hopOpts = opts;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await request(current, hopOpts);
    const { statusCode } = res;
    if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
      await discard(res);
      redirects.push(`${statusCode} ${current} -> ${res.headers.location}`);
      const next = new URL(res.headers.location, current).toString();
      // Leaving the origin: credentials do not travel with the request, and
      // the Referer is cut back to its origin, the way a browser's default
      // strict-origin-when-cross-origin policy treats a cross-origin hop
      // (see refererOriginOnly for why it is trimmed, not dropped).
      if (!sameOrigin(credentialOrigin, next) && hopOpts.headers) {
        const { headers, removed } = stripCredentialHeaders(hopOpts.headers);
        const referer = refererOriginOnly(headers);
        if (removed.length || referer.changed) {
          for (const name of removed) if (!strippedHeaders.includes(name)) strippedHeaders.push(name);
          hopOpts = { ...hopOpts, headers: referer.headers };
        }
      }
      current = next;
      continue;
    }
    if (statusCode >= 400) {
      // An auth-bound CDN answers 401/403 to the very credential stripping the
      // cross-origin rule performed. GitHub is the canonical case: request the
      // release hop WITH a session cookie and it redirects to
      // objects.githubusercontent.com, whose signed URL then *requires* the
      // session — so the cookie-less follow-up is refused. The way out is to
      // replay the whole chain anonymously: without the credential on the
      // first hop the origin issues an anonymous-friendly target instead
      // (release-assets.githubusercontent.com). One retry, only when this
      // chain actually stripped something, never on the first hop itself.
      if ((statusCode === 401 || statusCode === 403) &&
          strippedHeaders.length > 0 && hop > 0 && !opts._anonRetry && opts.headers) {
        await discard(res);
        const anon = stripCredentialHeaders(opts.headers).headers;
        const replayed = await requestFollow(url, { ...opts, headers: anon, _anonRetry: true });
        // Keep the audit trail: what this chain stripped before the replay
        // belongs to the caller's view of the transfer, not to the inner call.
        replayed.strippedHeaders = [...new Set([...strippedHeaders, ...replayed.strippedHeaders])];
        return replayed;
      }
      const err = new HttpStatusError(statusCode, res.statusMessage, current, {
        retryAfterMs: parseRetryAfter(res.headers["retry-after"]),
      });
      await discard(res);
      throw err;
    }
    // From here the caller owns the stream. A late socket error must surface
    // through the async iterator, not as an unhandled 'error' event, so add a
    // guarded handler that only swallows the case where nobody is listening.
    if (res.stream && typeof res.stream.on === "function" && res.stream.listenerCount("error") === 0) {
      res.stream.on("error", () => {});
    }
    return { ...res, finalUrl: current, redirects, strippedHeaders };
  }
  throw new Error(`too many redirects (${maxRedirects}) starting at ${url}`);
}

/**
 * Read a whole response body with a hard byte ceiling.
 *
 * An optional `limiter` (from ./rate.mjs) is applied inside the read loop, so a
 * throttled transfer pulls from the socket only as fast as the bucket allows.
 * Waiting *after* buffering the body would move every byte at line speed and
 * then pause, which is not a bandwidth limit — it is a bandwidth limit plus an
 * unbounded memory spike.
 *
 * @param {{stream:any}} res
 * @param {number} limit          hard ceiling in bytes
 * @param {{limiter?:{take:(n:number,s?:AbortSignal)=>Promise<void>}, signal?:AbortSignal, onBytes?:(n:number)=>void}} [opts]
 */
export async function readBody(res, limit = 8 * 1024 * 1024, opts = {}) {
  const { limiter, signal, onBytes } = opts;
  const chunks = [];
  let total = 0;
  // A body that stalls between chunks must still fail the instant the caller
  // cancels. Relying on the next chunk (or on the transport noticing) made a
  // cancel wait until the origin sent something. This listener rejects the
  // pending `next()` by destroying the stream, which ends the iterator at once.
  const onAbort = () => { try { res.stream.destroy?.(abortError()); } catch { /* gone */ } };
  if (signal) {
    if (signal.aborted) { onAbort(); throw abortError(); }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    for await (const chunk of res.stream) {
      if (signal?.aborted) throw abortError();
      total += chunk.length;
      if (total > limit) throw new Error(`response body exceeds ${limit} bytes`);
      if (limiter) await limiter.take(chunk.length, signal);
      if (signal?.aborted) throw abortError();
      chunks.push(chunk);
      onBytes?.(chunk.length);
    }
  } catch (err) {
    // A destroyed stream surfaces as a generic error; report the cancellation.
    if (signal?.aborted) throw abortError();
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (signal?.aborted) throw abortError();
  return Buffer.concat(chunks);
}

/**
 * Stream a whole response body into an ALREADY-OPEN file handle, chunk by
 * chunk, and return the number of bytes written.
 *
 * readBody() has to hold the entire body in memory, so its byte cap doubled
 * as the memory ceiling: the media paths used it with 64/128 MiB caps, which
 * made every fragment larger than the cap fail outright and pinned peak
 * memory at (fragments in flight) x (cap). Here each chunk goes to disk as it
 * arrives, so memory use is one chunk per in-flight response regardless of
 * the fragment size.
 *
 * The handle belongs to the caller and is never closed here: a media
 * downloader streams its init segment into the output file it is assembling
 * and keeps writing after this returns. `position` says where the body should
 * land — an explicit offset, or null (the default) for "wherever the handle's
 * own position currently is", i.e. append. With an explicit position the
 * caller can place a fragment in the middle of a larger artefact.
 *
 * `limiter` (from ./rate.mjs) and `signal` mirror readBody(): the bucket is
 * spent BEFORE the chunk is written, so a throttled transfer pulls from the
 * socket only as fast as the bucket allows, and a stalled body fails the
 * moment the caller cancels instead of waiting for the next chunk.
 *
 * The byte cap survives only as a FUSE against a runaway or misdirected
 * response — a wrong URL that streams for ever would otherwise fill the disk.
 * It is deliberately relaxed to 1 GiB: with the body going straight to disk
 * the cap no longer bounds memory, and the old 8/64/128 MiB values (sensible
 * only when they doubled as the memory ceiling) rejected legitimate
 * large-segment downloads. Pass an explicit `limit` to bound a known-small
 * resource.
 *
 * On any error (limit exceeded, cancelled, transport reset mid-body) the
 * bytes already written stay on disk; the caller decides what they mean. The
 * media caller treats a fragment as finished only when a completion marker
 * beside the file says so, so an abandoned partial can never be mistaken for
 * a complete one.
 *
 * @param {{stream:any}} res
 * @param {import("node:fs/promises").FileHandle} handle opened for writing
 * @param {{position?:number|null, limit?:number,
 *          limiter?:{take:(n:number,s?:AbortSignal)=>Promise<void>},
 *          signal?:AbortSignal, onBytes?:(n:number)=>void}} [opts]
 * @returns {Promise<number>} bytes written
 */
export async function readBodyToFile(res, handle, opts = {}) {
  const { limiter, signal, onBytes } = opts;
  const position = opts.position ?? null;
  const limit = opts.limit ?? 1024 * 1024 * 1024;   // fuse only, see above
  let written = 0;
  // Same contract as readBody(): destroy the stream on abort so a pending
  // `next()` in the async iterator rejects immediately instead of waiting for
  // the origin to send something.
  const onAbort = () => { try { res.stream.destroy?.(abortError()); } catch { /* gone */ } };
  if (signal) {
    if (signal.aborted) { onAbort(); throw abortError(); }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    for await (const chunk of res.stream) {
      if (signal?.aborted) throw abortError();
      if (written + chunk.length > limit) throw new Error(`response body exceeds ${limit} bytes`);
      if (limiter) await limiter.take(chunk.length, signal);
      if (signal?.aborted) throw abortError();
      await handle.write(chunk, 0, chunk.length, position === null ? null : position + written);
      written += chunk.length;
      onBytes?.(chunk.length);
    }
  } catch (err) {
    if (signal?.aborted) throw abortError();
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (signal?.aborted) throw abortError();
  return written;
}
