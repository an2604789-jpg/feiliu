// 批-6 回归:stop() 刷盘竞态 —— flush 落盘后仍被"迟到的防抖保存"覆盖。
//
// 缺陷(2026-10-25 定位,test/batch1-approvals.mjs:367-450 以 ~1/3 概率失败,
// 批-5 验收 git archive HEAD 证明竞态在批-5 前即存在):
//   stop() 的链路本身是同步的 —— flushToQueue -> #resolve -> queue.add
//   把条目放进内存任务表,saveNow 也确实把它写进了 queue.json(带堆栈的
//   复现取证显示 daemon 的 save 内容正确、含 flush 条目)。真正丢数据的是
//   之后:同进程里任何一个还带着 400ms 保存防抖(queue.mjs scheduleSave)
//   的 QueueManager —— batch1 里是前置套件自己的队列,其最后一次 add/
//   pause/cancel 在 daemon 套件开始前几百毫秒布防 —— 在 daemon saveNow
//   之后几十毫秒触发,经由 paths.queue 的实时 env getter(paths.mjs
//   dataRoot() 每次读 process.env.DOWNLOADX_HOME)把"旧任务表"写进
//   daemon 的数据根,最后写者胜,flush 条目被抹掉。
//
// 本文件把这个形态确定性地重建出来:
//   (a) 每轮一个真实 Daemon(临时 DOWNLOADX_HOME,本地 origin,不碰真
//       剪贴板/用户目录/生产数据根);
//   (b) N 条 URL 挂起待批;一部分先批准并等其下载完成(与 batch1 相同的
//       前置活动),其余留待 stop() flush;
//   (c) stop() 与若干 approve 并发发出(approve 赢则入队,flush 赢则
//       approve 404 —— 每条 URL 恰好入队一次,两条路径都必须成立);
//   (d) 关键放大:5 个"同进程迟到写入者"(与 batch1 前置套件队列同构的
//       QueueManager),保存防抖在 stop() 前 350/300/250/200/150ms 依次
//       布防,触发落在 stop() 后 +50..+250ms —— 修复前全部盖在 daemon
//       saveNow(约 +15ms)之后、测试读到之前;daemon 自己被中止 runner
//       的纠正性写要到 +400ms 之后才来(生产环境中进程已退出,永不来);
//   (e) stop() 返回后立刻开始快速轮询 queue.json 约 700ms:任何时刻每
//       条 URL 都必须恰好出现一次,迟到写入者的旧任务表不得成为文件
//       内容。修复后所有迟到触发(+50..+250ms)都先于 stop() 的终局
//       saveNow(静默窗之后,约 +505ms),轮询窗口内不可能再观察到覆盖。
//
// 纪律:仅 node 测试;无窗口;不启停任何既有进程;临时数据根;进程干净退出。
//
// Usage: node test/batch6-approvals-race.mjs        (默认 5 轮)
//        BATCH6_ROUNDS=10 node test/batch6-approvals-race.mjs

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Suite, assert } from "./harness.mjs";
import { startOrigin } from "./origin.mjs";

const ROUNDS = Math.max(1, Number(process.env.BATCH6_ROUNDS) || 5);
/** 每轮挂起的 URL 数。 */
const N_PENDING = 8;
/** 停机前先批准并等待完成的条数(前置活动,同 batch1)。 */
const N_APPROVED_FIRST = 2;
/** 与 stop() 并发发出的 approve 数(其余条目走 flush 路径)。 */
const N_APPROVE_RACING = 3;
/**
 * 迟到写入者个数:布防时刻从 stop() 前 350ms 起每 50ms 一个,触发因此
 * 落在 stop() 后 +50..+250ms,横跨修复前 saveNow(~+15ms)与测试首读之间。
 */
const N_STRAGGLERS = 5;
const STRAGGLER_STAGGER_MS = 50;
const STRAGGLER_LEAD_MS = 350;
/** stop() 返回后轮询 queue.json 的窗口与节奏:捕捉任何迟到的覆盖。 */
const WATCH_MS = 700;
const WATCH_POLL_MS = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn() is true, or fail with the caller's message. */
async function waitFor(fn, { timeoutMs = 30000, everyMs = 25, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await sleep(everyMs);
  }
}

