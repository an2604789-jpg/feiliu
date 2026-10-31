// Clipboard watcher: offer to download a URL copied to the clipboard.
//
// Windows has no portable clipboard-change event in Node, so this polls the
// clipboard through PowerShell at a lazy interval. That is cheap enough at one
// check per second and avoids a native dependency.

import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";

const URL_RE = /^(https?|ftp):\/\/\S+$/i;

function readClipboard() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") { resolve(""); return; }
    // -Raw alone, not "-Raw -Format Text": PowerShell 7 (what this machine's
    // PATH serves as powershell.exe, 7.6.6) dropped -Format, so the old
    // argument list failed on every single poll and the watcher sat silent
    // forever (err was swallowed into ""). -Raw works on 5.1 and 7.x alike.
    execFile("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => resolve(err ? "" : String(stdout || "").trim()));
  });
}

export class ClipboardWatcher extends EventEmitter {
  constructor({ intervalMs = 1500, config } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.config = config;
    this.timer = null;
    this.last = "";
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll cycle; exposed for tests so no timing is involved. */
  async check() {
    if (this.config && this.config.get("monitorClipboard") === false) return null;
    const text = await readClipboard();
    if (!text || text === this.last) return null;
    this.last = text;
    const candidate = (text.split(/\r?\n/)[0] || "").trim();
    if (!URL_RE.test(candidate)) return null;
    this.emit("url", candidate);
    return candidate;
  }
}
