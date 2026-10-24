#!/usr/bin/env node
// downloadx CLI — runs one transfer directly for one-off use, and drives the
// daemon (queue, GUI, schedules) for everything else.

import path from "node:path";
import fsp from "node:fs/promises";
import process from "node:process";

import { formatBytes, formatSpeed, formatDuration, clamp, parseSize } from "./util.mjs";
import { probe } from "./probe.mjs";
import { DownloadEngine } from "./engine.mjs";
import { Config } from "./config.mjs";
import { Downloader, detectKind as detectUrlKind, chooseOutputName, isResumingSelf } from "./downloader.mjs";
import { ensureDirs } from "./paths.mjs";
import { VERSION as PACKAGE_VERSION } from "./version.mjs";

const VERSION = PACKAGE_VERSION;

const USAGE = [
  "downloadx " + VERSION + " — download manager",
  "",
  "Usage: downloadx <command> [options]",
  "",
  "Commands:",
  "  get <url...>         Download now in the foreground (with progress)",
  "  add <url...>         Add to the persistent queue (starts the daemon)",
  "  list                 Show queued and finished downloads",
  "  task <id>            Show one task in detail",
  "  status               Daemon and queue status",
  "  pause [id|all]       Pause one task or the whole queue",
  "  resume [id|all]      Resume one task or the whole queue",
  "  remove <id>          Remove a task (--delete also deletes the file)",
  "  grab <page>          Queue every downloadable resource the page links to",
  "  sniff <page>         Find media streams on a page and describe them",
  "  stop                 Stop the background daemon",
  "  doctor               Check Node, daemon, API, folders, native host and ffmpeg",
  "  history [q]          Show, search or clear the URL history (add <url> | clear)",
  "  proxy [sub]          Capture proxy: status | start [tunnel|mitm] | stop | list | ca",
  "  open                 Open the web GUI",
  "  daemon               Run the background daemon in the foreground",
  "  config [k[=v]]       Read or write settings",
  "  schedule [...]       List / add / remove scheduled actions",
  "  test                 Run the built-in self-test",
  "  version | help",
  "",
  "Options (get / add):",
  "  -o, --output <p>       Save to this file or directory",
  "  -c, --connections <n>  Connections 1-32",
  "  -s, --segment-size <n> Segment size, e.g. 8M",
  "  -l, --limit <rate>     Speed limit, e.g. 2M",
  "      --proxy <url>      HTTP proxy",
  '  -H, --header "N: v"    Extra request header (repeatable)',
  "      --referer <url>    Referer header",
  "      --cookie <s>       Cookie header",
  "  -u, --username <u>     Credentials",
  "  -p, --password <p>     Credentials",
  "  -k, --insecure         Skip TLS verification",
  "      --filename <n>     Override the saved file name",
  "      --kind <k>         Force http | ftp | hls | dash",
  "  -q, --quiet            No progress output",
  "      --dry-run          Probe and print the plan only",
  "      --json             Machine-readable output (list, task, status)",
  "",
  "Examples:",
  "  downloadx get https://example.com/big.iso -c 16",
  "  downloadx add https://example.com/a.mp4",
  "  downloadx daemon",
].join("\n");

export function parseArgs(argv) {
  const opts = { headers: {}, resume: true, connections: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(a + " needs a value");
      return v;
    };
    switch (a) {
      case "-o": case "--output": opts.output = next(); break;
      case "-c": case "--connections": opts.connections = clamp(Number(next()) | 0, 1, 32); break;
      case "-s": case "--segment-size": opts.segmentSize = parseSize(next()); break;
      case "-l": case "--limit":
        // The foreground CLI uses --limit as a byte rate; history uses it as a
        // row count. Both are recorded and the command picks the one it needs.
        opts.limitRaw = next();
        try { opts.limit = parseSize(opts.limitRaw); } catch { opts.limit = Number(opts.limitRaw) || 0; }
        break;
      case "--proxy": opts.proxy = next(); break;
      case "--referer": opts.referer = next(); break;
      case "--cookie": opts.cookies = next(); break;
      case "-u": case "--username": opts.username = next(); break;
      case "-p": case "--password": opts.password = next(); break;
      case "-k": case "--insecure": opts.insecure = true; break;
      case "--filename": opts.filename = next(); break;
      case "--kind": opts.kind = next(); break;
      case "--priority": opts.priority = Number(next()) || 0; break;
      case "--delete": opts.deleteFile = true; break;
      case "--media-only": opts.mediaOnly = true; break;
      case "--ext": opts.extensions = String(next()).split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--links-only": opts.includeResources = false; break;
      case "-q": case "--quiet": opts.quiet = true; break;
      case "--dry-run": opts.dryRun = true; break;
      // Machine-readable output. Only list, task and status honour it; every
      // other command keeps the human format it has always printed, because
      // its output is a report, not data another program should parse.
      case "--json": opts.json = true; break;
      case "-r": case "--resume": opts.resume = true; break;
      case "--no-resume": opts.resume = false; break;
      case "--port": opts.port = Number(next()) || 0; break;
      case "-h": case "--help": opts.help = true; break;
      case "-V": case "--version": opts.version = true; break;
      case "-H": case "--header": {
        const raw = next();
        const idx = raw.indexOf(":");
        if (idx < 0) throw new Error('header must look like "Name: value": ' + raw);
        opts.headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
        break;
      }
      default:
        if (a.startsWith("-") && a.length > 1) throw new Error("unknown option: " + a);
        positional.push(a);
    }
  }
  return { opts, positional };
}

export function normalizeUrl(raw) {
  let url = String(raw).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = "https://" + url;
  new URL(url);
  return url;
}

function renderBar(percent, width = 28) {
  const filled = clamp(Math.round((percent / 100) * width), 0, width);
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

/**
 * Progress renderer for HLS/DASH transfers.
 *
 * The media path reports progress as *segments completed*, not bytes, so the
 * byte-oriented renderer would print a bar derived from a segment count and
 * label it with bytes. This one shows the fragment counter and stays honest
 * about the fact that no byte total is known for a stream.
 */
function makeMediaRenderer({ quiet }) {
  let last = 0;
  return (p) => {
    if (quiet) return;
    const now = Date.now();
    const percent = typeof p.percent === "number" && Number.isFinite(p.percent) ? p.percent : null;
    if (now - last < 200 && percent !== null && percent < 100) return;
    last = now;
    if (percent === null) {
      // No segment total (live playlist, or a manifest still resolving).
      process.stderr.write("\r\x1b[2K  receiving media...");
      return;
    }
    const line = "  " + renderBar(percent) + " " + percent.toFixed(1).padStart(5) + "%  " +
      (p.bytesWritten ?? 0) + "/" + (p.totalBytes ?? 0) + " segments";
    process.stderr.write("\r\x1b[2K" + line);
  };
}
function makeRenderer({ quiet }) {
  let last = 0;
  return (p) => {
    if (quiet) return;
    const now = Date.now();
    if (now - last < 200 && p.percent < 100) return;
    last = now;
    const line = "  " + renderBar(p.percent) + " " + p.percent.toFixed(1).padStart(5) + "%  " +
      formatBytes(p.bytesWritten) + " / " + formatBytes(p.totalBytes) + "  " +
      formatSpeed(p.speed) + "  ETA " + formatDuration(p.eta ?? 0);
    process.stderr.write("\r\x1b[2K" + line);
  };
}

async function parentExists(p) {
  try { await fsp.stat(path.dirname(p)); return true; } catch { return false; }
}

async function resolveTarget(output, filename) {
  if (!output) return path.resolve(process.cwd(), filename);
  const resolved = path.resolve(output);
  const looksLikeDirectory = /[\\/]$/.test(output) || path.extname(resolved) === "" || !(await parentExists(resolved));
  try {
    const st = await fsp.stat(resolved);
    if (st.isDirectory()) return path.join(resolved, filename);
    if (looksLikeDirectory) throw new Error("--output " + output + " is an existing file, not a directory");
    return resolved;
  } catch (err) {
    if (err && err.message && err.message.includes("not a directory")) throw err;
    if (looksLikeDirectory) {
      await mkdirForUser(resolved, output);
      return path.join(resolved, filename);
    }
    await mkdirForUser(path.dirname(resolved), output);
    return resolved;
  }
}

/**
 * Create an output directory, reporting failure with the path the user typed.
 *
 * Node reports a mkdir failure against its internal long-path spelling (on
 * Windows, a path carrying the double-backslash question-mark prefix), which is
 * not something a user typed or can act on. The message therefore names the
 * original --output value, and the underlying reason after it.
 */
async function mkdirForUser(dir, shown) {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    const reason = (err && (err.code || err.message)) || "unknown error";
    throw new Error("cannot create the output folder for " + shown + ": " + reason);
  }
}

