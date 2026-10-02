import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { applyMigrations, createSqliteD1 } from '../src/dev/sqlite-d1';
import type { CloudflareEnvLike } from '../src/server/cloudflare-types';
import worker from '../src/worker';
import { D1_MIGRATIONS } from './helpers/local-d1';
import { createMemoryR2 } from './helpers/memory-r2';

const ORIGIN = 'https://rec.example.test';
const SECRETS = { SLOP_ROOSTER_ACCESS_UUID: crypto.randomUUID(), APP_SESSION_SECRET: 's'.repeat(48), SHARE_TOKEN_SECRET: 't'.repeat(48) };
const ctx = { waitUntil() { /* Nothing is deferred in these requests. */ } };

async function environment(t: TestContext, overrides: Partial<CloudflareEnvLike> = {}) {
  const db = createSqliteD1();
  t.after(() => db.close());
  await applyMigrations(db, D1_MIGRATIONS);
  const assetRequests: string[] = [];
  const env: CloudflareEnvLike = {
    DB: db, RECORDINGS: createMemoryR2(), ...SECRETS,
    ASSETS: {
      async fetch(request) {
        assetRequests.push(new URL(request.url).pathname);
        return new Response('<!doctype html><title>Slop Rooster</title>', { headers: { 'content-type': 'text/html' } });
      },
    },
    ...overrides,
  };
  return { env, db, assetRequests };
}

test('/api/* is answered by the API handler; every other path is a static asset', async t => {
  const { env, assetRequests } = await environment(t);
  const config = await worker.fetch(new Request(`${ORIGIN}/api/config`), env, ctx);
  assert.equal(config.status, 200);
  assert.equal(config.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal((await config.json() as { configured: boolean }).configured, true);
  const missing = await worker.fetch(new Request(`${ORIGIN}/api/does-not-exist`), env, ctx);
  assert.equal(missing.status, 404, 'unknown API routes are JSON errors, not the SPA');
  assert.equal(missing.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(assetRequests, []);

  for (const path of ['/', '/v/3f0c2b8e-1d4a-4b6c-9e8f-7a6b5c4d3e2f', '/manage/3f0c2b8e-1d4a-4b6c-9e8f-7a6b5c4d3e2f', '/api', '/apis/x']) {
    const response = await worker.fetch(new Request(`${ORIGIN}${path}`), env, ctx);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), 'text/html', path);
  }
  assert.deepEqual(assetRequests, ['/', '/v/3f0c2b8e-1d4a-4b6c-9e8f-7a6b5c4d3e2f', '/manage/3f0c2b8e-1d4a-4b6c-9e8f-7a6b5c4d3e2f', '/api', '/apis/x']);

  const { env: bare } = await environment(t, { ASSETS: undefined });
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/`), bare, ctx)).status, 404);
});

test('missing bindings surface as 503 JSON errors instead of crashing the Worker', async t => {
  const { env } = await environment(t, { DB: undefined, RECORDINGS: undefined });
  const config = await worker.fetch(new Request(`${ORIGIN}/api/config`), env, ctx);
  assert.equal((await config.json() as { configured: boolean }).configured, false);
  const login = await worker.fetch(new Request(`${ORIGIN}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ accessCode: SECRETS.SLOP_ROOSTER_ACCESS_UUID }),
  }), env, ctx);
  assert.equal(login.status, 200, 'signing in needs only the secrets');
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const reservation = await worker.fetch(new Request(`${ORIGIN}/api/recordings/uploads`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
    body: JSON.stringify({ title: 'x', contentType: 'video/webm', sizeBytes: 1, durationSeconds: 1 }),
  }), env, ctx);
  assert.equal(reservation.status, 503);
  assert.equal((await reservation.json() as { code: string }).code, 'database_unavailable');
});

test('the scheduled handler awaits durable Markdown recovery before it resolves', async t => {
  const { env, db } = await environment(t, { GEMINI_API_KEY: 'test-key' });
  const recordingId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  await db.prepare(`INSERT INTO slop_recordings (id, request_id, upload_id, title, content_type, size_bytes, duration_seconds, object_key, transfer_id, upload_state, markdown_enabled)
    VALUES (?1, ?2, ?3, 'Walkthrough', 'video/webm', 10, 1, ?4, 'transfer', 'ready', 1)`).bind(recordingId, crypto.randomUUID(), crypto.randomUUID(), `recordings/${recordingId}/video`).run();
  // A finished job whose provider interaction still has to be deleted: cron-only cleanup work.
  await db.prepare(`INSERT INTO slop_markdown_jobs (id, recording_id, request_id, goal, status, markdown, interaction_id, cleanup_pending)
    VALUES (?1, ?2, ?3, '', 'completed', '# Done', 'interaction-42', 1)`).bind(jobId, recordingId, crypto.randomUUID()).run();

  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    await new Promise(resolve => setTimeout(resolve, 20));
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });

  await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env);
  assert.deepEqual(calls, ['DELETE https://generativelanguage.googleapis.com/v1beta/interactions/interaction-42']);
  const row = await db.prepare('SELECT cleanup_pending, interaction_id, markdown FROM slop_markdown_jobs WHERE id = ?1').bind(jobId).first<Record<string, unknown>>();
  assert.deepEqual({ ...row }, { cleanup_pending: 0, interaction_id: null, markdown: '# Done' });

  const { env: withoutGemini } = await environment(t);
  await worker.scheduled({}, withoutGemini);
  assert.equal(calls.length, 1, 'without a Gemini key there is no background work');
});
