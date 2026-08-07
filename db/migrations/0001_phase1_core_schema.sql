-- Phase 1 的领域基础表。ID 由应用层生成，便于保留 002 的历史答卷 ID。

CREATE OR REPLACE FUNCTION app_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE TABLE users (
  id text PRIMARY KEY,
  name text NOT NULL,
  employee_no text,
  department text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'legacy_unmatched')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX users_employee_no_unique_idx ON users (employee_no) WHERE employee_no IS NOT NULL;

CREATE TABLE user_identities (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users (id),
  provider text NOT NULL CHECK (provider IN ('dingtalk', 'feishu', 'legacy')),
  provider_subject text NOT NULL,
  union_id text,
  open_id text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, provider_subject)
);

CREATE UNIQUE INDEX user_identities_provider_union_id_unique_idx
  ON user_identities (provider, union_id) WHERE union_id IS NOT NULL;
CREATE UNIQUE INDEX user_identities_provider_open_id_unique_idx
  ON user_identities (provider, open_id) WHERE open_id IS NOT NULL;

CREATE TABLE roles (
  code text PRIMARY KEY CHECK (code IN ('student', 'grader', 'exam_admin', 'system_admin')),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_roles (
  user_id text NOT NULL REFERENCES users (id),
  role_code text NOT NULL REFERENCES roles (code),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, role_code)
);

INSERT INTO roles (code, name, description) VALUES
  ('student', '考生', '查看被分配考试、提交答卷并查看本人结果'),
  ('grader', '阅卷人', '查看被分派答卷、阅卷并写入批注'),
  ('exam_admin', '考试管理员', '管理考试、题库、考试分配与阅卷分派'),
  ('system_admin', '系统管理员', '管理用户、角色、集成、审计与系统配置');

CREATE TABLE question_banks (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  owner_id text REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE questions (
  id text PRIMARY KEY,
  bank_id text NOT NULL REFERENCES question_banks (id),
  external_id text,
  type text NOT NULL CHECK (type IN ('single', 'multi', 'judge', 'qa')),
  stem text NOT NULL,
  options_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  answer_json jsonb NOT NULL DEFAULT 'null'::jsonb,
  explanation text NOT NULL DEFAULT '',
  score numeric(10, 2) NOT NULL CHECK (score >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX questions_bank_external_id_unique_idx
  ON questions (bank_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE exams (
  id text PRIMARY KEY,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'published', 'paused', 'closed', 'archived')),
  duration_seconds integer NOT NULL CHECK (duration_seconds > 0),
  pass_score numeric(10, 2) NOT NULL CHECK (pass_score >= 0),
  total_score numeric(10, 2) NOT NULL CHECK (total_score >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  answer_rules_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE exam_questions (
  exam_id text NOT NULL REFERENCES exams (id),
  question_id text NOT NULL REFERENCES questions (id),
  position integer NOT NULL CHECK (position > 0),
  score numeric(10, 2) NOT NULL CHECK (score >= 0),
  section text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (exam_id, question_id),
  UNIQUE (exam_id, position)
);

CREATE TABLE exam_assignments (
  id text PRIMARY KEY,
  exam_id text NOT NULL REFERENCES exams (id),
  subject_type text NOT NULL CHECK (subject_type IN ('user', 'department', 'group')),
  subject_id text NOT NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  UNIQUE (exam_id, subject_type, subject_id)
);

CREATE TABLE submissions (
  id text PRIMARY KEY,
  legacy_submission_id text UNIQUE,
  exam_id text NOT NULL REFERENCES exams (id),
  exam_version integer NOT NULL CHECK (exam_version > 0),
  user_id text REFERENCES users (id),
  legacy_student_name text,
  legacy_dingtalk_union_id text,
  attempt_no integer NOT NULL DEFAULT 1 CHECK (attempt_no > 0),
  status text NOT NULL CHECK (status IN ('pending', 'graded', 'cancelled')),
  started_at timestamptz,
  submitted_at timestamptz NOT NULL,
  duration_seconds integer NOT NULL CHECK (duration_seconds >= 0),
  objective_score numeric(10, 2) NOT NULL DEFAULT 0 CHECK (objective_score >= 0),
  qa_score numeric(10, 2) NOT NULL DEFAULT 0 CHECK (qa_score >= 0),
  total_score numeric(10, 2),
  pass_score numeric(10, 2) NOT NULL CHECK (pass_score >= 0),
  pass boolean,
  scores_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  grader_id text REFERENCES users (id),
  grader_name text,
  grader_comment text NOT NULL DEFAULT '',
  graded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX submissions_exam_user_idx ON submissions (exam_id, user_id, submitted_at DESC);
CREATE INDEX submissions_exam_legacy_union_idx ON submissions (exam_id, legacy_dingtalk_union_id, submitted_at DESC);
CREATE INDEX submissions_status_submitted_idx ON submissions (status, submitted_at DESC);

CREATE TABLE submission_questions (
  submission_id text NOT NULL REFERENCES submissions (id),
  question_id text,
  position integer NOT NULL CHECK (position > 0),
  snapshot_json jsonb NOT NULL,
  answer_json jsonb NOT NULL DEFAULT 'null'::jsonb,
  earned_score numeric(10, 2) NOT NULL DEFAULT 0 CHECK (earned_score >= 0),
  automatic_score numeric(10, 2),
  manually_adjusted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (submission_id, position)
);

CREATE INDEX submission_questions_question_idx ON submission_questions (question_id);

CREATE TABLE retake_permissions (
  id text PRIMARY KEY,
  exam_id text NOT NULL REFERENCES exams (id),
  user_id text NOT NULL REFERENCES users (id),
  remaining_count integer NOT NULL DEFAULT 0 CHECK (remaining_count >= 0),
  granted_by text REFERENCES users (id),
  granted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (exam_id, user_id)
);

CREATE TABLE notifications (
  id text PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  event_type text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('feishu', 'dingtalk')),
  recipient text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'abandoned')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX notifications_status_next_attempt_idx ON notifications (status, next_attempt_at);

CREATE TABLE audit_logs (
  id text PRIMARY KEY,
  actor_id text REFERENCES users (id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id, created_at DESC);

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
CREATE TRIGGER user_identities_set_updated_at BEFORE UPDATE ON user_identities FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
CREATE TRIGGER roles_set_updated_at BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
CREATE TRIGGER user_roles_set_updated_at BEFORE UPDATE ON user_roles FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
CREATE TRIGGER question_banks_set_updated_at BEFORE UPDATE ON question_banks FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
CREATE TRIGGER questions_set_updated_at BEFORE UPDATE ON questions FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
CREATE TRIGGER exams_set_updated_at BEFORE UPDATE ON exams FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
CREATE TRIGGER exam_questions_set_updated_at BEFORE UPDATE ON exam_questions FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
CREATE TRIGGER exam_assignments_set_updated_at BEFORE UPDATE ON exam_assignments FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
CREATE TRIGGER submissions_set_updated_at BEFORE UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
CREATE TRIGGER submission_questions_set_updated_at BEFORE UPDATE ON submission_questions FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
CREATE TRIGGER retake_permissions_set_updated_at BEFORE UPDATE ON retake_permissions FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
CREATE TRIGGER notifications_set_updated_at BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
CREATE TRIGGER audit_logs_set_updated_at BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
