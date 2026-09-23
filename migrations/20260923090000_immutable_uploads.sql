ALTER TABLE slop_recordings ADD COLUMN IF NOT EXISTS upload_sha256 text CHECK (upload_sha256 IS NULL OR upload_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE slop_recordings ADD COLUMN IF NOT EXISTS upload_lease_owner text;
ALTER TABLE slop_recordings ADD COLUMN IF NOT EXISTS upload_lease_until timestamptz;
