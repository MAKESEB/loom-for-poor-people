import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createLocalRepository } from '../src/dev/repository';
import { GeminiError, type GeminiClient, type GeminiFile, type GeminiInteraction } from '../src/server/gemini';
import { createJobService } from '../src/server/jobs';
import type { StorageRuntime } from '../src/server/storage';
import type { RecordingRow, Repository } from '../src/server/types';
import { MAX_MARKDOWN_BYTES } from '../src/shared/policy';

const bytes = new TextEncoder().encode('recorded video bytes');
const uri = (name: string) => `https://generativelanguage.googleapis.com/v1beta/${name}`;

async function setup(t: TestContext) {
  const local = await createLocalRepository('memory://');
  const deferred: Promise<unknown>[] = [];
  t.after(async () => {
    await Promise.allSettled(deferred);
    await local.close();
  });
  let recording: RecordingRow = {
    id: crypto.randomUUID(), requestId: crypto.randomUUID(), uploadId: crypto.randomUUID(),
    title: 'A walkthrough', contentType: 'video/webm', sizeBytes: bytes.length,
    durationSeconds: 3, createdAt: new Date().toISOString(), objectKey: `videos/${crypto.randomUUID()}.webm`,
    transferId: 'transfer-1', uploadSha256: null, uploadAttempted: false, uploadState: 'ready', protected: false, markdownEnabled: true,
  };
  await local.repository.createRecording(recording);
  await local.repository.attachTransfer(recording.id, 'transfer-1');
  await local.repository.completeRecording(recording.id);
  recording = await local.repository.updateRecording(recording.id, { markdownEnabled: true });
  const calls: string[] = [];
  const state = {
    uploadState: 'ACTIVE' as GeminiFile['state'],
    fileState: 'ACTIVE' as GeminiFile['state'],
    create: { id: 'interaction-1', status: 'in_progress', markdown: null } as GeminiInteraction,
    result: { id: 'interaction-1', status: 'completed', markdown: '# Briefing\n\nA useful result.' } as GeminiInteraction,
  };
  const files = new Set<string>();
  const client: GeminiClient = {
    async uploadFile(input) {
      calls.push('upload');
      assert(input.name, 'the cleanup key must be known before upload starts');
      const current = await local.repository.getLatestJob(recording.id);
      assert.equal(current?.providerFileName, input.name);
      assert.equal(current?.status, 'uploading');
      const source = await input.openBody(new AbortController().signal);
      assert.deepEqual(new Uint8Array(await new Response(source).arrayBuffer()), bytes);
      files.add(input.name);
      return { name: input.name, uri: uri(input.name), state: state.uploadState };
    },
    async getFile(name) {
      calls.push('get-file');
      if (!files.has(name)) throw new GeminiError('missing', 404);
      return { name, uri: uri(name), state: state.fileState };
    },
    async deleteFile(name) { calls.push('delete-file'); files.delete(name); },
    async createInteraction(input) {
      calls.push('create');
      const current = await local.repository.getJob(input.jobId);
      assert.equal(current?.status, 'submitting', 'the submission barrier must already be durable');
      assert.equal(input.goal, current?.goal);
      return state.create;
    },
    async getInteraction() { calls.push('get-interaction'); return state.result; },
    async cancelInteraction() { calls.push('cancel'); },
    async deleteInteraction() {
      calls.push('delete-interaction');
      const current = await local.repository.getLatestJob(recording.id);
      assert(['completed', 'failed', 'uncertain'].includes(current!.status), 'cleanup cannot run before durable terminal state');
      if (current!.status === 'completed') assert.equal(current!.markdown, state.result.markdown);
    },
  };
  const runtime: StorageRuntime = {
    storage: {
      async reserveUpload() { throw new Error('Unexpected video upload reservation'); },
      async completeUpload() { throw new Error('Unexpected video upload completion'); },
      async upload() { throw new Error('Unexpected video upload'); },
      async deleteObject() { throw new Error('Jobs must retain the original recording'); },
      async createSignedRead(objectKey: string) {
        calls.push('fresh-capability');
        assert.equal(objectKey, recording.objectKey);
        return { url: 'https://storage.example/private', requiredHeaders: { authorization: 'private-capability' }, operation: 'GET', objectKey, expectedContentLength: null, expiresAt: new Date(Date.now() + 60_000).toISOString() };
      },
    },
    async capabilityFetch(request: Request) {
      calls.push('storage-read');
      assert.equal(request.redirect, 'manual', 'storage capabilities must use the workerd-supported redirect policy');
      assert.equal(request.headers.get('authorization'), 'private-capability');
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    },
  };
  const makeService = (inputMethod: 'files' | 'inline' = 'files') => createJobService(local.repository, runtime, { apiKey: 'test-key', client, processingWaitMs: 0, inputMethod });
  const service = makeService();
  const due = (id: string) => local.database.query("UPDATE slop_markdown_jobs SET next_run_at=now()-interval '1 second' WHERE id=$1", [id]);
  const generate = async (goal = '') => {
    const view = await service.generate(recording, goal, crypto.randomUUID());
    assert(view.jobId);
    return view.jobId;
  };
  return { ...local, recording, calls, state, files, client, runtime, makeService, service, due, generate, deferred };
}

