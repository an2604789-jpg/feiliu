// Batch-1 small-fix regressions: publish rename retry, reserved device names,
// static-file containment, Host-header anti-rebinding.
//
// The four defects this guards against:
//   (1) publish() renamed the staged file exactly once, so a real-time virus
//       scanner still holding the staging file open at the assembly moment
//       (EPERM/EBUSY/ENOTEMPTY — a boundary IDM's documentation records as
//       real) failed an otherwise complete, verified transfer. publish now
//       retries on exactly those three codes with removeQuietly's pattern
//       (8 attempts, 40ms steps) and still throws when the window never opens.
//   (2) sanitizeName() kept Windows' reserved device names ("con", "nul.mp4"):
//       such a download wrote to a device, not a file. Reserved names now get
//       a "_" prefix, and trailing dots/spaces (which Windows silently strips)
//       are removed first.
//   (3) #serveStatic() proved containment with a string prefix
//       (file.startsWith(GUI_DIR)), which "…\gui2\…" — a sibling directory —
//       also satisfies. The check is now path.relative-based.
//   (4) listen() answered any Host header, so DNS rebinding (attacker domain
//       resolving to 127.0.0.1) reached the local API. Anything but
//       127.0.0.1:<port> / localhost:<port> is now 403 before any route runs.
//
// Note on (3): the HTTP front door in listen() parses every request with
// new URL(req.url, …), and the WHATWG parser collapses dot segments server-side
// ("/../x" and "/%2e%2e/x" both arrive as "/x"), so no request can put a real
// ".." into #serveStatic through HTTP — the prefix weakness was latent, not
// directly reachable. The relative check is the containment proof standing on
// its own; its one HTTP-observable effect is asserted directly: a path whose
// resolved file is outside the GUI root per path.relative (the literal name
// "..%5CREADME.md", i.e. a file literally called "..\README.md" inside gui/)
// now answers 403 where the old code answered 404.
//
// Everything runs against an isolated DOWNLOADX_HOME in the OS temp dir and
// servers that close all connections on exit: no public network, no user
// Downloads, no %APPDATA%\downloadx, nothing under the production data root.
//
// Usage: node test/batch1-smallfixes.mjs

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import process from "node:process";
import { EventEmitter } from "node:events";

import { Suite, assert } from "./harness.mjs";

const NL = String.fromCharCode(10);

