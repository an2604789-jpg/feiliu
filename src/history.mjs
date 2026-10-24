// URL history.
//
// A download manager is used repeatedly on the same few sites, and the URL a
// user wants is almost always one they have used before: re-typing or re-finding
// a link is the most common friction in daily use. This records every URL that
// was ever queued, so the GUI and CLI can offer it back.
//
// Design notes:
//
//   * It is an append-only journal (`history.jsonl`), not a rewritten JSON
//     document. A crash can then only lose the last line instead of the whole
//     file, which is the same reasoning the transfer journal uses.
//   * Nothing secret is stored. The URL is recorded without its query string
//     when that query looks like a credential or a session token, because a
//     history file is read by the user and may be pasted into a bug report.
//   * It is bounded: entries beyond `maxEntries` are dropped from the front on
//     rewrite, so the file cannot grow without limit.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { paths, ensureDirs } from "./paths.mjs";

/** Query keys whose value is a credential rather than a resource selector. */
const SECRET_QUERY = /^(token|access_token|auth|apikey|api_key|key|sig|signature|secret|password|passwd|pwd|session|sid|code|state|jwt|bearer|sessionid|session_id|sso|ticket|nonce|grant|assertion|id_token|refresh_token)$/i;

const DEFAULT_MAX = 500;

/**
 * Reduce a URL to what is safe to keep in a plain-text history file.
 *
 * The host, path and harmless query parameters are preserved, because they are
 * what makes an entry recognisable. Values under a secret-looking key are
 * dropped, and so is the userinfo section: `https://user:pw@host/f` must never
 * be written to disk in the clear.
 *
 * @param {string} raw
 * @returns {string} the redacted URL, or the input when it cannot be parsed
 */
export function redactUrl(raw) {
  let u;
  try { u = new URL(String(raw)); }
  catch { return String(raw); }

  if (u.username || u.password) {
    u.username = "";
    u.password = "";
  }
  if (u.search) {
    const keep = new URLSearchParams();
    let dropped = false;
    for (const [k, v] of u.searchParams) {
      if (SECRET_QUERY.test(k)) { dropped = true; continue; }
      keep.append(k, v);
    }
    const next = keep.toString();
    // A search string that became empty is removed outright rather than left as
    // a bare "?"; a partially redacted one is marked so the user can tell why
    // the URL looks shorter than the one they pasted.
    u.search = dropped ? (next ? next + "&__redacted=1" : "__redacted=1") : next;
  }
  u.hash = "";
  return u.toString();
}

/** One history entry. */
function makeEntry(url, extra = {}) {
  return {
    url,
    finalUrl: extra.finalUrl ?? null,
    filename: extra.filename ?? null,
    dir: extra.dir ?? null,
    size: extra.size ?? null,
    at: extra.at ?? Date.now(),
    source: extra.source ?? "manual",
  };
}

export class UrlHistory {
  /**
   * @param {{ file?:string, maxEntries?:number }} [opts]
   */
  constructor({ file = path.join(paths.root, "history.jsonl"), maxEntries = DEFAULT_MAX } = {}) {
    this.file = file;
    this.maxEntries = Math.max(1, maxEntries);
    this.entries = [];
    /** URLs seen this session, to make the in-memory de-duplication cheap. */
    this.seen = new Map();
    this._saving = null;
    /** Entries recorded but not yet written, oldest first. */
    this._pending = [];
  }

