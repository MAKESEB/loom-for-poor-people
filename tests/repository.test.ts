import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createLocalRepository } from '../src/dev/repository';
import { createRepository, type QueryClient } from '../src/server/repository';
import { MAX_RECORDING_BYTES, MAX_SINGLE_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES } from '../src/shared/policy';
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
  beforeEach(async () => { await local.database.exec('TRUNCATE slop_recording_parts, slop_markdown_jobs, slop_recordings'); });
  after(async () => { await local?.close(); });

  async function createJob(goal = 'Summarize the recording.') {
    const recording = await local.repository.createRecording(recordingInput());
    return (await local.repository.createJob({ id: randomUUID(), requestId: randomUUID(), recordingId: recording.id, goal })).job;
  }

  async function multipartRecording(sizeBytes = MAX_SINGLE_UPLOAD_BYTES + 1) {
    return local.repository.createRecording({ ...recordingInput(), sizeBytes, durationSeconds: 7_200.5 });
  }

  async function finishPart(recordingId: string, index: number, release = true) {
    assert(await local.repository.createPart(recordingId, index));
    const owner = randomUUID();
    const claimed = await local.repository.claimPart(recordingId, index, owner);
    assert(claimed);
    assert(await local.repository.savePartDigest(recordingId, index, owner, claimed.leaseVersion, 'd'.repeat(64)));
    assert(await local.repository.attachPartTransfer(recordingId, index, owner, claimed.leaseVersion, `transfer-${index}`));
    assert(await local.repository.completePart(recordingId, index, owner, claimed.leaseVersion));
    if (release) await local.repository.releasePart(recordingId, index, owner, claimed.leaseVersion);
    return { owner, fence: claimed.leaseVersion };
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

  test('new recordings preserve long durations and select chunks only above the single-upload limit', async () => {
    for (const sizeBytes of [MAX_SINGLE_UPLOAD_BYTES, MAX_SINGLE_UPLOAD_BYTES + 1, MAX_RECORDING_BYTES]) {
      const record = await local.repository.createRecording({ ...recordingInput(), sizeBytes, durationSeconds: 7_200.5 });
      assert.equal(record.sizeBytes, sizeBytes);
      assert.equal(record.durationSeconds, 7_200.5);
      assert.equal(record.storageMode, sizeBytes > MAX_SINGLE_UPLOAD_BYTES ? 'parts' : 'single');
      assert.equal(record.chunkSizeBytes, sizeBytes > MAX_SINGLE_UPLOAD_BYTES ? UPLOAD_CHUNK_BYTES : undefined);
      assert.equal(record.partCount, sizeBytes > MAX_SINGLE_UPLOAD_BYTES ? Math.ceil(sizeBytes / UPLOAD_CHUNK_BYTES) : undefined);
      assert.deepEqual(await local.repository.getRecording(record.id), record);
      const raw = (await local.database.query<{ size_bytes: number; duration_seconds: number }>(
        'SELECT size_bytes, duration_seconds FROM slop_recordings WHERE id = $1', [record.id],
      )).rows[0];
      assert.equal(raw.size_bytes, Math.min(sizeBytes, MAX_SINGLE_UPLOAD_BYTES), 'legacy size constraints remain satisfied');
      assert.equal(raw.duration_seconds, 900, 'legacy duration constraints remain satisfied without truncating public metadata');
    }
    for (const durationSeconds of [-1, Infinity, -Infinity, NaN]) {
      await assert.rejects(local.repository.createRecording({ ...recordingInput(), durationSeconds }));
    }
    for (const sizeBytes of [0, MAX_RECORDING_BYTES + 1]) {
      await assert.rejects(local.repository.createRecording({ ...recordingInput(), sizeBytes }));
    }
  });

  test('part manifests derive immutable keys and exact sizes from the recording reservation', async () => {
    const record = await multipartRecording();
    const repeated = await Promise.all(Array.from({ length: 8 }, () => local.repository.createPart(record.id, 0)));
    assert(repeated[0]);
    assert(repeated.every(row => JSON.stringify(row) === JSON.stringify(repeated[0])));
    assert.equal(repeated[0].objectKey, `recordings/${record.id}/parts/000000`);
    assert.equal(repeated[0].sizeBytes, UPLOAD_CHUNK_BYTES);
    assert.equal(repeated[0].leaseVersion, 0);
    const last = await local.repository.createPart(record.id, record.partCount! - 1);
    assert(last);
    assert.equal(last.sizeBytes, record.sizeBytes - (record.partCount! - 1) * UPLOAD_CHUNK_BYTES);
    assert.equal(last.objectKey, `recordings/${record.id}/parts/000006`);
    assert.deepEqual((await local.repository.listParts(record.id)).map(part => part.index), [0, 6]);
    for (const index of [-1, record.partCount!, 128, 1.5, NaN]) {
      assert.equal(await local.repository.createPart(record.id, index), null);
    }
    const single = await local.repository.createRecording(recordingInput());
    assert.equal(await local.repository.createPart(single.id, 0), null);
    assert.equal(await local.repository.createPart(randomUUID(), 0), null);
    assert.equal(await local.repository.getPart(record.id, 1), null);
    const largest = await multipartRecording(MAX_RECORDING_BYTES);
    assert.equal((await local.repository.createPart(largest.id, 127))?.sizeBytes, UPLOAD_CHUNK_BYTES);
  });

  test('part leases fence every data mutation across expired owners and same-owner reclaims', async () => {
    const record = await multipartRecording();
    assert(await local.repository.createPart(record.id, 0));
    const owners = ['dev', 'production', 'retry'];
    const claims = await Promise.all(owners.map(owner => local.repository.claimPart(record.id, 0, owner)));
    assert.equal(claims.filter(Boolean).length, 1);
    const claim = claims.find(Boolean)!;
    const owner = owners[claims.findIndex(Boolean)];
    const digest = 'a'.repeat(64);
    const tryWrites = (writer: string, fence: number) => Promise.all([
      local.repository.attachPartTransfer(record.id, 0, writer, fence, 'part-transfer'),
      local.repository.savePartDigest(record.id, 0, writer, fence, digest),
      local.repository.markPartAttempt(record.id, 0, writer, fence, true),
      local.repository.completePart(record.id, 0, writer, fence),
    ]);
    assert.deepEqual(await tryWrites('wrong-owner', claim.leaseVersion), [null, null, null, null]);
    assert.deepEqual(await tryWrites(owner, claim.leaseVersion + 1), [null, null, null, null]);
    assert.equal((await local.repository.attachPartTransfer(record.id, 0, owner, claim.leaseVersion, 'part-transfer'))?.transferId, 'part-transfer');
    assert.equal(await local.repository.attachPartTransfer(record.id, 0, owner, claim.leaseVersion, 'other-transfer'), null);
    assert.equal((await local.repository.savePartDigest(record.id, 0, owner, claim.leaseVersion, digest))?.uploadSha256, digest);
    assert.equal(await local.repository.savePartDigest(record.id, 0, owner, claim.leaseVersion, 'b'.repeat(64)), null);
    assert.equal((await local.repository.markPartAttempt(record.id, 0, owner, claim.leaseVersion, true))?.uploadAttempted, true);
    await local.database.query("UPDATE slop_recording_parts SET lease_until = now() - interval '1 second' WHERE recording_id = $1", [record.id]);
    assert.deepEqual(await tryWrites(owner, claim.leaseVersion), [null, null, null, null]);
    const replacement = await local.repository.claimPart(record.id, 0, owner);
    assert(replacement);
    assert.equal(replacement.leaseVersion, claim.leaseVersion + 1);
    assert.equal(replacement.uploadSha256, digest);
    assert.equal(replacement.uploadAttempted, true);
    assert.deepEqual(await tryWrites(owner, claim.leaseVersion), [null, null, null, null]);
    await local.repository.releasePart(record.id, 0, owner, claim.leaseVersion);
    await local.repository.releasePart(record.id, 0, 'wrong-owner', replacement.leaseVersion);
    assert.equal(await local.repository.claimPart(record.id, 0, 'another-writer'), null);
    assert.equal((await local.repository.markPartAttempt(record.id, 0, owner, replacement.leaseVersion, false))?.uploadAttempted, false);
    await local.repository.releasePart(record.id, 0, owner, replacement.leaseVersion);
    assert.equal((await local.repository.claimPart(record.id, 0, 'another-writer'))?.leaseVersion, replacement.leaseVersion + 1);
  });

  test('a part needs both its digest and transfer receipt before becoming immutable and ready', async () => {
    const record = await multipartRecording();
    assert(await local.repository.createPart(record.id, 0));
    const claim = await local.repository.claimPart(record.id, 0, 'owner');
    assert(claim);
    assert.equal(await local.repository.completePart(record.id, 0, 'owner', claim.leaseVersion), null);
    assert(await local.repository.savePartDigest(record.id, 0, 'owner', claim.leaseVersion, 'a'.repeat(64)));
    assert.equal(await local.repository.completePart(record.id, 0, 'owner', claim.leaseVersion), null);
    assert(await local.repository.attachPartTransfer(record.id, 0, 'owner', claim.leaseVersion, 'receipt'));
    const ready = await local.repository.completePart(record.id, 0, 'owner', claim.leaseVersion);
    assert.equal(ready?.uploadState, 'ready');
    assert.equal(await local.repository.markPartAttempt(record.id, 0, 'owner', claim.leaseVersion, true), null);
    assert.equal(await local.repository.savePartDigest(record.id, 0, 'owner', claim.leaseVersion, 'a'.repeat(64)), null);
    await local.repository.releasePart(record.id, 0, 'owner', claim.leaseVersion);
    assert.equal(await local.repository.claimPart(record.id, 0, 'new-owner'), null);
    assert.deepEqual(await local.repository.createPart(record.id, 0), ready, 'ready retries are read-only');
    assert.equal(await local.repository.completeMultipartRecording(record.id), null, 'one ready part cannot publish the whole recording');
    await local.repository.attachTransfer(record.id, 'legacy-receipt');
    await assert.rejects(local.repository.completeRecording(record.id), /unavailable/, 'the old completion path cannot publish a chunked recording');
  });

  test('multipart publication is atomic, waits for all receipts and released leases, and freezes the manifest', async () => {
    const record = await multipartRecording();
    assert.equal(await local.repository.completeMultipartRecording(record.id), null);
    for (let index = 0; index < record.partCount! - 1; index++) await finishPart(record.id, index);
    assert.equal(await local.repository.completeMultipartRecording(record.id), null);
    const lastIndex = record.partCount! - 1;
    const last = await finishPart(record.id, lastIndex, false);
    assert.equal(await local.repository.completeMultipartRecording(record.id), null, 'a completed part with an active writer lease must not be published');
    await local.repository.releasePart(record.id, lastIndex, last.owner, last.fence);
    assert(await local.repository.claimUpload(record.id, 'whole-recording-writer'));
    assert.equal(await local.repository.completeMultipartRecording(record.id), null, 'a parent upload lease also fences publication');
    await local.repository.releaseUpload(record.id, 'whole-recording-writer');
    const completions = await Promise.all(Array.from({ length: 4 }, () => local.repository.completeMultipartRecording(record.id)));
    assert(completions.every(value => value?.uploadState === 'ready'));
    const manifest = await local.repository.listParts(record.id);
    assert.equal(manifest.reduce((total, part) => total + part.sizeBytes, 0), record.sizeBytes);
    assert.deepEqual(manifest.map(part => part.index), Array.from({ length: record.partCount! }, (_, index) => index));
    assert.deepEqual(await local.repository.createPart(record.id, 0), manifest[0]);
    assert.equal(await local.repository.createPart(record.id, record.partCount!), null);
    assert.equal(await local.repository.claimPart(record.id, 0, 'post-publish'), null);
    assert.equal(await local.repository.attachPartTransfer(record.id, lastIndex, last.owner, last.fence, 'new-receipt'), null);
    assert.equal(await local.repository.savePartDigest(record.id, lastIndex, last.owner, last.fence, 'b'.repeat(64)), null);
    assert.equal(await local.repository.markPartAttempt(record.id, lastIndex, last.owner, last.fence, true), null);
    assert.equal(await local.repository.completePart(record.id, lastIndex, last.owner, last.fence), null);
    assert.deepEqual(await local.repository.listParts(record.id), manifest);
    assert.deepEqual(await local.repository.completeMultipartRecording(record.id), completions[0]);
  });

  test('publication rejects malformed manifests even when all parts claim to be ready', async () => {
    const record = await multipartRecording();
    for (let index = 0; index < record.partCount!; index++) await finishPart(record.id, index);
    const first = (await local.repository.getPart(record.id, 0))!;
    const corruptions = [
      { set: 'size_bytes = size_bytes - 1', reset: 'size_bytes = $2', value: first.sizeBytes },
      { set: "object_key = 'unexpected-part-key'", reset: 'object_key = $2', value: first.objectKey },
      { set: 'upload_sha256 = NULL', reset: 'upload_sha256 = $2', value: first.uploadSha256 },
      { set: 'transfer_id = NULL', reset: 'transfer_id = $2', value: first.transferId },
      { set: "upload_state = 'pending'", reset: 'upload_state = $2', value: 'ready' },
      { set: 'part_index = 127', reset: 'part_index = $2', value: 0 },
    ];
    for (const corruption of corruptions) {
      await local.database.query(`UPDATE slop_recording_parts SET ${corruption.set} WHERE recording_id = $1 AND part_index = 0`, [record.id]);
      assert.equal(await local.repository.completeMultipartRecording(record.id), null, corruption.set);
      await local.database.query(`UPDATE slop_recording_parts SET ${corruption.reset} WHERE recording_id = $1 AND object_key = $3`, [record.id, corruption.value, corruption.set.startsWith('object_key') ? 'unexpected-part-key' : first.objectKey]);
    }
    assert.equal((await local.repository.completeMultipartRecording(record.id))?.uploadState, 'ready');
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
    const chunked = await readFile(new URL('../migrations/20260925090000_chunked_recordings.sql', import.meta.url), 'utf8');
    await database.exec(chunked);
    const expectedChunked = { ...upgraded, full_size_bytes: null, full_duration_seconds: null, storage_mode: 'single', chunk_size_bytes: null, part_count: null };
    assert.deepEqual((await database.query('SELECT * FROM slop_recordings WHERE id = $1', [record.id])).rows[0], expectedChunked);
    await database.exec(chunked);
    assert.deepEqual((await database.query('SELECT * FROM slop_recordings WHERE id = $1', [record.id])).rows[0], expectedChunked, 'chunk migration is additive and replay-safe');
    const client: QueryClient = {
      async query({ text, values }) {
        const result = await database.query<Record<string, unknown>>(text, [...values]);
        return { rows: result.rows, rowCount: result.affectedRows ?? null, command: text.trim().split(/\s+/)[0].toUpperCase() };
      },
    };
    const restored = await createRepository(client).getRecording(record.id);
    assert(restored);
    assert.equal(restored.sizeBytes, record.sizeBytes);
    assert.equal(restored.durationSeconds, record.durationSeconds);
    assert.equal(restored.storageMode, 'single');
    assert.equal(restored.transferId, 'legacy-completed-transfer');
    assert.equal(restored.protected, true);
    assert.equal(restored.markdownEnabled, true);
    assert.equal(restored.uploadState, 'ready');
  } finally {
    await database.close();
  }
});
