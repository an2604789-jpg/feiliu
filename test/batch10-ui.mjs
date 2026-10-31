// test/batch10-ui.mjs — 批-10 UI 回归（W1:P0 快赢三件 + 通知拉起兜底）
//
// 覆盖（全部纯源级/抠段求值，零服务器、零文件写入、零进程操作）：
//   1. friendlyError 三新模式（429 / EPROTO / 503），每个给“下一步”；
//      顺序钉死：429 不被 404/401 先吃，EPROTO 不被证书/TLS 行先吃；旧样例不回归。
//   2. 行内按钮（rowActionsHtml/abBtn）状态可见性矩阵 + .with-text 短文字。
//   3. 任务卡右键菜单 [ui-pure] 纯函数 taskMenuItems 的状态→项矩阵，
//      与 desktop/main.mjs 的 [task-menu-fallback] 兜底副本逐状态同语义。
//   4. menu:taskActions 通道 / preload 暴露 / contextmenu 绑定 / focus-app
//      兜底拉起（消费等待、注册表定位、LOCALAPPDATA 兜底、--no-sandbox）源级断言。
//
// host.mjs 只被 import 其纯导出（GUI_EXE_NAME/pickInstalledGuiDir/decodeConsoleOutput），
// 不触碰 stdio 循环；DOWNLOADX_HOME 一律指向临时目录，绝不读生产数据根。
//
// Usage: node test/batch10-ui.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

// 硬纪律：本测试进程若碰 paths 必须落在临时目录，绝不指向生产数据根。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx10-ui-home-"));
process.env.DOWNLOADX_HOME = TMP_HOME;
process.on("exit", () => { try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* 尽力而为 */ } });

import { Suite } from "./harness.mjs";
const host = await import("../extension/host.mjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NL = String.fromCharCode(10);

const html = fs.readFileSync(path.join(ROOT, "gui", "index.html"), "utf8");
const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "desktop", "main.mjs"), "utf8");
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, "desktop", "preload.cjs"), "utf8");
const HOST_SRC = fs.readFileSync(path.join(ROOT, "extension", "host.mjs"), "utf8");

// ---- 抠段求值 ----------------------------------------------------------------

function sliceFn(src, re, name) {
  const m = re.exec(src);
  assert.ok(m, "gui/index.html 里找不到 " + name);
  return m[0];
}

// friendlyError 在标记段之外，按函数体切片（与 batch4-gui 同款正则）。
const friendlyError = new Function(
  sliceFn(html, /function friendlyError\([\s\S]*?\n\}/, "friendlyError") + NL + "return friendlyError;")();

// 行内按钮可见性矩阵：rowActionsHtml + abBtn + icon + ICONS + esc 原样切片，
// DESKTOP 以参数注入（完成态的“打开文件/文件夹”按钮只在桌面容器出现）。
function loadRowActions(desktop) {
  const pieces = [
    sliceFn(html, /function esc\(s\)\{[\s\S]*?\n\}/, "esc"),
    sliceFn(html, /const ICONS = \{[\s\S]*?\n\};/, "ICONS"),
    sliceFn(html, /function icon\(name\)\{[^\n]*\}/, "icon"),
    sliceFn(html, /function abBtn\([\s\S]*?\n\}/, "abBtn"),
    sliceFn(html, /function rowActionsHtml\([\s\S]*?\n\}/, "rowActionsHtml"),
  ].join(NL);
  return new Function("DESKTOP", pieces + NL + "return rowActionsHtml;")(desktop);
}

// [ui-pure]：菜单可见性纯函数（主进程运行期也从这里提取）+ W2 粘贴/待审纯函数。
const uiPureMatch = /\/\/ \[ui-pure\] begin[^\n]*\r?\n([\s\S]*?)\/\/ \[ui-pure\] end/.exec(html);
const uiPure = uiPureMatch ? new Function(uiPureMatch[1] + NL +
  "return { taskMenuItems, planPasteAction, firstUrlLine, findLiveTaskUrl, pendCountdownText, pendBannerVisibleFor };")() : null;

// [task-menu-fallback]：main.mjs 的同语义兜底副本。
const fallbackMatch = /\/\/ \[task-menu-fallback\] begin\r?\n([\s\S]*?)\/\/ \[task-menu-fallback\] end/.exec(MAIN_SRC);
const menuFallback = fallbackMatch ? new Function(fallbackMatch[1] + NL + "return { taskMenuItemsFallback };")() : null;

