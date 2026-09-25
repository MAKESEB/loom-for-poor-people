import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHE_MARKER_NAME,
  CACHE_ROOT_NAME,
  CACHE_STALE_MS,
  RECORDING_CACHE_LOCK_PREFIX,
  cleanupTemporaryRecordingCaches,
  createTemporaryRecordingStore,
} from '../src/client/recordingCache';

const NOW = 1_800_000_000_000;
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const marker = (lastActivity: number) => JSON.stringify({
  kind: 'slop-rooster-recording-cache', version: 1, lastActivity,
});
const missing = () => new DOMException('Missing entry', 'NotFoundError');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

class ObservedBlob extends Blob {
  constructor(parts: BlobPart[], private readonly read: (bytes: number) => void) { super(parts); }
  override async text() { this.read(this.size); return super.text(); }
  override async arrayBuffer() { this.read(this.size); return super.arrayBuffer(); }
  override slice(start?: number, end?: number, contentType?: string) {
    return new ObservedBlob([super.slice(start, end, contentType)], this.read);
  }
}

interface FileHooks {
  beforeCreateWritable?: (file: MemoryFile) => void | Promise<void>;
  beforeWrite?: (file: MemoryFile) => void | Promise<void>;
  beforeRemove?: (directory: MemoryDirectory, name: string) => void | Promise<void>;
}

class MemoryFile {
  readonly kind = 'file';
  data: Blob;
  getFileCalls = 0;
  readSizes: number[] = [];
  writes = 0;
  closes = 0;
  aborts = 0;

  constructor(readonly name: string, contents: BlobPart = '', private readonly hooks: FileHooks = {}) {
    this.data = new Blob([contents]);
  }

  async getFile() {
    this.getFileCalls += 1;
    return new ObservedBlob([this.data], bytes => { this.readSizes.push(bytes); }) as unknown as File;
  }

  async createWritable() {
    await this.hooks.beforeCreateWritable?.(this);
    let pending = new Blob();
    return {
      write: async (data: BlobPart) => {
        this.writes += 1;
        await this.hooks.beforeWrite?.(this);
        pending = new Blob([data]);
      },
      close: async () => { this.closes += 1; this.data = pending; },
      abort: async () => { this.aborts += 1; },
    };
  }
}

class MemoryDirectory {
  readonly kind = 'directory';
  readonly children = new Map<string, MemoryDirectory | MemoryFile>();
  readonly removed: string[] = [];
  yieldedEntries = 0;

  constructor(readonly name: string, readonly hooks: FileHooks = {}) {}

  directory(name: string) {
    const child = new MemoryDirectory(name, this.hooks);
    this.children.set(name, child);
    return child;
  }

  file(name: string, contents: BlobPart = '') {
    const child = new MemoryFile(name, contents, this.hooks);
    this.children.set(name, child);
    return child;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.children.get(name);
    if (existing?.kind === 'directory') return existing;
    if (existing) throw new DOMException('Wrong entry kind', 'TypeMismatchError');
    if (options?.create) return this.directory(name);
    throw missing();
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.children.get(name);
    if (existing?.kind === 'file') return existing;
    if (existing) throw new DOMException('Wrong entry kind', 'TypeMismatchError');
    if (options?.create) return this.file(name);
    throw missing();
  }

  async removeEntry(name: string, options?: { recursive?: boolean }) {
    await this.hooks.beforeRemove?.(this, name);
    const entry = this.children.get(name);
    if (!entry) throw missing();
    if (entry.kind === 'directory' && entry.children.size && !options?.recursive) {
      throw new DOMException('Directory is not empty', 'InvalidModificationError');
    }
    this.removed.push(name);
    this.children.delete(name);
  }

  async *entries(): AsyncGenerator<[string, MemoryDirectory | MemoryFile]> {
    for (const entry of this.children.entries()) {
      this.yieldedEntries += 1;
      yield entry;
    }
  }

  async *values() { for await (const [, value] of this.entries()) yield value; }
  [Symbol.asyncIterator]() { return this.entries(); }
  asHandle() { return this as unknown as FileSystemDirectoryHandle; }
}

type LockCallback = (lock: Lock | null) => unknown | Promise<unknown>;
class MemoryLocks {
  readonly held = new Set<string>();
  readonly calls: { name: string; options: LockOptions }[] = [];
  readonly releases = new Map<string, number>();
  private readonly waiting = new Map<string, (() => void)[]>();
  beforeRequest?: (name: string, options: LockOptions) => void | Promise<void>;

