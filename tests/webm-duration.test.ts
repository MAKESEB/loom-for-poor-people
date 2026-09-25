import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixRecordingDuration } from '../src/client/fixWebmDuration';

const SEGMENT_ID = new Uint8Array([0x18, 0x53, 0x80, 0x67]);
const UNKNOWN_SIZE = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

function join(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function id(value: number): Uint8Array<ArrayBuffer> {
  const hex = value.toString(16);
  return Uint8Array.from(hex.match(/.{2}/g)!.map(pair => parseInt(pair, 16)));
}

function size(value: number): Uint8Array<ArrayBuffer> {
  let width = 1;
  while (BigInt(value) >= (1n << BigInt(width * 7)) - 1n) width += 1;
  let encoded = BigInt(value) | (1n << BigInt(width * 7));
  const bytes = new Uint8Array(width);
  for (let index = width - 1; index >= 0; index -= 1) { bytes[index] = Number(encoded & 255n); encoded >>= 8n; }
  return bytes;
}

function element(value: number, payload = new Uint8Array()): Uint8Array<ArrayBuffer> {
  return join(id(value), size(payload.length), payload);
}

function uint(value: number): Uint8Array<ArrayBuffer> {
  const bytes: number[] = [];
  do { bytes.unshift(value % 256); value = Math.floor(value / 256); } while (value);
  return Uint8Array.from(bytes);
}

function float(value: number, width = 8): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(width);
  if (width === 4) new DataView(bytes.buffer).setFloat32(0, value);
  else new DataView(bytes.buffer).setFloat64(0, value);
  return bytes;
}

const EBML = element(0x1a45dfa3, element(0x4282, new TextEncoder().encode('webm')));
const TRACKS = element(0x1654ae6b);
const BLOCK = element(0xa3, new Uint8Array([0x81, 0, 0, 0x80, 0xde, 0xad, 0xbe, 0xef]));
const CLUSTER = element(0x1f43b675, join(element(0xe7, uint(0)), BLOCK));

function info(...children: Uint8Array[]) { return element(0x1549a966, join(...children)); }
function timestampScale(value = 1_000_000) { return element(0x2ad7b1, uint(value)); }
function webm(children: Uint8Array[], finite = false) {
  const payload = join(...children);
  return new Blob([EBML, SEGMENT_ID, finite ? size(payload.length) : UNKNOWN_SIZE, payload], { type: 'video/webm' });
}

function durationOffset(bytes: Uint8Array, width = 8) {
  const found = Buffer.from(bytes).indexOf(new Uint8Array([0x44, 0x89, 0x80 | width]));
  assert(found >= 0, 'the repaired Info must contain a Float Duration element');
  return found + 3;
}

async function bytes(blob: Blob) { return new Uint8Array(await blob.arrayBuffer()); }

test('inserts Duration while preserving TimestampScale, unknown Segment size and every media byte', async () => {
  const metadata = info(timestampScale(2_000_000), element(0x4d80, new TextEncoder().encode('Chrome')));
  const source = webm([metadata, TRACKS, CLUSTER]);
  const original = await bytes(source);
  const fixed = await fixRecordingDuration(source, 12_345);
  const output = await bytes(fixed);

  assert.notEqual(fixed, source);
  assert.equal(fixed.type, 'video/webm');
  assert.equal(output.length, original.length + 11);
  const duration = durationOffset(output);
  assert.equal(new DataView(output.buffer).getFloat64(duration), 6_172.5, 'duration uses the original 2 ms time base');
  assert.deepEqual(output.subarray(EBML.length, EBML.length + 12), join(SEGMENT_ID, UNKNOWN_SIZE));
  assert.deepEqual(output.subarray(0, EBML.length + 12 + 4), original.subarray(0, EBML.length + 12 + 4));
  assert.deepEqual(output.subarray(duration + 8), join(TRACKS, CLUSTER), 'the untouched tail starts immediately after appended Duration');
  assert(Buffer.from(output).includes(Buffer.from(timestampScale(2_000_000))), 'TimestampScale bytes must never be normalized');
  assert.deepEqual(await bytes(source), original, 'the original Blob remains unchanged');
});

test('uses the specified default TimestampScale when absent or represented by an empty element', async () => {
  for (const scale of [new Uint8Array(), element(0x2ad7b1)]) {
    const fixed = await fixRecordingDuration(webm([info(scale), TRACKS, CLUSTER]), 123.25);
    const output = await bytes(fixed);
    assert.equal(new DataView(output.buffer).getFloat64(durationOffset(output)), 123.25);
  }
});

