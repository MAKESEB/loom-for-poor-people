import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createR2StorageRuntime, TRANSFER_IDLE_TTL_MS } from '../src/server/r2-storage';
import { streamMultipartRecording } from '../src/server/recording-storage';
import { fixedLengthBody, type StorageCapability } from '../src/server/storage';
import type { RecordingPart, RecordingRow } from '../src/server/types';
import { createMemoryR2, type MemoryR2, type MemoryR2Options } from './helpers/memory-r2';

const KEY = 'recordings/example/video.webm';
const BYTES = Uint8Array.from([26, 69, 223, 163, 1, 2, 3, 4]);
const START = Date.parse('2026-09-25T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;
/** Transfer IDs are the hex SHA-256 of their idempotency key. */
const transferIdOf = (idempotencyKey: string) => createHash('sha256').update(idempotencyKey).digest('hex');
const FIRST_TRANSFER = transferIdOf('video:upload-1');

function setup(options: MemoryR2Options = {}, wrap: (bucket: MemoryR2) => MemoryR2 = bucket => bucket) {
  const bucket = wrap(createMemoryR2(options));
  const clock = { now: START };
  let sequence = 0;
  const runtime = createR2StorageRuntime(bucket, { now: () => clock.now, randomUUID: () => `transfer-${++sequence}` });
  return { bucket, clock, runtime, ...runtime };
}

type Setup = ReturnType<typeof setup>;

function input(overrides: Partial<{ idempotencyKey: string; objectKey: string; contentType: string; contentLength: number }> = {}) {
  return { idempotencyKey: 'video:upload-1', objectKey: KEY, contentType: 'video/webm', contentLength: BYTES.length, ...overrides };
}

async function reserveReady(context: Setup, overrides: Parameters<typeof input>[0] = {}) {
  const reservation = await context.storage.reserveUpload(input(overrides));
  assert.equal(reservation.state, 'ready');
  if (reservation.state !== 'ready') throw new Error('Missing upload capability');
  return reservation;
}

function putRequest(capability: StorageCapability, body: BodyInit | null) {
  return new Request(capability.url, { method: 'PUT', headers: capability.requiredHeaders, body, duplex: 'half' } as RequestInit);
}

async function stored(context: Setup, bytes: Uint8Array = BYTES, key = KEY) {
  const reservation = await reserveReady(context, { objectKey: key, contentLength: bytes.length, idempotencyKey: `video:${key.replaceAll('/', '-')}` });
  const response = await context.capabilityFetch(putRequest(reservation.capability, bytes.slice()));
  assert.equal(response.status, 200);
  return context.storage.createSignedRead(key);
}

function streamOf(bytes: Uint8Array, chunkBytes = 3) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + chunkBytes));
      offset += chunkBytes;
    },
  });
}

async function body(response: Response) { return [...new Uint8Array(await response.arrayBuffer())]; }

const withCode = (code: string, status?: number) => (error: unknown) => {
  assert(error instanceof Error);
  assert.equal((error as Error & { code?: unknown }).code, code);
  if (status !== undefined) assert.equal((error as Error & { status?: unknown }).status, status);
  return true;
};

test('reservations are idempotent, expose a one-hour PUT capability and reject conflicting input', async () => {
  const context = setup();
  const first = await reserveReady(context);
  assert.equal(first.transferId, FIRST_TRANSFER);
  assert.equal(first.capability.operation, 'PUT');
  assert.equal(first.capability.objectKey, KEY);
  assert.equal(first.capability.expectedContentLength, BYTES.length);
  assert.deepEqual({ ...first.capability.requiredHeaders }, { 'content-type': 'video/webm' });
  assert.equal(first.capability.expiresAt, new Date(START + HOUR).toISOString());
  assert.match(first.capability.url, /^https:\/\/r2-capability\.invalid\/[A-Za-z0-9_-]+$/);

  context.clock.now += 1000;
  const replay = await reserveReady(context);
  assert.equal(replay.transferId, first.transferId, 'the same idempotency key resolves to the same transfer');
  assert.equal(replay.capability.expiresAt, new Date(START + 1000 + HOUR).toISOString(), 'a replay receives a fresh capability');

  for (const conflicting of [{ contentLength: 9 }, { contentType: 'video/mp4' }, { objectKey: 'recordings/other/video.webm' }]) {
    await assert.rejects(context.storage.reserveUpload(input(conflicting)), withCode('storage_conflict'));
  }
  await assert.rejects(context.storage.reserveUpload(input({ idempotencyKey: 'bad key/../x' })), /Invalid idempotency key/);
  for (const objectKey of [`_meta/transfers/${FIRST_TRANSFER}.json`, 'recordings/../secret', './video', '/absolute', 'with space']) {
    await assert.rejects(context.storage.reserveUpload(input({ objectKey, idempotencyKey: 'video:other' })), /Invalid object key/);
  }
  await assert.rejects(context.storage.reserveUpload(input({ contentLength: -1, idempotencyKey: 'video:negative' })), /Invalid content length/);

  assert(context.bucket.objects.has(`_meta/transfers/${FIRST_TRANSFER}.json`));
  assert(context.bucket.objects.has('_meta/requests/video:upload-1.json'));
  assert(!context.bucket.objects.has(KEY), 'a reservation never creates the object');
});

