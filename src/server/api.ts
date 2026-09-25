import { sha256 } from '@noble/hashes/sha2.js';
import { AuthUnavailableError, clearSessionCookie, createSessionCookie, hasSession, validAccessCode, validViewerToken, viewerToken, type AuthConfig } from './auth';
import { DatabaseUnavailableError } from './repository';
import { fixedLengthBody, StorageUnavailableError, type StorageRuntime } from './storage';
import { RecordingStorageError, streamMultipartRecording } from './recording-storage';
import { MAX_RECORDING_BYTES, MAX_MARKDOWN_BYTES, MAX_SINGLE_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES, MAX_DURATION_SECONDS } from '../shared/policy';
import type { MarkdownService, MarkdownView, RecordingPart, RecordingRow, Repository } from './types';

export const MAX_VIDEO_BYTES = MAX_RECORDING_BYTES;
export { MAX_DURATION_SECONDS } from '../shared/policy';
const MAX_JSON_BYTES = 24 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VIDEO_TYPES = new Set(['video/webm', 'video/mp4']);

type Resolvable<T> = T | (() => T);
export interface ApiOptions {
  repository: Resolvable<Repository>;
  auth: Resolvable<AuthConfig>;
  markdown?: Resolvable<MarkdownService>;
  now?: () => Date;
  randomUUID?: () => string;
  storageDiagnostics?: () => unknown;
}

export interface RecordingMetadata {
  id: string;
  title: string;
  durationSeconds: number;
  sizeBytes: number;
  contentType: string;
  createdAt: string;
  videoUrl: string;
  sharePath: string;
  isOwner: boolean;
  protected: boolean;
  markdownEnabled: boolean;
  markdownEligible: boolean;
  maxMarkdownBytes: number;
}

interface UploadInput {
  requestId?: string;
  title: string;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number;
}

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function resolve<T>(value: Resolvable<T>): T { return typeof value === 'function' ? (value as () => T)() : value; }

