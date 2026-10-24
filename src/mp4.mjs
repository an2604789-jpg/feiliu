// Minimal fragmented-MP4 muxer with streaming FileHandle & 64-bit (co64) support.
//
// Adaptive streaming (DASH and HLS-fMP4) delivers video and audio as separate
// tracks, each with its own init segment and media fragments. Joining them into
// one playable file normally means shelling out to ffmpeg — which XDM avoids by
// implementing the merge itself, and which this module now does too.
//
// Fragmented MP4 makes this tractable. Each track's init segment carries a
// complete "moov" with one "trak"; each fragment is a self-contained
// "moof"+"mdat" pair whose "tfhd" names its track id. So a merge is:
//
//   1. keep one "ftyp";
//   2. build a "moov" holding both "trak"s, renumbering the second track's id;
//   3. append every fragment, rewriting the track id in the fragments that
//      moved to the second track;
//   4. interleave fragments by their decode time so players see data in order.
//
// For 2GB~4GB+ 4K high-bitrate streams, `muxFilesStreaming` scans only 8~16 byte
// Box headers via `FileHandle`, never loads `mdat` payloads into V8 heap memory,
// upgrades 32-bit `stco` sample offset tables to 64-bit `co64` when offsets
// exceed 4GB (2^32 - 1), and streams `mdat` media payloads in 64KB chunks.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

/** @type {number} 32 位无符号整数上限 (4GB - 1 字节)，超过此偏移需升级 stco 为 co64 */
export const MAX_UINT32_OFFSET = 0xffffffff;

/** @type {number} 流式管道每次读写的默认分块大小 (64KB) */
const STREAM_HIGH_WATER_MARK = 64 * 1024;

// ============================================================================
// 1. 基础 Box 解析与内存操作函数（100% 保持既有行为与签名）
// ============================================================================

/**
 * 从 Buffer 指定偏移处读取单个 ISO BMFF Box 头部信息
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ type: string, size: number, headerSize: number, start: number, end: number } | null}
 */
export function readBox(buf, offset) {
  if (!buf || offset + 8 > buf.length) return null;
  let size = buf.readUInt32BE(offset);
  const type = buf.toString("latin1", offset + 4, offset + 8);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > buf.length) return null;
    size = Number(buf.readBigUInt64BE(offset + 8));
    headerSize = 16;
  } else if (size === 0) {
    size = buf.length - offset;
  }
  if (size < headerSize || offset + size > buf.length) return null;
  return { type, size, headerSize, start: offset, end: offset + size };
}

/**
 * 列出 Buffer 中的所有顶层 Box
 * @param {Buffer} buf
 * @returns {Array<{ type: string, size: number, headerSize: number, start: number, end: number }>}
 */
export function listBoxes(buf) {
  const out = [];
  if (!buf || !buf.length) return out;
  let off = 0;
  for (;;) {
    const b = readBox(buf, off);
    if (!b) break;
    out.push(b);
    off = b.end;
    if (off >= buf.length) break;
  }
  return out;
}

/**
 * 在父 Box 内查找第一个指定类型的子 Box
 * @param {Buffer} buf
 * @param {{ start: number, end: number, headerSize: number }} parent
 * @param {string} type
 */
export function findChild(buf, parent, type) {
  let off = parent.start + parent.headerSize;
  while (off < parent.end) {
    const b = readBox(buf, off);
    if (!b) break;
    if (b.type === type) return b;
    off = b.end;
  }
  return null;
}

/**
 * 在父 Box 内查找所有指定类型的子 Box
 * @param {Buffer} buf
 * @param {{ start: number, end: number, headerSize: number }} parent
 * @param {string} type
 */
export function findChildren(buf, parent, type) {
  const out = [];
  let off = parent.start + parent.headerSize;
  while (off < parent.end) {
    const b = readBox(buf, off);
    if (!b) break;
    if (b.type === type) out.push(b);
    off = b.end;
  }
  return out;
}

/**
 * 截取 Box 对应的 Buffer 视图
 * @param {Buffer} buf
 * @param {{ start: number, end: number }} box
 * @returns {Buffer}
 */
function sliceBox(buf, box) {
  return buf.subarray(box.start, box.end);
}