test('a PUT stores exactly the reserved bytes with their content type and completes the transfer', async () => {
  const context = setup();
  const reservation = await reserveReady(context);
  assert.deepEqual(await context.storage.completeUpload(reservation.transferId), { state: 'pending', transferId: reservation.transferId });

  const response = await context.capabilityFetch(putRequest(reservation.capability, streamOf(BYTES)));
  assert.equal(response.status, 200);
  const object = context.bucket.objects.get(KEY);
  assert(object);
  assert.deepEqual([...object.bytes], [...BYTES]);
  assert.equal(object.httpMetadata?.contentType, 'video/webm');

  assert.deepEqual(await context.storage.completeUpload(reservation.transferId), { state: 'completed', transferId: reservation.transferId });
  assert.deepEqual(await context.storage.reserveUpload(input()), { state: 'completed', transferId: reservation.transferId });
  await assert.rejects(context.storage.completeUpload('transfer-unknown'), withCode('storage_transfer_not_found', 404));
});

test('over- and under-length PUTs are rejected without writing an object', async () => {
  const context = setup();
  const reservation = await reserveReady(context);
  for (const bytes of [BYTES.slice(0, 5), Uint8Array.from([...BYTES, 9]), new Uint8Array(0)]) {
    const response = await context.capabilityFetch(putRequest(reservation.capability, bytes));
    assert.equal(response.status, 400);
    assert.equal(await response.text(), 'Upload length mismatch');
    assert(!context.bucket.objects.has(KEY));
    assert.equal((await context.storage.completeUpload(reservation.transferId)).state, 'pending');
    await assert.rejects(context.storage.createSignedRead(KEY), withCode('storage_object_not_found', 404));
  }
  const noBody = await context.capabilityFetch(new Request(reservation.capability.url, { method: 'PUT' }));
  assert.equal(noBody.status, 400);
  assert(!context.bucket.operations.some(operation => operation.method === 'put' && operation.key === KEY), 'no object write was attempted');

  const retried = await context.capabilityFetch(putRequest(reservation.capability, BYTES.slice()));
  assert.equal(retried.status, 200, 'a rejected attempt leaves the transfer open for a correct retry');
});

test('a short upload stream returns 400, a failed put after every byte returns 502, and both leave the transfer incomplete', async () => {
  let failPuts = 1;
  const context = setup({ beforePut(key) { if (key === KEY && failPuts-- > 0) throw new Error('R2 unavailable'); } });
  const reservation = await reserveReady(context);

  const erroring = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(BYTES.slice(0, 4)); controller.error(new Error('client went away')); },
  });
  assert.equal((await context.capabilityFetch(putRequest(reservation.capability, erroring))).status, 400, 'a short body certainly did not commit');
  // Every byte reached R2 and the put failed without a visible object: the outcome is unknown, not "rejected".
  assert.equal((await context.capabilityFetch(putRequest(reservation.capability, BYTES.slice()))).status, 502);
  assert(!context.bucket.objects.has(KEY));
  assert.equal((await context.storage.completeUpload(reservation.transferId)).state, 'pending');

  assert.equal((await context.capabilityFetch(putRequest(reservation.capability, BYTES.slice()))).status, 200);
  assert.equal((await context.storage.completeUpload(reservation.transferId)).state, 'completed');
});

test('a put that rejects after its object committed still reports the commit', async () => {
  let loseResponse = true;
  const context = setup({}, bucket => ({
    ...bucket,
    async put(key, value, options) {
      const stored = await bucket.put(key, value, options);
      if (key === KEY && loseResponse) { loseResponse = false; throw new Error('R2 response lost after commit'); }
      return stored;
    },
  }));
  const reservation = await reserveReady(context);
  assert.equal((await context.capabilityFetch(putRequest(reservation.capability, BYTES.slice()))).status, 200, 'the object marker proves the commit');
  assert.equal(loseResponse, false);
  assert.equal((await context.storage.completeUpload(reservation.transferId)).state, 'completed');
});

