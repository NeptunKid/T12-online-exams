CREATE TABLE organization_departments (
  id text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('dingtalk', 'feishu')),
  external_id text NOT NULL,
  name text NOT NULL,
  parent_external_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, external_id)
);

CREATE TABLE user_departments (
  user_id text NOT NULL REFERENCES users (id),
  department_id text NOT NULL REFERENCES organization_departments (id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, department_id)
);

CREATE INDEX organization_departments_active_name_idx
  ON organization_departments (status, name, provider, external_id);

CREATE INDEX user_departments_department_idx
  ON user_departments (department_id, user_id);
