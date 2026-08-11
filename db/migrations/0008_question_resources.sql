CREATE TABLE question_resources (
  id text PRIMARY KEY,
  mime_type text NOT NULL
    CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  content bytea NOT NULL,
  size_bytes integer NOT NULL
    CHECK (size_bytes BETWEEN 1 AND 5242880),
  sha256 text NOT NULL UNIQUE
    CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (octet_length(content) = size_bytes)
);