test('a PUT after completion is refused with 409 and keeps the original bytes', async () => {
  const context = setup();
  const reservation = await reserveReady(context);
  assert.equal((await context.capabilityFetch(putRequest(reservation.capability, BYTES.slice()))).status, 200);
  const again = await context.capabilityFetch(putRequest(reservation.capability, new Uint8Array(BYTES.length)));
  assert.equal(again.status, 409);
  assert.deepEqual([...context.bucket.objects.get(KEY)!.bytes], [...BYTES]);
});

test('a committed object reconciles a transfer record whose completion update was lost', async () => {
  let failRecord = true;
  const context = setup({
    beforePut(key) { if (key === `_meta/transfers/${FIRST_TRANSFER}.json` && failRecord && context.bucket.objects.has(KEY)) { failRecord = false; throw new Error('record write lost'); } },
  });
  const reservation = await reserveReady(context);
  assert.equal((await context.capabilityFetch(putRequest(reservation.capability, BYTES.slice()))).status, 200);
  assert.equal(failRecord, false, 'the record update failed after the object committed');
  assert.deepEqual(await context.storage.reserveUpload(input()), { state: 'completed', transferId: reservation.transferId });
  assert.equal((await context.storage.completeUpload(reservation.transferId)).state, 'completed');
  assert.equal((await context.capabilityFetch(putRequest(reservation.capability, BYTES.slice()))).status, 409);
});

test('Workers streams the PUT body through FixedLengthStream into R2, including api.ts fixed-length bodies', async () => {
  const scope = globalThis as typeof globalThis & { FixedLengthStream?: new (length: number) => TransformStream<Uint8Array, Uint8Array> };
  const original = scope.FixedLengthStream;
  // Models workerd: FixedLengthStream is a native TransformStream, and piping one
  // native TransformStream's readable into another is not implemented there.
  const nativeReadables = new WeakSet<ReadableStream>();
  class FakeFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
    constructor(length: number) {
      let seen = 0;
      super({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > length) throw new TypeError('Stream exceeded declared length');
          controller.enqueue(chunk);
        },
        flush() { if (seen !== length) throw new TypeError('Stream ended before declared length'); },
      });
      nativeReadables.add(this.readable);
    }
  }
  type PipeThrough = (this: ReadableStream, transform: ReadableWritablePair<unknown, unknown>, options?: StreamPipeOptions) => ReadableStream;
  const prototype = ReadableStream.prototype as unknown as { pipeThrough: PipeThrough };
  const originalPipeThrough = prototype.pipeThrough;
  prototype.pipeThrough = function (transform, options) {
    if (nativeReadables.has(this) && transform instanceof FakeFixedLengthStream) throw new TypeError('Inter-TransformStream ReadableStream.pipeTo() is not implemented.');
    return originalPipeThrough.call(this, transform, options);
  };
  scope.FixedLengthStream = FakeFixedLengthStream;
  try {
    const context = setup();
    const reservation = await reserveReady(context);
    for (const bytes of [BYTES.slice(0, 7), Uint8Array.from([...BYTES, 0])]) {
      assert.equal((await context.capabilityFetch(putRequest(reservation.capability, streamOf(bytes)))).status, 400);
      assert(!context.bucket.objects.has(KEY));
    }
    // api.ts forwards uploads as fixedLengthBody(body, size), i.e. already a FixedLengthStream readable.
    assert.equal((await context.capabilityFetch(putRequest(reservation.capability, fixedLengthBody(streamOf(BYTES), BYTES.length)))).status, 200);
    const puts = context.bucket.operations.filter(operation => operation.method === 'put' && operation.key === KEY);
    assert.equal(puts.length, 3);
    assert(puts.every(operation => operation.streamed), 'the body is streamed rather than buffered');
    assert.deepEqual([...context.bucket.objects.get(KEY)!.bytes], [...BYTES]);
    assert.equal((await context.storage.completeUpload(reservation.transferId)).state, 'completed');

    const read = await context.storage.createSignedRead(KEY);
    const ranged = await context.capabilityFetch(new Request(read.url, { headers: { range: 'bytes=2-4' } }));
    assert.equal(ranged.status, 206);
    assert.deepEqual(await body(ranged), [223, 163, 1]);

    // An abort errors the known-length pipe too, so R2 rejects the put without committing.
    const otherKey = 'recordings/aborted/video.webm';
    const other = await reserveReady(context, { idempotencyKey: 'video:aborted', objectKey: otherKey });
    const controller = new AbortController();
    let stalled!: () => void;
    const reachedStall = new Promise<void>(resolve => { stalled = resolve; });
    const attempt = context.capabilityFetch(new Request(other.capability.url, {
      method: 'PUT', headers: other.capability.requiredHeaders, duplex: 'half', signal: controller.signal,
      body: fixedLengthBody(controlledStream(BYTES, async index => { if (index === 5) { stalled(); await never(); } }), BYTES.length),
    } as RequestInit));
    await reachedStall;
    controller.abort();
    await assert.rejects(attempt, (error: unknown) => (error as { name?: unknown }).name === 'AbortError');
    assert(!context.bucket.objects.has(otherKey));
  } finally {
    prototype.pipeThrough = originalPipeThrough;
    if (original) scope.FixedLengthStream = original;
    else delete scope.FixedLengthStream;
  }
});

