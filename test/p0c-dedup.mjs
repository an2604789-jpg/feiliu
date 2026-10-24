
// P0-C: a deliberate click must never be swallowed by the automatic-media
// cooldown.
//
// The defect this guards against: the badge's "Get" button sends the same
// media-found message shape as the fetch hook and the webRequest observer. A
// page that reported a stream two seconds earlier put that URL inside the
// 30-second cooldown window, so the click was answered {duplicate:true,
// throttled:true} and the button said "Already queued" for a download that was
// never created. The user waited for a file that did not exist.
//
// This test loads the real extension/background.js (not a copy of its logic)
// into a sandbox with a chrome API mock, wires its native-messaging port to a
// real extension/host.mjs subprocess and a real in-process daemon, then drives
// the message listener the way the content script does.
//
// Run the same file against the pre-fix file to see it fail:
//   P0C_BACKGROUND=...\background.js.p0c-bak node test/p0c-dedup.mjs
//
// Since batch-1 (2026-10-24) the background media-found path probes a
// candidate before queueing it: automatic reports must answer video/*|audio/*
// and at least 1 MiB. The fixtures below therefore serve a real media
// content-type over 2 MiB so the cooldown/duplicate behaviour under test is
// reached at all; a plain 64 KiB .bin would (correctly) never queue.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { Suite, assert } from "./harness.mjs";
import { startNativeHost, startContextOrigin, startSlowOrigin } from "./ext-protocol.mjs";

const PROJECT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const BACKGROUND = process.env.P0C_BACKGROUND || path.join(PROJECT, "extension", "background.js");

const suite = new Suite("p0c-dedup");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Load the real background.js into a context whose only browser API is ours.
 *
 * @returns {{ send: (msg:object, sender?:object)=>Promise<object>, chrome:any, unload:()=>void }}
 */
function loadBackground(backgroundPath, { onNativeMessage }) {
  const messageListeners = [];
  const disconnectListeners = [];

  const port = {
    onMessage: {
      addListener(fn) { messageListeners.push(fn); },
      removeListener(fn) {
        const i = messageListeners.indexOf(fn);
        if (i >= 0) messageListeners.splice(i, 1);
      },
    },
    onDisconnect: { addListener(fn) { disconnectListeners.push(fn); } },
    postMessage(message) {
      // Fire-and-forget, exactly like chrome's port: the reply arrives later on
      // the onMessage listeners.
      Promise.resolve()
        .then(() => onNativeMessage(message))
        .then((reply) => {
          for (const fn of messageListeners.slice()) { try { fn(reply); } catch { /* listener threw */ } }
        })
        .catch((err) => {
          const reply = { ok: false, error: String((err && err.message) || err) };
          for (const fn of messageListeners.slice()) { try { fn(reply); } catch { /* ignore */ } }
        });
    },
  };

  const chrome = {
    runtime: {
      id: "p0c-test-extension",
      lastError: undefined,
      connectNative() { return port; },
      onInstalled: { addListener() {} },
      onMessage: { addListener(fn) { messageListeners.push.call; } },
    },
    contextMenus: { create() {}, onClicked: { addListener() {} } },
    action: { onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    webRequest: { onHeadersReceived: { addListener() {} } },
    tabs: { query(q, cb) { cb && cb([]); }, sendMessage() { return Promise.resolve(); } },
    notifications: { create() {} },
  };
  // onMessage needs its own list: the port above re-used messageListeners as a
  // convenience and that would collide with ask()'s temporary listeners.
  const bgMessageListeners = [];
  chrome.runtime.onMessage = { addListener(fn) { bgMessageListeners.push(fn); } };

  const sandbox = {
    chrome,
    console: { warn() {}, log() {}, error() {} },
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Math,
    Object,
    Promise,
    String,
    Number,
    Boolean,
    Array,
    Map,
    Set,
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(backgroundPath, "utf8");
  vm.runInContext(source, sandbox, { filename: backgroundPath });

  const send = (msg, sender = { tab: { url: "https://page.example/watch" } }) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const respond = (reply) => {
        if (settled) return;
        settled = true;
        resolve(reply);
      };
      for (const fn of bgMessageListeners) {
        try { fn(msg, sender, respond); } catch (err) { reject(err); return; }
      }
      setTimeout(() => {
        if (!settled) { settled = true; reject(new Error("the background worker never answered: " + JSON.stringify(msg))); }
      }, 25000);
    });

  return { send, chrome };
}