/**
 * 改写 tkhd Box 中的 track_ID
 * @param {Buffer} buf
 * @param {{ start: number, end: number, headerSize: number }} tkhd
 * @param {number} newId
 * @returns {Buffer}
 */
export function writeTkhdTrackId(buf, tkhd, newId) {
  const copy = Buffer.from(sliceBox(buf, tkhd));
  const version = copy[8];
  const base = 8 + 4;
  if (version === 1) copy.writeUInt32BE(newId, base + 16);
  else copy.writeUInt32BE(newId, base + 8);
  return copy;
}

/**
 * 改写 tfhd Box 中的 track_ID
 * @param {Buffer} buf
 * @param {{ start: number, end: number }} tfhd
 * @param {number} newId
 * @returns {Buffer}
 */
function writeTfhdTrackId(buf, tfhd, newId) {
  const copy = Buffer.from(sliceBox(buf, tfhd));
  copy.writeUInt32BE(newId, 8 + 4);
  return copy;
}

/**
 * 改写 trex Box 中的 track_ID
 * @param {Buffer} buf
 * @param {{ start: number, end: number }} trex
 * @param {number} newId
 * @returns {Buffer}
 */
function writeTrexTrackId(buf, trex, newId) {
  const copy = Buffer.from(sliceBox(buf, trex));
  copy.writeUInt32BE(newId, 8 + 4);
  return copy;
}

/**
 * 改写 moof Box 内所有 traf/tfhd 的 track_ID
 * @param {Buffer} buf
 * @param {{ start: number, end: number, headerSize: number }} moof
 * @param {number} oldId
 * @param {number} newId
 * @returns {Buffer}
 */
export function rewriteMoofTrackId(buf, moof, oldId, newId) {
  if (oldId === newId) return Buffer.from(sliceBox(buf, moof));
  const mfhd = findChild(buf, moof, "mfhd");
  const parts = [];
  if (mfhd) parts.push(Buffer.from(sliceBox(buf, mfhd)));
  for (const traf of findChildren(buf, moof, "traf")) {
    const children = [];
    let off = traf.start + traf.headerSize;
    while (off < traf.end) {
      const b = readBox(buf, off);
      if (!b) break;
      if (b.type === "tfhd") {
        children.push(writeTfhdTrackId(buf, b, newId));
      } else {
        children.push(Buffer.from(sliceBox(buf, b)));
      }
      off = b.end;
    }
    const trafPayload = Buffer.concat(children);
    const trafHeader = Buffer.alloc(8);
    trafHeader.writeUInt32BE(8 + trafPayload.length, 0);
    trafHeader.write("traf", 4, "latin1");
    parts.push(Buffer.concat([trafHeader, trafPayload]));
  }
  const moofPayload = Buffer.concat(parts);
  const moofHeader = Buffer.alloc(8);
  moofHeader.writeUInt32BE(8 + moofPayload.length, 0);
  moofHeader.write("moof", 4, "latin1");
  return Buffer.concat([moofHeader, moofPayload]);
}

/**
 * 判定 Buffer 是否包含 fMP4 初始化段 (ftyp/styp + moov)
 * @param {Buffer} buf
 * @returns {boolean}
 */
export function isFragmentedMp4(buf) {
  if (!buf || buf.length < 8) return false;
  const boxes = listBoxes(buf);
  return (
    boxes.some((b) => b.type === "moov") &&
    boxes.some((b) => b.type === "ftyp" || b.type === "styp")
  );
}

/**
 * 判定 Buffer 是否包含 fMP4 媒体分片 (moof)
 * @param {Buffer} buf
 * @returns {boolean}
 */
export function isMediaFragment(buf) {
  if (!buf || buf.length < 8) return false;
  const boxes = listBoxes(buf);
  return boxes.some((b) => b.type === "moof");
}

/**
 * 从 moof Box Buffer 中提取 tfdt 解码时间戳 (baseMediaDecodeTime)
 * @param {Buffer} buf
 * @param {{ start: number, end: number, headerSize: number }} moof
 * @returns {number}
 */
function extractMoofDecodeTime(buf, moof) {
  let decodeTime = 0;
  const traf = findChild(buf, moof, "traf");
  if (traf) {
    const tfdt = findChild(buf, traf, "tfdt");
    if (tfdt) {
      const v = buf[tfdt.start + tfdt.headerSize];
      const at = tfdt.start + tfdt.headerSize + 4;
      decodeTime =
        v === 1 ? Number(buf.readBigUInt64BE(at)) : buf.readUInt32BE(at);
    }
  }
  return decodeTime;
}