test('createSignedRead requires an existing object and returns a GET capability', async () => {
  const context = setup();
  await assert.rejects(context.storage.createSignedRead(KEY), withCode('storage_object_not_found', 404));
  await assert.rejects(context.storage.createSignedRead('../escape'), withCode('storage_object_not_found', 404));
  const read = await stored(context);
  assert.equal(read.operation, 'GET');
  assert.equal(read.objectKey, KEY);
  assert.equal(read.expectedContentLength, null);
  assert.deepEqual({ ...read.requiredHeaders }, {});
  assert.equal(read.expiresAt, new Date(START + HOUR).toISOString());
});

test('a GET returns the full object with exact headers', async () => {
  const context = setup();
  const read = await stored(context);
  const response = await context.capabilityFetch(new Request(read.url, { headers: read.requiredHeaders, redirect: 'manual' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(BYTES.length));
  assert.equal(response.headers.get('content-type'), 'video/webm');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('content-range'), null);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.deepEqual(await body(response), [...BYTES]);
});

test('ranged GETs return 206 with exact Content-Range and length', async () => {
  const context = setup();
  const read = await stored(context);
  const cases: [string, string, number[]][] = [
    ['bytes=4-6', 'bytes 4-6/8', [1, 2, 3]],
    ['bytes=5-', 'bytes 5-7/8', [2, 3, 4]],
    ['bytes=6-100', 'bytes 6-7/8', [3, 4]],
    ['bytes=0-0', 'bytes 0-0/8', [26]],
  ];
  for (const [range, contentRange, expected] of cases) {
    const response = await context.capabilityFetch(new Request(read.url, { headers: { range } }));
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('content-range'), contentRange);
    assert.equal(response.headers.get('content-length'), String(expected.length));
    assert.deepEqual(await body(response), expected);
  }
  const lastGet = context.bucket.operations.filter(operation => operation.method === 'get' && operation.key === KEY).at(-1);
  assert.deepEqual(lastGet?.range, { offset: 0, length: 1 }, 'only the requested bytes are read from R2');
});

test('a Range guarded by If-Range returns the full object, because no validator can match', async () => {
  const context = setup();
  const read = await stored(context);
  for (const ifRange of ['"some-etag"', 'Wed, 21 Oct 2015 07:28:00 GMT']) {
    const response = await context.capabilityFetch(new Request(read.url, { headers: { range: 'bytes=2-4', 'if-range': ifRange } }));
    assert.equal(response.status, 200, ifRange);
    assert.equal(response.headers.get('content-range'), null);
    assert.equal(response.headers.get('content-length'), String(BYTES.length));
    assert.deepEqual(await body(response), [...BYTES]);
  }
});

test('suffix ranges return the final bytes and clamp to the object size', async () => {
  const context = setup();
  const read = await stored(context);
  const tail = await context.capabilityFetch(new Request(read.url, { headers: { range: 'bytes=-3' } }));
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get('content-range'), 'bytes 5-7/8');
  assert.equal(tail.headers.get('content-length'), '3');
  assert.deepEqual(await body(tail), [2, 3, 4]);
  const whole = await context.capabilityFetch(new Request(read.url, { headers: { range: 'bytes=-50' } }));
  assert.equal(whole.status, 206);
  assert.equal(whole.headers.get('content-range'), 'bytes 0-7/8');
  assert.deepEqual(await body(whole), [...BYTES]);
});

test('malformed or unsatisfiable ranges return 416 with the object size', async () => {
  const context = setup();
  const read = await stored(context);
  for (const range of ['bytes=100-', 'bytes=8-9', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'items=0-1', 'bytes=0-1,3-4', 'bytes=a-b']) {
    const response = await context.capabilityFetch(new Request(read.url, { headers: { range } }));
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), 'bytes */8');
    assert.equal(response.body, null);
  }
});

