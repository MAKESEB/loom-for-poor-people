ALTER TABLE slop_recordings ADD COLUMN IF NOT EXISTS upload_attempted_at timestamptz DEFAULT now();