test('durable processing survives closing the tab and UI polling only retrieves known interactions', async (t) => {
  const h = await setup(t);
  h.state.uploadState = 'PROCESSING';
  const id = await h.generate('Transcribe the recording.');
  await h.service.status(h.recording, true);
  assert.deepEqual(h.calls, [], 'queued UI status cannot start an upload');
  await h.service.advance(id);
  assert.equal((await h.repository.getJob(id))?.status, 'processing');
  h.calls.length = 0;
  await h.service.status(h.recording, true);
  assert.deepEqual(h.calls, [], 'processing UI status cannot start an Interaction');

  await h.due(id);
  const restarted = h.makeService();
  await restarted.runPending();
  assert.deepEqual(h.calls, ['get-file', 'create']);
  assert.equal((await h.repository.getJob(id))?.interactionId, 'interaction-1');
  h.calls.length = 0;
  await h.due(id);
  const result = await restarted.status(h.recording, true);
  assert.equal(result.markdown, h.state.result.markdown);
  assert.equal(result.status, 'completed');
  assert.deepEqual(h.calls, ['get-interaction'], 'a UI GET defers provider deletion to cron');
  await restarted.runPending();
  const complete = await h.repository.getJob(id);
  assert.equal(complete?.cleanupPending, false);
  assert.equal(complete?.providerFileName, null);
  assert.equal(complete?.interactionId, null);
  assert.equal(complete?.markdown, h.state.result.markdown);
  assert.equal(h.files.size, 0);
});

test('double Generate and simultaneous Dev/production workers submit only one active job', async (t) => {
  const h = await setup(t);
  const [first, second] = await Promise.all([
    h.service.generate(h.recording, 'Briefing', crypto.randomUUID()),
    h.service.generate(h.recording, 'Different prompt', crypto.randomUUID()),
  ]);
  assert.equal(first.jobId, second.jobId);
  await Promise.all([h.service.advance(first.jobId!), h.makeService().advance(second.jobId!)]);
  assert.equal(h.calls.filter((call) => call === 'upload').length, 1);
  assert.equal(h.calls.filter((call) => call === 'create').length, 1);
  await h.due(first.jobId!);
  await Promise.all([h.service.status(h.recording, true), h.makeService().status(h.recording, true)]);
  assert.equal(h.calls.filter((call) => call === 'get-interaction').length, 1);
});

