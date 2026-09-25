import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { RecordingStorageError, streamMultipartRecording } from '../src/server/recording-storage';
import type { ManagedStorage, StorageRuntime } from '../src/server/storage';
import type { RecordingPart, RecordingRow } from '../src/server/types';

const ID = 'e578d489-bf37-48b7-905b-0d0df541a7a6';
const VIDEO = Uint8Array.from({ length: 23 }, (_, index) => (index * 37 + 19) % 256);
const SECRET = 'private-storage-capability-secret';
const CHUNK_SIZE = 8;

function manifest() {
  const recording: RecordingRow = {
    id: ID, requestId: ID, uploadId: ID, title: 'Multipart recording',
    contentType: 'video/webm', sizeBytes: VIDEO.length, durationSeconds: 2,
    createdAt: '2026-09-25T10:00:00.000Z', objectKey: `recordings/${ID}/video.webm`,
    transferId: null, uploadSha256: null, uploadAttempted: true, uploadState: 'ready',
    protected: false, markdownEnabled: false, storageMode: 'parts',
    chunkSizeBytes: CHUNK_SIZE, partCount: Math.ceil(VIDEO.length / CHUNK_SIZE),
  };
  const parts: RecordingPart[] = Array.from({ length: recording.partCount! }, (_, index) => {
    const bytes = VIDEO.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
    return {
      recordingId: ID, index, objectKey: `recordings/${ID}/parts/${index}`,
      sizeBytes: bytes.length, transferId: `transfer-${index}`,
      uploadSha256: createHash('sha256').update(bytes).digest('hex'),
      uploadAttempted: true, uploadState: 'ready', leaseVersion: 1,
    };
  });
  return { recording, parts };
}

type UpstreamOverride = (context: {
  index: number; request: Request; bytes: Uint8Array; headers: Headers;
}) => Response | Promise<Response> | undefined;

function fakeRuntime(options: { override?: UpstreamOverride; chunkBytes?: number } = {}) {
  const state = {
    signedReads: [] as string[],
    requests: [] as { index: number; range: string | null }[],
    pulls: [] as number[],
    cancellations: [] as number[],
  };
  const storage: ManagedStorage = {
    async createSignedRead(objectKey) {
      state.signedReads.push(objectKey);
      return {
        operation: 'GET', objectKey,
        url: `https://storage.test/${objectKey}?signature=${SECRET}`,
        expiresAt: '2030-01-01T00:00:00.000Z', expectedContentLength: null,
        requiredHeaders: { 'x-storage-permission': 'allow' },
      };
    },
    async reserveUpload() { throw new Error('Playback must not reserve an upload.'); },
    async completeUpload() { throw new Error('Playback must not complete an upload.'); },
    async upload() { throw new Error('Playback must not upload.'); },
    async deleteObject() { throw new Error('Playback must not delete objects.'); },
  };
  const runtime: StorageRuntime = {
    storage,
    async capabilityFetch(request) {
      assert.equal(request.method, 'GET');
      assert.equal(request.redirect, 'manual');
      assert.equal(request.headers.get('x-storage-permission'), 'allow');
      assert.equal(request.headers.get('cookie'), null);
      assert.equal(request.headers.get('authorization'), null);
      assert.equal(request.headers.get('if-range'), null, 'The aggregate validator does not identify an individual stored part.');
      const index = Number(new URL(request.url).pathname.split('/').at(-1));
      const partBytes = VIDEO.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
      const range = request.headers.get('range');
      state.requests.push({ index, range });
      assert(range, 'Every part fetch must request its exact local byte interval.');
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      assert(match);
      const start = Number(match[1]);
      const end = Number(match[2]);
      assert(start >= 0 && start <= end && end < partBytes.length);
      const bytes = partBytes.slice(start, end + 1);
      const headers = new Headers({
        'content-type': 'video/webm', 'content-length': String(bytes.length),
        'content-range': `bytes ${start}-${end}/${partBytes.length}`,
      });
      const override = await options.override?.({ index, request, bytes, headers });
      if (override) return override;
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          state.pulls.push(index);
          if (offset === bytes.length) { controller.close(); return; }
          const endAt = Math.min(bytes.length, offset + (options.chunkBytes ?? bytes.length));
          controller.enqueue(bytes.slice(offset, endAt));
          offset = endAt;
        },
        cancel() { state.cancellations.push(index); },
      }, { highWaterMark: 0 });
      return new Response(body, { status: 206, headers });
    },
  };
  return { runtime, state };
}

