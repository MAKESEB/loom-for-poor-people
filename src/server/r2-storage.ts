import type { R2BucketLike, R2PutOptionsLike } from './cloudflare-types';
import type { ManagedStorage, StorageCapability, StorageRuntime } from './storage';

/**
 * Emulates the managed private-storage semantics (reservations, idempotency
 * receipts, transfer completion and short-lived capabilities) on one R2 bucket.
 *
 * Transfer records and receipts are small JSON objects under `_meta/`; R2 is
 * strongly consistent for read-after-write. Valid object keys must start with an
 * alphanumeric character, so they can never collide with that prefix.
 *
 * Capabilities are stateless and unsigned: they are only ever created and
 * consumed server-side (the API hands them straight to capabilityFetch), exactly
 * like the managed gateway's signed URLs never reached clients.
 *
 * Like the managed gateway, a transfer that never commits expires
 * (`storage_upload_expired`, which the API answers with 409 and the client with a
 * fresh reservation). Without that, an attempt cancelled mid-PUT would leave its
 * recording waiting for an outcome forever. A committed object is never reported
 * expired, and an attempt that could already have been reported expired can no
 * longer commit.
 */

const CAPABILITY_ORIGIN = 'https://r2-capability.invalid';
const CAPABILITY_TTL_MS = 60 * 60 * 1000;
/** A reserved transfer whose upload never started expires after this long. */
const RESERVATION_TTL_MS = CAPABILITY_TTL_MS;
/**
 * Once an upload started, the transfer expires after this long without upload activity,
 * whether its last attempt failed, stalled or vanished with its invocation. That is well
 * above the API's 60-second idle timeout and its 180-second D1 upload lease, so a live
 * attempt always renews it first, and a failed one can be retried in the meantime.
 */
export const TRANSFER_IDLE_TTL_MS = 5 * 60 * 1000;
/** A streaming PUT records its progress at most this often. */
const HEARTBEAT_MS = 30 * 1000;
const MAX_TOKEN_LENGTH = 8192;
const OBJECT_KEY = /^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const TRANSFER_ID = /^[A-Za-z0-9._:-]{1,128}$/;

type Grant =
  | { v: 1; op: 'GET'; key: string; exp: number }
  | { v: 1; op: 'PUT'; key: string; transferId: string; exp: number };

/**
 * `createdAt` and `activeAt` (the last sign of progress of a started upload) drive
 * expiry; records written before transfers expired have neither and never expire.
 */
interface Transfer { key: string; contentType: string; size: number; completed: boolean; createdAt?: number; activeAt?: number }
interface ReservationInput { idempotencyKey: string; objectKey: string; contentType: string; contentLength: number }
interface Receipt { transferId: string; input: ReservationInput }

type FixedLengthStreamConstructor = new (length: number) => TransformStream<Uint8Array, Uint8Array>;

export interface R2StorageOptions {
  now?: () => number;
  randomUUID?: () => string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const validObjectKey = (key: unknown): key is string =>
  typeof key === 'string' && OBJECT_KEY.test(key) && !key.split('/').some(part => part === '..' || part === '.');
const validTransferId = (id: unknown): id is string => typeof id === 'string' && TRANSFER_ID.test(id);
const validSize = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const optionalTime = (value: unknown) => value === undefined || (typeof value === 'number' && Number.isFinite(value));

function isGrant(value: unknown): value is Grant {
  if (!isRecord(value) || value.v !== 1 || !validObjectKey(value.key) || typeof value.exp !== 'number' || !Number.isFinite(value.exp)) return false;
  if (value.op === 'GET') return value.transferId === undefined;
  return value.op === 'PUT' && validTransferId(value.transferId);
}

function isTransfer(value: unknown): value is Transfer {
  return isRecord(value) && validObjectKey(value.key) && typeof value.contentType === 'string'
    && validSize(value.size) && typeof value.completed === 'boolean' && optionalTime(value.createdAt) && optionalTime(value.activeAt);
}

function isReceipt(value: unknown): value is Receipt {
  if (!isRecord(value) || !validTransferId(value.transferId) || !isRecord(value.input)) return false;
  const input = value.input;
  return typeof input.idempotencyKey === 'string' && typeof input.objectKey === 'string'
    && typeof input.contentType === 'string' && typeof input.contentLength === 'number';
}

function encodeToken(grant: Grant): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(JSON.stringify(grant))) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeToken(token: string): Grant | null {
  if (!token || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const base64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
    return isGrant(value) ? value : null;
  } catch {
    return null;
  }
}

function parseCapabilityUrl(value: string): Grant | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== CAPABILITY_ORIGIN || url.username || url.password || url.search || url.hash) return null;
  const token = url.pathname.slice(1);
  if (token.includes('/')) return null;
  return decodeToken(token);
}

