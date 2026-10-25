// Batch7 docs regression: the proxy copy/documentation shipped with the P-18
// docs package must actually exist in the shipped files, and the GUI's inline
// script must still parse after the settings-page edits.
//
// Covered (ask 包3):
//   (a) gui/index.html 设置页「网络与安全」区:代理模式三项各有一句行为说明 —
//       使用系统代理=自动读取系统/浏览器代理设置;手动指定=始终用下方地址;
//       直连=忽略一切代理(regex against the shipped HTML);
//   (b) gui/index.html 手动代理地址 hint 注明 http://user:pass@host:port 与
//       socks5:// 形态及鉴权用途;
//   (c) the proxy settings wiring survived the copy edit unchanged: the three
//       <option> values, the two input ids and the save-payload keys are still
//       exactly what the daemon's config expects (纯文案改动,零行为改动的护栏);
//   (d) README.md has a ## 代理 section documenting: proxyMode 三态语义、代理
//       URL 带凭据写法、BT(aria2c) 的 UDP/直连限制、captureProxy 的
//       upstreamProxy 关系(regex against the shipped README);
//   (e) gui 内联脚本语法可编译 — batch1-gui 手法的轻量版:同样的 <script>
//       抽取正则,但只用 vm.Script 编译(等价 node --check),不执行、不需要
//       DOM shim,也不留任何事件循环句柄。
//
// No server, no network. The only files read are gui/index.html and README.md;
// DOWNLOADX_HOME points at a throwaway temp dir (removed on exit) so the real
// data root — %APPDATA%\downloadx or D:/IAM/downloadx-data — is never touched.
//
// Usage: node test/batch7-docs.mjs

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { Suite } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NL = String.fromCharCode(10);

async function main() {
  const suite = new Suite("batch7-docs");
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else if (r.kind === "skip") process.stdout.write("    SKIP  " + r.text + "  - " + r.reason + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  // 包3 discipline: throwaway DOWNLOADX_HOME, never the real data root.
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-batch7-docs-"));
  process.env.DOWNLOADX_HOME = home;

  try {
    const html = fs.readFileSync(path.join(ROOT, "gui", "index.html"), "utf8");
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

    // ------------------------------------------- (a)(b)(c) GUI 设置页文案
    suite.group("GUI 设置页「网络与安全」代理文案");

    await suite.test("代理模式三项各有一句行为说明", () => {
      assert.ok(/使用系统代理[:：=＝][^<\n]{0,20}自动读取系统\/浏览器代理设置/.test(html),
        "“使用系统代理”必须说明:自动读取系统/浏览器代理设置");
      assert.ok(/手动指定[:：=＝][^<\n]{0,10}始终用下方地址/.test(html),
        "“手动指定”必须说明:始终用下方地址");
      assert.ok(/直连[:：=＝][^<\n]{0,10}忽略一切代理/.test(html),
        "“直连”必须说明:忽略一切代理");
    });

    await suite.test("手动代理地址 hint 注明两种形态与鉴权用途", () => {
      // 锚定到 hint 本身:placeholder 里本来就有 socks5://user:pass@host:port,
      // 只查全文会把旧占位符误当新文案。
      const hint = /<span class="hint">仅在“手动指定代理”时使用[^<]*<\/span>/.exec(html);
      assert.ok(hint, "手动代理地址的 hint 必须存在");
      assert.ok(/http:\/\/user:pass@host:port/.test(hint[0]), "hint 必须写明 http://user:pass@host:port 形态");
      assert.ok(/socks5:\/\//.test(hint[0]), "hint 必须写明 socks5:// 形态");
      assert.ok(/鉴权/.test(hint[0]), "hint 必须写明 user:pass 的鉴权用途");
    });

    await suite.test("纯文案改动:代理设置的接线原样保留", () => {
      assert.ok(/<select id="cfg-proxyMode">/.test(html), "cfg-proxyMode select 还在");
      assert.ok(/<option value="system">使用系统代理<\/option>/.test(html), "system 选项原样");
      assert.ok(/<option value="manual">手动指定代理<\/option>/.test(html), "manual 选项原样");
      assert.ok(/<option value="none">直连（不使用代理）<\/option>/.test(html), "none 选项原样");
      assert.ok(/id="cfg-proxy"/.test(html), "cfg-proxy 输入框还在");
      assert.ok(/proxyMode:\s*document\.getElementById\("cfg-proxyMode"\)\.value/.test(html),
        "保存 payload 仍携带 proxyMode");
      assert.ok(/proxy:\s*document\.getElementById\("cfg-proxy"\)\.value\.trim\(\)/.test(html),
        "保存 payload 仍携带 proxy");
    });

    // ------------------------------------------------------- (d) README
    suite.group("README 代理小节");

    await suite.test("存在 ## 代理 小节,覆盖 proxyMode 三态语义", () => {
      const sec = /^##\s+代理\s*$(.*?)^##\s+/ms.exec(readme);
      assert.ok(sec, "README 必须有 ## 代理 小节");
      const doc = sec[1];
      assert.ok(/proxyMode/.test(doc), "提到 proxyMode");
      assert.ok(/`system`[^。\n]{0,60}自动读取系统\/浏览器代理设置/.test(doc),
        "system=自动读取系统/浏览器代理设置");
      assert.ok(/`manual`[^。\n]{0,60}始终用下方地址/.test(doc), "manual=始终用下方地址");
      assert.ok(/`none`[^。\n]{0,60}忽略一切代理/.test(doc), "none=忽略一切代理");
    });

    await suite.test("凭据写法、BT 限制与 captureProxy.upstreamProxy 关系齐备", () => {
      const doc = /^##\s+代理\s*$(.*?)^##\s+/ms.exec(readme)[1];
      assert.ok(/http:\/\/user:pass@host:port/.test(doc), "http 带凭据写法");
      assert.ok(/socks5:\/\/user:pass@host:port/.test(doc), "socks5 带凭据写法");
      assert.ok(/鉴权/.test(doc), "凭据的鉴权用途");
      assert.ok(/aria2c/.test(doc) && /--all-proxy/.test(doc), "BT 经 aria2c 且代理以 --all-proxy 透传");
      assert.ok(/UDP/.test(doc) && /直连/.test(doc), "BT 的 UDP/直连出口要求");
      assert.ok(/upstreamProxy/.test(doc), "captureProxy 的 upstreamProxy 配置位");
      assert.ok(/NO_PROXY/.test(doc) && /环境变量/.test(doc), "上游回落到环境变量并遵循 NO_PROXY");
    });

    // ------------------------------------- (e) 内联脚本语法(轻量 node --check)
    suite.group("gui 内联脚本语法");

    await suite.test("内联 <script> 可编译(vm.Script = node --check 等价)", () => {
      // 与 batch1-gui 相同的抽取正则;这里只编译不执行,所以不需要 DOM shim,
      // 也不会留下定时器/句柄 —— 进程干净退出。
      const m = /<script>([\s\S]*)<\/script>/.exec(html);
      assert.ok(m, "gui/index.html 必须含有内联 <script>");
      assert.doesNotThrow(() => new vm.Script(m[1], { filename: "gui-inline.js" }),
        "内联脚本必须能通过语法编译(node --check 等价)");
    });
  } finally {
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch7-docs crashed: " + ((err && err.stack) || err) + NL);
    process.exitCode = 1;
  });