test('replaces an existing Duration in a finite indexed file without shifting any byte offsets', async () => {
  const originalDuration = element(0x4489, float(100));
  const seek = element(0x114d9b74, element(0x4dbb, element(0x53ac, uint(44))));
  const cues = element(0x1c53bb6b, element(0xbb, element(0xb7, element(0xf1, uint(44)))));
  const source = webm([seek, info(timestampScale(), originalDuration), TRACKS, CLUSTER, cues], true);
  const original = await bytes(source);
  const expected = original.slice();
  new DataView(expected.buffer).setFloat64(durationOffset(expected), 9_876.5);

  const fixed = await fixRecordingDuration(source, 9_876.5);
  assert.deepEqual(await bytes(fixed), expected, 'only the original Float payload may change');
  assert.equal(fixed.size, source.size);
});

test('preserves the four-byte Float representation and respects a non-default time base', async () => {
  const source = webm([info(timestampScale(500_000), element(0x4489, float(0, 4))), TRACKS, CLUSTER], true);
  const original = await bytes(source);
  const expected = original.slice();
  new DataView(expected.buffer).setFloat32(durationOffset(expected, 4), 2_469);
  assert.deepEqual(await bytes(await fixRecordingDuration(source, 1_234.5)), expected);
});

test('grows the Info size VINT instead of accidentally writing the unknown-size sentinel', async () => {
  // 120 bytes of Info data becomes 131 after appending the 11-byte Duration.
  // A Title is meaningful metadata and cannot be reclaimed like a Void.
  const metadata = info(element(0x7ba9, new Uint8Array(117).fill(0x61)));
  const source = webm([metadata, TRACKS, CLUSTER]);
  const fixed = await fixRecordingDuration(source, 4_000);
  const output = await bytes(fixed);
  const infoSizeOffset = EBML.length + SEGMENT_ID.length + UNKNOWN_SIZE.length + 4;
  assert.deepEqual(output.subarray(infoSizeOffset, infoSizeOffset + 2), new Uint8Array([0x40, 0x83]));
  assert.equal(fixed.size, source.size + 12, 'the widened size VINT contributes one additional byte');
  assert.deepEqual(output.subarray(-TRACKS.length - CLUSTER.length), join(TRACKS, CLUSTER));
});

test('walks unknown-size Clusters using EBML boundaries while ignoring element-like video bytes', async () => {
  const opaque = element(0xa3, join(new Uint8Array([0x81, 0, 0, 0x80]), id(0x1c53bb6b), id(0x114d9b74)));
  const first = join(id(0x1f43b675), UNKNOWN_SIZE, element(0xe7, uint(0)), opaque);
  const second = join(id(0x1f43b675), UNKNOWN_SIZE, element(0xe7, uint(500)), BLOCK);
  const source = webm([info(timestampScale()), TRACKS, first, second]);
  const fixed = await fixRecordingDuration(source, 1_000);
  assert.notEqual(fixed, source);
  assert.deepEqual((await bytes(fixed)).subarray(-first.length - second.length), join(first, second));
});

interface ReadObservation { start: number; length: number }

class ObservedBlob extends Blob {
  reads: ReadObservation[] = [];
  override async arrayBuffer(): Promise<ArrayBuffer> { throw new Error('The entire source recording must not be materialized.'); }
  override slice(start = 0, end = this.size, contentType?: string): Blob {
    const part = super.slice(start, end, contentType);
    const read = part.arrayBuffer.bind(part);
    part.arrayBuffer = async () => {
      this.reads.push({ start, length: part.size });
      assert(part.size <= 1024 * 1024, 'every metadata read is bounded to at most 1 MiB');
      return read();
    };
    return part;
  }
}

function largeRecording(trailer = new Uint8Array(), metadata = info(timestampScale())) {
  // Immutable Blob references create a large logical file without a giant buffer.
  const unit = new Blob([new Uint8Array(1024 * 1024).fill(0x5a)]);
  const payload = new Blob(Array.from({ length: 512 }, () => unit));
  const largeBlockHeader = join(id(0xa3), size(payload.size));
  const ending = element(0xa3, new Uint8Array([0x81, 0, 0, 0x80, 0x11, 0x22, 0x33]));
  const clusterHeader = join(id(0x1f43b675), size(largeBlockHeader.length + payload.size + ending.length));
  return new ObservedBlob([EBML, SEGMENT_ID, UNKNOWN_SIZE, metadata, TRACKS, clusterHeader, largeBlockHeader, payload, ending, trailer], { type: 'video/webm' });
}