export function createApiHandler(runtime: Resolvable<StorageRuntime>, options: ApiOptions) {
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());

  return async function handleApiRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/config' && request.method === 'GET') {
        let configured = true;
        try { resolve(runtime); resolve(options.repository); resolve(options.auth); } catch { configured = false; }
        return json({ maxBytes: MAX_VIDEO_BYTES, maxDurationSeconds: MAX_DURATION_SECONDS, maxMarkdownBytes: MAX_MARKDOWN_BYTES, configured });
      }
      const auth = resolve(options.auth);
      let owner = await hasSession(request, auth, now());

      if (url.pathname === '/api/session') {
        if (request.method === 'GET') return json({ authenticated: owner });
        assertSameOrigin(request);
        if (request.method === 'DELETE') return json({ authenticated: false }, 200, { 'set-cookie': clearSessionCookie(request) });
        requireMethod(request, 'POST');
        const input = await readRequestJson(request);
        if (!isObject(input) || !(await validAccessCode(auth, input.accessCode))) {
          throw new ApiError(401, 'invalid_access_code', 'That access code is not correct.');
        }
        return json({ authenticated: true }, 200, { 'set-cookie': await createSessionCookie(request, auth, now()) });
      }

      const repository = resolve(options.repository);
      if (url.pathname === '/api/recordings/uploads') {
        requireMethod(request, 'POST');
        assertWrite(request, owner);
        const input = parseUploadInput(await readRequestJson(request));
        const id = randomUUID();
        let recording = await repository.createRecording({
          id, requestId: input.requestId ?? randomUUID(), uploadId: randomUUID(), title: input.title,
          contentType: input.contentType, sizeBytes: input.sizeBytes, durationSeconds: input.durationSeconds,
          createdAt: now().toISOString(), objectKey: `recordings/${id}/video`, transferId: null, uploadSha256: null, uploadAttempted: false,
          uploadState: 'pending', protected: false, markdownEnabled: false,
        });
        if (!sameInput(input, recording)) throw new ApiError(409, 'upload_request_conflict', 'This upload request was already used for a different recording.');
        if (recording.storageMode === 'parts') return reservationResponse(recording, recording.uploadState === 'ready');
        if (recording.uploadState === 'ready' || recording.uploadSha256) return reservationResponse(recording, true);
        const reserved = await reserve(resolve(runtime), recording);
        recording = await repository.attachTransfer(recording.id, reserved.transferId);
        return reservationResponse(recording, reserved.state === 'completed');
      }

      const route = /^\/api\/recordings\/([^/]+)(?:\/(upload|complete|video|markdown)(?:\/(download))?)?$/.exec(url.pathname);
      if (!route || !isUuid(route[1]) || (route[3] && route[2] !== 'markdown')) throw notFound();
      const id = route[1].toLowerCase();
      const action = route[2];
      const viewMode = url.searchParams.get('view');
      if (action !== 'upload' && action !== 'complete') {
        if (viewMode === 'public') {
          owner = false;
          if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(403, 'read_only_view', 'This sharing view is read-only.');
        } else if (viewMode === 'manage' && !owner) throw new ApiError(401, 'authentication_required', 'Enter your access code to manage this recording.');
      }
      let recording = await repository.getRecording(id);

      if (action === 'upload' || action === 'complete') {
        requireMethod(request, action === 'upload' ? 'PUT' : 'POST');
        assertWrite(request, owner);
        let uploadId: unknown = url.searchParams.get('uploadId');
        if (action === 'complete') {
          const input = await readRequestJson(request);
          uploadId = isObject(input) ? input.uploadId : null;
        }
        if (!isUuid(uploadId)) throw new ApiError(400, 'invalid_upload', 'A valid upload token is required.');
        if (!recording || recording.uploadId !== uploadId.toLowerCase()) throw new ApiError(404, 'upload_not_found', 'This upload could not be found.');
        if (action === 'upload') {
          if (recording.storageMode === 'parts') return await uploadPart(request, resolve(runtime), repository, recording);
          return await uploadVideo(request, resolve(runtime), repository, recording);
        }
        if (recording.storageMode === 'parts') {
          if (recording.uploadState !== 'ready') {
            const completed = await completeMultipart(resolve(runtime), repository, recording);
            if (!completed) return pendingResponse();
            recording = completed;
          }
          return json(await metadata(recording, true, auth, null));
        }
        if (recording.uploadState !== 'ready') {
          if (!recording.transferId) return pendingResponse();
          const transferId = recording.transferId;
          if (!recording.uploadSha256) {
            const owner = crypto.randomUUID();
            const claimed = await repository.claimUpload(recording.id, owner);
            if (!claimed) return pendingResponse();
            try {
              // Signed reads are granted only after the gateway has registered its receipt.
              if (!claimed.uploadSha256 && (await resolve(runtime).storage.completeUpload(transferId)).state !== 'completed') return pendingResponse();
              const digest = claimed.uploadSha256 ?? await storedVideoDigest(resolve(runtime), claimed);
              if (!digest) return pendingResponse();
              const saved = await repository.saveUploadDigest(recording.id, owner, digest);
              if (!saved) return pendingResponse();
              recording = saved;
            } finally { await repository.releaseUpload(recording.id, owner); }
          }
          const completion = await resolve(runtime).storage.completeUpload(transferId);
          if (completion.state !== 'completed') return pendingResponse();
          recording = await repository.completeRecording(id);
        }
        return json(await metadata(recording, true, auth, null));
      }

      if (!recording || recording.uploadState !== 'ready') throw notFound();
      if (!action && request.method === 'PATCH') {
        assertWrite(request, owner);
        const input = await readRequestJson(request);
        if (!isObject(input) || !Object.keys(input).length || Object.keys(input).some(key => key !== 'protected' && key !== 'markdownEnabled') ||
          (input.protected !== undefined && typeof input.protected !== 'boolean') || (input.markdownEnabled !== undefined && typeof input.markdownEnabled !== 'boolean')) {
          throw new ApiError(400, 'invalid_settings', 'Choose a valid sharing option.');
        }
        recording = await repository.updateRecording(id, input as { protected?: boolean; markdownEnabled?: boolean });
        return json(await metadata(recording, true, auth, null, viewMode));
      }

      if (action === 'markdown' && request.method === 'POST' && !route[3]) {
        assertWrite(request, owner);
        if (recording.sizeBytes > MAX_MARKDOWN_BYTES) throw new ApiError(413, 'markdown_too_large', 'Markdown is available for recordings up to 50 MiB.');
        const input = await readRequestJson(request);
        if (!isObject(input) || typeof input.goal !== 'string' || input.goal.length > 4000 || !isUuid(input.requestId)) {
          throw new ApiError(400, 'invalid_goal', 'Use a goal of 4,000 characters or fewer and a valid request ID.');
        }
        if (!recording.markdownEnabled) throw new ApiError(409, 'markdown_disabled', 'Turn on Generate Markdown first.');
        if (!options.markdown) throw new ApiError(503, 'markdown_unavailable', 'Markdown generation is not connected yet.');
        return json(await resolve(options.markdown).generate(recording, input.goal.trim(), input.requestId.toLowerCase()), 202);
      }

      if (!owner && recording.protected && !(await validViewerToken(auth, id, url.searchParams.get('token')))) {
        throw new ApiError(403, 'access_denied', 'This recording needs its complete protected link.');
      }
      if (action === 'video') {
        if (request.method !== 'GET' && request.method !== 'HEAD') requireMethod(request, 'GET');
        if (recording.storageMode === 'parts') return await streamMultipartRecording(request, resolve(runtime), recording, await repository.listParts(recording.id));
        return await streamVideo(request, resolve(runtime), recording);
      }
      if (action === 'markdown') {
        requireMethod(request, 'GET');
        if (!recording.markdownEnabled && !owner) {
          if (route[3]) throw notFound();
          return json({ enabled: false, status: 'idle', markdown: null } satisfies MarkdownView);
        }
        const view = options.markdown
          ? await resolve(options.markdown).status(recording, true)
          : await storedMarkdown(repository, recording);
        if (route[3]) {
          if (!view.markdown) throw new ApiError(404, 'markdown_not_ready', 'Markdown is not ready yet.');
          const headers = commonHeaders();
          headers.set('content-type', 'text/markdown; charset=utf-8');
          headers.set('content-disposition', `attachment; filename="slop-rooster-${id}.md"`);
          return new Response(view.markdown, { headers });
        }
        return json(view);
      }
      requireMethod(request, 'GET');
      return json(await metadata(recording, owner, auth, url.searchParams.get('token'), viewMode));
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status);
      if (error instanceof RecordingStorageError) return json({ error: error.message, code: error.code }, error.status);
      if (error instanceof AuthUnavailableError) return json({ error: 'Access is not configured yet. Please try again later.', code: 'auth_unavailable' }, 503);
      if (error instanceof DatabaseUnavailableError) return json({ error: 'The database is not connected yet. Please try again later.', code: 'database_unavailable' }, 503);
      if (error instanceof StorageUnavailableError) return json({ error: 'Storage is not connected yet. Please try again later.', code: 'storage_unavailable' }, 503);
      const code = errorCode(error);
      if (code === 'storage_quota_exceeded') return json({ error: 'Storage is full. Your recording has not been shared.', code }, 507);
      if (code === 'storage_upload_expired') return json({ error: 'This upload expired. Please upload your recording again.', code }, 409);
      if (code === 'request_conflict') return json({ error: 'This generation request was already used with a different goal.', code }, 409);
      if (code === 'generation_busy') return json({ error: 'A generation is already being started. Please retry.', code }, 409);
      return json({ error: 'This request could not be completed. Please try again.', code: 'request_failed' }, 502);
    }
  };
}

