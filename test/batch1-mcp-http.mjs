#!/usr/bin/env node
// 批-2 追加回归:daemon 内置的 MCP-over-HTTP 端点(状态化无会话 Streamable)。
//
// 覆盖:initialize/tools/list/tools/call 全链路、令牌必验、GET 拒绝、
// well-known 描述文件无泄密、Host 守卫随 remoteAccess 开关收放、
// remoteAccess 开启后 daemon 绑定 0.0.0.0 且 /api/status 如实上报。

import assert from "node:assert/strict";
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ENTRY = path.join(ROOT, "bin", "downloadx.mjs");

const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-mcp-http-"));

function startDaemon() {
  const child = spawn(process.execPath, [ENTRY, "daemon"], {
    env: { ...process.env, DOWNLOADX_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.on("error", (err) => process.stderr.write("[daemon] spawn error: " + err.message + "\n"));
  child.stderr.on("data", (c) => process.stderr.write("[daemon] " + c));
  child.stdout.on("data", (c) => process.stderr.write("[daemon:out] " + String(c).slice(0, 200)));
  child.on("exit", (code, signal) => process.stderr.write(`[daemon] exited code=${code} signal=${signal}\n`));
  return child;
}

async function waitHealthy(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const rt = JSON.parse(await fsp.readFile(path.join(home, "runtime.json"), "utf8"));
      const res = await fetch(`http://127.0.0.1:${rt.port}/api/status`, {
        headers: { "x-downloadx-token": rt.token }, signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return { rt, ...JSON.parse(await res.text()) };
    } catch { /* not ready */ }
  }
  return null;
}

async function mcp(port, token, method, params, id = 1) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-downloadx-token": token,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    } else {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      setTimeout(resolve, 300);
    }
  });
}

// undici 的 fetch 不允许伪造 Host 头(按 URL 生成),Host 守卫测试必须走 node:http。
function requestWithHost(port, reqPath, hostHeader, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: reqPath, method: "GET", headers: { ...headers, host: hostHeader } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("initialize / tools/list / tools/call over HTTP, token enforced", async () => {
  startDaemon();
  const state = await waitHealthy();
  assert.ok(state, "daemon became healthy");
  const { rt } = state;

  const noAuth = await fetch(`http://127.0.0.1:${rt.port}/mcp`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(noAuth.status, 401, "no token is refused");

  const init = await mcp(rt.port, rt.token, "initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" },
  });
  assert.equal(init.status, 200, "initialize answers 200");
  assert.equal(init.body?.result?.serverInfo?.name, "downloadx");
  assert.equal(init.body?.result?.protocolVersion, "2025-06-18");

  const list = await mcp(rt.port, rt.token, "tools/list", {});
  const names = (list.body?.result?.tools || []).map((t) => t.name);
  assert.ok(names.includes("downloadx_download") && names.includes("downloadx_status"), "core tools advertised");

  const call = await mcp(rt.port, rt.token, "tools/call", { name: "downloadx_list", arguments: {} });
  assert.equal(call.status, 200, "tools/call answers 200");
  const payload = JSON.parse(call.body?.result?.content?.[0]?.text || "{}");
  assert.ok(Array.isArray(payload.tasks), "downloadx_list returns tasks");

  const get = await fetch(`http://127.0.0.1:${rt.port}/mcp`, { headers: { "x-downloadx-token": rt.token } });
  assert.equal(get.status, 405, "GET /mcp is refused (stateless POST only)");

  // well-known: reachable, honest, and free of the token
  const wk = await fetch(`http://127.0.0.1:${rt.port}/.well-known/downloadx-mcp.json`);
  assert.equal(wk.status, 200, "well-known descriptor served");
  const desc = await wk.json();
  assert.equal(desc.endpoint, "/mcp");
  assert.ok(!JSON.stringify(desc).includes(rt.token), "descriptor carries no token");

  // Host guard stays on while remoteAccess is off: a foreign Host is refused
  // even with a valid token (node:http so the Host header is really forged).
  const foreign = await requestWithHost(rt.port, "/api/status", "evil.example", {
    "x-downloadx-token": rt.token,
  });
  assert.equal(foreign.status, 403, "foreign Host refused while remoteAccess off");

  globalThis.__rt = rt;
  globalThis.__child = state;
});

test("remoteAccess on: binds 0.0.0.0, Host guard relaxed, token still mandatory", async () => {
  const rt0 = globalThis.__rt;
  // flip the switch through the API itself, then restart so the bind happens
  const patch = await fetch(`http://127.0.0.1:${rt0.port}/api/config`, {
    method: "PATCH",
    headers: { "x-downloadx-token": rt0.token, "content-type": "application/json" },
    body: JSON.stringify({ remoteAccess: true }),
  });
  assert.equal(patch.status, 200, "remoteAccess patch accepted");
  await fetch(`http://127.0.0.1:${rt0.port}/api/shutdown`, {
    method: "POST", headers: { "x-downloadx-token": rt0.token },
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));

  const child = startDaemon();
  const state = await waitHealthy();
  assert.ok(state, "daemon restarted with remoteAccess");
  const { rt } = state;
  assert.equal(state.config?.remoteAccess, true, "config reports remoteAccess");
  assert.equal(state.boundHost, "0.0.0.0", "status reports the wide bind");

  // a Host the old guard would refuse now passes (LAN client naming by IP)
  const foreign = await requestWithHost(rt.port, "/mcp", "evil.example", {
    "x-downloadx-token": rt.token,
  });
  assert.equal(foreign.status, 405, "Host guard relaxed under remoteAccess (405 = reached the POST-only route)");
  const noToken = await requestWithHost(rt.port, "/mcp", "evil.example");
  assert.equal(noToken.status, 401, "token still mandatory under remoteAccess");

  await fetch(`http://127.0.0.1:${rt.port}/api/shutdown`, {
    method: "POST", headers: { "x-downloadx-token": rt.token },
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  void child;
});

for (const [name, fn] of tests) {
  try { await fn(); console.log("  PASS ", name); }
  catch (err) { failures++; console.log("  FAIL ", name, "\n   ", (err && err.message) || err); }
}

if (!process.env.MCP_HTTP_KEEP) await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
else console.log("kept:", home);
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
