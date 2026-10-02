import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { applyMigrations, createSqliteD1 } from '../src/dev/sqlite-d1';
import type { RecordingMetadata } from '../src/server/api';
import { createCloudflareApp, resolveR2StorageRuntime, type CloudflareAppOptions } from '../src/server/cloudflare';
import type { CloudflareEnvLike } from '../src/server/cloudflare-types';
import { createD1Repository } from '../src/server/d1-repository';
import type { GeminiClient } from '../src/server/gemini';
import { StorageUnavailableError } from '../src/server/storage';
import { MAX_SINGLE_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES } from '../src/shared/policy';
import { D1_MIGRATIONS } from './helpers/local-d1';
import { createMemoryR2 } from './helpers/memory-r2';

const ORIGIN = 'https://rec.example.test';
const LOCAL = 'http://localhost:8787';
const ACCESS_UUID = '4f1d2a8e-9b3c-4e5f-8a7b-6c5d4e3f2a1b';
const SECRETS = { SLOP_ROOSTER_ACCESS_UUID: ACCESS_UUID, APP_SESSION_SECRET: 's'.repeat(48), SHARE_TOKEN_SECRET: 't'.repeat(48) };
const VIDEO = new TextEncoder().encode('bytes recorded on a self-hosted Worker');

interface UploadBody { id: string; uploadId: string; uploadUrl: string | null; headers: Record<string, string>; partCount?: number; chunkSizeBytes?: number }
async function json<T>(response: Response | Promise<Response>): Promise<T> { return (await (await response).json()) as T; }