test('lost create confirmation becomes uncertain and requires an explicit new request', async (t) => {
  const h = await setup(t);
  h.client.createInteraction = async () => { h.calls.push('create'); throw new GeminiError('lost-response', null, true); };
  const id = await h.generate();
  await h.service.advance(id);
  const uncertain = await h.repository.getJob(id);
  assert.equal(uncertain?.status, 'uncertain');
  assert.match(uncertain!.error!, /may have received/);
  assert.equal(uncertain?.cleanupAfter, uncertain?.deadlineAt);
  await h.due(id);
  await h.service.runPending();
  await h.service.status(h.recording, true);
  assert.equal(h.calls.filter((call) => call === 'create').length, 1);
  assert.equal(h.calls.filter((call) => call === 'delete-file').length, 0, 'allow the possibly running Interaction its bounded lifetime');
  const second = await h.generate();
  assert.notEqual(second, id, 'a deliberate owner retry creates a new attempt');
});

test('a stale submitting lease is recovered without resubmitting to Gemini', async (t) => {
  const h = await setup(t);
  const id = await h.generate();
  await h.database.query("UPDATE slop_markdown_jobs SET status='submitting',provider_file_name='files/known',provider_file_uri=$2,lease_owner='dead-worker',lease_until=now()-interval '1 second' WHERE id=$1", [id, uri('files/known')]);
  await h.service.runPending();
  assert.equal((await h.repository.getJob(id))?.status, 'uncertain');
  assert.deepEqual(h.calls, []);
});

test('a lost upload response is reconciled through its pre-persisted file name', async (t) => {
  const h = await setup(t);
  const realUpload = h.client.uploadFile;
  h.client.uploadFile = async (input) => { await realUpload(input); throw new GeminiError('upload-response-lost'); };
  const id = await h.generate();
  await h.service.advance(id);
  const queued = await h.repository.getJob(id);
  assert.equal(queued?.status, 'queued');
  assert(queued?.providerFileName);
  assert.equal(queued?.providerFileUri, null);
  await h.due(id);
  await h.makeService().runPending();
  assert.equal((await h.repository.getJob(id))?.status, 'generating');
  assert.equal(h.calls.filter((call) => call === 'upload').length, 1, 'recovery must reuse the already uploaded file');
  assert.equal(h.calls.filter((call) => call === 'create').length, 1);
});

test('provider cleanup retries independently without losing Markdown or regenerating', async (t) => {
  const h = await setup(t);
  const id = await h.generate();
  await h.service.advance(id);
  await h.due(id);
  const realDelete = h.client.deleteFile;
  let failed = false;
  h.client.deleteFile = async (name) => {
    if (!failed) { failed = true; h.calls.push('delete-file-failed'); throw new GeminiError('temporary', 503); }
    await realDelete(name);
  };
  await h.service.runPending();
  let job = await h.repository.getJob(id);
  assert.equal(job?.status, 'completed');
  assert.equal(job?.markdown, h.state.result.markdown);
  assert.equal(job?.cleanupPending, true);
  assert.equal(job?.interactionId, null);
  await h.due(id);
  await h.service.runPending();
  job = await h.repository.getJob(id);
  assert.equal(job?.cleanupPending, false);
  assert.equal(h.calls.filter((call) => call === 'delete-interaction').length, 1);
  assert.equal(h.calls.filter((call) => call === 'create').length, 1);
});

test('the generation deadline cancels known work and keeps the original video available', async (t) => {
  const h = await setup(t);
  const id = await h.generate();
  await h.service.advance(id);
  await h.database.query("UPDATE slop_markdown_jobs SET next_run_at=now()-interval '1 second',deadline_at=now()-interval '1 second' WHERE id=$1", [id]);
  await h.service.runPending();
  const job = await h.repository.getJob(id);
  assert.equal(job?.status, 'failed');
  assert.match(job!.error!, /too long/);
  assert.equal(job?.cleanupPending, false);
  assert(h.calls.includes('cancel'));
  assert.equal((await h.repository.getRecording(h.recording.id))?.uploadState, 'ready');
});

