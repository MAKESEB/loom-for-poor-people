import type { R2BucketLike, R2ObjectBodyLike, R2ObjectLike, R2PutOptionsLike, R2RangeLike } from '../../src/server/cloudflare-types';

export interface MemoryR2Object {
  bytes: Uint8Array;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface MemoryR2Operation {
  method: 'head' | 'get' | 'put' | 'delete';
  key: string;
  range?: R2RangeLike;
  streamed?: boolean;
}

export interface MemoryR2Options {
  /** Size of each body chunk returned by get(); defaults to the whole range at once. */
  chunkBytes?: number;
  /** Runs before a put commits; throwing rejects the put without storing anything. */
  beforePut?: (key: string, bytes: Uint8Array) => void | Promise<void>;
}

export interface MemoryR2 extends R2BucketLike {
  objects: Map<string, MemoryR2Object>;
  operations: MemoryR2Operation[];
}

type PutValue = Parameters<R2BucketLike['put']>[1];

async function collect(value: PutValue): Promise<Uint8Array> {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (value instanceof Uint8Array) return value.slice();
  const reader = value.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value.slice());
      length += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function describe(key: string, object: MemoryR2Object): R2ObjectLike {
  return {
    key, size: object.bytes.byteLength,
    ...(object.httpMetadata ? { httpMetadata: { ...object.httpMetadata } } : {}),
    ...(object.customMetadata ? { customMetadata: { ...object.customMetadata } } : {}),
  };
}

/** An in-memory R2 bucket honouring ranged reads, metadata and atomic puts. */
export function createMemoryR2(options: MemoryR2Options = {}): MemoryR2 {
  const objects = new Map<string, MemoryR2Object>();
  const operations: MemoryR2Operation[] = [];
  return {
    objects,
    operations,
    async head(key) {
      operations.push({ method: 'head', key });
      const object = objects.get(key);
      return object ? describe(key, object) : null;
    },
    async get(key, getOptions) {
      operations.push({ method: 'get', key, ...(getOptions?.range ? { range: { ...getOptions.range } } : {}) });
      const object = objects.get(key);
      if (!object) return null;
      let bytes = object.bytes;
      const range = getOptions?.range;
      if (range) {
        const { offset, length } = range;
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.byteLength) {
          throw new RangeError('Invalid range');
        }
        bytes = bytes.slice(offset, offset + length);
      } else {
        bytes = bytes.slice();
      }
      const chunkBytes = options.chunkBytes ?? Math.max(1, bytes.byteLength);
      let position = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (position >= bytes.byteLength) { controller.close(); return; }
          const next = Math.min(bytes.byteLength, position + chunkBytes);
          controller.enqueue(bytes.slice(position, next));
          position = next;
        },
      }, { highWaterMark: 0 });
      const result: R2ObjectBodyLike = {
        ...describe(key, object),
        body,
        async arrayBuffer() { return bytes.slice().buffer; },
        async text() { return new TextDecoder().decode(bytes); },
      };
      return result;
    },
    async put(key, value, putOptions?: R2PutOptionsLike) {
      const streamed = value instanceof ReadableStream;
      operations.push({ method: 'put', key, streamed });
      const bytes = await collect(value);
      await options.beforePut?.(key, bytes);
      const object: MemoryR2Object = {
        bytes,
        ...(putOptions?.httpMetadata ? { httpMetadata: { ...putOptions.httpMetadata } } : {}),
        ...(putOptions?.customMetadata ? { customMetadata: { ...putOptions.customMetadata } } : {}),
      };
      objects.set(key, object);
      return describe(key, object);
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        operations.push({ method: 'delete', key });
        objects.delete(key);
      }
    },
  };
}