async function setup(t: TestContext, overrides: Partial<CloudflareEnvLike> = {}, options: CloudflareAppOptions = {}, origin = ORIGIN) {
  const db = createSqliteD1();
  t.after(() => db.close());
  await applyMigrations(db, D1_MIGRATIONS);
  const bucket = createMemoryR2();
  const env: CloudflareEnvLike = { DB: db, RECORDINGS: bucket, ...SECRETS, ...overrides };
  const app = createCloudflareApp(env, options);
  let cookie = '';
  function req(path: string, init: { method?: string; value?: unknown; body?: BodyInit; headers?: Record<string, string>; anonymous?: boolean } = {}) {
    return new Request(`${origin}${path}`, {
      method: init.method ?? (init.value === undefined ? 'GET' : 'POST'),
      headers: { ...(init.anonymous || !cookie ? {} : { cookie }), ...(init.value === undefined ? {} : { 'content-type': 'application/json', origin }), ...init.headers },
      ...(init.value !== undefined ? { body: JSON.stringify(init.value) } : init.body !== undefined ? { body: init.body } : {}),
      ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit);
  }
  async function signIn(accessCode = ACCESS_UUID) {
    const response = await app.fetch(req('/api/session', { value: { accessCode }, anonymous: true }));
    if (response.status === 200) cookie = response.headers.get('set-cookie')!.split(';')[0];
    return response;
  }
  async function record(details: Record<string, unknown> = {}, bytes = VIDEO) {
    const reservation = await app.fetch(req('/api/recordings/uploads', {
      value: { id: crypto.randomUUID(), title: 'Self-hosted walkthrough', contentType: 'video/webm', sizeBytes: bytes.length, durationSeconds: 3, ...details },
    }));
    assert.equal(reservation.status, 201, await reservation.clone().text());
    const upload = await json<UploadBody>(reservation);
    assert(upload.uploadUrl);
    const put = await app.fetch(req(upload.uploadUrl, { method: 'PUT', body: bytes.slice().buffer, headers: upload.headers }));
    assert.equal(put.status, 204, await put.clone().text());
    const completed = await app.fetch(req(`/api/recordings/${upload.id}/complete`, { value: { uploadId: upload.uploadId } }));
    assert.equal(completed.status, 200, await completed.clone().text());
    return { upload, recording: await json<RecordingMetadata>(completed) };
  }
  return { app, env, db, bucket, repository: createD1Repository(db), req, signIn, record };
}

test('the Worker reports itself configured only with D1, R2 and the three required secrets', async t => {
  const config = async (overrides: Partial<CloudflareEnvLike>) => {
    const { app, req } = await setup(t, overrides);
    return (await json<{ configured: boolean; maxBytes: number }>(app.fetch(req('/api/config')))).configured;
  };
  assert.equal(await config({}), true);
  assert.equal(await config({ DB: undefined }), false);
  assert.equal(await config({ RECORDINGS: undefined }), false);
  assert.equal(await config({ SLOP_ROOSTER_ACCESS_UUID: undefined }), false);
  assert.equal(await config({ APP_SESSION_SECRET: 'too-short' }), false);
  assert.equal(await config({ SHARE_TOKEN_SECRET: '' }), false);
  // GEMINI_API_KEY is optional: Markdown is simply not connected without it.
  assert.equal(await config({ GEMINI_API_KEY: undefined }), true);

  const { app, req } = await setup(t, { APP_SESSION_SECRET: undefined });
  const session = await app.fetch(req('/api/session'));
  assert.equal(session.status, 503);
  assert.equal((await json<{ code: string }>(session)).code, 'auth_unavailable');
  assert.throws(() => resolveR2StorageRuntime({ RECORDINGS: {} }), StorageUnavailableError);
});

test('sign-in uses the shared access UUID and a signed, host-bound session cookie', async t => {
  const { app, req, signIn } = await setup(t);
  assert.deepEqual(await json(app.fetch(req('/api/session'))), { authenticated: false });
  assert.equal((await signIn('not-the-access-code')).status, 401);
  const login = await signIn();
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!;
  assert(cookie.startsWith('__Host-slop_rooster_session='));
  assert(cookie.includes('HttpOnly') && cookie.includes('Secure') && cookie.includes('SameSite=Strict'));
  assert.deepEqual(await json(app.fetch(req('/api/session'))), { authenticated: true });
  assert.equal((await app.fetch(req('/api/recordings/uploads', { value: { title: 'x' }, anonymous: true }))).status, 401);

  // `wrangler dev` serves plain http://localhost: the cookie drops the __Host- prefix and Secure.
  const local = await setup(t, {}, {}, LOCAL);
  const localCookie = (await local.signIn()).headers.get('set-cookie')!;
  assert(localCookie.startsWith('slop_rooster_session=') && !localCookie.includes('Secure'));
});

test('a recording uploads to R2, is indexed in D1 and streams back with ranges and protection', async t => {
  const { app, req, signIn, record, bucket, repository } = await setup(t);
  await signIn();
  const { upload, recording } = await record();
  assert.equal(recording.isOwner, true);
  assert.equal(recording.sizeBytes, VIDEO.length);
  assert.equal(recording.sharePath, `/v/${upload.id}`);

  const row = await repository.getRecording(upload.id);
  assert.equal(row?.uploadState, 'ready');
  assert.match(row?.uploadSha256 ?? '', /^[0-9a-f]{64}$/);
  const keys = [...bucket.objects.keys()];
  assert(keys.includes(`recordings/${upload.id}/video`), 'the video is an R2 object');
  assert(keys.filter(key => key !== `recordings/${upload.id}/video`).every(key => key.startsWith('_meta/')), 'everything else is transfer bookkeeping');
  assert(!JSON.stringify(recording).includes('r2-capability'), 'storage capabilities never reach clients');

  const full = await app.fetch(req(`${recording.videoUrl}?view=public`, { anonymous: true }));
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-length'), String(VIDEO.length));
  assert.equal(full.headers.get('cache-control'), 'no-store');
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), VIDEO);
  const ranged = await app.fetch(req(recording.videoUrl, { headers: { range: 'bytes=6-13' }, anonymous: true }));
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 6-13/${VIDEO.length}`);
  assert.deepEqual(new Uint8Array(await ranged.arrayBuffer()), VIDEO.slice(6, 14));
  const head = await app.fetch(req(recording.videoUrl, { method: 'HEAD', anonymous: true }));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(VIDEO.length));

  const changed = await json<RecordingMetadata>(app.fetch(req(`/api/recordings/${upload.id}`, { method: 'PATCH', value: { protected: true } })));
  assert.equal(changed.protected, true);
  const token = new URL(changed.sharePath, ORIGIN).searchParams.get('token');
  assert(token);
  assert.equal((await app.fetch(req(`/api/recordings/${upload.id}?view=public`, { anonymous: true }))).status, 403);
  assert.equal((await app.fetch(req(`/api/recordings/${upload.id}/video?view=public`))).status, 403, 'a creator cookie does not unlock the public view');
  const viewer = await app.fetch(req(`/api/recordings/${upload.id}/video?view=public&token=${token}`, { anonymous: true }));
  assert.equal(viewer.status, 200);
  assert.deepEqual(new Uint8Array(await viewer.arrayBuffer()), VIDEO);
});

test('recordings above the single-upload limit upload as 8 MiB R2 parts and seek across part boundaries', async t => {
  const { app, req, signIn, bucket } = await setup(t);
  await signIn();
  const size = MAX_SINGLE_UPLOAD_BYTES + 17;
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index++) bytes[index] = (index * 31 + 7) & 0xff;
  const reservation = await app.fetch(req('/api/recordings/uploads', {
    value: { id: crypto.randomUUID(), title: 'Long walkthrough', contentType: 'video/webm', sizeBytes: size, durationSeconds: 3_600 },
  }));
  assert.equal(reservation.status, 201, await reservation.clone().text());
  const upload = await json<UploadBody>(reservation);
  assert.equal(upload.chunkSizeBytes, UPLOAD_CHUNK_BYTES);
  assert.equal(upload.partCount, Math.ceil(size / UPLOAD_CHUNK_BYTES));
  for (let part = 0; part < upload.partCount!; part++) {
    const slice = bytes.slice(part * UPLOAD_CHUNK_BYTES, Math.min(size, (part + 1) * UPLOAD_CHUNK_BYTES));
    const put = await app.fetch(req(`${upload.uploadUrl}&part=${part}`, { method: 'PUT', body: slice.buffer, headers: upload.headers }));
    assert.equal(put.status, 204, await put.clone().text());
  }
  const completed = await app.fetch(req(`/api/recordings/${upload.id}/complete`, { value: { uploadId: upload.uploadId } }));
  assert.equal(completed.status, 200, await completed.clone().text());
  const recording = await json<RecordingMetadata>(completed);
  assert.equal(recording.sizeBytes, size);
  assert.equal(recording.markdownEligible, false);
  const parts = [...bucket.objects.keys()].filter(key => key.startsWith(`recordings/${upload.id}/parts/`));
  assert.equal(parts.length, upload.partCount);

  const offset = UPLOAD_CHUNK_BYTES - 19;
  const ranged = await app.fetch(req(recording.videoUrl, { headers: { range: `bytes=${offset}-${offset + 52}` }, anonymous: true }));
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes ${offset}-${offset + 52}/${size}`);
  assert.deepEqual(new Uint8Array(await ranged.arrayBuffer()), bytes.slice(offset, offset + 53));
  const suffix = await app.fetch(req(recording.videoUrl, { headers: { range: 'bytes=-31' }, anonymous: true }));
  assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), bytes.slice(size - 31));
});

