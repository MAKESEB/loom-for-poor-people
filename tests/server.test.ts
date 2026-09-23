import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createLocalRepository } from '../src/dev/repository';
import type { MarkdownService } from '../src/server/types';
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
  const state = { pendingCompletions: 0, videoCompleteCalls: 0, signedReadCalls: 0, videoPutCalls: 0 };
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
      const transfer = [...transfers.values()].find(item => item.objectKey === objectKey);
      if (!objects.has(objectKey) || (transfer && !transfer.completed)) throw Object.assign(new Error('Missing object'), { code: 'storage_object_not_found' });
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
      state.videoPutCalls++;
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


const AUTH = { accessUuid: '25d8debe-680f-4b72-988d-fef6005a88a0', sessionSecret: 'a'.repeat(64), shareSecret: 'b'.repeat(64) };
async function setup(t: TestContext, markdown?: MarkdownService) {
  const local = await createLocalRepository('memory://');
  t.after(() => local.close());
  const fake = fakeRuntime();
  const handle = createApiHandler(fake.runtime, { repository: local.repository, auth: AUTH, markdown });
  const login = await handle(new Request(`${ORIGIN}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ accessCode: AUTH.accessUuid }) }));
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  function req(path: string, options: { method?: string; value?: unknown; body?: BodyInit; headers?: Record<string,string>; anonymous?: boolean } = {}) {
    return new Request(`${ORIGIN}${path}`, {
      method: options.method ?? (options.value === undefined ? 'GET' : 'POST'),
      headers: { ...(options.anonymous ? {} : { cookie }), ...(options.value === undefined ? {} : { 'content-type': 'application/json', origin: ORIGIN }), ...options.headers },
      ...(options.value !== undefined ? { body: JSON.stringify(options.value) } : options.body !== undefined ? { body: options.body } : {}),
    });
  }
  async function prepare(details = DETAILS) {
    const response = await handle(req('/api/recordings/uploads', { value: details }));
    assert.equal(response.status, 201, await response.clone().text());
    const upload = await response.json();
    assert(!JSON.stringify(upload).includes('storage.test'), 'signed storage destinations stay server-side');
    if (!upload.alreadyUploaded) {
      const put = await handle(req(upload.uploadUrl, { method: 'PUT', body: VIDEO.slice().buffer, headers: upload.headers }));
      assert.equal(put.status, 204, await put.clone().text());
    }
    return upload;
  }
  async function complete(upload: { id:string; uploadId:string }) {
    const response = await handle(req(`/api/recordings/${upload.id}/complete`, { value: { uploadId: upload.uploadId } }));
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  return { ...fake, ...local, handle, req, prepare, complete, cookie };
}

test('session login, secure cookie, reload, rejected code and logout', async t => {
  const { handle, req } = await setup(t);
  assert.deepEqual(await (await handle(req('/api/session'))).json(), { authenticated: true });
  assert.deepEqual(await (await handle(req('/api/session', { anonymous: true }))).json(), { authenticated: false });
  const login = await handle(req('/api/session', { value: { accessCode: AUTH.accessUuid }, anonymous: true }));
  const cookie = login.headers.get('set-cookie')!;
  assert(cookie.startsWith('__Host-')); assert(cookie.includes('HttpOnly')); assert(cookie.includes('Secure')); assert(cookie.includes('Max-Age=2592000')); assert(!cookie.includes('Domain='));
  assert.equal((await handle(req('/api/session', { value: { accessCode: 'wrong' }, anonymous: true }))).status, 401);
  const logout = await handle(req('/api/session', { method: 'DELETE' }));
  assert.equal(logout.status, 200); assert(logout.headers.get('set-cookie')!.includes('Max-Age=0'));
  assert.equal((await handle(req('/api/session', { value: { accessCode: AUTH.accessUuid }, headers: { origin: 'https://malicious.test' } }))).status, 403);
});

test('uploads and completes once, persists metadata, and never exposes private storage', async t => {
  const { handle, req, prepare, complete, state, repository, runtime } = await setup(t);
  const upload = await prepare();
  assert.notEqual(upload.id, DETAILS.id); assert.notEqual(upload.id, upload.uploadId);
  assert.equal((await handle(req(`/api/recordings/${upload.id}`))).status, 404);
  const recording = await complete(upload);
  assert.equal(recording.isOwner, true); assert.equal(recording.protected, false);
  assert.equal(recording.sharePath, `/v/${upload.id}`);
  assert(!JSON.stringify(recording).includes(upload.uploadId));
  assert(!JSON.stringify(recording).includes('storage.test'));
  const calls = state.videoCompleteCalls;
  assert.deepEqual(await complete(upload), recording);
  assert.equal(state.videoCompleteCalls, calls);
  const afterRestart = createApiHandler(runtime, { repository, auth: AUTH });
  const publicMetadata = await (await afterRestart(req(`/api/recordings/${upload.id}`, { anonymous: true }))).json();
  assert.equal(publicMetadata.isOwner, false);
  const video = await handle(req(publicMetadata.videoUrl, { anonymous: true }));
  assert.equal(video.status, 200); assert.equal(video.headers.get('cache-control'), 'no-store');
  assert.deepEqual(new Uint8Array(await video.arrayBuffer()), VIDEO);
});

test('reservations are idempotent under concurrency, reject changes and preserve ready state', async t => {
  const { handle, req, prepare, complete, transfers } = await setup(t);
  const reservations = await Promise.all([1,2].map(() => handle(req('/api/recordings/uploads', { value: DETAILS })).then(r => r.json())));
  assert.equal(reservations[0].id, reservations[1].id); assert.equal(reservations[0].uploadId, reservations[1].uploadId);
  assert.equal(transfers.size, 1);
  const upload = await prepare();
  assert.equal(upload.id, reservations[0].id);
  assert.equal((await handle(req('/api/recordings/uploads', { value: { ...DETAILS, title: 'Changed' } }))).status, 409);
  await complete(upload);
  const retry = await (await handle(req('/api/recordings/uploads', { value: DETAILS }))).json();
  assert.equal(retry.alreadyUploaded, true); assert.equal(retry.uploadUrl, null);
});

test('upload and completion require both creator session and private upload ID', async t => {
  const { handle, req, prepare } = await setup(t);
  assert.equal((await handle(req('/api/recordings/uploads', { value: DETAILS, anonymous: true }))).status, 401);
  const upload = await prepare();
  assert.equal((await handle(req(upload.uploadUrl, { method: 'PUT', body: VIDEO.slice().buffer, headers: upload.headers, anonymous: true }))).status, 401);
  assert.equal((await handle(req(`/api/recordings/${upload.id}/complete`, { value: { uploadId: upload.uploadId }, anonymous: true }))).status, 401);
  for (const uploadId of [upload.id, OTHER_ID]) assert.equal((await handle(req(`/api/recordings/${upload.id}/complete`, { value: { uploadId } }))).status, 404);
  assert.equal((await handle(req(`/api/recordings/${OTHER_ID}/complete`, { value: { uploadId: upload.uploadId } }))).status, 404);
});

test('pending storage completion never publishes metadata; same request can recover', async t => {
  const { handle, req, prepare, complete, state } = await setup(t);
  const upload = await prepare(); state.pendingCompletions = 1;
  const pending = await handle(req(`/api/recordings/${upload.id}/complete`, { value: { uploadId: upload.uploadId } }));
  assert.equal(pending.status, 202); assert.equal(pending.headers.get('retry-after'), '2');
  assert.equal((await handle(req(`/api/recordings/${upload.id}`, { anonymous: true }))).status, 404);
  assert.equal((await complete(upload)).id, upload.id);
});

test('validates limits, types, UUIDs, bounded JSON and same-origin writes', async t => {
  const { handle, req, transfers } = await setup(t);
  for (const [change, status] of [
    [{ sizeBytes: MAX_VIDEO_BYTES + 1 }, 413], [{ sizeBytes: 0 }, 400], [{ sizeBytes: 3.5 }, 400],
    [{ durationSeconds: MAX_DURATION_SECONDS + 1 }, 400], [{ durationSeconds: -1 }, 400],
    [{ contentType: 'text/html' }, 415], [{ contentType: 'video/webm;codecs=vp9' }, 415],
    [{ title: '' }, 400], [{ title: 'a'.repeat(101) }, 400], [{ title: 'a\u0000b' }, 400], [{ id: '../metadata' }, 400],
  ] as const) assert.equal((await handle(req('/api/recordings/uploads', { value: { ...DETAILS, ...change } }))).status, status, JSON.stringify(change));
  assert.equal(transfers.size, 0);
  assert.equal((await handle(req('/api/recordings/uploads', { value: DETAILS, headers: { origin: 'https://malicious.test' } }))).status, 403);
  assert.equal((await handle(req('/api/recordings/uploads', { value: DETAILS, headers: { 'sec-fetch-site': 'cross-site' } }))).status, 403);
  assert.equal((await handle(req('/api/recordings/uploads', { value: DETAILS, headers: { 'content-type': 'text/plain' } }))).status, 415);
  assert.equal((await handle(req('/api/recordings/uploads', { value: { ...DETAILS, extra: 'x'.repeat(25000) } }))).status, 413);
  assert.equal((await handle(req('/api/recordings/uploads', { method: 'POST', body: '{broken', headers: { 'content-type': 'application/json' } }))).status, 400);
  assert.equal((await handle(req('/api/recordings/uploads'))).status, 405);
  assert.equal((await handle(req('/api/recordings/not-a-uuid'))).status, 404);
});

test('streamed upload rejects undeclared short or oversized bodies and never publishes them', async t => {
  const { handle, req } = await setup(t);
  const reservation = await (await handle(req('/api/recordings/uploads', { value: DETAILS }))).json();
  for (const bytes of [VIDEO.slice(1), new Uint8Array(VIDEO.length + 1)]) {
    const response = await handle(req(reservation.uploadUrl, { method: 'PUT', body: bytes.buffer, headers: reservation.headers }));
    assert.equal(response.status, 400, await response.clone().text());
    assert.equal((await handle(req(`/api/recordings/${reservation.id}`, { anonymous: true }))).status, 404);
  }
  assert.equal((await handle(req(reservation.uploadUrl, { method: 'PUT', body: VIDEO.slice().buffer, headers: { ...reservation.headers, 'content-length': String(VIDEO.length + 1) } }))).status, 400);
});

test('accepted and completed PUT replays verify their bytes without writing the object again', async t => {
  const { handle, req, prepare, complete, state, objects, repository } = await setup(t);
  const upload = await prepare();
  const altered = VIDEO.slice(); altered[0] ^= 1;
  const originalPuts = state.videoPutCalls;
  const put = (body: Uint8Array, headers = upload.headers) => handle(req(upload.uploadUrl, { method: 'PUT', body: body.slice().buffer, headers }));
  assert.equal((await put(altered)).status, 409, 'accepted bytes are immutable before completion too');
  assert.equal((await put(VIDEO)).status, 204);
  await complete(upload);
  assert.equal((await put(altered)).status, 409, 'same-size modified content conflicts after completion');
  assert.equal((await put(VIDEO)).status, 204);
  assert.equal((await put(VIDEO, { 'content-type': 'video/mp4' })).status, 415);
  assert.equal((await put(VIDEO.slice(1))).status, 400);
  assert.equal((await put(VIDEO, { ...upload.headers, 'content-length': String(VIDEO.length + 1) })).status, 400);
  assert.equal(state.videoPutCalls, originalPuts, 'replay verification never opens another provider PUT');
  const row = await repository.getRecording(upload.id); assert(row?.uploadSha256);
  assert.equal(row.uploadSha256.length, 64);
  assert.deepEqual(objects.get(row.objectKey)?.bytes, VIDEO);
});

test('a committed PUT with lost digest checkpoint is recovered from stored bytes without overwrite', async t => {
  const { runtime, repository, req, handle, state, objects } = await setup(t);
  let loseCheckpoint = true;
  const interrupted = createApiHandler(runtime, {
    auth: AUTH,
    repository: { ...repository, async saveUploadDigest(...args) {
      if (loseCheckpoint) { loseCheckpoint = false; throw new Error('simulated checkpoint interruption'); }
      return repository.saveUploadDigest(...args);
    } },
  });
  const upload = await (await interrupted(req('/api/recordings/uploads', { value: DETAILS }))).json();
  const put = (body: Uint8Array) => req(upload.uploadUrl, { method: 'PUT', body: body.slice().buffer, headers: upload.headers });
  assert.equal((await interrupted(put(VIDEO))).status, 502);
  assert.equal((await repository.getRecording(upload.id))?.uploadSha256, null);
  const originalPuts = state.videoPutCalls;
  state.pendingCompletions = 1;
  const pending = await handle(put(VIDEO));
  assert.equal(pending.status, 503, 'a pending gateway receipt must not allow a replacement PUT');
  assert.equal((await pending.json()).code, 'upload_outcome_pending');
  assert.equal(state.videoPutCalls, originalPuts);
  const altered = VIDEO.slice(); altered[0] ^= 1;
  assert.equal((await handle(put(altered))).status, 409);
  assert.equal((await handle(put(VIDEO))).status, 204);
  assert.equal(state.videoPutCalls, originalPuts, 'the unknown PUT outcome never triggers a second write');
  const row = await repository.getRecording(upload.id); assert(row?.uploadSha256);
  assert.deepEqual(objects.get(row.objectKey)?.bytes, VIDEO);
});

test('protecting links gates metadata, ranges, HEAD and Markdown with permanent read-only tokens', async t => {
  const { handle, req, prepare, complete } = await setup(t);
  const upload = await prepare(); await complete(upload);
  const protectedResponse = await handle(req(`/api/recordings/${upload.id}`, { method: 'PATCH', value: { protected: true, markdownEnabled: true } }));
  const metadata = await protectedResponse.json();
  const token = new URL(metadata.sharePath, ORIGIN).searchParams.get('token'); assert(token);
  const paths = [`/api/recordings/${upload.id}`, `/api/recordings/${upload.id}/video`, `/api/recordings/${upload.id}/markdown`, `/api/recordings/${upload.id}/markdown/download`];
  for (const path of paths) {
    assert.equal((await handle(req(path, { anonymous: true }))).status, 403, path);
    assert.equal((await handle(req(`${path}?token=bad`, { anonymous: true }))).status, 403);
  }
  assert.equal((await handle(req(paths[1], { method: 'HEAD', anonymous: true }))).status, 403);
  const authorized = await (await handle(req(`${paths[0]}?token=${token}`, { anonymous: true }))).json();
  assert.equal(authorized.isOwner, false); assert(authorized.videoUrl.endsWith(`?token=${token}`));
  assert.equal((await handle(req(`${paths[0]}?token=${token}`, { method: 'PATCH', value: { protected: false }, anonymous: true }))).status, 401);
  assert.equal((await handle(req(`${paths[2]}?token=${token}`, { value: { goal: '', requestId: REQUEST_ID }, anonymous: true }))).status, 401);
  assert.equal((await (await handle(req(paths[0]))).json()).sharePath, metadata.sharePath, 'owner reload derives identical permanent token');
  await handle(req(paths[0], { method: 'PATCH', value: { protected: false } }));
  assert.equal((await handle(req(paths[1], { anonymous: true }))).status, 200);
  const protectedAgain = await (await handle(req(paths[0], { method: 'PATCH', value: { protected: true } }))).json();
  assert.equal(protectedAgain.sharePath, metadata.sharePath);
  assert.equal((await handle(req(paths[1], { anonymous: true }))).status, 403);
});

test('video playback forwards range and HEAD semantics without caching stale access', async t => {
  const { handle, req, prepare, complete } = await setup(t);
  const recording = await complete(await prepare());
  const range = await handle(req(recording.videoUrl, { headers: { range: 'bytes=1-4' }, anonymous: true }));
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes 1-4/${VIDEO.length}`);
  assert.equal(range.headers.get('accept-ranges'), 'bytes'); assert.equal(range.headers.get('location'), null);
  assert.deepEqual(new Uint8Array(await range.arrayBuffer()), VIDEO.slice(1,5));
  const suffix = await handle(req(recording.videoUrl, { headers: { range: 'bytes=-3' } }));
  assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), VIDEO.slice(-3));
  const head = await handle(req(recording.videoUrl, { method: 'HEAD' }));
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(VIDEO.length)); assert.equal(await head.text(), '');
  assert.equal((await handle(req(recording.videoUrl, { headers: { range: 'bytes=0-1,3-4' } }))).status, 416);
  const outside = await handle(req(recording.videoUrl, { headers: { range: 'bytes=999999-' } }));
  assert.equal(outside.status, 416); assert.equal(outside.headers.get('content-range'), `bytes */${VIDEO.length}`);
});