  async request(name: string, optionsOrCallback: LockOptions | LockCallback, callback?: LockCallback) {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const run = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback!;
    this.calls.push({ name, options });
    await this.beforeRequest?.(name, options);
    if (this.held.has(name) && options.ifAvailable) return run(null);
    while (this.held.has(name)) {
      await new Promise<void>(resolve => {
        this.waiting.set(name, [...(this.waiting.get(name) ?? []), resolve]);
      });
    }
    this.held.add(name);
    try { return await run({ name, mode: options.mode ?? 'exclusive' } as Lock); }
    finally {
      this.held.delete(name);
      this.releases.set(name, (this.releases.get(name) ?? 0) + 1);
      const waiting = this.waiting.get(name) ?? [];
      this.waiting.delete(name);
      for (const resolve of waiting) resolve();
    }
  }

  asManager() { return this as unknown as Pick<LockManager, 'request'>; }
}

function fixture(hooks: FileHooks = {}) {
  const root = new MemoryDirectory('root', hooks);
  const parent = root.directory(CACHE_ROOT_NAME);
  const locks = new MemoryLocks();
  const storage = { async getDirectory() { return root.asHandle(); } };
  return { root, parent, locks, storage };
}

function cache(parent: MemoryDirectory, id: string, lastActivity = NOW - CACHE_STALE_MS - 1) {
  const directory = parent.directory(id);
  const activity = directory.file(CACHE_MARKER_NAME, marker(lastActivity));
  directory.file('part-00000000', 'recording');
  return { directory, activity };
}

test('cleanup removes expired inactive captures once and protects active, fresh, and unknown entries', async () => {
  const { parent, locks } = fixture();
  cache(parent, uuid(1));
  cache(parent, uuid(2), NOW - CACHE_STALE_MS + 1);
  cache(parent, uuid(3));
  cache(parent, 'another-feature-cache');
  parent.directory(uuid(4)).file('part-00000000', 'unmarked recording');
  parent.file(uuid(5), 'unrelated file');
  const unknownContents = cache(parent, uuid(6));
  unknownContents.directory.file('notes.txt', 'user data');
  const nestedContents = cache(parent, uuid(7));
  nestedContents.directory.directory('part-00000001');
  locks.held.add(`${RECORDING_CACHE_LOCK_PREFIX}${uuid(3)}`);

  await cleanupTemporaryRecordingCaches(parent.asHandle(), locks.asManager(), () => NOW);
  await cleanupTemporaryRecordingCaches(parent.asHandle(), locks.asManager(), () => NOW);

  assert.deepEqual(parent.removed, [uuid(1)]);
  for (const name of [uuid(2), uuid(3), uuid(4), uuid(5), uuid(6), uuid(7), 'another-feature-cache']) {
    assert.equal(parent.children.has(name), true, `${name} must be preserved`);
  }
  assert.equal(locks.held.has(`${RECORDING_CACHE_LOCK_PREFIX}${uuid(3)}`), true);
  assert.ok(locks.calls.every(call => call.options.ifAvailable === true), 'cleanup never waits for another tab');
});

test('cleanup requires a valid marker and v4 UUID before deleting any recording data', async () => {
  const { parent, locks } = fixture();
  const unsafeMarkers = [
    'invalid JSON',
    'null',
    '{}',
    JSON.stringify({ kind: 'another-cache', version: 1, lastActivity: 0 }),
    JSON.stringify({ kind: 'slop-rooster-recording-cache', version: 2, lastActivity: 0 }),
    JSON.stringify({ kind: 'slop-rooster-recording-cache', version: 1, lastActivity: '0' }),
    JSON.stringify({ kind: 'slop-rooster-recording-cache', version: 1, lastActivity: -1 }),
    marker(NOW + CACHE_STALE_MS),
  ];
  for (const [index, value] of unsafeMarkers.entries()) {
    parent.directory(uuid(index)).file(CACHE_MARKER_NAME, value);
  }
  cache(parent, '00000000-0000-1000-8000-000000000100');
  cache(parent, '00000000-0000-4000-0000-000000000101');
  await cleanupTemporaryRecordingCaches(parent.asHandle(), locks.asManager(), () => NOW);
  assert.equal(parent.children.size, unsafeMarkers.length + 2);
  assert.deepEqual(parent.removed, []);
});