async function metadata(recording: RecordingRow, isOwner: boolean, auth: AuthConfig, suppliedToken: string | null, viewMode?: string | null): Promise<RecordingMetadata> {
  const token = recording.protected ? (isOwner ? await viewerToken(auth, recording.id) : suppliedToken) : null;
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  const videoQuery = new URLSearchParams(token ? { token } : {});
  if (viewMode === 'public' || viewMode === 'manage') videoQuery.set('view', viewMode);
  return {
    id: recording.id, title: recording.title, durationSeconds: recording.durationSeconds, sizeBytes: recording.sizeBytes,
    contentType: recording.contentType, createdAt: recording.createdAt, isOwner, protected: recording.protected,
    markdownEnabled: recording.markdownEnabled, markdownEligible: recording.sizeBytes <= MAX_MARKDOWN_BYTES, maxMarkdownBytes: MAX_MARKDOWN_BYTES,
    videoUrl: `/api/recordings/${recording.id}/video${videoQuery.size ? `?${videoQuery}` : ''}`, sharePath: `/v/${recording.id}${query}`,
  };
}

function reserve(runtime: StorageRuntime, recording: RecordingRow) {
  return runtime.storage.reserveUpload({ idempotencyKey: `video:${recording.uploadId}`, objectKey: recording.objectKey, contentType: recording.contentType, contentLength: recording.sizeBytes });
}

