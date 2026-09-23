CREATE TABLE IF NOT EXISTS slop_recordings (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  upload_id uuid NOT NULL UNIQUE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  content_type text NOT NULL CHECK (content_type IN ('video/webm', 'video/mp4')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 52428800),
  duration_seconds double precision NOT NULL CHECK (duration_seconds >= 0 AND duration_seconds <= 900),
  created_at timestamptz NOT NULL DEFAULT now(),
  object_key text NOT NULL UNIQUE,
  transfer_id text,
  upload_state text NOT NULL DEFAULT 'pending' CHECK (upload_state IN ('pending', 'ready')),
  protected boolean NOT NULL DEFAULT false,
  markdown_enabled boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS slop_markdown_jobs (
  id uuid PRIMARY KEY,
  recording_id uuid NOT NULL REFERENCES slop_recordings(id),
  request_id uuid NOT NULL UNIQUE,
  goal text NOT NULL CHECK (char_length(goal) <= 4000),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'uploading', 'processing', 'submitting', 'generating', 'completed', 'failed', 'uncertain')),
  provider_file_name text,
  provider_file_uri text,
  interaction_id text,
  markdown text,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  cleanup_pending boolean NOT NULL DEFAULT false,
  cleanup_after timestamptz,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  lease_owner text,
  lease_until timestamptz,
  lease_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS slop_one_active_job ON slop_markdown_jobs(recording_id)
  WHERE status IN ('queued', 'uploading', 'processing', 'submitting', 'generating');
CREATE INDEX IF NOT EXISTS slop_jobs_recording_created ON slop_markdown_jobs(recording_id, created_at DESC);
CREATE INDEX IF NOT EXISTS slop_jobs_due ON slop_markdown_jobs(next_run_at)
  WHERE status IN ('queued', 'uploading', 'processing', 'submitting', 'generating') OR cleanup_pending;
