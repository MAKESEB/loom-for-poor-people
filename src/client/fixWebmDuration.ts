const PREFIX_BYTES = 1024 * 1024;
const MAX_METADATA_READ_BYTES = 8 * 1024 * 1024;
const MAX_ELEMENTS = 500_000;

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TRACKS = 0x1654ae6b;
const CLUSTER = 0x1f43b675;
const SEEK_HEAD = 0x114d9b74;
const CUES = 0x1c53bb6b;
const VOID = 0xec;
const CRC32 = 0xbf;
const DURATION = 0x4489;
const TIMESTAMP_SCALE = 0x2ad7b1;
const CLUSTER_POSITION = 0xa7;
const MUXING_APP = 0x4d80;
const WRITING_APP = 0x5741;

const TOP_LEVEL = new Set([INFO, TRACKS, CLUSTER, SEEK_HEAD, CUES, 0x1941a469, 0x1043a770, 0x1254c367]);
const CLUSTER_CHILDREN = new Set([0xe7, 0x5854, CLUSTER_POSITION, 0xab, 0xa3, 0xa0, 0xaf, VOID, CRC32]);

interface Element {
  id: number;
  start: number;
  sizeStart: number;
  sizeWidth: number;
  dataStart: number;
  end: number | null;
}

class UnsupportedWebm extends Error {}

function vint(bytes: Uint8Array, offset: number, isId: boolean) {
  const first = bytes[offset];
  if (!first) throw new UnsupportedWebm();
  let width = 1;
  let marker = 0x80;
  while (!(first & marker)) { width += 1; marker >>>= 1; }
  if (width > (isId ? 4 : 8) || offset + width > bytes.length) throw new UnsupportedWebm();
  let value = isId ? first : first & (marker - 1);
  let unknown = !isId && value === marker - 1;
  for (let index = 1; index < width; index += 1) {
    value = value * 256 + bytes[offset + index];
    unknown &&= bytes[offset + index] === 0xff;
  }
  if (!unknown && !Number.isSafeInteger(value)) throw new UnsupportedWebm();
  return { width, value: unknown ? null : value };
}

function element(bytes: Uint8Array, start: number, availableEnd: number): Element {
  const id = vint(bytes, 0, true);
  const size = vint(bytes, id.width, false);
  const dataStart = start + id.width + size.width;
  const end = size.value === null ? null : dataStart + size.value;
  if (dataStart > availableEnd || (end !== null && (!Number.isSafeInteger(end) || end > availableEnd))) throw new UnsupportedWebm();
  return { id: id.value!, start, sizeStart: start + id.width, sizeWidth: size.width, dataStart, end };
}

function finiteEnd(value: Element) {
  if (value.end === null) throw new UnsupportedWebm();
  return value.end;
}

function encodeSize(value: number, width: number): Uint8Array<ArrayBuffer> {
  // All-one VINT data is the unknown-size sentinel, never a finite byte count.
  while (value >= 2 ** (7 * width) - 1) width += 1;
  if (width > 8 || !Number.isSafeInteger(value)) throw new UnsupportedWebm();
  const bytes = new Uint8Array(width);
  for (let index = width - 1; index >= 0; index -= 1) {
    bytes[index] = value % 256;
    value = Math.floor(value / 256);
  }
  bytes[0] |= 1 << (8 - width);
  return bytes;
}

function readInfo(info: Element, prefix: Uint8Array) {
  const end = finiteEnd(info);
  if (end > prefix.length) throw new UnsupportedWebm();
  let scale = 1_000_000;
  let sawScale = false;
  let duration: Element | null = null;
  const children: Element[] = [];
  for (let offset = info.dataStart; offset < end;) {
    const child = element(prefix.subarray(offset, Math.min(offset + 12, end)), offset, end);
    const childEnd = finiteEnd(child);
    children.push(child);
    if (child.id === CRC32) throw new UnsupportedWebm();
    if (child.id === DURATION) {
      if (duration || ![4, 8].includes(childEnd - child.dataStart)) throw new UnsupportedWebm();
      duration = child;
    } else if (child.id === TIMESTAMP_SCALE) {
      if (sawScale || childEnd - child.dataStart > 8) throw new UnsupportedWebm();
      sawScale = true;
      if (childEnd > child.dataStart) {
        scale = 0;
        for (let index = child.dataStart; index < childEnd; index += 1) scale = scale * 256 + prefix[index];
        if (!Number.isSafeInteger(scale) || scale <= 0) throw new UnsupportedWebm();
      }
    }
    offset = childEnd;
  }
  return { scale, duration, children };
}

function encodeFloat(value: number, width: number): Uint8Array<ArrayBuffer> | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const bytes = new Uint8Array(width);
  const view = new DataView(bytes.buffer);
  if (width === 4) {
    view.setFloat32(0, value);
    if (!Number.isFinite(view.getFloat32(0)) || view.getFloat32(0) <= 0) return null;
  } else view.setFloat64(0, value);
  return bytes;
}