test('HEAD is allowed with a GET capability and returns headers without a body', async () => {
  const context = setup();
  const read = await stored(context);
  const head = await context.capabilityFetch(new Request(read.url, { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '8');
  assert.equal(head.headers.get('content-type'), 'video/webm');
  assert.equal(head.body, null);
  const rangedHead = await context.capabilityFetch(new Request(read.url, { method: 'HEAD', headers: { range: 'bytes=2-3' } }));
  assert.equal(rangedHead.status, 206);
  assert.equal(rangedHead.headers.get('content-range'), 'bytes 2-3/8');
  assert.equal(rangedHead.headers.get('content-length'), '2');
  assert.equal(rangedHead.body, null);
  assert(!context.bucket.operations.some(operation => operation.method === 'get' && operation.key === KEY), 'HEAD never reads the object body');
});

test('empty objects, missing metadata and deleted objects are handled like managed storage', async () => {
  const context = setup();
  const read = await stored(context, new Uint8Array(0), 'recordings/empty/video');
  const empty = await context.capabilityFetch(new Request(read.url));
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('content-length'), '0');
  assert.equal(empty.body, null);

  await context.bucket.put('recordings/untyped/video', BYTES.slice());
  const untyped = await context.storage.createSignedRead('recordings/untyped/video');
  assert.equal((await context.capabilityFetch(new Request(untyped.url))).headers.get('content-type'), 'application/octet-stream');

  await context.bucket.delete('recordings/untyped/video');
  assert.equal((await context.capabilityFetch(new Request(untyped.url))).status, 404);
});

test('expired, foreign, malformed and tampered capabilities return 404', async () => {
  const context = setup();
  const read = await stored(context);
  const token = new URL(read.url).pathname.slice(1);
  const forged = (grant: unknown) => `https://r2-capability.invalid/${btoa(JSON.stringify(grant)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  for (const url of [
    `https://storage.example/${token}`,
    `http://r2-capability.invalid/${token}`,
    `https://r2-capability.invalid:8443/${token}`,
    `https://r2-capability.invalid/${token}?extra=1`,
    `https://r2-capability.invalid/nested/${token}`,
    'https://r2-capability.invalid/',
    'https://r2-capability.invalid/not-base64!',
    'https://r2-capability.invalid/bm90LWpzb24',
    forged({ v: 2, op: 'GET', key: KEY, exp: START + HOUR }),
    forged({ v: 1, op: 'GET', key: '../escape', exp: START + HOUR }),
    forged({ v: 1, op: 'DELETE', key: KEY, exp: START + HOUR }),
    forged({ v: 1, op: 'PUT', key: KEY, exp: START + HOUR }),
  ]) {
    const response = await context.capabilityFetch(new Request(url));
    assert.equal(response.status, 404, url);
  }
  context.clock.now = START + HOUR;
  assert.equal((await context.capabilityFetch(new Request(read.url))).status, 200, 'a capability is valid until its expiry');
  context.clock.now = START + HOUR + 1;
  const expired = await context.capabilityFetch(new Request(read.url));
  assert.equal(expired.status, 404);
  assert.equal(await expired.text(), 'Expired file access');
});

test('a capability only permits its granted method', async () => {
  const context = setup();
  const reservation = await reserveReady(context);
  for (const method of ['GET', 'HEAD', 'POST', 'DELETE']) {
    assert.equal((await context.capabilityFetch(new Request(reservation.capability.url, { method }))).status, 405, `PUT capability with ${method}`);
  }
  assert.equal((await context.capabilityFetch(putRequest(reservation.capability, BYTES.slice()))).status, 200);
  const read = await context.storage.createSignedRead(KEY);
  for (const method of ['PUT', 'POST', 'DELETE']) {
    const init: RequestInit = method === 'PUT' || method === 'POST' ? { method, body: BYTES.slice() } : { method };
    assert.equal((await context.capabilityFetch(new Request(read.url, init))).status, 405, `GET capability with ${method}`);
  }
  assert.deepEqual([...context.bucket.objects.get(KEY)!.bytes], [...BYTES]);
});

test('upload() stores a complete object that can be read back', async () => {
  const context = setup();
  const result = await context.storage.upload({ idempotencyKey: 'direct:1', objectKey: 'recordings/direct/video', contentType: 'video/mp4', bytes: BYTES.slice() });
  assert.equal(result.state, 'completed');
  assert.deepEqual(await context.storage.completeUpload(result.transferId), { state: 'completed', transferId: result.transferId });
  const read = await context.storage.createSignedRead('recordings/direct/video');
  const response = await context.capabilityFetch(new Request(read.url));
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(await body(response), [...BYTES]);
  await assert.rejects(context.storage.upload({ idempotencyKey: 'direct:2', objectKey: '../x', contentType: 'video/mp4', bytes: BYTES }), /Invalid object key/);
});