function chromeInfo() {
  return info(timestampScale(), element(0x4d80, new TextEncoder().encode('Chrome')), element(0x5741, new TextEncoder().encode('Chrome')));
}

test('finishes a large Chrome-style capture with one prefix read and no changed media or index offsets', async () => {
  const cues = element(0x1c53bb6b, element(0xbb, element(0xb7, element(0xf1, uint(61)))));
  const source = largeRecording(cues, chromeInfo());
  const fixed = await fixRecordingDuration(source, 3_600_000);
  assert.notEqual(fixed, source);
  assert.equal(fixed.size, source.size, 'Info is patched within its original allocation');
  assert.deepEqual(source.reads, [{ start: 0, length: 1024 * 1024 }], 'no disk reads are issued for recorded frames');
  const prefix = await bytes(fixed.slice(0, 100));
  assert.equal(new DataView(prefix.buffer).getFloat32(durationOffset(prefix, 4)), 3_600_000);
  assert(Buffer.from(prefix).includes(Buffer.from(timestampScale())), 'the exact timestamp scale remains present');
  assert.deepEqual(await bytes(fixed.slice(-64)), await bytes(Blob.prototype.slice.call(source, -64)));
  const infoEnd = EBML.length + SEGMENT_ID.length + UNKNOWN_SIZE.length + chromeInfo().length;
  assert.deepEqual(await bytes(fixed.slice(infoEnd, infoEnd + 128)), await bytes(Blob.prototype.slice.call(source, infoEnd, infoEnd + 128)));
});

test('reuses Void space for float64 Duration while leaving application names and every external offset unchanged', async () => {
  const app = element(0x4d80, new TextEncoder().encode('Chrome'));
  const metadata = info(timestampScale(), app, element(0xec, new Uint8Array(15)));
  const source = webm([element(0x114d9b74), metadata, TRACKS, CLUSTER, element(0x1c53bb6b)], true);
  const original = await bytes(source);
  const fixed = await fixRecordingDuration(source, 12_345.678);
  const output = await bytes(fixed);
  assert.equal(output.length, original.length);
  assert.equal(new DataView(output.buffer).getFloat64(durationOffset(output)), 12_345.678);
  assert(Buffer.from(output).includes(Buffer.from(app)), 'available padding avoids altering application names');
  assert.deepEqual(output.subarray(-CLUSTER.length - 5), original.subarray(-CLUSTER.length - 5));
});

test('absorbs a single spare byte with a legal two-byte Duration size VINT', async () => {
  const metadata = info(timestampScale(), element(0xec, new Uint8Array(10)));
  const source = webm([metadata, TRACKS, CLUSTER]);
  const fixed = await fixRecordingDuration(source, 1_234);
  const output = await bytes(fixed);
  const offset = Buffer.from(output).indexOf(new Uint8Array([0x44, 0x89, 0x40, 0x08]));
  assert(offset >= 0, 'a finite eight-byte Float uses a valid extended size encoding');
  assert.equal(new DataView(output.buffer).getFloat64(offset + 4), 1_234);
  assert.equal(fixed.size, source.size);
  assert.deepEqual(output.subarray(-CLUSTER.length), CLUSTER);
});

test('compacts descriptive names only on UTF-8 boundaries and keeps both mandatory names nonempty', async () => {
  const names = [element(0x4d80, new TextEncoder().encode('🦊🦊🦊')), element(0x5741, new TextEncoder().encode('🦊🦊🦊'))];
  const source = webm([info(timestampScale(), ...names), TRACKS, CLUSTER]);
  const fixed = await fixRecordingDuration(source, 100);
  assert.equal(fixed.size, source.size);
  const output = await bytes(fixed);
  for (const identifier of [0x4d80, 0x5741]) {
    const start = Buffer.from(output).indexOf(id(identifier));
    const length = output[start + 2] & 0x7f;
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(output.subarray(start + 3, start + 3 + length));
    assert(decoded.length > 0 && /^🦊+$/u.test(decoded));
  }
  const floatOffset = Buffer.from(output).indexOf(new Uint8Array([0x44, 0x89, 0x40, 0x08]));
  assert(floatOffset >= 0);
  assert.equal(new DataView(output.buffer).getFloat64(floatOffset + 4), 100);
});