/** A daemon the real host subprocess can talk to, sharing one DOWNLOADX_HOME. */
async function withDaemonAndHost(fn) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-p0c-"));
  const previousHome = process.env.DOWNLOADX_HOME;
  process.env.DOWNLOADX_HOME = home;
  const { Daemon } = await import("../src/daemon.mjs");
  const daemon = await new Daemon({ port: 0 }).init();
  const runtime = await daemon.start();
  const host = startNativeHost(home);
  const calls = [];
  const bg = loadBackground(BACKGROUND, {
    onNativeMessage: async (message) => {
      calls.push(message);
      return await host.send(message);
    },
  });
  const out = path.join(home, "downloads");
  await fsp.mkdir(out, { recursive: true });
  await daemon.config.set({ defaultDir: out, categorizeByType: false, overwriteExisting: "overwrite", maxConnections: 2, askBeforeAdd: false });
  const api = async (p, options = {}) => {
    const res = await fetch("http://127.0.0.1:" + runtime.port + p, {
      headers: Object.assign({ "x-downloadx-token": runtime.token }, options.body ? { "content-type": "application/json" } : {}),
      ...options,
    });
    return await res.json();
  };
  try {
    return await fn({ runtime, daemon, host, bg, api, out, calls, home });
  } finally {
    host.close();
    await daemon.stop();
    if (previousHome === undefined) delete process.env.DOWNLOADX_HOME;
    else process.env.DOWNLOADX_HOME = previousHome;
    // The 2 MiB fixture transfer can still be flushing its segment files when
    // the home is removed; on Windows that races rmdir into ENOTEMPTY, so
    // retry briefly instead of failing a test whose assertions all passed.
    for (let i = 0; ; i++) {
      try {
        await fsp.rm(home, { recursive: true, force: true });
        break;
      } catch (err) {
        if (i >= 8 || (err.code !== "ENOTEMPTY" && err.code !== "EBUSY" && err.code !== "EPERM")) throw err;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
}

const tasksFor = async (api, url) => {
  const payload = await api("/api/tasks");
  return (payload.tasks || []).filter((t) => t.url === url);
};

// ---------------------------------------------------------------------------
// The three scenarios named in the batch order.
// ---------------------------------------------------------------------------

await suite.test("first user click queues a real task", async () => {
  const origin = await startContextOrigin({ size: 2 * 1024 * 1024, contentType: "video/mp4" });
  const url = origin.url + "?case=first";
  try {
    await withDaemonAndHost(async ({ api, bg }) => {
      const reply = await bg.send({ type: "media-found", url, kind: "http", origin: "user" });
      assert.equal(reply.ok, true, "the click must not fail: " + JSON.stringify(reply));
      assert.equal(reply.throttled, false, "a user click is never throttled");
      assert.equal(reply.duplicate, false, "nothing existed yet, so this is not a duplicate");
      const found = await tasksFor(api, url);
      assert.equal(found.length, 1, "exactly one task must exist for a first click");
    });
  } finally {
    await origin.close();
  }
});

await suite.test("automatic media events are still collapsed", async () => {
  const origin = await startContextOrigin({ size: 2 * 1024 * 1024, contentType: "video/mp4" });
  const url = origin.url + "?case=auto";
  try {
    await withDaemonAndHost(async ({ api, bg }) => {
      const first = await bg.send({ type: "media-found", url, kind: "http" });
      assert.equal(first.ok, true);
      assert.equal(first.throttled, false, "the first observation of a URL is not suppressed");

      const second = await bg.send({ type: "media-found", url, kind: "http" });
      assert.equal(second.ok, true, "a suppressed event still answers ok");
      assert.equal(second.throttled, true, "the repeat automatic event must be collapsed");
      assert.equal(second.duplicate, false,
        "a suppressed event is not a duplicate: the daemon never said a task existed");
      assert.equal(second.duplicate && second.throttled, false,
        "duplicate and throttled must never both be true");

      const found = await tasksFor(api, url);
      assert.equal(found.length, 1, "the collapse must not create a second task");
    });
  } finally {
    await origin.close();
  }
});

await suite.test("a user click right after automatic events is NOT swallowed by the cooldown", async () => {
  // This is the defect, reproduced exactly: auto event, auto event (suppressed),
  // then a person presses Get. Before the fix the click was answered
  // {duplicate:true, throttled:true} and no task was created.
  const origin = await startContextOrigin({ size: 2 * 1024 * 1024, contentType: "video/mp4" });
  const url = origin.url + "?case=clickswallowed";
  try {
    await withDaemonAndHost(async ({ api, bg }) => {
      await bg.send({ type: "media-found", url, kind: "http" });          // auto: queues
      const suppressed = await bg.send({ type: "media-found", url, kind: "http" }); // auto: collapsed
      assert.equal(suppressed.throttled, true, "the second automatic event must be inside the cooldown");

      // Remove the task so a live task cannot be the reason for anything that
      // follows: the only thing being tested is the cooldown.
      const existing = await tasksFor(api, url);
      assert.equal(existing.length, 1);
      await api("/api/tasks/" + encodeURIComponent(existing[0].id), { method: "DELETE" });
      assert.equal((await tasksFor(api, url)).length, 0, "the task must be gone before the click");

      const click = await bg.send({ type: "media-found", url, kind: "http", origin: "user" });
      assert.equal(click.ok, true, "the click must not fail: " + JSON.stringify(click));
      assert.equal(click.throttled, false, "a user click must never be reported as throttled");
      assert.equal(click.duplicate, false, "no task existed, so this cannot be a duplicate");

      const after = await tasksFor(api, url);
      assert.equal(after.length, 1, "the user's click must have created exactly one task");
    });
  } finally {
    await origin.close();
  }
});

await suite.test("a genuinely repeated user click reports duplicate without throttling", async () => {
  // Slow origin on purpose: the background now probes before queueing, so the
  // duplicate check happens one round trip later than it used to. A fast 2 MiB
  // localhost transfer can already be complete by then; a trickled transfer
  // keeps the task genuinely live for the repeat click.
  const origin = await startSlowOrigin();
  const url = origin.url + "?case=dupe";
  try {
    await withDaemonAndHost(async ({ api, bg }) => {
      const first = await bg.send({ type: "media-found", url, kind: "http", origin: "user" });
      assert.equal(first.duplicate, false);

      const second = await bg.send({ type: "media-found", url, kind: "http", origin: "user" });
      assert.equal(second.ok, true);
      assert.equal(second.duplicate, true, "a live task exists, so the daemon must say duplicate");
      assert.equal(second.throttled, false, "a user click is never throttled");
      assert.equal(second.duplicate && second.throttled, false,
        "duplicate and throttled must never both be true");

      const found = await tasksFor(api, url);
      assert.equal(found.length, 1, "the second click must not create a second task");
    });
  } finally {
    await origin.close();
  }
});

await suite.test("every reply keeps duplicate and throttled mutually exclusive", async () => {
  // Slow origin, same reason as the duplicate test above: the user click at
  // replies[2] must find the auto-queued task still live.
  const origin = await startSlowOrigin();
  const url = origin.url + "?case=invariant";
  try {
    await withDaemonAndHost(async ({ bg }) => {
      const replies = [];
      replies.push(await bg.send({ type: "media-found", url, kind: "http" }));                  // auto, queues
      replies.push(await bg.send({ type: "media-found", url, kind: "http" }));                  // auto, throttled
      replies.push(await bg.send({ type: "media-found", url, kind: "http", origin: "user" }));  // user, duplicate
      replies.push(await bg.send({ type: "media-found", url, kind: "http" }));                  // auto again
      for (const r of replies) {
        assert.equal(Boolean(r.duplicate) && Boolean(r.throttled), false,
          "a reply must never claim to be both a duplicate and throttled: " + JSON.stringify(r));
      }
      assert.equal(replies[1].throttled, true, "the suppressed automatic event is throttled");
      assert.equal(replies[1].duplicate, false, "and it is not a duplicate");
      assert.equal(replies[2].duplicate, true, "the user click found the live task");
      assert.equal(replies[2].throttled, false, "and it was not throttled");
    });
  } finally {
    await origin.close();
  }
});

process.stdout.write(suite.report());
process.exit(suite.failed ? 1 : 0);