/**
 * How a failed transfer is spelt: the error's own code in brackets, then its
 * message.
 *
 * The media strategies hand the downloader's error straight to the user, so the
 * prefix comes from the error object (its code is set where the refusal is
 * made) instead of being repeated at each call site. Every strategy therefore
 * says the same thing: "error: [ALREADY_EXISTS] file already exists ...".
 *
 * @returns {string} "[CODE] " or "" when the error carries no code
 */
function errorLabel(err) {
  return err && err.code ? "[" + err.code + "] " : "";
}

/**
 * Is this name already occupied — by the finished file, or by anything the
 * engine keeps beside it while a transfer is in flight?
 *
 * The path list comes from Downloader.outputPathSet(), the same list the daemon
 * claims, so the CLI cannot forget a derived name the engine really writes
 * (streaming ".partial", segmented journal ".downloadx", staging
 * ".downloadx-part"). The daemon answers this question from its live claim
 * registry *and* the disk; the CLI runs one foreground transfer and has only
 * the disk to consult.
 */
function takenOnDisk(kind) {
  return async (requested) => {
    for (const p of Downloader.outputPathSet(requested, kind || "http")) {
      try { await fsp.access(p); return true; } catch { /* free */ }
    }
    return false;
  };
}

/**
 * Apply `overwriteExisting` to the path a foreground `get` resolved.
 *
 * The rule is chooseOutputName() — the very function the daemon's #pickName()
 * runs — so `get -o <existing file>` and a queued download answer identically:
 * rename lands beside the old file, skip refuses with ALREADY_EXISTS,
 * overwrite replaces. Nothing here writes anything; the caller decides what a
 * refusal means for its exit code, and `--dry-run` therefore stays read-only
 * however the policy answers.
 *
 * @returns {Promise<{target:string, renamed:boolean, policy:string}>}
 */
async function applyOutputPolicy(targetPath, { config, url, kind }) {
  const policy = config.get("overwriteExisting");
  const decided = await chooseOutputName({
    requested: targetPath,
    policy,
    isTaken: takenOnDisk(kind),
    isResuming: (p) => isResumingSelf(p, url),
  });
  return { target: decided.target, renamed: decided.renamed, policy };
}

/**
 * Foreground HLS/DASH download, delegating to the same media path the daemon
 * uses. Keeping one implementation means a fix in the daemon benefits the CLI
 * too, and the CLI cannot drift into saving a playlist instead of the media.
 *
 * @returns {Promise<number>} 0 on success, 1 on failure
 */
