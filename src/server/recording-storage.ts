import { sha256 } from '@noble/hashes/sha2.js';
import { fixedLengthBody, type StorageRuntime } from './storage';
import type { RecordingPart, RecordingRow } from './types';

export class RecordingStorageError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'RecordingStorageError';
  }
}

interface ManifestPart {
  objectKey: string;
  sizeBytes: number;
  offset: number;
}

interface PartSlice {
  part: ManifestPart;
  start: number;
  end: number;
}

interface OpenPart {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  expected: number;
  received: number;
}

const unavailable = () => new RecordingStorageError(502, 'video_unavailable', 'The recording could not be loaded. Please try again.');
const cancelled = () => new RecordingStorageError(499, 'video_request_cancelled', 'The recording request was cancelled.');
const invalidManifest = () => new RecordingStorageError(502, 'recording_manifest_invalid', 'The recording could not be verified.');
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Snapshot the completed manifest so later mutation cannot change a stream in progress. */
function validateManifest(recording: RecordingRow, parts: RecordingPart[]) {
  const { sizeBytes, partCount, chunkSizeBytes } = recording;
  if (recording.storageMode !== 'parts' || recording.uploadState !== 'ready'
    || !positiveInteger(sizeBytes) || !positiveInteger(partCount) || !positiveInteger(chunkSizeBytes)
    || partCount !== Math.ceil(sizeBytes / chunkSizeBytes) || parts.length !== partCount) throw invalidManifest();

  const keys = new Set<string>();
  const snapshot: ManifestPart[] = [];
  const hash = sha256.create();
  const encoder = new TextEncoder();
  let offset = 0;
  try {
    hash.update(encoder.encode(JSON.stringify(['multipart-v1', recording.id, recording.contentType, sizeBytes, partCount, chunkSizeBytes])));
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      const expectedSize = Math.min(chunkSizeBytes, sizeBytes - offset);
      if (!part || part.index !== index || part.recordingId !== recording.id || part.uploadState !== 'ready'
        || !positiveInteger(part.sizeBytes) || part.sizeBytes !== expectedSize
        || typeof part.objectKey !== 'string' || !part.objectKey || keys.has(part.objectKey)
        || typeof part.transferId !== 'string' || !part.transferId
        || typeof part.uploadSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(part.uploadSha256)) throw invalidManifest();
      keys.add(part.objectKey);
      snapshot.push({ objectKey: part.objectKey, sizeBytes: part.sizeBytes, offset });
      hash.update(encoder.encode(JSON.stringify([index, part.sizeBytes, part.uploadSha256])));
      offset += part.sizeBytes;
    }
    if (offset !== sizeBytes) throw invalidManifest();
    const digest = [...hash.digest()].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return { parts: snapshot, etag: `"multipart-${digest}"` };
  } finally { hash.destroy(); }
}

/** BigInt preserves the meaning of valid ranges even when an end exceeds JS's integer precision. */
function parseRange(value: string, size: number): { start: number; end: number } | null {
  if (value.length > 80) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const total = BigInt(size);
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (suffix === 0n) return null;
    return { start: Number(suffix >= total ? 0n : total - suffix), end: size - 1 };
  }
  const start = BigInt(match[1]);
  const end = match[2] ? BigInt(match[2]) : total - 1n;
  if (start >= total || end < start) return null;
  return { start: Number(start), end: Number(end >= total ? total - 1n : end) };
}

async function discardBody(response: Response) {
  try { await response.body?.cancel(); } catch { /* Never expose provider cancellation errors. */ }
}

/**
 * Concatenate immutable private objects without buffering the complete recording.
 * Only the first part's headers are fetched before returning; subsequent parts
 * and all body reads follow consumer demand. No signed capability reaches clients.
 */