function reservationResponse(recording: RecordingRow, alreadyUploaded: boolean) {
  return json({ id: recording.id, uploadId: recording.uploadId,
    uploadUrl: alreadyUploaded ? null : `/api/recordings/${recording.id}/upload?uploadId=${recording.uploadId}`,
    headers: { 'content-type': recording.contentType }, alreadyUploaded,
    ...(recording.storageMode === 'parts' ? { chunkSizeBytes: recording.chunkSizeBytes, partCount: recording.partCount } : {}),
  }, 201);
}

function pendingResponse() { return json({ state: 'pending', retryAfterSeconds: 2 }, 202, { 'retry-after': '2' }); }

function partRecording(recording: RecordingRow, part: RecordingPart): RecordingRow {
  return { ...recording, uploadId: `${recording.uploadId}:part:${part.index}`, objectKey: part.objectKey, sizeBytes: part.sizeBytes,
    transferId: part.transferId, uploadSha256: part.uploadSha256, uploadAttempted: part.uploadAttempted, uploadState: part.uploadState };
}

async function uploadPart(request: Request, runtime: StorageRuntime, repository: Repository, recording: RecordingRow) {
  const value = new URL(request.url).searchParams.get('part');
  if (!value || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) >= (recording.partCount ?? 0)) {
    throw new ApiError(400, 'invalid_upload_part', 'Choose a valid recording part.');
  }
  const index = Number(value);
  const part = await repository.createPart(recording.id, index);
  if (!part || part.sizeBytes > UPLOAD_CHUNK_BYTES) throw new ApiError(409, 'upload_manifest_conflict', 'This upload part is not available.');
  let fence: number | null = null;
  let leaseOwner: string | null = null;
  const required = (value: RecordingPart | null) => {
    if (!value) throw new ApiError(409, 'upload_in_progress', 'This upload part is being verified. Please retry.');
    return partRecording(recording, value);
  };
  // Reuse the bounded digest/uncertain-outcome protocol for each immutable private
  // object. The adapter fences every mutation to this part's current lease.
  const partRepository: Repository = {
    ...repository,
    async claimUpload(_id, owner) {
      const claimed = await repository.claimPart(recording.id, index, owner);
      if (!claimed) return null;
      fence = claimed.leaseVersion;
      leaseOwner = owner;
      return partRecording(recording, claimed);
    },
    async attachTransfer(_id, transferId) {
      return required(await repository.attachPartTransfer(recording.id, index, leaseOwner ?? '', fence ?? -1, transferId));
    },
    async saveUploadDigest(_id, owner, digest) {
      const saved = await repository.savePartDigest(recording.id, index, owner, fence ?? -1, digest);
      return saved ? partRecording(recording, saved) : null;
    },
    async markUploadAttempt(_id, owner, attempted) {
      const saved = await repository.markPartAttempt(recording.id, index, owner, fence ?? -1, attempted);
      return saved ? partRecording(recording, saved) : null;
    },
    releaseUpload: (_id, owner) => repository.releasePart(recording.id, index, owner, fence ?? -1),
  };
  const response = await uploadVideo(request, runtime, partRepository, partRecording(recording, part));
  // A receipt normally settles with this request; a pending receipt remains durable
  // and the explicit completion endpoint resumes it without uploading bytes again.
  await settlePart(runtime, repository, recording, index);
  return response;
}

async function settlePart(runtime: StorageRuntime, repository: Repository, recording: RecordingRow, index: number): Promise<void> {
  const owner = crypto.randomUUID();
  let part = await repository.claimPart(recording.id, index, owner);
  if (!part) return;
  const fence = part.leaseVersion;
  try {
    if (!part.transferId || (!part.uploadSha256 && !part.uploadAttempted)) return;
    if ((await runtime.storage.completeUpload(part.transferId)).state !== 'completed') return;
    if (!part.uploadSha256) {
      const digest = await storedVideoDigest(runtime, partRecording(recording, part));
      if (!digest) return;
      part = await repository.savePartDigest(recording.id, index, owner, fence, digest);
      if (!part) return;
    }
    await repository.completePart(recording.id, index, owner, fence);
  } finally { await repository.releasePart(recording.id, index, owner, fence); }
}

