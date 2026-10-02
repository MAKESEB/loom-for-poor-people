-- Additive, like every hosted schema change: a deleted recording keeps its row as a tombstone,
-- because its Markdown jobs reference it and may still have to clean up provider resources.
-- deleted_at marks it; the repository then reports the upload state 'deleted'.
ALTER TABLE slop_recordings ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
