// Batch8 CI regression: the installer workflow vendors yt-dlp into bin/
// before packaging and the README advertises the enhancement (ask 包3, 批-8).
//
// The defect this guards against: the two build jobs (windows/linux) package
// the app without the yt-dlp helper, so a green CI still ships installers that
// silently miss the 1800+ video-site parsing enhancement — or a later edit
// reorders/mutates the workflow so the vendored binary never lands in bin/
// before electron-builder collects "bin/**/*", or the README claims something
// the packaging does not ship.
//
// Asserted here (text-level; no server, no network):
//   (a) windows job: a "Vendor yt-dlp" step, placed BEFORE the electron-builder
//       packaging step, downloads yt-dlp.exe from the official
//       releases/latest URL into bin/;
//   (b) linux job: the analogous step for yt-dlp_linux, marked executable;
//   (c) neither download can fail the build: the failure branch is downgraded
//       to a ::warning:: (runtime findYtDlp falls back to PATH lookup);
//   (d) README 特性 section advertises 内置/可选 yt-dlp with the 1800+ claim
//       and the install-guidance promise;
//   (e) package.json electron-builder files still list "bin/**/*", so the
//       vendored binary actually reaches the installers.
//
// Only repo files are read; DOWNLOADX_HOME points at a throwaway temp dir
// (removed on exit) so the real data root — %APPDATA%\downloadx or
// D:/IAM/downloadx-data — is never touched. No timers, no servers, no handles:
// the process exits cleanly.
//
// Usage: node test/batch8-ci.mjs

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { Suite } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NL = String.fromCharCode(10);

const YT_DLP_URL_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";

/**
 * Slice a job's YAML section out of the workflow text. Jobs sit at a 2-space
 * indent (`  windows:`), so a section runs from its header to the next
 * 2-space-indented `name:` line. Returns null when the job is missing.
 */
function jobSection(text, job) {
  const start = text.search(new RegExp("^  " + job + ":[ \\t]*$", "m"));
  if (start < 0) return null;
  const rest = text.slice(start);
  // Search from offset 1 so the section's own header cannot match itself.
  const next = rest.slice(1).search(/^  [A-Za-z_][A-Za-z0-9_-]*:[ \t]*$/m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

async function main() {
  const suite = new Suite("batch8-ci");
  suite.onResult = (r) => {
    if (r.kind === "group") process.stdout.write(NL + "  " + r.text + NL);
    else if (r.kind === "pass") process.stdout.write("    PASS  " + r.text + NL);
    else if (r.kind === "skip") process.stdout.write("    SKIP  " + r.text + "  - " + r.reason + NL);
    else process.stdout.write("    FAIL  " + r.text + NL + "          " +
      String(r.error).split(NL).join(NL + "          ") + NL);
  };

  // 包3 discipline: throwaway DOWNLOADX_HOME, never the real data root.
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "downloadx-batch8-ci-"));
  process.env.DOWNLOADX_HOME = home;

  try {
    const yml = fs.readFileSync(
      path.join(ROOT, ".github", "workflows", "build-installers.yml"), "utf8");
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

    // --------------------------------------- (a)(b)(c) workflow 下载步骤
    suite.group("build-installers.yml 两个构建作业内置 yt-dlp");

    await suite.test("windows 作业在 packaging 前下载 yt-dlp.exe 到 bin/", () => {
      const sec = jobSection(yml, "windows");
      assert.ok(sec, "workflow 必须有 windows 作业");
      const step = sec.indexOf("Vendor yt-dlp");
      assert.ok(step >= 0, "windows 作业必须有 Vendor yt-dlp 下载步骤");
      const pack = sec.indexOf("npx electron-builder");
      assert.ok(pack >= 0, "windows 作业必须有 electron-builder 打包步骤");
      assert.ok(step < pack, "yt-dlp 下载步骤必须排在 packaging(npx electron-builder)之前");
      const body = sec.slice(step, pack);
      assert.ok(body.includes(YT_DLP_URL_BASE + "yt-dlp.exe"),
        "必须从官方 releases/latest URL 下载 yt-dlp.exe");
      assert.ok(body.includes("bin/yt-dlp.exe"),
        "必须落盘到 bin/yt-dlp.exe(随 bin/**/* 进安装包)");
    });

    await suite.test("linux 作业在 packaging 前下载 yt-dlp_linux 到 bin/ 并加执行位", () => {
      const sec = jobSection(yml, "linux");
      assert.ok(sec, "workflow 必须有 linux 作业");
      const step = sec.indexOf("Vendor yt-dlp");
      assert.ok(step >= 0, "linux 作业必须有 Vendor yt-dlp 下载步骤");
      const pack = sec.indexOf("npx electron-builder");
      assert.ok(pack >= 0, "linux 作业必须有 electron-builder 打包步骤");
      assert.ok(step < pack, "yt-dlp 下载步骤必须排在 packaging(npx electron-builder)之前");
      const body = sec.slice(step, pack);
      assert.ok(body.includes(YT_DLP_URL_BASE + "yt-dlp_linux"),
        "必须从官方 releases/latest URL 下载 yt-dlp_linux");
      assert.ok(body.includes("bin/yt-dlp_linux"),
        "必须落盘到 bin/yt-dlp_linux(随 bin/**/* 进安装包)");
      assert.ok(body.includes("chmod +x bin/yt-dlp_linux"),
        "linux 二进制必须 chmod +x,否则打进包里也无法执行");
    });

    await suite.test("下载失败只警告不 fail 构建(warning 继续,PATH 兜底)", () => {
      for (const job of ["windows", "linux"]) {
        const sec = jobSection(yml, job);
        const body = sec.slice(sec.indexOf("Vendor yt-dlp"), sec.indexOf("npx electron-builder"));
        assert.ok(body.includes("::warning::yt-dlp download failed"),
          job + ": 下载失败分支必须降级为 ::warning::,不能让构建变红");
        assert.ok(/falls back to PATH/.test(body),
          job + ": 警告需说明运行时 findYtDlp 回退 PATH 的兜底");
      }
    });

    // ------------------------------------------------------- (d) README
    suite.group("README 特性区宣传 yt-dlp 增强");

    await suite.test("## 特性 小节含 内置/可选 yt-dlp 一行(1800+ 站点 + 安装指引)", () => {
      const m = /^##\s+特性\s*$(.*?)^##\s+/ms.exec(readme);
      assert.ok(m, "README 必须有 ## 特性 小节");
      const doc = m[1];
      assert.ok(/内置\/可选 yt-dlp/.test(doc), "特性区必须提到 内置/可选 yt-dlp");
      assert.ok(/1800\+ 视频站解析/.test(doc), "必须写明 1800+ 视频站解析");
      assert.ok(/yt-dlp 未装时给出安装指引/.test(doc), "必须承诺 yt-dlp 未装时给出安装指引");
    });

    // ---------------------------------- (e) 打包 files 列表护栏
    suite.group("electron-builder 仍收集 bin/**/*");

    await suite.test("package.json build.files 包含 bin/**/*(下载物真的进安装包)", () => {
      assert.ok(Array.isArray(pkg.build && pkg.build.files),
        "package.json 必须有 build.files 列表");
      assert.ok(pkg.build.files.includes("bin/**/*"),
        'build.files 必须包含 "bin/**/*",否则 workflow 的下载步骤只是空转');
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
    process.stderr.write("batch8-ci crashed: " + ((err && err.stack) || err) + NL);
    process.exitCode = 1;
  });
