CREATE TABLE backup_runs (
  id text PRIMARY KEY,
  scope_type text NOT NULL
    CHECK (scope_type IN ('system', 'exam', 'question-bank')),
  scope_id text NOT NULL DEFAULT '',
  trigger_type text NOT NULL
    CHECK (trigger_type IN ('manual', 'scheduled')),
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'failed')),
  requested_by text REFERENCES users (id),
  started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz,
  error_message text,
  CHECK (
    (scope_type = 'system' AND scope_id = '')
    OR (scope_type <> 'system' AND length(scope_id) > 0)
  ),
  CHECK (
    (status = 'running' AND completed_at IS NULL AND error_message IS NULL)
    OR (status = 'succeeded' AND completed_at IS NOT NULL AND error_message IS NULL)
    OR (status = 'failed' AND completed_at IS NOT NULL AND length(error_message) > 0)
  ),
  CHECK (trigger_type <> 'manual' OR requested_by IS NOT NULL)
);

CREATE INDEX backup_runs_scope_recent_idx
  ON backup_runs (scope_type, scope_id, completed_at DESC, id DESC)
  WHERE status = 'succeeded';

CREATE INDEX backup_runs_started_at_idx
  ON backup_runs (started_at DESC, id DESC);

CREATE TABLE backup_artifacts (
  id text PRIMARY KEY,
  run_id text NOT NULL UNIQUE REFERENCES backup_runs (id) ON DELETE CASCADE,
  storage_type text NOT NULL
    CHECK (storage_type IN ('database', 'filesystem')),
  filename text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/vnd.t12.exam-backup+zip',
  content bytea,
  storage_key text,
  sha256 text NOT NULL
    CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL
    CHECK (size_bytes > 0),
  retention_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (storage_type = 'database' AND content IS NOT NULL AND storage_key IS NULL)
    OR (storage_type = 'filesystem' AND content IS NULL AND length(storage_key) > 0)
  ),
  CHECK (storage_type <> 'database' OR octet_length(content) = size_bytes)
);

CREATE INDEX backup_artifacts_retention_idx
  ON backup_artifacts (retention_expires_at)
  WHERE retention_expires_at IS NOT NULL;
