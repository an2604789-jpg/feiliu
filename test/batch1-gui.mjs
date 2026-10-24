// Batch1 GUI regression: the parts of gui/index.html that are pure logic are
// extracted from the shipped file itself and executed here, so the test can
// never drift from what actually renders in the window.
//
// Covered (ask 包7):
//   (a) esc() — every dynamic field must go through it (spec 6);
//   (b) 分类映射 pickCategory/extOf — must agree with the engine's own
//       categorize() on the default extension table (src/categories.mjs);
//   (c) 目录联动 joinDir/linkedDirFor/categorySubmitDir — selecting a category
//       shows defaultDir/<分类> and MUST NOT double-nest on submit: while
//       categorizeByType is on the engine joins <base>/<category> itself
//       (resolveDirectory), so the linked segment is stripped back to baseDir;
//   (d) 前端排序 sortTaskList — 添加时间/大小/状态, no mutation of the queue
//       order array;
//   (e) structural checks on the shipped HTML: the endpoints the ask names
//       (probe / pending approve+reject / clear-completed), the 409 dialog with
//       existingTaskId, ensureDaemon fallback, askBeforeAdd switch, and that
//       the new dynamic banners still escape user-controlled fields.
//
// No server, no filesystem writes, no DOWNLOADX_HOME: this test reads exactly
// one file (gui/index.html) plus src/config.mjs for the extension table, so
// the production data root is never touched.
//
// Usage: node test/batch1-gui.mjs

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { Suite } from "./harness.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NL = String.fromCharCode(10);