test('Markdown toggle alone starts nothing; owner generation and viewer visibility are separate', async t => {
  let generates = 0;
  const markdown: MarkdownService = {
    async generate(recording) { generates++; return { enabled: recording.markdownEnabled, status: 'queued', markdown: null }; },
    async status(recording) { return { enabled: recording.markdownEnabled, status: 'completed', markdown: '# Briefing\nUseful result.' }; },
  };
  const { handle, req, prepare, complete } = await setup(t, markdown);
  const recording = await complete(await prepare());
  const base = `/api/recordings/${recording.id}`;
  assert.equal((await handle(req(`${base}/markdown`, { value: { goal: '', requestId: REQUEST_ID } }))).status, 409);
  await handle(req(base, { method: 'PATCH', value: { markdownEnabled: true } })); assert.equal(generates, 0);
  const generated = await handle(req(`${base}/markdown`, { value: { goal: 'Transcribe the spoken words.', requestId: REQUEST_ID } }));
  assert.equal(generated.status, 202); assert.equal(generates, 1);
  assert.equal((await (await handle(req(`${base}/markdown`, { anonymous: true }))).json()).markdown, '# Briefing\nUseful result.');
  const download = await handle(req(`${base}/markdown/download`, { anonymous: true }));
  assert.equal(download.status, 200); assert(download.headers.get('content-disposition')!.includes('.md'));
  await handle(req(base, { method: 'PATCH', value: { markdownEnabled: false } }));
  assert.deepEqual(await (await handle(req(`${base}/markdown`, { anonymous: true }))).json(), { enabled: false, status: 'idle', markdown: null });
  assert.equal((await handle(req(`${base}/markdown/download`, { anonymous: true }))).status, 404);
  assert.equal((await (await handle(req(`${base}/markdown`))).json()).markdown, '# Briefing\nUseful result.');
});

