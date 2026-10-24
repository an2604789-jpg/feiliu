// Site grabber: collect the downloadable resources a page references.
//
// Two independent passes:
//   1. HTML attributes (a[href], img[src], video/audio/source, link[href]);
//   2. media URLs embedded in inline scripts or JSON blobs, which is where
//      players usually hide the real stream address.
//
// This is a link collector, not a crawler: it reads one page and never
// executes page script.

import { requestFollow, readBody } from "./net.mjs";
import { categorize } from "./categories.mjs";
import { sanitizeName } from "./util.mjs";

/** tag/attribute pairs worth scanning, and whether they name a resource. */
const ATTRS = [
  { tag: "a", attr: "href", resource: false },
  { tag: "link", attr: "href", resource: true },
  { tag: "img", attr: "src", resource: true },
  { tag: "script", attr: "src", resource: true },
  { tag: "source", attr: "src", resource: true },
  { tag: "video", attr: "src", resource: true },
  { tag: "video", attr: "poster", resource: true },
  { tag: "audio", attr: "src", resource: true },
  { tag: "embed", attr: "src", resource: true },
  { tag: "object", attr: "data", resource: true },
  { tag: "track", attr: "src", resource: true },
];

/** Media/stream extensions worth surfacing even without a matching tag. */
export const MEDIA_EXT = new Set([
  "m3u8", "mpd", "mp4", "m4v", "mkv", "webm", "flv", "mov", "avi", "wmv", "ts",
  "mp3", "m4a", "aac", "flac", "ogg", "opus", "wav", "wma",
]);

/** Build the attribute regex without a layer of escaping that could mangle it. */
function attrRegex(tag, attr) {
  return new RegExp(
    "<" + tag + "\\b[^>]*?\\b" + attr + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
    "gi"
  );
}

/** Pull every attribute we care about out of an HTML document. */
export function extractLinks(html, baseUrl) {
  const found = new Map();
  const abs = (u) => {
    try { return new URL(u, baseUrl).toString(); } catch { return null; }
  };

  for (const entry of ATTRS) {
    const re = attrRegex(entry.tag, entry.attr);
    let m;
    while ((m = re.exec(html))) {
      const raw = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
      if (!raw || raw.startsWith("#") || /^(javascript|mailto|data|blob):/i.test(raw)) continue;
      const url = abs(raw);
      if (!url || !/^https?:/i.test(url)) continue;
      if (!found.has(url)) found.set(url, { url, tag: entry.tag, resource: entry.resource });
    }
  }

  // Media URLs inside inline script or JSON. Players usually store a path
  // here rather than a full URL, so both absolute and root-relative forms are
  // collected.
  const absRe = /https?:\/\/[^\s"'<>\)]+?\.(m3u8|mpd|mp4|m4v|mkv|webm|flv|mp3|m4a|aac|ts)(\?[^\s"'<>\)]*)?/gi;
  let u;
  while ((u = absRe.exec(html))) {
    const url = abs(u[0]);
    if (url && !found.has(url)) found.set(url, { url, tag: "script", resource: true, embedded: true });
  }
  const relRe = /["']([^"'\s]+\.(m3u8|mpd|mp4|m4v|mkv|webm|flv|mp3|m4a|aac|ts)(\?[^"'\s]*)?)["']/gi;
  while ((u = relRe.exec(html))) {
    const url = abs(u[1]);
    if (url && !found.has(url)) found.set(url, { url, tag: "script", resource: true, embedded: true });
  }

  return [...found.values()].map((r) => {
    const base = (r.url.split("/").pop() || "").split("?")[0];
    return {
      ...r,
      filename: sanitizeName(base, "resource"),
      category: categorize(r.url),
    };
  });
}

/**
 * Fetch a page and list what could be downloaded from it.
 * A non-HTML response is treated as the resource itself.
 */
export async function grabPage(pageUrl, opts = {}) {
  const res = await requestFollow(pageUrl, {
    headers: opts.headers, proxy: opts.proxy, insecure: opts.insecure,
    signal: opts.signal, timeoutMs: opts.timeoutMs || 30000,
  });
  const contentType = res.headers["content-type"] || "";
  const finalUrl = res.finalUrl || pageUrl;
  const body = await readBody(res, opts.maxBytes || 16 * 1024 * 1024);

  if (!/html|xml|json/i.test(contentType)) {
    const base = (finalUrl.split("/").pop() || "download").split("?")[0];
    return {
      pageUrl, finalUrl, contentType, isDocument: false,
      links: [{
        url: finalUrl, tag: "direct", resource: true,
        filename: sanitizeName(base, "download"),
        category: categorize(finalUrl),
      }],
    };
  }

  const html = body.toString("utf8");
  let links = extractLinks(html, finalUrl);
  if (opts.includeResources === false) links = links.filter((l) => l.tag === "a");
  if (opts.mediaOnly) {
    links = links.filter((l) => MEDIA_EXT.has((l.filename.split(".").pop() || "").toLowerCase()));
  }
  if (Array.isArray(opts.extensions) && opts.extensions.length) {
    const want = new Set(opts.extensions.map((e) => String(e).toLowerCase().replace(/^\./, "")));
    links = links.filter((l) => want.has((l.filename.split(".").pop() || "").toLowerCase()));
  }

  const seen = new Set([finalUrl]);
  links = links.filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true)));

  return { pageUrl, finalUrl, contentType, isDocument: true, links, htmlBytes: body.length };
}

/** Queue every link the page offered. */
export async function grabAndQueue(pageUrl, queue, opts = {}) {
  const result = await grabPage(pageUrl, opts);
  const out = [];
  for (const link of result.links) {
    try {
      const task = queue.add({
        url: link.url,
        filename: link.filename,
        dir: opts.dir,
        referer: result.finalUrl,
        headers: opts.headers,
        queueId: opts.queueId || "grabber",
        meta: { grabbedFrom: result.finalUrl },
      });
      out.push({ url: link.url, task });
    } catch (err) {
      out.push({ url: link.url, error: err.message });
    }
  }
  return { page: { finalUrl: result.finalUrl, total: result.links.length }, queued: out };
}