async function completeMultipart(runtime: StorageRuntime, repository: Repository, recording: RecordingRow): Promise<RecordingRow | null> {
  const parts = await repository.listParts(recording.id);
  // No open transaction spans provider requests, and one completion call has a
  // bounded batch even if an interrupted upload left many receipts unresolved.
  await Promise.all(parts.filter(part => part.uploadState !== 'ready' && part.transferId && (part.uploadSha256 || part.uploadAttempted)).slice(0, 8)
    .map(part => settlePart(runtime, repository, recording, part.index)));
  return repository.completeMultipartRecording(recording.id);
}

function digestHex(bytes: Uint8Array) { return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''); }

function lengthError() { return new ApiError(400, 'upload_size_mismatch', 'The upload size does not match this recording.'); }
function replayConflict() { return new ApiError(409, 'upload_content_conflict', 'This upload already contains a different recording.'); }

/** A constant-memory hash: each chunk is discarded as soon as SHA-256 consumes it. */
async function hashBody(body: ReadableStream<Uint8Array>, expected: number, signal?: AbortSignal): Promise<string> {
  const hash = sha256.create();
  const reader = body.getReader();
  let length = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new ApiError(408, 'upload_timeout', 'The upload timed out. Please try again.');
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > expected || length > MAX_VIDEO_BYTES) { await reader.cancel(); throw lengthError(); }
      hash.update(chunk.value);
    }
    if (signal?.aborted) throw new ApiError(408, 'upload_timeout', 'The upload timed out. Please try again.');
    if (length !== expected) throw lengthError();
    return digestHex(hash.digest());
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
    hash.destroy();
  }
}

async function storedVideoDigest(runtime: StorageRuntime, recording: RecordingRow, signal?: AbortSignal): Promise<string | null> {
  let capability;
  try { capability = await runtime.storage.createSignedRead(recording.objectKey); }
  catch (error) { if (errorCode(error) === 'storage_object_not_found') return null; throw error; }
  const response = await runtime.capabilityFetch(new Request(capability.url, { headers: capability.requiredHeaders, redirect: 'manual', signal }));
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new ApiError(502, 'video_unavailable', 'The uploaded recording could not be verified.'); }
  try { return await hashBody(response.body, recording.sizeBytes, signal); }
  catch (error) {
    if (error instanceof ApiError && error.code === 'upload_size_mismatch') throw new ApiError(502, 'stored_video_invalid', 'The uploaded recording could not be verified.');
    throw error;
  }
}

