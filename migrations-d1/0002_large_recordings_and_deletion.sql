-- Recordings up to 10 GiB (1,280 parts of 8 MiB) and deleted recordings.
--
-- SQLite cannot change a CHECK constraint in place, so slop_recordings and slop_recording_parts are
-- rebuilt: copy the rows aside, drop the table, create it again under the same name and copy the rows
-- back. D1 cannot switch foreign keys off inside its migration transaction, so checks are deferred to
-- the end of it instead. Dropping slop_recordings leaves its jobs and parts without a parent for a
-- moment; SQLite counts those violations and takes each back when the parent row is inserted again
-- into the table of that name. (Renaming a copy into place would not: the count would stay and the
-- commit would fail.) Child tables reference slop_recordings by name, so nothing else changes.
--
-- Changes against 0001:
--   * slop_recordings.size_bytes: up to 10 GiB (MAX_RECORDING_BYTES in src/shared/policy.ts).
--   * slop_recordings.part_count and slop_recording_parts.part_index: up to 1,280 parts.
--   * slop_recordings.upload_state: also 'deleted'. A deleted recording keeps its row as a tombstone
--     so Markdown jobs (which reference it) can still finish their provider cleanup; its title is
--     cleared and every route treats it as missing.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE slop_recordings_previous AS SELECT * FROM slop_recordings ORDER BY rowid;
DROP TABLE slop_recordings;

CREATE TABLE slop_recordings (
  id TEXT PRIMARY KEY CHECK (id GLOB '????????-????-????-????-????????????' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  request_id TEXT NOT NULL UNIQUE CHECK (request_id GLOB '????????-????-????-????-????????????' AND length(replace(request_id, '-', '')) = 32 AND replace(request_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  upload_id TEXT NOT NULL UNIQUE CHECK (upload_id GLOB '????????-????-????-????-????????????' AND length(replace(upload_id, '-', '')) = 32 AND replace(upload_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  content_type TEXT NOT NULL CHECK (content_type IN ('video/webm', 'video/mp4')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 10737418240),
  -- Finite and non-negative; NaN binds as NULL and fails NOT NULL.
  duration_seconds REAL NOT NULL CHECK (duration_seconds >= 0 AND duration_seconds <= 1.7976931348623157e308),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  object_key TEXT NOT NULL UNIQUE,
  transfer_id TEXT,
  upload_state TEXT NOT NULL DEFAULT 'pending' CHECK (upload_state IN ('pending', 'ready', 'deleted')),
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
  part_count INTEGER CHECK (part_count BETWEEN 1 AND 1280)
) STRICT;

INSERT INTO slop_recordings (id, request_id, upload_id, title, content_type, size_bytes,
  duration_seconds, created_at, object_key, transfer_id, upload_state, protected, markdown_enabled, upload_sha256,
  upload_lease_owner, upload_lease_until, upload_attempted_at, storage_mode, chunk_size_bytes, part_count)
SELECT id, request_id, upload_id, title, content_type, size_bytes,
  duration_seconds, created_at, object_key, transfer_id, upload_state, protected, markdown_enabled, upload_sha256,
  upload_lease_owner, upload_lease_until, upload_attempted_at, storage_mode, chunk_size_bytes, part_count
FROM slop_recordings_previous ORDER BY rowid;
DROP TABLE slop_recordings_previous;

CREATE TABLE slop_recording_parts_previous AS SELECT * FROM slop_recording_parts ORDER BY rowid;
DROP TABLE slop_recording_parts;

CREATE TABLE slop_recording_parts (
  recording_id TEXT NOT NULL REFERENCES slop_recordings(id),
  part_index INTEGER NOT NULL CHECK (part_index BETWEEN 0 AND 1279),
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

INSERT INTO slop_recording_parts (recording_id, part_index, size_bytes, object_key, transfer_id, upload_sha256,
  upload_attempted_at, upload_state, lease_owner, lease_until, lease_version, updated_at)
SELECT recording_id, part_index, size_bytes, object_key, transfer_id, upload_sha256,
  upload_attempted_at, upload_state, lease_owner, lease_until, lease_version, updated_at
FROM slop_recording_parts_previous ORDER BY rowid;
DROP TABLE slop_recording_parts_previous;