test('Markdown jobs read the video from R2; the scheduled run completes queued work before it resolves', async t => {
  const submitted: { goal: string; bytes: Uint8Array }[] = [];
  const client: GeminiClient = {
    async uploadFile() { throw new Error('The inline path is used for new jobs.'); },
    async getFile() { throw new Error('No Files-backed job exists.'); },
    async deleteFile() { /* Nothing to clean up. */ },
    async createInteraction(input) {
      assert(input.inline);
      const source = await input.inline.openBody(new AbortController().signal);
      submitted.push({ goal: input.goal, bytes: new Uint8Array(await new Response(source).arrayBuffer()) });
      return { id: 'interaction-1', status: 'completed', markdown: '# Briefing\n\nRecorded on Cloudflare.' };
    },
    async getInteraction(id) { return { id, status: 'completed', markdown: '# Briefing\n\nRecorded on Cloudflare.' }; },
    async cancelInteraction() { /* Already finished. */ },
    async deleteInteraction() { /* Provider data is removed after the Markdown is stored. */ },
  };
  const { app, req, signIn, record } = await setup(t, { GEMINI_API_KEY: 'test-key' }, { markdown: { client } });
  await signIn();
  const { upload } = await record();
  await app.fetch(req(`/api/recordings/${upload.id}`, { method: 'PATCH', value: { markdownEnabled: true } }));
  // Without an ExecutionContext nothing is deferred: the job stays queued for the cron.
  const started = await app.fetch(req(`/api/recordings/${upload.id}/markdown`, { value: { goal: 'Write a transcript.', requestId: crypto.randomUUID() } }));
  assert.equal(started.status, 202, await started.clone().text());
  assert.equal((await json<{ status: string }>(started)).status, 'queued');
  assert.equal(submitted.length, 0);

  await app.scheduled();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].goal, 'Write a transcript.');
  assert.deepEqual(submitted[0].bytes, VIDEO);
  const view = await json<{ status: string; markdown: string }>(app.fetch(req(`/api/recordings/${upload.id}/markdown`)));
  assert.equal(view.status, 'completed');
  assert.equal(view.markdown, '# Briefing\n\nRecorded on Cloudflare.');

  // Small videos start right away in the request's waitUntil window when one is available.
  const { recording: second } = await record({ id: crypto.randomUUID() });
  await app.fetch(req(`/api/recordings/${second.id}`, { method: 'PATCH', value: { markdownEnabled: true } }));
  const waiting: Promise<unknown>[] = [];
  const deferred = await app.fetch(req(`/api/recordings/${second.id}/markdown`, { value: { goal: '', requestId: crypto.randomUUID() } }), { waitUntil: task => { waiting.push(task); } });
  assert.equal(deferred.status, 202);
  assert.equal(waiting.length, 1);
  await Promise.all(waiting);
  assert.equal(submitted.length, 2);
});

test('without GEMINI_API_KEY the scheduled run is a no-op and Markdown reports it is not connected', async t => {
  const { app, req, signIn, record } = await setup(t);
  await app.scheduled();
  await signIn();
  const { upload } = await record();
  await app.fetch(req(`/api/recordings/${upload.id}`, { method: 'PATCH', value: { markdownEnabled: true } }));
  const response = await app.fetch(req(`/api/recordings/${upload.id}/markdown`, { value: { goal: '', requestId: crypto.randomUUID() } }));
  assert.equal(response.status, 503);
  assert.equal((await json<{ code: string }>(response)).code, 'markdown_unavailable');
});