async function main() {
  const suite = new Suite("batch10-ui");

  // ======================================================= friendlyError
  suite.group("friendlyError 三新模式（429/EPROTO/503），每个带下一步");

  await suite.test("429 → 限流文案，且给出连接数/代理出路", () => {
    const m = friendlyError("HTTP 429 Too Many Requests");
    assert.match(m, /429/);
    assert.match(m, /重试/);
    assert.match(m, /连接数|代理/);
    assert.doesNotMatch(m, /404|认证/);
  });
  await suite.test("EPROTO wrong version number → 代理隧道出路，不被证书行先吃", () => {
    // OpenSSL 报错常带 "SSL routines" 字样：证书分支在后面，必须让位。
    const m = friendlyError("Request failed: EPROTO 0A00010B:SSL routines:ssl3_get_record:wrong version number");
    assert.match(m, /EPROTO/);
    assert.match(m, /代理|SOCKS5|端口/);
    assert.doesNotMatch(m, /证书校验失败/);
  });
  await suite.test("503 → 服务暂不可用（任务 error 字符串路径）", () => {
    const m = friendlyError("HTTP 503 Service Unavailable");
    assert.match(m, /503/);
    assert.match(m, /稍后重试/);
  });
  await suite.test("旧样例不回归（空间/拒绝/404/未知串透传）", () => {
    assert.match(friendlyError("ENOSPC: no space left on device"), /磁盘空间不足/);
    assert.match(friendlyError("connect ECONNREFUSED 1.2.3.4:443"), /拒绝连接/);
    assert.match(friendlyError("HTTP 404 Not Found"), /404/);
    assert.equal(friendlyError("plain weird failure"), "plain weird failure");
  });
  await suite.test("顺序钉死：429 在 404/401 之前，EPROTO 在证书行之前（源级）", () => {
    const body = /function friendlyError\([\s\S]*?\n\}/.exec(html)[0];
    const at = (re) => { const m = re.exec(body); assert.ok(m, re + " 应存在"); return m.index; };
    const i429 = at(/429\|too many requests/);
    const iEproto = at(/EPROTO\|wrong version number/);
    const i503 = at(/503\|service unavailable/);
    const iCert = at(/certificate\|证书/);
    const i404 = at(/404\|not found/);
    const i401 = at(/401\|403\|unauthorized/);
    assert.ok(i429 < i404 && i429 < i401, "429 必须先判");
    assert.ok(iEproto < iCert, "EPROTO 必须先于证书/TLS 判定");
    assert.ok(i503 < i404, "503 必须先于 404 判定");
  });

  // ======================================================= 行内按钮短文字
  suite.group("rowActionsHtml 状态可见性矩阵（.with-text 短文字去神秘化）");

  const parse = (htmlOut) => [...htmlOut.matchAll(/<button class="ab ([^"]*)" data-a="([a-zA-Z]+)"[^>]*>([\s\S]*?)<\/button>/g)]
    .map((m) => ({ cls: m[1], action: m[2], inner: m[3] }));
  const actionsOf = (t) => parse(loadRowActions(true)(t)).map((b) => b.action);
  const hasText = (t, action, text) => {
    const btn = parse(loadRowActions(true)(t)).find((b) => b.action === action);
    assert.ok(btn, action + " 按钮应存在");
    assert.match(btn.cls, /with-text/, action + " 应带 with-text 类");
    assert.match(btn.inner, new RegExp('<span class="t">' + text + "</span>"),
      action + ' 应带短文字“' + text + "”");
  };
  const iconOnly = (t, action) => {
    const btn = parse(loadRowActions(true)(t)).find((b) => b.action === action);
    assert.ok(btn, action + " 按钮应存在");
    assert.doesNotMatch(btn.cls, /with-text/, action + " 应保持纯图标");
    assert.doesNotMatch(btn.inner, /<span class="t">/, action + " 不应带文字");
  };

  await suite.test("downloading/connecting/queued：暂停（带字），无继续/重试/打开类", () => {
    for (const status of ["downloading", "connecting", "queued"]) {
      const a = actionsOf({ status });
      assert.ok(a.includes("pause"), status + " 应有暂停");
      assert.ok(!a.includes("start") && !a.includes("retry"), status + " 不应有继续/重试");
      assert.ok(!a.includes("openFile") && !a.includes("showFolder"), status + " 不应有打开类");
      hasText({ status }, "pause", "暂停");
    }
  });
  await suite.test("paused：继续（带字），无暂停", () => {
    const a = actionsOf({ status: "paused" });
    assert.ok(a.includes("start") && !a.includes("pause"));
    hasText({ status: "paused" }, "start", "继续");
  });
  await suite.test("error：重试（带字），无暂停/继续", () => {
    const a = actionsOf({ status: "error" });
    assert.ok(a.includes("retry") && !a.includes("pause") && !a.includes("start"));
    hasText({ status: "error" }, "retry", "重试");
  });
  await suite.test("complete（桌面）：打开文件夹（带字）；打开文件保持图标；无取消", () => {
    const a = actionsOf({ status: "complete" });
    assert.ok(a.includes("showFolder") && a.includes("openFile") && a.includes("convert"));
    assert.ok(!a.includes("cancel"));
    hasText({ status: "complete" }, "showFolder", "打开文件夹");
    iconOnly({ status: "complete" }, "openFile");
    iconOnly({ status: "complete" }, "convert");
    iconOnly({ status: "complete" }, "copyLink");
    iconOnly({ status: "complete" }, "remove");
  });
  await suite.test("complete（浏览器）：无打开文件/文件夹（DESKTOP 门）", () => {
    const a = parse(loadRowActions(false)({ status: "complete" })).map((b) => b.action);
    assert.ok(!a.includes("openFile") && !a.includes("showFolder"));
  });
  await suite.test("互斥钉死：任一状态里暂停与继续绝不同时出现", () => {
    for (const status of ["downloading", "connecting", "queued", "paused", "error", "complete"]) {
      const a = actionsOf({ status });
      assert.ok(!(a.includes("pause") && a.includes("start")), status);
    }
  });
  await suite.test(".with-text 样式存在且禁止换行（源级）", () => {
    assert.match(html, /\.ab\.with-text\{[^}]*white-space:nowrap/);
    assert.match(html, /\.actions\{display:flex;gap:3px;flex-wrap:nowrap;\}/);
  });

  // ======================================================= 右键菜单纯函数
  suite.group("[ui-pure] taskMenuItems 状态→项矩阵（右键菜单可见性）");

  await suite.test("标记段存在且恰好一份", () => {
    assert.ok(uiPureMatch, "gui/index.html 里找不到 [ui-pure] 标记段");
    assert.equal((html.match(/\[ui-pure\] begin/g) || []).length, 1);
    assert.equal((html.match(/\[ui-pure\] end/g) || []).length, 1);
    assert.equal(typeof uiPure.taskMenuItems, "function");
  });
  const seq = (status) => uiPure.taskMenuItems(status).map((i) => i.action);
  await suite.test("进行中/排队：暂停+取消+复制链接+删除", () => {
    for (const s of ["downloading", "connecting", "queued"]) {
      assert.deepEqual(seq(s), ["pause", "cancel", "copyLink", "remove"], s);
    }
  });
  await suite.test("已暂停：继续+取消+复制链接+删除；失败：重试+取消+复制链接+删除", () => {
    assert.deepEqual(seq("paused"), ["start", "cancel", "copyLink", "remove"]);
    assert.deepEqual(seq("error"), ["retry", "cancel", "copyLink", "remove"]);
  });
  await suite.test("已完成：打开文件+打开文件夹+复制链接+删除，无取消", () => {
    assert.deepEqual(seq("complete"), ["openFile", "showFolder", "copyLink", "remove"]);
  });
  await suite.test("未知状态不炸：回落到取消+复制链接+删除", () => {
    assert.deepEqual(seq("weird"), ["cancel", "copyLink", "remove"]);
    assert.deepEqual(seq(""), ["cancel", "copyLink", "remove"]);
  });
  await suite.test("动作名与行内按钮 data-a 同一词汇表", () => {
    const known = new Set(["pause", "start", "retry", "cancel", "openFile", "showFolder", "copyLink", "remove"]);
    for (const s of ["downloading", "connecting", "queued", "paused", "error", "complete"]) {
      for (const a of seq(s)) assert.ok(known.has(a), s + ":" + a);
    }
  });

  await suite.test("菜单每个动作名都能被 onAction 字面分发(防 405 死项复发)", () => {
    // 收口教训:complete 态曾用 "openFolder" 而 onAction 只认 "showFolder",
    // 点击落到 daemon 405「该操作当前版本不支持」。这里不维护白名单——
    // 直接要求每个动作名在 onAction 源里以字符串字面出现(普通分支的
    // pause/start/retry 经 "/"+action 动态拼接,字面落在 toast map 里,
    // 同样算数)。取窗到下一个顶层 async function,防 [\s\S]*? 提前截断。
    const start = html.indexOf("async function onAction(action,id){");
    assert.ok(start >= 0, "onAction 应存在于 gui/index.html");
    const next = html.indexOf("\nasync function ", start + 10);
    const body = html.slice(start, next === -1 ? html.length : next);
    for (const s of ["downloading", "connecting", "queued", "paused", "error", "complete"]) {
      for (const a of seq(s)) {
        // 三种合法形态:字符串字面("pause"/'pause')或普通分支的映射裸键(pause:)
        const ok = body.includes('"' + a + '"') || body.includes("'" + a + "'") || body.includes(a + ":");
        assert.ok(ok, "onAction 无法分发 \"" + a + "\"(菜单死项)");
      }
    }
  });

  suite.group("menu:taskActions 通道与同语义兜底（源级）");

  await suite.test("desktop/main.mjs 注册 menu:taskActions，Menu 在主进程构建", () => {
    assert.match(MAIN_SRC, /ipcMain\.handle\("menu:taskActions"/);
    const h = /ipcMain\.handle\("menu:taskActions"[\s\S]*?\n\}\);/.exec(MAIN_SRC);
    assert.ok(h, "处理函数体应存在");
    assert.match(h[0], /Menu\.buildFromTemplate/);
    assert.match(h[0], /menu\.popup\(/);
    assert.match(h[0], /clicked = String\(it\.action/);
  });
  await suite.test("主进程运行期引用 gui 的 [ui-pure] 段（读文件提取求值），并有兜底", () => {
    assert.match(MAIN_SRC, /gui",\s*"index\.html"/);
    // main.mjs 的提取正则里标记写作 \[ui-pure\]（转义形式），断言按原样匹配
    assert.ok(MAIN_SRC.includes("\\[ui-pure\\] begin"), "main.mjs 必须引用 [ui-pure] 标记段");
    assert.match(MAIN_SRC, /new Function\(m\[1\]/);
    assert.match(MAIN_SRC, /taskMenuItemsFallback/);
  });
  await suite.test("preload.cjs 暴露 taskActions → invoke(\"menu:taskActions\")", () => {
    assert.match(PRELOAD_SRC, /taskActions:\s*\(info\)\s*=>\s*ipcRenderer\.invoke\("menu:taskActions"/);
  });
  await suite.test("gui 在 #rows 上委托绑定 contextmenu，动作回放 onAction 单一入口", () => {
    assert.match(script, /getElementById\("rows"\)\.addEventListener\("contextmenu"/);
    assert.match(script, /window\.downloadx\.taskActions\(/);
    assert.match(script, /if \(action\) onAction\(action, id\)/);
    assert.match(script, /e\.preventDefault\(\)/);
  });
  await suite.test("兜底副本与 [ui-pure] 逐状态同语义", () => {
    assert.ok(menuFallback, "main.mjs 里找不到 [task-menu-fallback] 标记段");
    for (const s of ["downloading", "connecting", "queued", "paused", "error", "complete", "weird", ""]) {
      assert.deepEqual(menuFallback.taskMenuItemsFallback(s), uiPure.taskMenuItems(s), "状态 " + s);
    }
  });

  // ======================================================= 失败视图全部重试
  suite.group("失败视图「全部重试」");

  await suite.test("按钮存在、默认 hidden、仅 error 视图显示（源级）", () => {
    assert.match(html, /id="btnRetryAll"[^>]*hidden/);
    const js = /function updateRetryAllVis\(\)\{[\s\S]*?\n\}/.exec(script);
    assert.ok(js, "updateRetryAllVis 应存在");
    assert.match(js[0], /state\.view !== "error"/);
    assert.match(script, /applyView\(\)\{[\s\S]{0,200}updateRetryAllVis\(\);/, "applyView 必须调用可见性开关");
  });
  await suite.test("行为走批量条同款 retry 通道，执行中禁用防双击（源级）", () => {
    const h = /getElementById\("btnRetryAll"\)\.onclick = async \(\) => \{[\s\S]*?\n\};/.exec(script);
    assert.ok(h, "btnRetryAll onclick 应存在");
    const body = h[0];
    assert.match(body, /filteredTasks\(\)\.filter\(\(t\)=>t\.status==="error"\)/, "只重试当前失败视图内的 error 任务");
    assert.match(body, /\/retry",\s*\{\s*method:"POST"\s*\}\)/, "与 data-batch=retry 同通道 POST /api/tasks/:id/retry");
    assert.match(body, /btn\.disabled = true/, "执行中禁用");
    assert.match(body, /finally[\s\S]*?btn\.disabled = false/, "finally 里恢复");
    assert.match(body, /refresh\(\)/);
  });

  // ======================================================= focus-app 兜底拉起
  suite.group("focus-app 兜底拉起（通知点击必须拉起界面）");

  await suite.test("写完 focus.show 后进入消费等待，等待 3s、步进 250ms", () => {
    assert.equal(host.FOCUS_CONSUME_WAIT_MS, 3000);
    assert.equal(host.FOCUS_CONSUME_POLL_MS, 250);
    assert.match(HOST_SRC, /case "focus-app":[\s\S]{0,800}raiseDesktopOrSpawn\(focusFile\)/,
      "focus-app 分支必须调用兜底流程");
    assert.match(HOST_SRC, /while \(Date\.now\(\) < deadline\)[\s\S]{0,200}fileExists\(focusFile\)/,
      "必须轮询 focus.show 是否已被 desktop 消费");
    assert.match(HOST_SRC, /const deadline = Date\.now\(\) \+ FOCUS_CONSUME_WAIT_MS;/);
  });
  await suite.test("先查 HKCU 卸载表（DisplayName 飞流/feiliu → InstallLocation），兜底 %LOCALAPPDATA%\\Programs", () => {
    assert.match(HOST_SRC, /HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall/);
    assert.match(HOST_SRC, /InstallLocation/);
    assert.match(HOST_SRC, /DisplayName/);
    assert.match(HOST_SRC, /process\.env\.LOCALAPPDATA[\s\S]{0,120}"Programs"/);
  });
  await suite.test("兜底 spawn：detached + stdio ignore + --no-sandbox + unref", () => {
    assert.match(HOST_SRC, /spawn\(exe,\s*\["--no-sandbox"\],\s*\{\s*detached:\s*true,\s*stdio:\s*"ignore"\s*\}\)/,
      "本机未签名 Electron 必须 --no-sandbox");
    assert.match(HOST_SRC, /child\.unref\(\)/);
    assert.match(HOST_SRC, /child\.on\("error"/);
  });
  await suite.test("非 Windows 或找不到安装路径时保持现行为（返回 null，文件留在盘上）", () => {
    assert.match(HOST_SRC, /if \(process\.platform !== "win32"\) return null;/);
    assert.match(HOST_SRC, /installed GUI not found[\s\S]{0,120}left in place/);
  });
  await suite.test("应答不等待：focus-app 立即 ok，兜底后台跑", () => {
    const h = /case "focus-app": \{[\s\S]*?\n    \}/.exec(HOST_SRC);
    assert.ok(h, "focus-app 分支应存在");
    assert.match(h[0], /return \{ ok: true \};/);
    assert.match(h[0], /void raiseDesktopOrSpawn/);
  });
  await suite.test("纯件：GUI 名常量、Programs 目录挑选、GBK 控制台解码", () => {
    assert.equal(host.GUI_EXE_NAME, "飞流下载器.exe");
    assert.equal(host.pickInstalledGuiDir(["a", "飞流下载器", "b"]), "飞流下载器");
    assert.equal(host.pickInstalledGuiDir(["A", "feiliu GUI"]), "feiliu GUI");
    assert.equal(host.pickInstalledGuiDir(["a", "b"]), null);
    assert.equal(host.pickInstalledGuiDir(null), null);
    // reg.exe 在中文 Windows 输出 GBK：飞流下载器 的 GBK 字节必须解回原文
    const gbk = Buffer.from([0xB7, 0xC9, 0xC1, 0xF7, 0xCF, 0xC2, 0xD4, 0xD8, 0xC6, 0xF7]);
    assert.equal(host.decodeConsoleOutput(gbk), "飞流下载器");
    assert.match(host.GUI_NAME_RE.source, /feiliu/);
  });

  // ======================================================= W2 侧栏分层
  suite.group("W2 侧栏分层：常用 / 可折叠高级（源级）");

  await suite.test("任务视图 5 项原样保留", () => {
    for (const v of ["all", "active", "queued", "complete", "error"]) {
      assert.match(html, new RegExp('data-view="' + v + '"'), v);
    }
  });
  await suite.test("常用四项保持一级，高级三项收进默认收起的折叠分组", () => {
    const iTitle = html.indexOf('<div class="nav-title">常用</div>');
    assert.ok(iTitle > 0, "工具组标题应为“常用”");
    for (const v of ["page:settings", "page:discover", "page:history", "page:schedule"]) {
      const i = html.indexOf('data-view="' + v + '"');
      assert.ok(i > iTitle && i < html.indexOf("advToolsToggle"), v + " 应在常用一级");
    }
    const iToggle = html.indexOf('id="advToolsToggle"');
    assert.ok(iToggle > 0, "高级分组开关应存在");
    assert.match(html, /<button class="nav-group-toggle" id="advToolsToggle" aria-expanded="false"/,
      "开关应为 button 且默认收起（aria-expanded=false）");
    assert.ok(html.includes(">高级</span>"), "分组标题“高级”");
    const sub = /<div class="nav-sub" id="advToolsGroup" hidden>([\s\S]*?)<\/div>\s*<\/div>\s*<\/nav>/.exec(html)
      || /<div class="nav-sub" id="advToolsGroup" hidden>([\s\S]*?)<\/div>/.exec(html);
    assert.ok(sub, "高级折叠容器应存在且 hidden");
    for (const v of ["page:capture", "page:agent", "page:log"]) {
      assert.ok(sub[0].includes('data-view="' + v + '"'), v + " 应收进高级分组");
    }
  });
  await suite.test("开关联动：setAdvToolsOpen 切换 hidden/aria-expanded；点到组内页面自动展开", () => {
    const js = /function setAdvToolsOpen\(open\)\{[\s\S]*?\n\}/.exec(script);
    assert.ok(js, "setAdvToolsOpen 应存在");
    assert.match(js[0], /box\.hidden = !open/);
    assert.match(js[0], /setAttribute\("aria-expanded"/);
    assert.match(script, /getElementById\("advToolsToggle"\)\.onclick/);
    assert.match(script, /applyView\(\)\{[\s\S]{0,400}page:\(capture\|agent\|log\)/,
      "applyView 必须在进入高级页面时自动展开");
  });

  // ======================================================= W2 设置页折叠
  suite.group("W2 设置页：常用卡片一级 + 高级折叠（localStorage 持久）");

  await suite.test("常用三卡（保存位置/性能/队列分组）在折叠区外", () => {
    const iOpen = html.indexOf('<div id="cfgAdvCards" hidden>');
    assert.ok(iOpen > 0, "高级折叠区应存在且默认 hidden");
    for (const t of ["下载位置与文件", "性能与并发", "队列分组"]) {
      const i = html.indexOf("<h3>" + t + "</h3>");
      assert.ok(i > 0 && i < iOpen, t + " 应保持在常用区");
    }
  });
  await suite.test("网络与安全/自动行为/浏览器接管/媒体处理与外部引擎收进折叠区", () => {
    const region = /<div id="cfgAdvCards" hidden>([\s\S]*?)<\/div><!-- \/cfgAdvCards/.exec(html);
    assert.ok(region, "折叠区应有闭合注释配对");
    for (const t of ["网络与安全", "自动行为", "浏览器接管", "媒体处理与外部引擎"]) {
      assert.ok(region[0].includes("<h3>" + t + "</h3>"), t + " 应收进高级折叠区");
    }
  });
  await suite.test("保存/恢复按钮留在折叠区外；折叠状态存 localStorage（重启保持）", () => {
    const iClose = html.indexOf("</div><!-- /cfgAdvCards");
    const iSave = html.indexOf('id="btnSaveCfg"');
    assert.ok(iClose > 0 && iSave > iClose, "form-actions 必须在折叠区之后（任何折叠状态都可见）");
    const js = /function setCfgAdvOpen\(open\)\{[\s\S]*?\n\}/.exec(script);
    assert.ok(js, "setCfgAdvOpen 应存在");
    assert.match(js[0], /localStorage\.setItem\("dx-cfg-adv-open"/);
    const init = /\(function initCfgAdv\(\)\{[\s\S]*?\n\}\)\(\);/.exec(script);
    assert.ok(init, "initCfgAdv 应存在");
    assert.match(init[0], /saved === "1"/, "默认收起（仅显式 '1' 才展开）");
    assert.match(script, /getElementById\("cfgAdvToggle"\)\.onclick/);
  });

  // ======================================================= W2 粘贴即下
  suite.group("W2 粘贴即下：决策纯函数三分支 + 快捷行接线");

  await suite.test("planPasteAction：http(s) → probe；magnet/ftp/非链接/空 → 不动作", () => {
    assert.deepEqual(uiPure.planPasteAction("https://a/f.zip", null), { action: "probe", url: "https://a/f.zip" });
    assert.deepEqual(uiPure.planPasteAction("HTTP://A/F.ZIP", null), { action: "probe", url: "HTTP://A/F.ZIP" });
    // 剪贴板常带换行：取首个非空行
    assert.deepEqual(uiPure.planPasteAction("\n  https://a/f.zip \n垃圾尾行", null),
      { action: "probe", url: "https://a/f.zip" });
    assert.deepEqual(uiPure.planPasteAction("magnet:?xt=urn:btih:abc", null), { action: "none", url: "" });
    assert.deepEqual(uiPure.planPasteAction("ftp://h/f", null), { action: "none", url: "" });
    assert.deepEqual(uiPure.planPasteAction("", null), { action: "none", url: "" });
    assert.deepEqual(uiPure.planPasteAction("   \n  ", null), { action: "none", url: "" });
    assert.deepEqual(uiPure.planPasteAction("随便一段文本", null), { action: "none", url: "" });
  });
  await suite.test("planPasteAction：同一 URL 命中上次成功探测 → reuse（不重复探测）", () => {
    const cache = { url: "https://a/f.zip", result: { filename: "f.zip", totalBytes: 10 } };
    assert.deepEqual(uiPure.planPasteAction("https://a/f.zip", cache), { action: "reuse", url: "https://a/f.zip" });
    assert.equal(uiPure.planPasteAction("https://a/other.zip", cache).action, "probe");
    assert.equal(uiPure.planPasteAction("https://a/f.zip", { url: "https://a/f.zip", result: null }).action,
      "probe", "缓存无结果不 reuse");
    assert.equal(uiPure.planPasteAction("https://a/f.zip", null).action, "probe");
  });
  await suite.test("findLiveTaskUrl：在途判定与 host.mjs LIVE_TASK_STATUSES 同语义", () => {
    const tasks = [
      { url: "https://a/1", status: "queued" },
      { url: "https://a/2", status: "downloading" },
      { url: "https://a/3", status: "paused" },
      { url: "https://a/4", status: "connecting" },
      { url: "https://a/5", status: "error" },
      { url: "https://a/6", status: "complete" },
    ];
    for (const t of tasks.slice(0, 4)) assert.ok(uiPure.findLiveTaskUrl(tasks, t.url), t.status + " 在途");
    assert.equal(uiPure.findLiveTaskUrl(tasks, "https://a/5"), null, "error 允许重新下载");
    assert.equal(uiPure.findLiveTaskUrl(tasks, "https://a/6"), null, "complete 允许重新下载");
    assert.equal(uiPure.findLiveTaskUrl([], "https://a/1"), null);
    assert.equal(uiPure.findLiveTaskUrl(null, "https://a/1"), null);
  });
  await suite.test("接线：paste 300ms 防抖 → /api/probe；快捷行按钮齐备；输入改动即收起", () => {
    assert.match(script, /getElementById\("urlInput"\)\.addEventListener\("paste"/);
    assert.match(script, /pasteTimer = setTimeout\(\(\)\=>\{ void runUrlQuickProbe\(\); \}, 300\)/, "300ms 防抖");
    const block = /async function runUrlQuickProbe\(\)\{[\s\S]*?\n\}/.exec(script);
    assert.ok(block, "runUrlQuickProbe 应存在");
    assert.match(block[0], /api\("\/api\/probe", \{ method:"POST", body:\{ url \} \}\)/, "探测走 m-probe 同款通道");
    assert.match(block[0], /r\.excluded \|\| r\.error/, "例外/失败不显示快捷行");
    assert.match(script, /function renderQuickRow\(url, r\)\{[\s\S]*?qrStart[\s\S]*?qrMore/);
    assert.match(script, /await submitNewTask\(body\)/, "开始下载复用 submitNewTask（409 对话框/清空输入框/切全部）");
    assert.match(script, /qrMore"\)\.onclick = \(\)=>\{ hideQuickRow\(\); openNew\(\); \}/, "更多选项照旧 openNew");
    assert.match(script, /firstUrlLine\(document\.getElementById\("urlInput"\)\.value\) !== lastUrlProbe\.url/,
      "输入内容与快捷行 URL 不一致即收起");
    // 同 URL 在途 → 快捷行提示（复用 409 文案，全文至少两处：readableError + 快捷行）
    assert.ok((html.match(/已在队列中：同一链接的任务正在进行。/g) || []).length >= 2,
      "409 文案应在快捷行复用");
  });

  // ======================================================= W2 待确认区块
  suite.group("W2 待确认区块：倒计时/视图范围/行内批准拒绝/badge 并入");

  await suite.test("倒计时文案纯函数：mm:ss（向上取整），到点/过期/无效 → 已超时", () => {
    const now = 1700000000000;
    assert.equal(uiPure.pendCountdownText(now + 90000, now), "01:30");
    assert.equal(uiPure.pendCountdownText(now + 90100, now), "01:31", "向上取整");
    assert.equal(uiPure.pendCountdownText(now + 4500, now), "00:05", "向上取整");
    assert.equal(uiPure.pendCountdownText(now + 60000, now), "01:00");
    assert.equal(uiPure.pendCountdownText(now + 3661000, now), "61:01", "超过 1 小时按累计分钟");
    assert.equal(uiPure.pendCountdownText(now, now), "已超时");
    assert.equal(uiPure.pendCountdownText(now - 1, now), "已超时");
    assert.equal(uiPure.pendCountdownText(NaN, now), "已超时");
    assert.equal(uiPure.pendCountdownText(null, now), "已超时");
    assert.equal(uiPure.pendCountdownText(undefined, now), "已超时");
  });
  await suite.test("视图范围纯函数：仅 全部/队列/失败 显示", () => {
    for (const v of ["all", "queued", "error"]) assert.equal(uiPure.pendBannerVisibleFor(v), true, v);
    for (const v of ["active", "complete", "cat:video", "queue:work", "page:settings", "", undefined]) {
      assert.equal(uiPure.pendBannerVisibleFor(v), false, String(v));
    }
  });
  await suite.test("渲染接线：空/不在视图整块隐藏并停表；行含 URL+文件名+倒计时+批准/拒绝", () => {
    const body = /function renderPendBanner\(\)\{[\s\S]*?\n\}/.exec(script);
    assert.ok(body, "renderPendBanner 应存在");
    assert.match(body[0], /pendBannerVisibleFor\(state\.view\)/, "可见性走纯函数");
    assert.match(body[0], /stopPendTimer\(\)/, "隐藏时停掉倒计时定时器");
    assert.match(body[0], /class="pend-url" data-ap=/, "URL（截断展示，title 全文）且可点开审批模态");
    assert.match(body[0], /p\.filename \? '<span class="pend-name"/, "文件名有则显");
    assert.match(body[0], /class="pend-cd" data-expires=/, "倒计时节点");
    assert.match(body[0], /title="按待审时记录的文件名与目录直接加入队列">批准</, "行内[批准]");
    assert.match(body[0], /class="btn danger" data-rj="[^"]*">拒绝</, "行内[拒绝]");
    assert.ok(!/scrollIntoView|\.focus\(\)/.test(body[0]), "淡入显示绝不滚动抢焦点");
  });
  await suite.test("倒计时定时器：每秒刷新，且仅区块可见时运行", () => {
    assert.match(script, /pendCdTimer = setInterval\(pendTick, 1000\)/, "每秒刷新");
    const start = /function startPendTimer\(\)\{[\s\S]*?\n\}/.exec(script);
    const stop = /function stopPendTimer\(\)\{[\s\S]*?\n\}/.exec(script);
    assert.ok(start && stop, "start/stop 应成对存在");
    assert.match(start[0], /if \(pendCdTimer\) return;/, "不重复起表");
    assert.match(stop[0], /clearInterval\(pendCdTimer\)/);
    assert.match(script, /function pendTick\(\)\{[\s\S]*?pendCountdownText\(Number\(el\.dataset\.expires\), now\)/,
      "刻度用纯函数按 expiresAt-now 算");
  });
  await suite.test("行内直接批准走既有 approve 端点，成功/409 与模态同一套语义", () => {
    const fn = /async function directApprovePending\(id\)\{[\s\S]*?\n\}/.exec(script);
    assert.ok(fn, "directApprovePending 应存在");
    assert.match(fn[0], /\/api\/pending\/"\+encodeURIComponent\(id\)\+"\/approve/);
    assert.match(fn[0], /status === 409/);
    assert.match(fn[0], /state\.pending\.filter\(\(x\)=>x\.id!==id\)/);
    assert.match(script, /list\.querySelectorAll\("button\[data-ap\]"\)\.forEach\(\(b\)=>\{ b\.onclick = \(\)=> directApprovePending\(b\.dataset\.ap\); \}/,
      "批准按钮绑直接批准");
    assert.match(script, /list\.querySelectorAll\("\.pend-url\[data-ap\]"\)/, "点 URL 走审批模态（可改文件名/目录）");
  });
  await suite.test("侧栏队列 badge 并入待审数（如 3+1）", () => {
    const body = /function renderCounts\(\)\{[\s\S]*?\n\}/.exec(script);
    assert.ok(body, "renderCounts 应存在");
    assert.match(body[0], /const pendN = \(state\.pending \|\| \[\]\)\.length;/);
    assert.match(body[0], /c\.queued \+ "\+" \+ pendN/, "badge 文本 queued+pending");
    assert.match(body[0], /另有 " \+ pendN \+ " 条待确认/, "悬停标题说明待审数");
  });
  await suite.test("淡入动画存在（不抢焦点的纯 CSS 淡入）", () => {
    assert.match(html, /@keyframes pendIn\{from\{opacity:0/);
    assert.match(html, /\.pend-banner\.show\{display:flex;animation:pendIn/);
  });

  // ======================================================= esc / 结构纪律
  suite.group("结构与纪律（不破坏既有标记段/零依赖）");

  await suite.test("既有标记段各恰好一份，未被本批破坏", () => {
    for (const m of ["GUI-PURE-START", "GUI-PURE-END", "GUI-ROWSYNC-START", "GUI-ROWSYNC-END"]) {
      assert.equal((html.match(new RegExp(m, "g")) || []).length, 1, m);
    }
  });
  await suite.test("内联脚本零依赖（无 require/import/process）", () => {
    assert.ok(!/require\(/.test(html));
    assert.ok(!/(^|[^.\w])import\s*['"(\w]/m.test(script));
    assert.ok(!/\bprocess\.\b/.test(script));
  });
  await suite.test("新文案全部落在 gui/index.html（grep 复验钉子）", () => {
    for (const lit of ["对方限流（429）", "TLS 握手失败（EPROTO）", "服务暂不可用（503）",
      "全部重试", "with-text", "复制下载链接",
      "开始下载", "更多选项…", "已在队列中：同一链接的任务正在进行。",
      "高级", "常用", "展开或收起高级工具", "高级设置（网络与安全 / 自动行为 / 浏览器接管 / 外部引擎）"]) {
      assert.ok(html.includes(lit), "缺文案/标记：" + lit);
    }
  });

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch10-ui crashed: " + ((err && err.stack) || err) + NL);
    process.exitCode = 1;
  });
