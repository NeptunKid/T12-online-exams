const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const { checksum, listMigrations } = require("../scripts/migrate");

const root = path.join(__dirname, "..");

test("Phase 1 schema 覆盖多考试、快照、权限和通知基础表", () => {
  const migration = listMigrations().find((item) => item.name === "0001_phase1_core_schema");
  assert.ok(migration);
  for (const table of [
    "users", "user_identities", "roles", "user_roles", "question_banks", "questions",
    "exams", "exam_questions", "exam_assignments", "submissions", "submission_questions",
    "retake_permissions", "notifications", "audit_logs"
  ]) {
    assert.match(migration.sql, new RegExp(`CREATE TABLE ${table} \\(`));
  }
  assert.match(migration.sql, /snapshot_json jsonb NOT NULL/);
  assert.match(migration.sql, /legacy_submission_id text UNIQUE/);
  assert.match(migration.sql, /\('system_admin', '系统管理员'/);
  assert.equal(checksum(migration.sql).length, 64);
});

test("每份迁移都提供同名回滚文件", () => {
  for (const migration of listMigrations()) {
    assert.match(migration.downPath, /db\/migrations\/down\/\d{4}_.+\.sql$/);
    assert.match(require("node:fs").readFileSync(migration.downPath, "utf8"), /(DROP TABLE|DELETE FROM|DROP CONSTRAINT|DROP COLUMN)/);
  }
});

test("迁移计划不需要数据库凭证且不执行数据库写入", () => {
  const result = spawnSync(process.execPath, ["scripts/migrate.js", "--plan"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0001_phase1_core_schema\s+回滚：有/);
});

test("0002 迁移为历史答卷用户建立可回滚的个人授权", () => {
  const migration = listMigrations().find((item) => item.name === "0002_legacy_exam_assignments");
  assert.ok(migration);
  assert.match(migration.sql, /INSERT INTO exam_assignments/);
  assert.match(migration.sql, /legacy_assignment_/);
  assert.match(require("node:fs").readFileSync(migration.downPath, "utf8"), /DELETE FROM exam_assignments/);
});

test("0003 迁移允许填空题并可恢复旧题型约束", () => {
  const migration = listMigrations().find((item) => item.name === "0003_fill_question_type");
  assert.ok(migration);
  assert.match(migration.sql, /'fill'/);
  assert.match(require("node:fs").readFileSync(migration.downPath, "utf8"), /'qa'/);
});

test("0004 修正清洁卫生时长并建立可回滚的全员授权", () => {
  const migration = listMigrations().find((item) => item.name === "0004_production_exam_workflow");
  assert.ok(migration);
  assert.match(migration.sql, /duration_seconds = 2700/);
  assert.match(migration.sql, /all-active-dingtalk-users/);
  assert.match(migration.sql, /graded_at IS NULL/);
  const down = require("node:fs").readFileSync(migration.downPath, "utf8");
  assert.match(down, /DELETE FROM exam_assignments/);
  assert.match(down, /duration_seconds = 30/);
});

test("0005 为题干图片建立可回滚的 JSON 数组字段", () => {
  const migration = listMigrations().find((item) => item.name === "0005_question_stem_images");
  assert.ok(migration);
  assert.match(migration.sql, /images_json jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
  assert.match(migration.sql, /jsonb_typeof\(images_json\) = 'array'/);
  const down = require("node:fs").readFileSync(migration.downPath, "utf8");
  assert.match(down, /DROP COLUMN images_json/);
});

test("0006 为钉钉和飞书员工建立可回滚的跨平台全员授权", () => {
  const migration = listMigrations().find((item) => item.name === "0006_cross_platform_exam_assignments");
  assert.ok(migration);
  assert.match(migration.sql, /all-active-users/);
  assert.match(migration.sql, /ON CONFLICT \(exam_id, subject_type, subject_id\) DO NOTHING/);
  const down = require("node:fs").readFileSync(migration.downPath, "utf8");
  assert.match(down, /DELETE FROM exam_assignments/);
  assert.match(down, /all-active-users/);
});

test("0007 建立试卷分值所有权兼容层且不改写历史答卷", () => {
  const migration = listMigrations().find((item) => item.name === "0007_exam_authoring_score_ownership");
  assert.ok(migration);

  assert.match(migration.sql, /ALTER COLUMN score SET DEFAULT 0/);
  assert.doesNotMatch(migration.sql, /ALTER COLUMN score DROP NOT NULL/);
  assert.doesNotMatch(migration.sql, /DROP COLUMN score/);

  assert.match(migration.sql, /ADD COLUMN question_bank_id text/);
  assert.match(migration.sql, /FOREIGN KEY \(question_bank_id\) REFERENCES question_banks \(id\)/);
  assert.match(migration.sql, /HAVING COUNT\(DISTINCT q\.bank_id\) = 1/);

  assert.match(migration.sql, /ADD COLUMN pass_rate numeric\(7, 6\)/);
  assert.match(migration.sql, /ROUND\(pass_score \/ total_score, 6\)/);
  assert.match(migration.sql, /ALTER COLUMN pass_rate SET DEFAULT 0\.600000/);
  assert.match(migration.sql, /CHECK \(pass_rate >= 0 AND pass_rate <= 1\)/);
  assert.doesNotMatch(migration.sql, /UPDATE\s+(submissions|submission_questions)\b/i);

  const down = require("node:fs").readFileSync(migration.downPath, "utf8");
  assert.match(down, /DROP COLUMN pass_rate/);
  assert.match(down, /DROP COLUMN question_bank_id/);
  assert.match(down, /ALTER COLUMN score DROP DEFAULT/);
});

test("0009 自动备份迁移不读写历史答卷", () => {
  const migration = listMigrations().find((item) => item.name === "0009_automatic_backups");
  assert.ok(migration);
  assert.match(migration.sql, /CREATE TABLE backup_runs/);
  assert.match(migration.sql, /CREATE TABLE backup_artifacts/);
  assert.match(migration.sql, /storage_type IN \('database', 'filesystem'\)/);
  assert.match(migration.sql, /ON DELETE CASCADE/);
  assert.match(migration.sql, /retention_expires_at timestamptz/);
  assert.doesNotMatch(migration.sql, /\b(submissions|submission_questions)\b/i);
});

test("0012 建立组织部门和用户成员关系且提供回滚", () => {
  const migration = listMigrations().find((item) => item.name === "0012_organization_directory");
  assert.ok(migration);
  assert.match(migration.sql, /CREATE TABLE organization_departments/);
  assert.match(migration.sql, /CREATE TABLE user_departments/);
  assert.match(require("node:fs").readFileSync(migration.downPath, "utf8"), /DROP TABLE IF EXISTS user_departments/);
});

test("0010 为题库生命周期增加可回滚的乐观锁版本", () => {
  const migration = listMigrations().find((item) => item.name === "0010_question_bank_versions");
  assert.ok(migration);
  assert.match(migration.sql, /ALTER TABLE question_banks/);
  assert.match(migration.sql, /ADD COLUMN version integer NOT NULL DEFAULT 1/);
  assert.doesNotMatch(migration.sql, /\b(submissions|submission_questions)\b/i);
  assert.match(require("node:fs").readFileSync(migration.downPath, "utf8"), /DROP COLUMN version/);
});
