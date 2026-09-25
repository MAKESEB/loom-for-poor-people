import type { RecordingPartStore } from './recordingBuffer';

export const CACHE_ROOT_NAME = 'slop-rooster-recordings';
export const CACHE_MARKER_NAME = '.recording-cache.json';
export const CACHE_STALE_MS = 24 * 60 * 60 * 1000;
export const RECORDING_CACHE_LOCK_PREFIX = 'slop-rooster-recording-cache:';

const MARKER_KIND = 'slop-rooster-recording-cache';
const MAX_MARKER_BYTES = 256;
const MARKER_REFRESH_MS = 60_000;
const MAX_SCANNED_DIRECTORIES = 64;
const MAX_REMOVALS = 4;
const MAX_DIRECTORY_ENTRIES = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PART_FILE = /^part-\d{8}$/;

type CacheLocks = Pick<LockManager, 'request'>;
type DirectoryEntries = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};
interface CacheLease { release(): Promise<void> }

/** The lock callback stays pending for the entire capture, preview and upload. */
async function acquireLease(locks: CacheLocks, name: string): Promise<CacheLease | null> {
  let release!: () => void;
  const lifetime = new Promise<void>(resolve => { release = resolve; });
  let acquired!: (lease: CacheLease | null) => void;
  let rejected!: (reason: unknown) => void;
  const result = new Promise<CacheLease | null>((resolve, reject) => { acquired = resolve; rejected = reject; });
  const held = Promise.resolve().then(() => locks.request(
    `${RECORDING_CACHE_LOCK_PREFIX}${name}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) { acquired(null); return; }
      acquired({ async release() { release(); await held; } });
      await lifetime;
    },
  )).catch(rejected);
  return result;
}

async function readActivity(directory: FileSystemDirectoryHandle): Promise<number | null> {
  try {
    const file = await (await directory.getFileHandle(CACHE_MARKER_NAME)).getFile();
    if (file.size > MAX_MARKER_BYTES) return null;
    const marker: unknown = JSON.parse(await file.slice(0, MAX_MARKER_BYTES).text());
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
    const value = marker as Record<string, unknown>;
    if (Object.keys(value).length !== 3 || value.kind !== MARKER_KIND || value.version !== 1
      || typeof value.lastActivity !== 'number' || !Number.isSafeInteger(value.lastActivity) || value.lastActivity < 0) return null;
    return value.lastActivity;
  } catch { return null; }
}

async function writeActivity(directory: FileSystemDirectoryHandle, at: number) {
  const file = await directory.getFileHandle(CACHE_MARKER_NAME, { create: true });
  const writer = await file.createWritable();
  try {
    await writer.write(JSON.stringify({ kind: MARKER_KIND, version: 1, lastActivity: at }));
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}

/** Never recursively remove an unknown file or a nested directory. */
async function containsOnlyCacheFiles(directory: FileSystemDirectoryHandle, ownedFiles?: ReadonlySet<string>): Promise<boolean> {
  const iterator = (directory as DirectoryEntries).entries();
  // Live owners know their exact files, so even very long captures can be removed.
  // One extra iterator step observes completion (or an unexpected additional file).
  const maximumEntries = ownedFiles ? ownedFiles.size + 1 : MAX_DIRECTORY_ENTRIES;
  try {
    for (let count = 0; count < maximumEntries; count += 1) {
      const next = await iterator.next();
      if (next.done) return true;
      const [name, handle] = next.value;
      const knownName = ownedFiles ? ownedFiles.has(name) : name === CACHE_MARKER_NAME || PART_FILE.test(name);
      if (handle.kind !== 'file' || !knownName) return false;
    }
    // An unexpectedly large directory is preserved rather than scanned without a bound.
    return false;
  } finally { await iterator.return?.(); }
}

/** Best-effort scavenging is limited to old, marked, unlocked temporary captures. */
export async function cleanupTemporaryRecordingCaches(
  parent: FileSystemDirectoryHandle, locks: CacheLocks, now: () => number = Date.now,
): Promise<void> {
  try {
    const iterator = (parent as DirectoryEntries).entries();
    let removed = 0;
    try {
      for (let scanned = 0; scanned < MAX_SCANNED_DIRECTORIES && removed < MAX_REMOVALS; scanned += 1) {
        const next = await iterator.next();
        if (next.done) break;
        const [name, handle] = next.value;
        if (handle.kind !== 'directory' || !UUID.test(name)) continue;
        const directory = handle as FileSystemDirectoryHandle;
        const activity = await readActivity(directory);
        if (activity === null || now() - activity <= CACHE_STALE_MS) continue;
        const lease = await acquireLease(locks, name).catch(() => null);
        if (!lease) continue;
        try {
          // The candidate may have been refreshed while the lock request was queued.
          const current = await parent.getDirectoryHandle(name);
          const refreshed = await readActivity(current);
          if (refreshed === null || now() - refreshed <= CACHE_STALE_MS || !await containsOnlyCacheFiles(current)) continue;
          await parent.removeEntry(name, { recursive: true });
          removed += 1;
        } catch { /* A stale cache must never prevent the next recording. */ }
        finally { await lease.release(); }
      }
    } finally { await iterator.return?.(); }
  } catch { /* Missing iteration support, locks, or storage leave existing files untouched. */ }
}

export async function createTemporaryRecordingStore(
  storage: Pick<StorageManager, 'getDirectory'>, locks: CacheLocks,
  options: { now?: () => number; randomUUID?: () => string } = {},
): Promise<RecordingPartStore> {
  const now = options.now ?? Date.now;
  const root = await storage.getDirectory();
  const parent = await root.getDirectoryHandle(CACHE_ROOT_NAME, { create: true });
  await cleanupTemporaryRecordingCaches(parent, locks, now);
  const name = (options.randomUUID ?? (() => crypto.randomUUID()))();
  if (!UUID.test(name)) throw new Error('A temporary recording directory could not be created.');
  const lease = await acquireLease(locks, name);
  if (!lease) throw new Error('A temporary recording directory is already in use.');
  let directory: FileSystemDirectoryHandle | undefined;
  try {
    // Never adopt or remove a pre-existing directory, even in the unlikely UUID collision case.
    try {
      await parent.getDirectoryHandle(name);
      throw new Error('The temporary recording directory already exists.');
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    }
    directory = await parent.getDirectoryHandle(name, { create: true });
    let lastMarkerAttempt = now();
    await writeActivity(directory, lastMarkerAttempt);
    const ownedDirectory = directory;
    const ownedFiles = new Set([CACHE_MARKER_NAME]);
    let pending = Promise.resolve();
    let disposed = false;
    let disposing: Promise<void> | undefined;
    return {
      write(index, chunk) {
        if (disposed) return Promise.reject(new Error('This recording has been discarded.'));
        if (!Number.isSafeInteger(index) || index < 0 || index >= 100_000_000) return Promise.reject(new Error('The recording part is invalid.'));
        const operation = pending.then(async () => {
          const filename = `part-${index.toString().padStart(8, '0')}`;
          const file = await ownedDirectory.getFileHandle(filename, { create: true });
          ownedFiles.add(filename);
          const writer = await file.createWritable();
          try {
            await writer.write(chunk);
            await writer.close();
          } catch (error) {
            await writer.abort().catch(() => {});
            throw error;
          }
          const at = now();
          if (at - lastMarkerAttempt >= MARKER_REFRESH_MS) {
            lastMarkerAttempt = at;
            // The live lock protects even an old marker; a refresh error must not lose video.
            await writeActivity(ownedDirectory, at).catch(() => {});
          }
          return file.getFile();
        });
        pending = operation.then(() => {}, () => {});
        return operation;
      },
      dispose() {
        if (disposing) return disposing;
        disposed = true;
        disposing = pending.then(async () => {
          try {
            if (await containsOnlyCacheFiles(ownedDirectory, ownedFiles)) await parent.removeEntry(name, { recursive: true });
          } catch (error) {
            if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
          } finally { await lease.release(); }
        });
        return disposing;
      },
    };
  } catch (error) {
    try {
      if (directory && await containsOnlyCacheFiles(directory)) await parent.removeEntry(name, { recursive: true });
    } catch { /* A partially created cache can remain; never hold its lock after failure. */ }
    finally { await lease.release(); }
    throw error;
  }
}
