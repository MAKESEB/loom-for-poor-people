import { createPrivateDatabaseClient, type CustomerDatabaseClient } from '@ohmyhost/customer-runtime/database';
import { MAX_SINGLE_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES } from '../shared/policy';
import type { JobPatch, MarkdownJob, RecordingPart, RecordingRow, Repository } from './types';

export type QueryClient = Pick<CustomerDatabaseClient, 'query'>;

export class DatabaseUnavailableError extends Error {
  constructor() { super('The managed database binding is unavailable.'); }
}

export function resolveRepository(environment: Record<string, unknown>): Repository {
  const binding = environment.OHMYHOST_DATABASE as Parameters<typeof createPrivateDatabaseClient>[0] | undefined;
  if (!binding || typeof binding.query !== 'function' || typeof binding.transaction !== 'function') throw new DatabaseUnavailableError();
  return createRepository(createPrivateDatabaseClient(binding));
}

const activeSql = "('queued', 'uploading', 'processing', 'submitting', 'generating')";
// Parent row locks serialize manifest changes with final publication. Ready parts
// are immutable; only releasing their lease remains possible before publication.
const writableRecordingSql = `WITH writable_recording AS MATERIALIZED (
  SELECT id FROM slop_recordings WHERE id = $1 AND storage_mode = 'parts' AND upload_state = 'pending' FOR UPDATE
)`;
const jobColumns: Record<keyof JobPatch, string> = {
  status: 'status', providerFileName: 'provider_file_name', providerFileUri: 'provider_file_uri', interactionId: 'interaction_id',
  markdown: 'markdown', error: 'error', attempts: 'attempts', cleanupPending: 'cleanup_pending', cleanupAfter: 'cleanup_after',
  nextRunAt: 'next_run_at', deadlineAt: 'deadline_at',
};