function fixedLengthStream(): FixedLengthStreamConstructor | undefined {
  return (globalThis as typeof globalThis & { FixedLengthStream?: FixedLengthStreamConstructor }).FixedLengthStream;
}

/** Buffers a body whose guard stream already enforces its exact length (Node and local tooling only). */
async function collect(body: ReadableStream<Uint8Array>, size: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const bytes = new Uint8Array(size);
  let offset = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array) || offset + result.value.byteLength > size) throw new TypeError('Unexpected upload chunk');
      bytes.set(result.value, offset);
      offset += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== size) throw new RangeError('Upload length mismatch');
  return bytes;
}

/** The ID of the one transfer an idempotency key maps to, so concurrent first reservations converge on it. */
async function transferIdFor(idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(idempotencyKey));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The upload was aborted.', 'AbortError');
}

async function discardBody(request: Request) {
  try { await request.body?.cancel(); } catch { /* The upload is rejected either way. */ }
}

const missingObject = () => Object.assign(new Error('Missing object'), { code: 'storage_object_not_found', status: 404 });
const uploadExpired = () => Object.assign(new Error('Upload expired'), { code: 'storage_upload_expired', status: 409 });
const isUploadExpired = (error: unknown) => isRecord(error) && error.code === 'storage_upload_expired';
/** 4xx: this attempt certainly did not commit (a short fixed-length body never can). */
const lengthMismatch = () => new Response('Upload length mismatch', { status: 400 });
/** 410: the transfer expired; the API answers storage_upload_expired. */
const expiredResponse = () => new Response('Upload expired', { status: 410 });
/** 5xx: every byte reached R2 but the put failed, and no committed object is visible (yet). */
const outcomeUnknown = () => new Response('Upload outcome unknown', { status: 502 });