test('storage configuration uses documented gateway values and sanitizes all failures', async t => {
  assert.throws(() => resolveStorageRuntime({}), StorageUnavailableError);
  assert.throws(() => resolveStorageRuntime({ FILES: { get() {}, put() {} } }), StorageUnavailableError);
  const binding = { OHMYHOST_STORAGE_GATEWAY: { fetch: async () => new Response('{}') }, OHMYHOST_STORAGE_GATEWAY_URL: 'https://gateway.test', OHMYHOST_STORAGE_KEY: 's'.repeat(43), OHMYHOST_PROJECT_ID: '01M2NFNNQV8C4N1WDYJQJ6RQXC', OHMYHOST_ENVIRONMENT_ID: '01M2NFNNQV8C4N1WDYJQJ6RQXD' };
  assert.equal(typeof resolveStorageRuntime(binding).storage.reserveUpload, 'function');
  assert(!JSON.stringify(storageBindingDiagnostics(binding)).includes('secret'));
  const { repository, req, runtime } = await setup(t);
  const handle = createApiHandler(() => resolveStorageRuntime({}), { repository, auth: AUTH });
  const config = await (await handle(req('/api/config'))).json();
  assert.equal(config.configured, false); assert.equal(config.maxBytes, MAX_VIDEO_BYTES);
  assert.equal((await handle(req('/api/recordings/uploads', { value: DETAILS }))).status, 503);
  const broken = createApiHandler({ ...runtime, storage: { ...runtime.storage, async reserveUpload() { throw new Error('https://private.test/?secret=private'); } } }, { repository, auth: AUTH });
  const response = await broken(req('/api/recordings/uploads', { value: DETAILS }));
  assert.equal(response.status, 502); assert(!(await response.text()).includes('secret'));
});