async function runMediaGet(url, kind, opts, config, say) {
  const { QueueManager } = await import("./queue.mjs");

  // --output may name a directory or a file. The plain HTTP path already tells
  // the two apart; doing the same here keeps `get -o movie.mp4 <hls-url>` from
  // creating a directory called movie.mp4.
  //
  // A file path is an instruction about the final artefact, not a hint about
  // where to put things: it must not then be re-routed into a category
  // subfolder or renamed to "movie (2).ts". meta.exactTarget carries that.
  let dir = null;
  let filename = opts.filename || null;
  let exactTarget = false;
  if (opts.output) {
    const resolved = path.resolve(opts.output);
    let stat = null;
    try { stat = await fsp.stat(resolved); } catch { /* not created yet */ }
    const looksLikeDirectory = /[\\/]$/.test(opts.output)
      || (stat ? stat.isDirectory() : path.extname(resolved) === "");
    if (looksLikeDirectory) {
      dir = resolved;
    } else {
      dir = path.dirname(resolved);
      if (!filename) filename = path.basename(resolved);
      // Only an unnamed file path (nothing came from --filename) is treated as
      // the exact artefact. With --filename the user named the file separately
      // and expects the ordinary directory rules to apply.
      exactTarget = !opts.filename;
    }
  }
  // The media strategies create their folder here; a failure must name the
  // path the user asked for (--output, or the configured default folder),
  // not the resolved parent and not Node's internal spelling.
  await mkdirForUser(dir || config.get("defaultDir"), opts.output || config.get("defaultDir"));

  const headers = Object.assign({}, opts.headers,
    opts.referer ? { Referer: opts.referer } : null,
    opts.cookies ? { Cookie: opts.cookies } : null);
  const proxy = opts.proxy || config.get("proxy") || undefined;
  const insecure = opts.insecure || config.get("insecure");

  if (opts.dryRun) {
    return await reportMediaPlan(url, kind, { headers, proxy, insecure }, config, say);
  }

  const queue = new QueueManager({ config });
  await queue.load();
  const downloader = new Downloader({ config, queue });

  // The downloader owns its own AbortController; without handing it this
  // signal, Ctrl-C left a media transfer running to completion.
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);

  const renderer = makeMediaRenderer(opts);
  downloader.on("progress", (p) => renderer(p));
  downloader.on("log", (e) => say(e.message || String(e)));

  const task = {
    id: "cli-" + Date.now().toString(36),
    url,
    kind,
    filename,
    dir,
    headers,
    // Credentials become an Authorization header inside the downloader;
    // dropping them here made every authenticated stream fail.
    username: opts.username || null,
    password: opts.password || null,
    connections: opts.connections || config.get("maxConnections"),
    speedLimit: opts.limit || config.get("speedLimit"),
    proxy,
    insecure,
    signal: controller.signal,
    meta: exactTarget ? { exactTarget: true } : {},
  };

  say("downloading " + kind.toUpperCase() + " stream");

  try {
    const result = await downloader.run(task);
    if (!opts.quiet) process.stderr.write("\r\x1b[2K");

    // A failed merge means the requested deliverable was not produced:
    // report a failure rather than a success summary over track files.
    if (result.meta && result.meta.mergeNote) {
      process.stdout.write("  file: " + result.target + "\n");
      process.stderr.write("  error: track merge failed: " + result.meta.mergeNote + "\n");
      if (result.meta.separateTracks && result.meta.separateTracks.length) {
        process.stderr.write("  tracks kept separate:\n");
        for (const t of result.meta.separateTracks) process.stderr.write("    " + t + "\n");
      }
      return 1;
    }

    // An empty artefact is not a downloaded stream and must not be reported
    // as one, however cheerful the summary would look.
    if (!result.ok || !(result.bytes > 0)) {
      process.stderr.write("  error: no media was produced for " + url + "\n");
      return 1;
    }

    process.stdout.write(
      "  done: " + formatBytes(result.bytes) + "\n" +
      "  file: " + result.target + "\n" +
      "  sha256: " + result.sha256 + "\n" +
      (result.meta && result.meta.segments ? "  segments: " + result.meta.segments + "\n" : "") +
      (result.meta && result.meta.merged ? "  tracks merged\n" : "")
    );
    return 0;
  } catch (err) {
    if (!opts.quiet) process.stderr.write("\r\x1b[2K");
    if (controller.signal.aborted) process.stderr.write("  cancelled\n");
    else process.stderr.write("  error: " + errorLabel(err) + ((err && err.message) || err) + "\n");
    return 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
/**
 * Describe a media URL without transferring it, for --dry-run.
 *
 * Only the playlist or manifest is fetched. --dry-run promises that no media
 * is downloaded, so resolving the fragment list is as far as this goes.
 *
 * @returns {Promise<number>} 0 when the plan was printed, 1 when it could not be
 */
async function reportMediaPlan(url, kind, { headers, proxy, insecure }, config, say) {
  try {
    if (kind === "hls") {
      const { resolvePlaylist } = await import("./hls.mjs");
      const { playlist, variants, chosen } = await resolvePlaylist(url, { headers, proxy, insecure });
      if (!playlist.isMedia || !playlist.segments.length) {
        process.stderr.write("  error: the playlist contains no media segments" + "\n");
        return 1;
      }
      process.stdout.write("  kind: hls" + (variants.length ? "  variants: " + variants.length : "") + "\n");
      if (chosen && chosen.RESOLUTION) process.stdout.write("  variant: " + chosen.RESOLUTION + "\n");
      process.stdout.write("  plan: " + playlist.segments.length + " segment(s), " +
        formatDuration(playlist.duration) + " seconds of declared media" + "\n");
      return 0;
    }

    const { requestFollow, readBody } = await import("./net.mjs");
    const { parseMpd, selectTracks, listSegments } = await import("./dash.mjs");
    const res = await requestFollow(url, { headers, proxy, insecure });
    const mpd = parseMpd((await readBody(res)).toString("utf8"), url);
    const tracks = selectTracks(mpd, {});
    if (!tracks.video && !tracks.audio) {
      process.stderr.write("  error: the manifest has no usable representation" + "\n");
      return 1;
    }
    process.stdout.write("  kind: dash" + "\n");
    for (const [label, rep] of [["video", tracks.video], ["audio", tracks.audio]]) {
      if (!rep) continue;
      const segs = listSegments(mpd, rep, {});
      if (!segs.length) {
        process.stderr.write("  error: the " + label + " representation produced no segments" + "\n");
        return 1;
      }
      process.stdout.write("  plan: " + label + " representation " + rep.id + ", " + segs.length + " segment(s)" + "\n");
    }
    return 0;
  } catch (err) {
    process.stderr.write("  error: could not read the media manifest: " + ((err && err.message) || err) + "\n");
    return 1;
  }
}
/**
 * Foreground download for a resource with no declared length.
 *
 * Streams once to a temporary file and renames on success, so a partial
 * transfer never occupies the final path. Reports bytes received rather
 * than a percentage, because the total is genuinely unknown.
 *
 * @returns {Promise<number>} 0 on success, 1 on failure
 */
async function runStreamingGet(url, opts, config, say, info) {
  say("length: unknown (streaming in a single pass)");
  let targetPath;
  let policyUsed = "rename";
  let renamed = false;
  try {
    const decided = await applyOutputPolicy(
      await resolveTarget(opts.output, opts.filename || info.filename),
      { config, url, kind: "http" },
    );
    targetPath = decided.target;
    policyUsed = decided.policy;
    renamed = decided.renamed;
  } catch (err) {
    // skip refuses before a byte is written: say which file is protected and
    // stop, instead of streaming over it.
    if (err && err.code === "ALREADY_EXISTS") {
      process.stderr.write("  error: " + errorLabel(err) + err.message + "\n");
      return 1;
    }
    throw err;
  }
  if (renamed) say("an existing file was kept — overwriteExisting=" + policyUsed + " puts this one beside it");
  say("saving to " + targetPath);

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);

  const engine = new DownloadEngine({
    url,
    targetPath,
    connections: 1,
    headers: opts.headers,
    proxy: opts.proxy || config.get("proxy") || undefined,
    insecure: opts.insecure || config.get("insecure"),
    maxRate: opts.limit || config.get("speedLimit"),
    signal: controller.signal,
  });

  let received = 0;
  let lastRender = 0;
  const render = () => {
    if (opts.quiet) return;
    const now = Date.now();
    if (now - lastRender < 200) return;
    lastRender = now;
    process.stderr.write("\r\x1b[2K  received " + formatBytes(received) + "  (total unknown)");
  };

  try {
    const result = await engine.runStreaming({
      url,
      targetPath,
      headers: opts.headers,
      proxy: opts.proxy || config.get("proxy") || undefined,
      insecure: opts.insecure || config.get("insecure"),
      maxRate: opts.limit || config.get("speedLimit"),
      signal: controller.signal,
      onProgress: (prog) => { received = prog.bytesWritten; render(); },
    });
    if (!opts.quiet) process.stderr.write("\r\x1b[2K");
    process.stdout.write(
      "  done: " + formatBytes(result.bytes) + "\n" +
      "  file: " + targetPath + "\n" +
      "  sha256: " + result.sha256 + "\n" +
      "  length: unknown (not resumable; re-running restarts)\n"
    );
    return 0;
  } catch (err) {
    if (!opts.quiet) process.stderr.write("\r\x1b[2K");
    if (controller.signal.aborted) process.stderr.write("  cancelled — the partial file was removed\n");
    else process.stderr.write("  error: " + err.message + "\n");
    return 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
async function cmdGet(urls, opts) {
  const config = new Config();
  await config.load();
  let failures = 0;

  for (const raw of urls) {
    let url;
    try { url = normalizeUrl(raw); } catch { process.stderr.write("  error: not a valid URL: " + raw + "\n"); failures++; continue; }
    const say = (m) => { if (!opts.quiet) process.stderr.write("\n  " + m + "\n"); };

    // Media playlists (HLS/DASH) are not single resources: the downloader
    // fetches every fragment and merges the tracks. Running them through the
    // segmented HTTP engine would save the manifest text instead of the
    // media, so the strategy is chosen before probing.
    const requestedKind = opts.kind ? String(opts.kind).toLowerCase() : null;
    const kind = requestedKind || detectUrlKind(url);
    if (kind === "hls" || kind === "dash") {
      const code = await runMediaGet(url, kind, opts, config, say);
      if (code !== 0) failures++;
      continue;
    }

    say("probing " + url);

    let info;
    try {
      const headers = Object.assign({}, opts.headers);
      if (opts.referer) headers.Referer = opts.referer;
      if (opts.cookies) headers.Cookie = opts.cookies;
      info = await probe(url, {
        headers,
        proxy: opts.proxy || config.get("proxy") || undefined,
        insecure: opts.insecure || config.get("insecure"),
      });
    } catch (err) {
      process.stderr.write("  error: probe failed: " + err.message + "\n");
      failures++;
      continue;
    }

    say(info.finalUrl);
    say("size: " + (info.totalBytes ? formatBytes(info.totalBytes) : "unknown") +
        "  ranges: " + (info.supportsRanges ? "yes" : "no") + "  type: " + (info.contentType || "?"));

    // A chunked or otherwise undeclared length cannot be split into ranges,
    // so it is streamed in one pass instead of failing outright. The size and
    // the percentage stay unknown: reporting a number here would be invented.
    if (!info.totalBytes) {
      const code = await runStreamingGet(url, opts, config, say, info);
      if (code !== 0) failures++;
      continue;
    }

    let targetPath;
    let policyUsed = "rename";
    let renamed = false;
    try {
      const decided = await applyOutputPolicy(
        await resolveTarget(opts.output, opts.filename || info.filename),
        { config, url, kind: "http" },
      );
      targetPath = decided.target;
      policyUsed = decided.policy;
      renamed = decided.renamed;
    } catch (err) {
      if (err && err.code === "ALREADY_EXISTS") {
        process.stderr.write("  error: " + errorLabel(err) + err.message + "\n");
        failures++;
        continue;
      }
      throw err;
    }
    if (renamed) say("an existing file was kept — overwriteExisting=" + policyUsed + " puts this one beside it");
    say("saving to " + targetPath);

    if (opts.dryRun) {
      const { planSegments } = await import("./plan.mjs");
      const plan = planSegments(info.totalBytes, {
        connections: opts.connections || config.get("maxConnections"),
        segmentBytes: opts.segmentSize || config.get("segmentBytes"),
      });
      process.stdout.write("\n  plan: " + plan.length + " segment(s)\n");
      for (const s of plan) {
        process.stdout.write("    #" + s.index + "  " + s.start + "-" + s.end + "  (" + formatBytes(s.end - s.start + 1) + ")\n");
      }
      continue;
    }

    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once("SIGINT", onSigint);

    const engine = new DownloadEngine({
      url,
      targetPath,
      connections: opts.connections || config.get("maxConnections"),
      segmentBytes: opts.segmentSize || config.get("segmentBytes"),
      headers: opts.headers,
      proxy: opts.proxy || config.get("proxy") || undefined,
      insecure: opts.insecure || config.get("insecure"),
      maxRate: opts.limit || config.get("speedLimit"),
      signal: controller.signal,
    });

    engine.on("progress", makeRenderer(opts));
    engine.on("log", (m) => say(m));
    engine.on("retry", (r) => say("retry segment #" + r.segment + " (attempt " + r.attempt + ", +" + r.delay + "ms): " + r.error));
    engine.on("downgrade", (m) => say(m));

    try {
      const result = await engine.run({ probe: info, resume: opts.resume });
      if (!opts.quiet) process.stderr.write("\r\x1b[2K");
      process.stdout.write(
        "  done: " + formatBytes(result.bytes) + " in " + formatDuration(result.elapsedMs / 1000) +
        " (" + formatSpeed(result.bytes / (result.elapsedMs / 1000)) + ")\n" +
        // The path actually written, not the one asked for: under the rename
        // policy these differ by "(2)" and only the real one can be found.
        "  file: " + targetPath + "\n" +
        "  sha256: " + result.sha256 + "\n" +
        "  retries: " + (result.retries || 0) + (result.downgraded ? "  (degraded: " + result.reason + ")" : "") + "\n"
      );
    } catch (err) {
      if (!opts.quiet) process.stderr.write("\r\x1b[2K");
      if (controller.signal.aborted) process.stderr.write("  cancelled — re-run the same command to resume\n");
      else process.stderr.write("  error: " + err.message + "\n");
      failures++;
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  }
  return failures ? 1 : 0;
}

async function client() {
  const { readRuntime } = await import("./daemon.mjs");
  const rt = await readRuntime();
  if (!rt) return null;
  const call = async (method, route, body) => {
    const headers = { "x-downloadx-token": rt.token };
    if (body) headers["content-type"] = "application/json";
    const res = await fetch("http://" + rt.host + ":" + rt.port + route, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    return { status: res.status, payload };
  };
  return { rt, call };
}

async function ensureDaemon(opts = {}) {
  const existing = await client();
  if (existing) return existing;

  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { paths } = await import("./paths.mjs");
  // The daemon must be launched through the executable entry point, which is
  // the module that actually calls main(). This file (src/cli.mjs) is a plain
  // module: running it directly is a no-op that exits 0, which made every cold
  // start look like a slow startup and then time out.
  const selfPath = fileURLToPath(new URL("../bin/downloadx.mjs", import.meta.url));

  // A runtime file left by a crashed daemon must not send us looking for a
  // process that is gone; readRuntime already validates the pid, so a null
  // here means no live daemon.
  // stdio is deliberately "ignore". Attaching pipes and then releasing them
  // breaks the daemon: on shutdown it writes a line to stderr, which becomes an
  // EPIPE on a closed pipe and kills the process mid-stop — leaving the runtime
  // file behind so `stop` reports a timeout. The daemon already writes
  // everything to its own log, so diagnostics come from there instead of a pipe.
  const child = spawn(process.execPath, [selfPath, "daemon"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  let exited = null;
  let exitSignal = null;
  child.on("exit", (code, signal) => { exited = code; exitSignal = signal; });
  child.on("error", () => { exited = -1; });
  child.unref();

  /** Recent daemon log lines, used to explain a failed start. */
  const logTail = async (n = 8) => {
    try {
      const text = await fsp.readFile(path.join(paths.logs, "downloadx.log"), "utf8");
      return text.split(/\r?\n/).filter(Boolean).slice(-n).join("\n    ");
    } catch { return ""; }
  };

  // Poll rather than sleep a fixed amount: startup time varies, and a longer
  // fixed wait would only hide a genuine failure.
  const deadlineMs = opts.timeoutMs ?? 20000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    await new Promise((r) => setTimeout(r, 150));

    // The child died: report why instead of waiting out the full timeout.
    if (exited !== null) {
      const detail = await logTail();
      throw new Error(
        "the daemon exited during startup (exit " + exited +
        (exitSignal ? ", signal " + exitSignal : "") + ")" +
        (detail ? "\n    " + detail : "")
      );
    }

    const c = await client();
    if (c) return c;
  }

  // Timed out. Distinguish the plausible causes so the message is actionable.
  let hint = "";
  try {
    const raw = JSON.parse(await fsp.readFile(paths.runtime, "utf8"));
    if (raw && raw.pid) {
      let alive = true;
      try { process.kill(raw.pid, 0); } catch { alive = false; }
      hint = alive
        ? "\n    a process holds the runtime file (pid " + raw.pid + ") but its API is unreachable on " + raw.host + ":" + raw.port
        : "\n    the runtime file references pid " + raw.pid + ", which is not running";
    }
  } catch { /* no readable runtime file */ }

  try { child.kill(); } catch { /* already gone */ }
  const tail = await logTail();
  throw new Error(
    "the daemon did not answer within " + deadlineMs + " ms" + hint +
    (tail ? "\n    daemon output:\n    " + tail : "") +
    "\n    try running: downloadx daemon"
  );
}

async function cmdAdd(urls, opts) {
  const c = await ensureDaemon();
  const added = [];
  for (const raw of urls) {
    let url;
    try { url = normalizeUrl(raw); } catch { process.stderr.write("  skip (invalid URL): " + raw + "\n"); continue; }
    const { status, payload } = await c.call("POST", "/api/tasks", {
      url,
      filename: opts.filename,
      dir: opts.output,
      connections: opts.connections,
      headers: opts.headers,
      referer: opts.referer,
      cookies: opts.cookies,
      username: opts.username,
      password: opts.password,
      speedLimit: opts.limit,
      priority: opts.priority,
      kind: opts.kind,
    });
    if (status === 201) {
      added.push(payload.task);
      process.stdout.write("  added " + payload.task.id.slice(0, 8) + "  " + payload.task.url + "\n");
    } else {
      process.stderr.write("  failed: " + (payload.error || status) + "\n");
    }
  }
  if (added.length) {
    process.stdout.write("\n  " + added.length + " task(s) queued.  GUI: " + c.rt.url + "\n");
    return 0;
  }
  return 1;
}

function printTasks(tasks) {
  if (!tasks.length) {
    process.stdout.write("  (no downloads)\n");
    return;
  }
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  process.stdout.write("  " + pad("ID", 10) + " " + pad("STATUS", 12) + " " + pad("PROGRESS", 24) + " " + pad("SPEED", 12) + "NAME\n");
  for (const t of tasks) {
    const pct = t.percent ? t.percent.toFixed(1) + "%" : "—";
    const prog = pct + " " + formatBytes(t.downloadedBytes) + "/" + (t.totalBytes ? formatBytes(t.totalBytes) : "?");
    process.stdout.write(
      "  " + pad(t.id.slice(0, 8), 10) + " " + pad(t.status, 12) + " " + pad(prog, 24) + " " +
      pad(t.speed ? formatSpeed(t.speed) : "—", 12) + " " + (t.filename || t.url) + "\n"
    );
  }
}

/**
 * Print one task in detail.
 *
 * Deliberately not JSON by default: a human reading a terminal asked for the
 * task, and the machine-readable form is one flag away.
 */
function printTask(t) {
  const pct = typeof t.percent === "number" ? t.percent.toFixed(1) + "%" : "—";
  const lines = [
    "  id:       " + t.id,
    "  status:   " + t.status,
    "  name:     " + (t.filename || "(not resolved yet)"),
    "  dir:      " + (t.dir || "(daemon default)"),
    "  progress: " + pct + " " + formatBytes(t.downloadedBytes) + "/" +
      (t.totalBytes ? formatBytes(t.totalBytes) : "?"),
    "  speed:    " + (t.speed ? formatSpeed(t.speed) : "—"),
    "  sha256:   " + (t.sha256 || "—"),
  ];
  if (t.error) lines.push("  error:    " + t.error);
  process.stdout.write(lines.join("\n") + "\n");
}

async function cmdList(opts = {}) {
  const c = await client();
  if (!c) {
    if (opts.json) {
      // Still parseable: an agent must not have to guess whether an empty
      // answer means "no tasks" or "no daemon".
      process.stdout.write(JSON.stringify({ tasks: [], count: 0, daemon: { running: false } }) + "\n");
      return 0;
    }
    process.stdout.write("  daemon not running (start it with: downloadx daemon)\n");
    return 0;
  }
  const { payload } = await c.call("GET", "/api/tasks");
  const tasks = payload.tasks || [];
  if (opts.json) {
    process.stdout.write(JSON.stringify({ tasks, count: tasks.length }) + "\n");
    return 0;
  }
  printTasks(tasks);
  return 0;
}

/**
 * Resolve a task id, accepting an unambiguous prefix.
 *
 * The daemon only answers full ids, but every human-facing command in this CLI
 * shows the first eight characters, so a short id has to work here too or the
 * output cannot be pasted back in.
 *
 * @returns {Promise<{task: object|null, reason: "ok"|"missing"|"ambiguous"}>}
 */
async function findTask(c, id) {
  const direct = await c.call("GET", "/api/tasks/" + encodeURIComponent(id));
  if (direct.status === 200 && direct.payload && direct.payload.task) {
    return { task: direct.payload.task, reason: "ok" };
  }
  const list = await c.call("GET", "/api/tasks");
  const matches = (list.payload.tasks || []).filter((t) => t.id.startsWith(id));
  if (matches.length === 1) return { task: matches[0], reason: "ok" };
  return { task: null, reason: matches.length > 1 ? "ambiguous" : "missing" };
}

async function cmdTask(id, opts = {}) {
  if (!id) {
    process.stderr.write("error: task needs a task id\n");
    return 2;
  }
  const c = await client();
  if (!c) {
    if (opts.json) process.stderr.write(JSON.stringify({ error: "daemon not running", code: "ENODAEMON" }) + "\n");
    else process.stderr.write("  daemon not running (start it with: downloadx daemon)\n");
    return 1;
  }

  const { task, reason } = await findTask(c, id);
  if (!task) {
    if (opts.json) {
      // One line on stderr, exit 2: "you asked for something that is not
      // there" is a caller error, not a daemon failure.
      process.stderr.write(JSON.stringify({ error: "no such task", code: "ENOTASK" }) + "\n");
    } else if (reason === "ambiguous") {
      process.stderr.write("  " + id + " is ambiguous\n");
    } else {
      process.stderr.write("  no such task: " + id + "\n");
    }
    return 2;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ task }) + "\n");
    return 0;
  }
  printTask(task);
  return 0;
}

async function cmdStatus(opts = {}) {
  const c = await client();
  if (!c) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ daemon: { running: false, url: null }, queue: null }) + "\n");
      return 1;
    }
    process.stdout.write("  daemon: not running\n");
    return 1;
  }
  const { payload } = await c.call("GET", "/api/status");
  const s = payload.queue || {};
  if (opts.json) {
    process.stdout.write(JSON.stringify({
      daemon: { running: true, url: c.rt.url, version: payload.version, uptimeMs: payload.uptimeMs || 0 },
      queue: s,
    }) + "\n");
    return 0;
  }
  process.stdout.write(
    "  daemon:  " + c.rt.url + "\n" +
    "  uptime:  " + formatDuration((payload.uptimeMs || 0) / 1000) + "\n" +
    "  tasks:   " + (s.total || 0) + " total, " + (s.active || 0) + " active, " + (s.queued || 0) +
    " queued, " + (s.complete || 0) + " done, " + (s.error || 0) + " failed\n" +
    "  speed:   " + formatSpeed(s.totalSpeed || 0) + "\n" +
    "  slots:   " + (s.active || 0) + "/" + (s.capacity || 0) + "\n"
  );
  return 0;
}