test('repairs a 512 MiB recording using a bounded prefix and sparse headers, preserving its lazy tail', async () => {
  const source = largeRecording();
  const fixed = await fixRecordingDuration(source, 60 * 60 * 1000);
  assert.notEqual(fixed, source);
  assert.equal(fixed.size, source.size + 11);
  assert(source.reads.some(read => read.start > 500 * 1024 * 1024), 'the tail structure is checked without reading media payload');
  assert(source.reads.reduce((total, read) => total + read.length, 0) <= 1024 * 1024 + 64);
  const prefix = await bytes(fixed.slice(0, 100));
  assert.equal(new DataView(prefix.buffer).getFloat64(durationOffset(prefix)), 3_600_000);
  assert.deepEqual(await bytes(fixed.slice(-64)), await bytes(Blob.prototype.slice.call(source, -64)));
});

test('finds trailing Cues beyond a large media payload and declines offset-changing insertion', async () => {
  const source = largeRecording(element(0x1c53bb6b, element(0xbb)));
  assert.equal(await fixRecordingDuration(source, 10_000), source);
  assert(source.reads.reduce((total, read) => total + read.length, 0) <= 1024 * 1024 + 96);
});

test('does not insert into finite or indexed layouts, including indices after unknown-size Clusters', async () => {
  const unknownCluster = join(id(0x1f43b675), UNKNOWN_SIZE, BLOCK);
  const metadata = info(timestampScale());
  const fixtures = [
    webm([metadata, TRACKS, CLUSTER], true),
    webm([element(0x114d9b74), metadata, TRACKS, CLUSTER]),
    webm([metadata, TRACKS, CLUSTER, element(0x1c53bb6b)]),
    webm([metadata, TRACKS, unknownCluster, element(0x1c53bb6b)]),
    webm([metadata, TRACKS, element(0x1f43b675, join(element(0xa7, uint(50)), BLOCK))]),
  ];
  for (const source of fixtures) assert.equal(await fixRecordingDuration(source, 5_000), source);
});

test('preserves enclosing checksums instead of leaving invalid CRC values after an edit', async () => {
  const checksum = element(0xbf, new Uint8Array(4));
  for (const duration of [new Uint8Array(), element(0x4489, float(0))]) {
    for (const source of [
      webm([checksum, info(timestampScale(), duration), TRACKS, CLUSTER]),
      webm([info(checksum, timestampScale(), duration), TRACKS, CLUSTER]),
    ]) assert.equal(await fixRecordingDuration(source, 5_000), source);
  }
});

test('returns the original for truncated elements, malformed sizes, invalid time bases and unsupported Float sizes', async () => {
  const valid = webm([info(timestampScale()), TRACKS, CLUSTER]);
  const truncatedCluster = valid.slice(0, valid.size - 1, 'video/webm');
  const fixtures = [
    truncatedCluster,
    new Blob([EBML, SEGMENT_ID, UNKNOWN_SIZE, id(0x1549a966), new Uint8Array([0])], { type: 'video/webm' }),
    webm([info(timestampScale(0)), TRACKS, CLUSTER]),
    webm([info(timestampScale(), timestampScale()), TRACKS, CLUSTER]),
    webm([info(timestampScale(), element(0x4489, new Uint8Array(3))), TRACKS, CLUSTER]),
    webm([info(timestampScale(), element(0x4489, float(0)), element(0x4489, float(0))), TRACKS, CLUSTER]),
    webm([info(timestampScale()), TRACKS, CLUSTER, info(timestampScale())]),
  ];
  for (const source of fixtures) assert.equal(await fixRecordingDuration(source, 5_000), source);
});

test('leaves unsupported inputs and invalid requested durations untouched', async () => {
  const source = webm([info(timestampScale()), TRACKS, CLUSTER]);
  for (const duration of [0, -1, Infinity, NaN]) assert.equal(await fixRecordingDuration(source, duration), source);
  const mp4 = new Blob([new Uint8Array([0, 0, 0, 12])], { type: 'video/mp4' });
  assert.equal(await fixRecordingDuration(mp4, 1_000), mp4);
  const unreadable = new ObservedBlob([source], { type: 'video/webm' });
  unreadable.slice = () => { throw new Error('Source is no longer readable'); };
  assert.equal(await fixRecordingDuration(unreadable, 1_000), unreadable);
});