/** Fit Duration into existing metadata space, so neither indexes nor media move. */
function compactInfo(info: Element, fields: ReturnType<typeof readInfo>, prefix: Uint8Array, ticks: number): Uint8Array<ArrayBuffer> | null {
  const voidBytes = fields.children.filter(child => child.id === VOID).reduce((total, child) => total + finiteEnd(child) - child.start, 0);
  const apps = fields.children.filter(child => child.id === MUXING_APP || child.id === WRITING_APP);
  const appCounts = new Map<number, number>();
  for (const app of apps) appCounts.set(app.id, (appCounts.get(app.id) ?? 0) + 1);
  // Only descriptive application names may shrink. Keep nonempty UTF-8 prefixes;
  // codec settings, timestamps and all other metadata remain byte-for-byte intact.
  const trimmable = apps.flatMap(child => {
    const payload = prefix.subarray(child.dataStart, finiteEnd(child));
    if (!payload.length || payload.length > 1024 || appCounts.get(child.id) !== 1) return [];
    try {
      const name = new TextDecoder('utf-8', { fatal: true }).decode(payload);
      if (!name || name.includes('\0')) return [];
      const ends: number[] = [];
      for (let index = 1; index <= payload.length; index += 1) {
        if (index === payload.length || (payload[index] & 0xc0) !== 0x80) ends.push(index);
      }
      return [{ child, ends }];
    } catch { return []; }
  });
  for (const width of [8, 4]) {
    const value = encodeFloat(ticks, width);
    if (!value) continue;
    const names = trimmable.map(app => ({ ...app, lengthIndex: app.ends.length - 1 }));
    let available = voidBytes;
    const needed = 3 + width;
    while (available < needed) {
      // Shorten the longest remaining name first, retaining both mandatory fields.
      const choice = names.filter(app => app.lengthIndex > 0).sort((a, b) => b.ends[b.lengthIndex] - a.ends[a.lengthIndex])[0];
      if (!choice) break;
      const priorLength = choice.ends[choice.lengthIndex];
      choice.lengthIndex -= 1;
      available += priorLength - choice.ends[choice.lengthIndex];
    }
    if (available < needed) continue;
    let remainder = available - needed;
    // A one-byte Void cannot be encoded. A non-minimal size VINT is valid EBML
    // (RFC 8794 §6.1) and absorbs that one spare byte without changing semantics.
    const durationSize = encodeSize(width, remainder === 1 ? 2 : 1);
    if (remainder === 1) remainder = 0;
    const output = new Uint8Array(finiteEnd(info) - info.dataStart);
    let offset = 0;
    const append = (bytes: Uint8Array) => { output.set(bytes, offset); offset += bytes.length; };
    for (const child of fields.children) {
      if (child.id === VOID) continue;
      const name = names.find(app => app.child === child);
      if (name && name.ends[name.lengthIndex] < finiteEnd(child) - child.dataStart) {
        const length = name.ends[name.lengthIndex];
        append(prefix.subarray(child.start, child.sizeStart));
        append(encodeSize(length, child.sizeWidth));
        append(prefix.subarray(child.dataStart, child.dataStart + length));
      } else append(prefix.subarray(child.start, finiteEnd(child)));
    }
    append(new Uint8Array([0x44, 0x89]));
    append(durationSize);
    append(value);
    if (remainder) {
      let sizeWidth = 1;
      while (remainder - 1 - sizeWidth >= 2 ** (7 * sizeWidth) - 1) sizeWidth += 1;
      append(new Uint8Array([VOID]));
      append(encodeSize(remainder - 1 - sizeWidth, sizeWidth));
      offset += remainder - 1 - sizeWidth;
    }
    if (offset !== output.length) throw new UnsupportedWebm();
    return output;
  }
  return null;
}

/**
 * Repair a recorder WebM without reading or copying the complete video into RAM.
 * EBML sizes/unknown masters follow RFC 8794; Duration is in TimestampScale ticks
 * (nanoseconds), not necessarily milliseconds. Unsupported layouts keep the Blob.
 */
