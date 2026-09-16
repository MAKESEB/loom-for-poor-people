import type { createPrivateStorageClient } from '@ohmyhost/customer-runtime/storage';

export type ManagedStorage = ReturnType<typeof createPrivateStorageClient>;

export interface StorageRuntime {
  storage: ManagedStorage;
  capabilityFetch: (request: Request) => Promise<Response>;
}

const managedMethods = ['reserveUpload', 'completeUpload', 'createSignedRead', 'upload', 'deleteObject'] as const;

export class StorageUnavailableError extends Error {
  constructor() {
    super('The managed storage binding is unavailable.');
    this.name = 'StorageUnavailableError';
  }
}

/**
 * Tentative deployment boundary: the published FILES binding does not document its
 * managed-client wiring yet. Accept an explicit compatible client only; never
 * guess gateway credentials or silently fall back to a raw bucket.
 */
export function resolveStorageRuntime(environment: Record<string, unknown>): StorageRuntime {
  const binding = environment.FILES;
  if (!binding || typeof binding !== 'object' ||
      !managedMethods.every((method) => typeof (binding as Record<string, unknown>)[method] === 'function')) {
    throw new StorageUnavailableError();
  }
  return {
    storage: binding as ManagedStorage,
    capabilityFetch: (request) => fetch(request),
  };
}

/** These fixed method types are safe diagnostics; binding values and arbitrary names stay private. */
export function storageBindingDiagnostics(environment: Record<string, unknown>) {
  const binding = environment.FILES;
  return {
    present: binding !== undefined && binding !== null,
    methods: Object.fromEntries(managedMethods.map((method) => [
      method,
      binding && typeof binding === 'object' ? typeof (binding as Record<string, unknown>)[method] : 'undefined',
    ])),
  };
}
