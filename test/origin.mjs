// Controlled test origin. Each route exercises one behaviour the engine must
// handle, so tests never depend on the public internet.
//
//   /range/<size>     supports Range
//   /norange/<size>   ignores Range, always 200 from byte 0
//   /flaky/<size>     drops the socket mid-body for the first N attempts
//   /short/<size>     closes the body early once, then serves correctly
//   /etag/<size>      supports Range and exposes a strong ETag
//   /slow/<size>      trickles the body to exercise rate limiting
//   /throttle/<size>/<chunk>/<delayMs>  ranged + rate-limited + stable ETag
//   /auth/<size>      requires Basic auth
//   /hls/<count>      a master + media m3u8 pair with <count> segments
//   /seg/<n>          one HLS segment body
//   /disposition/<n>  Content-Disposition filename
//   /redirect/<n>     two redirects before the real body

import http from "node:http";
import { createHash, randomBytes } from "node:crypto";

const bufCache = new Map();
function payload(size) {
  if (!bufCache.has(size)) bufCache.set(size, randomBytes(size));
  return bufCache.get(size);
}

/**
 * The exact bytes a /range/<size> route serves, so a test can verify a file
 * byte-for-byte. The payload is cached, so repeated calls return the same
 * buffer the origin used.
 */
export function payloadFor(size) {
  return payload(size);
}

