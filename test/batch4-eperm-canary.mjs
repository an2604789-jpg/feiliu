#!/usr/bin/env node
// 批-4 回归 W5:daemon EPERM 哨兵(canary)——对"长跑数小时后 daemon 对默认下载卷
// 丧失写能力(EPERM mkdir/open),新进程同刻正常,重启即愈,根因未知"这一未解之症
// 的取证布防。根因本批不定论(timebox):结论 = 取证手段已布防,下次复发抓第一现场。
//
// ═══════════════════ 两次实录(D:/IAM/反馈/批1-验收/施工记录-20261024.md)═══════════════════
//
// 实录一 · 附记七(2026-10-24 18:1x,抖音直链 EPERM 诊断):
//   现象:运行中的桌面版 daemon 下载报 EPERM mkdir 'E:\Downloads\video\<token>.mp4.downloadx'。
//   对照矩阵:PowerShell mkdir 同名 ✓ / 普通 node ✓ / Electron-as-Node(同 daemon 二进制
//   上下文)✗→✓(出现抖动)——唯独那个运行中的 daemon 进程稳定 EPERM,根目录/子目录均
//   复现(排除 categorizeByType 子目录因素)。Defender RTP 当时为关;fltmc 列表含
//   UCPD/gameflt/WdFilter/Xbox360Filter64。处置:临时纯 node daemon 重试,213MB+21MB
//   全部完整下载——同机同刻新进程完全正常。
//
// 实录二 · 批-3 收口(2026-10-25 凌晨):
//   pid 3432 存活 3.5h 后 EPERM 复发(写 E:\Downloads 失败),与附记七同模式;
//   release 同步重启后治愈,当刻只留下"重启即愈"一个事实。根因取证列批-4(即本包)。
//
// ═══════════════════ 共性(两录俱备)═══════════════════
//   S1 仅长跑进程自身中毒:同刻新进程(乃至同二进制上下文)写同卷正常 → 进程级状态。
//   S2 失败集中在"在该卷创建新条目"(mkdir 新目录 / open 新文件);既有句柄的读写
//      未见异常报告 → create 类路径特异。
//   S3 该卷整个子树同失败(根目录/子目录均复现)→ 非单目录 ACL/属性问题。
//   S4 重启进程即愈、无残留 → 瞬时 per-process 状态,非持久卷损坏。
//   S5 两次都在"用户下载失败"之后才被发现——中毒起点时刻未知(这正是哨兵要补的数据)。
//
// ═══════════════════ 差异 ═══════════════════
//   D1 实录一出现 Electron-as-Node ✗→✓ 抖动;实录二无抖动记录(直接重启治愈)。
//   D2 实录一发生在抖音大文件(213MB 分段)下载失败之后,负载画像明确;实录二仅知
//      uptime≈3.5h,负载画像未知。
//   D3 实录一诊断时 Defender RTP 为关(过滤驱动仍驻留);实录二未复查 RTP 状态。
//
// ═══════════════════ 候选根因排序 + 可检验预测 ═══════════════════
//
// ① 过滤驱动 per-process 上下文耗尽/损坏(最可疑)
//    机理:机器驻留多个 minifilter(UCPD/gameflt/WdFilter/Xbox360Filter64);create 类
//    操作需过滤驱动分配 per-stream/per-process 上下文,长跑进程上下文累积/泄漏后新建
//    失败,内核以 EPERM 回绝——而既有句柄(上下文已建)继续可用,与 S1~S4 全部吻合。
//    可检验预测:
//      P1 中毒时段失败仅限 create 类 syscall(mkdir/open 新名),既有句柄写继续
//        (下载中途的任务不因中毒而断,只有新任务失败——日志可查证);
//      P2 病程无自愈:一旦中毒持续到进程死亡(两次实录均如此)。若哨兵观察到
//        fail→OK 自发恢复,本假设降权;
//      P3 fltmc 分离可疑过滤驱动(需管理员,人证实验)后,长跑不再复发;
//      P4 中毒进程同刻 spawn/新 socket 等其他 create 类操作也可能报资源类错误。
//
// ② window-station / 桌面堆资源退化
//    机理:同机同夜已实锤系统级 shell 状态病——本应用子孙进程拉 explorer 全部
//    0xC0000142、pwsh 同码、进程内 shell API 间歇失灵(附记十二/十三),机器 shell
//    状态在退化。桌面堆按 window-station 共享、按进程配额;耗尽时进程内依赖窗口站的
//    某些内核/用户路径(含部分对象创建)可能异常失败。
//    可检验预测:
//      P1 中毒时段同进程的一切窗口/GDI 操作(系统通知、对话框)同步失败(附记十二
//        通知链可作对照);
//      P2 桌面堆共享 ⇒ 同 desktop 的其他 GUI 进程同时段也有症状(而非仅 daemon);
//      P3 重启 explorer / 注销重登(重建 window station)可愈,无需重启 daemon——
//        若属实,指向②而非①;
//      P4 句柄计数正常的情况下依然中毒(与③区分)。
//
// ③ daemon 自身句柄/内存泄漏拖垮进程资源
//    机理:最平凡解释:长跑泄漏句柄/内存,越过阈值后 create 类调用开始失败。
//    可检验预测:
//      P1 翻转时刻进程句柄数/activeHandles 处于高位且随 uptime 单调增——哨兵每条
//        翻转行都带 activeHandles=/uptime=/tasks= 快照,翻日志即可裁决;
//      P2 资源耗尽不区分卷:翻转时刻其他卷(E: 之外)同样失败(人工同刻对照可补证);
//      P3 泄漏源修复后(若存在)不再复发;句柄曲线在修复前后可见拐点。
//
//    裁决倚仗:翻转行的 activeHandles/uptime/tasks 快照 + 翻转时刻 tasklist 人工补拍
//    句柄计数,即可在①②③中排序;哨兵本身只负责把"翻转时刻"钉死到 30 分钟粒度。
//
// ═══════════════════ 本套件锁定的行为(全部落在临时目录,零真实卷写)═══════════════════
//   C1 start() 首拍即写一次:mkdir 默认目录 + 独占('wx')创建随机名探针文件 +
//      写 <1KB 载荷 + 关闭 + 即删,目录零残留;两次探针名字不同。
//   C2 默认 30 分钟间隔;定时器 unref(不阻止进程退出);stop() 收走定时器。
//   C3 翻转边沿触发:OK→失败记一条 WARN(code/syscall/path/errno/uptime/tasks/
//      activeHandles/pid 俱全);持续失败不再刷屏;失败→OK 记一条 INFO 恢复行
//      (含起点时刻与失败次数);再稳定不再记。首拍即败(出生即中毒)也算翻转
//      (firstProbe=true)。
//   C4 探针任何失败绝不抛出(probeNow 永不 reject、永远返回结果对象),定时器回调
//      全包;哨兵不碰下载主流程。
//   C5 defaultDir 未配置/为空 → 跳过(ran:false + skipped,零 io、零状态变化、零日志;
//      Config.sanitize 恒回填默认目录,故生产中该路径休眠,但契约必须成立)。
//   C6 完整 Daemon 临时实例:init() 即布防(日志留 armed 行),首拍落在临时默认目录
//      (绝不触碰真实用户 Downloads);默认 30 分钟间隔 + unref;stop() 收走哨兵。
//
// 纪律:临时 DOWNLOADX_HOME;严禁读写 D:/IAM/downloadx-data;daemon 用例在 init()
// 之前预写 config.json 指向临时 defaultDir 并关 monitorClipboard(不派生 powershell,
// 不读真实剪贴板);不启动任何带窗口程序;不结束/重启既有进程;全收尾,进程干净退出。
//
// Usage: node test/batch4-eperm-canary.mjs

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Suite, assert } from "./harness.mjs";