async function uploadVideo(request: Request, runtime: StorageRuntime, repository: Repository, recording: RecordingRow) {
  if (recording.sizeBytes > MAX_SINGLE_UPLOAD_BYTES) throw new ApiError(413, 'upload_part_too_large', 'Upload this recording in its reserved parts.');
  const type = request.headers.get('content-type')?.split(';')[0].trim();
  if (type !== recording.contentType) throw new ApiError(415, 'invalid_video_type', 'The upload type does not match this recording.');
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== recording.sizeBytes)) throw lengthError();
  if (!request.body) throw new ApiError(400, 'empty_upload', 'The recording must contain video data.');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timeout = setTimeout(cancel, 120_000);
  request.signal.addEventListener('abort', cancel, { once: true });
  let leaseOwner: string | null = null;
  try {
    if (request.signal.aborted) controller.abort();
    if (recording.uploadSha256) {
      if (await hashBody(request.body, recording.sizeBytes, controller.signal) !== recording.uploadSha256) throw replayConflict();
      return new Response(null, { status: 204, headers: commonHeaders() });
    }
    // Only one first PUT may be in flight. Its 120-second request deadline is shorter
    // than the durable 180-second lease, including when an invocation disappears.
    leaseOwner = crypto.randomUUID();
    const claimed = await repository.claimUpload(recording.id, leaseOwner);
    if (!claimed) throw new ApiError(409, 'upload_in_progress', 'This upload is already in progress. Please retry in a moment.');
    recording = claimed;
    let storedDigest = recording.uploadSha256;
    if (!storedDigest && (recording.uploadAttempted || recording.uploadState === 'ready')) {
      if (!recording.transferId) throw new ApiError(502, 'upload_unavailable', 'The original upload could not be verified.');
      const outcome = await runtime.storage.completeUpload(recording.transferId);
      if (outcome.state !== 'completed') throw new ApiError(503, 'upload_outcome_pending', 'Storage is still verifying the original upload. Please retry in a moment.');
      storedDigest = await storedVideoDigest(runtime, recording, controller.signal);
      if (!storedDigest) throw new ApiError(502, 'video_unavailable', 'The uploaded recording could not be verified.');
    }
    if (storedDigest) {
      // The first PUT may have committed even if its response or DB checkpoint was lost.
      // Confirm the original bytes instead of issuing a second PUT to its object key.
      if (!await repository.saveUploadDigest(recording.id, leaseOwner, storedDigest)) throw new ApiError(409, 'upload_in_progress', 'This upload is still being verified. Please retry.');
      if (await hashBody(request.body, recording.sizeBytes, controller.signal) !== storedDigest) throw replayConflict();
      return new Response(null, { status: 204, headers: commonHeaders() });
    }
    if (recording.uploadState === 'ready') throw new ApiError(502, 'video_unavailable', 'The uploaded recording could not be verified.');
    const reserved = await reserve(runtime, recording);
    await repository.attachTransfer(recording.id, reserved.transferId);
    if (reserved.state === 'completed') throw new ApiError(502, 'video_unavailable', 'The uploaded recording could not be verified.');
    const hash = sha256.create();
    let length = 0;
    let forwarded = 0;
    let invalidLength = false;
    let digest: string | null = null;
    const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        length += chunk.byteLength;
        if (length > recording.sizeBytes || length > MAX_VIDEO_BYTES) { invalidLength = true; throw lengthError(); }
        hash.update(chunk);
        forwarded += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        if (length !== recording.sizeBytes) { invalidLength = true; throw lengthError(); }
        digest = digestHex(hash.digest());
      },
    }));
    const headers = new Headers(reserved.capability.requiredHeaders);
    headers.set('content-type', recording.contentType);
    headers.set('content-length', String(recording.sizeBytes));
    let upstream: Response;
    try {
      if (!await repository.markUploadAttempt(recording.id, leaseOwner, true)) throw new ApiError(409, 'upload_in_progress', 'This upload is still being verified. Please retry.');
      let outgoing: Request;
      try {
        outgoing = new Request(reserved.capability.url, {
          method: 'PUT', headers, body: fixedLengthBody(body, recording.sizeBytes), redirect: 'manual', signal: controller.signal, duplex: 'half',
        } as RequestInit);
      } catch {
        throw new ApiError(502, 'upload_request_invalid', 'The upload request could not be prepared. Please try again.');
      }
      try { upstream = await runtime.capabilityFetch(outgoing); }
      catch {
        throw new ApiError(502, 'storage_transfer_unavailable', 'Storage could not receive the upload. Please try again.');
      }
    } catch (error) {
      const wasAborted = controller.signal.aborted;
      if (forwarded < recording.sizeBytes) {
        // A fixed-length object cannot commit before all declared bytes reach the
        // transport. Cancel this attempt before making that known-short retryable.
        controller.abort();
        await repository.markUploadAttempt(recording.id, leaseOwner, false);
      }
      if (invalidLength) {
        // A full-length PUT followed by extra input remains uncertain.
        throw lengthError();
      }
      if (wasAborted) throw new ApiError(408, 'upload_timeout', 'The upload timed out. Please try again.');
      throw error;
    } finally { hash.destroy(); }
    await upstream.body?.cancel();
    if (!upstream.ok) {
      if (upstream.status >= 400 && upstream.status < 500) await repository.markUploadAttempt(recording.id, leaseOwner, false);
      if (invalidLength || !digest) throw lengthError();
      throw new ApiError(502, 'upload_failed', 'The video could not be uploaded. Please try again.');
    }
    if (invalidLength || !digest) throw lengthError();
    if (!await repository.saveUploadDigest(recording.id, leaseOwner, digest)) throw new ApiError(409, 'upload_in_progress', 'This upload is still being verified. Please retry.');
    return new Response(null, { status: 204, headers: commonHeaders() });
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', cancel);
    if (leaseOwner) await repository.releaseUpload(recording.id, leaseOwner);
  }
}