test('a fenced-out upload worker cannot submit an interaction or release a newer lease', async (t) => {
  const h = await setup(t);
  const realUpload = h.client.uploadFile;
  h.client.uploadFile = async (input) => {
    const file = await realUpload(input);
    const job = await h.repository.getLatestJob(h.recording.id);
    await h.database.query("UPDATE slop_markdown_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job!.id]);
    assert(await h.repository.claimJob(job!.id, 'new-owner', 240));
    return file;
  };
  const id = await h.generate();
  await h.service.advance(id);
  assert.equal(h.calls.filter((call) => call === 'create').length, 0);
  const job = await h.repository.getJob(id);
  assert.equal(job?.leaseOwner, 'new-owner');
  assert.equal(job?.providerFileName, [...h.files][0], 'known provider name survives the lost worker');
});

test('a definite create rejection fails without exposing provider diagnostics or replaying', async (t) => {
  const h = await setup(t);
  h.client.createInteraction = async () => { h.calls.push('create'); throw new GeminiError('invalid_request', 400); };
  const id = await h.generate();
  await h.service.advance(id);
  assert.equal((await h.repository.getJob(id))?.status, 'failed');
  await h.service.runPending();
  assert.equal(h.calls.filter((call) => call === 'create').length, 1);
  assert.equal((await h.repository.getJob(id))?.cleanupPending, false);
});

test('streamed inline generation keeps its provider ID durable without uploading a Files resource', async (t) => {
  const h = await setup(t);
  const service = h.makeService('inline');
  h.client.createInteraction = async (input) => {
    h.calls.push('create');
    assert(input.inline);
    assert.equal(input.inline.sizeBytes, bytes.length);
    assert.equal((await h.repository.getJob(input.jobId))?.status, 'submitting');
    const source = await input.inline.openBody(new AbortController().signal);
    assert.deepEqual(new Uint8Array(await new Response(source).arrayBuffer()), bytes);
    return h.state.create;
  };
  const generated = await service.generate(h.recording, 'A briefing', crypto.randomUUID());
  await service.advance(generated.jobId!);
  assert.equal((await h.repository.getJob(generated.jobId!))?.interactionId, 'interaction-1');
  assert.deepEqual(h.calls, ['create', 'fresh-capability', 'storage-read']);
  await h.due(generated.jobId!);
  const result = await h.makeService('inline').status(h.recording, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.markdown, h.state.result.markdown);
  await service.runPending();
  assert.equal(h.calls.filter(call => call === 'delete-interaction').length, 1);
  assert.equal(h.calls.filter(call => call === 'upload' || call === 'delete-file').length, 0);
});

test('a lost streamed inline submission is never automatically repeated', async (t) => {
  const h = await setup(t);
  const service = h.makeService('inline');
  h.client.createInteraction = async () => { h.calls.push('create'); throw new GeminiError('upload-response-lost', null, true); };
  const generated = await service.generate(h.recording, '', crypto.randomUUID());
  await service.advance(generated.jobId!);
  assert.equal((await h.repository.getJob(generated.jobId!))?.status, 'uncertain');
  await h.due(generated.jobId!);
  await service.runPending();
  await service.status(h.recording, true);
  assert.deepEqual(h.calls, ['create']);
});

test('videos larger than 10 MiB stay queued for cron instead of the short HTTP waitUntil window', async (t) => {
  const h = await setup(t);
  await h.database.query('UPDATE slop_recordings SET size_bytes=$2, full_size_bytes=$2 WHERE id=$1', [h.recording.id, 10 * 1024 * 1024 + 1]);
  const recording = await h.repository.getRecording(h.recording.id);
  assert.equal(recording?.sizeBytes, 10 * 1024 * 1024 + 1);
  const deferred = h.deferred;
  const service = createJobService(h.repository, h.runtime, { apiKey: 'test-key', client: h.client, defer: (task) => { deferred.push(task); } });
  const result = await service.generate(recording!, '', crypto.randomUUID());
  assert.equal(result.status, 'queued');
  assert.equal(deferred.length, 0);
  assert.deepEqual(h.calls, []);
  const pending = await h.repository.listWork(4);
  assert.equal(pending[0].id, result.jobId, 'cron can claim the durable queued job');
});

test('oversized recordings reject Markdown before creating a job or starting any work', async (t) => {
  const h = await setup(t);
  let createCalls = 0;
  const repository: Repository = {
    ...h.repository,
    async createJob(input) { createCalls++; return h.repository.createJob(input); },
  };
  const deferred = h.deferred;
  const service = createJobService(repository, h.runtime, {
    apiKey: 'test-key', client: h.client, defer: task => { deferred.push(task); },
  });
  await assert.rejects(
    service.generate({ ...h.recording, sizeBytes: MAX_MARKDOWN_BYTES + 1 }, 'Transcribe this recording.', crypto.randomUUID()),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.equal((error as Error & { code: string }).code, 'markdown_too_large');
      assert.equal((error as Error & { status: number }).status, 413);
      assert.equal(error.message, 'Markdown generation is available for recordings up to 50 MiB.');
      return true;
    },
  );
  assert.equal(createCalls, 0, 'the policy must be checked before touching the job queue');
  assert.equal(deferred.length, 0);
  assert.deepEqual(h.calls, [], 'no provider or storage operation may start');
  assert.equal(await h.repository.getLatestJob(h.recording.id), null);
  assert.deepEqual(await h.repository.listWork(4), []);
});

