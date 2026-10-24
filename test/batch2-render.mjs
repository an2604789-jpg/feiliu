// Batch2 W1 regression: task list keyed incremental rendering.
//
// The defect this guards against (界面审查 #1, high): render() rebuilt #rows with
// a single innerHTML assignment on every 2s poll AND every SSE progress frame, so
// text selections were destroyed, drag reordering was swallowed, clicks were
// periodically lost and hover states were interrupted.
//
// The fix reuses row DOM keyed by task id. The automatable part is the decision
// logic, extracted from the shipped gui/index.html itself (same technique as
// test/batch1-gui.mjs) so the test can never drift from the file that renders:
//   (a) rowShape()  — which "shape" a row is in; only a shape change may rebuild
//                     the row's inner prog/actions blocks;
//   (b) rowVals()   — every display value of a row (bar width, meta span texts,
//                     error/merge texts, pill class+text, name/url, checkbox),
//                     with injected formatters so no DOM is needed;
//   (c) diffRowVals() — the per-frame patch must contain ONLY changed fields
//                     (a speed-only progress frame touches exactly one span);
//   (d) diffRowList() — add/remove/order decisions for the keyed sync;
//   (e) structural checks — the wholesale innerHTML rebuild now lives only in
//                     the signature branch (first build / view / search / sort
//                     switch), the incremental path writes leaf nodes only,
//                     DOM ids/classes stay as batch1 and desktop-e2e expect them,
//                     the dragId guard and SSE progress handler are untouched,
//                     and the copy literals of the incremental path match the
//                     rebuild generator (rowProgHtml) so the two cannot drift.
//
// Interactive parts (text selection surviving refresh, drag reorder, hover,
// shift-range checkbox across refreshes) cannot be asserted headless; they are
// smoke steps in the batch2 report.
//
// No server, no daemon, no DOWNLOADX_HOME, nothing written: reads exactly one
// file (gui/index.html). D:/IAM/downloadx-data is never touched.
//
// Usage: node test/batch2-render.mjs

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
  const suite = new Suite("batch2-render");

  const html = fs.readFileSync(path.join(ROOT, "gui", "index.html"), "utf8");

  // ---- extract the keyed-row-sync pure region from the shipped file
  const region = /\/\* ==== GUI-ROWSYNC-START[\s\S]*?GUI-ROWSYNC-END ==== \*\//.exec(html);
  assert.ok(region, "gui/index.html must contain the GUI-ROWSYNC region");
  const R = new Function(
    region[0] + NL + "return { rowShape, rowVals, diffRowVals, diffRowList };"
  )();

  // Deterministic fake formatters: every value is recognisable in assertions.
  const F = {
    bytes: (n) => "B[" + n + "]",
    speed: (n) => "V[" + n + "]",
    dur: (s) => "T[" + Math.round(s) + "]",
    errText: (m) => "E[" + (m || "") + "]",
    name: (t) => t.filename || ("N[" + t.url + "]"),
    statusCn: (st) => "CN[" + st + "]",
  };

  // Baseline task: downloading, known length, 20% done, 100 B/s → eta exactly 8s.
  const T = (over) => Object.assign({
    id: "t1", status: "downloading", url: "https://x/f.mp4", filename: "f.mp4",
    totalBytes: 1000, downloadedBytes: 200, percent: 20, lengthKnown: true, speed: 100,
  }, over);

  /** Slice one function body out of the shipped HTML (same trick as batch1-gui). */
  const fnBody = (name) => {
    const start = html.indexOf("function " + name);
    assert.ok(start > 0, "function " + name + " must exist in gui/index.html");
    const chunk = html.slice(start, start + 6000);
    const end = chunk.indexOf(NL + "}");
    assert.ok(end > 0, "function " + name + " must terminate");
    return chunk.slice(0, end);
  };

  try {
    // ------------------------------------------------------------- rowShape
    suite.group("rowShape：形态判定（只有形态变化才允许行内重建）");

    await suite.test("下载中·已知长度·有速度 → eta 位亮起", () => {
      assert.equal(R.rowShape(T()), "downloading|k|1|0|0|0");
    });
    await suite.test("速度为 0 → 无 eta；connecting 同样算运行中", () => {
      assert.equal(R.rowShape(T({ speed: 0 })), "downloading|k|0|0|0|0");
      assert.equal(R.rowShape(T({ status: "connecting" })), "connecting|k|1|0|0|0");
    });
    await suite.test("流式（总大小未知）→ u 形态，eta 不亮", () => {
      assert.equal(R.rowShape(T({ lengthKnown: false, totalBytes: null, speed: 100 })),
        "downloading|u|0|0|0|0");
    });
    await suite.test("完成带 sha256 / 失败 / 合并备注各有独立形态位", () => {
      assert.equal(R.rowShape(T({ status: "complete", percent: 100, downloadedBytes: 1000, sha256: "abc" })),
        "complete|k|0|1|0|0");
      assert.equal(R.rowShape(T({ status: "complete", percent: 100, downloadedBytes: 1000 })),
        "complete|k|0|0|0|0");
      assert.equal(R.rowShape(T({ status: "error", error: "boom" })), "error|k|0|0|1|0");
      assert.equal(R.rowShape(T({ mergeNote: "muxing" })), "downloading|k|1|0|0|1");
    });
    await suite.test("状态切换改变形态（驱动 prog/actions 两小块重建）", () => {
      assert.notEqual(R.rowShape(T({ status: "paused" })), R.rowShape(T()));
      assert.notEqual(R.rowShape(T({ status: "complete", percent: 100, downloadedBytes: 1000 })), R.rowShape(T()));
    });

    // -------------------------------------------------------------- rowVals
    suite.group("rowVals：行的全部展示值（与重建路径同文案）");

    await suite.test("下载中·已知长度：span 顺序 = 百分比/速度/剩余时间/已下载进度", () => {
      const v = R.rowVals(T(), F, false);
      assert.deepEqual(v.s, ["20.0%", "V[100]", "剩余 T[8]", "B[200] / B[1000]"]);
      assert.equal(v.width, "20.0%");
      assert.equal(v.pillCls, "pill downloading");
      assert.equal(v.pillText, "CN[downloading]");
      assert.equal(v.name, "f.mp4");
      assert.equal(v.nameTitle, "https://x/f.mp4");
      assert.equal(v.url, "https://x/f.mp4");
      assert.equal(v.checked, false);
    });
    await suite.test("速度为 0：不产生剩余时间 span", () => {
      assert.deepEqual(R.rowVals(T({ speed: 0 }), F, true).s,
        ["20.0%", "V[0]", "B[200] / B[1000]"]);
    });
    await suite.test("流式：已接收 + 总大小未知，宽度恒 100%", () => {
      const v = R.rowVals(T({ lengthKnown: false, totalBytes: null, speed: 0 }), F, false);
      assert.deepEqual(v.s, ["已接收 B[200]", "总大小未知（流式传输）"]);
      assert.equal(v.width, "100%");
    });
    await suite.test("完成：大小 + 校验串前 12 位；paused/queued 文案一致", () => {
      assert.deepEqual(
        R.rowVals(T({ status: "complete", percent: 100, downloadedBytes: 1000, sha256: "abcdef123456xyz" }), F, false).s,
        ["100.0%", "B[1000]", "校验 abcdef123456…"]);
      assert.deepEqual(R.rowVals(T({ status: "paused" }), F, false).s,
        ["20.0%", "已保留 B[200] 可断点续传"]);
      assert.deepEqual(R.rowVals(T({ status: "queued", speed: 0 }), F, false).s,
        ["20.0%", "等待下载…"]);
    });
    await suite.test("百分比保留 1 位小数；错误/合并备注文本就位；checked 透传", () => {
      const v = R.rowVals(T({ percent: 37.53, status: "error", error: "EPERM", mergeNote: "mux" }), F, true);
      assert.equal(v.width, "37.5%");
      assert.equal(v.s[0], "37.5%");
      assert.equal(v.errText, "E[EPERM]");
      assert.equal(v.mergeText, "ℹ mux");
      assert.equal(v.checked, true);
    });

    // ----------------------------------------------------------- diffRowVals
    suite.group("diffRowVals：每帧只改变化的叶子");

    await suite.test("完全相同 → null（该帧对该行零 DOM 写入）", () => {
      assert.equal(R.diffRowVals(R.rowVals(T(), F, true), R.rowVals(T(), F, true)), null);
    });
    await suite.test("纯速度帧：只碰速度与剩余时间两个 span（宽度/百分比/大小不动）", () => {
      const a = R.rowVals(T(), F, false);
      const b = R.rowVals(T({ speed: 120 }), F, false);
      assert.equal(a.shape, b.shape, "same shape, patch path");
      // eta = (1000-200)/120 ≈ 6.67s → T[7]；它随速度联动是正确行为
      assert.deepEqual(R.diffRowVals(a, b), { s1: "V[120]", s2: "剩余 T[7]" });
    });
    await suite.test("百分比变化：宽度 + 百分比 span，其余不动", () => {
      const a = R.rowVals(T(), F, false);
      const b = R.rowVals(T({ percent: 30 }), F, false);
      assert.deepEqual(R.diffRowVals(a, b), { width: "30.0%", s0: "30.0%" });
    });
    await suite.test("流式任务推进：只碰“已接收”一个 span，宽度不动", () => {
      const u = (dl) => T({ lengthKnown: false, totalBytes: null, downloadedBytes: dl, speed: 0 });
      assert.deepEqual(
        R.diffRowVals(R.rowVals(u(200), F, false), R.rowVals(u(300), F, false)),
        { s0: "已接收 B[300]" });
    });
    await suite.test("勾选/URL/错误文案各自独立成 diff 字段", () => {
      const base = R.rowVals(T(), F, true);
      assert.deepEqual(R.diffRowVals(base, R.rowVals(T(), F, false)), { checked: false });
      assert.deepEqual(R.diffRowVals(base, R.rowVals(T({ url: "https://x/g.mp4" }), F, true)),
        { nameTitle: "https://x/g.mp4", url: "https://x/g.mp4" });
      const e1 = R.rowVals(T({ status: "error", error: "a" }), F, false);
      const e2 = R.rowVals(T({ status: "error", error: "b" }), F, false);
      assert.equal(e1.shape, e2.shape, "error→error keeps shape, patch path");
      assert.deepEqual(R.diffRowVals(e1, e2), { errText: "E[b]" });
    });
    await suite.test("旧值缺失 → null（防御：不产生写回项）", () => {
      assert.equal(R.diffRowVals(null, R.rowVals(T(), F, false)), null);
    });

    // ----------------------------------------------------------- diffRowList
    suite.group("diffRowList：行的增删与顺序");

    await suite.test("列表不变：无增删、顺序不变", () => {
      assert.deepEqual(R.diffRowList(["a", "b", "c"], ["a", "b", "c"]),
        { removed: [], added: [], orderChanged: false });
    });
    await suite.test("删中间行 / 头部插入新行", () => {
      assert.deepEqual(R.diffRowList(["a", "b", "c"], ["a", "c"]),
        { removed: ["b"], added: [], orderChanged: false });
      assert.deepEqual(R.diffRowList(["a", "b"], ["x", "a", "b"]),
        { removed: [], added: ["x"], orderChanged: false });
    });
    await suite.test("保留行相对顺序变化被识别；整表清空全部为删除", () => {
      assert.equal(R.diffRowList(["a", "b", "c"], ["c", "a", "b"]).orderChanged, true);
      assert.deepEqual(R.diffRowList(["a", "b"], []),
        { removed: ["a", "b"], added: [], orderChanged: false });
    });

    // ------------------------------------------------------------ 结构回归
    suite.group("交付文件结构（增量路径/守卫/DOM 结构）");

    await suite.test("标记区域恰好一份：GUI-PURE 与 GUI-ROWSYNC", () => {
      assert.equal((html.match(/GUI-PURE-START/g) || []).length, 1);
      assert.equal((html.match(/GUI-PURE-END/g) || []).length, 1);
      assert.equal((html.match(/GUI-ROWSYNC-START/g) || []).length, 1);
      assert.equal((html.match(/GUI-ROWSYNC-END/g) || []).length, 1);
    });
    await suite.test("render()：整体 innerHTML 重建只活在签名分支，热路径走 syncRows", () => {
      const src = fnBody("render");
      assert.ok(/rowsSig !== sig/.test(src), "signature branch present");
      assert.equal((src.match(/box\.innerHTML = tasks\.map/g) || []).length, 1,
        "wholesale rebuild appears exactly once");
      assert.ok(/syncRows\(box, tasks\)/.test(src), "incremental path present");
      assert.ok(/rowEls\.clear\(\);\s*rowsSig = null;/.test(src),
        "empty state drops the row cache so the next render rebuilds");
    });
    await suite.test("syncRows：删行走 diffRowList，归位用 insertBefore，零 innerHTML", () => {
      const src = fnBody("syncRows");
      assert.ok(/diffRowList\(/.test(src) && /insertBefore\(/.test(src));
      assert.ok(/buildRow\(t\)/.test(src) && /updateTaskRow\(el, t\)/.test(src));
      assert.ok(!src.includes("innerHTML"), "syncRows must not rebuild #rows");
    });
    await suite.test("updateTaskRow：仅形态变化重建 prog/actions 并重绑按钮，否则只写 diff", () => {
      const src = fnBody("updateTaskRow");
      assert.ok(/v\.shape !== f\.shape/.test(src), "shape gate present");
      assert.equal((src.match(/innerHTML/g) || []).length, 2,
        "only prog+actions may be rebuilt");
      assert.ok(/rowProgHtml\(t\)/.test(src) && /rowActionsHtml\(t\)/.test(src));
      assert.ok(/wireRowActions\(el\)/.test(src), "rebuilt buttons get re-wired");
      assert.ok(/diffRowVals\(v, f\)/.test(src));
    });
    await suite.test("applyRowDiff：只写叶子(textContent/style/title/checked)", () => {
      const src = fnBody("applyRowDiff");
      assert.ok(/style\.width = d\.width/.test(src));
      assert.ok(/textContent = v/.test(src));
      assert.ok(/c\.cb\.checked = d\.checked/.test(src), "checkbox follows state.checkedIds");
      assert.ok(/c\.pill\.className = d\.pillCls/.test(src));
      assert.ok(!src.includes("innerHTML"));
    });
    await suite.test("DOM id/class 结构保留（batch1 与 desktop-e2e 依赖的选择器）", () => {
      const src = fnBody("renderTask");
      for (const cls of ['class="task"', 'class="selbox"', 'class="grip"', 'class="prog"',
        'class="actions"', 'class="pill ', 'class="name"', 'class="url"', "draggable=", 'data-id='])
        assert.ok(src.includes(cls), "renderTask must keep " + cls);
      const prog = fnBody("rowProgHtml");
      for (const cls of ['class="bar ', 'class="pmeta"', 'class="err-text"', 'class="nums"'])
        assert.ok(prog.includes(cls), "rowProgHtml must keep " + cls);
      assert.ok(fnBody("rowActionsHtml").includes("abBtn("), "actions still via abBtn");
      assert.ok(fnBody("abBtn").includes('button class="ab '), "ab button markup unchanged");
    });
    await suite.test("增量与重建两条路径文案同源（哨兵：同一批字面量两处都在）", () => {
      const prog = fnBody("rowProgHtml");
      for (const lit of ["已接收 ", "总大小未知（流式传输）", "剩余 ", "校验 ", "已保留 ", "可断点续传", "等待下载…"]) {
        assert.ok(prog.includes(lit), "rowProgHtml keeps literal: " + lit);
        assert.ok(region[0].includes(lit), "GUI-ROWSYNC (rowVals) must carry the same literal: " + lit);
      }
    });
    await suite.test("拖拽：逐行接线，drop 目标序号从 .rows 实时取", () => {
      assert.ok(/function wireDrag\(scope\)\{\s*scope\.querySelectorAll\("\.task"\)\.forEach\(wireDragRow\);\s*\}/.test(html),
        "wireDrag delegates to wireDragRow");
      const src = fnBody("wireDragRow");
      assert.ok(/row\.closest\("\.rows"\)/.test(src), "drop resolves the whole list at event time");
      assert.ok(/"\/move"/.test(src), "move endpoint unchanged");
    });
    await suite.test("复选框：单框接线，Shift 范围选择覆盖整个列表", () => {
      const src = fnBody("wireSelBoxEl");
      assert.ok(/cb\.closest\("\.rows"\) \|\| document/.test(src));
      assert.ok(/e\.shiftKey && state\.lastCheckId/.test(src));
      assert.ok(/state\.checkedIds\.add\(ids\[i\]\)/.test(src));
    });
    await suite.test("refresh 的 dragId 守卫与 SSE progress→render() 保持原样", () => {
      assert.ok(/if \(dragId\) return;/.test(html), "drag-in-progress skips refresh");
      const i = html.indexOf('msg.type==="progress"');
      assert.ok(i > 0, "SSE progress handler present");
      const blk = html.slice(i, i + 700);
      assert.ok(blk.includes("t.percent="), "progress mutates the task in place");
      assert.ok(blk.includes("render()"), "progress still re-renders (now incremental)");
    });
    await suite.test("内联脚本零依赖纪律不回退（无 require/import/process）", () => {
      assert.ok(!/require\(/.test(html));
      const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
      assert.ok(!/(^|[^.\w])import\s*['"(\w]/m.test(script));
      assert.ok(!/\bprocess\.\b/.test(script));
    });
  } finally {
    // nothing to tear down: no server, no timers, no files written
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch2-render crashed: " + ((err && err.stack) || err) + NL);
    process.exitCode = 1;
  });
