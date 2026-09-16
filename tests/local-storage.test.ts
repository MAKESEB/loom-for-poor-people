import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalStorage } from '../src/dev/local-storage';

test('disk storage preserves completed uploads across restart and supports seeking', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'little-loom-test-'));
  try {
    const first = createLocalStorage(directory);
    const input = { objectKey: 'recordings/example/video', idempotencyKey: 'upload-example', contentType: 'video/webm', contentLength: 8 };
    const reservation = await first.storage.reserveUpload(input);
    assert.equal(reservation.state, 'ready');
    if (reservation.state !== 'ready') throw new Error('Missing upload capability');
    const uploaded = await first.capabilityFetch(new Request(reservation.capability.url, { method: 'PUT', headers: reservation.capability.requiredHeaders, body: new Uint8Array([26, 69, 223, 163, 1, 2, 3, 4]) }));
    assert.equal(uploaded.status, 200);
    assert.equal((await first.storage.completeUpload(reservation.transferId)).state, 'completed');

    const restarted = createLocalStorage(directory);
    assert.equal((await restarted.storage.reserveUpload(input)).state, 'completed');
    const read = await restarted.storage.createSignedRead(input.objectKey);
    const video = await restarted.capabilityFetch(new Request(read.url, { headers: { Range: 'bytes=4-6' } }));
    assert.equal(video.status, 206);
    assert.equal(video.headers.get('Content-Range'), 'bytes 4-6/8');
    assert.deepEqual([...new Uint8Array(await video.arrayBuffer())], [1, 2, 3]);
    const invalidRange = await restarted.capabilityFetch(new Request(read.url, { headers: { Range: 'bytes=100-' } }));
    assert.equal(invalidRange.status, 416);
    await assert.rejects(restarted.storage.reserveUpload({ ...input, contentLength: 9 }), /Conflicting/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('disk storage refuses incomplete or oversized uploads without publishing data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'little-loom-test-'));
  try {
    const runtime = createLocalStorage(directory);
    const reservation = await runtime.storage.reserveUpload({ objectKey: 'recordings/example/video', idempotencyKey: 'short-upload', contentType: 'video/webm', contentLength: 4 });
    if (reservation.state !== 'ready') throw new Error('Missing upload capability');
    for (const body of [new Uint8Array(2), new Uint8Array(5)]) {
      const response = await runtime.capabilityFetch(new Request(reservation.capability.url, { method: 'PUT', body }));
      assert.equal(response.status, 400);
      assert.equal((await runtime.storage.completeUpload(reservation.transferId)).state, 'pending');
      await assert.rejects(runtime.storage.createSignedRead('recordings/example/video'));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
