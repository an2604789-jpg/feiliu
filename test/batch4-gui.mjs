// Batch-4 GUI regression: the pure logic behind the new W4 surfaces, extracted
// from the shipped gui/index.html itself (the batch1-gui / batch2-render
// convention — the test can never drift from what actually renders).
//
// Covered (批-4 W4 队列视图/转换对话框/磁力入口/设置区块):
//   (a) isMagnetUrl          — URL 栏 magnet: 直达入队的判定;
//   (b) queueNavGroups       — 侧栏分组导航构造:无自定义组时为空(不多占位),
//                               有自定义组时逐组列出,name 缺省回落 id;
//   (c) CONVERT_PRESETS      — 与 src/convert.mjs PRESETS 的 key/label 逐项一致
//                               (预设四选一,参数绝不进 UI);
//   (d) convertSubmitBody    — POST /api/tasks 请求体:kind "convert"、
//                               meta{sourcePath,sourceTaskId,preset}、
//                               url 按引擎约定 "convert:"+源路径、dir 空则不发;
//   (e) sanitizeQueueRows    — 组名/并发表单校验:空名与重名报错(后端 sanitize
//                               只会静默丢组,用户必须看到原因)、并发钳 1..32、
//                               结果与 Config.sanitize 完全兼容;
//   (f) displayTaskUrl/rowVals — 转换任务行的“约 xx%”呈现与源文件路径展示,
//                               非 convert 行的展示值逐字节不变(batch2-render 契约);
//   (g) friendlyError        — aria2c/ffmpeg 缺失的人话报错必须原样透出
//                               (P-3:磁力错误曾是空串,回归哨兵);
//   (h) 结构检查             — 交付文件里新交互的端点/接线/esc 哨兵;
//   (i) DOM shim 冒烟        — 内联脚本顶层求值零引用错误(全部新接线含其中)。
//
// No server, no filesystem writes, no DOWNLOADX_HOME: this test reads
// gui/index.html plus src/convert.mjs / src/bt.mjs / src/config.mjs constants,
// so the production data root is never touched and the process exits clean.
//
// Usage: node test/batch4-gui.mjs

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { Suite } from "./harness.mjs";
import { PRESETS } from "../src/convert.mjs";
import { NO_ARIA2C_MESSAGE } from "../src/bt.mjs";
import { NO_FFMPEG_MESSAGE } from "../src/convert.mjs";
import { DEFAULT_CONFIG, Config } from "../src/config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NL = String.fromCharCode(10);