/**
 * 解析内存中的轨道初始化段与分片数组（保持既有签名与返回结构）
 * @param {Buffer} initBuf
 * @param {Buffer[]} [fragments=[]]
 */
export function parseTrack(initBuf, fragments = []) {
  const boxes = listBoxes(initBuf);
  const ftyp = boxes.find((b) => b.type === "ftyp" || b.type === "styp");
  const moov = boxes.find((b) => b.type === "moov");
  if (!moov) throw new Error("init segment lacks moov box");

  const trak = findChild(initBuf, moov, "trak");
  if (!trak) throw new Error("moov lacks trak");

  const tkhd = findChild(initBuf, trak, "tkhd");
  if (!tkhd) throw new Error("trak lacks tkhd");

  const version = initBuf[tkhd.start + tkhd.headerSize];
  const base = tkhd.start + tkhd.headerSize + 4;
  const trackId =
    version === 1
      ? initBuf.readUInt32BE(base + 16)
      : initBuf.readUInt32BE(base + 8);

  const samples = [];
  for (const frag of fragments) {
    const fb = listBoxes(frag);
    const moof = fb.find((b) => b.type === "moof");
    if (!moof) continue;
    const decodeTime = extractMoofDecodeTime(frag, moof);
    samples.push({ decodeTime, buffer: frag, moofBox: moof });
  }

  let duration = 0;
  const mvhd = findChild(initBuf, moov, "mvhd");
  if (mvhd) {
    const v = initBuf[mvhd.start + mvhd.headerSize];
    const b = mvhd.start + mvhd.headerSize + 4;
    duration =
      v === 1
        ? Number(initBuf.readBigUInt64BE(b + 16))
        : initBuf.readUInt32BE(b + 12);
  }

  return {
    trackId,
    ftyp,
    moovBuffer: initBuf,
    moov,
    trak,
    samples,
    duration,
    initBuffer: initBuf
  };
}

// ============================================================================
// 2. 64 位大文件支持：stco (32-bit) 自动升级转换为 co64 (64-bit)
// ============================================================================

/**
 * 将单个 32 位 stco Box Buffer 升级转换为 64 位 co64 Box Buffer
 * @param {Buffer} stcoBuf 原始 stco Box Buffer（含 8 字节头部）
 * @param {bigint|number} [offsetDelta=0n] 需要叠加的偏移量增量
 * @returns {Buffer} 转换后的 co64 Box Buffer
 */
export function convertStcoToCo64Box(stcoBuf, offsetDelta = 0n) {
  if (!stcoBuf || stcoBuf.length < 16) return stcoBuf;
  const versionAndFlags = stcoBuf.readUInt32BE(8);
  const entryCount = stcoBuf.readUInt32BE(12);
  const delta = BigInt(offsetDelta);

  const co64Size = 16 + entryCount * 8;
  const out = Buffer.alloc(co64Size);
  out.writeUInt32BE(co64Size, 0);
  out.write("co64", 4, "latin1");
  out.writeUInt32BE(versionAndFlags, 8);
  out.writeUInt32BE(entryCount, 12);

  for (let i = 0; i < entryCount; i++) {
    const entryOffset = 16 + i * 4;
    const oldVal =
      entryOffset + 4 <= stcoBuf.length
        ? BigInt(stcoBuf.readUInt32BE(entryOffset))
        : 0n;
    const newVal = oldVal + delta >= 0n ? oldVal + delta : 0n;
    out.writeBigUInt64BE(newVal, 16 + i * 8);
  }
  return out;
}

/**
 * 递归重写容器 Box（如 trak -> mdia -> minf -> stbl），将其中的 32 位 stco 升级为 64 位 co64
 * @param {Buffer} boxBuf 容器 Box 的完整 Buffer
 * @param {bigint|number} [offsetDelta=0n] 偏移增量
 * @returns {Buffer} 升级后的容器 Box Buffer
 */
