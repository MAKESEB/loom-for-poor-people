import test from 'node:test';
import assert from 'node:assert/strict';
import { createBufferedRecording, MEMORY_RECORDING_BYTES } from '../src/client/recordingBuffer';
import { MAX_RECORDING_BYTES } from '../src/shared/policy';

test('disk recording flushes ordered parts before exposing the complete video', async () => {
  const writes: number[] = [];
  let release!: () => void;
  const firstWrite = new Promise<void>(resolve => { release = resolve; });
  const buffer = createBufferedRecording(MAX_RECORDING_BYTES, {
    async write(index, chunk) {
      writes.push(index);
      if (!index) await firstWrite;
      return new Blob([chunk]);
    },
    async dispose() {},
  });
  const first = buffer.append(new Blob(['video-header']));
  const second = buffer.append(new Blob(['frame-one']));
  const third = buffer.append(new Blob(['frame-two']));
  assert.equal(buffer.diskBacked, true);
  assert.equal(buffer.maxBytes, MAX_RECORDING_BYTES);
  assert.equal(buffer.queuedBytes, 30);
  let finished = false;
  const result = buffer.finish('video/webm').then(blob => { finished = true; return blob; });
  await Promise.resolve();
  assert.deepEqual(writes, [0]);
  assert.equal(finished, false);
  release();
  await Promise.all([first, second, third]);
  const blob = await result;
  assert.equal(blob.type, 'video/webm');
  assert.equal(await blob.text(), 'video-headerframe-oneframe-two');
  assert.deepEqual(writes, [0, 1, 2]);
  assert.equal(buffer.queuedBytes, 0);
  await assert.rejects(buffer.append(new Blob(['late-frame'])), /finished/);
});

test('storage failure preserves both committed and unsaved chunks for preview and download', async () => {
  let writes = 0;
  const buffer = createBufferedRecording(MAX_RECORDING_BYTES, {
    async write(_index, chunk) {
      if (++writes === 2) throw new Error('quota exceeded');
      return new Blob([chunk]);
    },
    async dispose() {},
  });
  await buffer.append(new Blob(['saved']));
  await assert.rejects(buffer.append(new Blob(['-unsaved'])), /quota exceeded/);
  await assert.rejects(buffer.append(new Blob(['-final'])), /quota exceeded/);
  assert.equal(writes, 2, 'a failed store is not repeatedly written');
  assert.equal(await (await buffer.finish('video/webm')).text(), 'saved-unsaved-final');
  assert.equal(buffer.queuedBytes, 0);
});

test('a short disk write retains the complete captured part instead of publishing truncated data', async () => {
  const buffer = createBufferedRecording(MAX_RECORDING_BYTES, {
    async write(_index, chunk) { return chunk.slice(0, 2); },
    async dispose() {},
  });
  await assert.rejects(buffer.append(new Blob(['complete-frame'])), /could not be saved/);
  assert.equal(await (await buffer.finish('video/webm')).text(), 'complete-frame');
});

test('discard waits for an in-flight write, cleans once, and cannot return a stale recording', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let cleaned = 0;
  let writes = 0;
  const buffer = createBufferedRecording(MAX_RECORDING_BYTES, {
    async write(_index, chunk) { writes += 1; await blocked; return chunk; },
    async dispose() { cleaned += 1; },
  });
  const first = buffer.append(new Blob(['a']));
  const second = buffer.append(new Blob(['b']));
  await Promise.resolve();
  const cleanup = buffer.dispose();
  assert.equal(cleaned, 0);
  release();
  await Promise.all([first, second, cleanup, buffer.dispose()]);
  assert.equal(writes, 1, 'queued writes are skipped after discard');
  assert.equal(cleaned, 1);
  await assert.rejects(buffer.finish('video/webm'), /discarded/);
  await assert.rejects(buffer.append(new Blob(['late'])), /finished/);
});

test('the non-OPFS fallback advertises a bounded smaller recording capacity', async () => {
  const buffer = createBufferedRecording(MAX_RECORDING_BYTES);
  assert.equal(buffer.diskBacked, false);
  assert.equal(buffer.maxBytes, MEMORY_RECORDING_BYTES);
  const smaller = createBufferedRecording(1024);
  assert.equal(smaller.maxBytes, 1024);
  await buffer.append(new Blob(['captured']));
  assert.equal(await (await buffer.finish('video/webm')).text(), 'captured');
  await buffer.dispose();
});
