import { createPrivateStorageClient } from '@ohmyhost/customer-runtime/storage';

export type ManagedStorage = ReturnType<typeof createPrivateStorageClient>;

export interface StorageRuntime {
  storage: ManagedStorage;
  capabilityFetch: (request: Request) => Promise<Response>;
}

/** Workers derives Content-Length from the stream type, ignoring a manually set header. */
export function fixedLengthBody(body: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  const FixedLength = (globalThis as typeof globalThis & {
    FixedLengthStream?: new (length: number) => TransformStream<Uint8Array, Uint8Array>;
  }).FixedLengthStream;
  return FixedLength ? body.pipeThrough(new FixedLength(length)) : body;
}

export class StorageUnavailableError extends Error {
  constructor() { super('The managed storage binding is unavailable.'); this.name = 'StorageUnavailableError'; }
}

/** Gateway credentials stay server-side; signed capabilities never leave the app. */
export function resolveStorageRuntime(environment: Record<string, unknown>): StorageRuntime {
  const gateway = environment.OHMYHOST_STORAGE_GATEWAY as { fetch?: (request: Request) => Promise<Response> } | undefined;
  const endpoint = environment.OHMYHOST_STORAGE_GATEWAY_URL;
  const key = environment.OHMYHOST_STORAGE_KEY;
  const projectId = environment.OHMYHOST_PROJECT_ID;
  const environmentId = environment.OHMYHOST_ENVIRONMENT_ID;
  if (!gateway || typeof gateway.fetch !== 'function' || ![endpoint, key, projectId, environmentId].every(value => typeof value === 'string' && value.length > 0)) throw new StorageUnavailableError();
  const capabilityFetch = (request: Request) => fetch(request);
  return {
    storage: createPrivateStorageClient({
      endpoint: endpoint as string, key: key as string, projectId: projectId as string, environmentId: environmentId as string,
      fetch: request => gateway.fetch!(request), capabilityFetch,
    }),
    capabilityFetch,
  };
}

export function storageBindingDiagnostics(environment: Record<string, unknown>) {
  const gateway = environment.OHMYHOST_STORAGE_GATEWAY as { fetch?: unknown } | undefined;
  return {
    gateway: typeof gateway?.fetch === 'function',
    configured: ['OHMYHOST_STORAGE_GATEWAY_URL', 'OHMYHOST_STORAGE_KEY', 'OHMYHOST_PROJECT_ID', 'OHMYHOST_ENVIRONMENT_ID'].every(name => typeof environment[name] === 'string' && Boolean(environment[name])),
  };
}