test('cleanup rechecks freshness after acquiring a lock so a concurrent refresh is preserved', async () => {
  const { parent, locks } = fixture();
  const { activity } = cache(parent, uuid(1));
  locks.beforeRequest = () => {
    assert.ok(activity.getFileCalls > 0, 'the initial stale-marker read precedes locking');
    activity.data = new Blob([marker(NOW)]);
  };
  await cleanupTemporaryRecordingCaches(parent.asHandle(), locks.asManager(), () => NOW);
  assert.equal(parent.children.has(uuid(1)), true);
  assert.ok(activity.getFileCalls >= 2, 'the marker is reread while holding the lock');
  assert.equal(locks.held.size, 0);
});

test('oversized markers are preserved without unbounded marker reads', async () => {
  const { parent, locks } = fixture();
  const { activity } = cache(parent, uuid(1));
  activity.data = new Blob([marker(0).padEnd(4096, ' ')]);
  await cleanupTemporaryRecordingCaches(parent.asHandle(), locks.asManager(), () => NOW);
  assert.equal(parent.children.has(uuid(1)), true);
  assert.ok(activity.readSizes.every(size => size <= 256), 'oversized marker bodies are never read in full');
});

test('cleanup limits parent inspection and deletes at most four directories per pass', async () => {
  const limited = fixture();
  for (let index = 0; index < 64; index += 1) limited.parent.file(`unrelated-${index}`);
  const beyondLimit = cache(limited.parent, uuid(1));
  await cleanupTemporaryRecordingCaches(limited.parent.asHandle(), limited.locks.asManager(), () => NOW);
  assert.equal(beyondLimit.activity.getFileCalls, 0);
  assert.equal(limited.parent.children.has(uuid(1)), true);
  assert.ok(limited.parent.yieldedEntries <= 65, 'at most one iterator lookahead is used beyond the inspection budget');

  const bounded = fixture();
  for (let index = 0; index < 8; index += 1) cache(bounded.parent, uuid(index));
  await cleanupTemporaryRecordingCaches(bounded.parent.asHandle(), bounded.locks.asManager(), () => NOW);
  assert.equal(bounded.parent.removed.length, 4);
  await cleanupTemporaryRecordingCaches(bounded.parent.asHandle(), bounded.locks.asManager(), () => NOW);
  assert.equal(bounded.parent.children.size, 0);
});

test('cleanup preserves candidates exceeding the bounded child inspection budget', async () => {
  const { parent, locks } = fixture();
  const { directory } = cache(parent, uuid(1));
  for (let index = 1; index < 8193; index += 1) {
    directory.file(`part-${String(index).padStart(8, '0')}`);
  }
  await cleanupTemporaryRecordingCaches(parent.asHandle(), locks.asManager(), () => NOW);
  assert.equal(parent.children.has(uuid(1)), true);
  assert.ok(directory.yieldedEntries <= 8193, 'an oversized candidate does not cause an unbounded scan');
});

test('a live store holds its lock through pending writes and releases it after disposal', async () => {
  const started = deferred();
  const blocked = deferred();
  const { parent, locks, storage } = fixture({
    async beforeWrite(file) {
      if (file.name.startsWith('part-')) { started.resolve(); await blocked.promise; }
    },
  });
  let now = NOW;
  const id = uuid(1);
  const lockName = `${RECORDING_CACHE_LOCK_PREFIX}${id}`;
  const store = await createTemporaryRecordingStore(storage, locks.asManager(), { now: () => now, randomUUID: () => id });
  assert.equal(locks.held.has(lockName), true);
  now += CACHE_STALE_MS + 1;
  await cleanupTemporaryRecordingCaches(parent.asHandle(), locks.asManager(), () => now);
  assert.equal(parent.children.has(id), true, 'even an old active recording is protected');

  const write = store.write(0, new Blob(['video bytes']));
  await started.promise;
  const disposing = store.dispose();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(locks.held.has(lockName), true, 'the lock is retained until the last write completes');
  assert.equal(parent.children.has(id), true);
  blocked.resolve();
  assert.equal(await (await write).text(), 'video bytes');
  await disposing;
  await store.dispose();
  assert.equal(parent.children.has(id), false);
  assert.equal(locks.held.has(lockName), false);
  assert.equal(locks.releases.get(lockName), 1);
});

