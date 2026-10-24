// Segment planning.
//
// Two rules matter more than they look:
//   * tiny files must not be split — connection setup costs more than it saves;
//   * segment count is bounded by both the requested concurrency and the file
//     size, so we never create 1-byte segments.

import { clamp } from "./util.mjs";

export const MIN_SEGMENT_BYTES = 1024 * 1024;      // do not split below 1 MiB
export const DEFAULT_SEGMENT_BYTES = 8 * 1024 * 1024; // 8 MiB target segment
export const MAX_CONNECTIONS = 32;

/**
 * @typedef {{ index:number, start:number, end:number }} Segment
 * end is inclusive (matching HTTP Range semantics).
 */

/**
 * Split `totalBytes` into inclusive ranges.
 * @param {number} totalBytes
 * @param {{ connections?:number, segmentBytes?:number }} [opts]
 * @returns {Segment[]}
 */
export function planSegments(totalBytes, opts = {}) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    throw new Error("planSegments needs a positive total size");
  }
  const connections = clamp(Math.floor(opts.connections ?? 8), 1, MAX_CONNECTIONS);
  const segmentBytes = Math.max(MIN_SEGMENT_BYTES, opts.segmentBytes ?? DEFAULT_SEGMENT_BYTES);

  if (totalBytes <= MIN_SEGMENT_BYTES || connections === 1) {
    return [{ index: 0, start: 0, end: totalBytes - 1 }];
  }

  const bySize = Math.ceil(totalBytes / segmentBytes);
  const count = clamp(Math.min(connections, bySize), 1, MAX_CONNECTIONS);
  const per = Math.ceil(totalBytes / count);

  const segments = [];
  for (let i = 0; i < count; i++) {
    const start = i * per;
    if (start >= totalBytes) break;
    const end = Math.min(start + per - 1, totalBytes - 1);
    segments.push({ index: segments.length, start, end });
  }
  return segments;
}

/** Does this plan cover [0, totalBytes-1] exactly once, in order? */
export function validatePlan(segments, totalBytes) {
  let cursor = 0;
  for (const s of segments) {
    if (s.start !== cursor) return false;
    if (s.end < s.start) return false;
    cursor = s.end + 1;
  }
  return cursor === totalBytes;
}

/**
 * Re-split one segment into `parts` pieces (used by the adaptive controller
 * when a transfer is slower than the connection count suggests it should be).
 * @returns {Segment[]}
 */
export function splitSegment(segment, parts) {
  const size = segment.end - segment.start + 1;
  const n = clamp(Math.floor(parts), 1, MAX_CONNECTIONS);
  if (n <= 1 || size < MIN_SEGMENT_BYTES * 2) return [segment];
  const per = Math.ceil(size / n);
  const out = [];
  for (let start = segment.start; start <= segment.end; start += per) {
    out.push({ index: 0, start, end: Math.min(start + per - 1, segment.end) });
  }
  return out.map((s, i) => ({ ...s, index: i }));
}
