import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { applyMigrations, createSqliteD1, splitSqlStatements } from '../src/dev/sqlite-d1';
import { resolveD1Repository } from '../src/server/cloudflare';
import type { D1Value } from '../src/server/cloudflare-types';
import { createD1Repository } from '../src/server/d1-repository';
import { DatabaseUnavailableError } from '../src/server/repository';
import { MAX_PART_COUNT, MAX_RECORDING_BYTES, MAX_SINGLE_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES } from '../src/shared/policy';
import type { JobStatus, RecordingRow } from '../src/server/types';
import { createLocalD1Repository as createLocalRepository, D1_MIGRATIONS as MIGRATIONS } from './helpers/local-d1';

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sqlNow = (modifier?: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', 'now'${modifier ? `, '${modifier}'` : ''})`;

function recordingInput(): RecordingRow {
  const id = randomUUID();
  return {
    id, requestId: randomUUID(), uploadId: randomUUID(), title: 'A screen walkthrough',
    contentType: 'video/webm', sizeBytes: 1_024, durationSeconds: 12.5,
    createdAt: new Date().toISOString(), objectKey: `recordings/${id}/video`,
    transferId: null, uploadSha256: null, uploadAttempted: false, uploadState: 'pending', protected: false, markdownEnabled: false,
  };
}

describe('repository against the real D1 migration (node:sqlite)', () => {
  let local: Awaited<ReturnType<typeof createLocalRepository>>;

  async function sql(query: string, ...values: D1Value[]) {
    return (await local.database.prepare(query).bind(...values).all()).results;
  }

  before(async () => { local = await createLocalRepository('memory://'); });
  beforeEach(async () => {
    for (const table of ['slop_recording_parts', 'slop_markdown_jobs', 'slop_recordings']) await sql(`DELETE FROM ${table}`);
  });
  after(() => { local?.close(); });

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
    assert.equal(results[0].uploadAttempted, false, 'new reservations explicitly opt out of the conservative column default');
    assert.equal(await local.repository.getRecording(randomUUID()), null);
    const count = await sql('SELECT count(*) AS count FROM slop_recordings');
    assert.equal(count[0].count, 1);
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
    const started = Date.parse(String((await sql(`SELECT ${sqlNow()} AS observed_at`))[0].observed_at));
    const claims = await Promise.all(owners.map(owner => local.repository.claimUpload(record.id, owner)));
    assert.equal(claims.filter(Boolean).length, 1);
    const owner = owners[claims.findIndex(Boolean)];
    const lease = (await sql(`SELECT upload_lease_until, ${sqlNow()} AS observed_at FROM slop_recordings WHERE id = ?1`, record.id))[0];
    assert.match(String(lease.upload_lease_until), ISO_MS);
    const expiresAt = Date.parse(String(lease.upload_lease_until));
    assert(expiresAt >= started + 180_000 && expiresAt <= Date.parse(String(lease.observed_at)) + 180_000, 'uploads receive a three-minute lease');
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
    await sql(`UPDATE slop_recordings SET upload_lease_until = ${sqlNow('-1 seconds')} WHERE id = ?1`, record.id);
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

  test('upload outcomes are fenced by the lease and can be cleared', async () => {
    const record = await local.repository.createRecording(recordingInput());
    assert.equal(await local.repository.markUploadAttempt(record.id, 'nobody', true), null);
    assert(await local.repository.claimUpload(record.id, 'writer'));
    assert.equal((await local.repository.markUploadAttempt(record.id, 'writer', true))?.uploadAttempted, true);
    assert.match(String((await sql('SELECT upload_attempted_at FROM slop_recordings WHERE id = ?1', record.id))[0].upload_attempted_at), ISO_MS);
    assert.equal((await local.repository.markUploadAttempt(record.id, 'writer', false))?.uploadAttempted, false);
    await local.repository.releaseUpload(record.id, 'writer');
    assert.equal(await local.repository.markUploadAttempt(record.id, 'writer', true), null);
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
      const raw = (await sql('SELECT * FROM slop_recordings WHERE id = ?1', record.id))[0];
      assert.equal(raw.size_bytes, sizeBytes, 'the single size column stores the full value');
      assert.equal(raw.duration_seconds, 7_200.5, 'the single duration column stores the full value');
      assert(!Object.hasOwn(raw, 'full_size_bytes') && !Object.hasOwn(raw, 'full_duration_seconds'), 'no capped legacy columns remain');
    }
    for (const durationSeconds of [-1, Infinity, -Infinity, NaN]) {
      await assert.rejects(local.repository.createRecording({ ...recordingInput(), durationSeconds }));
    }
    for (const sizeBytes of [0, 1.5, MAX_RECORDING_BYTES + 1]) {
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
    const lastIndex = record.partCount! - 1;
    assert(lastIndex > 1);
    assert.equal(last.objectKey, `recordings/${record.id}/parts/${String(lastIndex).padStart(6, '0')}`);
    assert.deepEqual((await local.repository.listParts(record.id)).map(part => part.index), [0, lastIndex]);
    for (const index of [-1, record.partCount!, MAX_PART_COUNT, 1.5, NaN]) {
      assert.equal(await local.repository.createPart(record.id, index), null);
    }
    const single = await local.repository.createRecording(recordingInput());
    assert.equal(await local.repository.createPart(single.id, 0), null);
    assert.equal(await local.repository.createPart(randomUUID(), 0), null);
    assert.equal(await local.repository.getPart(record.id, 1), null);
    const largest = await multipartRecording(MAX_RECORDING_BYTES);
    assert.equal(largest.partCount, MAX_PART_COUNT);
    assert.equal((await local.repository.createPart(largest.id, MAX_PART_COUNT - 1))?.sizeBytes, UPLOAD_CHUNK_BYTES);
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
    await sql(`UPDATE slop_recording_parts SET lease_until = ${sqlNow('-1 seconds')} WHERE recording_id = ?1`, record.id);
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
    const corruptions: { set: string; reset: string; value: D1Value }[] = [
      { set: 'size_bytes = size_bytes - 1', reset: 'size_bytes = ?2', value: first.sizeBytes },
      { set: "object_key = 'unexpected-part-key'", reset: 'object_key = ?2', value: first.objectKey },
      { set: 'upload_sha256 = NULL', reset: 'upload_sha256 = ?2', value: first.uploadSha256 },
      { set: 'transfer_id = NULL', reset: 'transfer_id = ?2', value: first.transferId },
      { set: "upload_state = 'pending'", reset: 'upload_state = ?2', value: 'ready' },
      { set: 'part_index = 127', reset: 'part_index = ?2', value: 0 },
    ];
    for (const corruption of corruptions) {
      await sql(`UPDATE slop_recording_parts SET ${corruption.set} WHERE recording_id = ?1 AND part_index = 0`, record.id);
      assert.equal(await local.repository.completeMultipartRecording(record.id), null, corruption.set);
      await sql(`UPDATE slop_recording_parts SET ${corruption.reset} WHERE recording_id = ?1 AND object_key = ?3`, record.id, corruption.value, corruption.set.startsWith('object_key') ? 'unexpected-part-key' : first.objectKey);
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
      await sql('UPDATE slop_markdown_jobs SET status = ?2 WHERE id = ?1', firstJob.id, status);
      const retry = await local.repository.createJob({ id: randomUUID(), requestId: randomUUID(), recordingId: recording.id, goal: 'Another goal.' });
      assert.equal(retry.created, false, status);
      assert.equal(retry.job.id, firstJob.id, status);
      assert.equal(retry.job.goal, 'Write a briefing.', 'another request cannot overwrite an in-flight goal');
    }
    await sql("UPDATE slop_markdown_jobs SET status = 'completed' WHERE id = ?1", firstJob.id);
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
    await sql(`UPDATE slop_markdown_jobs SET lease_until = ${sqlNow('-1 seconds')} WHERE id = ?1`, job.id);
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

  test('job leases last the clamped number of seconds', async () => {
    for (const [requested, expected] of [[60, 60], [0.25, 1], [-5, 1], [10_000, 600], [90.5, 90.5]] as const) {
      const job = await createJob();
      const before = Date.parse(String((await sql(`SELECT ${sqlNow()} AS now`))[0].now));
      const claimed = await local.repository.claimJob(job.id, 'worker', requested);
      const afterClaim = Date.parse(String((await sql(`SELECT ${sqlNow()} AS now`))[0].now));
      assert(claimed?.leaseUntil);
      const until = Date.parse(claimed.leaseUntil);
      assert(until >= before + expected * 1000 && until <= afterClaim + expected * 1000, `lease for ${requested}s`);
      await sql("UPDATE slop_markdown_jobs SET status = 'completed' WHERE id = ?1", job.id);
    }
    const job = await createJob();
    await assert.rejects(local.repository.claimJob(job.id, 'worker', NaN), RangeError);
  });

  test('job patches store canonical timestamps and 0/1 booleans', async () => {
    const job = await createJob();
    const claimed = await local.repository.claimJob(job.id, 'worker', 60);
    assert(claimed);
    const updated = await local.repository.updateJob(job.id, 'worker', claimed.leaseVersion, {
      status: 'uploading', providerFileName: 'files/a', attempts: 2, cleanupPending: true,
      cleanupAfter: '2030-01-01T01:00:00+01:00', nextRunAt: '2030-01-01T00:00:00Z', deadlineAt: new Date(Date.UTC(2030, 0, 2)).toISOString(),
    });
    assert(updated);
    assert.equal(updated.cleanupPending, true);
    assert.equal(updated.cleanupAfter, '2030-01-01T00:00:00.000Z');
    assert.equal(updated.nextRunAt, '2030-01-01T00:00:00.000Z');
    assert.equal(updated.deadlineAt, '2030-01-02T00:00:00.000Z');
    assert.equal(updated.attempts, 2);
    const raw = (await sql('SELECT cleanup_pending, cleanup_after, next_run_at, updated_at FROM slop_markdown_jobs WHERE id = ?1', job.id))[0];
    assert.equal(raw.cleanup_pending, 1);
    assert.equal(raw.next_run_at, '2030-01-01T00:00:00.000Z');
    assert.match(String(raw.updated_at), ISO_MS);
    const cleared = await local.repository.updateJob(job.id, 'worker', claimed.leaseVersion, { cleanupPending: false, cleanupAfter: null, providerFileName: undefined });
    assert.equal(cleared?.cleanupPending, false);
    assert.equal(cleared?.cleanupAfter, null);
    assert.equal(cleared?.providerFileName, 'files/a', 'undefined patch fields are left unchanged');
    assert.equal((await sql('SELECT cleanup_pending FROM slop_markdown_jobs WHERE id = ?1', job.id))[0].cleanup_pending, 0);
    await assert.rejects(local.repository.updateJob(job.id, 'worker', claimed.leaseVersion, { nextRunAt: 'not a date' }), RangeError);
  });

  test('only due unlocked work is scheduled, including cleanup for every terminal state', async () => {
    const due = await createJob();
    const future = await createJob();
    const leased = await createJob();
    const finished = await createJob();
    await sql(`UPDATE slop_markdown_jobs SET next_run_at = ${sqlNow('+1 hours')} WHERE id = ?1`, future.id);
    assert(await local.repository.claimJob(leased.id, 'busy-worker', 60));
    await sql("UPDATE slop_markdown_jobs SET status = 'completed' WHERE id = ?1", finished.id);
    const cleanupIds: string[] = [];
    for (const status of ['completed', 'failed', 'uncertain'] satisfies JobStatus[]) {
      const cleanup = await createJob();
      cleanupIds.push(cleanup.id);
      await sql('UPDATE slop_markdown_jobs SET status = ?2, cleanup_pending = 1 WHERE id = ?1', cleanup.id, status);
    }
    assert.deepEqual((await local.repository.listWork(50)).map(row => row.id).sort(), [due.id, ...cleanupIds].sort());
    assert.equal(await local.repository.claimJob(future.id, 'early-worker', 60), null);
    assert.equal(await local.repository.claimJob(finished.id, 'unneeded-worker', 60), null);
    assert.equal((await local.repository.listWork(1)).length, 1);
    assert.equal((await local.repository.listWork(0)).length, 1, 'the limit is clamped to at least one');
    for (const id of cleanupIds) {
      assert(await local.repository.claimJob(id, 'cleanup-worker', 60));
    }
    assert.deepEqual((await local.repository.listWork(50)).map(row => row.id), [due.id]);
  });

  test('the latest job is the most recently inserted even when millisecond timestamps tie', async () => {
    const recording = await local.repository.createRecording(recordingInput());
    const createdAt = new Date().toISOString();
    const older = `ffffffff-${randomUUID().slice(9)}`;
    const newer = `00000000-${randomUUID().slice(9)}`;
    await sql(`INSERT INTO slop_markdown_jobs (id, recording_id, request_id, goal, status, created_at) VALUES (?1, ?2, ?3, 'a', 'completed', ?4)`, older, recording.id, randomUUID(), createdAt);
    await sql(`INSERT INTO slop_markdown_jobs (id, recording_id, request_id, goal, status, created_at) VALUES (?1, ?2, ?3, 'b', 'completed', ?4)`, newer, recording.id, randomUUID(), createdAt);
    assert.equal((await local.repository.getLatestJob(recording.id))?.id, newer);
  });

  test('UUIDs match case-insensitively and are stored in canonical lowercase, as Postgres uuid columns were', async () => {
    const input = recordingInput();
    const upper = { ...input, id: input.id.toUpperCase(), requestId: input.requestId.toUpperCase(), uploadId: input.uploadId.toUpperCase(), sizeBytes: MAX_SINGLE_UPLOAD_BYTES + 1 };
    const record = await local.repository.createRecording(upper);
    assert.equal(record.id, input.id);
    assert.equal(record.requestId, input.requestId);
    assert.equal(record.uploadId, input.uploadId);
    assert.deepEqual(await local.repository.getRecording(upper.id), record);
    assert.deepEqual(await local.repository.getRecordingByRequest(upper.requestId), record);
    assert.equal((await local.repository.createPart(upper.id, 0))?.objectKey, `recordings/${input.id}/parts/000000`);
    const created = await local.repository.createJob({ id: randomUUID().toUpperCase(), requestId: randomUUID(), recordingId: input.id, goal: 'g' });
    assert.equal(created.job.id, created.job.id.toLowerCase());
    assert.equal((await local.repository.getJob(created.job.id.toUpperCase()))?.id, created.job.id);
    await assert.rejects(sql("INSERT INTO slop_recordings (id, request_id, upload_id, title, content_type, size_bytes, duration_seconds, object_key) VALUES ('not-a-uuid', ?1, ?2, 't', 'video/webm', 1, 0, 'k')", randomUUID(), randomUUID()), /CHECK/);
  });
});

describe('the D1 migration', () => {
  test('is tracked like wrangler, replay-safe, and persists data across reopening', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'slop-rooster-d1-'));
    try {
      const first = await createLocalRepository(directory);
      const record = await first.repository.createRecording(recordingInput());
      const job = (await first.repository.createJob({ id: randomUUID(), requestId: randomUUID(), recordingId: record.id, goal: 'Persist me.' })).job;
      await applyMigrations(first.database, MIGRATIONS);
      first.close();
      const reopened = await createLocalRepository(directory);
      try {
        assert.deepEqual(await reopened.repository.getRecording(record.id), record, 'reapplying migrations preserves existing data');
        assert.deepEqual(await reopened.repository.getJob(job.id), job);
        const applied = (await reopened.database.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map(row => row.name);
        assert.deepEqual(applied, (await readdir(MIGRATIONS)).filter(name => name.endsWith('.sql')).sort());
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('0002 rebuilds recordings and parts for 10 GiB without losing rows or foreign keys', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'slop-rooster-0002-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await copyFile(new URL('0001_init.sql', MIGRATIONS), join(directory, '0001_init.sql'));
    const database = createSqliteD1();
    t.after(() => database.close());
    await applyMigrations(database, directory);
    const before = createD1Repository(database);
    const multipart = await before.createRecording({ ...recordingInput(), sizeBytes: MAX_SINGLE_UPLOAD_BYTES + 1 });
    assert(await before.createPart(multipart.id, 0));
    assert(await before.createPart(multipart.id, 6));
    const single = await before.createRecording(recordingInput());
    await before.attachTransfer(single.id, 'transfer-single');
    await before.completeRecording(single.id);
    const job = (await before.createJob({ id: randomUUID(), requestId: randomUUID(), recordingId: single.id, goal: 'Survive the rebuild.' })).job;
    const rowsOf = async (table: string) => (await database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
    const snapshot = { recordings: await rowsOf('slop_recordings'), parts: await rowsOf('slop_recording_parts'), jobs: await rowsOf('slop_markdown_jobs') };
    await assert.rejects(before.createRecording({ ...recordingInput(), sizeBytes: MAX_RECORDING_BYTES }), /CHECK/, '0001 still caps recordings at 1 GiB');

    await applyMigrations(database, MIGRATIONS);
    assert.deepEqual({ recordings: await rowsOf('slop_recordings'), parts: await rowsOf('slop_recording_parts'), jobs: await rowsOf('slop_markdown_jobs') }, snapshot);
    const after = createD1Repository(database);
    assert.deepEqual(await after.getJob(job.id), job);
    assert.deepEqual(await after.getRecording(multipart.id), multipart);
    assert.deepEqual((await database.prepare('PRAGMA foreign_key_check').all()).results, []);
    await assert.rejects(after.createJob({ id: randomUUID(), requestId: randomUUID(), recordingId: randomUUID(), goal: 'g' }), /FOREIGN KEY/);
    await assert.rejects(database.prepare('INSERT INTO slop_recording_parts (recording_id, part_index, size_bytes, object_key) VALUES (?1, 1, 1, ?2)').bind(randomUUID(), randomUUID()).run(), /FOREIGN KEY/);
    await assert.rejects(database.prepare('DELETE FROM slop_recordings WHERE id = ?1').bind(multipart.id).run(), /FOREIGN KEY/, 'parts still pin their recording');
    await assert.rejects(database.prepare('DELETE FROM slop_recordings WHERE id = ?1').bind(single.id).run(), /FOREIGN KEY/, 'jobs still pin their recording');
    const indexes = (await database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'slop_%' ORDER BY name").all<{ name: string }>()).results.map(row => row.name);
    assert.deepEqual(indexes, ['slop_jobs_due', 'slop_jobs_recording_created', 'slop_one_active_job']);
    const large = await after.createRecording({ ...recordingInput(), sizeBytes: MAX_RECORDING_BYTES });
    assert.equal(large.partCount, MAX_PART_COUNT);
    assert.equal((await after.createPart(large.id, MAX_PART_COUNT - 1))?.objectKey, `recordings/${large.id}/parts/001279`);
    await database.prepare("UPDATE slop_recordings SET upload_state = 'deleted' WHERE id = ?1").bind(single.id).run();
    assert.equal((await after.getRecording(single.id))?.uploadState, 'deleted', "the 'deleted' state is allowed");
  });

  test('keeps LIKE and GLOB patterns within the 50-byte D1 limit that node:sqlite does not enforce', async () => {
    const sources = [
      ...await Promise.all((await readdir(MIGRATIONS)).filter(name => name.endsWith('.sql')).map(name => readFile(new URL(name, MIGRATIONS), 'utf8'))),
      await readFile(new URL('../src/server/d1-repository.ts', import.meta.url), 'utf8'),
    ];
    const patterns = sources.flatMap(source => [...source.matchAll(/\b(?:GLOB|LIKE)\s+'((?:[^']|'')*)'/gi)].map(match => match[1]));
    assert(patterns.length > 0);
    for (const pattern of patterns) assert(Buffer.byteLength(pattern) <= 50, `pattern too long for D1: ${pattern}`);
  });

  test('keeps every constraint SQLite can express', async (t) => {
    const local = await createLocalRepository();
    t.after(() => local.close());
    const insert = (table: string, row: Record<string, D1Value>) => local.database
      .prepare(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map((_, index) => `?${index + 1}`).join(', ')})`)
      .bind(...Object.values(row)).run();
    const recording = await local.repository.createRecording({ ...recordingInput(), sizeBytes: MAX_SINGLE_UPLOAD_BYTES + 1 });
    const recordingRow = (column: string, value: D1Value) => ({
      id: randomUUID(), request_id: randomUUID(), upload_id: randomUUID(), title: 't', content_type: 'video/webm',
      size_bytes: 1, duration_seconds: 0, object_key: randomUUID(), [column]: value,
    });
    const jobRow = (column: string, value: D1Value) => ({ id: randomUUID(), recording_id: recording.id, request_id: randomUUID(), goal: 'g', [column]: value });
    const partRow = (column: string, value: D1Value) => ({ recording_id: recording.id, part_index: 1, size_bytes: 1, object_key: randomUUID(), [column]: value });
    assert(await insert('slop_recordings', recordingRow('protected', 1)), 'the recording fixture is valid');
    assert(await insert('slop_markdown_jobs', jobRow('attempts', 1)), 'the job fixture is valid');
    assert(await insert('slop_recording_parts', partRow('lease_version', 1)), 'the part fixture is valid');
    const invalid: [string, (column: string, value: D1Value) => Record<string, D1Value>, string, D1Value][] = [
      ['slop_recordings', recordingRow, 'id', 'not-a-uuid'], ['slop_recordings', recordingRow, 'request_id', randomUUID().toUpperCase()],
      ['slop_recordings', recordingRow, 'upload_id', `${randomUUID()}0`], ['slop_recordings', recordingRow, 'id', null],
      ['slop_recordings', recordingRow, 'title', ''], ['slop_recordings', recordingRow, 'title', 'x'.repeat(101)],
      ['slop_recordings', recordingRow, 'content_type', 'video/ogg'],
      ['slop_recordings', recordingRow, 'size_bytes', 0], ['slop_recordings', recordingRow, 'size_bytes', MAX_RECORDING_BYTES + 1],
      ['slop_recordings', recordingRow, 'size_bytes', 'large'], ['slop_recordings', recordingRow, 'duration_seconds', -0.5],
      ['slop_recordings', recordingRow, 'upload_state', 'done'], ['slop_recordings', recordingRow, 'protected', 2],
      ['slop_recordings', recordingRow, 'markdown_enabled', -1], ['slop_recordings', recordingRow, 'storage_mode', 'multi'],
      ['slop_recordings', recordingRow, 'chunk_size_bytes', 8_388_609], ['slop_recordings', recordingRow, 'part_count', 0],
      ['slop_recordings', recordingRow, 'part_count', MAX_PART_COUNT + 1], ['slop_recordings', recordingRow, 'upload_sha256', 'A'.repeat(64)],
      ['slop_recordings', recordingRow, 'upload_sha256', 'a'.repeat(63)], ['slop_recordings', recordingRow, 'upload_sha256', 'g'.repeat(64)],
      ['slop_recordings', recordingRow, 'created_at', '2026-09-25 10:00:00'], ['slop_recordings', recordingRow, 'upload_lease_until', '2026-09-25T10:00:00Z'],
      ['slop_recordings', recordingRow, 'upload_attempted_at', 'yesterday'],
      ['slop_markdown_jobs', jobRow, 'id', 'job-1'], ['slop_markdown_jobs', jobRow, 'status', 'paused'],
      ['slop_markdown_jobs', jobRow, 'goal', 'x'.repeat(4001)], ['slop_markdown_jobs', jobRow, 'cleanup_pending', 2],
      ['slop_markdown_jobs', jobRow, 'next_run_at', 'soon'], ['slop_markdown_jobs', jobRow, 'deadline_at', '2026-09-25'],
      ['slop_markdown_jobs', jobRow, 'lease_until', '2026-09-25T10:00:00'], ['slop_markdown_jobs', jobRow, 'attempts', 1.5],
      ['slop_recording_parts', partRow, 'part_index', MAX_PART_COUNT], ['slop_recording_parts', partRow, 'part_index', -1],
      ['slop_recording_parts', partRow, 'size_bytes', 0], ['slop_recording_parts', partRow, 'size_bytes', 8_388_609],
      ['slop_recording_parts', partRow, 'transfer_id', ''], ['slop_recording_parts', partRow, 'upload_sha256', 'F'.repeat(64)],
      ['slop_recording_parts', partRow, 'upload_state', 'uploaded'], ['slop_recording_parts', partRow, 'lease_until', 'later'],
    ];
    for (const [table, row, column, value] of invalid) {
      await assert.rejects(insert(table, row(column, value)), /constraint|cannot store/i, `${table}.${column} = ${value}`);
    }
    await assert.rejects(insert('slop_markdown_jobs', jobRow('recording_id', randomUUID())), /FOREIGN KEY/, 'jobs reference an existing recording');
    await assert.rejects(local.repository.createJob({ id: randomUUID(), requestId: randomUUID(), recordingId: randomUUID(), goal: 'g' }), /FOREIGN KEY/);
    await assert.rejects(insert('slop_recording_parts', partRow('recording_id', randomUUID())), /FOREIGN KEY/, 'parts reference an existing recording');
  });

  test('column defaults match the original schema', async (t) => {
    const local = await createLocalRepository();
    t.after(() => local.close());
    const id = randomUUID();
    await local.database.prepare(`INSERT INTO slop_recordings (id, request_id, upload_id, title, content_type, size_bytes, duration_seconds, object_key, transfer_id, upload_state)
      VALUES (?1, ?2, ?3, 'Raw', 'video/mp4', 10, 1.5, ?4, 'legacy-transfer', 'ready')`).bind(id, randomUUID(), randomUUID(), `recordings/${id}/video`).run();
    const restored = await local.repository.getRecording(id);
    assert(restored);
    assert.equal(restored.uploadAttempted, true, 'a row without an explicit outcome conservatively requires upload reconciliation');
    assert.equal(restored.protected, false);
    assert.equal(restored.markdownEnabled, false);
    assert.equal(restored.storageMode, 'single');
    assert.equal(restored.chunkSizeBytes, undefined);
    assert.equal(restored.uploadSha256, null);
    assert.equal(restored.transferId, 'legacy-transfer');
    assert.equal(restored.uploadState, 'ready');
    const created = (await local.repository.createJob({ id: randomUUID(), requestId: randomUUID(), recordingId: id, goal: '' })).job;
    assert.equal(created.status, 'queued');
    assert.equal(created.attempts, 0);
    assert.equal(created.leaseVersion, 0);
    assert.equal(created.cleanupPending, false);
    assert.equal(created.cleanupAfter, null);
    assert.equal(created.nextRunAt, created.createdAt);
    assert.equal(created.updatedAt, created.createdAt);
    assert.equal(Date.parse(created.deadlineAt) - Date.parse(created.createdAt), 30 * 60_000, 'the deadline defaults to thirty minutes');
  });
});

describe('the D1 binding', () => {
  test('resolveD1Repository requires env.DB and uses it', async () => {
    assert.throws(() => resolveD1Repository({}), DatabaseUnavailableError);
    assert.throws(() => resolveD1Repository({ DB: {} }), DatabaseUnavailableError);
    const db = createSqliteD1();
    try {
      assert.throws(() => resolveD1Repository({ DATABASE: db, D1: db }), DatabaseUnavailableError, 'only the D1 binding name DB is used');
      await applyMigrations(db, MIGRATIONS);
      const record = await resolveD1Repository({ DB: db }).createRecording(recordingInput());
      assert.deepEqual(await createD1Repository(db).getRecording(record.id), record);
    } finally {
      db.close();
    }
  });
});

describe('the node:sqlite D1 shim', () => {
  test('binds D1 values, returns plain rows and reports changes', async () => {
    const db = createSqliteD1();
    try {
      await db.prepare('CREATE TABLE t (a TEXT, b REAL, c BLOB, d INTEGER)').run();
      const inserted = await db.prepare('INSERT INTO t VALUES (?1, ?2, ?3, ?4), (?1, ?2, NULL, NULL)').bind('x', 1.5, new Uint8Array([1, 2]).buffer, null).run();
      assert.equal(inserted.meta?.changes, 2);
      const rows = (await db.prepare('SELECT * FROM t ORDER BY rowid').all()).results;
      assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype);
      assert.equal(rows[0].a, 'x');
      assert.equal(rows[0].b, 1.5);
      assert.deepEqual(new Uint8Array(rows[0].c as ArrayBuffer), new Uint8Array([1, 2]));
      assert.equal(rows[0].d, null);
      assert.equal((await db.prepare('SELECT count(*) AS n FROM t').all()).meta?.changes, 0);
      assert.equal(await db.prepare('SELECT * FROM t WHERE a = ?1').bind('missing').first(), null);
      assert.throws(() => db.prepare('SELECT ?1').bind(undefined as unknown as D1Value), TypeError);
      await assert.rejects(db.prepare('SELEC nonsense').all(), /syntax/, 'compilation errors reject like D1 instead of throwing from prepare()');
    } finally {
      db.close();
    }
  });

  test('batch runs atomically', async () => {
    const db = createSqliteD1();
    try {
      await db.prepare('CREATE TABLE t (a INTEGER PRIMARY KEY)').run();
      await assert.rejects(db.batch!([db.prepare('INSERT INTO t VALUES (?1)').bind(1), db.prepare('INSERT INTO t VALUES (?1)').bind(1)]), /UNIQUE/);
      assert.equal((await db.prepare('SELECT count(*) AS n FROM t').first<{ n: number }>())?.n, 0, 'a failed batch rolls back');
      const results = await db.batch!([db.prepare('INSERT INTO t VALUES (?1)').bind(1), db.prepare('SELECT a FROM t')]);
      assert.deepEqual(results[1].results, [{ a: 1 }]);
    } finally {
      db.close();
    }
  });

  test('migration scripts split only at top-level semicolons', () => {
    assert.deepEqual(splitSqlStatements(`
      -- a comment; with a semicolon
      CREATE TABLE a (x TEXT DEFAULT 'a;b' CHECK (x <> "y;z")); /* block; comment */
      INSERT INTO a VALUES ('it''s; fine');
      CREATE TRIGGER t AFTER INSERT ON a BEGIN
        UPDATE a SET x = CASE WHEN x = 'q' THEN 'r' ELSE x END;
        DELETE FROM a WHERE x = 'z';
      END;
      SELECT CASE WHEN 1 THEN ';' END
    `).map(statement => statement.replace(/\s+/g, ' ')), [
      `CREATE TABLE a (x TEXT DEFAULT 'a;b' CHECK (x <> "y;z"))`,
      `INSERT INTO a VALUES ('it''s; fine')`,
      `CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET x = CASE WHEN x = 'q' THEN 'r' ELSE x END; DELETE FROM a WHERE x = 'z'; END`,
      `SELECT CASE WHEN 1 THEN ';' END`,
    ]);
    assert.throws(() => splitSqlStatements("SELECT 'open"), SyntaxError);
  });
});