test('deleteObject removes the object and is idempotent', async () => {
  const context = setup();
  await stored(context);
  assert.deepEqual(await context.storage.deleteObject({ idempotencyKey: 'delete:1', objectKey: KEY }), { state: 'completed', deletionId: 'delete:1' });
  assert(!context.bucket.objects.has(KEY));
  await assert.rejects(context.storage.createSignedRead(KEY), withCode('storage_object_not_found', 404));
  assert.deepEqual(await context.storage.deleteObject({ idempotencyKey: 'delete:1', objectKey: KEY }), { state: 'completed', deletionId: 'delete:1' });
  await assert.rejects(context.storage.deleteObject({ idempotencyKey: 'delete:2', objectKey: '../x' }), /Invalid object key/);
});

test('streamMultipartRecording reads a two-part recording through the R2 runtime', async () => {
  const id = 'e578d489-bf37-48b7-905b-0d0df541a7a6';
  const video = Uint8Array.from({ length: 13 }, (_, index) => (index * 37 + 19) % 256);
  const chunkSize = 8;
  const context = setup({ chunkBytes: 3 });
  const parts: RecordingPart[] = [];
  for (let index = 0; index < 2; index++) {
    const bytes = video.slice(index * chunkSize, (index + 1) * chunkSize);
    const objectKey = `recordings/${id}/parts/${index}`;
    const reservation = await reserveReady(context, { idempotencyKey: `video:${id}:part:${index}`, objectKey, contentLength: bytes.length });
    assert.equal((await context.capabilityFetch(putRequest(reservation.capability, bytes))).status, 200);
    assert.equal((await context.storage.completeUpload(reservation.transferId)).state, 'completed');
    parts.push({
      recordingId: id, index, objectKey, sizeBytes: bytes.length, transferId: reservation.transferId,
      uploadSha256: createHash('sha256').update(bytes).digest('hex'), uploadAttempted: true, uploadState: 'ready', leaseVersion: 1,
    });
  }
  const recording: RecordingRow = {
    id, requestId: id, uploadId: id, title: 'Multipart recording', contentType: 'video/webm', sizeBytes: video.length,
    durationSeconds: 2, createdAt: '2026-09-25T10:00:00.000Z', objectKey: `recordings/${id}/video.webm`,
    transferId: null, uploadSha256: null, uploadAttempted: true, uploadState: 'ready', protected: false,
    markdownEnabled: false, storageMode: 'parts', chunkSizeBytes: chunkSize, partCount: 2,
  };
  const request = (headers: Record<string, string> = {}) => new Request(`https://app.test/api/recordings/${id}/video`, { headers });

  const full = await streamMultipartRecording(request(), context.runtime, recording, parts);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-length'), '13');
  assert.deepEqual(await body(full), [...video]);

  const crossing = await streamMultipartRecording(request({ range: 'bytes=5-10' }), context.runtime, recording, parts);
  assert.equal(crossing.status, 206);
  assert.equal(crossing.headers.get('content-range'), 'bytes 5-10/13');
  assert.deepEqual(await body(crossing), [...video.slice(5, 11)]);

  const tail = await streamMultipartRecording(request({ range: 'bytes=-2' }), context.runtime, recording, parts);
  assert.equal(tail.status, 206);
  assert.deepEqual(await body(tail), [...video.slice(11)]);
});

function transferRecord(context: Setup, transferId: string): { completed: boolean; createdAt?: number; activeAt?: number } {
  const object = context.bucket.objects.get(`_meta/transfers/${transferId}.json`);
  assert(object, 'the transfer record exists');
  return JSON.parse(new TextDecoder().decode(object.bytes)) as { completed: boolean; createdAt?: number; activeAt?: number };
}

/** Delivers `bytes` one at a time; `beforeChunk` runs before each (e.g. to move the clock) and may stall the stream. */
function controlledStream(bytes: Uint8Array, beforeChunk: (index: number) => void | Promise<void>, onCancel?: () => void) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= bytes.length) { controller.close(); return; }
      await beforeChunk(index);
      controller.enqueue(bytes.slice(index, index + 1));
      index += 1;
    },
    cancel() { onCancel?.(); },
  }, { highWaterMark: 0 });
}

const never = () => new Promise<void>(() => undefined);

