// DASH (MPD) manifest parsing and segment-template expansion.

import { requestFollow, readBody } from "./net.mjs";

/** Minimal XML reader: enough for MPD without pulling in a parser dependency. */
function pickAll(xml, tag) {
  const out = [];
  const re = new RegExp(`<(?:(\\w+):)?${tag}\\b([^>]*?)(/?)>`, "g");
  let m;
  while ((m = re.exec(xml))) out.push({ attrs: parseAttrs(m[2]), selfClosing: m[3] === "/" });
  return out;
}

function parseAttrs(text) {
  const out = {};
  const re = /([A-Za-z0-9:_-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2];
  return out;
}

/** ISO-8601 duration (PT1H2M3.5S) to seconds. */
export function parseDuration(iso) {
  if (!iso) return null;
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map((x) => (x === undefined ? 0 : Number(x)));
  return y * 31_536_000 + mo * 2_592_000 + d * 86_400 + h * 3600 + mi * 60 + s;
}

/** Replace $Number$ and $RepresentationID$ style DASH templates. */
export function expandTemplate(template, { number = 0, representationId = "", bandwidth = 0, time = 0, tokens = {} } = {}) {
  return template.replace(/\$([A-Za-z]+)(?:%0(\d+)d)?\$/g, (_all, name, width) => {
    switch (name) {
      case "Number": return width ? String(number).padStart(Number(width), "0") : String(number);
      case "RepresentationID": return representationId;
      case "Bandwidth": return String(bandwidth);
      case "Time": return String(time);
      default: return tokens[name] ?? "";
    }
  });
}

export function parseMpd(xml, baseUrl = "") {
  const abs = (u) => (baseUrl ? new URL(u, baseUrl).toString() : u);
  const periods = [];
  const periodRe = /<Period\b([^>]*)>([\s\S]*?)<\/Period>/g;
  let pm;
  while ((pm = periodRe.exec(xml))) {
    const pAttrs = parseAttrs(pm[1]);
    const body = pm[2];
    const representations = [];

    const adaptRe = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g;
    let am;
    while ((am = adaptRe.exec(body))) {
      const aAttrs = parseAttrs(am[1]);
      const aBody = am[2];
      const repRe = /<Representation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Representation>)/g;
      let rm;
      while ((rm = repRe.exec(aBody))) {
        const rAttrs = parseAttrs(rm[1]);
        const rBody = rm[2] ?? "";
        const segBase = pickAll(aBody, "SegmentTemplate")[0]?.attrs ?? pickAll(rBody, "SegmentTemplate")[0]?.attrs ?? {};
        // A SegmentTimeline lists explicit segment times; ffmpeg emits one by
        // default, so a downloader that ignores it produces zero segments.
        const timelineBody = /<SegmentTimeline\b[^>]*>([\s\S]*?)<\/SegmentTimeline>/.exec(aBody)?.[1]
          ?? /<SegmentTimeline\b[^>]*>([\s\S]*?)<\/SegmentTimeline>/.exec(rBody)?.[1]
          ?? null;
        const timeline = timelineBody
          ? [...timelineBody.matchAll(/<S\b([^>]*?)\/?>/g)].map((mm) => parseAttrs(mm[1]))
          : null;
        const segList = pickAll(aBody, "SegmentList")[0]?.attrs ?? pickAll(rBody, "SegmentList")[0]?.attrs ?? {};
        representations.push({
          id: rAttrs.id ?? "",
          bandwidth: Number(rAttrs.bandwidth) || 0,
          width: Number(rAttrs.width) || null,
          height: Number(rAttrs.height) || null,
          mimeType: rAttrs.mimeType ?? aAttrs.mimeType ?? null,
          codecs: rAttrs.codecs ?? aAttrs.codecs ?? null,
          segmentTemplate: segBase,
          segmentList: segList,
          segmentTimeline: timeline,
          initialization: pickAll(rBody, "Initialization")[0]?.attrs?.sourceURL ?? segBase.initialization ?? null,
        });
      }
    }
    periods.push({ id: pAttrs.id ?? "", duration: parseDuration(pAttrs.duration), representations });
  }

  const mpdAttrs = parseAttrs(/<MPD\b([^>]*)>/.exec(xml)?.[1] ?? "");
  return {
    type: mpdAttrs.type ?? "static",
    mediaPresentationDuration: parseDuration(mpdAttrs.mediaPresentationDuration),
    baseUrl: abs(/<BaseURL>([^<]+)<\/BaseURL>/.exec(xml)?.[1] ?? ""),
    periods,
    representations: periods.flatMap((p) => p.representations),
    xml,
  };
  }

