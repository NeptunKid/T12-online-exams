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
    assert.match(require("node:fs").readFileSync(migration.downPath, "utf8"), /DROP TABLE/);
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