export function createRepository(client: QueryClient): Repository {
  async function rows(text: string, values: Parameters<QueryClient['query']>[0]['values'] = []) {
    return (await client.query({ text, values })).rows;
  }
  async function recording(text: string, values: Parameters<QueryClient['query']>[0]['values']) {
    const result = (await rows(text, values))[0];
    return result ? mapRecording(result) : null;
  }
  async function job(text: string, values: Parameters<QueryClient['query']>[0]['values']) {
    const result = (await rows(text, values))[0];
    return result ? mapJob(result) : null;
  }
  async function part(text: string, values: Parameters<QueryClient['query']>[0]['values']) {
    const result = (await rows(text, values))[0];
    return result ? mapPart(result) : null;
  }
  function updatePart(id: string, index: number, owner: string, fence: number, assignments: string,
    values: Parameters<QueryClient['query']>[0]['values'] = [], condition = '') {
    return part(`${writableRecordingSql}
      UPDATE slop_recording_parts p SET ${assignments}, updated_at = now() FROM writable_recording r
      WHERE p.recording_id = r.id AND p.part_index = $2 AND p.lease_owner = $3 AND p.lease_version = $4
      AND p.lease_until > now() AND p.upload_state = 'pending' ${condition} RETURNING p.*`, [id, index, owner, fence, ...values]);
  }
  const required = <T>(value: T | null) => { if (value === null) throw new Error('The requested database record is unavailable.'); return value; };
  return {
    async createRecording(input) {
      const multipart = input.sizeBytes > MAX_SINGLE_UPLOAD_BYTES;
      return required(await recording(`INSERT INTO slop_recordings
        (id, request_id, upload_id, title, content_type, size_bytes, duration_seconds, created_at, object_key, upload_attempted_at,
         full_size_bytes, full_duration_seconds, storage_mode, chunk_size_bytes, part_count)
        VALUES ($1,$2,$3,$4,$5,LEAST($6::integer,52428800),LEAST($7::double precision,900),$8,$9,NULL,$6,$7,$10,$11,$12)
        ON CONFLICT (request_id) DO UPDATE SET request_id = EXCLUDED.request_id RETURNING *`,
      [input.id, input.requestId, input.uploadId, input.title, input.contentType, input.sizeBytes, input.durationSeconds, input.createdAt, input.objectKey,
        multipart ? 'parts' : 'single', multipart ? UPLOAD_CHUNK_BYTES : null, multipart ? Math.ceil(input.sizeBytes / UPLOAD_CHUNK_BYTES) : null]));
    },
    getRecording: id => recording('SELECT * FROM slop_recordings WHERE id = $1', [id]),
    getRecordingByRequest: requestId => recording('SELECT * FROM slop_recordings WHERE request_id = $1', [requestId]),
    async attachTransfer(id, transferId) {
      return required(await recording('UPDATE slop_recordings SET transfer_id = $2 WHERE id = $1 AND (transfer_id IS NULL OR transfer_id = $2) RETURNING *', [id, transferId]));
    },
    claimUpload: (id, owner) => recording(`UPDATE slop_recordings SET upload_lease_owner = $2, upload_lease_until = now() + interval '3 minutes'
      WHERE id = $1 AND (upload_lease_until IS NULL OR upload_lease_until <= now()) RETURNING *`, [id, owner]),
    saveUploadDigest: (id, owner, digest) => recording(`UPDATE slop_recordings SET upload_sha256 = $3
      WHERE id = $1 AND upload_lease_owner = $2 AND upload_lease_until > now()
      AND (upload_sha256 IS NULL OR upload_sha256 = $3) RETURNING *`, [id, owner, digest]),
    markUploadAttempt: (id, owner, attempted) => recording(`UPDATE slop_recordings SET upload_attempted_at = CASE WHEN $3::boolean THEN now() ELSE NULL END
      WHERE id = $1 AND upload_lease_owner = $2 AND upload_lease_until > now() RETURNING *`, [id, owner, attempted]),
    async releaseUpload(id, owner) {
      await rows('UPDATE slop_recordings SET upload_lease_owner = NULL, upload_lease_until = NULL WHERE id = $1 AND upload_lease_owner = $2', [id, owner]);
    },
    async completeRecording(id) {
      return required(await recording("UPDATE slop_recordings SET upload_state = 'ready' WHERE id = $1 AND storage_mode = 'single' AND transfer_id IS NOT NULL RETURNING *", [id]));
    },
    async updateRecording(id, patch) {
      return required(await recording('UPDATE slop_recordings SET protected = COALESCE($2::boolean, protected), markdown_enabled = COALESCE($3::boolean, markdown_enabled) WHERE id = $1 RETURNING *', [id, patch.protected ?? null, patch.markdownEnabled ?? null]));
    },
    async createPart(recordingId, index) {
      if (!Number.isInteger(index) || index < 0 || index >= 128) return null;
      const created = await part(`WITH parent AS MATERIALIZED (
        SELECT id, full_size_bytes, chunk_size_bytes, part_count FROM slop_recordings
        WHERE id = $1 AND storage_mode = 'parts' AND upload_state = 'pending' AND $2::integer < part_count FOR UPDATE
      ) INSERT INTO slop_recording_parts (recording_id, part_index, size_bytes, object_key)
        SELECT id, $2::integer, LEAST(chunk_size_bytes, full_size_bytes - $2::integer * chunk_size_bytes),
          'recordings/' || id::text || '/parts/' || lpad($2::text, 6, '0') FROM parent
        ON CONFLICT DO NOTHING RETURNING *`, [recordingId, index]);
      return created ?? part('SELECT * FROM slop_recording_parts WHERE recording_id = $1 AND part_index = $2', [recordingId, index]);
    },
    getPart: (id, index) => part('SELECT * FROM slop_recording_parts WHERE recording_id = $1 AND part_index = $2', [id, index]),
    async listParts(id) {
      return (await rows('SELECT * FROM slop_recording_parts WHERE recording_id = $1 ORDER BY part_index', [id])).map(mapPart);
    },
    claimPart: (id, index, owner) => part(`${writableRecordingSql}
      UPDATE slop_recording_parts p SET lease_owner = $3, lease_until = now() + interval '3 minutes',
        lease_version = lease_version + 1, updated_at = now() FROM writable_recording r
      WHERE p.recording_id = r.id AND p.part_index = $2 AND p.upload_state = 'pending'
        AND (p.lease_until IS NULL OR p.lease_until <= now()) RETURNING p.*`, [id, index, owner]),
    attachPartTransfer: (id, index, owner, fence, transferId) => updatePart(id, index, owner, fence,
      'transfer_id = $5', [transferId], 'AND (p.transfer_id IS NULL OR p.transfer_id = $5)'),
    savePartDigest: (id, index, owner, fence, digest) => updatePart(id, index, owner, fence,
      'upload_sha256 = $5', [digest], 'AND (p.upload_sha256 IS NULL OR p.upload_sha256 = $5)'),
    markPartAttempt: (id, index, owner, fence, attempted) => updatePart(id, index, owner, fence,
      'upload_attempted_at = CASE WHEN $5::boolean THEN now() ELSE NULL END', [attempted]),
    completePart: (id, index, owner, fence) => updatePart(id, index, owner, fence,
      "upload_state = 'ready'", [], 'AND p.upload_sha256 IS NOT NULL AND p.transfer_id IS NOT NULL'),
    async releasePart(id, index, owner, fence) {
      await rows(`${writableRecordingSql}
        UPDATE slop_recording_parts p SET lease_owner = NULL, lease_until = NULL, updated_at = now() FROM writable_recording r
        WHERE p.recording_id = r.id AND p.part_index = $2 AND p.lease_owner = $3 AND p.lease_version = $4`, [id, index, owner, fence]);
    },
    async completeMultipartRecording(id) {
      const completed = await recording(`UPDATE slop_recordings r SET upload_state = 'ready'
        WHERE r.id = $1 AND r.storage_mode = 'parts' AND r.upload_state = 'pending'
          AND (r.upload_lease_until IS NULL OR r.upload_lease_until <= now())
          AND r.part_count = (SELECT count(*) FROM slop_recording_parts p WHERE p.recording_id = r.id)
          AND r.full_size_bytes = (SELECT sum(p.size_bytes) FROM slop_recording_parts p WHERE p.recording_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM slop_recording_parts p WHERE p.recording_id = r.id AND (
            p.part_index < 0 OR p.part_index >= r.part_count OR p.upload_state <> 'ready'
            OR p.upload_sha256 IS NULL OR p.transfer_id IS NULL
            OR (p.lease_until IS NOT NULL AND p.lease_until > now())
            OR p.size_bytes <> LEAST(r.chunk_size_bytes, r.full_size_bytes - p.part_index * r.chunk_size_bytes)
            OR p.object_key <> 'recordings/' || r.id::text || '/parts/' || lpad(p.part_index::text, 6, '0')
          )) RETURNING r.*`, [id]);
      return completed ?? recording("SELECT * FROM slop_recordings WHERE id = $1 AND storage_mode = 'parts' AND upload_state = 'ready'", [id]);
    },
    async createJob(input) {
      const created = await job(`INSERT INTO slop_markdown_jobs (id, recording_id, request_id, goal)
        VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *`, [input.id, input.recordingId, input.requestId, input.goal]);
      if (created) return { job: created, created: true };
      const previous = await job('SELECT * FROM slop_markdown_jobs WHERE request_id = $1', [input.requestId]);
      if (previous) {
        if (previous.recordingId !== input.recordingId || previous.goal !== input.goal) throw Object.assign(new Error('This generation request was already used with a different goal.'), { code: 'request_conflict', status: 409 });
        return { job: previous, created: false };
      }
      const active = await job(`SELECT * FROM slop_markdown_jobs WHERE recording_id = $1 AND status IN ${activeSql} ORDER BY created_at DESC LIMIT 1`, [input.recordingId]);
      if (active) return { job: active, created: false };
      // The conflicting active job can finish between statements; retry once with the same request ID.
      const retried = await job(`INSERT INTO slop_markdown_jobs (id, recording_id, request_id, goal)
        VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *`, [input.id, input.recordingId, input.requestId, input.goal]);
      if (retried) return { job: retried, created: true };
      throw Object.assign(new Error('A generation is already being started. Please retry.'), { code: 'generation_busy', status: 409 });
    },
    getLatestJob: id => job('SELECT * FROM slop_markdown_jobs WHERE recording_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [id]),
    getJob: id => job('SELECT * FROM slop_markdown_jobs WHERE id = $1', [id]),
    claimJob: (id, owner, leaseSeconds) => job(`UPDATE slop_markdown_jobs SET lease_owner = $2,
      lease_until = now() + ($3::double precision * interval '1 second'), lease_version = lease_version + 1
      WHERE id = $1 AND (lease_until IS NULL OR lease_until <= now()) AND next_run_at <= now()
      AND (status IN ${activeSql} OR cleanup_pending) RETURNING *`, [id, owner, Math.min(600, Math.max(1, leaseSeconds))]),
    async updateJob(id, owner, leaseVersion, patch) {
      const entries = Object.entries(patch).filter(([name, value]) => Object.hasOwn(jobColumns, name) && value !== undefined) as [keyof JobPatch, Exclude<JobPatch[keyof JobPatch], undefined>][];
      const assignments = entries.map(([name], index) => `${jobColumns[name]} = $${index + 4}`);
      return job(`UPDATE slop_markdown_jobs SET ${[...assignments, 'updated_at = now()'].join(', ')}
        WHERE id = $1 AND lease_owner = $2 AND lease_version = $3 AND lease_until > now() RETURNING *`,
      [id, owner, leaseVersion, ...entries.map(([, value]) => value)]);
    },
    async releaseJob(id, owner, leaseVersion) {
      await rows('UPDATE slop_markdown_jobs SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $2 AND lease_version = $3', [id, owner, leaseVersion]);
    },
    async listWork(limit) {
      return (await rows(`SELECT * FROM slop_markdown_jobs WHERE next_run_at <= now()
        AND (lease_until IS NULL OR lease_until <= now()) AND (status IN ${activeSql} OR cleanup_pending)
        ORDER BY next_run_at, created_at LIMIT $1`, [Math.min(50, Math.max(1, limit))])).map(mapJob);
    },
  };
}

function iso(value: unknown) { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }
function nullable(value: unknown) { return value === null || value === undefined ? null : String(value); }
function mapRecording(row: Readonly<Record<string, unknown>>): RecordingRow {
  return { id: String(row.id), requestId: String(row.request_id), uploadId: String(row.upload_id), title: String(row.title),
    contentType: String(row.content_type), sizeBytes: Number(row.full_size_bytes ?? row.size_bytes), durationSeconds: Number(row.full_duration_seconds ?? row.duration_seconds),
    createdAt: iso(row.created_at), objectKey: String(row.object_key), transferId: nullable(row.transfer_id), uploadSha256: nullable(row.upload_sha256), uploadAttempted: row.upload_attempted_at != null,
    uploadState: row.upload_state as RecordingRow['uploadState'], protected: row.protected === true, markdownEnabled: row.markdown_enabled === true,
    storageMode: row.storage_mode === 'parts' ? 'parts' : 'single',
    ...(row.chunk_size_bytes == null ? {} : { chunkSizeBytes: Number(row.chunk_size_bytes) }),
    ...(row.part_count == null ? {} : { partCount: Number(row.part_count) }) };
}
function mapPart(row: Readonly<Record<string, unknown>>): RecordingPart {
  return { recordingId: String(row.recording_id), index: Number(row.part_index), objectKey: String(row.object_key), sizeBytes: Number(row.size_bytes),
    transferId: nullable(row.transfer_id), uploadSha256: nullable(row.upload_sha256), uploadAttempted: row.upload_attempted_at != null,
    uploadState: row.upload_state as RecordingPart['uploadState'], leaseVersion: Number(row.lease_version) };
}
function mapJob(row: Readonly<Record<string, unknown>>): MarkdownJob {
  return { id: String(row.id), recordingId: String(row.recording_id), requestId: String(row.request_id), goal: String(row.goal),
    status: row.status as MarkdownJob['status'], providerFileName: nullable(row.provider_file_name), providerFileUri: nullable(row.provider_file_uri),
    interactionId: nullable(row.interaction_id), markdown: nullable(row.markdown), error: nullable(row.error), attempts: Number(row.attempts),
    cleanupPending: row.cleanup_pending === true, cleanupAfter: row.cleanup_after == null ? null : iso(row.cleanup_after),
    nextRunAt: iso(row.next_run_at), deadlineAt: iso(row.deadline_at), leaseOwner: nullable(row.lease_owner),
    leaseUntil: row.lease_until == null ? null : iso(row.lease_until), leaseVersion: Number(row.lease_version),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