async function main() {
  const suite = new Suite("batch4-gui");

  const htmlPath = path.join(ROOT, "gui", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");

  // ---- extract the pure regions from the shipped file
  const pureMatch = /\/\* ==== GUI-PURE-START[\s\S]*?GUI-PURE-END ==== \*\//.exec(html);
  assert.ok(pureMatch, "gui/index.html must contain the GUI-PURE region");
  const pure = new Function(
    pureMatch[0] + NL +
    "return { esc, normPath, isMagnetUrl, queueNavGroups, CONVERT_PRESETS, convertSubmitBody, sanitizeQueueRows };"
  )();

  const rowsyncMatch = /\/\* ==== GUI-ROWSYNC-START[\s\S]*?GUI-ROWSYNC-END ==== \*\//.exec(html);
  assert.ok(rowsyncMatch, "gui/index.html must contain the GUI-ROWSYNC region");
  const R = new Function(
    rowsyncMatch[0] + NL + "return { displayTaskUrl, rowShape, rowVals };"
  )();

  // friendlyError lives outside both marked regions; slice it by function body.
  const feMatch = /function friendlyError\([\s\S]*?\n\}/.exec(html);
  assert.ok(feMatch, "gui/index.html must define friendlyError");
  const friendlyError = new Function(feMatch[0] + NL + "return friendlyError;")();

  // Deterministic fake formatters, same shape as batch2-render's.
  const F = {
    bytes: (n) => "B[" + n + "]",
    speed: (n) => "V[" + n + "]",
    dur: (s) => "T[" + Math.round(s) + "]",
    errText: (m) => "E[" + (m || "") + "]",
    name: (t) => t.filename || ("N[" + t.url + "]"),
    statusCn: (st) => "CN[" + st + "]",
  };

  try {
    // ------------------------------------------------------------- magnet 直达
    suite.group("URL 栏 magnet: 直达入队");

    await suite.test("magnet:?xt= 判定为直达（大小写不敏感、容忍首尾空白）", () => {
      assert.equal(pure.isMagnetUrl("magnet:?xt=urn:btih:abc&dn=x"), true);
      assert.equal(pure.isMagnetUrl("MAGNET:?xt=urn:btih:abc"), true);
      assert.equal(pure.isMagnetUrl("  magnet:?xt=urn:btih:abc  "), true);
    });
    await suite.test("http/ftp/m3u8/空串不走直达，仍进新建模态", () => {
      assert.equal(pure.isMagnetUrl("https://example.com/a.zip"), false);
      assert.equal(pure.isMagnetUrl("ftp://x/y"), false);
      assert.equal(pure.isMagnetUrl(""), false);
      assert.equal(pure.isMagnetUrl(null), false);
      // torrent 文件是 http URL，由引擎 detectKind 判 bt，不经 magnet 直达分支
      assert.equal(pure.isMagnetUrl("https://x.org/a.torrent"), false);
    });

    // ------------------------------------------------------- 队列分组导航
    suite.group("侧栏队列分组导航构造");

    await suite.test("默认单组配置 → 不渲染导航（与现状一致，不多占位）", () => {
      assert.deepEqual(pure.queueNavGroups(DEFAULT_CONFIG.queues), []);
      assert.deepEqual(pure.queueNavGroups([{ id: "default", name: "默认", concurrent: 8 }]), []);
      assert.deepEqual(pure.queueNavGroups([]), []);
      assert.deepEqual(pure.queueNavGroups(undefined), []);
      assert.deepEqual(pure.queueNavGroups("junk"), []);
    });
    await suite.test("有自定义组 → 默认组与自定义组都列出", () => {
      assert.deepEqual(
        pure.queueNavGroups([
          { id: "default", name: "Default", concurrent: 32 },
          { id: "work", name: "工作", concurrent: 2 },
        ]),
        [{ id: "default", name: "Default" }, { id: "work", name: "工作" }]);
    });
    await suite.test("name 缺失回落 id；name 空白回落 id；垃圾条目剔除", () => {
      assert.deepEqual(
        pure.queueNavGroups([
          { id: "a", concurrent: 1 },
          { id: "b", name: "   ", concurrent: 1 },
          null,
          { name: "no-id" },
          { id: "", name: "empty" },
        ]),
        [{ id: "a", name: "a" }, { id: "b", name: "b" }]);
    });

    // ------------------------------------------------------------- 预设表
    suite.group("转换预设表与 src/convert.mjs 一致");

    await suite.test("恰好四个预设，key 集合与引擎 PRESETS 完全一致", () => {
      assert.equal(pure.CONVERT_PRESETS.length, 4, "预设四选一");
      assert.deepEqual(
        pure.CONVERT_PRESETS.map((p) => p.key).sort(),
        Object.keys(PRESETS).sort());
    });
    await suite.test("每个预设的 label 与引擎一致，且都带一句给用户的说明", () => {
      for (const p of pure.CONVERT_PRESETS) {
        assert.equal(p.label, PRESETS[p.key].label, "label must match PRESETS." + p.key);
        assert.ok(p.desc && p.desc.length >= 8, "desc（一句说明）必须存在：" + p.key);
      }
    });

    // ------------------------------------------------------- 转换提交体
    suite.group("转换任务 POST /api/tasks 请求体");

    await suite.test("kind=convert，意图全在 meta（sourcePath/sourceTaskId/preset）", () => {
      const b = pure.convertSubmitBody({
        sourcePath: "E:\\Downloads\\a.mp4", sourceTaskId: "tid-1", preset: "h265",
      });
      assert.equal(b.kind, "convert");
      assert.equal(b.meta.sourcePath, "E:\\Downloads\\a.mp4");
      assert.equal(b.meta.sourceTaskId, "tid-1");
      assert.equal(b.meta.preset, "h265");
      // 引擎约定：url 是标签（test/batch4-convert.mjs 同款），真实意图在 meta
      assert.equal(b.url, "convert:E:\\Downloads\\a.mp4");
    });
    await suite.test("输出目录默认同目录：dir 为空则不发，非空则去尾部分隔符", () => {
      const withDir = pure.convertSubmitBody({
        sourcePath: "E:/dl/a.mp4", preset: "mp3", dir: "E:/out/",
      });
      assert.equal(withDir.dir, "E:/out");
      const noDir = pure.convertSubmitBody({ sourcePath: "E:/dl/a.mp4", preset: "mp3", dir: "  " });
      assert.equal("dir" in noDir, false, "空目录必须省略，让引擎落到源文件同目录");
    });
    await suite.test("preset 缺省时原样携带（引擎侧给人话报错，UI 不假装校验通过）", () => {
      const b = pure.convertSubmitBody({ sourcePath: "/x/a.mp4" });
      assert.equal(b.meta.preset, undefined);
      assert.equal(b.meta.sourceTaskId, null);
    });

    // ------------------------------------------------------- 队列分组表单
    suite.group("队列分组表单校验（增删改 → PATCH /api/config）");

    await suite.test("合法行：name 去空白、缺 id 用 name 补、并发钳 1..32", () => {
      const v = pure.sanitizeQueueRows([
        { id: "work", name: "  工作  ", concurrent: 2 },
        { name: "play", concurrent: 99 },
        { name: "low", concurrent: 0 },
        { name: "auto", concurrent: "5" },
        { name: "junk", concurrent: NaN },
      ]);
      assert.equal(v.ok, true);
      assert.deepEqual(v.queues, [
        { id: "work", name: "工作", concurrent: 2 },
        { id: "play", name: "play", concurrent: 32 },
        { id: "low", name: "low", concurrent: 1 },
        { id: "auto", name: "auto", concurrent: 5 },
        { id: "junk", name: "junk", concurrent: 32 },
      ]);
    });
    await suite.test("结果与后端 Config.sanitize 完全兼容（原样过闸不变形）", () => {
      const v = pure.sanitizeQueueRows([
        { id: "a", name: "甲", concurrent: 3 },
        { name: "乙", concurrent: 40 },
      ]);
      assert.equal(v.ok, true);
      const c = Config.sanitize({ ...DEFAULT_CONFIG, queues: v.queues });
      assert.deepEqual(c.queues, v.queues, "GUI 校验产物必须被引擎原样接受");
    });
    await suite.test("空组名报错（后端只会静默丢组，用户必须看到原因）", () => {
      const v = pure.sanitizeQueueRows([{ id: "a", name: "ok" }, { id: "", name: "  " }]);
      assert.equal(v.ok, false);
      assert.ok(v.error.includes("组名"));
    });
    await suite.test("重名报错（两行都会以 name 兜底成同一个 id）", () => {
      const v = pure.sanitizeQueueRows([{ name: "电影" }, { name: "电影" }]);
      assert.equal(v.ok, false);
      assert.ok(v.error.includes("重复"));
    });
    await suite.test("上限 64 与既有数组一致（DEFAULT_CONFIG 单组 + 63 新组 = 64 可过）", () => {
      const ok64 = pure.sanitizeQueueRows([{ id: "default", name: "Default", concurrent: 32 },
        ...Array.from({ length: 63 }, (_, i) => ({ name: "g" + i, concurrent: 1 }))]);
      assert.equal(ok64.ok, true);
      const bad65 = pure.sanitizeQueueRows([
        ...Array.from({ length: 65 }, (_, i) => ({ name: "g" + i, concurrent: 1 }))]);
      assert.equal(bad65.ok, false);
      assert.ok(bad65.error.includes("64"));
    });
    await suite.test("全删空 → 提交空数组是合法操作（引擎回落默认单组）", () => {
      const v = pure.sanitizeQueueRows([]);
      assert.equal(v.ok, true);
      assert.deepEqual(v.queues, []);
      const c = Config.sanitize({ ...DEFAULT_CONFIG, queues: v.queues });
      assert.deepEqual(c.queues, DEFAULT_CONFIG.queues, "引擎必须回落到默认单组");
    });

    // ------------------------------------------------- 转换任务的行呈现
    suite.group("转换任务在列表中的“约 xx%”呈现");

    const CV = (over) => Object.assign({
      id: "c1", kind: "convert", status: "downloading", url: "convert:E:\\dl\\a.mp4",
      filename: "a.mp4", totalBytes: 6_000_000, downloadedBytes: 2_700_000,
      percent: 45, lengthKnown: true, speed: 0,
    }, over);
    const HTTP = (over) => Object.assign({
      id: "h1", status: "downloading", url: "https://x/f.mp4", filename: "f.mp4",
      totalBytes: 1000, downloadedBytes: 200, percent: 20, lengthKnown: true, speed: 100,
    }, over);

    await suite.test("转换中·时长已知 → 只有一句“约 N%”，无速度/剩余/字节对", () => {
      const v = R.rowVals(CV(), F, false);
      assert.deepEqual(v.s, ["约 45%"]);
      assert.equal(v.width, "45.0%", "进度条宽度仍用精确百分比");
      assert.equal(v.pillText, "CN[downloading]");
    });
    await suite.test("转换中·时长未知 → “转换中…”+说明，宽度恒 100%", () => {
      const v = R.rowVals(CV({ totalBytes: null, downloadedBytes: 1_500_000, percent: null, lengthKnown: false }), F, false);
      assert.deepEqual(v.s, ["转换中…", "时长未知，无法估算百分比"]);
      assert.equal(v.width, "100%");
    });
    await suite.test("排队/暂停/完成的转换任务各有状态文案", () => {
      assert.deepEqual(R.rowVals(CV({ status: "queued", totalBytes: null, percent: null, lengthKnown: false }), F, false).s,
        ["等待转换…"]);
      assert.deepEqual(R.rowVals(CV({ status: "paused", totalBytes: null, percent: null, lengthKnown: false }), F, false).s,
        ["转换已暂停", "重新开始将从头转换（不支持断点续传）"]);
      assert.deepEqual(R.rowVals(CV({ status: "complete", percent: 100, downloadedBytes: 6_000_000, sha256: "abcdef123456xyz" }), F, false).s,
        ["100.0%", "B[6000000]", "校验 abcdef123456…"],
        "完成的转换显示真实产物大小与校验串");
    });
    await suite.test("转换行的“链接”位置显示源文件路径（url 标签剥前缀）", () => {
      assert.equal(R.displayTaskUrl(CV()), "格式转换 · 源文件 E:\\dl\\a.mp4");
      assert.equal(R.displayTaskUrl({ kind: "convert", url: "plain" }), "格式转换 · 源文件 plain");
      assert.equal(R.displayTaskUrl({ url: "https://x/f.mp4" }), "https://x/f.mp4");
      assert.equal(R.displayTaskUrl({}), "");
      assert.equal(R.rowVals(CV(), F, false).url, "格式转换 · 源文件 E:\\dl\\a.mp4");
    });
    await suite.test("非 convert 行的展示值逐字节不变（batch2-render 契约守护）", () => {
      assert.deepEqual(R.rowVals(HTTP(), F, false).s,
        ["20.0%", "V[100]", "剩余 T[8]", "B[200] / B[1000]"]);
      assert.equal(R.rowVals(HTTP(), F, false).url, "https://x/f.mp4");
      assert.deepEqual(R.rowVals(HTTP({ status: "queued", speed: 0 }), F, false).s,
        ["20.0%", "等待下载…"]);
      // 流式（总大小未知）任务的旧文案也不许变
      assert.deepEqual(R.rowVals(HTTP({ lengthKnown: false, totalBytes: null, speed: 0 }), F, false).s,
        ["已接收 B[200]", "总大小未知（流式传输）"]);
      // rowShape 的既有串不许变（batch2-render 逐字断言）
      assert.equal(R.rowShape(HTTP()), "downloading|k|1|0|0|0");
      assert.equal(R.rowShape(HTTP({ status: "error", error: "boom" })), "error|k|0|0|1|0");
    });

    // ------------------------------------------------- 缺失引擎的人话报错
    suite.group("aria2c / ffmpeg 缺失的人话错误直接可见");

    await suite.test("aria2c 缺失文案原样透出（P-3：磁力错误曾是空串）", () => {
      assert.ok(NO_ARIA2C_MESSAGE.includes("aria2c"), "消息自证");
      assert.equal(friendlyError(NO_ARIA2C_MESSAGE), NO_ARIA2C_MESSAGE,
        "friendlyError 不得吞掉或改写引擎给的人话文案");
    });
    await suite.test("ffmpeg 缺失文案同样原样透出（同一约定）", () => {
      assert.equal(friendlyError(NO_FFMPEG_MESSAGE), NO_FFMPEG_MESSAGE);
    });
    await suite.test("错误行的渲染出口仍是 friendlyError(t.error)（结构哨兵）", () => {
      assert.ok(/friendlyError\(t\.error\)/.test(html), "err-text 渲染必须走 friendlyError");
    });

    // ------------------------------------------------------ 结构回归检查
    suite.group("交付文件结构（新交互的端点/接线/esc 哨兵）");

    /** Slice one function body out of the shipped HTML (batch2-render trick). */
    const fnBody = (name) => {
      const start = html.indexOf("function " + name);
      assert.ok(start > 0, "function " + name + " must exist in gui/index.html");
      const chunk = html.slice(start, start + 6000);
      const end = chunk.indexOf(NL + "}");
      assert.ok(end > 0, "function " + name + " must terminate");
      return chunk.slice(0, end);
    };

    await suite.test("侧栏分组容器默认隐藏，filteredTasks 按 queue: 前缀过滤", () => {
      assert.ok(html.includes('id="queueGroup"'), "nav group present");
      assert.ok(/id="queueGroup"[^>]*style="display:none"/.test(html), "默认不占位");
      const ft = fnBody("filteredTasks");
      assert.ok(ft.includes('v.startsWith("queue:")'), "过滤分支存在");
      assert.ok(ft.includes('t.queueId || "default"'), "缺省 queueId 视为 default 组");
    });
    await suite.test("分组导航/计数/标题/空态四处都接了 queue 视图", () => {
      const nav = fnBody("buildQueueNav");
      assert.ok(nav.includes("queue:") && nav.includes("c-queue-"), "导航项与徽标");
      assert.ok(/esc\(g\.name\)/.test(nav) && /esc\(g\.id\)/.test(nav), "导航动态字段过 esc");
      assert.ok(fnBody("renderCounts").includes("c-queue-"), "分组计数");
      const av = fnBody("applyView");
      assert.ok(av.includes('v.startsWith("queue:")'), "视图标题分支");
      assert.ok(fnBody("emptyHint").includes("queue:"), "分组空态提示");
      // 分组被删后不应停在空过滤器上
      assert.ok(nav.includes("setNavView"), "失效视图回落全部");
    });
    await suite.test("设置页 aria2c 路径进入读取与保存链路", () => {
      assert.ok(html.includes('id="cfg-aria2cPath"'), "输入框存在");
      assert.ok(/set\("cfg-aria2cPath",c\.aria2cPath\)/.test(html), "fillConfig 回显");
      assert.ok(/aria2cPath:\s*document\.getElementById\("cfg-aria2cPath"\)\.value\.trim\(\)/.test(html),
        "btnSaveCfg 提交（留空=自动查找）");
      assert.ok(Object.hasOwn(DEFAULT_CONFIG, "aria2cPath"), "必须是真实配置键");
    });
    await suite.test("队列管理区块：增/删/改缓冲，两条保存路径都走 PATCH /api/config", () => {
      assert.ok(html.includes('id="btnQueueAdd"') && html.includes('id="btnQueueSave"'));
      assert.ok(html.includes('id="queueRows"'), "行容器存在");
      const rq = fnBody("renderQueueRows");
      assert.ok(/esc\(r\.name\)/.test(rq) && /esc\(r\.concurrent\)/.test(rq), "行字段过 esc");
      assert.ok(rq.includes("q-del"), "删除按钮");
      const sv = fnBody("sanitizeQueueRows") + fnBody("renderQueueRows");
      assert.ok(sv.includes("state.queueRows"), "表单缓冲驱动");
      // 保存分组按钮的 onclick 与 保存设置 都引用 sanitizeQueueRows 且 PATCH /api/config
      assert.ok(/btnQueueSave"\)\.onclick[\s\S]{0,900}sanitizeQueueRows/.test(html),
        "保存分组先过校验");
      assert.ok(/btnQueueSave"\)\.onclick[\s\S]{0,900}"\/api\/config",\{method:"PATCH"/.test(html),
        "保存分组走既有 PATCH");
      // 保存设置按钮的 onclick 同样先过校验并一并提交分组（锚定 handler 而非按钮标记）
      assert.ok(/btnSaveCfg"\)\.onclick[\s\S]{0,400}sanitizeQueueRows/.test(html),
        "保存设置同样过校验");
      assert.ok(/btnSaveCfg"\)\.onclick[\s\S]{0,2200}queues: qv\.queues/.test(html),
        "保存设置一并提交分组");
    });
    await suite.test("转换对话框：预设四选一、目录默认同目录、提交体来自纯函数", () => {
      assert.ok(html.includes('id="convertOverlay"'), "对话框存在");
      assert.ok(html.includes('id="cv-presets"') && html.includes('id="cv-dir"') && html.includes('id="cv-source"'));
      const rp = fnBody("renderConvertPresets");
      assert.ok(rp.includes("CONVERT_PRESETS") && /esc\(p\.key\)/.test(rp) &&
        /esc\(p\.label\)/.test(rp) && /esc\(p\.desc\)/.test(rp), "预设渲染过 esc");
      const oc = html.slice(html.indexOf("async function openConvertDialog"), html.indexOf("async function openConvertDialog") + 1800);
      assert.ok(oc.includes('/location'), "源路径取自 location 端点（改名后的真实路径）");
      assert.ok(oc.includes("loc.exists"), "源文件已不在原位置时给出提示");
      const ok = html.slice(html.indexOf('cv-btnOk").onclick'), html.indexOf('cv-btnOk").onclick') + 1400);
      assert.ok(ok.includes("convertSubmitBody"), "提交体走纯函数");
      assert.ok(ok.includes("submitNewTask"), "复用既有提交链路（toast/409 对话框/切视图）");
      assert.ok(ok.includes("cv-btnOk"), "提交期间禁用按钮（防双击）");
    });
    await suite.test("完成任务行有“转换…”按钮，onAction 有对应分支", () => {
      const ra = fnBody("rowActionsHtml");
      assert.ok(/t\.status==="complete"\)\s*actions\.push\(abBtn\("film",t\.id,"convert"/.test(ra),
        "完成行才有转换按钮");
      assert.ok(/"转换为其他格式/.test(ra), "按钮标题给足信息");
      const oa = fnBody("onAction");
      assert.ok(oa.includes('action==="convert"') && oa.includes("openConvertDialog"), "动作分支接线");
    });
    await suite.test("magnet 直达接在 openNew 里，复用 submitNewTask", () => {
      assert.ok(fnBody("openNew").includes("isMagnetUrl"), "直达判定");
      assert.ok(html.includes("async function addMagnetDirect"), "直达函数存在");
      const am = html.slice(html.indexOf("async function addMagnetDirect"),
        html.indexOf("async function addMagnetDirect") + 500);
      assert.ok(am.includes("submitNewTask"), "复用提交链路（含 409 已在队列对话框）");
      assert.ok(am.includes("btn.disabled"), "按钮防双击");
      assert.ok(/placeholder="[^"]*magnet/.test(html), "URL 栏提示词包含 magnet");
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
      // 顶层求值跑完 = 所有加载期绑定（含批-4 新接线：转换对话框/队列分组/
      // magnet 直达）无引用错误
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
    process.stderr.write("batch4-gui crashed: " + ((err && err.stack) || err) + NL);
    process.exitCode = 1;
  });