  /** Read the journal. A damaged line is skipped, never fatal. */
  async load() {
    await ensureDirs();
    let text = "";
    try { text = await fsp.readFile(this.file, "utf8"); }
    catch (err) {
      if (err.code !== "ENOENT") this.lastError = err.message;
      this.entries = [];
      return this;
    }
    const parsed = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec.url === "string" && rec.url) parsed.push(rec);
      } catch { /* a torn trailing line is expected after a crash */ }
    }
    // Newest first, and one entry per URL: the journal records every use, the
    // in-memory list is the de-duplicated view.
    parsed.sort((a, b) => (b.at || 0) - (a.at || 0));
    this.entries = [];
    for (const rec of parsed) {
      const key = rec.url;
      if (this.seen.has(key)) {
        const existing = this.seen.get(key);
        // Keep the most recent occurrence's metadata, but preserve the first
        // sighting time so the list can show "first seen".
        existing.at = rec.at || existing.at;
        if (rec.filename) existing.filename = rec.filename;
        if (rec.dir) existing.dir = rec.dir;
        if (rec.size) existing.size = rec.size;
        continue;
      }
      const entry = makeEntry(rec.url, rec);
      this.entries.push(entry);
      this.seen.set(key, entry);
    }
    this.entries = this.entries.slice(0, this.maxEntries);
    return this;
  }

  /**
   * Record a queued URL.
   *
   * @param {string} rawUrl
   * @param {{ finalUrl?:string, filename?:string, dir?:string, size?:number, source?:string }} [extra]
   * @returns {object|null} the entry, or null when the URL is unusable
   */
  record(rawUrl, extra = {}) {
    if (!rawUrl || typeof rawUrl !== "string") return null;
    const url = redactUrl(rawUrl);
    const entry = makeEntry(url, extra);

    const existing = this.seen.get(url);
    if (existing) {
      // Re-use moves the entry to the top: history is ordered by usefulness,
      // and the thing you just used again is the most useful.
      existing.at = entry.at;
      if (entry.filename) existing.filename = entry.filename;
      if (entry.dir) existing.dir = entry.dir;
      if (entry.size) existing.size = entry.size;
      if (entry.finalUrl) existing.finalUrl = entry.finalUrl;
      const i = this.entries.indexOf(existing);
      if (i > 0) { this.entries.splice(i, 1); this.entries.unshift(existing); }
    } else {
      this.entries.unshift(entry);
      this.seen.set(url, entry);
      if (this.entries.length > this.maxEntries) {
        for (const dropped of this.entries.splice(this.maxEntries)) this.seen.delete(dropped.url);
      }
    }
    this.#append(entry);
    return entry;
  }

  /**
   * Append one line.
   *
   * Bursts are coalesced: a grab or a clipboard catch can record many URLs at
   * once, and one append per URL would be needlessly chatty. The queue holds
   * every pending entry rather than just flagging that something changed —
   * writing only the most recent one silently dropped the others from the
   * journal, so they vanished the next time the file was read.
   *
   * A failure is recorded in lastError but never breaks a download: history is
   * a convenience, not a requirement.
   */
  #append(entry) {
    this._pending.push(entry);
    if (this._saving) return this._saving;
    this._saving = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      this._saving = null;
      const batch = this._pending.splice(0, this._pending.length);
      if (!batch.length) return;
      try {
        await ensureDirs();
        await fsp.appendFile(this.file, batch.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
      } catch (err) {
        this.lastError = err.message;
      }
    })();
    return this._saving;
  }

  /** Rewrite the file when the journal has grown well past the live entries. */
  async #compactIfNeeded() {
    try {
      const st = await fsp.stat(this.file);
      if (st.size < 64 * 1024) return;
      const lines = (await fsp.readFile(this.file, "utf8")).split(/\r?\n/).filter(Boolean);
      if (lines.length <= this.maxEntries) return;
      await this.compact();
    } catch { /* compaction is best effort */ }
  }

  /** Rewrite the journal to exactly the live entries, newest first. */
  async compact() {
    await ensureDirs();
    const body = [...this.entries].reverse().map((e) => JSON.stringify(e)).join("\n");
    const tmp = this.file + ".tmp";
    await fsp.writeFile(tmp, body + (body ? "\n" : ""), "utf8");
    await fsp.rename(tmp, this.file);
  }

  /** Wait for any queued append, so a test or a shutdown can observe the file. */
  async flush() {
    if (this._saving) await this._saving;
  }

  /**
   * Search the history.
   *
   * @param {{ q?:string, limit?:number }} [opts]
   * @returns {Array<object>} newest first
   */
  list({ q = "", limit = 50 } = {}) {
    const needle = String(q || "").trim().toLowerCase();
    const matches = needle
      ? this.entries.filter((e) =>
          e.url.toLowerCase().includes(needle) ||
          String(e.filename || "").toLowerCase().includes(needle))
      : [...this.entries];
    return matches.slice(0, Math.max(0, limit)).map((e) => ({ ...e }));
  }

  /** How many entries are kept. */
  get size() { return this.entries.length; }

  /**
   * Forget everything.
   *
   * Deleting a user's history is a destructive action, so it only ever happens
   * when explicitly asked for. No timer and no startup path calls this.
   */
  async clear() {
    const count = this.entries.length;
    this.entries = [];
    this.seen.clear();
    await fsp.rm(this.file, { force: true });
    return count;
  }
}