export function createR2StorageRuntime(bucket: R2BucketLike, options: R2StorageOptions = {}): StorageRuntime {
  const now = options.now ?? (() => Date.now());
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const transferKey = (id: string) => `_meta/transfers/${id}.json`;
  const receiptKey = (idempotencyKey: string) => `_meta/requests/${idempotencyKey}.json`;

  async function readJson(key: string): Promise<unknown> {
    const object = await bucket.get(key);
    return object ? JSON.parse(await object.text()) as unknown : null;
  }
  async function writeJson(key: string, value: unknown) {
    await bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });
  }
  async function readTransfer(id: string): Promise<Transfer | null> {
    if (!validTransferId(id)) return null;
    const value = await readJson(transferKey(id));
    if (value === null) return null;
    if (!isTransfer(value)) throw new Error('Corrupt transfer record');
    return value;
  }
  const saveTransfer = (id: string, transfer: Transfer) => writeJson(transferKey(id), transfer);
  const newTransfer = (input: ReservationInput): Transfer =>
    ({ key: input.objectKey, contentType: input.contentType, size: input.contentLength, completed: false, createdAt: now() });

  /** Only meaningful for a transfer that has not committed; always check `committed` first. */
  function expired(transfer: Transfer): boolean {
    if (transfer.activeAt !== undefined) return now() - transfer.activeAt > TRANSFER_IDLE_TTL_MS;
    if (transfer.createdAt !== undefined) return now() - transfer.createdAt > RESERVATION_TTL_MS;
    return false;
  }

  /**
   * A transfer is complete once its record says so, or once its object committed
   * with this transfer's marker (the record update may have been interrupted).
   */
  async function committed(id: string, transfer: Transfer): Promise<boolean> {
    if (transfer.completed) return true;
    const object = await bucket.head(transfer.key);
    if (!object || object.size !== transfer.size || object.customMetadata?.transferId !== id) return false;
    await saveTransfer(id, { ...transfer, completed: true }).catch(() => undefined);
    return true;
  }

  function capability(grant: Grant, expectedContentLength: number | null, contentType: string): StorageCapability {
    return {
      operation: grant.op,
      objectKey: grant.key,
      url: `${CAPABILITY_ORIGIN}/${encodeToken(grant)}`,
      expiresAt: new Date(grant.exp).toISOString(),
      expectedContentLength,
      requiredHeaders: grant.op === 'PUT' ? { 'content-type': contentType } : {},
    };
  }
  const putCapability = (transferId: string, input: ReservationInput) =>
    capability({ v: 1, op: 'PUT', key: input.objectKey, transferId, exp: now() + CAPABILITY_TTL_MS }, input.contentLength, input.contentType);

  const storage: ManagedStorage = {
    async reserveUpload(request) {
      if (!IDEMPOTENCY_KEY.test(request.idempotencyKey)) throw new Error('Invalid idempotency key');
      if (!validObjectKey(request.objectKey)) throw new Error('Invalid object key');
      if (!validSize(request.contentLength)) throw new Error('Invalid content length');
      const input: ReservationInput = {
        idempotencyKey: request.idempotencyKey, objectKey: request.objectKey,
        contentType: request.contentType, contentLength: request.contentLength,
      };
      const previousValue = await readJson(receiptKey(input.idempotencyKey));
      if (previousValue !== null) {
        if (!isReceipt(previousValue)) throw new Error('Corrupt upload receipt');
        const previous = previousValue.input;
        if (previous.objectKey !== input.objectKey || previous.contentType !== input.contentType || previous.contentLength !== input.contentLength) {
          throw Object.assign(new Error('Conflicting upload'), { code: 'storage_conflict' });
        }
        const transferId = previousValue.transferId;
        let transfer = await readTransfer(transferId);
        if (!transfer) {
          transfer = newTransfer(input);
          await saveTransfer(transferId, transfer);
        }
        if (await committed(transferId, transfer)) return { state: 'completed', transferId };
        // A replay never extends the deadline; otherwise a stuck upload would never expire.
        if (expired(transfer)) throw uploadExpired();
        return { state: 'ready', transferId, capability: putCapability(transferId, input) };
      }
      // Derived from the key, not random: two concurrent first reservations write the same
      // transfer and receipt instead of binding the key to two transfers.
      const transferId = await transferIdFor(input.idempotencyKey);
      // The transfer exists before its receipt, so a receipt always resolves.
      await saveTransfer(transferId, newTransfer(input));
      await writeJson(receiptKey(input.idempotencyKey), { transferId, input } satisfies Receipt);
      return { state: 'ready', transferId, capability: putCapability(transferId, input) };
    },

    async completeUpload(transferId) {
      const transfer = await readTransfer(transferId);
      if (!transfer) throw Object.assign(new Error('Unknown transfer'), { code: 'storage_transfer_not_found', status: 404 });
      if (await committed(transferId, transfer)) return { state: 'completed', transferId };
      if (expired(transfer)) throw uploadExpired();
      return { state: 'pending', transferId };
    },

    async createSignedRead(objectKey) {
      if (!validObjectKey(objectKey) || !await bucket.head(objectKey)) throw missingObject();
      return capability({ v: 1, op: 'GET', key: objectKey, exp: now() + CAPABILITY_TTL_MS }, null, 'application/octet-stream');
    },

    async deleteObject({ objectKey, idempotencyKey }) {
      if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new Error('Invalid idempotency key');
      if (!validObjectKey(objectKey)) throw new Error('Invalid object key');
      await bucket.delete(objectKey);
      return { state: 'completed', deletionId: idempotencyKey };
    },

    async upload(input) {
      if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) throw new Error('Invalid idempotency key');
      if (!validObjectKey(input.objectKey)) throw new Error('Invalid object key');
      const transferId = randomUUID();
      await bucket.put(input.objectKey, input.bytes, { httpMetadata: { contentType: input.contentType }, customMetadata: { transferId } });
      await saveTransfer(transferId, { key: input.objectKey, contentType: input.contentType, size: input.bytes.byteLength, completed: true, createdAt: now() });
      return { state: 'completed', transferId };
    },
  };

  /**
   * Streams one upload attempt into R2. Like fetch, it honours `request.signal`: an
   * abort errors the body pipe, so R2 rejects the put without committing, and the
   * abort reason is thrown. The answer says whether the attempt could have committed:
   * 200 committed, 4xx certainly not (a fixed-length object cannot commit before all
   * its bytes arrived), 410 expired, 5xx unknown (every byte reached R2, then the put
   * failed without a visible object).
   */
  async function put(request: Request, key: string, transferId: string): Promise<Response> {
    const { signal } = request;
    const transfer = await readTransfer(transferId);
    if (!transfer || transfer.key !== key) { await discardBody(request); return new Response(null, { status: 404 }); }
    if (await committed(transferId, transfer)) { await discardBody(request); return new Response(null, { status: 409 }); }
    if (expired(transfer)) { await discardBody(request); return expiredResponse(); }
    if (signal.aborted) { await discardBody(request); throw abortReason(signal); }

    // Record the attempt before any byte can commit, so an attempt that stalls or is
    // cancelled together with its invocation expires TRANSFER_IDLE_TTL_MS later.
    const startedAt = now();
    const active: Transfer = { ...transfer, activeAt: startedAt };
    try { await saveTransfer(transferId, active); } catch (error) { await discardBody(request); throw error; }

    let forwarded = 0;
    let confirmedAt = startedAt; // the progress time the stored record is known to carry
    let heartbeatAt = startedAt;
    let heartbeat: Promise<void> | null = null;
    const pastExpiry = () => now() - confirmedAt > TRANSFER_IDLE_TTL_MS;
    const progress = () => {
      // Another request may already have reported this transfer expired: it must not commit now.
      if (pastExpiry()) throw uploadExpired();
      const current = now();
      if (heartbeat || current - heartbeatAt < HEARTBEAT_MS) return;
      heartbeatAt = current;
      heartbeat = saveTransfer(transferId, { ...transfer, activeAt: current })
        .then(() => { confirmedAt = current; }, () => undefined)
        .finally(() => { heartbeat = null; });
    };
    let stopListening = () => {};
    const guard = new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        const onAbort = () => { try { controller.error(abortReason(signal)); } catch { /* The stream already settled. */ } };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
        stopListening = () => signal.removeEventListener('abort', onAbort);
      },
      transform(chunk, controller) {
        if (forwarded + chunk.byteLength > transfer.size) throw new RangeError('Upload exceeds declared length');
        progress();
        forwarded += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        if (forwarded !== transfer.size) throw new RangeError('Upload length mismatch');
        progress();
      },
    });
    const putOptions: R2PutOptionsLike = { httpMetadata: { contentType: transfer.contentType }, customMetadata: { transferId } };
    try {
      const FixedLength = fixedLengthStream();
      if (!request.body) {
        if (transfer.size !== 0) throw new RangeError('Upload length mismatch');
        await bucket.put(key, new Uint8Array(0), putOptions);
      } else if (FixedLength) {
        // Workers: R2 needs a known-length stream. The guard is a plain JS TransformStream
        // because workerd cannot pipe one native TransformStream into another
        // ("Inter-TransformStream pipeTo() is not implemented"), and api.ts already wraps
        // upload bodies in a FixedLengthStream. Any other length, an abort or an expiry
        // errors the stream, so the put rejects without committing anything.
        await bucket.put(key, request.body.pipeThrough(guard).pipeThrough(new FixedLength(transfer.size)), putOptions);
      } else {
        await bucket.put(key, await collect(request.body.pipeThrough(guard), transfer.size), putOptions);
      }
    } catch (error) {
      stopListening();
      await heartbeat;
      if (forwarded < transfer.size) {
        if (signal.aborted) throw abortReason(signal);
        return isUploadExpired(error) ? expiredResponse() : lengthMismatch();
      }
      // Every byte reached R2: only the object itself shows whether the put committed.
      if (await committed(transferId, active).catch(() => false)) return new Response(null, { status: 200 });
      if (signal.aborted) throw abortReason(signal);
      return isUploadExpired(error) ? expiredResponse() : outcomeUnknown();
    }
    stopListening();
    await heartbeat;
    // The object carries this transfer's marker, so an interrupted record update
    // is reconciled by `committed` on the next completion or reservation.
    await saveTransfer(transferId, { ...active, completed: true }).catch(() => undefined);
    return new Response(null, { status: 200 });
  }

  async function read(request: Request, key: string): Promise<Response> {
    const metadata = await bucket.head(key);
    if (!metadata) return new Response(null, { status: 404 });
    const size = metadata.size;
    const headers = new Headers({
      'Content-Type': metadata.httpMetadata?.contentType || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
    });
    let start = 0, end = size - 1, status = 200;
    // RFC 9110 13.1.5: a Range guarded by If-Range applies only when the validator
    // matches. These objects expose no ETag or Last-Modified, so nothing can match:
    // answer with the full representation instead of a possibly stale 206.
    const range = request.headers.get('if-range') === null ? request.headers.get('range') : null;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      status = 206;
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    const length = Math.max(0, end - start + 1);
    headers.set('Content-Length', String(length));
    if (request.method === 'HEAD' || length === 0) return new Response(null, { status, headers });
    const object = await bucket.get(key, { range: { offset: start, length } });
    if (!object) return new Response(null, { status: 404 });
    // R2 bodies (ranged or not) are already known-length streams in workerd, so the
    // Content-Length survives when api.ts passes this body straight to the client.
    return new Response(object.body, { status, headers });
  }

  async function capabilityFetch(request: Request): Promise<Response> {
    const grant = parseCapabilityUrl(request.url);
    if (!grant || now() > grant.exp) { await discardBody(request); return new Response('Expired file access', { status: 404 }); }
    if (request.method !== grant.op && !(request.method === 'HEAD' && grant.op === 'GET')) {
      await discardBody(request);
      return new Response(null, { status: 405 });
    }
    return grant.op === 'PUT' ? put(request, grant.key, grant.transferId) : read(request, grant.key);
  }

  return { storage, capabilityFetch };
}
