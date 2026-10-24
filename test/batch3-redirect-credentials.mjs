// Batch-3 regression (P-5): a redirect that leaves the origin must not carry
// credentials, and the Referer must follow the web convention on that hop.
//
// The defect this guards against (待修问题清单 P-5): a GitHub release download
// answers 302 to a signed objects.githubusercontent.com URL, and the request
// that followed the redirect still carried the browser session cookie —
// GitHub answers 401 to that, and beyond the breakage the forwarded cookie is
// a leak: the host behind a redirect was chosen by the origin, never by the
// user, so it must not receive credentials it was not granted.
//
// What is asserted here:
//   1. a two-level cross-host redirect chain from a local origin, driven
//      through the real downloader (engine path, not just the transport
//      primitive): the first hop receives the cookie, every second- and
//      third-hop request receives none, and the file still arrives
//      byte-for-byte;
//   2. a same-host redirect keeps the cookie and the full Referer;
//   3. a 302 across hosts must not carry Authorization on the second hop —
//      neither a literal header nor the Basic header the product builds from
//      username/password;
//   4. the Referer on a cross-host hop is reduced to its origin, the way a
//      browser's default strict-origin-when-cross-origin policy does, and
//      stays that way for the rest of the chain; a Referer that cannot be
//      parsed is dropped rather than forwarded;
//   5. a request that does not redirect keeps every header, and a redirect
//      chain never mutates the caller's own header object.
//
// Cross-host on loopback uses the two loopback literals as distinct host
// names — 127.0.0.1 and [::1] — so no DNS, no external interface, and the
// host comparison in net.mjs is exercised for real, not via a port trick.
//
// Everything runs against these local origins and an isolated throwaway
// DOWNLOADX_HOME, so no public network, no user Downloads, no
// %APPDATA%\downloadx, and never D:/IAM/downloadx-data.
//
// Usage: node test/batch3-redirect-credentials.mjs

import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** A deterministic body, so a byte-exact file comparison is meaningful. */
const makeBody = (len) => {
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
};

/**
 * One redirect hop. `redirects` maps a path to a Location (an absolute URL on
 * another hop, or a path on this server for the same-host case); any other
 * path serves `body`, with Range honoured so the engine's segmenting works.
 *
 * Every request that arrives is recorded, headers included, so tests assert
 * on what the wire actually carried.
 */
async function startHop(host, { redirects = {}, body = makeBody(1024) } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const pathname = req.url.split("?")[0];
    seen.push({ path: pathname, headers: { ...req.headers } });
    const location = redirects[pathname];
    if (location) {
      res.writeHead(302, { Location: location });
      res.end();
      return;
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      const slice = body.subarray(start, end + 1);
      res.writeHead(206, {
        "Content-Type": "application/octet-stream",
        "Content-Length": slice.length,
        "Content-Range": `bytes ${start}-${end}/${body.length}`,
        "Accept-Ranges": "bytes",
        ETag: '"p5-stable"',
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": body.length,
      "Accept-Ranges": "bytes",
      ETag: '"p5-stable"',
    });
    res.end(body);
  });
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, host, () => resolve());
  });
  const shown = host.includes(":") ? `[${host}]` : host;
  const base = `http://${shown}:${srv.address().port}`;
  return {
    base,
    host,
    seen,
    at: (p) => seen.find((s) => s.path === p) ?? null,
    all: (p) => seen.filter((s) => s.path === p),
    close: () => new Promise((resolve) => {
      srv.closeAllConnections?.();
      srv.close(() => resolve());
    }),
  };
}