export async function fixRecordingDuration(blob: Blob, durationMs: number): Promise<Blob> {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !blob.size || (blob.type && blob.type.split(';')[0] !== 'video/webm')) return blob;
  try {
    const prefix = new Uint8Array(await blob.slice(0, PREFIX_BYTES).arrayBuffer());
    let readBytes = prefix.byteLength;
    let elements = 0;
    async function header(offset: number, parentEnd: number) {
      if (++elements > MAX_ELEMENTS || offset >= parentEnd) throw new UnsupportedWebm();
      const end = Math.min(offset + 12, parentEnd);
      if (end <= prefix.length) return element(prefix.subarray(offset, end), offset, parentEnd);
      readBytes += end - offset;
      if (readBytes > MAX_METADATA_READ_BYTES) throw new UnsupportedWebm();
      return element(new Uint8Array(await blob.slice(offset, end).arrayBuffer()), offset, parentEnd);
    }

    const ebml = await header(0, blob.size);
    if (ebml.id !== EBML || finiteEnd(ebml) > prefix.length) return blob;
    let webm = false;
    for (let offset = ebml.dataStart; offset < ebml.end!;) {
      const child = await header(offset, ebml.end!);
      if (child.id === 0x4282) {
        if (webm || new TextDecoder().decode(prefix.subarray(child.dataStart, finiteEnd(child))) !== 'webm') return blob;
        webm = true;
      }
      offset = finiteEnd(child);
    }
    if (!webm) return blob;

    const segment = await header(ebml.end!, blob.size);
    if (segment.id !== SEGMENT || (segment.end !== null && segment.end !== blob.size)) return blob;
    const segmentEnd = segment.end ?? blob.size;
    let info: Element | null = null;
    let infoFields: ReturnType<typeof readInfo> | null = null;
    let mayInsert = segment.end === null;
    let sawCluster = false;
    let fixedMetadata: { start: number; end: number; bytes: Uint8Array<ArrayBuffer> } | null = null;

    async function clusterEnd(cluster: Element, inspectPositions: boolean) {
      if (cluster.end !== null && !inspectPositions) return cluster.end;
      const end = cluster.end ?? segmentEnd;
      let offset = cluster.dataStart;
      while (offset < end) {
        const child = await header(offset, end);
        // A top-level sibling ends an unknown-size Cluster. Opaque media payloads
        // are skipped using their sizes, never searched for element-looking bytes.
        if (cluster.end === null && TOP_LEVEL.has(child.id)) return offset;
        if (!CLUSTER_CHILDREN.has(child.id) || (inspectPositions && child.id === CLUSTER_POSITION)) throw new UnsupportedWebm();
        offset = finiteEnd(child);
      }
      return offset;
    }

    for (let offset = segment.dataStart; offset < segmentEnd;) {
      const child = await header(offset, segmentEnd);
      if (child.id === CRC32) return blob;
      if (child.id === INFO) {
        if (info || sawCluster) return blob;
        info = child;
        infoFields = readInfo(child, prefix);
        const ticks = durationMs * (1_000_000 / infoFields.scale);
        if (infoFields.duration) {
          const duration = infoFields.duration;
          const value = encodeFloat(ticks, finiteEnd(duration) - duration.dataStart);
          if (value) fixedMetadata = { start: duration.dataStart, end: finiteEnd(duration), bytes: value };
        } else {
          const compacted = compactInfo(child, infoFields, prefix, ticks);
          if (compacted) fixedMetadata = { start: child.dataStart, end: finiteEnd(child), bytes: compacted };
        }
      } else if (child.id === CLUSTER) {
        if (!infoFields) return blob;
        sawCluster = true;
        // RFC 8794 §11.3.1 requires CRC-32 to be the first child of its parent.
        // All enclosing headers and Info have been checked. An equal-size patch
        // leaves even trailing Cues/SeekHead and Cluster Position offsets valid,
        // so this normal Chrome path needs no frame-by-frame reads from disk.
        if (fixedMetadata) return new Blob([
          blob.slice(0, fixedMetadata.start), fixedMetadata.bytes, blob.slice(fixedMetadata.end),
        ], { type: blob.type });
        offset = await clusterEnd(child, infoFields.duration === null);
        continue;
      } else if (child.id !== TRACKS && child.id !== VOID) {
        // Growing Info changes subsequent Segment-relative offsets. Conservatively
        // restrict insertion to the simple Info/Tracks/Cluster recorder layout.
        mayInsert = false;
      }
      offset = finiteEnd(child);
    }
    if (!info || !infoFields || !sawCluster) return blob;

    const ticks = durationMs * (1_000_000 / infoFields.scale);
    if (!Number.isFinite(ticks) || ticks <= 0) return blob;
    const duration = infoFields.duration;
    const width = duration ? finiteEnd(duration) - duration.dataStart : 8;
    const encoded = encodeFloat(ticks, width);
    if (!encoded) return blob;

    if (duration) {
      // A same-width Float replacement preserves all SeekHead/Cues positions.
      return new Blob([blob.slice(0, duration.dataStart), encoded, blob.slice(finiteEnd(duration))], { type: blob.type });
    }
    if (!mayInsert) return blob;
    const durationElement = new Uint8Array([0x44, 0x89, 0x88, ...encoded]);
    const size = encodeSize(finiteEnd(info) - info.dataStart + durationElement.length, info.sizeWidth);
    // Keep the Segment's original unknown-size declaration; rewriting it as a
    // finite size can truncate or invalidate MediaRecorder's streaming container.
    return new Blob([
      blob.slice(0, info.sizeStart), size, blob.slice(info.dataStart, finiteEnd(info)),
      durationElement, blob.slice(finiteEnd(info)),
    ], { type: blob.type });
  } catch {
    // Missing metadata, unsupported indices/CRCs, truncated input, or a read
    // failure must not destroy the recording the browser already captured.
    return blob;
  }
}
