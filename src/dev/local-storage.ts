// This disk adapter is imported only by Vite's local development server.
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat, rename, rm, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { createPrivateStorageClient, StorageCapability } from '@ohmyhost/customer-runtime/storage';

type Storage = ReturnType<typeof createPrivateStorageClient>;
type Transfer = { key: string; contentType: string; size: number; completed: boolean };

export function createLocalStorage(root = resolve('.local/storage')) {
  const capabilities = new Map<string, { key: string; operation: 'GET' | 'PUT'; transferId?: string; expires: number }>();
  let origin = 'http://127.0.0.1:5173';
  const objectPath = (key: string) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/.test(key) || key.split('/').some(p => p === '..' || p === '.')) throw new Error('Invalid object key');
    return resolve(root, 'objects', key);
  };
  const transferPath = (id: string) => resolve(root, 'transfers', `${id}.json`);
  const saveTransfer = async (id: string, data: Transfer) => {
    await mkdir(dirname(transferPath(id)), { recursive: true });
    await writeFile(transferPath(id), JSON.stringify(data));
  };
  const capability = (key: string, operation: 'GET' | 'PUT', size: number | null, contentType: string, transferId?: string): StorageCapability => {
    const token = randomUUID();
    const expires = Date.now() + 60 * 60 * 1000;
    capabilities.set(token, { key, operation, transferId, expires });
    return { operation, objectKey: key, url: `${origin}/__local_storage/${token}`, expiresAt: new Date(expires).toISOString(), expectedContentLength: size, requiredHeaders: operation === 'PUT' ? { 'content-type': contentType } : {} };
  };
  const storage: Storage = {
    async reserveUpload(input) {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey)) throw new Error('Invalid idempotency key');
      const receiptPath = resolve(root, 'requests', `${input.idempotencyKey}.json`);
      const previous = await readFile(receiptPath, 'utf8').then(JSON.parse).catch(() => null) as { transferId: string; input: typeof input } | null;
      if (previous) {
        if (JSON.stringify(previous.input) !== JSON.stringify(input)) throw Object.assign(new Error('Conflicting upload'), { code: 'storage_conflict' });
        const transfer = JSON.parse(await readFile(transferPath(previous.transferId), 'utf8')) as Transfer;
        if (transfer.completed) return { state: 'completed', transferId: previous.transferId };
        return { state: 'ready', transferId: previous.transferId, capability: capability(input.objectKey, 'PUT', input.contentLength, input.contentType, previous.transferId) };
      }
      const transferId = randomUUID();
      await saveTransfer(transferId, { key: input.objectKey, contentType: input.contentType, size: input.contentLength, completed: false });
      await mkdir(dirname(receiptPath), { recursive: true });
      await writeFile(receiptPath, JSON.stringify({ transferId, input }));
      return { state: 'ready', transferId, capability: capability(input.objectKey, 'PUT', input.contentLength, input.contentType, transferId) };
    },
    async completeUpload(transferId) {
      const data = JSON.parse(await readFile(transferPath(transferId), 'utf8')) as Transfer;
      return { state: data.completed ? 'completed' : 'pending', transferId };
    },
    async createSignedRead(key) {
      try { await stat(objectPath(key)); } catch { throw Object.assign(new Error('Missing object'), { code: 'storage_object_not_found', status: 404 }); }
      return capability(key, 'GET', null, 'application/octet-stream');
    },
    async deleteObject({ objectKey, idempotencyKey }) {
      await rm(objectPath(objectKey), { force: true });
      return { state: 'completed', deletionId: idempotencyKey };
    },
    async upload(input) {
      const path = objectPath(input.objectKey);
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, input.bytes);
      await rename(temporary, path);
      await writeFile(`${path}.type`, input.contentType);
      return { state: 'completed', transferId: randomUUID() };
    },
  };

  async function capabilityFetch(request: Request): Promise<Response> {
    const token = new URL(request.url).pathname.split('/').pop() ?? '';
    const granted = capabilities.get(token);
    if (!granted || granted.expires < Date.now()) return new Response('Expired file access', { status: 404 });
    if (request.method !== granted.operation && !(request.method === 'HEAD' && granted.operation === 'GET')) return new Response(null, { status: 405 });
    const path = objectPath(granted.key);
    if (granted.operation === 'PUT') {
      const data = JSON.parse(await readFile(transferPath(granted.transferId!), 'utf8')) as Transfer;
      if (data.completed) return new Response(null, { status: 409 });
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'w');
      let size = 0;
      try {
        if (request.body) {
          for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
            size += chunk.byteLength;
            if (size > data.size) throw new Error('Upload exceeds declared length');
            await file.write(chunk);
          }
        }
        if (size !== data.size) throw new Error('Upload length mismatch');
      } catch {
        await file.close();
        await rm(temporary, { force: true });
        return new Response('Upload length mismatch', { status: 400 });
      }
      await file.close();
      await rename(temporary, path);
      await writeFile(`${path}.type`, data.contentType);
      await saveTransfer(granted.transferId!, { ...data, completed: true });
      return new Response(null, { status: 200 });
    }
    let size: number;
    try { size = (await stat(path)).size; } catch { return new Response(null, { status: 404 }); }
    const type = await readFile(`${path}.type`, 'utf8').catch(() => 'application/octet-stream');
    const headers = new Headers({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' });
    let start = 0, end = size - 1, status = 200;
    const range = request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      status = 206;
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    headers.set('Content-Length', String(Math.max(0, end - start + 1)));
    const body = request.method === 'HEAD' || size === 0 ? null : Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>;
    return new Response(body, { status, headers });
  }

  return { storage, capabilityFetch, setOrigin(value: string) { origin = value; } };
}
