// Media sniffer (server side).
//
// The extension observes traffic inside the browser; this module does the same
// job from the daemon: given a page URL, find the stream a player would use,
// classify it, and report enough metadata for a sensible download plan.
//
// Page script is never executed; manifests are fetched only to count segments,
// which is what a user needs in order to judge a download before starting it.

import { requestFollow, readBody } from "./net.mjs";
import { parseM3u8, rankVariants } from "./hls.mjs";
import { parseMpd, pickBestRepresentation } from "./dash.mjs";

const HLS_RE = /\.m3u8(\?|$)/i;
const DASH_RE = /\.mpd(\?|$)/i;
const MEDIA_RE = /\.(mp4|m4v|mkv|webm|flv|mov|avi|ts|mp3|m4a|aac|flac|ogg|opus|wav)(\?|$)/i;

/** Classify a URL by the kind of transfer it needs, or null. */
export function classify(url) {
  if (HLS_RE.test(url)) return "hls";
  if (DASH_RE.test(url)) return "dash";
  if (MEDIA_RE.test(url)) return "http";
  return null;
}

/** Inspect one stream URL: variants, segment count, duration, live flag. */
export async function inspectStream(url, opts = {}) {
  const kind = classify(url);
  if (!kind) return { url, kind: null, error: "not a recognised media URL" };
  const common = {
    headers: opts.headers, proxy: opts.proxy, insecure: opts.insecure,
    signal: opts.signal, timeoutMs: opts.timeoutMs || 30000,
  };

  if (kind === "hls") {
    const res = await requestFollow(url, common);
    const parsed = parseM3u8((await readBody(res)).toString("utf8"), res.finalUrl || url);
    if (parsed.isMaster) {
      const variants = rankVariants(parsed.variants);
      return { url, kind, master: true, variants, best: variants[0] || null, segmentCount: null, live: false };
    }
    return {
      url, kind, master: false, variants: [],
      segmentCount: parsed.segments.length,
      durationSec: parsed.duration,
      encrypted: parsed.segments.some((s) => s.key && s.key.method && s.key.method !== "NONE"),
      hasInitSegment: Boolean(parsed.mapUri),
      live: !parsed.endList,
    };
  }

  if (kind === "dash") {
    const res = await requestFollow(url, common);
    const mpd = parseMpd((await readBody(res)).toString("utf8"), url);
    const best = pickBestRepresentation(mpd);
    return {
      url, kind, master: mpd.type === "dynamic",
      representations: (mpd.representations || []).map((r) => ({
        id: r.id, bandwidth: r.bandwidth, width: r.width, height: r.height, mimeType: r.mimeType,
      })),
      best: best
        ? { id: best.id, bandwidth: best.bandwidth, resolution: best.width ? best.width + "x" + best.height : null }
        : null,
      durationSec: mpd.mediaPresentationDuration,
      live: mpd.type === "dynamic",
    };
  }

  const { probe } = await import("./probe.mjs");
  const info = await probe(url, common);
  return {
    url, kind, totalBytes: info.totalBytes,
    contentType: info.contentType, supportsRanges: info.supportsRanges,
  };
}

/**
 * Find stream candidates on a page by scanning its HTML and inline script.
 * Master playlists are ranked first because they are what a user should pick.
 */
export async function sniffPage(pageUrl, opts = {}) {
  const res = await requestFollow(pageUrl, {
    headers: opts.headers, proxy: opts.proxy, insecure: opts.insecure,
    signal: opts.signal, timeoutMs: opts.timeoutMs || 30000,
  });
  const contentType = res.headers["content-type"] || "";
  const finalUrl = res.finalUrl || pageUrl;
  const body = await readBody(res, opts.maxBytes || 16 * 1024 * 1024);

  if (!/html|xml|json/i.test(contentType)) {
    const kind = classify(finalUrl);
    return { pageUrl, finalUrl, candidates: kind ? [{ url: finalUrl, kind }] : [] };
  }

  const html = body.toString("utf8");
  const found = new Map();

  const absRe = /https?:\/\/[^\s"'<>\)]+?\.(m3u8|mpd|mp4|m4v|mkv|webm|flv|mov|mp3|m4a|aac)(\?[^\s"'<>\)]*)?/gi;
  let m;
  while ((m = absRe.exec(html))) {
    let url = m[0];
    try { url = new URL(url, finalUrl).toString(); } catch { continue; }
    const kind = classify(url);
    if (!kind) continue;
    if (!found.has(url)) {
      found.set(url, { url, kind, isMasterGuess: HLS_RE.test(url) && /master|index/i.test(url) });
    }
  }

  // Relative playlist paths, which is how most players reference them.
  const relRe = /["']([^"'\s]+\.(m3u8|mpd)(\?[^"'\s]*)?)["']/gi;
  while ((m = relRe.exec(html))) {
    try {
      const url = new URL(m[1], finalUrl).toString();
      const kind = classify(url);
      if (kind && !found.has(url)) {
        found.set(url, { url, kind, isMasterGuess: /master|index/i.test(url) });
      }
    } catch { /* skip unusable candidates */ }
  }

  const candidates = [...found.values()].sort((a, b) => Number(b.isMasterGuess) - Number(a.isMasterGuess));
  return { pageUrl, finalUrl, candidates };
}