async function cmdControl(action, target) {
  const c = await client();
  if (!c) { process.stderr.write("  daemon not running\n"); return 1; }
  if (target === "all" || !target) {
    const route = action === "pause" ? "/api/queue/pause" : "/api/queue/resume";
    await c.call("POST", route);
  } else {
    const { status, payload } = await c.call("POST", "/api/tasks/" + encodeURIComponent(target) + "/" + action);
    if (status >= 400) { process.stderr.write("  " + (payload.error || status) + "\n"); return 1; }
  }
  process.stdout.write("  " + action + " ok\n");
  return 0;
}

async function cmdRemove(id, opts) {
  const c = await client();
  if (!c) { process.stderr.write("  daemon not running\n"); return 1; }
  const { payload: listPayload } = await c.call("GET", "/api/tasks");
  const match = (listPayload.tasks || []).filter((t) => t.id.startsWith(id));
  if (match.length === 0) { process.stderr.write("  no task matching " + id + "\n"); return 1; }
  if (match.length > 1) { process.stderr.write("  " + id + " is ambiguous (" + match.length + " matches)\n"); return 1; }
  await c.call("DELETE", "/api/tasks/" + match[0].id + (opts.deleteFile ? "?deleteFile=1" : ""));
  process.stdout.write("  removed " + match[0].id.slice(0, 8) + "\n");
  return 0;
}

