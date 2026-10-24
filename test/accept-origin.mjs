// Configurable origin server for the acceptance suite.
//
// Each acceptance scenario needs an origin that misbehaves in one specific,
// reproducible way: a server that ignores Range, one that redirects, one that
// fails the first N requests, one that caps its own bandwidth. This module
// builds those on demand from a scenario descriptor, so the suite never depends
// on an external site being up or behaving a particular way.
//
// Every route is deterministic: given the same scenario and the same seed, the
// bytes served and the failure schedule are identical on every run.

import http from "node:http";
import { createHash } from "node:crypto";

/** Deterministic pseudo-random byte payload, so hashes are reproducible. */
export function payloadFor(size, seed = 1) {
  const buf = Buffer.alloc(size);
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < size; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    buf[i] = x >>> 24;
  }
  return buf;
}

export function sha256Of(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * A scenario describes one origin's behaviour.
 *
 * @typedef {object} Scenario
 * @property {string}  name
 * @property {number}  size          payload size in bytes
 * @property {number}  [seed]
 * @property {boolean} [supportsRange] advertise and honour byte ranges
 * @property {boolean} [liesAboutRange] advertise Range, then answer 200 anyway
 * @property {string}  [redirects]     number of 302 hops before serving
 * @property {object}  [requiredHeaders] headers a request must carry, else 403
 * @property {number}  [failFirst]     fail this many requests, then succeed
 * @property {number}  [failRangedFirst] fail this many RANGED requests (transfer phase only)
 * @property {number}  [failStatus]    status for those failures (default 503)
 * @property {number}  [bytesPerSecond] throttle the body to this rate
 * @property {number}  [stallAfterBytes] send this many bytes then hang
 * @property {number}  [dropAfterBytes]  send this many bytes then destroy the socket
 * @property {boolean} [digest]        publish a Content-Digest header
 * @property {string}  [filename]      Content-Disposition filename
 */

/**
 * Start a server implementing \`scenario\`.
 *
 * @param {Scenario} scenario
 * @returns {Promise<{url:string, origin:string, state:object, close:Function, reset:Function}>}
 */
export async function startScenarioServer(scenario) {
  const body = payloadFor(scenario.size, scenario.seed ?? 1);
  const digest = sha256Of(body);
  const state = {
    requests: 0,
    rangedRequests: 0,
    failures: 0,
    redirectsServed: 0,
    headerRejections: 0,
    bytesServed: 0,
    /** Bytes actually flushed to the socket (not what we intended to send). */
    bytesDelivered: 0,
    rangeRequestsSeen: [],
  };

  const server = http.createServer((req, res) => {
    state.requests++;
    // Measure delivered bytes rather than intended ones: the probe issues a
    // header-only GET and discards the body, so counting what we meant to send
    // would overstate the transfer.
    // A request counts toward transfer bytes when it carries a Range header
    // (a real segment fetch) or when the engine is deliberately reading the
    // whole file (single-stream mode). The probe's header-only GET carries
    // neither and is excluded.
    let countDelivered = Boolean(req.headers.range);
    let delivered = 0;
    const origWrite = res.write.bind(res);
    res.write = (chunk, ...rest) => {
      const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      delivered += len;
      if (countDelivered) state.bytesDelivered += len;
      return origWrite(chunk, ...rest);
    };
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    // ---- redirect chain -------------------------------------------------
    const hop = Number(url.searchParams.get("hop") || 0);
    const hops = scenario.redirects ?? 0;
    if (path === "/redirect" && hop < hops) {
      state.redirectsServed++;
      res.writeHead(302, { Location: "/redirect?hop=" + (hop + 1) });
      res.end();
      return;
    }
    if (path === "/redirect" && hop >= hops) {
      // fall through and serve from here
    }

    // ---- required headers ----------------------------------------------
    if (scenario.requiredHeaders) {
      for (const [k, v] of Object.entries(scenario.requiredHeaders)) {
        if (req.headers[k.toLowerCase()] !== v) {
          state.headerRejections++;
          res.writeHead(403, { "Content-Type": "text/plain", "Content-Length": "13" });
          res.end("header denied");
          return;
        }
      }
    }

    // ---- scheduled failures --------------------------------------------
    // failRangedFirst targets the transfer phase specifically. Failing every
    // request instead would be absorbed by the probe's own retry, so the
    // engine's retry path would never be exercised.
    const isRanged = Boolean(req.headers.range);
    const failBudget = scenario.failRangedFirst !== undefined
      ? (isRanged && state.failures < scenario.failRangedFirst)
      : (scenario.failFirst && state.failures < scenario.failFirst);
    if (failBudget) {
      state.failures++;
      const status = scenario.failStatus ?? 503;
      const headers = { "Content-Type": "text/plain", "Content-Length": "7" };
      // A 429 may carry Retry-After; keep it short so the suite stays fast.
      if (status === 429) headers["Retry-After"] = "1";
      res.writeHead(status, headers);
      res.end("failure");
      return;
    }

    // ---- range handling -------------------------------------------------
    const rangeHeader = req.headers.range;
    let start = 0;
    let end = body.length - 1;
    let partial = false;

    // A lying origin advertises support (Accept-Ranges) but answers 200 to
    // every ranged request. That is what actually triggers the engine's
    // single-stream fallback; simply omitting the header does not, because the
    // probe then reports no range support up front and no fallback is needed.
    if (scenario.liesAboutRange) {
      if (rangeHeader) state.rangedRequests++;
      partial = false;
      start = 0;
      end = body.length - 1;
    } else if (scenario.supportsRange !== false) {
      const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader || "");
      if (m) {
        state.rangedRequests++;
        const s = m[1] === "" ? null : Number(m[1]);
        const e = m[2] === "" ? null : Number(m[2]);
        if (s !== null && e !== null) { start = s; end = Math.min(e, body.length - 1); }
        else if (s !== null) { start = s; end = body.length - 1; }
        else { start = Math.max(0, body.length - Number(e)); end = body.length - 1; }
        if (start > end || start >= body.length) {
          res.writeHead(416, { "Content-Range": "bytes */" + body.length, "Content-Length": "0" });
          res.end();
          return;
        }
        partial = true;
        state.rangeRequestsSeen.push([start, end]);
      }
    }

    const slice = body.subarray(start, end + 1);
    const isHead = req.method === "HEAD";
    const headers = {
      "Content-Type": scenario.contentType || "application/octet-stream",
      "Content-Length": slice.length,
      "ETag": '"' + digest.slice(0, 16) + '"',
    };
    if (scenario.supportsRange !== false) headers["Accept-Ranges"] = "bytes";
    if (scenario.digest) headers["Content-Digest"] = "sha-256=:" + createHash("sha256").update(slice).digest("base64") + ":";
    if (scenario.filename) headers["Content-Disposition"] = 'attachment; filename="' + scenario.filename + '"';
    if (partial) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + body.length;

    // HEAD carries no body, exactly as a real server would answer it.
    if (isHead) {
      res.writeHead(partial ? 206 : 200, headers);
      res.end();
      return;
    }

    // ---- hard drop ------------------------------------------------------
    if (scenario.dropAfterBytes) {
      res.writeHead(partial ? 206 : 200, headers);
      res.write(slice.subarray(0, Math.min(scenario.dropAfterBytes, slice.length)));
      state.bytesServed += Math.min(scenario.dropAfterBytes, slice.length);
      setTimeout(() => res.destroy(), 10);
      return;
    }

    // ---- stall ----------------------------------------------------------
    if (scenario.stallAfterBytes) {
      res.writeHead(partial ? 206 : 200, headers);
      res.write(slice.subarray(0, Math.min(scenario.stallAfterBytes, slice.length)));
      state.bytesServed += Math.min(scenario.stallAfterBytes, slice.length);
      return;   // never end: the client must notice and recover
    }

    // ---- throttled or plain body ----------------------------------------
    res.writeHead(partial ? 206 : 200, headers);
    if (!partial) countDelivered = true;   // whole-file read is real transfer
    if (scenario.bytesPerSecond) {
      const chunk = Math.max(1024, Math.floor(scenario.bytesPerSecond / 20));
      let i = 0;
      const tick = () => {
        if (i >= slice.length) { res.end(); return; }
        if (res.destroyed) return;
        res.write(slice.subarray(i, i + chunk));
        state.bytesServed += Math.min(chunk, slice.length - i);
        i += chunk;
        setTimeout(tick, 50);
      };
      tick();
    } else {
      res.end(slice);
      state.bytesServed += slice.length;
    }
  });

  server.on("connection", (socket) => socket.on("error", () => {}));

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const origin = "http://127.0.0.1:" + port;

  return {
    url: origin + (scenario.redirects ? "/redirect" : "/file"),
    origin,
    state,
    expectedSha256: digest,
    expectedBytes: body.length,
    body,
    reset() {
      state.requests = 0; state.rangedRequests = 0; state.failures = 0;
      state.redirectsServed = 0; state.headerRejections = 0; state.bytesServed = 0;
      state.rangeRequestsSeen.length = 0;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => { server.close(() => r(undefined)); setTimeout(() => r(undefined), 2000); });
    },
  };
}
