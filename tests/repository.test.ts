import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createLocalRepository } from '../src/dev/repository';
import type { JobStatus, RecordingRow } from '../src/server/types';

function recordingInput(): RecordingRow {
  const id = randomUUID();
  return {
    id, requestId: randomUUID(), uploadId: randomUUID(), title: 'A screen walkthrough',
    contentType: 'video/webm', sizeBytes: 1_024, durationSeconds: 12.5,
    createdAt: new Date().toISOString(), objectKey: `recordings/${id}/video`,
    transferId: null, uploadSha256: null, uploadAttempted: false, uploadState: 'pending', protected: false, markdownEnabled: false,
  };
}

describe('repository against the real Postgres migration', () => {
  let local: Awaited<ReturnType<typeof createLocalRepository>>;

  before(async () => { local = await createLocalRepository('memory://'); });
  beforeEach(async () => { await local.database.exec('TRUNCATE slop_markdown_jobs, slop_recordings'); });
  after(async () => { await local?.close(); });

  async function createJob(goal = 'Summarize the recording.') {
    const recording = await local.repository.createRecording(recordingInput());
    return (await local.repository.createJob({ id: randomUUID(), requestId: randomUUID(), recordingId: recording.id, goal })).job;
  }

  test('upload requests are idempotent under concurrent retries and preserve the original record', async () => {
    const input = recordingInput();
    const results = await Promise.all(Array.from({ length: 8 }, () => local.repository.createRecording({
      ...input, id: randomUUID(), uploadId: randomUUID(), objectKey: `recordings/${randomUUID()}/video`,
    })));
    assert.equal(new Set(results.map(row => row.id)).size, 1);
    assert(results.every(row => row.requestId === input.requestId));
    assert(results.every(row => row.uploadId === results[0].uploadId));
    assert.deepEqual(await local.repository.getRecordingByRequest(input.requestId), results[0]);
    assert.deepEqual(await local.repository.getRecording(results[0].id), results[0]);
    assert.equal(results[0].uploadAttempted, false, 'new reservations explicitly opt out of the conservative legacy default');
    assert.equal(await local.repository.getRecording(randomUUID()), null);
    const count = await local.database.query<{ count: number }>('SELECT count(*)::integer AS count FROM slop_recordings');
    assert.equal(count.rows[0].count, 1);
  });

  test('completion requires an attached transfer and a retry cannot replace its storage reservation', async () => {
    const record = await local.repository.createRecording(recordingInput());
    await assert.rejects(local.repository.completeRecording(record.id), /unavailable/);
    assert.equal((await local.repository.attachTransfer(record.id, 'transfer-original')).transferId, 'transfer-original');
    assert.equal((await local.repository.attachTransfer(record.id, 'transfer-original')).transferId, 'transfer-original');
    await assert.rejects(local.repository.attachTransfer(record.id, 'transfer-other'), /unavailable/);
    assert.equal((await local.repository.completeRecording(record.id)).uploadState, 'ready');
    assert.equal((await local.repository.completeRecording(record.id)).uploadState, 'ready');
    await local.repository.updateRecording(record.id, { protected: true, markdownEnabled: true });
    const changed = await local.repository.updateRecording(record.id, { protected: false });
    assert.equal(changed.protected, false);
    assert.equal(changed.markdownEnabled, true, 'omitted settings must remain unchanged');
    assert.equal(changed.transferId, 'transfer-original');
  });

  test('concurrent upload claims admit one writer and only its owner can release the lease', async () => {
    const record = await local.repository.createRecording(recordingInput());
    const owners = Array.from({ length: 8 }, () => randomUUID());
    const started = (await local.database.query<{ observed_at: Date }>('SELECT now() AS observed_at')).rows[0].observed_at;
    const claims = await Promise.all(owners.map(owner => local.repository.claimUpload(record.id, owner)));
    assert.equal(claims.filter(Boolean).length, 1);
    const owner = owners[claims.findIndex(Boolean)];
    const lease = await local.database.query<{ upload_lease_until: Date; observed_at: Date }>(
      'SELECT upload_lease_until, now() AS observed_at FROM slop_recordings WHERE id = $1', [record.id],
    );
    const expiresAt = lease.rows[0].upload_lease_until.getTime();
    assert(expiresAt >= started.getTime() + 180_000 && expiresAt <= lease.rows[0].observed_at.getTime() + 180_000, 'uploads receive a three-minute lease');
    await local.repository.releaseUpload(record.id, 'wrong-owner');
    assert.equal(await local.repository.claimUpload(record.id, 'second-writer'), null, 'an unrelated request cannot unlock the upload');
    await local.repository.releaseUpload(record.id, owner);
    assert(await local.repository.claimUpload(record.id, 'second-writer'));
    await local.repository.releaseUpload(record.id, owner);
    assert.equal(await local.repository.claimUpload(record.id, 'third-writer'), null, 'a prior owner cannot unlock the replacement writer');
  });

  test('digest writes require the unexpired current upload lease', async () => {
    const record = await local.repository.createRecording(recordingInput());
    const digest = 'a'.repeat(64);
    assert.equal(await local.repository.saveUploadDigest(record.id, 'unclaimed-owner', digest), null);
    assert(await local.repository.claimUpload(record.id, 'original-owner'));
    assert.equal(await local.repository.saveUploadDigest(record.id, 'wrong-owner', digest), null);
    await local.database.query("UPDATE slop_recordings SET upload_lease_until = now() - interval '1 second' WHERE id = $1", [record.id]);
    assert.equal(await local.repository.saveUploadDigest(record.id, 'original-owner', digest), null, 'an expired owner is fenced before another writer claims the upload');
    assert.equal((await local.repository.getRecording(record.id))?.uploadSha256, null);
    assert(await local.repository.claimUpload(record.id, 'replacement-owner'));
    assert.equal(await local.repository.saveUploadDigest(record.id, 'original-owner', digest), null);
    assert.equal((await local.repository.saveUploadDigest(record.id, 'replacement-owner', digest))?.uploadSha256, digest);
  });

  test('an uploaded digest survives lease changes and can only be replayed identically', async () => {
    const record = await local.repository.createRecording(recordingInput());
    const digest = 'b'.repeat(64);
    assert(await local.repository.claimUpload(record.id, 'first-writer'));
    assert.equal((await local.repository.saveUploadDigest(record.id, 'first-writer', digest))?.uploadSha256, digest);
    assert.equal((await local.repository.saveUploadDigest(record.id, 'first-writer', digest))?.uploadSha256, digest);
    assert.equal(await local.repository.saveUploadDigest(record.id, 'first-writer', 'c'.repeat(64)), null);
    await local.repository.releaseUpload(record.id, 'first-writer');
    assert(await local.repository.claimUpload(record.id, 'retry-writer'));
    assert.equal((await local.repository.saveUploadDigest(record.id, 'retry-writer', digest))?.uploadSha256, digest);
    assert.equal(await local.repository.saveUploadDigest(record.id, 'retry-writer', 'c'.repeat(64)), null);
    assert.equal((await local.repository.getRecording(record.id))?.uploadSha256, digest);
  });

  test('concurrent generation requests retain exactly one active job for a recording', async () => {
    const recording = await local.repository.createRecording(recordingInput());
    const results = await Promise.all(Array.from({ length: 10 }, () => local.repository.createJob({
      id: randomUUID(), requestId: randomUUID(), recordingId: recording.id, goal: 'Write a briefing.',
    })));
    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal(new Set(results.map(result => result.job.id)).size, 1);
    const firstJob = results[0].job;
    for (const status of ['queued', 'uploading', 'processing', 'submitting', 'generating'] satisfies JobStatus[]) {
      await local.database.query('UPDATE slop_markdown_jobs SET status = $2 WHERE id = $1', [firstJob.id, status]);
      const retry = await local.repository.createJob({ id: randomUUID(), requestId: randomUUID(), recordingId: recording.id, goal: 'Another goal.' });
      assert.equal(retry.created, false, status);
      assert.equal(retry.job.id, firstJob.id, status);
      assert.equal(retry.job.goal, 'Write a briefing.', 'another request cannot overwrite an in-flight goal');
    }
    await local.database.query("UPDATE slop_markdown_jobs SET status = 'completed' WHERE id = $1", [firstJob.id]);
    const second = await local.repository.createJob({ id: randomUUID(), requestId: randomUUID(), recordingId: recording.id, goal: 'Another goal.' });
    assert.equal(second.created, true);
    assert.notEqual(second.job.id, firstJob.id);
    assert.equal((await local.repository.getLatestJob(recording.id))?.id, second.job.id);
  });

  test('a generation request is replayable only for its original recording and immutable goal', async () => {
    const first = await createJob();
    const replay = await local.repository.createJob({ id: randomUUID(), requestId: first.requestId, recordingId: first.recordingId, goal: first.goal });
    assert.equal(replay.created, false);
    assert.deepEqual(replay.job, first);
    const other = await local.repository.createRecording(recordingInput());
    for (const mismatch of [
      { recordingId: first.recordingId, goal: 'A different goal' },
      { recordingId: other.id, goal: first.goal },
    ]) {
      await assert.rejects(local.repository.createJob({ id: randomUUID(), requestId: first.requestId, ...mismatch }), (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'request_conflict');
        assert.equal((error as { status?: number }).status, 409);
        return true;
      });
    }
    assert.equal((await local.repository.getJob(first.id))?.goal, first.goal);
  });

  test('leases exclude concurrent workers and fence expired, replaced or incorrect owners', async () => {
    const job = await createJob();
    const claims = await Promise.all(['dev', 'production'].map(owner => local.repository.claimJob(job.id, owner, 60)));
    assert.equal(claims.filter(Boolean).length, 1);
    const first = claims.find(claim => claim !== null)!;
    assert.equal(first.leaseVersion, 1);
    assert(first.leaseOwner);
    assert.equal(await local.repository.updateJob(job.id, 'not-the-owner', first.leaseVersion, { status: 'uploading' }), null);
    assert.equal(await local.repository.updateJob(job.id, first.leaseOwner, first.leaseVersion + 1, { status: 'uploading' }), null);
    assert.equal((await local.repository.updateJob(job.id, first.leaseOwner, first.leaseVersion, { status: 'uploading' }))?.status, 'uploading');
    await local.database.query("UPDATE slop_markdown_jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [job.id]);
    assert.equal(await local.repository.updateJob(job.id, first.leaseOwner, first.leaseVersion, { status: 'failed' }), null, 'expiration fences the worker even before replacement');
    const replacement = await local.repository.claimJob(job.id, 'replacement', 60);
    assert(replacement);
    assert.equal(replacement.leaseVersion, first.leaseVersion + 1);
    assert.equal(await local.repository.updateJob(job.id, first.leaseOwner, first.leaseVersion, { status: 'failed' }), null);
    await local.repository.releaseJob(job.id, first.leaseOwner, first.leaseVersion);
    assert.equal((await local.repository.getJob(job.id))?.leaseOwner, 'replacement', 'stale release cannot unlock a successor');
    assert.equal((await local.repository.updateJob(job.id, 'replacement', replacement.leaseVersion, { status: 'processing' }))?.status, 'processing');
    await local.repository.releaseJob(job.id, 'replacement', replacement.leaseVersion);
    const reclaimed = await local.repository.claimJob(job.id, 'replacement', 60);
    assert(reclaimed);
    assert.equal(reclaimed.leaseVersion, replacement.leaseVersion + 1);
    assert.equal(await local.repository.updateJob(job.id, 'replacement', replacement.leaseVersion, { status: 'failed' }), null, 'fencing also applies when the same worker name reclaims a job');
  });

  test('only due unlocked work is scheduled, including cleanup for every terminal state', async () => {
    const due = await createJob();
    const future = await createJob();
    const leased = await createJob();
    const finished = await createJob();
    await local.database.query("UPDATE slop_markdown_jobs SET next_run_at = now() + interval '1 hour' WHERE id = $1", [future.id]);
    assert(await local.repository.claimJob(leased.id, 'busy-worker', 60));
    await local.database.query("UPDATE slop_markdown_jobs SET status = 'completed' WHERE id = $1", [finished.id]);
    const cleanupIds: string[] = [];
    for (const status of ['completed', 'failed', 'uncertain'] satisfies JobStatus[]) {
      const cleanup = await createJob();
      cleanupIds.push(cleanup.id);
      await local.database.query('UPDATE slop_markdown_jobs SET status = $2, cleanup_pending = true WHERE id = $1', [cleanup.id, status]);
    }
    assert.deepEqual((await local.repository.listWork(50)).map(row => row.id).sort(), [due.id, ...cleanupIds].sort());
    assert.equal(await local.repository.claimJob(future.id, 'early-worker', 60), null);
    assert.equal(await local.repository.claimJob(finished.id, 'unneeded-worker', 60), null);
    assert.equal((await local.repository.listWork(1)).length, 1);
    for (const id of cleanupIds) {
      assert(await local.repository.claimJob(id, 'cleanup-worker', 60));
    }
    assert.deepEqual((await local.repository.listWork(50)).map(row => row.id), [due.id]);
  });
});