async function cmdConfig(rest) {
  const config = new Config();
  await config.load();
  if (rest.length === 0) {
    process.stdout.write(JSON.stringify(config.values, null, 2) + "\n");
    return 0;
  }
  const joined = rest.join(" ");
  const eq = joined.indexOf("=");
  if (eq < 0) {
    const v = config.get(joined);
    if (v === undefined) { process.stderr.write("  unknown key: " + joined + "\n"); return 1; }
    process.stdout.write(typeof v === "object" ? JSON.stringify(v, null, 2) + "\n" : String(v) + "\n");
    return 0;
  }
  const key = joined.slice(0, eq).trim();
  const raw = joined.slice(eq + 1).trim();
  let parsed = raw;
  if (/^-?\d+$/.test(raw)) parsed = Number(raw);
  else if (raw === "true" || raw === "false") parsed = raw === "true";
  else if (raw.startsWith("{") || raw.startsWith("[")) { try { parsed = JSON.parse(raw); } catch { parsed = raw; } }
  await config.set({ [key]: parsed });
  process.stdout.write("  " + key + " = " + JSON.stringify(parsed) + "\n");
  return 0;
}

async function cmdSchedule(rest) {
  const c = await client();
  if (!c) { process.stderr.write("  daemon not running\n"); return 1; }
  if (rest.length === 0) {
    const { payload } = await c.call("GET", "/api/scheduler");
    const list = payload.schedules || [];
    if (!list.length) { process.stdout.write("  (no schedules)\n"); return 0; }
    for (const s of list) {
      process.stdout.write("  " + s.id.slice(0, 8) + "  " + (s.at || "—") + "  " + s.action + "  " + (s.enabled ? "enabled" : "disabled") + "  " + s.name + "\n");
    }
    return 0;
  }
  if (rest[0] === "add") {
    const at = rest[1];
    const action = rest[2] || "resume";
    const name = rest.slice(3).join(" ") || "schedule";
    const { payload } = await c.call("POST", "/api/scheduler", { at, action, name });
    process.stdout.write("  added " + ((payload.schedule && payload.schedule.id) ? payload.schedule.id.slice(0, 8) : "?") + " at " + at + "\n");
    return 0;
  }
  if (rest[0] === "remove" || rest[0] === "rm") {
    await c.call("DELETE", "/api/scheduler/" + encodeURIComponent(rest[1]));
    process.stdout.write("  removed\n");
    return 0;
  }
  process.stderr.write("  usage: downloadx schedule [add <HH:MM> <action> [name] | remove <id>]\n");
  return 1;
}