async function main() {
  const suite = new Suite("batch3-redirect-credentials");
  const NL = String.fromCharCode(10);
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else if (r.kind === "skip") process.stdout.write("    SKIP  " + r.text + "  - " + r.reason + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  // The throwaway home must exist and be in the environment BEFORE any src
  // module is imported: paths are derived from DOWNLOADX_HOME at import time.
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b3-redirect-"));
  process.env.DOWNLOADX_HOME = home;
  const out = path.join(home, "out");
  await fsp.mkdir(out, { recursive: true });

  const hops = [];
  const hop = (host, opts) => {
    const p = startHop(host, opts);
    hops.push(p);
    return p;
  };

  try {
    const { requestFollow, readBody, buildRequestHeaders } = await import("../src/net.mjs");
    const { Config } = await import("../src/config.mjs");
    const { QueueManager } = await import("../src/queue.mjs");
    const { Downloader } = await import("../src/downloader.mjs");

    // A downloader wired like media-e2e does it: explicit config under the
    // throwaway home, nothing inherited from the machine.
    const freshDownloader = async (name, patch = {}) => {
      const cfg = new Config(path.join(home, name + ".config.json"));
      await cfg.load();
      await cfg.set({
        defaultDir: path.join(out, name),
        categorizeByType: false,
        maxConnections: 4,
        overwriteExisting: "overwrite",
        maxRetries: 2,
        retryBaseMs: 50,
        speedLimit: 0,
        insecure: false,
        proxy: "",
        proxyMode: "none",
        ...patch,
      });
      const queue = new QueueManager({ config: cfg });
      await queue.load();
      return new Downloader({ config: cfg, queue });
    };

    // =====================================================================
    // 1. Two-level cross-host redirect, engine path: no cookie from hop two
    //    on, and the download still succeeds
    // =====================================================================
    suite.group("two-level cross-host redirect (engine path)");

    const BODY = makeBody(64 * 1024);
    await suite.test("cookie reaches hop 1 only; hops 2 and 3 see none; the file arrives byte-exact", async () => {
      const third = await hop("127.0.0.1", { body: BODY });
      const second = await hop("::1", { redirects: { "/mid": third.base + "/file" } });
      const first = await hop("127.0.0.1", { redirects: { "/dl": second.base + "/mid" } });

      const downloader = await freshDownloader("two-level");
      const dir = path.join(out, "two-level");
      const result = await downloader.run({
        id: "two-level", url: first.base + "/dl", kind: "http", filename: "two-level.bin", dir,
        headers: { Cookie: "session=P5-SECRET-VALUE" },
        connections: 1, meta: {},
      });

      assert.equal(result.bytes, BODY.length, "the redirected body must be downloaded in full");
      const saved = await fsp.readFile(result.target);
      assert.equal(saved.length, BODY.length, "the published file size");
      assert.equal(sha256(saved), sha256(BODY), "the published bytes must be exactly what the final hop served");

      // Hop 1 is the origin the credentials were meant for: it gets them.
      const hop1 = first.all("/dl");
      assert.ok(hop1.length > 0, "the first hop must have been requested");
      for (const req of hop1) {
        assert.equal(req.headers.cookie, "session=P5-SECRET-VALUE",
          "the original origin must receive the cookie");
      }
      // Hop 2 is the first foreign host: no Cookie may cross the redirect.
      const hop2 = second.all("/mid");
      assert.ok(hop2.length > 0, "the second hop must have been requested");
      for (const req of hop2) {
        assert.equal(req.headers.cookie, undefined,
          "the second hop must not receive a Cookie header, got " + JSON.stringify(req.headers.cookie));
      }
      // Hop 3 returns to the 127.0.0.1 host string, but it is still not the
      // origin the credentials were granted for: they must not come back.
      const hop3 = third.all("/file");
      assert.ok(hop3.length > 0, "the third hop must have been requested");
      for (const req of hop3) {
        assert.equal(req.headers.cookie, undefined,
          "a redirect chain must not re-acquire the cookie it was stripped of");
      }
    });

    // =====================================================================
    // 2. Same-host redirect: cookie and full Referer stay
    // =====================================================================
    suite.group("same-host redirect keeps headers");

    await suite.test("a redirect within one host keeps Cookie and the full Referer", async () => {
      const same = await hop("127.0.0.1", { redirects: { "/s": "/s2" } });
      const res = await requestFollow(same.base + "/s", {
        headers: {
          Cookie: "session=KEEP-ME",
          Referer: "https://site.test/watch/page?q=1",
          "X-Trace-Id": "trace-9",
        },
      });
      await readBody(res);
      const hop2 = same.at("/s2");
      assert.ok(hop2, "the redirect target must have been requested");
      assert.equal(hop2.headers.cookie, "session=KEEP-ME", "a same-host hop must keep the Cookie");
      assert.equal(hop2.headers.referer, "https://site.test/watch/page?q=1",
        "a same-host hop must keep the full Referer (strict-origin-when-cross-origin sends the full URL same-origin)");
      assert.equal(hop2.headers["x-trace-id"], "trace-9", "ordinary headers must survive");
      assert.deepEqual(res.strippedHeaders, [], "nothing may be reported stripped on a same-host hop");
    });

    // =====================================================================
    // 3. 302 across hosts: no Authorization on the second hop
    // =====================================================================
    suite.group("302 across hosts drops Authorization");

    await suite.test("a literal Authorization header is stripped on the second hop", async () => {
      const target = await hop("::1", {});
      const origin = await hop("127.0.0.1", { redirects: { "/auth": target.base + "/end" } });
      const res = await requestFollow(origin.base + "/auth", {
        headers: { Authorization: "Bearer p5-bearer-token", "X-Trace-Id": "trace-a" },
      });
      await readBody(res);
      assert.equal(origin.at("/auth").headers.authorization, "Bearer p5-bearer-token",
        "the original origin must receive the Authorization header");
      const hop2 = target.at("/end");
      assert.ok(hop2, "the cross-host target must have been requested");
      assert.equal(hop2.headers.authorization, undefined,
        "the second hop must not receive Authorization, got " + JSON.stringify(hop2.headers.authorization));
      assert.equal(hop2.headers["x-trace-id"], "trace-a", "non-credential headers still travel");
      assert.deepEqual(res.strippedHeaders, ["Authorization"], "the removal must be reported to the caller");
    });

    await suite.test("the Basic header built from username/password is stripped too", async () => {
      const target = await hop("::1", {});
      const origin = await hop("127.0.0.1", { redirects: { "/basic": target.base + "/end" } });
      const built = buildRequestHeaders({ username: "p5-user", password: "p5-pass" });
      assert.ok(built.Authorization && built.Authorization.startsWith("Basic "),
        "buildRequestHeaders must produce the Basic Authorization header to strip");
      const res = await requestFollow(origin.base + "/basic", { headers: built });
      await readBody(res);
      const hop2 = target.at("/end");
      assert.ok(hop2, "the cross-host target must have been requested");
      assert.equal(hop2.headers.authorization, undefined,
        "Basic credentials must not cross the redirect, got " + JSON.stringify(hop2.headers.authorization));
    });

    // =====================================================================
    // 4. Referer on a cross-host hop: web convention
    // =====================================================================
    suite.group("Referer follows the web convention across hosts");

    await suite.test("a cross-host hop carries the Referer's origin only, for the whole chain", async () => {
      const third = await hop("127.0.0.1", {});
      const second = await hop("::1", { redirects: { "/mid": third.base + "/file" } });
      const first = await hop("127.0.0.1", { redirects: { "/ref": second.base + "/mid" } });
      const res = await requestFollow(first.base + "/ref", {
        headers: { Referer: "https://site.test/watch/page?q=secret" },
      });
      await readBody(res);
      assert.equal(first.at("/ref").headers.referer, "https://site.test/watch/page?q=secret",
        "the first hop keeps the full Referer the caller asked for");
      assert.equal(second.at("/mid").headers.referer, "https://site.test",
        "the second hop must receive the Referer's origin only (strict-origin-when-cross-origin), got " +
        JSON.stringify(second.at("/mid").headers.referer));
      assert.equal(third.at("/file").headers.referer, "https://site.test",
        "the downgrade must persist for the rest of the chain");
    });

    await suite.test("a Referer that cannot be parsed is dropped, not forwarded", async () => {
      const target = await hop("::1", {});
      const origin = await hop("127.0.0.1", { redirects: { "/badref": target.base + "/end" } });
      const res = await requestFollow(origin.base + "/badref", {
        headers: { Referer: "not a parseable url at all" },
      });
      await readBody(res);
      const hop2 = target.at("/end");
      assert.ok(hop2, "the cross-host target must have been requested");
      assert.equal(hop2.headers.referer, undefined,
        "an unparseable Referer must be dropped on the cross-host hop, got " + JSON.stringify(hop2.headers.referer));
    });

    // =====================================================================
    // 5. No redirect, no change: headers and the caller's bag stay intact
    // =====================================================================
    suite.group("non-redirect requests are untouched");

    await suite.test("a plain 200 request carries every header it was given", async () => {
      const plain = await hop("127.0.0.1", {});
      const res = await requestFollow(plain.base + "/direct", {
        headers: {
          Cookie: "session=DIRECT",
          Authorization: "Bearer direct-token",
          Referer: "https://site.test/watch/page?q=1",
          "X-Trace-Id": "trace-d",
        },
      });
      await readBody(res);
      const got = plain.at("/direct");
      assert.ok(got, "the request must have arrived");
      assert.equal(got.headers.cookie, "session=DIRECT", "no redirect means no stripping: Cookie");
      assert.equal(got.headers.authorization, "Bearer direct-token", "no redirect means no stripping: Authorization");
      assert.equal(got.headers.referer, "https://site.test/watch/page?q=1", "no redirect means no downgrade: Referer");
      assert.equal(got.headers["x-trace-id"], "trace-d", "ordinary header still present");
      assert.deepEqual(res.strippedHeaders, [], "nothing may be reported stripped");
    });

    await suite.test("a redirect chain never mutates the caller's header object", async () => {
      const target = await hop("::1", {});
      const origin = await hop("127.0.0.1", { redirects: { "/mut": target.base + "/end" } });
      const bag = {
        Cookie: "session=MUTATION-CHECK",
        Authorization: "Bearer mutation-token",
        Referer: "https://site.test/watch/page?q=1",
        "X-Keep": "yes",
      };
      const snapshot = JSON.parse(JSON.stringify(bag));
      await readBody(await requestFollow(origin.base + "/mut", { headers: bag }));
      assert.deepEqual(bag, snapshot,
        "the caller's header bag must be byte-identical after a stripping redirect chain");
      const hop2 = target.at("/end");
      assert.ok(hop2, "the cross-host target must have been requested");
      assert.equal(hop2.headers["x-keep"], "yes", "non-credential headers still travel to the foreign host");
    });
  } finally {
    for (const p of hops) await p.then((h) => h.close()).catch(() => {});
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
    http.globalAgent.destroy();
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch3-redirect-credentials crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
