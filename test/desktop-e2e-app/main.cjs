const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const resultArg = process.argv.find((a) => a.startsWith("--result="));
const resultFile = resultArg ? decodeURIComponent(resultArg.slice("--result=".length)) : null;
const log = (s) => { try { fs.appendFileSync(path.join(__dirname, "boot.log"), s + "\n"); } catch { /* ignore */ } };
try { fs.writeFileSync(path.join(__dirname, "boot.log"), ""); } catch { /* ignore */ }
log("launcher booted");

const harness = pathToFileURL(path.resolve(__dirname, "..", "desktop-e2e-main.mjs")).href;
log("importing " + harness + " exists=" + fs.existsSync(path.resolve(__dirname, "..", "desktop-e2e-main.mjs")));
import(harness)
  .then((m) => log("imported OK keys=" + Object.keys(m).join(",")))
  .catch((err) => {
    log("import FAILED " + ((err && err.stack) || String(err)));
    try { if (resultFile) fs.writeFileSync(resultFile, JSON.stringify({ ok: false, error: "harness load: " + String(err) })); } catch { /* ignore */ }
    setTimeout(() => process.exit(1), 200);
  });