async function cmdGrab(rest, opts) {
  const target = rest[0];
  if (!target) { process.stderr.write("error: grab needs a page URL\n"); return 2; }
  const c = await ensureDaemon();
  const { status, payload } = await c.call("POST", "/api/grab", {
    url: target,
    queue: true,
    dir: opts.output,
    mediaOnly: Boolean(opts.mediaOnly),
    extensions: opts.extensions,
    includeResources: opts.includeResources,
  });
  if (status !== 200 || payload.error) {
    process.stderr.write("  error: " + (payload.error || status) + "\n");
    return 1;
  }
  process.stdout.write("  found " + payload.page.total + " resource(s) on " + payload.page.finalUrl + "\n");
  process.stdout.write("  queued " + payload.queued + "\n");
  for (const item of payload.items || []) {
    process.stdout.write("    " + (item.id ? item.id.slice(0, 8) : "FAILED  ") + "  " + item.url + (item.error ? "  (" + item.error + ")" : "") + "\n");
  }
  return 0;
}

async function cmdSniff(rest, opts) {
  const target = rest[0];
  if (!target) { process.stderr.write("error: sniff needs a page URL\n"); return 2; }
  const c = await ensureDaemon();
  const { payload } = await c.call("POST", "/api/sniff", { url: target });
  if (payload.error) { process.stderr.write("  error: " + payload.error + "\n"); return 1; }
  const list = payload.candidates || [];
  if (!list.length) { process.stdout.write("  no media streams found on " + payload.finalUrl + "\n"); return 0; }
  process.stdout.write("  " + list.length + " candidate(s) on " + payload.finalUrl + "\n");
  for (const cnd of list) {
    const detail = await c.call("POST", "/api/inspect-stream", { url: cnd.url });
    const d = detail.payload || {};
    let summary = cnd.kind;
    if (d.master && d.variants && d.variants.length) summary += ", " + d.variants.length + " variant(s), best " + (d.best && d.best.resolution ? d.best.resolution : "?");
    else if (d.segmentCount !== undefined && d.segmentCount !== null) summary += ", " + d.segmentCount + " segment(s)" + (d.live ? ", LIVE" : "") + (d.encrypted ? ", encrypted" : "");
    else if (d.totalBytes) summary += ", " + formatBytes(d.totalBytes);
    else if (d.representations) summary += ", " + d.representations.length + " representation(s)";
    process.stdout.write("    [" + summary + "]  " + cnd.url + "\n");
  }
  return 0;
}

async function cmdStop() {
  const c = await client();
  if (!c) { process.stdout.write("  daemon is not running\n"); return 0; }
  const { status, payload } = await c.call("POST", "/api/shutdown");
  if (status !== 200 || !payload.ok) { process.stderr.write("  stop failed: " + (payload.error || status) + "\n"); return 1; }
  // Wait for the runtime file to disappear so the caller knows it stopped.
  const { paths } = await import("./paths.mjs");
  const fsp = (await import("node:fs/promises"));
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try { await fsp.access(paths.runtime); } catch { process.stdout.write("  daemon stopped\n"); return 0; }
  }
  process.stdout.write("  stop requested (still shutting down)\n");
  return 0;
}

