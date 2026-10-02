-- Slop Rooster schema for Cloudflare D1 (SQLite). Applied by `wrangler d1 migrations apply DB`.
--
-- The SQLite equivalent of the four Postgres migrations in migrations/ (used by ohmyho.st hosting and
-- local `npm run dev`), consolidated into one schema. A D1 database starts empty, so size_bytes and
-- duration_seconds hold the full values; the Postgres full_size_bytes and full_duration_seconds
-- compatibility columns are not needed here.
--
-- Type conventions (STRICT tables enforce the declared storage class):
--   * UUIDs are canonical lowercase TEXT (the repository lowercases input, as Postgres uuid did).
--   * Booleans are INTEGER 0/1.
--   * Timestamps are TEXT in ISO-8601 UTC with milliseconds, 'YYYY-MM-DDTHH:MM:SS.sssZ', produced by
--     strftime('%Y-%m-%dT%H:%M:%fZ', 'now') or JavaScript toISOString(). The fixed format makes
--     lexicographic comparison equal chronological comparison, which every lease check relies on.
--     Each timestamp CHECK requires the value to equal its own canonical strftime rendering.
--
-- D1 limits LIKE/GLOB patterns to 50 bytes, so every GLOB here stays short.
--
-- There is no per-user ownership column: everyone who signs in with the shared access UUID has the
-- same creator privileges, exactly as with the Postgres schema.

CREATE TABLE slop_recordings (
  id TEXT PRIMARY KEY CHECK (id GLOB '????????-????-????-????-????????????' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  request_id TEXT NOT NULL UNIQUE CHECK (request_id GLOB '????????-????-????-????-????????????' AND length(replace(request_id, '-', '')) = 32 AND replace(request_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  upload_id TEXT NOT NULL UNIQUE CHECK (upload_id GLOB '????????-????-????-????-????????????' AND length(replace(upload_id, '-', '')) = 32 AND replace(upload_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  content_type TEXT NOT NULL CHECK (content_type IN ('video/webm', 'video/mp4')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 1073741824),
  -- Finite and non-negative; NaN binds as NULL and fails NOT NULL.
  duration_seconds REAL NOT NULL CHECK (duration_seconds >= 0 AND duration_seconds <= 1.7976931348623157e308),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  object_key TEXT NOT NULL UNIQUE,
  transfer_id TEXT,
  upload_state TEXT NOT NULL DEFAULT 'pending' CHECK (upload_state IN ('pending', 'ready')),
  protected INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0, 1)),
  markdown_enabled INTEGER NOT NULL DEFAULT 0 CHECK (markdown_enabled IN (0, 1)),
  upload_sha256 TEXT CHECK (upload_sha256 IS NULL OR (length(upload_sha256) = 64 AND upload_sha256 NOT GLOB '*[^0-9a-f]*')),
  upload_lease_owner TEXT,
  upload_lease_until TEXT
    CHECK (upload_lease_until IS strftime('%Y-%m-%dT%H:%M:%fZ', upload_lease_until)),
  -- Conservative default: a row written without an explicit outcome requires upload reconciliation.
  -- The repository always inserts NULL for new reservations.
  upload_attempted_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (upload_attempted_at IS strftime('%Y-%m-%dT%H:%M:%fZ', upload_attempted_at)),
  storage_mode TEXT NOT NULL DEFAULT 'single' CHECK (storage_mode IN ('single', 'parts')),
  chunk_size_bytes INTEGER CHECK (chunk_size_bytes BETWEEN 1 AND 8388608),
  part_count INTEGER CHECK (part_count BETWEEN 1 AND 128)
) STRICT;

CREATE TABLE slop_markdown_jobs (
  id TEXT PRIMARY KEY CHECK (id GLOB '????????-????-????-????-????????????' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  recording_id TEXT NOT NULL REFERENCES slop_recordings(id),
  request_id TEXT NOT NULL UNIQUE CHECK (request_id GLOB '????????-????-????-????-????????????' AND length(replace(request_id, '-', '')) = 32 AND replace(request_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  goal TEXT NOT NULL CHECK (length(goal) <= 4000),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'uploading', 'processing', 'submitting', 'generating', 'completed', 'failed', 'uncertain')),
  provider_file_name TEXT,
  provider_file_uri TEXT,
  interaction_id TEXT,
  markdown TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_pending IN (0, 1)),
  cleanup_after TEXT
    CHECK (cleanup_after IS strftime('%Y-%m-%dT%H:%M:%fZ', cleanup_after)),
  next_run_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (next_run_at IS strftime('%Y-%m-%dT%H:%M:%fZ', next_run_at)),
  deadline_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 minutes'))
    CHECK (deadline_at IS strftime('%Y-%m-%dT%H:%M:%fZ', deadline_at)),
  lease_owner TEXT,
  lease_until TEXT
    CHECK (lease_until IS strftime('%Y-%m-%dT%H:%M:%fZ', lease_until)),
  lease_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at))
) STRICT;

CREATE UNIQUE INDEX slop_one_active_job ON slop_markdown_jobs (recording_id)
  WHERE status IN ('queued', 'uploading', 'processing', 'submitting', 'generating');
CREATE INDEX slop_jobs_recording_created ON slop_markdown_jobs (recording_id, created_at DESC);
CREATE INDEX slop_jobs_due ON slop_markdown_jobs (next_run_at)
  WHERE status IN ('queued', 'uploading', 'processing', 'submitting', 'generating') OR cleanup_pending = 1;

CREATE TABLE slop_recording_parts (
  recording_id TEXT NOT NULL REFERENCES slop_recordings(id),
  part_index INTEGER NOT NULL CHECK (part_index BETWEEN 0 AND 127),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
  object_key TEXT NOT NULL UNIQUE,
  transfer_id TEXT CHECK (transfer_id IS NULL OR length(transfer_id) > 0),
  upload_sha256 TEXT CHECK (upload_sha256 IS NULL OR (length(upload_sha256) = 64 AND upload_sha256 NOT GLOB '*[^0-9a-f]*')),
  upload_attempted_at TEXT
    CHECK (upload_attempted_at IS strftime('%Y-%m-%dT%H:%M:%fZ', upload_attempted_at)),
  upload_state TEXT NOT NULL DEFAULT 'pending' CHECK (upload_state IN ('pending', 'ready')),
  lease_owner TEXT,
  lease_until TEXT
    CHECK (lease_until IS strftime('%Y-%m-%dT%H:%M:%fZ', lease_until)),
  lease_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  PRIMARY KEY (recording_id, part_index)
) STRICT;
