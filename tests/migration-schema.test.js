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
    assert.match(require("node:fs").readFileSync(migration.downPath, "utf8"), /(DROP TABLE|DELETE FROM|DROP CONSTRAINT)/);
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
