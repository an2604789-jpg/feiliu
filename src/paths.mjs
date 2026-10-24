// Where downloadx keeps its state.
//
// Layout under the data root (default %APPDATA%\\downloadx, override with
// DOWNLOADX_HOME):
//
//   config.json           settings
//   queue.json            task list and ordering
//   tasks/<id>/           per-task transfer state (segment journals)
//   logs/                 rotating text log
//   runtime.json          daemon port + token, rewritten on every start
//   grabber/              saved site-grabber projects

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";

export function dataRoot() {
  if (process.env.DOWNLOADX_HOME) return path.resolve(process.env.DOWNLOADX_HOME);
  const base = process.env.APPDATA || process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "downloadx");
}

export const paths = {
  get root() { return dataRoot(); },
  get config() { return path.join(dataRoot(), "config.json"); },
  get queue() { return path.join(dataRoot(), "queue.json"); },
  get tasks() { return path.join(dataRoot(), "tasks"); },
  get logs() { return path.join(dataRoot(), "logs"); },
  get runtime() { return path.join(dataRoot(), "runtime.json"); },
  get grabber() { return path.join(dataRoot(), "grabber"); },
  taskDir(id) { return path.join(dataRoot(), "tasks", id); },
};

export async function ensureDirs() {
  for (const dir of [paths.root, paths.tasks, paths.logs, paths.grabber]) {
    await fsp.mkdir(dir, { recursive: true });
  }
}

export function ensureDirsSync() {
  for (const dir of [paths.root, paths.tasks, paths.logs, paths.grabber]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