async function cmdProxy(rest, opts) {
  const c = await client();
  if (!c) { process.stderr.write("  daemon not running; start it with: downloadx daemon\n"); return 1; }
  const sub = rest[0] || "status";

  if (sub === "status") {
    const { payload } = await c.call("GET", "/api/proxy/status");
    const st = payload.proxy || {};
    process.stdout.write(
      "  capture proxy: " + (st.running ? "running on " + st.host + ":" + st.port : "stopped") + "\n" +
      "  mode:          " + (st.mode || "?") + (st.mode === "tunnel" ? "  (HTTPS destinations visible, content not)" : "  (HTTPS decrypted)") + "\n" +
      "  captures:      " + ((st.stats && st.stats.captured) || 0) + "  requests: " + ((st.stats && st.stats.requests) || 0) + "  tunnels: " + ((st.stats && st.stats.tunnels) || 0) + "\n" +
      "  CA cert:       " + (payload.ca && payload.ca.installed ? payload.ca.certPath : "not created") + "\n"
    );
    if (st.running) {
      process.stdout.write("\n  Point a client at it, e.g. curl -x http://" + st.host + ":" + st.port + " https://example.com/file.zip\n");
    }
    return 0;
  }

  if (sub === "start") {
    const mode = rest[1] === "mitm" ? "mitm" : (rest[1] === "tunnel" ? "tunnel" : undefined);
    const { status, payload } = await c.call("POST", "/api/proxy/start", mode ? { mode } : {});
    if (status !== 200) { process.stderr.write("  failed: " + (payload.error || status) + "\n"); return 1; }
    process.stdout.write("  capture proxy listening on " + payload.host + ":" + payload.port + " (" + payload.mode + ")\n");
    if (payload.mode === "tunnel") {
      process.stdout.write("  HTTPS traffic is tunnelled: destinations are visible, content is not.\n");
    }
    return 0;
  }

  if (sub === "stop") {
    await c.call("POST", "/api/proxy/stop");
    process.stdout.write("  capture proxy stopped\n");
    return 0;
  }

  if (sub === "list") {
    const { payload } = await c.call("GET", "/api/proxy/captures?limit=" + (opts.limit || 40));
    const list = payload.captures || [];
    if (!list.length) { process.stdout.write("  nothing captured yet\n"); return 0; }
    for (const e of list) {
      const size = e.contentLength ? formatBytes(e.contentLength) : "?";
      process.stdout.write("  " + String(e.confidence).padEnd(6) + " " + size.padStart(10) + "  " + String(e.filename).slice(0, 40).padEnd(42) + " " + e.reason + "\n");
      process.stdout.write("         " + e.url + "\n");
    }
    return 0;
  }

  if (sub === "clear") {
    const { payload } = await c.call("POST", "/api/proxy/captures/clear");
    process.stdout.write("  cleared " + payload.removed + " capture(s)\n");
    return 0;
  }

  if (sub === "ca") {
    const action = rest[1] || "show";
    if (action === "create") {
      const { status, payload } = await c.call("POST", "/api/proxy/ca");
      if (status !== 200) { process.stderr.write("  failed: " + (payload.error || status) + "\n"); return 1; }
      process.stdout.write("  CA certificate: " + payload.certPath + "\n  " + payload.installHint + "\n");
      return 0;
    }
    if (action === "destroy") {
      await c.call("POST", "/api/proxy/ca/destroy");
      process.stdout.write("  CA removed\n");
      return 0;
    }
    const { payload } = await c.call("GET", "/api/proxy/status");
    const ca = payload.ca || {};
    process.stdout.write("  installed: " + Boolean(ca.installed) + "\n  cert: " + (ca.certPath || "-") + "\n  key:  " + (ca.keyPath || "-") + "\n");
    if (ca.installed) process.stdout.write("  " + ca.installHint + "\n");
    return 0;
  }

  process.stderr.write("  usage: downloadx proxy [status|start [tunnel|mitm]|stop|list|clear|ca [show|create|destroy]]\n");
  return 1;
}

/**
 * Report on every component a user needs working, and say what to do about each
 * one that is not.
 *
 * Written for the situation the user is actually in: something did not work and
 * there is no obvious next step. Every line is either fine or "here is the
 * command", never a bare status code. No cookie, token or private URL is shown.
 *
 * @returns {Promise<number>} 0 when everything needed to download works
 */
async function cmdDoctor() {
  const { paths } = await import("./paths.mjs");
  const { findFfmpeg } = await import("./merge.mjs");
  const lines = [];
  let problems = 0;

  const ok = (label, detail) => lines.push(["ok", label, detail]);
  const warn = (label, detail, fix) => lines.push(["warn", label, detail + (fix ? "  -> " + fix : "")]);
  const bad = (label, detail, fix) => {
    problems++;
    lines.push(["FAIL", label, detail + (fix ? "  -> " + fix : "")]);
  };

  // ---- Node ------------------------------------------------------------
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok("node", "v" + process.versions.node);
  else bad("node", "v" + process.versions.node + " is older than the required v20",
    "install a current Node.js from nodejs.org and reopen the terminal");

  // ---- runtime directories --------------------------------------------
  try {
    await ensureDirs();
    const probe = path.join(paths.root, ".doctor-write-probe");
    await fsp.writeFile(probe, "ok", "utf8");
    await fsp.rm(probe, { force: true });
    ok("runtime dir", paths.root);
  } catch (err) {
    bad("runtime dir", paths.root + " is not writable: " + err.message,
      "check the folder permissions, or set DOWNLOADX_HOME to a writable path");
  }

  // ---- settings and download folder -----------------------------------
  try {
    const cfg = new Config();
    await cfg.load();
    const dir = cfg.get("defaultDir");
    let writable = true;
    try {
      await fsp.mkdir(dir, { recursive: true });
      const probe = path.join(dir, ".doctor-write-probe");
      await fsp.writeFile(probe, "ok", "utf8");
      await fsp.rm(probe, { force: true });
    } catch { writable = false; }
    if (writable) ok("download folder", dir);
    else bad("download folder", dir + " is not writable",
      "change it in the GUI Settings, or with: downloadx config defaultDir=<path>");
  } catch (err) {
    bad("config", "could not load the settings: " + err.message,
      "delete " + paths.config + " to start from the defaults (your downloads are not touched)");
  }

  // ---- daemon and API -------------------------------------------------
  const c = await client();
  if (c) {
    ok("daemon", "running at " + c.rt.url + " (pid " + c.rt.pid + ")");
    try {
      const { status, payload } = await c.call("GET", "/api/status");
      if (status === 200) {
        const q = payload.queue || {};
        ok("api", "responding; " + (q.total || 0) + " task(s), " + (q.active || 0) + " active");
        if (payload.capabilities && payload.capabilities.ffmpeg) ok("ffmpeg", payload.capabilities.ffmpeg);
        else warn("ffmpeg", "not found, so adaptive video stays as separate track files",
          "install ffmpeg on PATH, or set ffmpegPath in the GUI Settings");
      } else {
        bad("api", "answered HTTP " + status, "restart the daemon: downloadx stop  then  downloadx daemon");
      }
    } catch (err) {
      bad("api", "unreachable although the runtime file exists: " + err.message,
        "the daemon may be wedged; run downloadx stop, then start it again");
    }
  } else {
    // Not running yet is normal, so it is not counted as a failure.
    warn("daemon", "not running", "start it with: node bin/downloadx.mjs daemon   (or downloadx.cmd)");
    let stale = false;
    try { await fsp.access(paths.runtime); stale = true; } catch { /* absent, healthy */ }
    if (stale) {
      bad("runtime file", paths.runtime + " exists but no live process answers",
        "delete it: it is left over from a crashed daemon and makes clients wait for it");
    }
  }

  // ---- native messaging host ------------------------------------------
  try {
    const install = await import("../extension/install.mjs");
    const st = install.status();
    const usable = st.filter((s) => s.usable);
    const registered = st.filter((s) => s.installed);
    if (usable.length) {
      ok("native host", "usable for " + usable.map((s) => s.browser).join(", "));
    } else if (registered.length) {
      bad("native host",
        "registered for " + registered.map((s) => s.browser).join(", ") + " but not usable: " +
        (registered[0].reason || "unknown reason"),
        "run: node extension/install.mjs install --extension-id <the id on the extension card>");
    } else {
      warn("native host", "not registered for any browser",
        "run: node extension/install.mjs install --extension-id <the id on the extension card>");
    }
  } catch (err) {
    warn("native host", "could not be checked: " + err.message, "run: node extension/install.mjs status");
  }

  // ---- output ---------------------------------------------------------
  const label = { ok: "[ok] ", warn: "[--] ", FAIL: "[!!] " };
  process.stdout.write("\n  downloadx doctor\n\n");
  for (const [kind, what, detail] of lines) {
    process.stdout.write("  " + (label[kind] || "") + " " + what.padEnd(16) + detail + "\n");
  }
  process.stdout.write("\n");
  if (problems === 0) {
    process.stdout.write("  everything needed to download is working.\n");
    if (!c) process.stdout.write("  start the daemon to queue downloads.\n");
  } else {
    process.stdout.write("  " + problems + " problem(s) found; the fixes are printed above.\n");
  }
  process.stdout.write("  no cookie, token or private URL is shown here.\n\n");
  return problems === 0 ? 0 : 1;
}