function request(headers: Record<string, string> = {}, method = 'GET') {
  return new Request(`https://app.test/api/recordings/${ID}/video?token=creator-share-token`, {
    method, headers: { cookie: 'creator=session-secret', authorization: 'Bearer creator-secret', ...headers },
  });
}

function safeStorageError(code = 'video_unavailable') {
  return (error: unknown) => {
    assert(error instanceof RecordingStorageError);
    assert.equal(error.status, 502);
    assert.equal(error.code, code);
    assert(error.message.length > 0);
    for (const forbidden of [SECRET, 'storage.test', 'signature=', 'session-secret', 'creator-secret', 'creator-share-token']) {
      assert(!error.message.includes(forbidden), `Error message exposed ${forbidden}`);
    }
    return true;
  };
}

test('multipart playback concatenates exact bytes and keeps private capabilities server-side', async () => {
  const { recording, parts } = manifest();
  const { runtime, state } = fakeRuntime({ chunkBytes: 3 });
  const response = await streamMultipartRecording(request(), runtime, recording, parts);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/webm');
  assert.equal(response.headers.get('content-length'), String(VIDEO.length));
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('content-range'), null);
  assert.match(response.headers.get('etag')!, /^"multipart-[a-f0-9]{64}"$/);
  assert(!JSON.stringify([...response.headers]).includes(SECRET));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), VIDEO);
  assert.deepEqual(state.requests, [
    { index: 0, range: 'bytes=0-7' }, { index: 1, range: 'bytes=0-7' }, { index: 2, range: 'bytes=0-6' },
  ]);
});

test('multipart playback maps cross-part ranges to exact local intervals', async () => {
  const { recording, parts } = manifest();
  const { runtime, state } = fakeRuntime();
  const response = await streamMultipartRecording(request({ range: 'bytes=5-18' }), runtime, recording, parts);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 5-18/23');
  assert.equal(response.headers.get('content-length'), '14');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), VIDEO.slice(5, 19));
  assert.deepEqual(state.requests, [
    { index: 0, range: 'bytes=5-7' }, { index: 1, range: 'bytes=0-7' }, { index: 2, range: 'bytes=0-2' },
  ]);
});