test('recording activity markers refresh at most once per minute while part writes continue', async () => {
  const { parent, locks, storage } = fixture();
  let now = NOW;
  const store = await createTemporaryRecordingStore(storage, locks.asManager(), { now: () => now, randomUUID: () => uuid(1) });
  const directory = await parent.getDirectoryHandle(uuid(1));
  const activity = await directory.getFileHandle(CACHE_MARKER_NAME);
  assert.equal(activity.writes, 1);
  assert.equal(JSON.parse(await activity.data.text()).lastActivity, NOW);
  await store.write(0, new Blob(['first']));
  now += 59_999;
  await store.write(1, new Blob(['second']));
  assert.equal(activity.writes, 1);
  now += 1;
  await store.write(2, new Blob(['third']));
  assert.equal(activity.writes, 2);
  assert.equal(JSON.parse(await activity.data.text()).lastActivity, now);
  await store.write(3, new Blob(['fourth']));
  assert.equal(activity.writes, 2);
  await store.dispose();
});

test('failed refresh attempts stay throttled and do not discard successfully stored parts', async () => {
  let rejectRefresh = false;
  const { parent, locks, storage } = fixture({
    beforeWrite(file) {
      if (rejectRefresh && file.name === CACHE_MARKER_NAME) throw new Error('marker refresh failed');
    },
  });
  let now = NOW;
  const store = await createTemporaryRecordingStore(storage, locks.asManager(), { now: () => now, randomUUID: () => uuid(1) });
  const directory = await parent.getDirectoryHandle(uuid(1));
  const activity = await directory.getFileHandle(CACHE_MARKER_NAME);
  rejectRefresh = true;
  now += 60_000;
  assert.equal(await (await store.write(0, new Blob(['saved']))).text(), 'saved');
  await store.write(1, new Blob(['also saved']));
  assert.equal(activity.writes, 2, 'a failed refresh is not retried for every media part');
  assert.equal(locks.held.has(`${RECORDING_CACHE_LOCK_PREFIX}${uuid(1)}`), true);
  now += 60_000;
  await store.write(2, new Blob(['still saved']));
  assert.equal(activity.writes, 3);
  await store.dispose();
});

test('creation failure cleans its partial directory and releases the recording lock', async () => {
  const { parent, locks, storage } = fixture({
    beforeCreateWritable(file) {
      if (file.name === CACHE_MARKER_NAME) throw new Error('storage unavailable');
    },
  });
  const id = uuid(1);
  await assert.rejects(
    createTemporaryRecordingStore(storage, locks.asManager(), { now: () => NOW, randomUUID: () => id }),
    /storage unavailable/,
  );
  assert.equal(locks.held.has(`${RECORDING_CACHE_LOCK_PREFIX}${id}`), false);
  assert.equal(parent.children.has(id), false);
});

test('a failed part write retains the lock until disposal and aborts its incomplete writer', async () => {
  const { parent, locks, storage } = fixture({
    beforeWrite(file) { if (file.name.startsWith('part-')) throw new Error('quota exceeded'); },
  });
  const id = uuid(1);
  const store = await createTemporaryRecordingStore(storage, locks.asManager(), { now: () => NOW, randomUUID: () => id });
  await assert.rejects(store.write(0, new Blob(['unsaved'])), /quota exceeded/);
  const directory = await parent.getDirectoryHandle(id);
  const part = await directory.getFileHandle('part-00000000');
  assert.equal(part.aborts, 1);
  assert.equal(locks.held.has(`${RECORDING_CACHE_LOCK_PREFIX}${id}`), true);
  await store.dispose();
  assert.equal(locks.held.size, 0);
  assert.equal(parent.children.has(id), false);
});

test('disposal releases the lock even when removing its directory fails', async () => {
  const id = uuid(1);
  const { parent, locks, storage } = fixture({
    beforeRemove(_directory, name) { if (name === id) throw new Error('removal failed'); },
  });
  const store = await createTemporaryRecordingStore(storage, locks.asManager(), { now: () => NOW, randomUUID: () => id });
  await assert.rejects(store.dispose(), /removal failed/);
  assert.equal(locks.held.has(`${RECORDING_CACHE_LOCK_PREFIX}${id}`), false);
  assert.equal(parent.children.has(id), true, 'a failed cleanup remains available for a later stale sweep');
});