export function startOrigin({ port = 0, dropAfterAttempts = 2 } = {}) {
  const attempts = new Map();
  const rangedRequests = new Map();

  // CDN drift fixture: each connection is pinned to a backend, and the two
  // backends disagree. A multi-connection download stitches them together.
  let driftConns = 0;
  /** Backend index assigned per socket, so two connections always disagree. */
  const driftBackend = new WeakMap();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    if (p.startsWith("/throttle/")) {
      // Supports Range and trickles at a fixed rate, so a test can interrupt
      // a segmented transfer reliably instead of racing a fast local server.
      const parts = p.split("/");
      const size = Number(parts[2]) || 4 * 1024 * 1024;
      const chunkBytes = Number(parts[3]) || 32 * 1024;
      const delayMs = Number(parts[4]) || 8;
      const body = payload(size);
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      const slice = body.subarray(start, end + 1);
      const headers = {
        "Content-Type": "application/octet-stream",
        "Content-Length": slice.length,
        "Accept-Ranges": "bytes",
        // A stable ETag: the payload is deterministic, so a resume must never
        // be misread as a different revision.
        "ETag": '"' + createHash("sha256").update(body).digest("hex").slice(0, 32) + '"',
      };
      if (m) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
      res.writeHead(m ? 206 : 200, headers);
      let i = 0;
      const tick = () => {
        if (i >= slice.length) { res.end(); return; }
        if (res.destroyed) return;
        res.write(slice.subarray(i, i + chunkBytes));
        i += chunkBytes;
        setTimeout(tick, delayMs);
      };
      tick();
      return;
    }
    if (p.startsWith("/chunked/")) {
      // A chunked response declares no length, so the client cannot plan
      // byte ranges. Used to exercise the streaming path.
      const size = Number(p.split("/")[2]) || 65536;
      const body = payload(size);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Transfer-Encoding": "chunked" });
      let i = 0;
      const chunk = 16 * 1024;
      const tick = () => {
        if (i >= body.length) { res.end(); return; }
        if (res.destroyed) return;
        res.write(body.subarray(i, i + chunk));
        i += chunk;
        setTimeout(tick, 5);
      };
      tick();
      return;
    }
    // --- HLS ---------------------------------------------------------------
    if (p === "/hls/master.m3u8") {
      const count = Number(url.searchParams.get("count") || 4);
      const body = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
        "media.m3u8?count=" + count,
        '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
        "media720.m3u8?count=" + count,
      ].join("\n");
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (p === "/hls/media.m3u8" || p === "/hls/media720.m3u8") {
      const count = Number(url.searchParams.get("count") || 4);
      const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:4", "#EXT-X-MEDIA-SEQUENCE:0"];
      for (let i = 0; i < count; i++) {
        lines.push("#EXTINF:4.0,");
        lines.push("/seg/" + i);
      }
      lines.push("#EXT-X-ENDLIST");
      const body = lines.join("\n");
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (p.startsWith("/seg/")) {
      const n = Number(p.slice(5)) || 0;
      const body = Buffer.alloc(64 * 1024, 0x41 + (n % 26));
      res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": body.length });
      res.end(body);
      return;
    }

    // --- pages for the grabber and sniffer ---------------------------------
    if (p === "/page") {
      const html = [
        "<!doctype html><html><head>",
        '<link rel="stylesheet" href="/assets/site.css">',
        '<script src="/assets/app.js"></script>',
        "</head><body>",
        '<a href="/files/report.pdf">report</a>',
        '<a href="/files/archive.zip">archive</a>',
        '<a href="#fragment">skip me</a>',
        '<a href="mailto:x@y.z">mail</a>',
        '<img src="/images/photo.jpg">',
        '<video src="/media/clip.mp4" poster="/images/poster.png"></video>',
        "<script>",
        'var cfg = { hls: "/stream/master.m3u8?count=3", dash: "/stream/manifest.mpd" };',
        "</script>",
        "</body></html>",
      ].join("");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
      res.end(html);
      return;
    }
    // --- static assets referenced by the test page -------------------------
    if (p === "/media/clip.mp4" || p === "/images/photo.jpg" || p === "/files/report.pdf" || p === "/files/archive.zip" || p === "/assets/site.css" || p === "/assets/app.js") {
      const asset = Buffer.alloc(48 * 1024, 0x42);
      res.writeHead(200, {
        "Content-Type": p.endsWith(".mp4") ? "video/mp4" : p.endsWith(".jpg") ? "image/jpeg" : "application/octet-stream",
        "Content-Length": asset.length,
        "Accept-Ranges": "bytes",
      });
      res.end(asset);
      return;
    }

    if (p === "/stream/master.m3u8") {
      const count = Number(url.searchParams.get("count") || 3);
      const body = "#EXTM3U" + String.fromCharCode(10) +
        "#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720" + String.fromCharCode(10) +
        "/hls/media.m3u8?count=" + count + String.fromCharCode(10);
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (p === "/dash3/manifest.mpd") {
      // ffmpeg-style manifest: SegmentTimeline instead of a duration attribute,
      // and a templated initialization name.
      const xml = '<MPD type="static" mediaPresentationDuration="PT8S"><Period>' +
        '<AdaptationSet mimeType="video/mp4">' +
        '<Representation id="0" bandwidth="102256">' +
        '<SegmentTemplate timescale="15360" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number$.m4s" startNumber="1">' +
        '<SegmentTimeline><S t="0" d="61440"/><S d="61440"/></SegmentTimeline>' +
        "</SegmentTemplate></Representation></AdaptationSet>" +
        '<AdaptationSet mimeType="audio/mp4">' +
        '<Representation id="1" bandwidth="69000">' +
        '<SegmentTemplate timescale="44100" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number$.m4s" startNumber="1">' +
        '<SegmentTimeline><S t="0" d="88064"/><S d="88336"/></SegmentTimeline>' +
        "</SegmentTemplate></Representation></AdaptationSet>" +
        "</Period></MPD>";
      res.writeHead(200, { "Content-Type": "application/dash+xml", "Content-Length": Buffer.byteLength(xml) });
      res.end(xml);
      return;
    }
    if (/^\/dash3\/(init|chunk)-[01](-[0-9]+)?\.m4s$/.test(p)) {
      const body = Buffer.alloc(16 * 1024, p.includes("chunk-0") || p.includes("init-0") ? 0x56 : 0x41);
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": body.length });
      res.end(body);
      return;
    }
    if (p === "/dash2/manifest.mpd") {
      const xml = '<MPD type="static" mediaPresentationDuration="PT6S"><Period>' +
        '<AdaptationSet mimeType="video/mp4">' +
        '<Representation id="v1" bandwidth="2000000" width="1920" height="1080">' +
        '<SegmentTemplate timescale="1" duration="3" media="v-$Number$.m4s" initialization="v-init.mp4"/>' +
        "</Representation></AdaptationSet>" +
        '<AdaptationSet mimeType="audio/mp4">' +
        '<Representation id="a1" bandwidth="128000">' +
        '<SegmentTemplate timescale="1" duration="3" media="a-$Number$.m4s" initialization="a-init.mp4"/>' +
        "</Representation></AdaptationSet>" +
        "</Period></MPD>";
      res.writeHead(200, { "Content-Type": "application/dash+xml", "Content-Length": Buffer.byteLength(xml) });
      res.end(xml);
      return;
    }
    if (/^\/dash2\/(v|a)-(-?init|\d+)\.(m4s|mp4)$/.test(p) || /^\/(v|a)-(-?init|\d+)\.(m4s|mp4)$/.test(p)) {
      const isVideo = /\/(v)-/.test(p);
      const body = Buffer.alloc(32 * 1024, isVideo ? 0x56 : 0x41);
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": body.length });
      res.end(body);
      return;
    }
    if (p === "/stream/manifest.mpd") {
      const xml = '<MPD type="static" mediaPresentationDuration="PT12S"><Period><AdaptationSet mimeType="video/mp4">' +
        '<Representation id="v1" bandwidth="1500000" width="1280" height="720">' +
        '<SegmentTemplate timescale="1" duration="4" media="seg-$Number$.m4s" initialization="init.mp4"/>' +
        "</Representation></AdaptationSet></Period></MPD>";
      res.writeHead(200, { "Content-Type": "application/dash+xml", "Content-Length": Buffer.byteLength(xml) });
      res.end(xml);
      return;
    }

    // --- integrity fixtures -------------------------------------------------
    if (p.startsWith("/drift/")) {
      const size = Number(p.split("/")[2]) || (2 * 1024 * 1024);
      // Deterministic drift: ranges in the first half come from revision A,
      // the second half from revision B. Keying on the requested offset keeps
      // the fixture independent of connection order, so other tests opening
      // sockets to this origin cannot change the outcome.
      const mEarly = /bytes=(\d+)-/.exec(req.headers.range || "");
      const off = mEarly ? Number(mEarly[1]) : 0;
      const backend = off < size / 2 ? 0 : 1;
      const body = Buffer.alloc(size);
      for (let i = 0; i < size; i++) body[i] = ((i * 7 + 13) & 0xff) ^ (backend ? 0xff : 0);
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
      if (!m) {
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length, "Accept-Ranges": "bytes" });
        res.end(body);
        return;
      }
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      const slice = body.subarray(start, end + 1);
      res.writeHead(206, {
        "Content-Type": "application/octet-stream",
        "Content-Range": "bytes " + start + "-" + end + "/" + size,
        "Content-Length": slice.length,
      });
      res.end(slice);
      return;
    }

    if (p.startsWith("/digest/")) {
      const size = Number(p.split("/")[2]) || 65536;
      const body = Buffer.alloc(size, 0x5a);
      const algo = url.searchParams.get("algo") || "sha256";
      const corrupt = url.searchParams.get("corrupt") === "1";
      const real = createHash(algo).update(body).digest("base64");
      const fake = createHash(algo).update(Buffer.alloc(8, 0)).digest("base64");
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": body.length,
        "Accept-Ranges": "bytes",
        "Content-Digest": algo.replace("sha256", "sha-256") + "=:" + (corrupt ? fake : real) + ":",
      });
      res.end(body);
      return;
    }

    // --- objects -----------------------------------------------------------
    const m = /^\/(range|norange|flaky|short|etag|slow|auth|disposition|redirect)\/(\d+)$/.exec(p);
    if (!m) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    const mode = m[1];
    const body = payload(Number(m[2]));
    const total = body.length;

    if (mode === "auth") {
      const header = req.headers.authorization || "";
      const expected = "Basic " + Buffer.from("user:pass").toString("base64");
      if (header !== expected) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"', "Content-Length": "0" });
        res.end();
        return;
      }
    }

    if (mode === "redirect") {
      const hop = url.searchParams.get("hop");
      if (hop !== "2") {
        // Two hops, so the client must follow more than one redirect.
        const next = hop === "1" ? "/redirect/" + total + "?hop=2" : "/redirect/" + total + "?hop=1";
        res.writeHead(302, { Location: next });
        res.end();
        return;
      }
    }

    const rangeHeader = req.headers.range;
    const useRange = mode !== "norange";

    const headers = { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" };
    if (mode === "etag") headers.ETag = '"' + createHash("sha256").update(body).digest("hex").slice(0, 32) + '"';
    if (mode === "disposition") headers["Content-Disposition"] = 'attachment; filename="nice-name.bin"';
    if (useRange) headers["Accept-Ranges"] = "bytes";

    if (useRange && rangeHeader) {
      rangedRequests.set(p, (rangedRequests.get(p) || 0) + 1);
      const rm = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
      if (rm) {
        const start = Number(rm[1]);
        const end = rm[2] ? Math.min(Number(rm[2]), total - 1) : total - 1;
        if (start >= total) {
          res.writeHead(416, { "Content-Range": "bytes */" + total });
          res.end();
          return;
        }
        const slice = body.subarray(start, end + 1);
        res.writeHead(206, Object.assign({}, headers, {
          "Content-Range": "bytes " + start + "-" + end + "/" + total,
          "Content-Length": String(slice.length),
        }));

        if (mode === "short") {
          const key = "short:" + start;
          const n = attempts.get(key) || 0;
          attempts.set(key, n + 1);
          if (n === 0) {
            res.write(slice.subarray(0, Math.floor(slice.length / 2)));
            setTimeout(() => res.destroy(), 30);
            return;
          }
        }
        if (mode === "flaky") {
          const key = "flaky:" + start;
          const n = attempts.get(key) || 0;
          if (n < dropAfterAttempts) {
            attempts.set(key, n + 1);
            res.write(slice.subarray(0, Math.max(1, Math.floor(slice.length / 3))));
            setTimeout(() => res.destroy(), 20);
            return;
          }
        }
        if (mode === "slow") {
          let i = 0;
          const chunkSize = 16 * 1024;
          const tick = () => {
            if (i >= slice.length) { res.end(); return; }
            res.write(slice.subarray(i, i + chunkSize));
            i += chunkSize;
            setTimeout(tick, 25);
          };
          tick();
          return;
        }
        res.end(slice);
        return;
      }
    }

    res.writeHead(200, Object.assign({}, headers, { "Content-Length": String(total) }));
    if (mode === "slow") {
      let i = 0;
      const chunkSize = 16 * 1024;
      const tick = () => {
        if (i >= total) { res.end(); return; }
        res.write(body.subarray(i, i + chunkSize));
        i += chunkSize;
        setTimeout(tick, 25);
      };
      tick();
      return;
    }
    res.end(body);
  });

  // Sockets are destroyed on purpose by the flaky/short routes; without a
  // handler those resets surface as unhandled 'error' events and kill the run.
  server.on("connection", (socket) => {
    driftConns++;
    // Alternate strictly by arrival order, independent of earlier tests.
    driftBackend.set(socket, driftConns % 2);
    socket.on("error", () => {});
  });
  server.on("clientError", (err, socket) => { try { socket.destroy(); } catch { /* gone */ } });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        port: server.address().port,
        origin: "http://127.0.0.1:" + server.address().port,
        attempts,
        rangedRequests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