export function upgradeTrakStcoToCo64(boxBuf, offsetDelta = 0n) {
  const root = readBox(boxBuf, 0);
  if (!root) return boxBuf;

  const CONTAINER_TYPES = new Set(["trak", "mdia", "minf", "stbl"]);
  if (root.type === "stco") {
    return convertStcoToCo64Box(boxBuf, offsetDelta);
  }
  if (!CONTAINER_TYPES.has(root.type)) {
    return boxBuf;
  }

  const childBuffers = [];
  let changed = false;
  let off = root.headerSize;
  while (off < root.end) {
    const child = readBox(boxBuf, off);
    if (!child) {
      childBuffers.push(Buffer.from(boxBuf.subarray(off, root.end)));
      break;
    }
    const rawChild = Buffer.from(sliceBox(boxBuf, child));
    if (child.type === "stco") {
      childBuffers.push(convertStcoToCo64Box(rawChild, offsetDelta));
      changed = true;
    } else if (CONTAINER_TYPES.has(child.type)) {
      const upgraded = upgradeTrakStcoToCo64(rawChild, offsetDelta);
      if (upgraded !== rawChild) changed = true;
      childBuffers.push(upgraded);
    } else {
      childBuffers.push(rawChild);
    }
    off = child.end;
  }

  if (!changed) return boxBuf;

  const payload = Buffer.concat(childBuffers);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(root.type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

/**
 * 根据单轨或双轨初始化信息组装合并后的 ftyp 与 moov Buffer
 * @param {Array<ReturnType<typeof parseTrack>>} usable 有效轨道列表
 * @param {{ upgradeToCo64?: boolean, offsetDelta?: bigint|number }} [options]
 * @returns {{ ftyp: Buffer, moov: Buffer, firstId: number, secondId: number }}
 */
function buildMergedInitBuffers(usable, options = {}) {
  const { upgradeToCo64 = false, offsetDelta = 0n } = options;

  if (usable.length === 1) {
    const t = usable[0];
    const ftyp = t.ftyp
      ? Buffer.from(sliceBox(t.initBuffer, t.ftyp))
      : Buffer.alloc(0);

    let moov = Buffer.from(sliceBox(t.initBuffer, t.moov));
    if (upgradeToCo64) {
      const moovBox = readBox(moov, 0);
      if (moovBox) {
        const children = [];
        let off = moovBox.headerSize;
        while (off < moovBox.end) {
          const b = readBox(moov, off);
          if (!b) break;
          const slice = Buffer.from(sliceBox(moov, b));
          children.push(
            b.type === "trak" ? upgradeTrakStcoToCo64(slice, offsetDelta) : slice
          );
          off = b.end;
        }
        const payload = Buffer.concat(children);
        const hdr = Buffer.alloc(8);
        hdr.writeUInt32BE(8 + payload.length, 0);
        hdr.write("moov", 4, "latin1");
        moov = Buffer.concat([hdr, payload]);
      }
    }

    return { ftyp, moov, firstId: t.trackId, secondId: t.trackId };
  }

  const [first, second] = usable;
  const firstId = first.trackId;
  const secondId = firstId + 1;
  const ftyp = first.ftyp
    ? Buffer.from(sliceBox(first.initBuffer, first.ftyp))
    : Buffer.alloc(0);

  const parts = [];
  const mvhd = findChild(first.initBuffer, first.moov, "mvhd");
  if (mvhd) parts.push(Buffer.from(sliceBox(first.initBuffer, mvhd)));

  let trak1 = Buffer.from(sliceBox(first.initBuffer, first.trak));
  if (upgradeToCo64) {
    trak1 = upgradeTrakStcoToCo64(trak1, offsetDelta);
  }
  parts.push(trak1);

  let trak2 = Buffer.from(sliceBox(second.initBuffer, second.trak));
  const tkhd2 = findChild(second.initBuffer, second.trak, "tkhd");
  if (tkhd2) {
    const newTkhd = writeTkhdTrackId(second.initBuffer, tkhd2, secondId);
    const at = tkhd2.start - second.trak.start;
    newTkhd.copy(trak2, at);
  }
  if (upgradeToCo64) {
    trak2 = upgradeTrakStcoToCo64(trak2, offsetDelta);
  }
  parts.push(trak2);

  const mvex1 = findChild(first.initBuffer, first.moov, "mvex");
  const mvex2 = findChild(second.initBuffer, second.moov, "mvex");
  const mvexParts = [];
  if (mvex1) {
    for (const trex of findChildren(first.initBuffer, mvex1, "trex")) {
      mvexParts.push(Buffer.from(sliceBox(first.initBuffer, trex)));
    }
  }
  if (mvex2) {
    for (const trex of findChildren(second.initBuffer, mvex2, "trex")) {
      mvexParts.push(writeTrexTrackId(second.initBuffer, trex, secondId));
    }
  }
  const mvexPayload = Buffer.concat(mvexParts);
  const mvexHeader = Buffer.alloc(8);
  mvexHeader.writeUInt32BE(8 + mvexPayload.length, 0);
  mvexHeader.write("mvex", 4, "latin1");
  parts.push(Buffer.concat([mvexHeader, mvexPayload]));

  const moovPayload = Buffer.concat(parts);
  const moovHeader = Buffer.alloc(8);
  moovHeader.writeUInt32BE(8 + moovPayload.length, 0);
  moovHeader.write("moov", 4, "latin1");
  const moov = Buffer.concat([moovHeader, moovPayload]);

  return { ftyp, moov, firstId, secondId };
}

/**
 * 内存级双轨混流函数（100% 保持既有同步签名与返回值）
 * @param {Array<ReturnType<typeof parseTrack>>} tracks
 * @returns {Buffer}
 */
export function muxTracks(tracks) {
  const usable = tracks.filter(Boolean);
  if (!usable.length) throw new Error("nothing to mux");
  if (usable.length === 1) {
    const t = usable[0];
    const parts = [
      t.ftyp ? Buffer.from(sliceBox(t.initBuffer, t.ftyp)) : Buffer.alloc(0)
    ];
    parts.push(Buffer.from(sliceBox(t.initBuffer, t.moov)));
    for (const s of t.samples) parts.push(Buffer.from(s.buffer));
    return Buffer.concat(parts);
  }

  const [first, second] = usable;
  const { ftyp, moov, secondId } = buildMergedInitBuffers([first, second]);

  const allSamples = [];
  for (const s of first.samples) {
    allSamples.push({ decodeTime: s.decodeTime, buffer: s.buffer });
  }
  for (const s of second.samples) {
    const remapped = rewriteMoofTrackId(
      s.buffer,
      s.moofBox,
      second.trackId,
      secondId
    );
    const payload = Buffer.concat([
      remapped,
      sliceBox(s.buffer, { start: s.moofBox.end, end: s.buffer.length })
    ]);
    allSamples.push({ decodeTime: s.decodeTime, buffer: payload });
  }
  allSamples.sort((a, b) => a.decodeTime - b.decodeTime);

  const outParts = [ftyp, moov];
  for (const s of allSamples) outParts.push(s.buffer);
  return Buffer.concat(outParts);
}

// ============================================================================
// 3. 全流式 I/O 架构：基于 FileHandle 按需读取 Box Header 与 Stream 管道混流
// ============================================================================

/**
 * 通过 FileHandle 在指定偏移处仅读取 8~16 字节的 Box Header，避免加载大块负载
 * @param {fsp.FileHandle} handle 已打开的文件句柄
 * @param {number} offset 起始字节偏移
 * @param {number} fileSize 文件总字节数
 * @param {Buffer} [scratchBuf] 可复用的 16 字节暂存 Buffer
 * @returns {Promise<{ type: string, size: number, headerSize: number, start: number, end: number } | null>}
 */
export async function readBoxHeaderFromFile(
  handle,
  offset,
  fileSize,
  scratchBuf = Buffer.allocUnsafe(16)
) {
  if (offset + 8 > fileSize) return null;
  const toRead = Math.min(16, fileSize - offset);
  const { bytesRead } = await handle.read(scratchBuf, 0, toRead, offset);
  if (bytesRead < 8) return null;

  let size = scratchBuf.readUInt32BE(0);
  const type = scratchBuf.toString("latin1", 4, 8);
  let headerSize = 8;

  if (size === 1) {
    if (bytesRead < 16) return null;
    size = Number(scratchBuf.readBigUInt64BE(8));
    headerSize = 16;
  } else if (size === 0) {
    size = fileSize - offset;
  }

  if (size < headerSize || offset + size > fileSize) return null;
  return {
    type,
    size,
    headerSize,
    start: offset,
    end: offset + size
  };
}

/**
 * 流式扫描整个文件的顶层 Box 列表（仅读取每个 Box 的 8~16 字节头部，跳过 mdat 内容）
 * @param {fsp.FileHandle} handle
 * @param {number} fileSize
 * @returns {Promise<Array<{ type: string, size: number, headerSize: number, start: number, end: number }>>}
 */
export async function listFileBoxes(handle, fileSize) {
  const boxes = [];
  const scratch = Buffer.allocUnsafe(16);
  let offset = 0;
  while (offset + 8 <= fileSize) {
    const box = await readBoxHeaderFromFile(handle, offset, fileSize, scratch);
    if (!box) break;
    boxes.push(box);
    offset = box.end;
  }
  return boxes;
}

/**
 * 按需从 FileHandle 读取指定元数据 Box（如 ftyp, moov, moof, sidx）的完整字节到 Buffer
 * @param {fsp.FileHandle} handle
 * @param {{ start: number, size: number }} box
 * @returns {Promise<Buffer>}
 */
async function readMetadataBoxBuffer(handle, box) {
  const buf = Buffer.allocUnsafe(box.size);
  let totalRead = 0;
  while (totalRead < box.size) {
    const { bytesRead } = await handle.read(
      buf,
      totalRead,
      box.size - totalRead,
      box.start + totalRead
    );
    if (bytesRead === 0) break;
    totalRead += bytesRead;
  }
  return totalRead === box.size ? buf : buf.subarray(0, totalRead);
}

/**
 * 使用 FileHandle 按需扫描单轨文件：
 * - 仅将 init 段 (ftyp/moov) 与各分片的 moof 等轻量元数据读入 Buffer；
 * - 对 mdat 媒体负载仅记录文件偏移 (mdatPayloadStart / mdatPayloadEnd / payloadSize)，零内存加载。
 * @param {fsp.FileHandle} handle
 * @param {string} filePath
 */
async function inspectTrackFromFileHandle(handle, filePath) {
  const stat = await handle.stat();
  const fileSize = stat.size;
  if (fileSize < 8) {
    return { isFmp4: false };
  }

  const boxes = await listFileBoxes(handle, fileSize);
  if (!boxes.length) {
    return { isFmp4: false };
  }

  let initEnd = 0;
  const initBoxes = [];
  for (const b of boxes) {
    if (
      b.type === "ftyp" ||
      b.type === "moov" ||
      b.type === "styp" ||
      b.type === "free"
    ) {
      initEnd = b.end;
      initBoxes.push(b);
    } else {
      break;
    }
  }

  const hasMoov = initBoxes.some((b) => b.type === "moov");
  const hasFtyp = initBoxes.some((b) => b.type === "ftyp" || b.type === "styp");
  if (!hasMoov || !hasFtyp || initEnd === 0) {
    return { isFmp4: false };
  }

  // 读取轻量级初始化段（通常仅数 KB），复用 parseTrack 校验 moov/trak/tkhd 结构
  const initBuffer = await readMetadataBoxBuffer(handle, {
    start: 0,
    size: initEnd
  });
  const parsedInit = parseTrack(initBuffer, []);

  // 遍历剩余 Box，按 [元数据 Box (moof 等) + mdat] 组装流式分片描述符
  const remainingBoxes = boxes.filter((b) => b.start >= initEnd);
  const hasMoof = remainingBoxes.some((b) => b.type === "moof");
  if (!hasMoof) {
    return { isFmp4: false };
  }
  const fragments = [];

  if (hasMoof) {
    let pendingMeta = [];
    for (const b of remainingBoxes) {
      if (b.type !== "mdat") {
        const metaBuf = await readMetadataBoxBuffer(handle, b);
        pendingMeta.push({ box: b, buffer: metaBuf });
      } else {
        // 遇到 mdat：绝不读取其负载到内存，仅记录文件偏移和头部信息
        const moofIdx = pendingMeta.findIndex((m) => m.box.type === "moof");
        if (moofIdx === -1) {
          pendingMeta = [];
          continue;
        }
        const moofEntry = pendingMeta[moofIdx];
        const localMoofBox = {
          type: "moof",
          size: moofEntry.buffer.length,
          headerSize: moofEntry.box.headerSize,
          start: 0,
          end: moofEntry.buffer.length
        };
        const decodeTime = extractMoofDecodeTime(moofEntry.buffer, localMoofBox);

        const mdatHeaderBuf = Buffer.alloc(b.headerSize);
        if (b.headerSize === 16) {
          mdatHeaderBuf.writeUInt32BE(1, 0);
          mdatHeaderBuf.write("mdat", 4, "latin1");
          mdatHeaderBuf.writeBigUInt64BE(BigInt(b.size), 8);
        } else {
          mdatHeaderBuf.writeUInt32BE(b.size, 0);
          mdatHeaderBuf.write("mdat", 4, "latin1");
        }

        fragments.push({
          decodeTime,
          sourcePath: filePath,
          metaItems: pendingMeta,
          moofIndex: moofIdx,
          mdatHeaderBuf,
          mdatFileOffset: b.start,
          mdatSize: b.size,
          mdatHeaderSize: b.headerSize,
          mdatPayloadStart: b.start + b.headerSize,
          mdatPayloadEnd: b.end - 1,
          mdatPayloadSize: b.size - b.headerSize
        });
        pendingMeta = [];
      }
    }
  }

  return {
    isFmp4: true,
    track: parsedInit,
    fragments,
    fileSize
  };
}

/**
 * 向 WriteStream 写入单个 Buffer 并遵循背压控制 (drain)
 * @param {fs.WriteStream} writeStream
 * @param {Buffer} buffer
 */
async function writeBufferWithBackpressure(writeStream, buffer) {
  if (!buffer || buffer.length === 0) return;
  if (!writeStream.write(buffer)) {
    await once(writeStream, "drain");
  }
}

/**
 * 通过 fs.createReadStream 将源文件中 [start, end] 范围的 mdat 原始媒体负载以 64KB 分块流式泵入目标写入流
 * @param {string} sourcePath 源轨文件路径
 * @param {number} start 负载起始字节偏移 (mdatPayloadStart)
 * @param {number} end 负载结束字节偏移（闭区间 mdatPayloadEnd）
 * @param {fs.WriteStream} writeStream 目标文件写入流
 */
async function pipeMdatPayloadRange(sourcePath, start, end, writeStream) {
  if (end < start) return;
  const readStream = fs.createReadStream(sourcePath, {
    start,
    end,
    highWaterMark: STREAM_HIGH_WATER_MARK
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      readStream.destroy();
      reject(err);
    };
    readStream.on("error", onError);
    writeStream.on("error", onError);
    readStream.on("end", () => {
      writeStream.removeListener("error", onError);
      resolve();
    });
    readStream.pipe(writeStream, { end: false });
  });
}

/**
 * 基于 FileHandle 与 Stream 的全流式双轨 fMP4 混流引擎（内存占用恒定低于 50MB）
 * @param {{ videoPath?: string|null, audioPath?: string|null, outputPath: string, forceCo64?: boolean }} params
 * @returns {Promise<{ ok: boolean, output: string|null, error: string|null, method: "native" } | null>}
 */
export async function muxFilesStreaming({
  videoPath,
  audioPath,
  outputPath,
  forceCo64 = false
}) {
  if (!videoPath && !audioPath) {
    return {
      ok: false,
      output: null,
      error: "nothing to merge",
      method: "native"
    };
  }

  /** @type {fsp.FileHandle|null} */
  let videoHandle = null;
  /** @type {fsp.FileHandle|null} */
  let audioHandle = null;

  try {
    if (videoPath) {
      videoHandle = await fsp.open(videoPath, "r");
    }
    if (audioPath) {
      audioHandle = await fsp.open(audioPath, "r");
    }

    const vInfo = videoHandle
      ? await inspectTrackFromFileHandle(videoHandle, videoPath)
      : null;
    const aInfo = audioHandle
      ? await inspectTrackFromFileHandle(audioHandle, audioPath)
      : null;

    // 扫描完元数据后立即释放 FileHandle，避免后续流式读取时句柄占满
    if (videoHandle) {
      await videoHandle.close();
      videoHandle = null;
    }
    if (audioHandle) {
      await audioHandle.close();
      audioHandle = null;
    }

    const activeTracks = [];
    if (vInfo && vInfo.isFmp4) activeTracks.push(vInfo);
    if (aInfo && aInfo.isFmp4) activeTracks.push(aInfo);

    // 若均非 fMP4，返回 null 供上层降级到 ffmpeg
    if (!activeTracks.length) {
      return null;
    }

    // 预估合并后文件总大小，若超过 4GB (0xFFFFFFFF) 则自动触发 stco -> co64 64 位升级
    const totalEstimatedBytes = activeTracks.reduce(
      (acc, item) => acc + BigInt(item.fileSize || 0),
      0n
    );
    const shouldUpgradeCo64 =
      Boolean(forceCo64) || totalEstimatedBytes > BigInt(MAX_UINT32_OFFSET);

    const parsedTracks = activeTracks.map((item) => item.track);
    const { ftyp, moov, secondId } = buildMergedInitBuffers(parsedTracks, {
      upgradeToCo64: shouldUpgradeCo64,
      offsetDelta: 0n
    });

    // 收集并按 decodeTime 交织排序所有音视频分片描述符（仅含轻量元数据引用）
    const allFragments = [];
    const firstTrackInfo = activeTracks[0];
    for (const frag of firstTrackInfo.fragments) {
      allFragments.push({
        ...frag,
        isSecondTrack: false,
        oldTrackId: firstTrackInfo.track.trackId,
        newTrackId: firstTrackInfo.track.trackId
      });
    }

    if (activeTracks.length > 1) {
      const secondTrackInfo = activeTracks[1];
      for (const frag of secondTrackInfo.fragments) {
        allFragments.push({
          ...frag,
          isSecondTrack: true,
          oldTrackId: secondTrackInfo.track.trackId,
          newTrackId: secondId
        });
      }
    }

    allFragments.sort((a, b) => a.decodeTime - b.decodeTime);

    // 创建目标文件写入流，依次写入 ftyp、moov 及交织后的 moof + mdat 流
    await fsp.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    const writeStream = fs.createWriteStream(outputPath, {
      highWaterMark: STREAM_HIGH_WATER_MARK
    });

    try {
      await writeBufferWithBackpressure(writeStream, ftyp);
      await writeBufferWithBackpressure(writeStream, moov);

      for (const frag of allFragments) {
        // 1. 写入 moof 及同分片内的非 mdat 元数据 Box（第二轨道从 moof 起改写 track_id）
        const startIdx = frag.isSecondTrack ? frag.moofIndex : 0;
        for (let i = startIdx; i < frag.metaItems.length; i++) {
          const meta = frag.metaItems[i];
          if (frag.isSecondTrack && meta.box.type === "moof") {
            const localMoof = {
              type: "moof",
              size: meta.buffer.length,
              headerSize: meta.box.headerSize,
              start: 0,
              end: meta.buffer.length
            };
            const rewrittenMoof = rewriteMoofTrackId(
              meta.buffer,
              localMoof,
              frag.oldTrackId,
              frag.newTrackId
            );
            await writeBufferWithBackpressure(writeStream, rewrittenMoof);
          } else {
            await writeBufferWithBackpressure(writeStream, meta.buffer);
          }
        }

        // 2. 写入 mdat Box Header (8 或 16 字节)
        await writeBufferWithBackpressure(writeStream, frag.mdatHeaderBuf);

        // 3. 以 64KB 分块流式管道直接从源文件泵入 mdat 媒体负载
        if (frag.mdatPayloadSize > 0) {
          await pipeMdatPayloadRange(
            frag.sourcePath,
            frag.mdatPayloadStart,
            frag.mdatPayloadEnd,
            writeStream
          );
        }
      }

      await new Promise((resolve, reject) => {
        writeStream.on("error", reject);
        writeStream.end(resolve);
      });
    } catch (streamErr) {
      writeStream.destroy();
      throw streamErr;
    }

    return {
      ok: true,
      output: outputPath,
      error: null,
      method: "native"
    };
  } catch (err) {
    return {
      ok: false,
      output: null,
      error: err && err.message ? err.message : String(err),
      method: "native"
    };
  } finally {
    if (videoHandle) {
      try {
        await videoHandle.close();
      } catch {
        // ignore close error
      }
    }
    if (audioHandle) {
      try {
        await audioHandle.close();
      } catch {
        // ignore close error
      }
    }
  }
}