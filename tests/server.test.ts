import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiHandler, MAX_DURATION_SECONDS, MAX_VIDEO_BYTES } from '../src/server/api';
import { resolveStorageRuntime, StorageUnavailableError, storageBindingDiagnostics, type ManagedStorage, type StorageRuntime } from '../src/server/storage';

const ORIGIN = 'https://app.test';
const REQUEST_ID = '2d4c015b-f26f-4f65-91c6-d7126db1aa42';
const OTHER_ID = 'ba9566c4-1fca-4a39-b075-9a142d191b4e';
const VIDEO = new TextEncoder().encode('real video bytes for transfer verification');
const DETAILS = { id: REQUEST_ID, title: 'A quick walkthrough', sizeBytes: VIDEO.length, durationSeconds: 12.5, contentType: 'video/webm' };

interface Transfer { objectKey: string; contentType: string; contentLength: number; completed: boolean }

function fakeRuntime() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const transfers = new Map<string, Transfer>();
  const reservations = new Map<string, string>();
  const state = { pendingCompletions: 0, videoCompleteCalls: 0, signedReadCalls: 0 };
  let sequence = 0;
  const nextTransfer = () => String(++sequence).padStart(26, '0');

  const capability = (operation: 'GET' | 'PUT', objectKey: string, transferId?: string): Awaited<ReturnType<ManagedStorage['createSignedRead']>> => ({
    operation, objectKey,
    url: operation === 'PUT' ? `https://storage.test/upload/${transferId}` : `https://storage.test/objects/${encodeURIComponent(objectKey)}`,
    expiresAt: '2030-01-01T00:00:00.000Z',
    expectedContentLength: transferId ? transfers.get(transferId)!.contentLength : null,
    requiredHeaders: operation === 'PUT' ? { 'content-type': transfers.get(transferId!)!.contentType } : {},
  });

  const storage: ManagedStorage = {
    async reserveUpload(input) {
      let transferId = reservations.get(input.idempotencyKey);
      if (!transferId) {
        transferId = nextTransfer();
        reservations.set(input.idempotencyKey, transferId);
        transfers.set(transferId, { objectKey: input.objectKey, contentType: input.contentType, contentLength: input.contentLength, completed: false });
      }
      const transfer = transfers.get(transferId)!;
      assert.equal(input.objectKey, transfer.objectKey, 'idempotency must retain the same object key');
      assert.equal(input.contentLength, transfer.contentLength);
      if (transfer.completed) return { state: 'completed', transferId };
      return { state: 'ready', transferId, capability: capability('PUT', input.objectKey, transferId) };
    },
    async completeUpload(transferId) {
      const transfer = transfers.get(transferId);
      if (!transfer) throw Object.assign(new Error('Missing transfer'), { code: 'storage_conflict' });
      state.videoCompleteCalls++;
      if (state.pendingCompletions > 0) {
        state.pendingCompletions--;
        return { state: 'pending', transferId };
      }
      const object = objects.get(transfer.objectKey);
      if (!object || object.bytes.length !== transfer.contentLength) return { state: 'pending', transferId };
      transfer.completed = true;
      return { state: 'completed', transferId };
    },
    async createSignedRead(objectKey) {
      state.signedReadCalls++;
      if (!objects.has(objectKey)) throw Object.assign(new Error('Missing object'), { code: 'storage_object_not_found' });
      return capability('GET', objectKey);
    },
    async upload(input) {
      objects.set(input.objectKey, { bytes: input.bytes.slice(), contentType: input.contentType });
      return { state: 'completed', transferId: nextTransfer() };
    },
    async deleteObject(input) {
      objects.delete(input.objectKey);
      return { state: 'completed', deletionId: nextTransfer() };
    },
  };

  const capabilityFetch = async (request: Request) => {
    const url = new URL(request.url);
    if (request.method === 'PUT' && url.pathname.startsWith('/upload/')) {
      const transfer = transfers.get(url.pathname.slice('/upload/'.length));
      if (!transfer) return new Response(null, { status: 404 });
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length !== transfer.contentLength) return new Response(null, { status: 400 });
      objects.set(transfer.objectKey, { bytes, contentType: transfer.contentType });
      return new Response(null, { status: 204 });
    }
    const object = objects.get(decodeURIComponent(url.pathname.slice('/objects/'.length)));
    if (!object) return new Response(null, { status: 404 });
    const headers = new Headers({ 'content-type': object.contentType, 'accept-ranges': 'bytes', etag: '"test-video"' });
    let status = 200;
    let bytes = object.bytes;
    const range = request.headers.get('range');
    if (range) {
      const [, start, end] = /^bytes=(\d*)-(\d*)$/.exec(range)!;
      const startAt = start ? Number(start) : Math.max(0, bytes.length - Number(end));
      const endAt = start && end ? Math.min(Number(end), bytes.length - 1) : bytes.length - 1;
      if (startAt > endAt || startAt >= bytes.length) {
        headers.set('content-range', `bytes */${bytes.length}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set('content-range', `bytes ${startAt}-${endAt}/${bytes.length}`);
      bytes = bytes.slice(startAt, endAt + 1);
      status = 206;
    }
    headers.set('content-length', String(bytes.length));
    return new Response(bytes.slice().buffer as ArrayBuffer, { status, headers });
  };

  return { runtime: { storage, capabilityFetch } satisfies StorageRuntime, objects, transfers, state };
}

function apiRequest(path: string, value?: unknown, headers?: Record<string, string>) {
  return new Request(`${ORIGIN}${path}`, value === undefined ? { headers } : {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(value),
  });
}

async function prepareUpload(handle: ReturnType<typeof createApiHandler>, runtime: StorageRuntime, details = DETAILS) {
  const response = await handle(apiRequest('/api/recordings/uploads', details));
  assert.equal(response.status, 201, await response.clone().text());
  const reservation = await response.json();
  if (!reservation.alreadyUploaded) {
    const put = await runtime.capabilityFetch(new Request(reservation.uploadUrl, {
      method: 'PUT', headers: reservation.headers, body: VIDEO.slice().buffer,
    }));
    assert.equal(put.status, 204);
  }
  return reservation as { id: string; uploadId: string; uploadUrl: string | null; headers: Record<string, string>; alreadyUploaded: boolean };
}

test('records, persists and views a video through its UUID, with idempotent completion', async () => {
  const fake = fakeRuntime();
  const handle = createApiHandler(fake.runtime, { now: () => new Date('2026-09-16T12:00:00.000Z') });
  const reservation = await prepareUpload(handle, fake.runtime);
  assert.notEqual(reservation.id, DETAILS.id, 'share ID must not be the private request token');
  assert.notEqual(reservation.id, reservation.uploadId, 'viewing and completing use different capabilities');
  assert.equal((await handle(apiRequest(`/api/recordings/${reservation.id}`))).status, 404);

  const completion = await handle(apiRequest(`/api/recordings/${reservation.id}/complete`, { uploadId: reservation.uploadId }));
  assert.equal(completion.status, 200);
  const recording = await completion.json();
  assert.deepEqual(recording, {
    id: reservation.id, title: DETAILS.title, sizeBytes: VIDEO.length, durationSeconds: DETAILS.durationSeconds,
    contentType: DETAILS.contentType, createdAt: '2026-09-16T12:00:00.000Z',
    videoUrl: `/api/recordings/${reservation.id}/video`, sharePath: `/v/${reservation.id}`,
  });
  assert(!JSON.stringify(recording).includes(reservation.uploadId));
  assert(!JSON.stringify(recording).includes('storage.test'));

  const get = await handle(apiRequest(`/api/recordings/${reservation.id}`));
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), recording);
  const video = await handle(apiRequest(recording.videoUrl));
  assert.equal(video.status, 200);
  assert.equal(video.headers.get('content-type'), 'video/webm');
  assert.equal(video.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await video.arrayBuffer()), VIDEO);

  const calls = fake.state.videoCompleteCalls;
  const repeated = await handle(apiRequest(`/api/recordings/${reservation.id}/complete`, { uploadId: reservation.uploadId }));
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), recording);
  assert.equal(fake.state.videoCompleteCalls, calls, 'a published recording does not restart its transfer');
});

test('share UUIDs cannot complete, overwrite, or expose another upload', async () => {
  const fake = fakeRuntime();
  const handle = createApiHandler(fake.runtime);
  const first = await prepareUpload(handle, fake.runtime);
  assert.equal((await handle(apiRequest(`/api/recordings/${first.id}/complete`, { uploadId: first.id }))).status, 404);
  assert.equal((await handle(apiRequest(`/api/recordings/${OTHER_ID}/complete`, { uploadId: first.uploadId }))).status, 404);
  assert.equal((await handle(apiRequest(`/api/recordings/${first.id}/complete`, { uploadId: OTHER_ID }))).status, 404);

  const second = await prepareUpload(handle, fake.runtime, { ...DETAILS, id: first.id });
  assert.notEqual(second.id, first.id, 'a chosen request token cannot choose an existing storage key');
  assert.equal((await handle(apiRequest(`/api/recordings/${first.id}/complete`, { uploadId: second.uploadId }))).status, 404);
  assert.equal((await handle(apiRequest('/api/recordings'))).status, 404, 'there is no public listing');
  assert.equal((await handle(apiRequest('/api/recordings/../../../pending'))).status, 404);
});

test('reservation retries retain their record and reject changed content', async () => {
  const fake = fakeRuntime();
  const handle = createApiHandler(fake.runtime);
  const first = await prepareUpload(handle, fake.runtime);
  const retry = await handle(apiRequest('/api/recordings/uploads', DETAILS));
  assert.equal(retry.status, 201);
  const retried = await retry.json();
  assert.equal(retried.id, first.id);
  assert.equal(retried.uploadId, first.uploadId);
  assert.equal(fake.transfers.size, 1);
  assert.equal((await handle(apiRequest('/api/recordings/uploads', { ...DETAILS, title: 'Different input' }))).status, 409);

  await handle(apiRequest(`/api/recordings/${first.id}/complete`, { uploadId: first.uploadId }));
  const finishedRetry = await (await handle(apiRequest('/api/recordings/uploads', DETAILS))).json();
  assert.equal(finishedRetry.alreadyUploaded, true);
  assert.equal(finishedRetry.uploadUrl, null);
  assert.equal(finishedRetry.id, first.id);
});

test('does not publish pending transfers and permits retry with the same token', async () => {
  const fake = fakeRuntime();
  const handle = createApiHandler(fake.runtime);
  const upload = await prepareUpload(handle, fake.runtime);
  fake.state.pendingCompletions = 1;
  const first = await handle(apiRequest(`/api/recordings/${upload.id}/complete`, { uploadId: upload.uploadId }));
  assert.equal(first.status, 202);
  assert.equal(first.headers.get('retry-after'), '2');
  assert.deepEqual(await first.json(), { state: 'pending', retryAfterSeconds: 2 });
  assert.equal((await handle(apiRequest(`/api/recordings/${upload.id}`))).status, 404);
  const second = await handle(apiRequest(`/api/recordings/${upload.id}/complete`, { uploadId: upload.uploadId }));
  assert.equal(second.status, 200);
});

test('validates limits, types, UUIDs, bounded JSON, and same-origin writes', async () => {
  const fake = fakeRuntime();
  const handle = createApiHandler(fake.runtime);
  for (const [change, status] of [
    [{ sizeBytes: MAX_VIDEO_BYTES + 1 }, 413], [{ sizeBytes: 0 }, 400], [{ sizeBytes: 3.5 }, 400],
    [{ durationSeconds: MAX_DURATION_SECONDS + 1 }, 400], [{ durationSeconds: -1 }, 400],
    [{ contentType: 'text/html' }, 415], [{ contentType: 'video/webm;codecs=vp9' }, 415],
    [{ title: '' }, 400], [{ title: 'a'.repeat(101) }, 400], [{ title: 'a\u0000b' }, 400],
    [{ id: '../metadata' }, 400],
  ] as const) {
    const response = await handle(apiRequest('/api/recordings/uploads', { ...DETAILS, ...change }));
    assert.equal(response.status, status, JSON.stringify(change));
  }
  assert.equal(fake.transfers.size, 0, 'invalid input must not reserve storage');
  assert.equal((await handle(apiRequest('/api/recordings/uploads', DETAILS, { origin: 'https://malicious.test' }))).status, 403);
  assert.equal((await handle(apiRequest('/api/recordings/uploads', DETAILS, { 'sec-fetch-site': 'cross-site' }))).status, 403);
  assert.equal((await handle(apiRequest('/api/recordings/uploads', DETAILS, { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await handle(apiRequest('/api/recordings/uploads', { ...DETAILS, extra: 'x'.repeat(9000) }))).status, 413);
  const malformed = new Request(`${ORIGIN}/api/recordings/uploads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' });
  assert.equal((await handle(malformed)).status, 400);
  assert.equal((await handle(apiRequest('/api/recordings/uploads'))).status, 405);
  assert.equal((await handle(apiRequest(`/api/recordings/${OTHER_ID}/complete`, {}))).status, 400);
  assert.equal((await handle(apiRequest('/api/recordings/not-a-uuid'))).status, 404);
});

test('proxies video range and HEAD responses without leaking signed URLs', async () => {
  const fake = fakeRuntime();
  const handle = createApiHandler(fake.runtime);
  const upload = await prepareUpload(handle, fake.runtime);
  const recording = await (await handle(apiRequest(`/api/recordings/${upload.id}/complete`, { uploadId: upload.uploadId }))).json();
  const response = await handle(apiRequest(recording.videoUrl, undefined, { range: 'bytes=1-4' }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 1-4/${VIDEO.length}`);
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('location'), null);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), VIDEO.slice(1, 5));
  const suffix = await handle(apiRequest(recording.videoUrl, undefined, { range: 'bytes=-3' }));
  assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), VIDEO.slice(-3));
  const head = await handle(new Request(`${ORIGIN}${recording.videoUrl}`, { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(VIDEO.length));
  assert.equal(await head.text(), '');
  assert.equal((await handle(apiRequest(recording.videoUrl, undefined, { range: 'bytes=0-1,3-4' }))).status, 416);
  const outside = await handle(apiRequest(recording.videoUrl, undefined, { range: 'bytes=999999-' }));
  assert.equal(outside.status, 416);
  assert.equal(outside.headers.get('content-range'), `bytes */${VIDEO.length}`);
});

test('fails closed for missing/raw storage bindings and returns safe configuration diagnostics', async () => {
  assert.throws(() => resolveStorageRuntime({}), StorageUnavailableError);
  assert.throws(() => resolveStorageRuntime({ FILES: { get() {}, put() {}, secret: 'do-not-expose' } }), StorageUnavailableError);
  const fake = fakeRuntime();
  assert.equal(resolveStorageRuntime({ FILES: fake.runtime.storage }).storage, fake.runtime.storage);
  const environment = { FILES: { get() {}, put() {}, secret: 'do-not-expose' }, PRIVATE_KEY: 'also-private' };
  const handle = createApiHandler(() => resolveStorageRuntime(environment), { storageDiagnostics: () => storageBindingDiagnostics(environment) });
  const response = await handle(apiRequest('/api/config'));
  assert.equal(response.status, 200);
  const text = await response.text();
  const config = JSON.parse(text);
  assert.equal(config.configured, false);
  assert.equal(config.maxBytes, MAX_VIDEO_BYTES);
  assert.equal(config.maxDurationSeconds, MAX_DURATION_SECONDS);
  assert.equal(config.storage.present, true);
  assert(!text.includes('do-not-expose'));
  assert(!text.includes('PRIVATE_KEY'));
  assert.equal((await handle(apiRequest('/api/recordings/uploads', DETAILS))).status, 503);
});

test('rejects corrupt stored metadata and sanitizes storage failures', async () => {
  const fake = fakeRuntime();
  const handle = createApiHandler(fake.runtime);
  fake.objects.set(`recordings/${OTHER_ID}/metadata.json`, { bytes: new TextEncoder().encode('{"id":"wrong","videoUrl":"https://private.signed.url/secret"}'), contentType: 'application/json' });
  const corrupt = await handle(apiRequest(`/api/recordings/${OTHER_ID}`));
  assert.equal(corrupt.status, 502);
  assert(!(await corrupt.text()).includes('private.signed.url'));
  const unavailable = createApiHandler({ ...fake.runtime, storage: {
    ...fake.runtime.storage,
    async reserveUpload() { throw new Error('https://gateway.secret.example?credential=secret'); },
  } });
  const error = await unavailable(apiRequest('/api/recordings/uploads', { ...DETAILS, id: undefined }));
  assert.equal(error.status, 502);
  assert(!(await error.text()).includes('credential'));
});