const NL = String.fromCharCode(10);

/** Poll until fn() returns truthy, or fail with the caller's message. */
async function waitFor(fn, { timeoutMs = 30000, everyMs = 25, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/**
 * Recording fake for the canary's injectable io: mkdir/open/write/close/rm
 * against an in-memory set, with per-op failure injection. The thrown errors
 * carry code/errno/syscall/path exactly like libuv's, because the flip line
 * has to quote them verbatim.
 */
function fakeIO({ failMkdir = null, failOpen = null, failRm = null } = {}) {
  const calls = [];
  const files = new Set();
  const mkErr = (spec, syscall, p) => {
    const e = new Error((spec.code || "EPERM") + ": " + syscall + " '" + p + "'");
    e.code = spec.code || "EPERM";
    e.errno = spec.errno ?? -4043;
    e.syscall = syscall;
    e.path = p;
    return e;
  };
  return {
    calls,
    files,
    async mkdir(dir) {
      calls.push(["mkdir", dir]);
      if (failMkdir) throw mkErr(failMkdir, "mkdir", dir);
      files.add(dir);
    },
    async open(p) {
      calls.push(["open", p]);
      if (failOpen) throw mkErr(failOpen, "open", p);
      files.add(p);
      return {
        writeFile: async (data) => { calls.push(["write", p, String(data)]); },
        close: async () => { calls.push(["close", p]); },
      };
    },
    async rm(p) { calls.push(["rm", p]); if (failRm) throw mkErr(failRm, "unlink", p); files.delete(p); },
    set failMkdir(v) { failMkdir = v; },
    set failOpen(v) { failOpen = v; },
  };
}

/** Capturing log with the Logger's info/warn surface (arrays under *Lines). */
function fakeLog() {
  const info = [];
  const warn = [];
  return {
    infoLines: info,
    warnLines: warn,
    info(m) { info.push(m); },
    warn(m) { warn.push(m); },
  };
}

/** Queue stub with a realistic status mix: 3 tasks, 2 active (connecting/downloading). */
function fakeQueue() {
  return { tasks: new Map([
    ["t1", { status: "downloading" }],
    ["t2", { status: "connecting" }],
    ["t3", { status: "complete" }],
  ]) };
}

async function main() {
  const suite = new Suite("batch4-eperm-canary");

  // Unit workspace + env FIRST, then the dynamic import: nothing in src/ may
  // ever resolve a path outside a throwaway home in this suite.
  const homeA = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b4-canary-unit-"));
  const previousHome = process.env.DOWNLOADX_HOME;
  process.env.DOWNLOADX_HOME = homeA;
  const { EpermCanary, Daemon } = await import("../src/daemon.mjs");

  const canaries = [];
  const mkCanary = (opts) => { const c = new EpermCanary(opts); canaries.push(c); return c; };

  // The one directory the "real io" probes may touch: inside the unit home.
  const realOut = path.join(homeA, "out");

  let daemon = null;      // the full-Daemon case, stopped in finally
  let homeB = null;

  try {
    // ------------------------------------------------ C1: first reading at once
    suite.group("C1 start() takes the first reading immediately");

    await suite.test("one <1KB random-name probe file is written then deleted, nothing left", async () => {
      const io = fakeIO();
      const log = fakeLog();
      const c = mkCanary({ config: { get: () => realOut }, io, log });
      c.start();
      const r = await waitFor(() => c.lastResult && c.lastResult.ran ? c.lastResult : null,
        { what: "the first probe to complete" });
      assert.equal(r.ok, true, "first probe on a writable dir must be ok");
      assert.equal(c.state, "ok");
      assert.equal(c.probes, 1);
      assert.equal(r.flipped, false, "unknown->ok is not a flip and must not log");
      // mkdir(defaultDir) then exclusive create of a random hidden name inside it.
      assert.equal(io.calls[0][0], "mkdir");
      assert.equal(io.calls[0][1], realOut);
      const open = io.calls.find((x) => x[0] === "open");
      assert.ok(open, "an exclusive open must happen");
      const name = path.basename(open[1]);
      assert.match(name, /^\.downloadx-eperm-canary-[0-9a-f]{8}\.tmp$/, "random probe name");
      assert.equal(path.dirname(open[1]), realOut, "probe must land inside the default dir");
      // Payload strictly <1KB, write, close, delete — and nothing survives.
      const write = io.calls.find((x) => x[0] === "write");
      assert.ok(write, "the payload must be written");
      assert.ok(write[2].length < 1024, "payload must be <1KB, got " + write[2].length);
      assert.ok(io.calls.some((x) => x[0] === "close"), "handle must be closed");
      const rm = io.calls.find((x) => x[0] === "rm");
      assert.equal(rm && rm[1], open[1], "the probe file must be deleted right after the write");
      assert.equal([...io.files].filter((p) => p !== realOut).length, 0, "no probe file may survive");
      // Only the boot "armed" line, never a flip line.
      assert.equal(log.warnLines.length, 0, "no WARN on a healthy first reading: " + log.warnLines.join(" | "));
      assert.ok(log.infoLines.every((l) => l.includes("armed")), "only the armed line expected: " + log.infoLines.join(" | "));
      c.stop();
    });

    await suite.test("a second probe uses a different random name and stays silent", async () => {
      const io = fakeIO();
      const log = fakeLog();
      const c = mkCanary({ config: { get: () => realOut }, io, log });
      await c.probeNow();
      const first = io.calls.find((x) => x[0] === "open")[1];
      const r2 = await c.probeNow();
      const second = io.calls.filter((x) => x[0] === "open").map((x) => x[1])[1];
      assert.equal(r2.ok, true);
      assert.equal(r2.flipped, false, "ok->ok must not flip");
      assert.notEqual(first, second, "probe names must be random per probe");
      assert.equal(log.warnLines.length, 0);
      c.stop();
    });

    // ------------------------------------------------ C2: cadence + unref + stop
    suite.group("C2 cadence, unref'd timer, stop()");

    await suite.test("default interval is 30 minutes and the timer is unref'd", async () => {
      const c = mkCanary({ config: { get: () => "" }, io: fakeIO(), log: fakeLog() });
      assert.equal(c.intervalMs, 30 * 60 * 1000, "default cadence must be 30min");
      c.start();
      assert.equal(c.started, true);
      assert.equal(typeof c.timer.hasRef === "function" ? c.timer.hasRef() : false, false,
        "the interval must be unref'd so it never holds the process open");
      c.stop();
      assert.equal(c.started, false, "stop() must disarm");
    });

    await suite.test("the interval really re-probes (1s cadence fires twice)", async () => {
      const c = mkCanary({ config: { get: () => realOut }, io: fakeIO(), log: fakeLog(), intervalMs: 1000 });
      c.start();
      await waitFor(() => c.probes >= 2 ? c.probes : null, { timeoutMs: 5000, what: "the second tick" });
      c.stop();
    });

    // ------------------------------------------------ C3: edge-triggered flips
    suite.group("C3 state flips log exactly one detailed line each");

    await suite.test("ok -> EPERM on open logs one WARN with code/syscall/path/errno/uptime/tasks; repeats stay silent", async () => {
      const io = fakeIO();
      const log = fakeLog();
      const c = mkCanary({ config: { get: () => realOut }, io, log, queue: fakeQueue() });
      const ok = await c.probeNow();
      assert.equal(ok.ok, true);
      io.failOpen = { code: "EPERM", errno: -4043 };
      const bad = await c.probeNow();
      assert.equal(bad.ok, false);
      assert.equal(bad.flipped, true, "ok->fail is the flip that must be logged");
      assert.equal(bad.code, "EPERM");
      assert.equal(bad.syscall, "open");
      assert.equal(log.warnLines.length, 1, "exactly one WARN per flip, got: " + log.warnLines.join(" | "));
      const line = log.warnLines[0];
      assert.match(line, /eperm-canary: WRITE LOST on /);
      assert.match(line, /code=EPERM/);
      assert.match(line, /syscall=open/);
      assert.match(line, /errno=-4043/);
      assert.ok(line.includes("path=" + bad.path), "the failing path must be quoted: " + line);
      assert.match(line, /uptime=\d+s \(/);
      assert.match(line, /tasks=3 /);
      assert.match(line, /active=2 /);
      assert.match(line, /activeHandles=\d+/);
      assert.match(line, /pid=\d+/);
      assert.match(line, /lastOk=/);
      // Continuation of the same failing run: no further lines.
      const bad2 = await c.probeNow();
      assert.equal(bad2.ok, false);
      assert.equal(bad2.flipped, false, "fail->fail must not flip");
      assert.equal(log.warnLines.length, 1, "a held state must not spam the log");
      c.stop();
    });

    await suite.test("EPERM on mkdir (the recorded syscall of both incidents) flips the same way", async () => {
      const io = fakeIO({ failMkdir: { code: "EPERM", errno: -4043 } });
      const log = fakeLog();
      const c = mkCanary({ config: { get: () => realOut }, io, log, queue: fakeQueue() });
      const bad = await c.probeNow();
      assert.equal(bad.ok, false);
      assert.equal(bad.flipped, true, "a first probe already failing is the most valuable flip");
      assert.equal(bad.syscall, "mkdir");
      assert.equal(log.warnLines.length, 1);
      assert.match(log.warnLines[0], /syscall=mkdir/);
      assert.match(log.warnLines[0], /firstProbe=true/, "born-poisoned must be marked");
      c.stop();
    });

    await suite.test("fail -> ok logs exactly one recovery INFO naming the failing run", async () => {
      const io = fakeIO();
      const log = fakeLog();
      const c = mkCanary({ config: { get: () => realOut }, io, log, queue: fakeQueue() });
      await c.probeNow();
      io.failOpen = { code: "EPERM" };
      await c.probeNow();
      await c.probeNow();          // two failures in the run
      io.failOpen = null;
      const back = await c.probeNow();
      assert.equal(back.ok, true);
      assert.equal(back.flipped, true, "fail->ok is a flip");
      const rec = log.infoLines.filter((l) => l.includes("write recovered"));
      assert.equal(rec.length, 1, "exactly one recovery line");
      assert.match(rec[0], /after failing since /);
      assert.match(rec[0], /2 probes\)/);
      assert.match(rec[0], /uptime=\d+s \(/);
      const again = await c.probeNow();
      assert.equal(again.flipped, false);
      assert.equal(log.infoLines.filter((l) => l.includes("write recovered")).length, 1, "no repeat recovery lines");
      c.stop();
    });

    // ------------------------------------------------ C4: containment
    suite.group("C4 a failing probe never throws and never touches the flow");

    await suite.test("probeNow resolves (never rejects) through hostile io", async () => {
      const log = fakeLog();
      const c = mkCanary({ config: { get: () => realOut }, io: {}, log });   // io missing every method
      let r = await c.probeNow();   // must not reject
      assert.equal(r.ok, false, "a broken io is a failed reading, not an exception");
      // A thrown non-Error is contained the same way.
      const hostile = { mkdir: () => { throw "boom-string"; }, open: () => {}, rm: () => {} };
      const c2 = mkCanary({ config: { get: () => realOut }, io: hostile, log: fakeLog() });
      r = await c2.probeNow();
      assert.equal(r.ok, false);
      assert.equal(c2.state, "fail");
      c.stop(); c2.stop();
    });

    await suite.test("an undeletable probe file WARNs but never flips state", async () => {
      const io = fakeIO({ failRm: { code: "EPERM", errno: -4043 } });
      const log = fakeLog();
      const c = mkCanary({ config: { get: () => realOut }, io, log });
      const r = await c.probeNow();
      assert.equal(r.ok, true, "the write succeeded; rm failure is litter, not poison");
      assert.equal(r.flipped, false);
      assert.equal(log.warnLines.length, 1, "one WARN about the leftover");
      assert.match(log.warnLines[0], /probe file not removable/);
      c.stop();
    });

    // ------------------------------------------------ C5: no defaultDir -> skip
    suite.group("C5 no configured default directory means stand-down");

    await suite.test("empty defaultDir: ran=false, skipped, zero io, zero state change, zero logs", async () => {
      const io = fakeIO();
      const log = fakeLog();
      const c = mkCanary({ config: { get: () => "" }, io, log });
      const r = await c.probeNow();
      assert.equal(r.ran, false);
      assert.equal(r.skipped, "defaultDir");
      assert.equal(io.calls.length, 0, "no filesystem op may happen");
      assert.equal(c.state, "unknown", "a skip is not a reading");
      assert.equal(c.probes, 0);
      c.start();                    // armed + first tick -> still nothing
      await new Promise((res) => setTimeout(res, 50));
      assert.equal(io.calls.length, 0);
      assert.equal(log.warnLines.length, 0);
      assert.equal(log.infoLines.filter((l) => !l.includes("armed")).length, 0);
      c.stop();
    });

    // ------------------------------------------------ C6: the real Daemon wires it
    suite.group("C6 a temp Daemon arms the canary on init and disarms on stop");

    await suite.test("init() loads the probe; first reading lands inside the temp defaultDir", async () => {
      homeB = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b4-canary-daemon-"));
      const dl = path.join(homeB, "dl");
      // Pre-write the config BEFORE init so the very first probe (which fires
      // during init) can never resolve to the real user's Downloads, and no
      // powershell clipboard poll is ever armed.
      await fsp.writeFile(path.join(homeB, "config.json"), JSON.stringify({
        defaultDir: dl,
        monitorClipboard: false,
        categorizeByType: false,
        askBeforeAdd: false,
      }, null, 2), "utf8");
      process.env.DOWNLOADX_HOME = homeB;
      daemon = await new Daemon({ port: 0 }).init();
      daemon.clipboard.stop();      // belt and braces: never read a real clipboard

      assert.ok(daemon.canary instanceof EpermCanary, "init() must create the canary");
      assert.equal(daemon.canary.started, true, "init() must arm it");
      assert.equal(daemon.canary.intervalMs, 30 * 60 * 1000, "production cadence is 30min");
      assert.equal(daemon.canary.timer.hasRef(), false, "the daemon's own timer must be unref'd");

      const r = await waitFor(() => daemon.canary.lastResult && daemon.canary.lastResult.ran ? daemon.canary.lastResult : null,
        { what: "the daemon canary's first reading" });
      assert.equal(r.ok, true, "first reading on a fresh temp dir must succeed");
      assert.ok(r.probePath.startsWith(dl + path.sep) || r.probePath.startsWith(dl),
        "the probe must land in the temp defaultDir, got " + r.probePath);
      // Zero leftovers in the watched dir, and the boot log proves the arm.
      const leftovers = (await fsp.readdir(dl)).filter((n) => n.includes("canary"));
      assert.equal(leftovers.length, 0, "no probe leftovers: " + leftovers.join(", "));
      const logText = await fsp.readFile(path.join(homeB, "logs", "downloadx.log"), "utf8");
      assert.match(logText, /eperm-canary: armed/, "the boot line must be in the rotating log");

      const runtime = await daemon.start();
      assert.ok(runtime.port > 0);
      await daemon.stop();
      assert.equal(daemon.canary.started, false, "stop() must disarm the canary");
      daemon = null;                // finally must not stop it twice
    });
  } finally {
    for (const c of canaries) { try { c.stop(); } catch { /* already down */ } }
    if (daemon) { try { await daemon.stop(); } catch { /* teardown best effort */ } }
    if (previousHome === undefined) delete process.env.DOWNLOADX_HOME;
    else process.env.DOWNLOADX_HOME = previousHome;
    await fsp.rm(homeA, { recursive: true, force: true }).catch(() => {});
    if (homeB) await fsp.rm(homeB, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch4-eperm-canary crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