test('a reservation whose upload never commits expires after an hour, and a replay never extends it', async () => {
  const context = setup();
  const reservation = await reserveReady(context);
  context.clock.now = START + HOUR;
  assert.equal((await context.storage.completeUpload(reservation.transferId)).state, 'pending', 'valid until its deadline');
  const replay = await reserveReady(context);
  assert.equal(replay.transferId, reservation.transferId);
  assert.equal(replay.capability.expiresAt, new Date(START + 2 * HOUR).toISOString(), 'the replayed capability outlives the transfer');
  context.clock.now = START + HOUR + 1;
  await assert.rejects(context.storage.completeUpload(reservation.transferId), withCode('storage_upload_expired', 409));
  await assert.rejects(context.storage.reserveUpload(input()), withCode('storage_upload_expired', 409));
  const fresh = await reserveReady(context, { idempotencyKey: 'video:upload-2', objectKey: 'recordings/other/video.webm' });
  const late = await context.capabilityFetch(putRequest(fresh.capability, BYTES.slice()));
  assert.equal(late.status, 200, 'a new reservation starts its own hour');

  // A still-valid capability of the expired transfer cannot commit it any more.
  const stale = await context.capabilityFetch(putRequest(replay.capability, BYTES.slice()));
  assert.equal(stale.status, 410);
  assert(!context.bucket.objects.has(KEY));
});

test('a committed transfer is never reported expired', async () => {
  const context = setup();
  const reservation = await reserveReady(context);
  assert.equal((await context.capabilityFetch(putRequest(reservation.capability, BYTES.slice()))).status, 200);
  context.clock.now = START + 10 * HOUR;
  assert.equal((await context.storage.completeUpload(reservation.transferId)).state, 'completed');
  assert.deepEqual(await context.storage.reserveUpload(input()), { state: 'completed', transferId: reservation.transferId });
});

test('an upload that stops making progress expires five minutes after its last sign of life and can no longer commit', async () => {
  const context = setup();
  const reservation = await reserveReady(context);
  let stall!: () => void;
  const stalled = new Promise<void>(resolve => { stall = resolve; });
  let resume!: () => void;
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  const attempt = context.capabilityFetch(putRequest(reservation.capability, controlledStream(BYTES, async index => {
    if (index === 4) { stall(); await resumed; }
  })));
  await stalled;
  assert.equal(transferRecord(context, reservation.transferId).activeAt, START, 'the attempt is recorded before any byte can commit');

  // Like an invocation cancelled mid-PUT: nothing will ever finish this attempt.
  context.clock.now = START + TRANSFER_IDLE_TTL_MS;
  assert.equal((await context.storage.completeUpload(reservation.transferId)).state, 'pending');
  context.clock.now = START + TRANSFER_IDLE_TTL_MS + 1;
  await assert.rejects(context.storage.completeUpload(reservation.transferId), withCode('storage_upload_expired', 409));
  await assert.rejects(context.storage.reserveUpload(input()), withCode('storage_upload_expired', 409));

  // If the stalled attempt wakes up after its expiry was reported, it must not commit.
  resume();
  assert.equal((await attempt).status, 410);
  assert(!context.bucket.objects.has(KEY));
  await assert.rejects(context.storage.completeUpload(reservation.transferId), withCode('storage_upload_expired', 409));
});

test('a slow upload that keeps sending bytes stays alive past the idle deadline through heartbeats', async () => {
  const context = setup();
  const reservation = await reserveReady(context);
  const step = 50 * 1000;
  let checkedMidway = false;
  const response = await context.capabilityFetch(putRequest(reservation.capability, controlledStream(BYTES, async index => {
    await new Promise(resolve => setTimeout(resolve, 0)); // lets the previous heartbeat write land
    context.clock.now += step;
    if (index === 7) {
      // START + 400 s: past START + TTL, but heartbeats keep the transfer alive.
      assert.equal((await context.storage.completeUpload(reservation.transferId)).state, 'pending');
      assert(transferRecord(context, reservation.transferId).activeAt! > START + 100 * 1000, 'heartbeats moved the last sign of life forward');
      checkedMidway = true;
    }
  })));
  assert(checkedMidway);
  assert.equal(context.clock.now - START, BYTES.length * step);
  assert(context.clock.now - START > TRANSFER_IDLE_TTL_MS);
  assert.equal(response.status, 200);
  assert.deepEqual([...context.bucket.objects.get(KEY)!.bytes], [...BYTES]);
  assert.equal((await context.storage.completeUpload(reservation.transferId)).state, 'completed');
});