async function main() {
  const suite = new Suite("batch6-approvals-race");
  const NL = String.fromCharCode(10);
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  const origin = await startOrigin();

  await suite.test(`concurrent approve+stop x${N_PENDING} held URLs over ${ROUNDS} rounds keeps every flushed entry on disk`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-b6-race-"));
      const previousHome = process.env.DOWNLOADX_HOME;
      process.env.DOWNLOADX_HOME = home;
      const out = path.join(home, "out");
      const out2 = path.join(home, "out2");
      await fsp.mkdir(out, { recursive: true });
      await fsp.mkdir(out2, { recursive: true });
      let daemon = null;
      try {
        const { Daemon } = await import("../src/daemon.mjs");
        daemon = await new Daemon({ port: 0 }).init();
        // Never read or write the real clipboard; keep files inside the home.
        daemon.clipboard.stop();
        await daemon.config.set({
          defaultDir: out, categorizeByType: false, overwriteExisting: "rename",
        });
        assert.equal(daemon.config.get("askBeforeAdd"), true, "the gate must be on by default");
        const runtime = await daemon.start();
        daemon.clipboard.stop();

        const dcall = async (method, route, body) => {
          const headers = { "x-downloadx-token": runtime.token };
          if (body) headers["content-type"] = "application/json";
          const res = await fetch("http://127.0.0.1:" + runtime.port + route, {
            method, headers, body: body ? JSON.stringify(body) : undefined,
          });
          const text = await res.text();
          let json2 = null;
          try { json2 = JSON.parse(text); } catch { json2 = { raw: text }; }
          return { status: res.status, json: json2 };
        };

        // (b) N 条剪贴板 URL 全部挂起。
        const urls = [];
        for (let i = 0; i < N_PENDING; i++) {
          // fixture host(非回环):第10项收口后 clipboard+回环一律跳过,挂起竞态语义
        // 用假域名验证;批准后的下载不可达、以终态(error)为准——竞态测的是落盘。
        urls.push(`https://approvals.fixture.example/range/65536?case=race&r=${round}&i=${i}`);
        }
        for (const u of urls) daemon.clipboard.emit("url", u);
        const held = await waitFor(async () => {
          const list = (await dcall("GET", "/api/pending")).json.pending;
          return list.length === urls.length ? new Map(list.map((p) => [p.url, p])) : false;
        }, { what: `round ${round}: all ${urls.length} URLs held` });

        // 前置活动:先批准 N_APPROVED_FIRST 条 —— 与 batch1 失败套件相同的
        // 活动形态(也会自然布防 daemon 自己的防抖)。fixture host 不可解析、
        // Windows DNS 死等分钟级,故不等待下载终态:竞态测的是批准与 stop
        // flush 的落盘时序,批准本身(201 + 任务落表)已经是布防活动。
        for (let i = 0; i < N_APPROVED_FIRST; i++) {
          const u = urls[i];
          const r = await dcall("POST", "/api/pending/" + held.get(u).id + "/approve", { dir: out2 });
          assert.equal(r.status, 201, `round ${round}: approve of ${u} must queue, got ${r.status} ${JSON.stringify(r.json)}`);
        }

        // (d) 迟到写入者梯队:与 batch1 前置套件队列同构的 QueueManager。
        //     每个 load 到 daemon 当前任务表(批准完成的那几条),再加进
        //     自己的 straggler 条目 —— add() 即布防 400ms 保存防抖。布防
        //     时刻从 stop() 前 350ms 起每 50ms 一个,因此触发落在 stop()
        //     后 +50..+250ms;届时 env 仍指向本轮 home,它们的旧任务表
        //     会写进 daemon 的 queue.json。修复前:这些写全部盖在
        //     saveNow 之后,把 flush 条目抹掉。
        const { QueueManager } = await import("../src/queue.mjs");
        const stragglerUrls = [];
        for (let s = 0; s < N_STRAGGLERS; s++) {
          const straggler = new QueueManager({ config: daemon.config });
          await straggler.load();
          const u = `https://approvals.fixture.example/range/1024?case=straggler&r=${round}&s=${s}`;
          stragglerUrls.push(u);
          straggler.add({ url: u, filename: `straggler-r${round}-${s}.bin`, dir: out });
          if (s < N_STRAGGLERS - 1) await sleep(STRAGGLER_STAGGER_MS);
        }
        await sleep(STRAGGLER_LEAD_MS - STRAGGLER_STAGGER_MS * (N_STRAGGLERS - 1));

        // (c) stop() 与 approve 并发:谁先到谁入队,另一路 404/flush 兜底,
        //     每条 URL 恰好入队一次。
        const racing = urls.slice(N_APPROVED_FIRST, N_APPROVED_FIRST + N_APPROVE_RACING);
        const stopPromise = daemon.stop();
        const racingApproves = racing.map((u) =>
          dcall("POST", "/api/pending/" + held.get(u).id + "/approve", { dir: out2 }).catch(() => null));
        await Promise.all([stopPromise, ...racingApproves]);
        assert.equal(daemon.started, false, `round ${round}: stop() must complete`);
        daemon = null;   // already stopped

        // (e) stop() 返回后立即开始快速轮询:任何时刻观察到覆盖即失败。
        //     修复前迟到写入者的触发(+50..+250ms)落在本窗口内;修复后
        //     它们全部先于 stop() 的终局 saveNow,窗口内不可能出现旧表。
        const queuePath = path.join(home, "queue.json");
        const deadline = Date.now() + WATCH_MS;
        let last = null;
        for (;;) {
          const saved = JSON.parse(await fsp.readFile(queuePath, "utf8"));
          last = saved;
          const counts = new Map();
          for (const t of saved.tasks || []) counts.set(t.url, (counts.get(t.url) || 0) + 1);
          for (const u of urls) {
            assert.equal(counts.get(u) || 0, 1,
              `round ${round}: ${u} must appear exactly once in queue.json after stop (flushed entries may not be lost), got ${counts.get(u) || 0}`);
          }
          assert.equal((saved.tasks || []).some((t) => stragglerUrls.includes(t.url)), false,
            `round ${round}: a straggler queue's stale map must never become queue.json content`);
          if (Date.now() >= deadline) break;
          await sleep(WATCH_POLL_MS);
        }
        // flush 回退:未经用户确认的目录。条目若在停机窗口里真的跑完了,
        // 下载器会把解析出的默认目录回填到任务上(dir=out);但绝不能是
        // approve 的覆盖目录 —— 那属于另一条路径。
        const flushedOnly = urls.slice(N_APPROVED_FIRST + N_APPROVE_RACING);
        for (const u of flushedOnly) {
          const t = (last.tasks || []).find((x) => x.url === u);
          assert.ok(t, `round ${round}: flushed entry ${u} missing`);
          assert.ok(t.dir === null || t.dir === out,
            `round ${round}: flush must use the default-directory fallback for ${u}, got ${t.dir}`);
        }
      } finally {
        if (daemon && daemon.started) await daemon.stop().catch(() => {});
        if (previousHome === undefined) delete process.env.DOWNLOADX_HOME;
        else process.env.DOWNLOADX_HOME = previousHome;
        // Windows rmdir can race a still-flushing transfer; retry briefly.
        for (let i = 0; ; i++) {
          try { await fsp.rm(home, { recursive: true, force: true }); break; }
          catch (err) {
            if (i >= 8 || (err.code !== "ENOTEMPTY" && err.code !== "EBUSY" && err.code !== "EPERM")) throw err;
            await sleep(300);
          }
        }
      }
    }
  });

  try { origin.server.closeAllConnections?.(); } catch { /* none */ }
  await new Promise((r) => { origin.close().then(r); setTimeout(r, 1500); });

  process.stdout.write(suite.report());
  return suite.failed > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write("batch6-approvals-race crashed: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
