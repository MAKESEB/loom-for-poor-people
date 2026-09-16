import { StorageUnavailableError, type StorageRuntime } from './storage';

export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_DURATION_SECONDS = 15 * 60;
const MAX_JSON_BYTES = 8 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VIDEO_TYPES = new Set(['video/webm', 'video/mp4']);

export interface RecordingMetadata {
  id: string;
  title: string;
  durationSeconds: number;
  sizeBytes: number;
  contentType: string;
  createdAt: string;
  videoUrl: string;
  sharePath: string;
}

interface UploadInput {
  requestId?: string;
  title: string;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number;
}

interface PendingUpload {
  version: 1;
  uploadId: string;
  transferId: string;
  recording: RecordingMetadata;
}

interface ApiOptions {
  now?: () => Date;
  randomUUID?: () => string;
  storageDiagnostics?: () => unknown;
}

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const objectKey = (id: string) => `recordings/${id}/video`;
const metadataKey = (id: string) => `recordings/${id}/metadata.json`;
const pendingKey = (uploadId: string) => `pending/${uploadId}.json`;
const requestKey = (requestId: string) => `requests/${requestId}.json`;

export function createApiHandler(runtime: StorageRuntime | (() => StorageRuntime), options: ApiOptions = {}) {
  const getRuntime = () => typeof runtime === 'function' ? runtime() : runtime;
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());

  return async function handleApiRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/config' && request.method === 'GET') {
        let configured = true;
        try { getRuntime(); } catch { configured = false; }
        return json({
          maxBytes: MAX_VIDEO_BYTES,
          maxDurationSeconds: MAX_DURATION_SECONDS,
          configured,
          ...(options.storageDiagnostics ? { storage: options.storageDiagnostics() } : {}),
        });
      }

      if (url.pathname === '/api/recordings/uploads') {
        requireMethod(request, 'POST');
        assertSameOrigin(request);
        const input = parseUploadInput(await readRequestJson(request));
        const active = getRuntime();
        let pending: PendingUpload;

        const previous = input.requestId ? await readJsonObject(active, requestKey(input.requestId)) : null;
        if (previous) {
          if (!isObject(previous) || !isUuid(previous.uploadId)) throw invalidStoredObject();
          const existing = await readJsonObject(active, pendingKey(previous.uploadId));
          pending = parsePending(existing);
          if (!sameInput(input, pending.recording)) {
            throw new ApiError(409, 'upload_request_conflict', 'This upload request was already used for a different recording.');
          }
        } else {
          const id = randomUUID();
          const uploadId = randomUUID();
          const reservation = await active.storage.reserveUpload({
            idempotencyKey: `video:${uploadId}`,
            objectKey: objectKey(id),
            contentType: input.contentType,
            contentLength: input.sizeBytes,
          });
          pending = {
            version: 1,
            uploadId,
            transferId: reservation.transferId,
            recording: {
              id,
              title: input.title,
              contentType: input.contentType,
              sizeBytes: input.sizeBytes,
              durationSeconds: input.durationSeconds,
              createdAt: now().toISOString(),
              videoUrl: `/api/recordings/${id}/video`,
              sharePath: `/v/${id}`,
            },
          };
          await writeJsonObject(active, pendingKey(uploadId), pending, `pending:${uploadId}`);
          if (input.requestId) {
            await writeJsonObject(active, requestKey(input.requestId), { uploadId }, `request:${input.requestId}`);
          }
          return reservationResponse(pending, reservation);
        }

        const reservation = await active.storage.reserveUpload({
          idempotencyKey: `video:${pending.uploadId}`,
          objectKey: objectKey(pending.recording.id),
          contentType: pending.recording.contentType,
          contentLength: pending.recording.sizeBytes,
        });
        return reservationResponse(pending, reservation);
      }

      const route = /^\/api\/recordings\/([^/]+)(?:\/(complete|video))?$/.exec(url.pathname);
      if (!route || !isUuid(route[1])) {
        throw new ApiError(404, 'not_found', 'This recording could not be found.');
      }
      const id = route[1].toLowerCase();
      const action = route[2];

      if (action === 'complete') {
        requireMethod(request, 'POST');
        assertSameOrigin(request);
        const input = await readRequestJson(request);
        if (!isObject(input) || !isUuid(input.uploadId)) {
          throw new ApiError(400, 'invalid_upload', 'A valid upload token is required.');
        }
        const active = getRuntime();
        const rawPending = await readJsonObject(active, pendingKey(input.uploadId.toLowerCase()));
        if (rawPending === null) throw new ApiError(404, 'upload_not_found', 'This upload could not be found.');
        const pending = parsePending(rawPending);
        if (pending.recording.id !== id || pending.uploadId !== input.uploadId.toLowerCase()) {
          throw new ApiError(404, 'upload_not_found', 'This upload could not be found.');
        }

        const existing = await readJsonObject(active, metadataKey(id));
        if (existing !== null) return json(parseRecording(existing, id));

        const completion = await active.storage.completeUpload(pending.transferId);
        if (completion.state !== 'completed') {
          return json({ state: 'pending', retryAfterSeconds: 2 }, 202, { 'retry-after': '2' });
        }
        await writeJsonObject(active, metadataKey(id), pending.recording, `publish:${pending.uploadId}`);
        return json(pending.recording);
      }

      if (action === 'video') {
        if (request.method !== 'GET' && request.method !== 'HEAD') requireMethod(request, 'GET');
        const active = getRuntime();
        const metadata = await getRecording(active, id);
        return await streamVideo(request, active, metadata);
      }

      requireMethod(request, 'GET');
      return json(await getRecording(getRuntime(), id));
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status);
      if (error instanceof StorageUnavailableError) {
        return json({ error: 'Storage is not connected yet. Please try again later.', code: 'storage_unavailable' }, 503);
      }
      const code = errorCode(error);
      if (code === 'storage_quota_exceeded') {
        return json({ error: 'Storage is full. Your recording has not been shared.', code }, 507);
      }
      if (code === 'storage_upload_expired') {
        return json({ error: 'This upload expired. Please upload your recording again.', code }, 409);
      }
      return json({ error: 'Storage could not finish this request. Please try again.', code: 'storage_error' }, 502);
    }
  };
}