test('the additive upload migration preserves an existing legacy recording and starts without a digest', async () => {
  const database = new PGlite('memory://');
  try {
    await database.waitReady;
    await database.exec(await readFile(new URL('../migrations/20260923070000_slop_rooster.sql', import.meta.url), 'utf8'));
    const record = recordingInput();
    await database.query(`INSERT INTO slop_recordings
      (id, request_id, upload_id, title, content_type, size_bytes, duration_seconds, created_at, object_key,
       transfer_id, upload_state, protected, markdown_enabled)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ready',true,true)`, [
      record.id, record.requestId, record.uploadId, record.title, record.contentType, record.sizeBytes,
      record.durationSeconds, record.createdAt, record.objectKey, 'legacy-completed-transfer',
    ]);
    const before = (await database.query<Record<string, unknown>>('SELECT * FROM slop_recordings WHERE id = $1', [record.id])).rows[0];
    assert(!Object.hasOwn(before, 'upload_sha256'), 'the fixture must begin with the actual legacy schema');
    const migration = await readFile(new URL('../migrations/20260923090000_immutable_uploads.sql', import.meta.url), 'utf8');
    await database.exec(migration);
    const expected = { ...before, upload_sha256: null, upload_lease_owner: null, upload_lease_until: null };
    assert.deepEqual((await database.query('SELECT * FROM slop_recordings WHERE id = $1', [record.id])).rows[0], expected);
    await database.exec(migration);
    assert.deepEqual((await database.query('SELECT * FROM slop_recordings WHERE id = $1', [record.id])).rows[0], expected, 'reapplying the additive migration must preserve existing data');
    const outcomes = await readFile(new URL('../migrations/20260923093000_upload_outcomes.sql', import.meta.url), 'utf8');
    await database.exec(outcomes);
    const upgraded = (await database.query<Record<string, unknown>>('SELECT * FROM slop_recordings WHERE id = $1', [record.id])).rows[0];
    assert(upgraded.upload_attempted_at, 'an existing recording conservatively requires original-upload reconciliation');
    const { upload_attempted_at: attemptedAt, ...rest } = upgraded;
    assert.deepEqual(rest, expected);
    await database.exec(outcomes);
    assert.deepEqual((await database.query('SELECT upload_attempted_at FROM slop_recordings WHERE id = $1', [record.id])).rows[0], { upload_attempted_at: attemptedAt });
  } finally {
    await database.close();
  }
});
