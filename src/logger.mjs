// Rotating text log, bounded in size and memory.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { paths, ensureDirsSync } from "./paths.mjs";

const MAX_BYTES = 2 * 1024 * 1024;   // rotate at 2 MiB
const KEEP_TAIL = 500;               // in-memory lines for the API

export class Logger {
  constructor({ file = null, level = "info" } = {}) {
    ensureDirsSync();
    this.file = file ?? path.join(paths.logs, "downloadx.log");
    this.level = level;
    this.tail = [];
  }

  static LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

  #write(level, message) {
    if ((Logger.LEVELS[level] ?? 20) < (Logger.LEVELS[this.level] ?? 20)) return;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
    this.tail.push(line);
    if (this.tail.length > KEEP_TAIL) this.tail.splice(0, this.tail.length - KEEP_TAIL);
    try {
      fs.appendFileSync(this.file, line + "\n");
      this.#maybeRotate();
    } catch { /* logging must never break a transfer */ }
  }

  #maybeRotate() {
    try {
      const st = fs.statSync(this.file);
      if (st.size <= MAX_BYTES) return;
      fs.renameSync(this.file, `${this.file}.1`);
    } catch { /* nothing to rotate */ }
  }

  debug(m) { this.#write("debug", m); }
  info(m) { this.#write("info", m); }
  warn(m) { this.#write("warn", m); }
  error(m) { this.#write("error", m); }

  tailLines(n = 200) { return this.tail.slice(-n); }
  tail2(n = 200) { return this.tailLines(n); }

  async readAll(n = 500) {
    try {
      const text = await fsp.readFile(this.file, "utf8");
      return text.split(/\r?\n/).filter(Boolean).slice(-n);
    } catch {
      return this.tailLines(n);
    }
  }
}