function reservationResponse(pending: PendingUpload, reservation: Awaited<ReturnType<StorageRuntime['storage']['reserveUpload']>>) {
  return json({
    id: pending.recording.id,
    uploadId: pending.uploadId,
    uploadUrl: reservation.state === 'ready' ? reservation.capability.url : null,
    headers: reservation.state === 'ready' ? reservation.capability.requiredHeaders : {},
    alreadyUploaded: reservation.state === 'completed',
  }, 201);
}

async function getRecording(runtime: StorageRuntime, id: string): Promise<RecordingMetadata> {
  const raw = await readJsonObject(runtime, metadataKey(id));
  if (raw === null) throw new ApiError(404, 'not_found', 'This recording could not be found.');
  return parseRecording(raw, id);
}

async function streamVideo(request: Request, runtime: StorageRuntime, metadata: RecordingMetadata) {
  const capability = await runtime.storage.createSignedRead(objectKey(metadata.id));
  const headers = new Headers(capability.requiredHeaders);
  const range = request.headers.get('range');
  if (range) {
    if (range.length > 80 || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) {
      throw new ApiError(416, 'invalid_range', 'Only one valid video byte range can be requested.');
    }
    headers.set('range', range);
  }
  const ifRange = request.headers.get('if-range');
  if (ifRange && ifRange.length <= 256) headers.set('if-range', ifRange);
  const upstream = await runtime.capabilityFetch(new Request(capability.url, { method: 'GET', headers }));
  if (![200, 206, 416].includes(upstream.status)) {
    await upstream.body?.cancel();
    throw new ApiError(502, 'video_unavailable', 'The recording could not be loaded. Please try again.');
  }
  const responseHeaders = commonHeaders();
  responseHeaders.set('content-type', metadata.contentType);
  responseHeaders.set('content-disposition', 'inline');
  responseHeaders.set('cache-control', 'private, max-age=60');
  for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  if (request.method === 'HEAD') {
    await upstream.body?.cancel();
    return new Response(null, { status: upstream.status, headers: responseHeaders });
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

async function readJsonObject(runtime: StorageRuntime, key: string): Promise<unknown | null> {
  let capability;
  try { capability = await runtime.storage.createSignedRead(key); }
  catch (error) {
    if (errorCode(error) === 'storage_object_not_found') return null;
    throw error;
  }
  const response = await runtime.capabilityFetch(new Request(capability.url, { headers: capability.requiredHeaders }));
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw invalidStoredObject();
  }
  try { return JSON.parse(await readBoundedText(response, MAX_JSON_BYTES)); }
  catch { throw invalidStoredObject(); }
}

async function writeJsonObject(runtime: StorageRuntime, key: string, value: unknown, idempotencyKey: string) {
  const uploaded = await runtime.storage.upload({
    objectKey: key,
    idempotencyKey,
    contentType: 'application/json',
    bytes: new TextEncoder().encode(JSON.stringify(value)),
  });
  if (uploaded.state === 'completed') return;
  const completion = await runtime.storage.completeUpload(uploaded.transferId);
  if (completion.state !== 'completed') {
    throw new ApiError(503, 'storage_pending', 'Storage is still saving this recording. Please retry in a moment.');
  }
}

async function readRequestJson(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    throw new ApiError(415, 'unsupported_content_type', 'Send this request as JSON.');
  }
  try { return JSON.parse(await readBoundedText(request, MAX_JSON_BYTES)); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_json', 'This request contains invalid JSON.');
  }
}