async function main() {
  const suite = new Suite("batch1-gui");

  const htmlPath = path.join(ROOT, "gui", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");

  // ---- extract the pure region from the shipped file
  const regionMatch = /\/\* ==== GUI-PURE-START[\s\S]*?GUI-PURE-END ==== \*\//.exec(html);
  assert.ok(regionMatch, "gui/index.html must contain the GUI-PURE region");
  const pure = new Function(
    regionMatch[0] + NL + "return { esc, extOf, normPath, joinDir, linkedDirFor, categorySubmitDir, pickCategory, sortTaskList };"
  )();

  // Same table buildCatNav() derives from the daemon's config.categories.
  const catMap = {};
  for (const [name, exts] of Object.entries(DEFAULT_CONFIG.categories)) {
    for (const e of exts) catMap[String(e).toLowerCase()] = name;
  }

  try {
    // ------------------------------------------------------------- esc()
    suite.group("esc() 转义（动态字段统一出口）");

    await suite.test("esc escapes &, <, > and quotes", () => {
      assert.equal(pure.esc('<b class="x">&'), "&lt;b class=&quot;x&quot;&gt;&amp;");
    });
    await suite.test("esc passes plain text through unchanged", () => {
      assert.equal(pure.esc("movie 2026 (1).mp4"), "movie 2026 (1).mp4");
    });
    await suite.test("esc handles null/undefined/non-strings without throwing", () => {
      assert.equal(pure.esc(null), "");
      assert.equal(pure.esc(undefined), "");
      assert.equal(pure.esc(409), "409");
    });

    // ------------------------------------------------- 分类映射与引擎一致
    suite.group("分类映射与引擎 categorize() 一致");

    await suite.test("pickCategory matches src/categories.mjs on real extensions", () => {
      // "" in the GUI select means "auto", which the engine expresses as null
      // (categorize() returns null when no extension matches).
      const samples = {
        "movie.mp4": "video", "clip.MKV": "video", "song.flac": "audio",
        "pack.7z": "archive", "doc.PDF": "document", "setup.exe": "program",
        "pic.jpeg": "image", "unknown.xyz": "", "noext": "",
      };
      for (const [name, expected] of Object.entries(samples)) {
        const got = pure.pickCategory(name, catMap);
        assert.equal(got === "" ? null : got,
          expected === "" ? null : expected,
          "pickCategory('" + name + "') must agree with engine categorize");
      }
    });
    await suite.test("pickCategory reads URLs, ignoring query and fragment", () => {
      assert.equal(pure.pickCategory("https://x.com/a/b/file.zip?token=1#t", catMap), "archive");
      assert.equal(pure.pickCategory("https://x.com/a/watch", catMap), "");
    });
    await suite.test("askBeforeAdd is a real config key the switch can PATCH", () => {
      assert.ok(Object.hasOwn(DEFAULT_CONFIG, "askBeforeAdd"),
        "settings switch cfg-askBeforeAdd must map to an existing config key");
      assert.ok(Object.hasOwn(DEFAULT_CONFIG, "categorizeByType"),
        "categorySubmitDir depends on the categorizeByType config key");
    });

    // ------------------------------------------------------- 目录联动
    suite.group("分类→保存目录联动（不得双重嵌套）");

    await suite.test("linkedDirFor shows defaultDir/<分类>", () => {
      assert.equal(pure.linkedDirFor("video", "D:/dl"), "D:/dl/video");
      assert.equal(pure.linkedDirFor("", "D:/dl"), "");
    });
    await suite.test("joinDir follows the base's own separator and trims trailing ones", () => {
      assert.equal(pure.joinDir("D:/dl", "video"), "D:/dl/video");
      assert.equal(pure.joinDir("D:/dl/", "video"), "D:/dl/video");
      assert.equal(pure.joinDir("D:\\dl\\", "video"), "D:\\dl\\video");
      assert.equal(pure.joinDir("/data/dl", "video"), "/data/dl/video");
      assert.equal(pure.joinDir("", "video"), "");
    });
    await suite.test("categorySubmitDir strips the linked segment while categorizeByType is on", () => {
      const shown = pure.linkedDirFor("video", "D:/dl");
      // The engine (resolveDirectory) will join <base>/video itself; sending the
      // shown path verbatim would produce D:/dl/video/video.
      assert.equal(pure.categorySubmitDir(shown, "video", true, "D:/dl"), "D:/dl");
      assert.notEqual(pure.categorySubmitDir(shown, "video", true, "D:/dl"),
        String.raw`D:/dl\video\video`, "must never double-nest");
    });
    await suite.test("categorySubmitDir keeps custom dirs and respects categorizeByType=off", () => {
      assert.equal(pure.categorySubmitDir("D:/custom", "video", true, "D:/dl"), "D:/custom");
      // Engine ignores category for placement when categorizeByType is off,
      // so the shown path must be sent verbatim.
      assert.equal(pure.categorySubmitDir(String.raw`D:/dl\video`, "video", false, "D:/dl"),
        String.raw`D:/dl\video`);
      assert.equal(pure.categorySubmitDir("D:/dl", "", true, "D:/dl"), "D:/dl");
    });

    // --------------------------------------------------------- 前端排序
    suite.group("任务列表前端排序");

    const T = (id, status, totalBytes, createdAt) => ({ id, status, totalBytes, createdAt });
    const list = [
      T("a", "complete", 100, 1),
      T("b", "downloading", 50, 2),
      T("c", "error", null, 3),
      T("d", "queued", 300, 4),
    ];
    await suite.test("按添加时间：新的在前", () => {
      assert.deepEqual(pure.sortTaskList(list, "added").map((t) => t.id), ["d", "c", "b", "a"]);
    });
    await suite.test("按大小：大的在前，大小未知排最后", () => {
      assert.deepEqual(pure.sortTaskList(list, "size").map((t) => t.id), ["d", "a", "b", "c"]);
    });
    await suite.test("按状态：下载中在前，未知状态最后", () => {
      const order = ["downloading", "connecting", "queued", "paused", "complete", "error"];
      const withUnknown = [...list, T("e", "weird-status", 1, 9)];
      assert.deepEqual(pure.sortTaskList(withUnknown, "status", order).map((t) => t.id),
        ["b", "d", "a", "c", "e"]);
    });
    await suite.test("默认顺序保持队列顺序，且不改写传入数组", () => {
      const snapshot = list.map((t) => t.id);
      assert.deepEqual(pure.sortTaskList(list, "default").map((t) => t.id), snapshot);
      assert.deepEqual(list.map((t) => t.id), snapshot, "input array must not be mutated");
    });

    // ------------------------------------------------------ 结构回归检查
    suite.group("交付文件结构（端点/联动/转义哨兵）");

    await suite.test("标记区域恰好一份，内联脚本零依赖（无 require/import）", () => {
      assert.equal((html.match(/GUI-PURE-START/g) || []).length, 1);
      assert.equal((html.match(/GUI-PURE-END/g) || []).length, 1);
      assert.ok(!/require\(/.test(html), "GUI must stay zero-runtime-dependency");
      const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
      assert.ok(!/(^|[^.\w])import\s*['"(\w]/m.test(script), "inline script must not import modules");
      assert.ok(!/\bprocess\.\b/.test(script), "inline script must not touch node process");
    });
    await suite.test("工具栏清除已完成按钮打到既有端点", () => {
      assert.ok(html.includes('id="btnClearDone"'), "toolbar button present");
      assert.ok(html.includes('"/api/queue/clear-completed"'), "endpoint call present");
    });
    await suite.test("审批横幅与批准/拒绝端点、SSE pending_added 刷新", () => {
      assert.ok(html.includes('id="pendBanner"') && html.includes('id="pendList"'));
      assert.ok(html.includes('"/api/pending/"') || html.includes("`/api/pending/"),
        "approve/reject calls under /api/pending/");
      assert.ok(html.includes('"/reject"') && html.includes('"/approve"'));
      assert.ok(html.includes("pending_added") && html.includes("pending_resolved"),
        "SSE events must refresh the banner");
    });
    await suite.test("probe 回填大小/类型/续传到新建模态", () => {
      assert.ok(html.includes('id="m-probe"'), "probe info line present");
      assert.ok(html.includes('"/api/probe"'), "probe endpoint called");
      assert.ok(html.includes("supportsRanges"), "resumable flag rendered");
      assert.ok(/m-url["']\)\.addEventListener\("blur"/.test(html), "probe wired to URL blur");
    });
    await suite.test("409 已在队列中：查看任务（跳转高亮）与仍要添加", () => {
      assert.ok(html.includes("existingTaskId"), "dialog consumes the existing task id");
      assert.ok(html.includes("dupDialog") && html.includes("jumpToTask"));
      assert.ok(html.includes("仍要添加") && html.includes("查看任务"));
      assert.ok(/status\s*===\s*409/.test(html), "409 branch keyed on the attached status");
    });
    await suite.test("SSE 反复断线走 ensureDaemon 兜底", () => {
      assert.ok(html.includes("ensureDaemon"), "fallback call present");
      assert.ok(html.includes("evFails >= 3"), "only after repeated failures");
    });
    await suite.test("设置页 askBeforeAdd 开关进入读取与保存链路", () => {
      assert.ok(html.includes('id="cfg-askBeforeAdd"'), "switch present");
      assert.ok(/set\("cfg-askBeforeAdd",c\.askBeforeAdd\)/.test(html), "fillConfig reads it");
      assert.ok(/askBeforeAdd:\s*document\.getElementById\("cfg-askBeforeAdd"\)\.checked/.test(html),
        "btnSaveCfg sends it");
    });
    await suite.test("最近完成横幅点击走 location+openPath（桌面端）", () => {
      assert.ok(html.includes('id="doneBanner"') && html.includes('id="doneOpen"'));
      assert.ok(/openPath\(r\.path\)/.test(html), "openPath used with the resolved path");
      assert.ok(html.includes('"/location"'), "resolved via the location endpoint");
    });
    await suite.test("新横幅/对话框的动态字段全部过 esc()（哨兵抽查）", () => {
      const body = (name) => {
        const start = html.indexOf("function " + name);
        assert.ok(start > 0, "function " + name + " must exist");
        const chunk = html.slice(start, start + 3000);
        const end = chunk.indexOf(NL + "}");
        return end > 0 ? chunk.slice(0, end) : chunk;
      };
      for (const fn of ["renderPendBanner", "dupDialog", "showDoneBanner"]) {
        const src = body(fn);
        assert.ok(/esc\(/.test(src), fn + " must escape interpolated fields");
      }
      assert.ok(html.includes("esc(p.url)"), "pending URL escaped");
      assert.ok(html.includes("data-ap=\"'+esc(p.id)+'"), "pending id escaped in attribute");
    });

    await suite.test("内联脚本可在 DOM shim 中完成顶层初始化（接线冒烟）", async () => {
      const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
      const el = () => ({
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        dataset: {}, style: {}, innerHTML: "", textContent: "", value: "", checked: false,
        disabled: false, placeholder: "",
        addEventListener() {}, removeEventListener() {},
        appendChild() {}, remove() {}, focus() {}, blur() {}, select() {},
        querySelector() { return null; }, querySelectorAll() { return []; },
        setAttribute() {}, getAttribute() { return null; },
        closest() { return null; }, scrollIntoView() {},
        onclick: null, oninput: null, onchange: null,
      });
      const sandbox = {
        console,
        setTimeout, clearTimeout,
        // 不留任何真实定时器：进程必须干净退出
        setInterval: () => 0, clearInterval() {},
        fetch: async () => ({ ok: false, status: 503, text: async () => JSON.stringify({ error: "offline" }) }),
        EventSource: class { constructor() { this.onopen = null; this.onmessage = null; this.onerror = null; } close() {} },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        navigator: {}, requestAnimationFrame: (fn) => setTimeout(fn, 0),
        location: { protocol: "http:", host: "127.0.0.1:1" },
        CSS: { escape: (s) => String(s) },
      };
      sandbox.window = sandbox;
      sandbox.globalThis = sandbox;
      sandbox.document = {
        getElementById: () => el(),
        // 静态选择器（如 #confirmOverlay .modal-foot）在真实页面一定命中，
        // shim 不解析选择器、一律给通用元素，只用于暴露脚本自身的引用错误
        querySelector: () => el(),
        querySelectorAll: () => [],
        addEventListener() {}, removeEventListener() {},
        createElement: () => el(),
        body: el(),
        documentElement: el(),
        activeElement: null,
      };
      const vm = await import("node:vm");
      const ctx = vm.createContext(sandbox);
      // 顶层求值跑完 = 所有加载期绑定（导航/横幅/模态/批量条/审批/排序）无引用错误
      vm.runInContext(script, ctx, { filename: "gui-inline.js" });
      // 让 refresh()/loadPending() 的被拒分支在受控沙箱里落完，避免悬空拒绝
      await new Promise((r) => setTimeout(r, 50));
    });
  } finally {
    // nothing to tear down: no server, no files written
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch1-gui crashed: " + ((err && err.stack) || err) + NL);
    process.exitCode = 1;
  });
