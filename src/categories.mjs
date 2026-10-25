// File classification, used to route downloads into subfolders.

import path from "node:path";
import { DEFAULT_CONFIG } from "./config.mjs";

/** Lowercased extension without the dot, or "" when there is none. */
export function extensionOf(nameOrUrl) {
  let name = String(nameOrUrl || "");
  try {
    if (/^[a-z]+:\/\//i.test(name)) name = decodeURIComponent(new URL(name).pathname);
  } catch { /* not a URL; treat as a plain name */ }
  const base = path.basename(name.split("?")[0].split("#")[0]);
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(base);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Which category bucket does this file belong to?
 * @returns {string|null} category name, or null when nothing matches
 */
export function categorize(nameOrUrl, categories = DEFAULT_CONFIG.categories) {
  const ext = extensionOf(nameOrUrl);
  if (!ext) return null;
  for (const [name, exts] of Object.entries(categories)) {
    if (Array.isArray(exts) && exts.some((e) => String(e).toLowerCase() === ext)) return name;
  }
  return null;
}

/**
 * Resolve the directory a download should land in.
 *
 * 批-5 / P-6 语义：调用方显式给出 `dir` 时，dir 就是权威落点——一字不差地
 * 落在那里，绝不追加分类子目录（API/agent 的 `dir+filename` 精确落点契约，
 * 修复"文件落在 dir/archive/…"的劫持）。分类只改变**未指定目录**（走
 * defaultDir）时的默认行为，且仍受 categorizeByType 开关控制。归类结果
 * 照常由调用方记录进 task.category（见 Downloader.requestedBase）。
 *
 * @param {{ filename:string, dir?:string, category?:string|null, config:any }} opts
 */
export function resolveDirectory({ filename, dir, category, config }) {
  const base = dir || config?.defaultDir || process.cwd();
  // An explicit dir is the exact landing place: appending a category folder
  // here is what broke the dir+filename contract (P-6).
  if (dir || !config?.categorizeByType) return base;
  const cat = category ?? categorize(filename, config.categories);
  return cat ? path.join(base, cat) : base;
}

/**
 * Never overwrite silently: pick the first free "name (n).ext".
 *
 * `keyOf` (optional) maps a candidate path to its comparison key. On a
 * case-insensitive volume two spellings of one name are one file, and the
 * caller's predicate may say "taken" for the variant it was asked about while
 * another variant has already been probed — remembering the keys already tried
 * keeps the search from looping over names that cannot be free.
 */
export async function uniquePath(targetPath, existsFn, keyOf) {
  const fsp = await import("node:fs/promises");
  const key = keyOf ?? ((p) => p);
  const check = existsFn ?? (async (p) => { try { await fsp.access(p); return true; } catch { return false; } });
  const tried = new Set();
  const free = async (candidate) => {
    const k = key(candidate);
    if (tried.has(k)) return false;      // already known to be unavailable
    tried.add(k);
    return !(await check(candidate));
  };
  if (await free(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const stem = path.basename(targetPath, ext);
  for (let i = 2; i < 10_000; i++) {
    const candidate = path.join(dir, `${stem} (${i})${ext}`);
    if (await free(candidate)) return candidate;
  }
  throw new Error(`cannot find a free name for ${targetPath}`);
}