async function readBoundedText(source: Request | Response, maximumBytes: number) {
  const declaredLength = source.headers.get('content-length');
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    throw new ApiError(413, 'request_too_large', 'This request is too large.');
  }
  if (!source.body) return '';
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new ApiError(413, 'request_too_large', 'This request is too large.');
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function parseUploadInput(value: unknown): UploadInput {
  if (!isObject(value)) throw new ApiError(400, 'invalid_recording', 'Recording details are required.');
  if (value.id !== undefined && !isUuid(value.id)) {
    throw new ApiError(400, 'invalid_request_id', 'A valid upload request ID is required.');
  }
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(value.title)) {
    throw new ApiError(400, 'invalid_title', 'Use a recording title between 1 and 100 characters.');
  }
  if (typeof value.contentType !== 'string' || !VIDEO_TYPES.has(value.contentType)) {
    throw new ApiError(415, 'invalid_video_type', 'Only WebM and MP4 recordings are supported.');
  }
  if (!Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) < 1) {
    throw new ApiError(400, 'invalid_size', 'The recording must contain video data.');
  }
  if (Number(value.sizeBytes) > MAX_VIDEO_BYTES) {
    throw new ApiError(413, 'recording_too_large', 'Recordings must be 50 MB or smaller.');
  }
  if (typeof value.durationSeconds !== 'number' || !Number.isFinite(value.durationSeconds) || value.durationSeconds < 0 || value.durationSeconds > MAX_DURATION_SECONDS) {
    throw new ApiError(400, 'invalid_duration', 'Recordings must be 15 minutes or shorter.');
  }
  return {
    ...(value.id ? { requestId: String(value.id).toLowerCase() } : {}),
    title: value.title.trim(),
    contentType: value.contentType,
    sizeBytes: Number(value.sizeBytes),
    durationSeconds: value.durationSeconds,
  };
}

function parsePending(value: unknown): PendingUpload {
  if (!isObject(value) || value.version !== 1 || !isUuid(value.uploadId) ||
      typeof value.transferId !== 'string' || value.transferId.length < 1 || value.transferId.length > 128 ||
      !isObject(value.recording) || !isUuid(value.recording.id)) throw invalidStoredObject();
  return { version: 1, uploadId: value.uploadId, transferId: value.transferId, recording: parseRecording(value.recording, value.recording.id) };
}

function parseRecording(value: unknown, id: string): RecordingMetadata {
  if (!isObject(value) || value.id !== id || !isUuid(value.id) ||
      typeof value.title !== 'string' || !value.title || value.title.length > 100 ||
      typeof value.durationSeconds !== 'number' || !Number.isFinite(value.durationSeconds) || value.durationSeconds < 0 || value.durationSeconds > MAX_DURATION_SECONDS ||
      !Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) < 1 || Number(value.sizeBytes) > MAX_VIDEO_BYTES ||
      typeof value.contentType !== 'string' || !VIDEO_TYPES.has(value.contentType) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      value.videoUrl !== `/api/recordings/${id}/video` || value.sharePath !== `/v/${id}`) throw invalidStoredObject();
  return {
    id, title: value.title, durationSeconds: value.durationSeconds, sizeBytes: Number(value.sizeBytes),
    contentType: value.contentType, createdAt: value.createdAt, videoUrl: value.videoUrl, sharePath: value.sharePath,
  };
}

function sameInput(input: UploadInput, recording: RecordingMetadata) {
  return input.title === recording.title && input.contentType === recording.contentType &&
    input.sizeBytes === recording.sizeBytes && input.durationSeconds === recording.durationSeconds;
}

function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if ((origin !== null && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new ApiError(403, 'cross_origin_request', 'Upload recordings from this website.');
  }
}

function requireMethod(request: Request, expected: string) {
  if (request.method !== expected) throw new ApiError(405, 'method_not_allowed', `This endpoint accepts ${expected} requests.`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function errorCode(value: unknown) { return isObject(value) && typeof value.code === 'string' ? value.code : null; }
function invalidStoredObject() { return new ApiError(502, 'invalid_storage_response', 'The recording could not be loaded. Please try again.'); }

function commonHeaders() {
  return new Headers({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
  });
}

function json(value: unknown, status = 200, extraHeaders?: Record<string, string>) {
  const headers = commonHeaders();
  headers.set('content-type', 'application/json; charset=utf-8');
  for (const [key, value] of Object.entries(extraHeaders ?? {})) headers.set(key, value);
  return new Response(JSON.stringify(value), { status, headers });
}