test('a PUT honours its request signal: an abort stops the transfer promptly, cancels the body and stores nothing', async () => {
  const context = setup();
  const reservation = await reserveReady(context);
  const controller = new AbortController();
  let stalled!: () => void;
  const reachedStall = new Promise<void>(resolve => { stalled = resolve; });
  let cancelled = false;
  const body = controlledStream(BYTES, async index => { if (index === 4) { stalled(); await never(); } }, () => { cancelled = true; });
  const attempt = context.capabilityFetch(new Request(reservation.capability.url, {
    method: 'PUT', headers: reservation.capability.requiredHeaders, body, duplex: 'half', signal: controller.signal,
  } as RequestInit));
  await reachedStall;
  controller.abort();
  await assert.rejects(attempt, (error: unknown) => (error as { name?: unknown }).name === 'AbortError');
  assert.equal(cancelled, true, 'the source body is cancelled');
  assert(!context.bucket.objects.has(KEY));
  assert.equal(transferRecord(context, reservation.transferId).activeAt, START, 'the failed attempt counts as upload activity');
  assert.equal((await context.storage.completeUpload(reservation.transferId)).state, 'pending');

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(context.capabilityFetch(new Request(reservation.capability.url, {
    method: 'PUT', headers: reservation.capability.requiredHeaders, body: BYTES.slice(), signal: aborted.signal,
  })), (error: unknown) => (error as { name?: unknown }).name === 'AbortError');
  assert(!context.bucket.operations.some(operation => operation.method === 'put' && operation.key === KEY), 'no object write was attempted');

  context.clock.now = START + TRANSFER_IDLE_TTL_MS;
  assert.equal((await context.capabilityFetch(putRequest(reservation.capability, BYTES.slice()))).status, 200, 'the same reservation can be retried until it expires');
});

test('a failed attempt can be retried for five minutes after its last activity, then the transfer expires', async () => {
  const context = setup();
  const reservation = await reserveReady(context);
  assert.equal((await context.capabilityFetch(putRequest(reservation.capability, BYTES.slice(0, 5)))).status, 400);
  context.clock.now = START + TRANSFER_IDLE_TTL_MS + 1;
  await assert.rejects(context.storage.reserveUpload(input()), withCode('storage_upload_expired', 409));
  assert.equal((await context.capabilityFetch(putRequest(reservation.capability, BYTES.slice()))).status, 410);
  assert(!context.bucket.objects.has(KEY));
});

test('an unknown put outcome keeps the attempt open until it expires', async () => {
  let failPuts = 1;
  const context = setup({ beforePut(key) { if (key === KEY && failPuts-- > 0) throw new Error('R2 unavailable'); } });
  const reservation = await reserveReady(context);
  assert.equal((await context.capabilityFetch(putRequest(reservation.capability, BYTES.slice()))).status, 502);
  assert.equal(transferRecord(context, reservation.transferId).activeAt, START, 'the uncertain attempt stays on record');
  context.clock.now = START + TRANSFER_IDLE_TTL_MS + 1;
  await assert.rejects(context.storage.completeUpload(reservation.transferId), withCode('storage_upload_expired', 409));
});

test('concurrent first reservations of one idempotency key converge on one transfer', async () => {
  const context = setup();
  const reservations = await Promise.all([1, 2, 3].map(() => reserveReady(context)));
  assert.deepEqual(new Set(reservations.map(reservation => reservation.transferId)), new Set([FIRST_TRANSFER]));
  assert.equal((await reserveReady(context)).transferId, FIRST_TRANSFER);
  assert.equal((await context.capabilityFetch(putRequest(reservations[1].capability, BYTES.slice()))).status, 200);
  assert.deepEqual(await context.storage.reserveUpload(input()), { state: 'completed', transferId: FIRST_TRANSFER });
});

test('records written before transfers expired stay valid and never expire', async () => {
  const context = setup();
  const legacyId = 'transfer-legacy';
  await context.bucket.put(`_meta/transfers/${legacyId}.json`, JSON.stringify({ key: KEY, contentType: 'video/webm', size: BYTES.length, completed: false }));
  await context.bucket.put('_meta/requests/video:legacy.json', JSON.stringify({ transferId: legacyId, input: input({ idempotencyKey: 'video:legacy' }) }));
  context.clock.now = START + 100 * HOUR;
  const replay = await reserveReady(context, { idempotencyKey: 'video:legacy' });
  assert.equal(replay.transferId, legacyId, 'an existing receipt keeps its random transfer ID');
  assert.equal((await context.storage.completeUpload(legacyId)).state, 'pending');
  await context.bucket.put(`_meta/transfers/${legacyId}.json`, JSON.stringify({ key: KEY, contentType: 'video/webm', size: BYTES.length, completed: false, activeAt: 'soon' }));
  await assert.rejects(context.storage.completeUpload(legacyId), /Corrupt transfer record/);
});