export async function streamMultipartRecording(
  request: Request,
  runtime: StorageRuntime,
  recording: RecordingRow,
  parts: RecordingPart[],
): Promise<Response> {
  const manifest = validateManifest(recording, parts);
  const headers = new Headers({
    'content-type': recording.contentType,
    'content-disposition': 'inline',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    etag: manifest.etag,
  });
  let selection = { start: 0, end: recording.sizeBytes - 1 };
  let status = 200;
  const range = request.headers.get('range');
  const ifRange = request.headers.get('if-range');
  // Dates and weak validators cannot establish identity for this immutable manifest.
  if (range !== null && (ifRange === null || ifRange === manifest.etag)) {
    const parsed = parseRange(range, recording.sizeBytes);
    if (!parsed) {
      headers.set('content-range', `bytes */${recording.sizeBytes}`);
      headers.set('content-length', '0');
      return new Response(null, { status: 416, headers });
    }
    selection = parsed;
    status = 206;
    headers.set('content-range', `bytes ${selection.start}-${selection.end}/${recording.sizeBytes}`);
  }
  headers.set('content-length', String(selection.end - selection.start + 1));
  if (request.method === 'HEAD') return new Response(null, { status, headers });

  const slices: PartSlice[] = manifest.parts
    .filter(part => part.offset <= selection.end && part.offset + part.sizeBytes > selection.start)
    .map(part => ({ part, start: Math.max(0, selection.start - part.offset), end: Math.min(part.sizeBytes - 1, selection.end - part.offset) }));
  const abort = new AbortController();
  let active: OpenPart | null = null;
  let nextPart = 0;
  let finished = false;
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;

  const detach = () => request.signal.removeEventListener('abort', onAbort);
  async function stop() {
    detach();
    abort.abort();
    const current = active;
    active = null;
    if (current) {
      try { await current.reader.cancel(); } catch { /* The public error is deliberately fixed. */ }
      try { current.reader.releaseLock(); } catch { /* A pending read may already have released its lock. */ }
    }
  }
  function onAbort() {
    if (finished) return;
    finished = true;
    output?.error(cancelled());
    void stop();
  }

  async function openPart(slice: PartSlice): Promise<OpenPart> {
    let response: Response;
    try {
      if (abort.signal.aborted) throw cancelled();
      const capability = await runtime.storage.createSignedRead(slice.part.objectKey);
      if (abort.signal.aborted) throw cancelled();
      const upstreamHeaders = new Headers(capability.requiredHeaders);
      upstreamHeaders.set('range', `bytes=${slice.start}-${slice.end}`);
      response = await runtime.capabilityFetch(new Request(capability.url, {
        method: 'GET', headers: upstreamHeaders, redirect: 'manual', signal: abort.signal,
      }));
    } catch {
      throw abort.signal.aborted ? cancelled() : unavailable();
    }

    const expected = slice.end - slice.start + 1;
    const wholePart = slice.start === 0 && slice.end === slice.part.sizeBytes - 1;
    const contentLength = response.headers.get('content-length');
    const contentRange = response.headers.get('content-range');
    const contentEncoding = response.headers.get('content-encoding');
    const correctStatus = response.status === 206
      ? contentRange === `bytes ${slice.start}-${slice.end}/${slice.part.sizeBytes}`
      : response.status === 200 && wholePart && contentRange === null;
    if (abort.signal.aborted || !correctStatus || contentLength !== String(expected) || !response.body
      || (contentEncoding !== null && contentEncoding !== 'identity')) {
      await discardBody(response);
      throw abort.signal.aborted ? cancelled() : unavailable();
    }
    return { reader: response.body.getReader(), expected, received: 0 };
  }

  request.signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (request.signal.aborted) onAbort();
    active = await openPart(slices[nextPart++]);
    if (finished) throw cancelled();
  } catch (error) {
    finished = true;
    await stop();
    throw error instanceof RecordingStorageError ? error : unavailable();
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) { output = controller; },
    async pull(controller) {
      if (finished) return;
      try {
        while (!finished) {
          if (!active) {
            if (nextPart === slices.length) {
              finished = true;
              detach();
              controller.close();
              return;
            }
            active = await openPart(slices[nextPart++]);
            if (finished) { await stop(); return; }
          }
          const current = active;
          const result = await current.reader.read();
          if (finished) return;
          if (result.done) {
            current.reader.releaseLock();
            active = null;
            if (current.received !== current.expected) throw unavailable();
            continue;
          }
          if (!(result.value instanceof Uint8Array)) throw unavailable();
          current.received += result.value.byteLength;
          if (current.received > current.expected) throw unavailable();
          if (result.value.byteLength === 0) continue;
          controller.enqueue(result.value);
          return;
        }
      } catch (error) {
        if (finished) return;
        finished = true;
        controller.error(error instanceof RecordingStorageError ? error : unavailable());
        await stop();
      }
    },
    async cancel() {
      finished = true;
      await stop();
    },
  }, { highWaterMark: 0 });
  return new Response(fixedLengthBody(body, selection.end - selection.start + 1), { status, headers });
}
