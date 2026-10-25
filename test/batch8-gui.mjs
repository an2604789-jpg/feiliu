// Batch-8 GUI regression（包2：yt-dlp 状态展示与设置）— pure-logic extraction from
// the shipped gui/index.html itself, batch1-gui / batch4-gui convention (the test
// can never drift from what actually renders in the window).
//
// Covered:
//   (a) ytdlpStatusView  — 设置页状态徽标文案：capabilities.ytdlp 容错读取
//                          （对象 {found,version,path} / 字符串路径 / 缺失=未安装）；
//   (b) ytdlpSourceBadge — 任务卡「来源:yt-dlp(<extractor>)」徽标文案；meta 未下发
//                          （旧 daemon 的 taskView 不透出 meta）时返回 ""，不渲染；
//   (c) ytdlpFormatLines — 任务详情浮层的可选清晰度文本行（字符串/对象条目、
//                          resolution/height 回退、filesize_approx、注入字节格式化器）；
//   (d) rowVals/diffRowVals — 徽标是行叶子字段而非形态位：无 meta 的行 srcBadge=""
//                          （batch2-render 的 diff 精确断言保持全绿）、rowShape 不变、
//                          徽标出现/消失各自成 diff 字段；
//   (e) 结构检查         — 设置页 cfg-ytdlpPath / cfg-ytdlpAutoDownload 的回显与
//                          PATCH /api/config 保存链路、状态徽标接线、安装指引链接
//                          （桌面窗口拒绝外跳 → 降级复制）、任务详情浮层（只读、
//                          注明切清晰度=重新下单）、esc 哨兵、标记区域唯一、零依赖；
//   (f) DOM shim 冒烟    — 内联脚本顶层求值零引用错误（含本批新接线）。
//
// 契约边界（不在此断言后端，包1 可能并行落地）：config 键 ytdlpPath /
// ytdlpAutoDownload、任务 meta.ytdlp、status.capabilities.ytdlp 由包1 定义/下发；
// 本测试只钉前端的读写与展示逻辑。
//
// No server, no filesystem writes, no DOWNLOADX_HOME: reads exactly one file
// (gui/index.html), so the production data root is never touched and the
// process exits clean.
//
// Usage: node test/batch8-gui.mjs

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { Suite } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NL = String.fromCharCode(10);