test('suffix, open-ended, single-byte and clamped ranges select the correct parts', async t => {
  for (const [range, start, end, intervals] of [
    ['bytes=-10', 13, 22, [[1, 'bytes=5-7'], [2, 'bytes=0-6']]],
    ['bytes=8-', 8, 22, [[1, 'bytes=0-7'], [2, 'bytes=0-6']]],
    ['bytes=8-8', 8, 8, [[1, 'bytes=0-0']]],
    ['bytes=20-999', 20, 22, [[2, 'bytes=4-6']]],
    ['bytes=-999', 0, 22, [[0, 'bytes=0-7'], [1, 'bytes=0-7'], [2, 'bytes=0-6']]],
  ] as const) {
    await t.test(range, async () => {
      const { recording, parts } = manifest();
      const { runtime, state } = fakeRuntime();
      const response = await streamMultipartRecording(request({ range }), runtime, recording, parts);
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/23`);
      assert.equal(response.headers.get('content-length'), String(end - start + 1));
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), VIDEO.slice(start, end + 1));
      assert.deepEqual(state.requests, intervals.map(([index, localRange]) => ({ index, range: localRange })));
    });
  }
});

test('invalid or unsatisfiable ranges return 416 without opening storage', async t => {
  for (const range of ['bytes=23-', 'bytes=9-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'items=1-2', 'bytes=1.5-2', 'bytes=9007199254740992-']) {
    await t.test(range, async () => {
      const { recording, parts } = manifest();
      const { runtime, state } = fakeRuntime();
      const response = await streamMultipartRecording(request({ range }), runtime, recording, parts);
      assert.equal(response.status, 416);
      assert.equal(response.headers.get('content-range'), 'bytes */23');
      assert.equal(response.headers.get('content-length'), '0');
      assert.equal((await response.arrayBuffer()).byteLength, 0);
      assert.deepEqual(state.signedReads, []);
      assert.deepEqual(state.requests, []);
    });
  }
});

test('HEAD derives headers and a deterministic aggregate validator without storage downloads', async () => {
  const { recording, parts } = manifest();
  const { runtime, state } = fakeRuntime();
  const first = await streamMultipartRecording(request({}, 'HEAD'), runtime, recording, parts);
  const second = await streamMultipartRecording(request({}, 'HEAD'), runtime, { ...recording }, parts.map(part => ({ ...part })));
  assert.equal(first.status, 200);
  assert.equal(first.body, null);
  assert.equal(first.headers.get('content-length'), String(VIDEO.length));
  assert.equal(first.headers.get('etag'), second.headers.get('etag'));
  const changed = parts.map(part => ({ ...part }));
  changed[2].uploadSha256 = 'f'.repeat(64);
  const different = await streamMultipartRecording(request({}, 'HEAD'), runtime, recording, changed);
  assert.notEqual(first.headers.get('etag'), different.headers.get('etag'));
  assert.deepEqual(state.signedReads, []);
  assert.deepEqual(state.requests, []);
  assert.deepEqual(state.pulls, []);
});

test('If-Range accepts only the exact aggregate strong ETag', async t => {
  const { recording, parts } = manifest();
  const headRuntime = fakeRuntime();
  const etag = (await streamMultipartRecording(request({}, 'HEAD'), headRuntime.runtime, recording, parts)).headers.get('etag')!;
  for (const [ifRange, status] of [[etag, 206], [`W/${etag}`, 200], ['"other"', 200], ['Fri, 25 Sep 2026 10:00:00 GMT', 200]] as const) {
    await t.test(ifRange, async () => {
      const { runtime } = fakeRuntime();
      const response = await streamMultipartRecording(request({ range: 'bytes=10-12', 'if-range': ifRange }), runtime, recording, parts);
      assert.equal(response.status, status);
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), status === 206 ? VIDEO.slice(10, 13) : VIDEO);
      assert.equal(response.headers.get('content-range'), status === 206 ? 'bytes 10-12/23' : null);
    });
  }
});

test('incomplete, unordered or inconsistent manifests fail before any storage access', async t => {
  const cases: [string, (recording: RecordingRow, parts: RecordingPart[]) => void][] = [
    ['missing part', (_, parts) => { parts.pop(); }],
    ['unordered parts', (_, parts) => { [parts[0], parts[1]] = [parts[1], parts[0]]; }],
    ['repeated index', (_, parts) => { parts[1].index = 0; }],
    ['noncontiguous index', (_, parts) => { parts[1].index = 3; }],
    ['foreign recording', (_, parts) => { parts[1].recordingId = 'another-recording'; }],
    ['duplicate key', (_, parts) => { parts[1].objectKey = parts[0].objectKey; }],
    ['empty key', (_, parts) => { parts[0].objectKey = ''; }],
    ['pending part', (_, parts) => { parts[1].uploadState = 'pending'; }],
    ['missing transfer receipt', (_, parts) => { parts[1].transferId = null; }],
    ['empty transfer receipt', (_, parts) => { parts[1].transferId = ''; }],
    ['missing digest', (_, parts) => { parts[1].uploadSha256 = null; }],
    ['short digest', (_, parts) => { parts[1].uploadSha256 = 'a'.repeat(63); }],
    ['uppercase digest', (_, parts) => { parts[1].uploadSha256 = 'A'.repeat(64); }],
    ['nonhex digest', (_, parts) => { parts[1].uploadSha256 = 'z'.repeat(64); }],
    ['incorrect part size', (_, parts) => { parts[1].sizeBytes--; }],
    ['incorrect last part size', (_, parts) => { parts[2].sizeBytes++; }],
    ['wrong total', recording => { recording.sizeBytes++; }],
    ['wrong part count', recording => { recording.partCount = 4; }],
    ['missing part count', recording => { delete recording.partCount; }],
    ['invalid chunk size', recording => { recording.chunkSizeBytes = 0; }],
    ['fractional chunk size', recording => { recording.chunkSizeBytes = 8.5; }],
    ['single-object mode', recording => { recording.storageMode = 'single'; }],
    ['pending recording', recording => { recording.uploadState = 'pending'; }],
  ];
  for (const [name, change] of cases) {
    await t.test(name, async () => {
      const { recording, parts } = manifest();
      const { runtime, state } = fakeRuntime();
      change(recording, parts);
      await assert.rejects(streamMultipartRecording(request(), runtime, recording, parts), safeStorageError('recording_manifest_invalid'));
      assert.deepEqual(state.signedReads, []);
      assert.deepEqual(state.requests, []);
    });
  }
});

test('a valid complete-part 200 response is accepted', async () => {
  const { recording, parts } = manifest();
  const { runtime } = fakeRuntime({ override({ bytes, headers }) {
    headers.delete('content-range');
    return new Response(bytes.slice().buffer, { status: 200, headers });
  } });
  const response = await streamMultipartRecording(request(), runtime, recording, parts);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), VIDEO);
});

test('partial reads reject upstream responses that ignore the requested range', async () => {
  const { recording, parts } = manifest();
  const { runtime } = fakeRuntime({ override({ headers }) {
    headers.delete('content-range'); headers.set('content-length', '8');
    return new Response(VIDEO.slice(0, 8).buffer, { status: 200, headers });
  } });
  await assert.rejects(streamMultipartRecording(request({ range: 'bytes=2-4' }), runtime, recording, parts), safeStorageError());
});

test('initial redirect and upstream header mismatches fail safely before returning a stream', async t => {
  const cases: [string, UpstreamOverride][] = [
    ['redirect', () => new Response(null, { status: 307, headers: { location: `https://storage.test/leak?signature=${SECRET}` } })],
    ['not found', () => new Response(SECRET, { status: 404 })],
    ['server error', () => new Response(SECRET, { status: 500 })],
    ['wrong interval', ({ bytes, headers }) => { headers.set('content-range', 'bytes 1-8/8'); return new Response(bytes.slice().buffer, { status: 206, headers }); }],
    ['wrong object size', ({ bytes, headers }) => { headers.set('content-range', 'bytes 0-7/9'); return new Response(bytes.slice().buffer, { status: 206, headers }); }],
    ['missing range', ({ bytes, headers }) => { headers.delete('content-range'); return new Response(bytes.slice().buffer, { status: 206, headers }); }],
    ['wrong length', ({ bytes, headers }) => { headers.set('content-length', '7'); return new Response(bytes.slice().buffer, { status: 206, headers }); }],
    ['missing length', ({ bytes, headers }) => { headers.delete('content-length'); return new Response(bytes.slice().buffer, { status: 206, headers }); }],
    ['unexpected encoding', ({ bytes, headers }) => { headers.set('content-encoding', 'gzip'); return new Response(bytes.slice().buffer, { status: 206, headers }); }],
    ['fetch rejects', () => { throw new Error(`Failed signed fetch https://storage.test/?signature=${SECRET}`); }],
  ];
  for (const [name, override] of cases) {
    await t.test(name, async () => {
      const { recording, parts } = manifest();
      const { runtime, state } = fakeRuntime({ override });
      await assert.rejects(streamMultipartRecording(request(), runtime, recording, parts), safeStorageError());
      assert.equal(state.requests.length, 1);
    });
  }
});

test('signing errors cannot expose gateway exception details', async () => {
  const { recording, parts } = manifest();
  const { runtime, state } = fakeRuntime();
  runtime.storage = { ...runtime.storage, async createSignedRead() { throw new Error(`Gateway denied ${SECRET}`); } };
  await assert.rejects(streamMultipartRecording(request(), runtime, recording, parts), safeStorageError());
  assert.deepEqual(state.requests, []);
});

test('playback opens one part and waits for downstream demand before reading or opening more', async () => {
  const { recording, parts } = manifest();
  const { runtime, state } = fakeRuntime();
  const response = await streamMultipartRecording(request(), runtime, recording, parts);
  assert.equal(state.requests.length, 1);
  assert.deepEqual(state.pulls, [], 'Constructing a response must not read the part body.');
  const reader = response.body!.getReader();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(state.pulls, [], 'Acquiring a reader without reading must preserve backpressure.');
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.deepEqual(first.value, VIDEO.slice(0, 8));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(state.requests.length, 1, 'Do not prefetch the next part while the consumer pauses.');
  assert.deepEqual(state.pulls, [0]);
  const second = await reader.read();
  assert.equal(second.done, false);
  assert.deepEqual(second.value, VIDEO.slice(8, 16));
  assert.equal(state.requests.length, 2);
  assert.equal(state.signedReads.length, 2);
  await reader.cancel();
  assert.equal(state.requests.length, 2, 'Cancellation must prevent opening the remaining part.');
  assert.deepEqual(state.cancellations, [1]);
});

test('cancelling a response before the first read cancels its initial upstream body', async () => {
  const { recording, parts } = manifest();
  const { runtime, state } = fakeRuntime();
  const response = await streamMultipartRecording(request(), runtime, recording, parts);
  await response.body!.cancel();
  assert.deepEqual(state.pulls, []);
  assert.deepEqual(state.cancellations, [0]);
  assert.equal(state.requests.length, 1);
});

test('aborting the client request stops its active stream without opening subsequent parts', async () => {
  const { recording, parts } = manifest();
  const { runtime, state } = fakeRuntime();
  const abort = new AbortController();
  const response = await streamMultipartRecording(new Request(request(), { signal: abort.signal }), runtime, recording, parts);
  const reader = response.body!.getReader();
  assert.deepEqual((await reader.read()).value, VIDEO.slice(0, 8));
  abort.abort(new Error(`Sensitive client details ${SECRET}`));
  await assert.rejects(reader.read(), (error: unknown) => {
    assert(error instanceof RecordingStorageError);
    assert.equal(error.code, 'video_request_cancelled');
    assert(!error.message.includes(SECRET));
    return true;
  });
  assert.deepEqual(state.cancellations, [0]);
  assert.equal(state.requests.length, 1);
});

test('an already aborted client request does not obtain a storage capability', async () => {
  const { recording, parts } = manifest();
  const { runtime, state } = fakeRuntime();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(streamMultipartRecording(new Request(request(), { signal: abort.signal }), runtime, recording, parts), (error: unknown) => {
    assert(error instanceof RecordingStorageError);
    assert.equal(error.code, 'video_request_cancelled');
    return true;
  });
  assert.deepEqual(state.signedReads, []);
  assert.deepEqual(state.requests, []);
});

test('an in-flight stream uses its validated manifest snapshot', async () => {
  const { recording, parts } = manifest();
  const { runtime, state } = fakeRuntime();
  const response = await streamMultipartRecording(request(), runtime, recording, parts);
  parts[1].objectKey = 'changed-after-validation';
  parts[2].sizeBytes = 1;
  recording.sizeBytes = 1;
  parts.reverse();
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), VIDEO);
  assert.deepEqual(state.requests.map(item => item.index), [0, 1, 2]);
});

test('actual short or oversized part bodies fail the stream instead of corrupting video bytes', async t => {
  for (const size of [7, 9]) {
    await t.test(`${size} bytes advertised as 8`, async () => {
      const { recording, parts } = manifest();
      const { runtime, state } = fakeRuntime({ override({ index, headers }) {
        if (index !== 0) return undefined;
        return new Response(new Uint8Array(size), { status: 206, headers });
      } });
      const response = await streamMultipartRecording(request(), runtime, recording, parts);
      await assert.rejects(response.arrayBuffer(), safeStorageError());
      assert.equal(state.requests.length, 1, 'A corrupt part must stop subsequent part downloads.');
    });
  }
});

test('later part failure rejects consumption safely and never opens following parts', async () => {
  const { recording, parts } = manifest();
  const { runtime, state } = fakeRuntime({ override({ index }) {
    if (index === 1) return new Response(SECRET, { status: 503 });
    return undefined;
  } });
  const response = await streamMultipartRecording(request(), runtime, recording, parts);
  assert.equal(response.status, 200);
  await assert.rejects(response.arrayBuffer(), safeStorageError());
  assert.equal(state.requests.length, 2);
});
