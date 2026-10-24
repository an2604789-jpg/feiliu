// HLS (m3u8) playback-list parsing and variant selection.

import { requestFollow, readBody } from "./net.mjs";

/**
 * Parse an m3u8 document.
 *
 * Handles master playlists (variants) and media playlists (segments),
 * plus EXT-X-KEY (AES-128 / SAMPLE-AES) and EXT-X-MAP init segments.
 * @returns {{
 *   isMaster:boolean, isMedia:boolean, variants:Array, segments:Array,
 *   mapUri:string|null, mediaSequence:number, targetDuration:number|null,
 *   endList:boolean, duration:number, version:number|null
 * }}
 */
export function parseM3u8(text, baseUrl = "") {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const abs = (uri) => {
    if (!baseUrl) return uri;
    try { return new URL(uri, baseUrl).toString(); } catch { return uri; }
  };

  const variants = [];
  const segments = [];
  let mediaSequence = 0;
  let targetDuration = null;
  let mapUri = null;
  let endList = false;
  let version = null;
  let totalDuration = 0;

  let pendingStreamInf = null;
  let pendingDuration = null;
  let pendingTitle = "";
  let pendingKey = null;

  for (const line of lines) {
    if (!line.startsWith("#")) {
      // A bare URI: either a variant (after STREAM-INF) or a media segment.
      if (pendingStreamInf) {
        variants.push({ ...pendingStreamInf, uri: abs(line) });
        pendingStreamInf = null;
      } else if (pendingDuration !== null) {
        segments.push({ uri: abs(line), duration: pendingDuration, title: pendingTitle, key: pendingKey });
        totalDuration += pendingDuration;
        pendingDuration = null;
        pendingTitle = "";
      }
      continue;
    }

    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pendingStreamInf = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = Number(line.split(":")[1]) || 0;
    } else if (line.startsWith("#EXT-X-VERSION:")) {
      version = Number(line.split(":")[1]) || null;
    } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = Number(line.split(":")[1]) || null;
    } else if (line.startsWith("#EXT-X-ENDLIST")) {
      endList = true;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-MAP:".length));
      if (attrs.URI) mapUri = abs(attrs.URI);
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-KEY:".length));
      pendingKey = attrs.METHOD && attrs.METHOD !== "NONE"
        ? { method: attrs.METHOD, uri: attrs.URI ? abs(attrs.URI) : null, iv: attrs.IV ?? null, keyFormat: attrs.KEYFORMAT ?? null }
        : null;
    } else if (line.startsWith("#EXTINF:")) {
      const info = parseExtinf(line);
      pendingDuration = info.duration;
      pendingTitle = info.title;
    }
  }

  const isMaster = variants.length > 0 && segments.length === 0;
  const isMedia = segments.length > 0;
  return {
    isMaster, isMedia, variants, segments, mapUri, mediaSequence,
    targetDuration, endList, duration: totalDuration, version,
  };
}

function parseExtinf(line) {
  const body = line.slice("#EXTINF:".length);
  const comma = body.indexOf(",");
  const duration = Number.parseFloat(body.slice(0, comma < 0 ? body.length : comma)) || 0;
  const title = comma >= 0 ? body.slice(comma + 1).trim() : "";
  return { duration, title };
}

/** Parse attribute lists like: BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2" */
export function parseAttributes(text) {
  const out = {};
  const re = /([A-Za-z0-9_-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(text))) {
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function resolutionPixels(res) {
  const m = /^(\d+)x(\d+)$/.exec(res ?? "");
  return m ? Number(m[1]) * Number(m[2]) : 0;
}

/** Best variant: highest resolution, then highest bandwidth. */
export function pickBestVariant(variants) {
  if (!variants.length) return null;
  return [...variants].sort((a, b) => {
    const ra = resolutionPixels(a.RESOLUTION), rb = resolutionPixels(b.RESOLUTION);
    if (ra !== rb) return rb - ra;
    return (Number(b.BANDWIDTH) || 0) - (Number(a.BANDWIDTH) || 0);
  })[0];
}

/** Variants sorted best-first, shaped for a GUI picker. */
export function rankVariants(variants) {
  return [...variants]
    .sort((a, b) => {
      const ra = resolutionPixels(a.RESOLUTION), rb = resolutionPixels(b.RESOLUTION);
      if (ra !== rb) return rb - ra;
      return (Number(b.BANDWIDTH) || 0) - (Number(a.BANDWIDTH) || 0);
    })
    .map((v, i) => ({
      index: i,
      bandwidth: Number(v.BANDWIDTH) || null,
      resolution: v.RESOLUTION ?? null,
      codecs: v.CODECS ?? null,
      name: v.NAME ?? null,
      uri: v.uri,
    }));
}

/** Fetch and parse a playlist, following a master playlist to a media one. */
export async function resolvePlaylist(url, opts = {}) {
  const common = {
    headers: opts.headers, proxy: opts.proxy, insecure: opts.insecure,
    signal: opts.signal, timeoutMs: opts.timeoutMs ?? 30_000,
  };
  const res = await requestFollow(url, common);
  const parsed = parseM3u8((await readBody(res)).toString("utf8"), res.finalUrl);

  if (parsed.isMaster) {
    const chosen = opts.variantIndex !== undefined
      ? parsed.variants[opts.variantIndex]
      : pickBestVariant(parsed.variants);
    if (!chosen) throw new Error("master playlist has no usable variant");
    const child = await requestFollow(chosen.uri, common);
    const childParsed = parseM3u8((await readBody(child)).toString("utf8"), chosen.uri);
    return { playlist: childParsed, url: chosen.uri, variants: rankVariants(parsed.variants), chosen };
  }

  return { playlist: parsed, url: res.finalUrl, variants: [], chosen: null };
}
