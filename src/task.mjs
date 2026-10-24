// Task model: one download, its state machine, and its persisted form.

import { randomUUID } from "node:crypto";

/** Lifecycle. Terminal states never transition again. */
export const STATUS = {
  QUEUED: "queued",
  CONNECTING: "connecting",
  DOWNLOADING: "downloading",
  PAUSED: "paused",
  COMPLETE: "complete",
  ERROR: "error",
};

export const TERMINAL = new Set([STATUS.COMPLETE]);
export const ACTIVE = new Set([STATUS.CONNECTING, STATUS.DOWNLOADING]);

const ALLOWED = {
  [STATUS.QUEUED]: [STATUS.CONNECTING, STATUS.DOWNLOADING, STATUS.PAUSED, STATUS.ERROR],
  [STATUS.CONNECTING]: [STATUS.DOWNLOADING, STATUS.QUEUED, STATUS.PAUSED, STATUS.ERROR],
  [STATUS.DOWNLOADING]: [STATUS.COMPLETE, STATUS.PAUSED, STATUS.QUEUED, STATUS.ERROR],
  [STATUS.PAUSED]: [STATUS.QUEUED, STATUS.CONNECTING, STATUS.ERROR],
  [STATUS.COMPLETE]: [],
  [STATUS.ERROR]: [STATUS.QUEUED, STATUS.CONNECTING],
};

export function canTransition(from, to) {
  return (ALLOWED[from] ?? []).includes(to);
}

export function makeTask(input) {
  const now = Date.now();
  return {
    id: input.id || randomUUID(),
    url: input.url,
    finalUrl: input.finalUrl || null,
    filename: input.filename || null,
    dir: input.dir || null,
    category: input.category ?? null,
    status: input.status || STATUS.QUEUED,
    kind: input.kind || "http",          // http | ftp | hls | dash
    totalBytes: input.totalBytes ?? null,
    downloadedBytes: input.downloadedBytes ?? 0,
    /** False once a transfer proves the origin declared no length. */
    lengthKnown: input.lengthKnown !== false,
    segments: input.segments ?? null,
    connections: input.connections ?? null,
    headers: input.headers || {},
    referer: input.referer || null,
    cookies: input.cookies || null,
    username: input.username || null,
    password: input.password || null,
    proxy: input.proxy || null,
    speedLimit: input.speedLimit ?? null,
    priority: input.priority ?? 0,
    queueId: input.queueId ?? "default",
    error: input.error ?? null,
    retries: input.retries ?? 0,
    speed: input.speed ?? 0,
    etag: input.etag ?? null,
    lastModified: input.lastModified ?? null,
    sha256: input.sha256 ?? null,
    createdAt: input.createdAt ?? now,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    updatedAt: now,
    attempts: input.attempts ?? 0,
    tags: input.tags || [],
    /** Extra protocol data (HLS playlist URL, DASH manifest, FTP path...). */
    meta: input.meta || {},
  };
}

/**
 * Statuses whose persisted record must not carry session credentials.
 *
 * This is deliberately wider than TERMINAL (which only holds "complete"
 * because an errored task may still transition): once a task has settled into
 * complete or error, its Cookie/credentials no longer need to survive a
 * restart, so they are stripped on the way to disk. In-flight and paused
 * tasks keep everything — pause → resume must still authenticate.
 */
const CREDENTIAL_FREE = new Set([STATUS.COMPLETE, STATUS.ERROR]);

/**
 * Copy of `headers` without any Cookie header, matched case-insensitively
 * (the wire side writes "Cookie", but a task captured from a browser may
 * carry any casing). Returns the original object untouched when there is
 * nothing to remove, and never mutates the live task.
 */
function withoutCookieHeaders(headers) {
  if (!headers || typeof headers !== "object") return headers;
  const keys = Object.keys(headers);
  if (!keys.some((k) => k.toLowerCase() === "cookie")) return headers;
  const out = {};
  for (const k of keys) if (k.toLowerCase() !== "cookie") out[k] = headers[k];
  return out;
}

/** Fields that must survive a restart; runtime-only fields are dropped. */
export function serializeTask(t) {
  const out = {
    id: t.id, url: t.url, finalUrl: t.finalUrl, filename: t.filename, dir: t.dir,
    category: t.category, status: t.status, kind: t.kind,
    totalBytes: t.totalBytes, downloadedBytes: t.downloadedBytes,
    lengthKnown: t.lengthKnown !== false,
    segments: t.segments, connections: t.connections, headers: t.headers,
    referer: t.referer, cookies: t.cookies, username: t.username, password: t.password,
    proxy: t.proxy, speedLimit: t.speedLimit, priority: t.priority, queueId: t.queueId,
    error: t.error, retries: t.retries, etag: t.etag, lastModified: t.lastModified,
    sha256: t.sha256, createdAt: t.createdAt, startedAt: t.startedAt,
    finishedAt: t.finishedAt, updatedAt: t.updatedAt, attempts: t.attempts,
    tags: t.tags, meta: t.meta,
  };
  // Credential hygiene: a settled task's session credentials must not sit in
  // queue.json forever. The strip happens only here, at the save layer — the
  // in-memory task keeps its credentials, so a retry in this process still
  // authenticates (the runner hands the live object to the downloader, it
  // never re-reads queue.json). There is no migration pass: existing records
  // are rewritten only when the queue is saved anyway, which is the file's
  // own write-temp-then-rename path.
  if (CREDENTIAL_FREE.has(t.status)) {
    out.headers = withoutCookieHeaders(t.headers);
    out.cookies = null;
    out.username = null;
    out.password = null;
  }
  return out;
}

/** Human-facing summary for the API and the GUI. */
export function taskView(t) {
  // A streamed transfer has no denominator. Returning 0 would read as "not
  // started" and 100 as "finished"; null lets the UI say the length is
  // unknown rather than draw a bar that means nothing.
  const known = t.lengthKnown !== false && t.totalBytes !== null && t.totalBytes !== undefined;
  const percent = known && t.totalBytes ? Math.min(100, (t.downloadedBytes / t.totalBytes) * 100) : null;
  return {
    id: t.id, url: t.url, filename: t.filename, dir: t.dir, status: t.status,
    kind: t.kind, totalBytes: t.totalBytes, downloadedBytes: t.downloadedBytes,
    lengthKnown: known,
    percent, speed: t.speed ?? 0, error: t.error, priority: t.priority,
    queueId: t.queueId, createdAt: t.createdAt, startedAt: t.startedAt,
    finishedAt: t.finishedAt, sha256: t.sha256, category: t.category,
    tags: t.tags, retries: t.retries,
    // Surface track-merging outcomes so the UI can explain a silent video or a
    // pair of separate files.
    merged: t.meta && t.meta.merged === true,
    mergeNote: (t.meta && t.meta.mergeNote) || null,
    separateTracks: (t.meta && t.meta.separateTracks) || null,
  };
}