async function main() {
  const suite = new Suite("batch8-gui");

  const htmlPath = path.join(ROOT, "gui", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");

  // ---- extract the pure regions from the shipped file
  const pureMatch = /\/\* ==== GUI-PURE-START[\s\S]*?GUI-PURE-END ==== \*\//.exec(html);
  assert.ok(pureMatch, "gui/index.html must contain the GUI-PURE region");
  const pure = new Function(
    pureMatch[0] + NL +
    "return { esc, YT_DLP_GUIDE_URL, ytdlpStatusView, ytdlpFormatLines };"
  )();

  const rowsyncMatch = /\/\* ==== GUI-ROWSYNC-START[\s\S]*?GUI-ROWSYNC-END ==== \*\//.exec(html);
  assert.ok(rowsyncMatch, "gui/index.html must contain the GUI-ROWSYNC region");
  const R = new Function(
    rowsyncMatch[0] + NL + "return { ytdlpSourceBadge, rowShape, rowVals, diffRowVals };"
  )();

  // Deterministic fake formatter, batch2-render shape.
  const bytes = (n) => "B[" + n + "]";

  // Baseline plain-HTTP task (no meta) — batch2-render's fixture shape.
  const T = (over) => Object.assign({
    id: "t1", status: "downloading", url: "https://x/f.mp4", filename: "f.mp4",
    totalBytes: 1000, downloadedBytes: 200, percent: 20, lengthKnown: true, speed: 100,
  }, over);
  const F = {
    bytes, speed: (n) => "V[" + n + "]", dur: (s) => "T[" + Math.round(s) + "]",
    errText: (m) => "E[" + (m || "") + "]", name: (t) => t.filename,
    statusCn: (st) => "CN[" + st + "]",
  };

  try {
    // ------------------------------------------------------- 设置页状态徽标
    suite.group("ytdlpStatusView：设置页状态徽标（capabilities.ytdlp 容错）");

    await suite.test("对象形态：found=true 且带版本 → 「已找到 yt-dlp <版本>」", () => {
      assert.deepEqual(pure.ytdlpStatusView({ found: true, version: "2025.10.22" }),
        { found: true, version: "2025.10.22", text: "已找到 yt-dlp 2025.10.22" });
    });
    await suite.test("对象形态：found 缺省时有 version/path 即视为已找到；版本去空白", () => {
      assert.equal(pure.ytdlpStatusView({ version: " 2025.10.22 " }).text, "已找到 yt-dlp 2025.10.22");
      const byPath = pure.ytdlpStatusView({ path: "C:\\tools\\yt-dlp.exe" });
      assert.equal(byPath.found, true);
      assert.equal(byPath.text, "已找到 yt-dlp", "无版本号只说已找到");
    });
    await suite.test("对象形态：found 明确为 false 即未安装（版本/路径都不救）", () => {
      const v = pure.ytdlpStatusView({ found: false, version: "x", path: "y" });
      assert.equal(v.found, false);
      assert.equal(v.text, "未安装");
    });
    await suite.test("空对象 / 缺失 / 垃圾输入 → 保守显示未安装", () => {
      for (const cap of [{}, undefined, null, 42, true]) {
        assert.equal(pure.ytdlpStatusView(cap).found, false, String(JSON.stringify(cap)));
        assert.equal(pure.ytdlpStatusView(cap).text, "未安装");
      }
    });
    await suite.test("字符串形态（capabilities.ffmpeg 同款）：非空路径=已找到，空白=未安装", () => {
      assert.equal(pure.ytdlpStatusView("C:\\tools\\yt-dlp.exe").found, true);
      assert.equal(pure.ytdlpStatusView("  ").found, false);
    });
    await suite.test("安装指引链接与规格逐字一致，且设置页真实引用", () => {
      assert.equal(pure.YT_DLP_GUIDE_URL, "https://github.com/yt-dlp/yt-dlp#installation");
      assert.ok(html.includes('href="https://github.com/yt-dlp/yt-dlp#installation"'),
        "设置页必须带安装指引 <a>");
    });

    // ------------------------------------------------------- 任务卡来源徽标
    suite.group("ytdlpSourceBadge：任务卡「来源:yt-dlp(<extractor>)」");

    await suite.test("meta.ytdlp.extractor → 来源:yt-dlp(<extractor>)，extractor 去空白", () => {
      assert.equal(R.ytdlpSourceBadge({ ytdlp: { extractor: "youtube", formats: [] } }), "来源:yt-dlp(youtube)");
      assert.equal(R.ytdlpSourceBadge({ ytdlp: { extractor: "  bilibili " } }), "来源:yt-dlp(bilibili)");
    });
    await suite.test("extractor 缺失仍有徽标（不带括号）；junk meta 一律空串", () => {
      assert.equal(R.ytdlpSourceBadge({ ytdlp: {} }), "来源:yt-dlp");
      for (const meta of [undefined, null, {}, { ytdlp: null }, { ytdlp: "youtube" }, { ytdlp: 42 }]) {
        assert.equal(R.ytdlpSourceBadge(meta), "", String(JSON.stringify(meta)));
      }
    });

    // ----------------------------------------------------- 可选清晰度文本行
    suite.group("ytdlpFormatLines：详情浮层的 formats 只读文本");

    await suite.test("字符串条目原样透出，空白条目剔除；非数组/垃圾条目安全", () => {
      assert.deepEqual(pure.ytdlpFormatLines(["137 mp4 1080p", "   ", "hls-1"], bytes),
        ["137 mp4 1080p", "hls-1"]);
      assert.deepEqual(pure.ytdlpFormatLines(null, bytes), []);
      assert.deepEqual(pure.ytdlpFormatLines("137", bytes), []);
      assert.deepEqual(pure.ytdlpFormatLines([null, 42, {}], bytes), []);
    });
    await suite.test("对象条目：format_id · ext · 分辨率 · 大小 · 备注", () => {
      assert.deepEqual(pure.ytdlpFormatLines(
        [{ format_id: 137, ext: "mp4", resolution: "1920x1080", filesize: 1234 }], bytes),
        ["137 · mp4 · 1920x1080 · B[1234]"]);
    });
    await suite.test("resolution 缺省回退 height「Np」；filesize 缺省用 filesize_approx", () => {
      assert.deepEqual(pure.ytdlpFormatLines([{ format_id: "h1", ext: "webm", height: 720 }], bytes),
        ["h1 · webm · 720p"]);
      assert.deepEqual(pure.ytdlpFormatLines([{ format_id: "x", filesize_approx: 2048 }], bytes),
        ["x · B[2048]"]);
    });
    await suite.test("format_note 收尾；无 fmt 注入时大小原样输出；文件大小无效则不输出", () => {
      assert.deepEqual(pure.ytdlpFormatLines([{ format_note: "storyboard" }], bytes),
        ["storyboard"]);
      assert.deepEqual(pure.ytdlpFormatLines([{ format_id: "a", filesize: 100 }], undefined),
        ["a · 100"]);
      assert.deepEqual(pure.ytdlpFormatLines([{ format_id: "a", filesize: NaN }], bytes), ["a"]);
    });

    // ------------------------------------------ 行展示值集成（叶子而非形态位）
    suite.group("rowVals/diffRowVals：徽标走叶子 diff，不动 rowShape");

    await suite.test("无 meta 的行 srcBadge 为空串（batch2-render 精确 diff 断言保持全绿）", () => {
      assert.equal(R.rowVals(T(), F, false).srcBadge, "");
      assert.equal(R.rowShape(T()), "downloading|k|1|0|0|0", "徽标不得成为形态位");
    });
    await suite.test("带 meta.ytdlp 的行徽标就位；出现/消失各自成 diff 字段", () => {
      const plain = R.rowVals(T(), F, false);
      const tagged = R.rowVals(T({ meta: { ytdlp: { extractor: "youtube" } } }), F, false);
      assert.equal(tagged.srcBadge, "来源:yt-dlp(youtube)");
      assert.deepEqual(R.diffRowVals(plain, tagged), { srcBadge: "来源:yt-dlp(youtube)" });
      assert.deepEqual(R.diffRowVals(tagged, plain), { srcBadge: "" });
    });
    await suite.test("两行都无 meta 时 diff 零 srcBadge 泄漏（速度帧保持只碰 s1/s2）", () => {
      const a = R.rowVals(T(), F, false);
      const b = R.rowVals(T({ speed: 120 }), F, false);
      assert.deepEqual(R.diffRowVals(a, b), { s1: "V[120]", s2: "剩余 T[7]" });
      assert.equal(R.diffRowVals(R.rowVals(T(), F, true), R.rowVals(T(), F, true)), null);
    });

    // ------------------------------------------------------ 结构回归检查
    suite.group("交付文件结构（读写链路/接线/esc 哨兵）");

    /** Slice one function body out of the shipped HTML (batch2-render trick). */
    const fnBody = (name) => {
      const start = html.indexOf("function " + name);
      assert.ok(start > 0, "function " + name + " must exist in gui/index.html");
      const chunk = html.slice(start, start + 6000);
      const end = chunk.indexOf(NL + "}");
      assert.ok(end > 0, "function " + name + " must terminate");
      return chunk.slice(0, end);
    };

    await suite.test("设置页 yt-dlp 路径进入回显与保存链路（同 aria2c 交互）", () => {
      assert.ok(html.includes('id="cfg-ytdlpPath"'), "输入框存在");
      assert.ok(/set\("cfg-ytdlpPath",c\.ytdlpPath\)/.test(html), "fillConfig 回显");
      assert.ok(/ytdlpPath:\s*document\.getElementById\("cfg-ytdlpPath"\)\.value\.trim\(\)/.test(html),
        "btnSaveCfg 提交（留空=自动查找）");
      assert.ok(/set\("cfg-ytdlpAutoDownload",c\.ytdlpAutoDownload\)/.test(html), "开关回显");
      assert.ok(/ytdlpAutoDownload:\s*document\.getElementById\("cfg-ytdlpAutoDownload"\)\.checked/.test(html),
        "btnSaveCfg 提交开关");
    });
    await suite.test("yt-dlp 区块落在「网络与安全」卡内（规格指定位置）", () => {
      const cardStart = html.indexOf('<h3>网络与安全</h3>');
      const cardEnd = html.indexOf('<h3>', cardStart + 1);
      const card = html.slice(cardStart, cardEnd);
      assert.ok(card.includes('id="cfg-ytdlpPath"') && card.includes('id="cfg-ytdlpAutoDownload"') &&
        card.includes('id="ytdlpState"'), "路径输入/自动下载开关/状态徽标都在该卡内");
    });
    await suite.test("状态徽标由 refresh 的 capabilities.ytdlp 驱动", () => {
      const rf = fnBody("refresh");
      assert.ok(rf.includes("capabilities.ytdlp") && rf.includes("ytdlpStatusView"),
        "refresh 必须读 capabilities.ytdlp 并过 ytdlpStatusView");
      assert.ok(rf.includes('ytChip.className = "status-chip " + (ytv.found ? "on" : "off")'),
        "found 与否切换 on/off 徽标");
    });
    await suite.test("安装指引：桌面窗口拒绝外跳 → 降级复制；浏览器直接跳转", () => {
      const i = html.indexOf('ytdlpGuideLink").addEventListener');
      assert.ok(i > 0, "指引链接点击处理存在");
      const blk = html.slice(i, i + 500);
      assert.ok(blk.includes("if (!DESKTOP) return;"), "浏览器不拦截默认跳转");
      assert.ok(blk.includes("preventDefault") && blk.includes("copyText"), "桌面降级为复制");
    });
    await suite.test("任务卡来源徽标：重建与增量两路同值，点击接任务详情浮层", () => {
      const rt = fnBody("renderTask");
      assert.ok(/src-badge/.test(rt) && /esc\(badge\)/.test(rt), "重建路径渲染徽标并转义");
      assert.ok(rt.includes('ytdlpSourceBadge(t.meta)'), "徽标文案来自纯函数");
      const crc = fnBody("cacheRowCommon");
      assert.ok(crc.includes('el.querySelector(".src-badge")'), "增量路径缓存徽标引用");
      const ard = fnBody("applyRowDiff");
      assert.ok(ard.includes("d.srcBadge") && ard.includes("classList.toggle"), "增量路径写回徽标");
      assert.ok(!ard.includes("innerHTML"), "applyRowDiff 仍只写叶子（batch2 契约）");
      const wr = fnBody("wireRowActions");
      assert.ok(wr.includes(".src-badge") && wr.includes("openTaskDetail"), "徽标点击接线");
    });
    await suite.test("任务详情浮层：只读 formats 文本，注明切清晰度=重新下单", () => {
      assert.ok(html.includes('id="taskOverlay"'), "浮层存在");
      for (const id of ["td-name", "td-source", "td-formats", "td-formats-field"]) {
        assert.ok(html.includes('id="' + id + '"'), id + " 存在");
      }
      const od = fnBody("openTaskDetail");
      assert.ok(od.includes("ytdlpFormatLines") && od.includes("textContent"), "formats 走纯函数+textContent");
      assert.ok(!od.includes("innerHTML"), "详情浮层不拼 HTML（用户数据零注入面）");
      assert.ok(html.includes("切换清晰度=重新下单"), "浮层注明切换语义");
      // 关闭路径：data-close 通用接线 + Escape + 点遮罩
      assert.ok((html.match(/data-close="taskOverlay"/g) || []).length === 2, "头/脚两个关闭按钮");
      assert.ok(/taskOverlay\.classList\.remove\("show"\)/.test(html), "Escape/遮罩关闭浮层");
    });
    await suite.test("标记区域恰好各一份，内联脚本零依赖（无 require/import/process）", () => {
      assert.equal((html.match(/GUI-PURE-START/g) || []).length, 1);
      assert.equal((html.match(/GUI-PURE-END/g) || []).length, 1);
      assert.equal((html.match(/GUI-ROWSYNC-START/g) || []).length, 1);
      assert.equal((html.match(/GUI-ROWSYNC-END/g) || []).length, 1);
      assert.ok(!/require\(/.test(html), "GUI must stay zero-runtime-dependency");
      const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
      assert.ok(!/(^|[^.\w])import\s*['"(\w]/m.test(script), "inline script must not import modules");
      assert.ok(!/\bprocess\.\b/.test(script), "inline script must not touch node process");
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
        // 静态选择器在真实页面一定命中；shim 只用于暴露脚本自身的引用错误
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
      // 顶层求值跑完 = 所有加载期绑定（含批-8 新接线：任务详情浮层/指引链接/
      // 徽标点击）无引用错误
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
    process.stderr.write("batch8-gui crashed: " + ((err && err.stack) || err) + NL);
    process.exitCode = 1;
  });
