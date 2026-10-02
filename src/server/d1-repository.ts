import { MAX_PART_COUNT, MAX_SINGLE_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES } from '../shared/policy';
import type { D1DatabaseLike, D1Value } from './cloudflare-types';
import type { JobPatch, MarkdownJob, RecordingPart, RecordingRow, Repository } from './types';

type Row = Readonly<Record<string, unknown>>;

// Timestamps are ISO-8601 UTC with milliseconds, identical to Date.prototype.toISOString(), so SQL
// compares them lexicographically. SQLite evaluates 'now' once per statement.
const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const nowPlus = (modifier: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${modifier})`;
// Upload and part leases. The API's 120-second upload deadline stays inside this 3-minute lease.
const leaseUntil = nowPlus("'+3 minutes'");
const activeSql = "('queued', 'uploading', 'processing', 'submitting', 'generating')";
// D1 runs every statement atomically and serializes writes, so the Postgres parent row lock
// (FOR UPDATE) becomes this predicate inside the same UPDATE statement: manifest changes and final
// publication cannot interleave. Ready parts are immutable; only releasing their lease remains
// possible before publication. ?1 is always the recording ID.
const writableRecordingSql = `EXISTS (SELECT 1 FROM slop_recordings r
  WHERE r.id = ?1 AND r.storage_mode = 'parts' AND r.upload_state = 'pending')`;
const jobColumns: Record<keyof JobPatch, string> = {
  status: 'status', providerFileName: 'provider_file_name', providerFileUri: 'provider_file_uri', interactionId: 'interaction_id',
  markdown: 'markdown', error: 'error', attempts: 'attempts', cleanupPending: 'cleanup_pending', cleanupAfter: 'cleanup_after',
  nextRunAt: 'next_run_at', deadlineAt: 'deadline_at',
};
const timestampColumns = new Set<keyof JobPatch>(['cleanupAfter', 'nextRunAt', 'deadlineAt']);

export function createD1Repository(db: D1DatabaseLike): Repository {
  async function rows(query: string, values: D1Value[] = []): Promise<Row[]> {
    return (await db.prepare(query).bind(...values).all<Row>()).results;
  }
  async function execute(query: string, values: D1Value[]) {
    await db.prepare(query).bind(...values).run();
  }
  async function recording(query: string, values: D1Value[]) {
    const result = (await rows(query, values))[0];
    return result ? mapRecording(result) : null;
  }
  async function job(query: string, values: D1Value[]) {
    const result = (await rows(query, values))[0];
    return result ? mapJob(result) : null;
  }
  async function part(query: string, values: D1Value[]) {
    const result = (await rows(query, values))[0];
    return result ? mapPart(result) : null;
  }
  function updatePart(id: string, index: number, owner: string, fence: number, assignments: string, values: D1Value[] = [], condition = '') {
    return part(`UPDATE slop_recording_parts SET ${assignments}, updated_at = ${now}
      WHERE recording_id = ?1 AND part_index = ?2 AND lease_owner = ?3 AND lease_version = ?4
      AND lease_until > ${now} AND upload_state = 'pending' ${condition} AND ${writableRecordingSql} RETURNING *`,
    [uuid(id), index, owner, fence, ...values]);
  }
  const required = <T>(value: T | null) => { if (value === null) throw new Error('The requested database record is unavailable.'); return value; };
  return {
    async createRecording(input) {
      const multipart = input.sizeBytes > MAX_SINGLE_UPLOAD_BYTES;
      // A replayed request ID changes nothing (the no-op update only makes RETURNING yield the row):
      // the stored row comes back so the caller can detect a mismatch.
      return required(await recording(`INSERT INTO slop_recordings
        (id, request_id, upload_id, title, content_type, size_bytes, duration_seconds, created_at, object_key,
         upload_attempted_at, storage_mode, chunk_size_bytes, part_count)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12)
        ON CONFLICT (request_id) DO UPDATE SET request_id = excluded.request_id RETURNING *`,
      [uuid(input.id), uuid(input.requestId), uuid(input.uploadId), input.title, input.contentType,
        input.sizeBytes, input.durationSeconds, timestamp(input.createdAt), input.objectKey, multipart ? 'parts' : 'single',
        multipart ? UPLOAD_CHUNK_BYTES : null, multipart ? Math.ceil(input.sizeBytes / UPLOAD_CHUNK_BYTES) : null]));
    },
    getRecording: id => recording('SELECT * FROM slop_recordings WHERE id = ?1', [uuid(id)]),
    getRecordingByRequest: requestId => recording('SELECT * FROM slop_recordings WHERE request_id = ?1', [uuid(requestId)]),
    async attachTransfer(id, transferId) {
      return required(await recording('UPDATE slop_recordings SET transfer_id = ?2 WHERE id = ?1 AND (transfer_id IS NULL OR transfer_id = ?2) RETURNING *', [uuid(id), transferId]));
    },
    claimUpload: (id, owner) => recording(`UPDATE slop_recordings SET upload_lease_owner = ?2, upload_lease_until = ${leaseUntil}
      WHERE id = ?1 AND (upload_lease_until IS NULL OR upload_lease_until <= ${now}) RETURNING *`, [uuid(id), owner]),
    saveUploadDigest: (id, owner, digest) => recording(`UPDATE slop_recordings SET upload_sha256 = ?3
      WHERE id = ?1 AND upload_lease_owner = ?2 AND upload_lease_until > ${now}
      AND (upload_sha256 IS NULL OR upload_sha256 = ?3) RETURNING *`, [uuid(id), owner, digest]),
    markUploadAttempt: (id, owner, attempted) => recording(`UPDATE slop_recordings SET upload_attempted_at = CASE WHEN ?3 = 1 THEN ${now} ELSE NULL END
      WHERE id = ?1 AND upload_lease_owner = ?2 AND upload_lease_until > ${now} RETURNING *`, [uuid(id), owner, flag(attempted)]),
    async releaseUpload(id, owner) {
      await execute('UPDATE slop_recordings SET upload_lease_owner = NULL, upload_lease_until = NULL WHERE id = ?1 AND upload_lease_owner = ?2', [uuid(id), owner]);
    },
    async completeRecording(id) {
      return required(await recording("UPDATE slop_recordings SET upload_state = 'ready' WHERE id = ?1 AND storage_mode = 'single' AND transfer_id IS NOT NULL AND upload_state <> 'deleted' RETURNING *", [uuid(id)]));
    },
    async updateRecording(id, patch) {
      return required(await recording('UPDATE slop_recordings SET protected = COALESCE(?2, protected), markdown_enabled = COALESCE(?3, markdown_enabled) WHERE id = ?1 RETURNING *',
        [uuid(id), flag(patch.protected), flag(patch.markdownEnabled)]));
    },
    async deleteRecording(id) {
      const deleted = await recording(`UPDATE slop_recordings SET upload_state = 'deleted', title = 'Deleted recording',
          protected = 0, markdown_enabled = 0
        WHERE id = ?1 AND upload_state IN ('ready', 'deleted') RETURNING *`, [uuid(id)]);
      // Finished jobs only: an active job keeps its lease-fenced row and fails on its next run.
      if (deleted) await execute(`UPDATE slop_markdown_jobs SET markdown = NULL, goal = '', updated_at = ${now}
        WHERE recording_id = ?1 AND status NOT IN ${activeSql}`, [deleted.id]);
      return deleted;
    },
    async createPart(recordingId, index) {
      if (!Number.isInteger(index) || index < 0 || index >= MAX_PART_COUNT) return null;
      const id = uuid(recordingId);
      // The parent predicate and the insert are one atomic statement (the Postgres FOR UPDATE lock).
      const created = await part(`INSERT INTO slop_recording_parts (recording_id, part_index, size_bytes, object_key)
        SELECT id, ?2, MIN(chunk_size_bytes, size_bytes - ?2 * chunk_size_bytes), 'recordings/' || id || '/parts/' || printf('%06d', ?2)
        FROM slop_recordings WHERE id = ?1 AND storage_mode = 'parts' AND upload_state = 'pending' AND ?2 < part_count
        ON CONFLICT DO NOTHING RETURNING *`, [id, index]);
      return created ?? part('SELECT * FROM slop_recording_parts WHERE recording_id = ?1 AND part_index = ?2', [id, index]);
    },
    getPart: (id, index) => part('SELECT * FROM slop_recording_parts WHERE recording_id = ?1 AND part_index = ?2', [uuid(id), index]),
    async listParts(id) {
      return (await rows('SELECT * FROM slop_recording_parts WHERE recording_id = ?1 ORDER BY part_index', [uuid(id)])).map(mapPart);
    },
    async deletePart(id, index) {
      await execute(`DELETE FROM slop_recording_parts WHERE recording_id = ?1 AND part_index = ?2
        AND EXISTS (SELECT 1 FROM slop_recordings r WHERE r.id = ?1 AND r.upload_state = 'deleted')`, [uuid(id), index]);
    },
    claimPart: (id, index, owner) => part(`UPDATE slop_recording_parts SET lease_owner = ?3, lease_until = ${leaseUntil},
        lease_version = lease_version + 1, updated_at = ${now}
      WHERE recording_id = ?1 AND part_index = ?2 AND upload_state = 'pending'
        AND (lease_until IS NULL OR lease_until <= ${now}) AND ${writableRecordingSql} RETURNING *`, [uuid(id), index, owner]),
    attachPartTransfer: (id, index, owner, fence, transferId) => updatePart(id, index, owner, fence,
      'transfer_id = ?5', [transferId], 'AND (transfer_id IS NULL OR transfer_id = ?5)'),
    savePartDigest: (id, index, owner, fence, digest) => updatePart(id, index, owner, fence,
      'upload_sha256 = ?5', [digest], 'AND (upload_sha256 IS NULL OR upload_sha256 = ?5)'),
    markPartAttempt: (id, index, owner, fence, attempted) => updatePart(id, index, owner, fence,
      `upload_attempted_at = CASE WHEN ?5 = 1 THEN ${now} ELSE NULL END`, [flag(attempted)]),
    completePart: (id, index, owner, fence) => updatePart(id, index, owner, fence,
      "upload_state = 'ready'", [], 'AND upload_sha256 IS NOT NULL AND transfer_id IS NOT NULL'),
    async releasePart(id, index, owner, fence) {
      await execute(`UPDATE slop_recording_parts SET lease_owner = NULL, lease_until = NULL, updated_at = ${now}
        WHERE recording_id = ?1 AND part_index = ?2 AND lease_owner = ?3 AND lease_version = ?4 AND ${writableRecordingSql}`,
      [uuid(id), index, owner, fence]);
    },
    async completeMultipartRecording(id) {
      const completed = await recording(`UPDATE slop_recordings SET upload_state = 'ready'
        WHERE id = ?1 AND storage_mode = 'parts' AND upload_state = 'pending'
          AND (upload_lease_until IS NULL OR upload_lease_until <= ${now})
          AND part_count = (SELECT count(*) FROM slop_recording_parts p WHERE p.recording_id = slop_recordings.id)
          AND size_bytes = (SELECT sum(p.size_bytes) FROM slop_recording_parts p WHERE p.recording_id = slop_recordings.id)
          AND NOT EXISTS (SELECT 1 FROM slop_recording_parts p WHERE p.recording_id = slop_recordings.id AND (
            p.part_index < 0 OR p.part_index >= slop_recordings.part_count OR p.upload_state <> 'ready'
            OR p.upload_sha256 IS NULL OR p.transfer_id IS NULL
            OR (p.lease_until IS NOT NULL AND p.lease_until > ${now})
            OR p.size_bytes <> MIN(slop_recordings.chunk_size_bytes, slop_recordings.size_bytes - p.part_index * slop_recordings.chunk_size_bytes)
            OR p.object_key <> 'recordings/' || slop_recordings.id || '/parts/' || printf('%06d', p.part_index)
          )) RETURNING *`, [uuid(id)]);
      return completed ?? recording("SELECT * FROM slop_recordings WHERE id = ?1 AND storage_mode = 'parts' AND upload_state = 'ready'", [uuid(id)]);
    },
    async createJob(input) {
      const values = [uuid(input.id), uuid(input.recordingId), uuid(input.requestId), input.goal];
      const insert = 'INSERT INTO slop_markdown_jobs (id, recording_id, request_id, goal) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING RETURNING *';
      const created = await job(insert, values);
      if (created) return { job: created, created: true };
      const previous = await job('SELECT * FROM slop_markdown_jobs WHERE request_id = ?1', [uuid(input.requestId)]);
      if (previous) {
        if (previous.recordingId !== input.recordingId || previous.goal !== input.goal) throw Object.assign(new Error('This generation request was already used with a different goal.'), { code: 'request_conflict', status: 409 });
        return { job: previous, created: false };
      }
      const active = await job(`SELECT * FROM slop_markdown_jobs WHERE recording_id = ?1 AND status IN ${activeSql} ORDER BY created_at DESC LIMIT 1`, [uuid(input.recordingId)]);
      if (active) return { job: active, created: false };
      // The conflicting active job can finish between statements; retry once with the same request ID.
      const retried = await job(insert, values);
      if (retried) return { job: retried, created: true };
      throw Object.assign(new Error('A generation is already being started. Please retry.'), { code: 'generation_busy', status: 409 });
    },
    // Timestamps have millisecond (not microsecond) resolution; rowid keeps "latest" deterministic on ties.
    getLatestJob: id => job('SELECT * FROM slop_markdown_jobs WHERE recording_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1', [uuid(id)]),
    getJob: id => job('SELECT * FROM slop_markdown_jobs WHERE id = ?1', [uuid(id)]),
    async claimJob(id, owner, leaseSeconds) {
      const seconds = Math.min(600, Math.max(1, leaseSeconds));
      if (Number.isNaN(seconds)) throw new RangeError('The job lease duration must be a number of seconds.');
      return job(`UPDATE slop_markdown_jobs SET lease_owner = ?2,
        lease_until = ${nowPlus("'+' || ?3 || ' seconds'")}, lease_version = lease_version + 1
        WHERE id = ?1 AND (lease_until IS NULL OR lease_until <= ${now}) AND next_run_at <= ${now}
        AND (status IN ${activeSql} OR cleanup_pending = 1) RETURNING *`, [uuid(id), owner, seconds]);
    },
    async updateJob(id, owner, leaseVersion, patch) {
      const entries = Object.entries(patch).filter(([name, value]) => Object.hasOwn(jobColumns, name) && value !== undefined) as [keyof JobPatch, Exclude<JobPatch[keyof JobPatch], undefined>][];
      const assignments = entries.map(([name], index) => `${jobColumns[name]} = ?${index + 4}`);
      return job(`UPDATE slop_markdown_jobs SET ${[...assignments, `updated_at = ${now}`].join(', ')}
        WHERE id = ?1 AND lease_owner = ?2 AND lease_version = ?3 AND lease_until > ${now} RETURNING *`,
      [uuid(id), owner, leaseVersion, ...entries.map(([name, value]) => jobValue(name, value))]);
    },
    async releaseJob(id, owner, leaseVersion) {
      await execute('UPDATE slop_markdown_jobs SET lease_owner = NULL, lease_until = NULL WHERE id = ?1 AND lease_owner = ?2 AND lease_version = ?3', [uuid(id), owner, leaseVersion]);
    },
    async listWork(limit) {
      return (await rows(`SELECT * FROM slop_markdown_jobs WHERE next_run_at <= ${now}
        AND (lease_until IS NULL OR lease_until <= ${now}) AND (status IN ${activeSql} OR cleanup_pending = 1)
        ORDER BY next_run_at, created_at LIMIT ?1`, [Math.min(50, Math.max(1, limit))])).map(mapJob);
    },
  };
}

// Postgres uuid columns compared case-insensitively and returned lowercase; stored TEXT is canonical lowercase.
function uuid(value: string) { return value.toLowerCase(); }
function timestamp(value: string) { return new Date(value).toISOString(); }
function flag(value: boolean | null | undefined): D1Value { return value === null || value === undefined ? null : value ? 1 : 0; }
function jobValue(name: keyof JobPatch, value: Exclude<JobPatch[keyof JobPatch], undefined>): D1Value {
  if (value === null || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return timestampColumns.has(name) ? timestamp(value) : value;
}

function iso(value: unknown) { return new Date(String(value)).toISOString(); }
function nullable(value: unknown) { return value === null || value === undefined ? null : String(value); }
function mapRecording(row: Row): RecordingRow {
  return { id: String(row.id), requestId: String(row.request_id), uploadId: String(row.upload_id), title: String(row.title),
    contentType: String(row.content_type), sizeBytes: Number(row.size_bytes), durationSeconds: Number(row.duration_seconds),
    createdAt: iso(row.created_at), objectKey: String(row.object_key), transferId: nullable(row.transfer_id), uploadSha256: nullable(row.upload_sha256), uploadAttempted: row.upload_attempted_at != null,
    uploadState: row.upload_state as RecordingRow['uploadState'], protected: row.protected === 1, markdownEnabled: row.markdown_enabled === 1,
    storageMode: row.storage_mode === 'parts' ? 'parts' : 'single',
    ...(row.chunk_size_bytes == null ? {} : { chunkSizeBytes: Number(row.chunk_size_bytes) }),
    ...(row.part_count == null ? {} : { partCount: Number(row.part_count) }) };
}
function mapPart(row: Row): RecordingPart {
  return { recordingId: String(row.recording_id), index: Number(row.part_index), objectKey: String(row.object_key), sizeBytes: Number(row.size_bytes),
    transferId: nullable(row.transfer_id), uploadSha256: nullable(row.upload_sha256), uploadAttempted: row.upload_attempted_at != null,
    uploadState: row.upload_state as RecordingPart['uploadState'], leaseVersion: Number(row.lease_version) };
}
function mapJob(row: Row): MarkdownJob {
  return { id: String(row.id), recordingId: String(row.recording_id), requestId: String(row.request_id), goal: String(row.goal),
    status: row.status as MarkdownJob['status'], providerFileName: nullable(row.provider_file_name), providerFileUri: nullable(row.provider_file_uri),
    interactionId: nullable(row.interaction_id), markdown: nullable(row.markdown), error: nullable(row.error), attempts: Number(row.attempts),
    cleanupPending: row.cleanup_pending === 1, cleanupAfter: row.cleanup_after == null ? null : iso(row.cleanup_after),
    nextRunAt: iso(row.next_run_at), deadlineAt: iso(row.deadline_at), leaseOwner: nullable(row.lease_owner),
    leaseUntil: row.lease_until == null ? null : iso(row.lease_until), leaseVersion: Number(row.lease_version),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
