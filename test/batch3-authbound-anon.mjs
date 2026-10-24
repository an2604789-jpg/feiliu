#!/usr/bin/env node
// 批-3 追加回归:认证绑定 CDN 的匿名整链重试(net.mjs requestFollow)。
//
// 真实场景(2026-10-25 00:2x 定案):浏览器转交携带 GitHub 会话 Cookie 请求
// github.com(同源,凭据合法保留)→ GitHub 发认证专用通道
// objects.githubusercontent.com 的签名地址 → 跨域剥离 Cookie 后请求该地址 → 401
// (该地址必须要会话)。修复:跨域跳转后 401/403 且本链剥过凭据 → 从原始 URL
// 整链匿名重试一次(GitHub 便发 release-assets 匿名地址)。
//
// 用两个本地端口模拟两个 origin:带 Cookie 的首跳被 A 302 到 B 的"绑定资产"
// (无 Cookie 即 401);匿名首跳被 302 到 B 的匿名资产(恒 200)。

import assert from "node:assert/strict";
import http from "node:http";

const { requestFollow } = await import(new URL("../src/net.mjs", import.meta.url).href);

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** @type {string[]} 每次到达 B 的请求有无 Cookie 的记录 */
const seen = [];

function makeServer() {
  return http.createServer((req, res) => {
    const hasCookie = Boolean(req.headers.cookie);
    if (req.url.startsWith("/release")) {
      // 首跳 origin A:会话在场 → 认证绑定地址;匿名 → 匿名地址。
      if (hasCookie) {
        res.writeHead(302, { location: `http://127.0.0.1:${B_PORT}/bound-asset` });
      } else {
        res.writeHead(302, { location: `http://127.0.0.1:${B_PORT}/anon-asset` });
      }
      res.end();
      return;
    }
    // origin B:绑定资产要求会话,匿名资产对所有人开放。
    seen.push(req.url + (hasCookie ? " +cookie" : " -cookie"));
    if (req.url === "/bound-asset" && !hasCookie) {
      res.writeHead(401); res.end("auth required"); return;
    }
    res.writeHead(200, { "content-length": "5" });
    res.end("bytes");
  });
}

let B_PORT = 0;
const serverA = makeServer();
const serverB = makeServer();

async function readAll(res) {
  const chunks = [];
  for await (const c of res.stream || []) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

test("auth-bound CDN: cookie chain 401 triggers one anonymous replay and succeeds", async () => {
  await new Promise((r) => serverA.listen(0, "127.0.0.1", r));
  await new Promise((r) => serverB.listen(0, "127.0.0.1", r));
  B_PORT = serverB.address().port;
  const aPort = serverA.address().port;

  seen.length = 0;
  const res = await requestFollow(`http://127.0.0.1:${aPort}/release`, {
    headers: { "User-Agent": "probe", Cookie: "_gh_sess=real" },
    maxRedirects: 5,
  });
  assert.equal(res.statusCode, 200, "final status 200 via anonymous replay");
  assert.equal(await readAll(res), "bytes");
  // 匿名重放必须真的发生过:绑定资产被匿名拒过一次,匿名资产成功一次。
  assert.ok(seen.includes("/bound-asset -cookie"), "bound asset refused anonymously (the 401 path)");
  assert.ok(seen.includes("/anon-asset -cookie"), "anon asset fetched");
  assert.ok(!seen.some((s) => s.endsWith("+cookie")), "no cookie ever left origin A");
  assert.ok(res.strippedHeaders.some((h) => h.toLowerCase() === "cookie"), "strip recorded");
});

test("anonymous-first requests never trigger the replay", async () => {
  seen.length = 0;
  const aPort = serverA.address().port;
  const res = await requestFollow(`http://127.0.0.1:${aPort}/release`, {
    headers: { "User-Agent": "probe" },
    maxRedirects: 5,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen, ["/anon-asset -cookie"], "single clean hop, no 401 detour");
});

test("401 on the FIRST hop is not replayed (credentials belong there)", async () => {
  const srv = http.createServer((req, res) => { res.writeHead(401); res.end("no"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await assert.rejects(
    () => requestFollow(`http://127.0.0.1:${port}/x`, { headers: { Cookie: "a=b" }, maxRedirects: 2 }),
    (err) => /401|Unauthorized/i.test(err.message),
  );
  await new Promise((r) => srv.close(r));
});

for (const [name, fn] of tests) {
  try { await fn(); console.log("  PASS ", name); }
  catch (err) { failures++; console.log("  FAIL ", name, "\n   ", (err && err.message) || err); }
}

for (const s of [serverA, serverB]) {
  s.closeAllConnections?.();
  await new Promise((r) => s.close(r));
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
