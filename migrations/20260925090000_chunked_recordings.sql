-- Keep legacy constraints and rows intact; new metadata stores the full recording.
ALTER TABLE slop_recordings ADD COLUMN IF NOT EXISTS full_size_bytes integer CHECK (full_size_bytes BETWEEN 1 AND 1073741824);
ALTER TABLE slop_recordings ADD COLUMN IF NOT EXISTS full_duration_seconds double precision CHECK (full_duration_seconds >= 0 AND full_duration_seconds < 'Infinity'::double precision);
ALTER TABLE slop_recordings ADD COLUMN IF NOT EXISTS storage_mode text NOT NULL DEFAULT 'single' CHECK (storage_mode IN ('single', 'parts'));
ALTER TABLE slop_recordings ADD COLUMN IF NOT EXISTS chunk_size_bytes integer CHECK (chunk_size_bytes BETWEEN 1 AND 8388608);
ALTER TABLE slop_recordings ADD COLUMN IF NOT EXISTS part_count integer CHECK (part_count BETWEEN 1 AND 128);

CREATE TABLE IF NOT EXISTS slop_recording_parts (
  recording_id uuid NOT NULL REFERENCES slop_recordings(id),
  part_index integer NOT NULL CHECK (part_index BETWEEN 0 AND 127),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
  object_key text NOT NULL UNIQUE,
  transfer_id text CHECK (transfer_id IS NULL OR char_length(transfer_id) > 0),
  upload_sha256 text CHECK (upload_sha256 IS NULL OR upload_sha256 ~ '^[0-9a-f]{64}$'),
  upload_attempted_at timestamptz,
  upload_state text NOT NULL DEFAULT 'pending' CHECK (upload_state IN ('pending', 'ready')),
  lease_owner text,
  lease_until timestamptz,
  lease_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recording_id, part_index)
);