/**
 * Show, search or clear the URL history.
 *
 * Reads the file directly rather than going through the daemon, so it works
 * even when the daemon is not running.
 *
 * @param {string[]} rest
 * @returns {Promise<number>}
 */
async function cmdHistory(rest, opts) {
  const { UrlHistory } = await import("./history.mjs");
  const history = new UrlHistory();
  await history.load();

  const sub = (rest[0] || "list").toLowerCase();

  if (sub === "clear") {
    // Explicit and never automatic: this deletes something the user built up.
    const removed = await history.clear();
    process.stdout.write("  cleared " + removed + " history entr" + (removed === 1 ? "y" : "ies") + "\n");
    return 0;
  }

  if (sub === "add") {
    const url = rest[1];
    if (!url) { process.stderr.write("usage: downloadx history add <url>\n"); return 2; }
    const entry = history.record(url, { source: "cli" });
    await history.flush();
    process.stdout.write("  recorded " + entry.url + "\n");
    return 0;
  }

  if (sub !== "list" && sub !== "ls") {
    process.stderr.write("usage: downloadx history [list [query] | add <url> | clear]\n");
    return 2;
  }

  const limit = opts.limit || 30;
  const entries = history.list({ q: rest.slice(1).join(" "), limit });
  if (!entries.length) {
    process.stdout.write(history.size
      ? "  (no history entry matches that)\n"
      : "  (no history yet; URLs are recorded as they are queued)\n");
    return 0;
  }
  const pad = (v, n) => String(v).padEnd(n).slice(0, n);
  process.stdout.write("  " + pad("WHEN", 17) + " " + pad("SIZE", 11) + " " + pad("NAME", 26) + "URL\n");
  for (const e of entries) {
    const when = new Date(e.at).toISOString().replace("T", " ").slice(0, 16);
    process.stdout.write("  " + pad(when, 17) + " " + pad(e.size ? formatBytes(e.size) : "-", 11) + " " +
      pad(e.filename || "-", 26) + e.url + "\n");
  }
  process.stdout.write("\n  " + entries.length + " of " + history.size + " entr" +
    (history.size === 1 ? "y" : "ies") + " shown\n");
  return 0;
}

async function cmdOpen() {
  const c = await client();
  if (!c) { process.stderr.write("  daemon not running; start it with: downloadx daemon\n"); return 1; }
  process.stdout.write("  " + c.rt.url + "\n");
  const { spawn } = await import("node:child_process");
  const opener = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", c.rt.url] : [c.rt.url];
  try { spawn(opener, args, { detached: true, stdio: "ignore" }).unref(); } catch { /* printed anyway */ }
  return 0;
}

async function cmdDaemon(opts) {
  await ensureDirs();
  const { Daemon } = await import("./daemon.mjs");
  try {
    const daemon = await new Daemon({ port: opts.port || 0 }).init();
    const runtime = await daemon.start();
    process.stdout.write(
      "\n  downloadx daemon\n" +
      "  gui:   " + runtime.url + "\n" +
      "  token: " + runtime.token + "\n" +
      "  pid:   " + runtime.pid + "\n\n" +
      "  Ctrl-C to stop.\n\n"
    );
    await daemon.runForever();
  } catch (err) {
    // The data-root lock is the normal way a second daemon stands down (the
    // MCP server and the desktop app race the same root); that is success,
    // not a failure, so the spawner must see exit 0 and reuse the peer.
    if (err && err.code === "DAEMON_PEER_OWNER") {
      process.stdout.write("\n  downloadx: " + err.message + "\n  nothing to do; the running daemon keeps serving.\n\n");
      return 0;
    }
    throw err;
  }
  return 0;
}

async function cmdTest() {
  const { runSelfTest } = await import("../test/selftest.mjs");
  return runSelfTest();
}

export async function main(argv) {
  const args = argv || process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    process.stderr.write("error: " + err.message + "\n\n" + USAGE);
    return 2;
  }
  const opts = parsed.opts;
  const positional = parsed.positional;

  if (opts.version) { process.stdout.write(VERSION + "\n"); return 0; }
  if (opts.help || positional.length === 0) { process.stdout.write(USAGE); return opts.help ? 0 : 2; }

  const command = positional[0];
  const rest = positional.slice(1);
  try {
    switch (command) {
      case "get":
      case "download":
        if (!rest.length) { process.stderr.write("error: get needs at least one URL\n"); return 2; }
        return await cmdGet(rest, opts);
      case "add":
        if (!rest.length) { process.stderr.write("error: add needs at least one URL\n"); return 2; }
        return await cmdAdd(rest, opts);
      case "list":
      case "ls":
        return await cmdList(opts);
      case "task":
        return await cmdTask(rest[0], opts);
      case "status":
        return await cmdStatus(opts);
      case "pause":
      case "resume":
        return await cmdControl(command, rest[0]);
      case "remove":
      case "rm":
        if (!rest.length) { process.stderr.write("error: remove needs a task id\n"); return 2; }
        return await cmdRemove(rest[0], opts);
      case "grab":
        return await cmdGrab(rest, opts);
      case "sniff":
        return await cmdSniff(rest, opts);
      case "stop":
        return await cmdStop();
      case "proxy":
        return await cmdProxy(rest, opts);
      case "open":
        return await cmdOpen();
      case "history":
      case "hist":
        return await cmdHistory(rest, opts);
      case "doctor":
      case "diag":
        return await cmdDoctor();
      case "daemon":
      case "serve":
        return await cmdDaemon(opts);
      case "config":
        return await cmdConfig(rest);
      case "schedule":
      case "schedules":
        return await cmdSchedule(rest);
      case "test":
      case "selftest":
        return await cmdTest();
      case "version":
        process.stdout.write(VERSION + "\n");
        return 0;
      case "help":
        process.stdout.write(USAGE);
        return 0;
      default:
        process.stderr.write('error: unknown command "' + command + '"\n\n' + USAGE);
        return 2;
    }
  } catch (err) {
    process.stderr.write("\nerror: " + ((err && err.message) || err) + "\n");
    if (process.env.DOWNLOADX_DEBUG) process.stderr.write(String(err && err.stack) + "\n");
    return 1;
  }
}