test('a UUID collision preserves an existing directory and releases only the attempted new lease', async () => {
  const { parent, locks, storage } = fixture();
  const id = uuid(1);
  const existing = cache(parent, id, NOW);
  existing.directory.file('notes.txt', 'keep this data');
  await assert.rejects(
    createTemporaryRecordingStore(storage, locks.asManager(), { now: () => NOW, randomUUID: () => id }),
    /already exists/,
  );
  assert.equal(parent.children.get(id), existing.directory);
  assert.equal(await (await existing.directory.getFileHandle('notes.txt')).data.text(), 'keep this data');
  assert.equal(locks.held.size, 0);
  assert.equal(locks.releases.get(`${RECORDING_CACHE_LOCK_PREFIX}${id}`), 1);
});

test('a collision with another active capture never releases that capture’s lock', async () => {
  const { parent, locks, storage } = fixture();
  const id = uuid(1);
  const existing = cache(parent, id, NOW);
  const lockName = `${RECORDING_CACHE_LOCK_PREFIX}${id}`;
  locks.held.add(lockName);
  await assert.rejects(
    createTemporaryRecordingStore(storage, locks.asManager(), { now: () => NOW, randomUUID: () => id }),
    /already in use/,
  );
  assert.equal(parent.children.get(id), existing.directory);
  assert.equal(locks.held.has(lockName), true);
  assert.equal(locks.releases.has(lockName), false);
});

test('disposal preserves unexpected data but still releases its lease and closes the store', async () => {
  const { parent, locks, storage } = fixture();
  const id = uuid(1);
  const store = await createTemporaryRecordingStore(storage, locks.asManager(), { now: () => NOW, randomUUID: () => id });
  const directory = await parent.getDirectoryHandle(id);
  directory.file('notes.txt', 'unrecognized data');
  await store.dispose();
  assert.equal(parent.children.get(id), directory);
  assert.equal(locks.held.size, 0);
  await assert.rejects(store.write(0, new Blob(['too late'])), /discarded/);
});

test('disposing a long recording removes all owned parts beyond the stale-cache scan limit', async () => {
  const { parent, locks, storage } = fixture();
  const id = uuid(1);
  const lockName = `${RECORDING_CACHE_LOCK_PREFIX}${id}`;
  const store = await createTemporaryRecordingStore(storage, locks.asManager(), { now: () => NOW, randomUUID: () => id });
  const part = new Blob(['recorded frame']);
  for (let index = 0; index < 8193; index += 1) await store.write(index, part);
  const directory = await parent.getDirectoryHandle(id);
  assert.equal(directory.children.size, 8194, 'the marker and every distinct part exist before disposal');
  assert.equal(locks.held.has(lockName), true);

  await store.dispose();

  assert.equal(parent.children.has(id), false, 'owned disposal must not inherit the abandoned-cache scan limit');
  assert.deepEqual(parent.removed, [id]);
  assert.equal(locks.held.has(lockName), false);
  assert.equal(locks.releases.get(lockName), 1);
});

for (const entryKind of ['file', 'directory'] as const) {
  test(`disposal preserves an unowned part-shaped ${entryKind} and releases the recording lock`, async () => {
    const { parent, locks, storage } = fixture();
    const id = uuid(1);
    const store = await createTemporaryRecordingStore(storage, locks.asManager(), { now: () => NOW, randomUUID: () => id });
    await store.write(0, new Blob(['owned part']));
    const directory = await parent.getDirectoryHandle(id);
    const name = 'part-00000001';
    const unexpected = entryKind === 'file'
      ? directory.file(name, 'unowned part data')
      : directory.directory(name);
    if (unexpected.kind === 'directory') unexpected.file('notes.txt', 'nested data');

    await store.dispose();

    assert.equal(parent.children.get(id), directory);
    assert.equal(directory.children.get(name), unexpected);
    assert.deepEqual(parent.removed, []);
    if (unexpected.kind === 'file') assert.equal(await unexpected.data.text(), 'unowned part data');
    else assert.equal(await (await unexpected.getFileHandle('notes.txt')).data.text(), 'nested data');
    assert.equal(locks.held.has(`${RECORDING_CACHE_LOCK_PREFIX}${id}`), false);
    await assert.rejects(store.write(1, new Blob(['too late'])), /discarded/);
  });
}