for (const inputMethod of ['files', 'inline'] as const) {
  test(`recovered oversized ${inputMethod} jobs fail before provider or storage work`, async (t) => {
    const h = await setup(t);
    const id = await h.generate();
    const repository: Repository = {
      ...h.repository,
      async getRecording(recordingId) {
        const recording = await h.repository.getRecording(recordingId);
        return recording ? { ...recording, sizeBytes: MAX_MARKDOWN_BYTES + 1 } : null;
      },
    };
    const service = createJobService(repository, h.runtime, { apiKey: 'test-key', client: h.client, inputMethod });
    await service.runPending();
    const job = await h.repository.getJob(id);
    assert.equal(job?.status, 'failed');
    assert.equal(job?.error, 'Markdown generation is available for recordings up to 50 MiB.');
    assert.equal(job?.attempts, 0);
    assert.equal(job?.providerFileName, null);
    assert.equal(job?.interactionId, null);
    assert.equal(job?.cleanupPending, false);
    assert.deepEqual(h.calls, [], 'recovering an old oversized job must not send its video to Gemini');
    assert.equal((await h.repository.getRecording(h.recording.id))?.uploadState, 'ready', 'the original video remains available');
  });
}

test('an exactly 50 MiB recording still creates a durable job for cron', async (t) => {
  const h = await setup(t);
  let createCalls = 0;
  const repository: Repository = {
    ...h.repository,
    async createJob(input) { createCalls++; return h.repository.createJob(input); },
  };
  const deferred = h.deferred;
  const service = createJobService(repository, h.runtime, {
    apiKey: 'test-key', client: h.client, defer: task => { deferred.push(task); },
  });
  const result = await service.generate({ ...h.recording, sizeBytes: MAX_MARKDOWN_BYTES }, '', crypto.randomUUID());
  assert.equal(createCalls, 1);
  assert.equal(result.status, 'queued');
  assert(result.jobId);
  assert.equal((await h.repository.getJob(result.jobId))?.status, 'queued');
  assert.equal((await h.repository.listWork(4))[0]?.id, result.jobId);
  assert.equal(deferred.length, 0, 'maximum-size videos must use the longer cron execution window');
  assert.deepEqual(h.calls, []);
});