/** True when a representation carries audio (explicitly or by omission). */
export function isAudio(rep) {
  const mime = (rep.mimeType || "").toLowerCase();
  if (mime.startsWith("audio")) return true;
  if (mime.startsWith("video")) return false;
  // No mimeType: use the codec string, then fall back to "no video dimensions".
  const codecs = (rep.codecs || "").toLowerCase();
  if (/mp4a|opus|vorbis|ac-3|ec-3|flac/.test(codecs)) return true;
  if (/avc|hev|hvc|vp0?9|av01/.test(codecs)) return false;
  return !rep.height && !rep.width;
}

/** Pick the highest-bandwidth video representation. */
export function pickBestRepresentation(mpd) {
  const reps = mpd.representations || [];
  if (!reps.length) return null;
  const video = reps.filter((r) => !isAudio(r));
  const pool = video.length ? video : reps;
  return [...pool].sort((a, b) => b.bandwidth - a.bandwidth)[0];
}

/** Pick the highest-bandwidth audio representation, or null. */
export function pickBestAudioRepresentation(mpd) {
  const audio = (mpd.representations || []).filter(isAudio);
  if (!audio.length) return null;
  return [...audio].sort((a, b) => b.bandwidth - a.bandwidth)[0];
}

/** Group representations into the tracks a downloader should fetch. */
export function selectTracks(mpd, opts = {}) {
  const video = opts.videoId
    ? (mpd.representations || []).find((r) => r.id === opts.videoId)
    : pickBestRepresentation(mpd);
  const audio = opts.audioId
    ? (mpd.representations || []).find((r) => r.id === opts.audioId)
    : (opts.includeAudio === false ? null : pickBestAudioRepresentation(mpd));
  return { video: video || null, audio: audio || null };
}

/**
 * Enumerate segment URLs for one representation.
 * Supports SegmentTemplate with $Number$ and SegmentTimeline.
 */
export function listSegments(mpd, rep, { segmentCount = 0 } = {}) {
  const t = rep.segmentTemplate || {};
  if (!t.media) return [];

  const start = Number(t.startNumber || 1);
  const timescale = Number(t.timescale || 1);
  const urls = [];

  // A SegmentTimeline is authoritative: it states each segment's start time and
  // repeat count, so the segment numbering follows it directly.
  if (Array.isArray(rep.segmentTimeline) && rep.segmentTimeline.length) {
    let number = start;
    let time = 0;
    for (const entry of rep.segmentTimeline) {
      const t0 = entry.t !== undefined ? Number(entry.t) : time;
      const d = Number(entry.d || 0);
      const r = Number(entry.r || 0);
      if (d <= 0) continue;
      for (let i = 0; i <= r; i++) {
        urls.push(expandTemplate(t.media, {
          number,
          representationId: rep.id,
          bandwidth: rep.bandwidth,
          time: t0 + i * d,
        }));
        number++;
      }
      time = t0 + (r + 1) * d;
    }
    return segmentCount > 0 ? urls.slice(0, segmentCount) : urls;
  }

  // Otherwise derive the count from the declared duration.
  const dur = Number(t.duration || 0);
  const total = mpd.mediaPresentationDuration || 0;
  const count = segmentCount > 0
    ? segmentCount
    : (dur > 0 && total > 0 ? Math.ceil((total * timescale) / dur) : 0);
  for (let i = 0; i < count; i++) {
    urls.push(expandTemplate(t.media, {
      number: start + i,
      representationId: rep.id,
      bandwidth: rep.bandwidth,
      time: i * dur,
    }));
  }
  return urls;
}