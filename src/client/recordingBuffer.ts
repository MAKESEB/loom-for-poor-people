import { MIB } from '../shared/policy';
import { createTemporaryRecordingStore } from './recordingCache';

export const MEMORY_RECORDING_BYTES = 128 * MIB;
export const MAX_QUEUED_RECORDING_BYTES = 32 * MIB;

export interface RecordingPartStore {
  write(index: number, chunk: Blob): Promise<Blob>;
  dispose(): Promise<void>;
}

export interface RecordingBuffer {
  readonly diskBacked: boolean;
  readonly maxBytes: number;
  readonly queuedBytes: number;
  append(chunk: Blob): Promise<void>;
  finish(contentType: string): Promise<Blob>;
  dispose(): Promise<void>;
}

/** Each disk part is immutable, so the final Blob can reference files without copying the video. */
export function createBufferedRecording(maxBytes: number, store?: RecordingPartStore): RecordingBuffer {
  const parts: Blob[] = [];
  let pending = Promise.resolve();
  let queuedBytes = 0;
  let failure: unknown;
  let closed = false;
  let disposed = false;
  let disposing: Promise<void> | undefined;

  return {
    diskBacked: !!store,
    maxBytes: store ? maxBytes : Math.min(maxBytes, MEMORY_RECORDING_BYTES),
    get queuedBytes() { return queuedBytes; },
    append(chunk) {
      if (closed || disposed) return Promise.reject(new Error('This recording has finished.'));
      const index = parts.push(chunk) - 1;
      if (!store) return Promise.resolve();
      queuedBytes += chunk.size;
      const write = pending.then(async () => {
        if (disposed) return;
        if (failure) throw failure;
        try {
          const file = await store.write(index, chunk);
          if (file.size !== chunk.size) throw new Error('The recording part could not be saved.');
          if (!disposed) parts[index] = file;
        } catch (error) {
          // Keep the original chunk for the final preview/download if local storage fills up.
          failure = error;
          throw error;
        }
      }).finally(() => { queuedBytes -= chunk.size; });
      pending = write.catch(() => {});
      return write;
    },
    async finish(contentType) {
      closed = true;
      await pending;
      if (disposed) throw new Error('This recording was discarded.');
      return new Blob(parts, { type: contentType });
    },
    dispose() {
      if (disposing) return disposing;
      disposed = true;
      closed = true;
      disposing = pending.then(async () => {
        parts.length = 0;
        await store?.dispose();
      });
      return disposing;
    },
  };
}

/** OPFS belongs to this site and needs no filesystem picker or external storage service. */
export async function createRecordingBuffer(maxBytes: number): Promise<RecordingBuffer> {
  let store: RecordingPartStore | undefined;
  try {
    // Without cross-tab locks, keep captures in bounded memory instead of risking
    // deletion of another tab's paused recording or pending upload.
    if (!navigator.storage?.getDirectory || !navigator.locks?.request) return createBufferedRecording(maxBytes);
    store = await createTemporaryRecordingStore(navigator.storage, navigator.locks);

    let capacity = maxBytes;
    try {
      const estimate = await navigator.storage.estimate();
      if (typeof estimate.quota === 'number' && typeof estimate.usage === 'number') {
        capacity = Math.min(capacity, Math.max(MIB, Math.floor((estimate.quota - estimate.usage) * 0.8)));
      }
    } catch { /* The storage estimate is advisory; writes still report real quota failures. */ }
    return createBufferedRecording(capacity, store);
  } catch {
    await store?.dispose().catch(() => {});
    return createBufferedRecording(maxBytes);
  }
}