async function main() {
  const suite = new Suite("batch1-smallfixes");
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  // Isolated data root. Set before any src import touches the filesystem.
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-batch1-"));
  const out = path.join(home, "out");
  await fsp.mkdir(out, { recursive: true });
  process.env.DOWNLOADX_HOME = home;

  const { TransferStore, renameWithRetry, STAGING_SUFFIX } = await import("../src/store.mjs");
  const { sanitizeName } = await import("../src/util.mjs");
  const { ApiServer } = await import("../src/api.mjs");

  /** One request against the test server, with full Host control. */
  const request = (base, route, { host, setHost = true, headers: extra = {} } = {}) => new Promise((resolve, reject) => {
    const headers = { ...extra };
    if (setHost && host !== undefined) headers.host = host;
    const req = http.request({
      host: "127.0.0.1", port: base.port, path: route, method: "GET", headers, setHost,
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });

  const stagedError = (code) => Object.assign(new Error(code + " (simulated)"), { code });

  // Declared outside the try so the finally can close the server even when a
  // test above it fails.
  let api = null;
  let base = null;

  try {
    // ------------------------------------------------------- publish retry
    suite.group("publish: rename retried on EPERM/EBUSY/ENOTEMPTY (store.mjs)");

    await suite.test("a clean rename moves the staging file to the target in one step", async () => {
      const target = path.join(out, "plain.bin");
      const staging = target + STAGING_SUFFIX;
      await fsp.writeFile(staging, Buffer.from("complete bytes"));
      const store = new TransferStore(target, { writePath: staging });
      assert.equal(store.staged, true, "a writePath distinct from the target is staged");
      await store.publish();
      assert.equal(fs.existsSync(target), true, "the target must hold the file after publish");
      assert.equal(fs.existsSync(staging), false, "the staging file must be gone");
      assert.equal((await fsp.readFile(target)).toString(), "complete bytes");
    });

    await suite.test("publish() is a no-op for a transfer that owns its target path", async () => {
      const target = path.join(out, "unstaged.bin");
      const store = new TransferStore(target);
      assert.equal(store.staged, false);
      await store.publish(); // must not create, move or throw
      assert.equal(fs.existsSync(target), false, "an unstaged publish must not create anything");
    });

    await suite.test("EPERM is retried with the 40ms escalating steps, then succeeds", async () => {
      const target = path.join(out, "retried.bin");
      const staging = target + STAGING_SUFFIX;
      await fsp.writeFile(staging, "data");
      const waits = [];
      const realRename = fsp.rename.bind(fsp);
      let calls = 0;
      // Two scanner-style EPERMs, then the real rename: the retry must land it.
      const rename = async (a, b) => {
        calls++;
        if (calls <= 2) throw stagedError("EPERM");
        return realRename(a, b);
      };
      await renameWithRetry(staging, target, { rename, wait: (ms) => { waits.push(ms); return Promise.resolve(); } });
      assert.equal(calls, 3, "two transient failures plus the successful attempt");
      assert.deepEqual(waits, [40, 80], "the backoff must follow removeQuietly's 40ms increments");
      assert.equal(fs.existsSync(target), true, "the rename must complete once the lock clears");
      assert.equal(fs.existsSync(staging), false);
    });

    await suite.test("EBUSY and ENOTEMPTY are retried too; other codes throw at once", async () => {
      const waits = [];
      for (const code of ["EBUSY", "ENOTEMPTY"]) {
        let calls = 0;
        const rename = async () => {
          calls++;
          if (calls === 1) throw stagedError(code);
          return;
        };
        await renameWithRetry("a", "b", { rename, wait: (ms) => { waits.push(ms); return Promise.resolve(); } });
        assert.equal(calls, 2, code + " must be retried once");
      }
      assert.deepEqual(waits, [40, 40], "each code's retry waits one 40ms step");
      let enoentCalls = 0;
      await assert.rejects(async () => {
        await renameWithRetry("a", "b", {
          rename: () => { enoentCalls++; throw stagedError("ENOENT"); },
          wait: () => { throw new Error("a non-retryable code must not wait"); },
        });
      }, "ENOENT must surface instead of being retried");
      assert.equal(enoentCalls, 1, "a non-retryable code must fail on the first attempt");
    });

    await suite.test("a lock that never clears throws the last error after 8 attempts", async () => {
      const waits = [];
      let calls = 0;
      const rename = async () => { calls++; throw stagedError("EPERM"); };
      await assert.rejects(
        async () => renameWithRetry("a", "b", { rename, wait: (ms) => { waits.push(ms); return Promise.resolve(); } }),
        (err) => err.code === "EPERM",
        "the last error must reach the caller: a silent success whose file never appears is worse than a failure",
      );
      assert.equal(calls, 8, "exactly 8 attempts, like removeQuietly");
      assert.deepEqual(waits, [40, 80, 120, 160, 200, 240, 280, 320], "40ms steps, escalating");
    });

    await suite.test("publish() itself rides out a transient lock and publishes the real bytes", async () => {
      const target = path.join(out, "e2e.bin");
      const staging = target + STAGING_SUFFIX;
      const payload = Buffer.from("verified complete content");
      await fsp.writeFile(staging, payload);
      // Monkey-patch the fs rename the helper defaults to, for the first call
      // only, to simulate the scanner holding the staging file open.
      const realRename = fsp.rename;
      let injected = false;
      fsp.rename = async (a, b) => {
        if (!injected) { injected = true; throw stagedError("EPERM"); }
        return realRename(a, b);
      };
      try {
        const store = new TransferStore(target, { writePath: staging });
        await store.publish();
      } finally {
        fsp.rename = realRename;
      }
      assert.equal(injected, true, "the simulated lock must actually have fired");
      assert.equal((await fsp.readFile(target)).equals(payload), true, "published bytes must be exact");
      assert.equal(fs.existsSync(staging), false);
    });

    // -------------------------------------------------- reserved device names
    suite.group("sanitizeName: reserved device names and trailing dots/spaces (util.mjs)");

    await suite.test("every classic reserved device name gets a _ prefix", () => {
      for (const name of ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"]) {
        assert.equal(sanitizeName(name), "_" + name, name + " is unusable on Windows as-is");
      }
      assert.equal(sanitizeName("CON"), "_CON", "the prefix must keep the user's case");
      assert.equal(sanitizeName("Com1"), "_Com1");
    });

    await suite.test("the device name wins before an extension, at any case", () => {
      assert.equal(sanitizeName("nul.mp4"), "_nul.mp4");
      assert.equal(sanitizeName("NUL.MP4"), "_NUL.MP4");
      assert.equal(sanitizeName("aux.png"), "_aux.png");
      assert.equal(sanitizeName("com1.tar.gz"), "_com1.tar.gz");
      assert.equal(sanitizeName("LPT7.iso"), "_LPT7.iso");
    });

    await suite.test("trailing dots and spaces are stripped before the device check", () => {
      assert.equal(sanitizeName("nul."), "_nul", "Windows would strip the dot and open NUL");
      assert.equal(sanitizeName("con  "), "_con");
      assert.equal(sanitizeName(" nul "), "_nul");
      assert.equal(sanitizeName("file."), "file");
      assert.equal(sanitizeName("file "), "file");
      assert.equal(sanitizeName("file.  "), "file");
      assert.equal(sanitizeName("report.docx"), "report.docx", "an internal dot is a normal name");
    });

    await suite.test("longer words that merely start like a device are untouched", () => {
      assert.equal(sanitizeName("compact"), "compact");
      assert.equal(sanitizeName("com10"), "com10", "only COM1-9 are reserved");
      assert.equal(sanitizeName("com0"), "com0");
      assert.equal(sanitizeName("conman.mp4"), "conman.mp4");
      assert.equal(sanitizeName("controller"), "controller");
    });

    await suite.test("the older guarantees still hold", () => {
      assert.equal(sanitizeName('a<b>c:d"e/f\\g|h?i*j'), "a_b_c_d_e_f_g_h_i_j");
      assert.equal(sanitizeName(""), "download");
      assert.equal(sanitizeName(".hidden"), "hidden");
    });

    await suite.test("the sanitized name is actually writable on this Windows", async () => {
      // The whole point: "nul.mp4" cannot exist as a file; "_nul.mp4" can.
      const file = path.join(out, sanitizeName("nul.mp4"));
      await fsp.writeFile(file, "x");
      assert.equal(fs.existsSync(file), true, "_nul.mp4 must be a real file");
      assert.equal(path.basename(file), "_nul.mp4");
    });

    // ------------------------------------------------ static file containment
    suite.group("#serveStatic: path.relative containment (api.mjs)");

    api = new ApiServer({
      queue: Object.assign(new EventEmitter(), { list: () => [], stats: { total: 0, active: 0 } }),
      config: { values: {}, get: (k) => (k === "exceptions" ? [] : null) },
      downloader: new EventEmitter(),
      log: { info() {}, warn() {}, error() {}, tail: () => [] },
    });
    base = await api.listen({ port: 0 });

    await suite.test("the real GUI still serves, with the token injected", async () => {
      const r = await request(base, "/index.html");
      assert.equal(r.status, 200, "index.html must keep serving");
      assert.ok(r.body.includes("window.__DOWNLOADX__"), "the token injection must survive");
      assert.ok(r.body.includes(base.token), "the injected token must be this server's token");
    });

    await suite.test("an unknown file inside the GUI root stays a 404", async () => {
      const r = await request(base, "/missing.js");
      assert.equal(r.status, 404);
    });

    await suite.test("a path outside the GUI root per path.relative is a 403, not a lookup", async () => {
      // A file literally called "..\README.md" inside gui/: path.relative puts
      // it outside the root (the result starts with ".."), the old prefix
      // check passed it to readFile and answered 404. It must never be 200.
      const r = await request(base, "/..%5CREADME.md");
      assert.equal(r.status, 403, "relative-to-root '…' starting with '..' must be 403, got " + r.status);
      assert.equal(r.body, "forbidden");
    });

    await suite.test("traversal-shaped requests never serve a file, whatever the status", async () => {
      for (const route of ["/../README.md", "/%2e%2e/%2e%2e/README.md", "/a/../../README.md", "/..%2fREADME.md"]) {
        const r = await request(base, route);
        assert.notEqual(r.status, 200, route + " must never serve content");
        assert.notEqual(r.status, 500, route + " must be refused cleanly");
        assert.ok(!r.body.includes("# downloadx"), route + " must not leak README content");
      }
    });

    // ------------------------------------------------------ Host validation
    suite.group("listen(): Host header anti-rebinding (api.mjs)");

    await suite.test("the addresses the UI is opened at keep working", async () => {
      const good = await request(base, "/index.html"); // undici-style default Host: 127.0.0.1:port
      assert.equal(good.status, 200, "the default 127.0.0.1:<port> Host must pass");
      const viaLocalhost = await request(base, "/index.html", { host: "localhost:" + base.port });
      assert.equal(viaLocalhost.status, 200, "localhost:<port> must pass");
      const upper = await request(base, "/index.html", { host: "LOCALHOST:" + base.port });
      assert.equal(upper.status, 200, "the hostname is case-insensitive");
    });

    await suite.test("any other Host is 403 before any route sees the request", async () => {
      // (An explicitly empty Host header cannot be sent through node:http — the
      // client substitutes its default — so a truly missing Host is covered by
      // the setHost:false request below.)
      const hosts = ["evil.example", "127.0.0.1.evil.example:" + base.port,
        "localhost:" + (base.port + 1), "127.0.0.1:"];
      for (const host of hosts) {
        const r = await request(base, "/index.html", { host });
        assert.equal(r.status, 403, "Host " + JSON.stringify(host) + " must be 403, got " + r.status);
      }
      const noHost = await request(base, "/index.html", { setHost: false });
      assert.ok(noHost.status === 403 || noHost.status === 400,
        "an HTTP/1.1 request without any Host must be refused, got " + noHost.status);
      // Over HTTP/1.1 node:http answers a missing Host with 400 before user
      // code runs (RFC 7230 §5.4), so the guard itself is exercised with an
      // HTTP/1.0 request line, where Host is optional and the socket is raw.
      const raw = await new Promise((resolve, reject) => {
        const sock = net.connect(base.port, "127.0.0.1", () => {
          sock.write("GET /index.html HTTP/1.0\r\n\r\n");
        });
        let data = "";
        sock.on("data", (c) => { data += c; });
        sock.on("close", () => resolve(data));
        sock.on("error", reject);
      });
      assert.match(raw, /^HTTP\/1\.1 403/, "a Host-less HTTP/1.0 request must get the guard's 403");
      assert.ok(!raw.includes("<!DOCTYPE"), "no GUI content may be served without a Host");
    });

    await suite.test("the token check behind the Host gate keeps its exact semantics", async () => {
      const noToken = await request(base, "/api/tasks");
      assert.equal(noToken.status, 401, "a missing token must still be 401");
      const badToken = await request(base, "/api/tasks", {
        host: "127.0.0.1:" + base.port,
        headers: { "x-downloadx-token": "not-the-token" },
      });
      assert.equal(badToken.status, 401, "a wrong token must still be 401");
      const good = await request(base, "/api/tasks", {
        host: "127.0.0.1:" + base.port,
        headers: { "x-downloadx-token": base.token },
      });
      assert.equal(good.status, 200, "the valid token must keep working over 127.0.0.1");
      assert.deepEqual(JSON.parse(good.body), { tasks: [] });
    });
  } finally {
    await api?.close().catch(() => {}); // closes keep-alive sockets, then all connections
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch1-smallfixes crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