async function streamVideo(request: Request, runtime: StorageRuntime, recording: RecordingRow) {
  const headers = new Headers();
  const range = request.headers.get('range');
  if (range) {
    if (range.length > 80 || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw new ApiError(416, 'invalid_range', 'Only one valid video byte range can be requested.');
    headers.set('range', range);
  }
  const ifRange = request.headers.get('if-range');
  if (ifRange && ifRange.length <= 256) headers.set('if-range', ifRange);
  const capability = await runtime.storage.createSignedRead(recording.objectKey);
  for (const [name, value] of Object.entries(capability.requiredHeaders)) headers.set(name, value);
  const upstream = await runtime.capabilityFetch(new Request(capability.url, { method: 'GET', headers, redirect: 'manual' }));
  if (![200, 206, 416].includes(upstream.status)) { await upstream.body?.cancel(); throw new ApiError(502, 'video_unavailable', 'The recording could not be loaded. Please try again.'); }
  const responseHeaders = commonHeaders();
  responseHeaders.set('content-type', recording.contentType);
  responseHeaders.set('content-disposition', 'inline');
  for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  if (request.method === 'HEAD') { await upstream.body?.cancel(); return new Response(null, { status: upstream.status, headers: responseHeaders }); }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

async function storedMarkdown(repository: Repository, recording: RecordingRow): Promise<MarkdownView> {
  const job = await repository.getLatestJob(recording.id);
  return { enabled: recording.markdownEnabled, status: job?.status ?? 'idle', markdown: job?.markdown ?? null, ...(job ? { jobId: job.id } : {}), ...(job?.error ? { error: job.error } : {}) };
}

async function readRequestJson(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new ApiError(415, 'unsupported_content_type', 'Send this request as JSON.');
  try { return JSON.parse(await readBoundedText(request)); }
  catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'invalid_json', 'This request contains invalid JSON.'); }
}

async function readBoundedText(request: Request) {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_JSON_BYTES)) throw new ApiError(413, 'request_too_large', 'This request is too large.');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let length = 0, text = '';
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_JSON_BYTES) { await reader.cancel(); throw new ApiError(413, 'request_too_large', 'This request is too large.'); }
      text += decoder.decode(result.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

function parseUploadInput(value: unknown): UploadInput {
  if (!isObject(value)) throw new ApiError(400, 'invalid_recording', 'Recording details are required.');
  if (value.id !== undefined && !isUuid(value.id)) throw new ApiError(400, 'invalid_request_id', 'A valid upload request ID is required.');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(value.title)) throw new ApiError(400, 'invalid_title', 'Use a recording title between 1 and 100 characters.');
  if (typeof value.contentType !== 'string' || !VIDEO_TYPES.has(value.contentType)) throw new ApiError(415, 'invalid_video_type', 'Only WebM and MP4 recordings are supported.');
  if (!Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) < 1) throw new ApiError(400, 'invalid_size', 'The recording must contain video data.');
  if (Number(value.sizeBytes) > MAX_VIDEO_BYTES) throw new ApiError(413, 'recording_too_large', 'Recordings must be 1 GiB or smaller.');
  if (typeof value.durationSeconds !== 'number' || !Number.isFinite(value.durationSeconds) || value.durationSeconds < 0) throw new ApiError(400, 'invalid_duration', 'Use a finite, nonnegative recording duration.');
  return { ...(value.id ? { requestId: String(value.id).toLowerCase() } : {}), title: value.title.trim(), contentType: value.contentType, sizeBytes: Number(value.sizeBytes), durationSeconds: value.durationSeconds };
}

function sameInput(input: UploadInput, recording: RecordingRow) { return input.title === recording.title && input.contentType === recording.contentType && input.sizeBytes === recording.sizeBytes && input.durationSeconds === recording.durationSeconds; }
function assertWrite(request: Request, owner: boolean) { assertSameOrigin(request); if (!owner) throw new ApiError(401, 'authentication_required', 'Enter your access code to continue.'); }
function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if ((origin !== null && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError(403, 'cross_origin_request', 'Use this website to make changes.');
}
function requireMethod(request: Request, expected: string) { if (request.method !== expected) throw new ApiError(405, 'method_not_allowed', `This endpoint accepts ${expected} requests.`); }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isUuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function errorCode(value: unknown) { return isObject(value) && typeof value.code === 'string' ? value.code : null; }
function notFound() { return new ApiError(404, 'not_found', 'This recording could not be found.'); }
function commonHeaders() { return new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow' }); }
function json(value: unknown, status = 200, extraHeaders?: Record<string, string>) {
  const headers = commonHeaders();
  headers.set('content-type', 'application/json; charset=utf-8');
  for (const [key, value] of Object.entries(extraHeaders ?? {})) headers.set(key, value);
  return new Response(JSON.stringify(value), { status, headers });
}
