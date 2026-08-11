const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { listMigrations } = require("../scripts/migrate");
const {
  applyBackupRetention,
  completeBackupRun,
  createBackupRun,
  failBackupRun,
  getBackupArtifact,
  listRecentBackupRuns,
  normalizeArtifact,
  saveBackupArtifact
} = require("../src/db/backup-repository");

function transactionalClient(responder) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      return responder(sql, params, calls);
    },
    release() { calls.push({ sql: "RELEASE" }); }
  };
  return { calls, client, pool: { connect: async () => client } };
}

test("0009 创建自动备份运行和两类工件且不触碰历史答卷", () => {
  const migration = listMigrations().find((item) => item.name === "0009_automatic_backups");
  assert.ok(migration);
  assert.match(migration.sql, /CREATE TABLE backup_runs/);
  assert.match(migration.sql, /trigger_type IN \('manual', 'scheduled'\)/);
  assert.match(migration.sql, /status IN \('running', 'succeeded', 'failed'\)/);
  assert.match(migration.sql, /CREATE TABLE backup_artifacts/);
  assert.match(migration.sql, /storage_type IN \('database', 'filesystem'\)/);
  assert.match(migration.sql, /content bytea/);
  assert.match(migration.sql, /sha256 ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration.sql, /retention_expires_at timestamptz/);
  assert.match(migration.sql, /size_bytes > 0/);
  assert.doesNotMatch(migration.sql, /\b(submissions|submission_questions)\b/i);
  const down = fs.readFileSync(migration.downPath, "utf8");
  assert.match(down, /IF EXISTS \(SELECT 1 FROM backup_artifacts\)/);
  assert.match(down, /拒绝回滚 0009/);
  assert.match(down, /DROP TABLE backup_artifacts/);
  assert.match(down, /DROP TABLE backup_runs/);
});

test("创建手动或定时备份运行时验证范围和操作人", async () => {
  const calls = [];
  const pool = { async query(sql, params) {
    calls.push({ sql, params });
    return { rows: [{
      id: params[0], scope_type: params[1], scope_id: params[2], trigger_type: params[3],
      status: "running", requested_by: params[4], started_at: new Date(), completed_at: null,
      error_message: null
    }] };
  } };
  const manual = await createBackupRun(pool, {
    scopeType: "exam", scopeId: "exam-1", triggerType: "manual", requestedBy: "admin-1"
  });
  assert.match(manual.id, /^backup_run_/);
  assert.equal(manual.scopeType, "exam");
  assert.deepEqual(calls[0].params.slice(1), ["exam", "exam-1", "manual", "admin-1"]);
  await createBackupRun(pool, { scopeType: "system", triggerType: "scheduled" });
  assert.deepEqual(calls[1].params.slice(1), ["system", "", "scheduled", null]);
  await assert.rejects(createBackupRun(pool, { scopeType: "exam", triggerType: "scheduled" }), /范围标识/);
  await assert.rejects(createBackupRun(pool, { scopeType: "system", triggerType: "manual" }), /发起人/);
});

test("数据库工件由正文推导并校验大小和 SHA-256", () => {
  const content = Buffer.from("portable-backup");
  const artifact = normalizeArtifact({
    storageType: "database", filename: "exam.t12backup", content,
    retentionExpiresAt: "2026-09-01T00:00:00Z"
  });
  assert.equal(artifact.sizeBytes, content.length);
  assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
  assert.equal(artifact.storageKey, null);
  assert.throws(() => normalizeArtifact({
    storageType: "database", filename: "x", content, sizeBytes: content.length + 1
  }), /大小校验失败/);
  assert.throws(() => normalizeArtifact({
    storageType: "database", filename: "x", content, sha256: "0".repeat(64)
  }), /SHA-256 校验失败/);
  assert.throws(() => normalizeArtifact({
    storageType: "database", filename: "x", content: Buffer.alloc(0)
  }), /正文无效/);
});

test("文件系统工件只保存受校验的键、摘要和大小", () => {
  const artifact = normalizeArtifact({
    storageType: "filesystem", filename: "exam.t12backup", storageKey: "2026/exam.t12backup",
    sha256: "A".repeat(64), sizeBytes: 2048
  });
  assert.equal(artifact.sha256, "a".repeat(64));
  assert.equal(artifact.content, null);
  assert.throws(() => normalizeArtifact({
    storageType: "filesystem", filename: "x", storageKey: "key", sha256: "bad", sizeBytes: 1
  }), /SHA-256 无效/);
  assert.throws(() => normalizeArtifact({
    storageType: "filesystem", filename: "x", storageKey: "key", sha256: "a".repeat(64), sizeBytes: 1,
    content: Buffer.from("unexpected")
  }), /不能写入数据库正文/);
});

test("保存工件锁定运行并在同一事务写入元数据", async () => {
  const content = Buffer.from("backup");
  const harness = transactionalClient((sql, params) => {
    if (sql.includes("SELECT status")) return { rows: [{ status: "running" }] };
    if (sql.includes("INSERT INTO backup_artifacts")) return { rows: [{
      id: params[0], run_id: params[1], storage_type: params[2], filename: params[3],
      content_type: params[4], storage_key: params[6], sha256: params[7], size_bytes: params[8],
      retention_expires_at: params[9], created_at: new Date()
    }] };
    return { rows: [] };
  });
  const saved = await saveBackupArtifact(harness.pool, "run-1", {
    storageType: "database", filename: "backup.t12backup", content
  });
  assert.equal(saved.runId, "run-1");
  assert.equal(harness.calls[0].sql, "BEGIN");
  assert.match(harness.calls[1].sql, /FOR UPDATE/);
  const insert = harness.calls.find((call) => call.sql.includes("INSERT INTO backup_artifacts"));
  assert.deepEqual(insert.params[5], content);
  assert.equal(harness.calls.at(-2).sql, "COMMIT");
});

test("自动调度可以在保存工件的同一事务完成运行", async () => {
  const content = Buffer.from("backup");
  const harness = transactionalClient((sql, params) => {
    if (sql.includes("SELECT status")) return { rows: [{ status: "running" }] };
    if (sql.includes("INSERT INTO backup_artifacts")) return { rows: [{
      id: "artifact-1", run_id: "run-1", storage_type: "database", filename: "exam.t12backup",
      content_type: "application/zip", storage_key: null, sha256: "b".repeat(64),
      size_bytes: content.length, retention_expires_at: null, created_at: new Date()
    }] };
    return { rows: [] };
  });
  await saveBackupArtifact(harness.pool, "run-1", {
    storageType: "database", filename: "exam.t12backup", content
  }, { completeRun: true });
  const completion = harness.calls.find((call) => call.sql.includes("SET status = 'succeeded'"));
  assert.deepEqual(completion.params, ["run-1"]);
  assert.equal(harness.calls.at(-2).sql, "COMMIT");
});

test("保存工件失败会回滚并释放连接", async () => {
  const harness = transactionalClient((sql) => {
    if (sql.includes("SELECT status")) return { rows: [{ status: "failed" }] };
    return { rows: [] };
  });
  await assert.rejects(saveBackupArtifact(harness.pool, "run-1", {
    storageType: "filesystem", filename: "x", storageKey: "key", sha256: "a".repeat(64), sizeBytes: 1
  }), /只能为运行中的备份/);
  assert.equal(harness.calls.at(-2).sql, "ROLLBACK");
  assert.equal(harness.calls.at(-1).sql, "RELEASE");
});

test("成功运行必须存在工件，失败运行保存受限错误文本", async () => {
  let hasArtifact = false;
  const harness = transactionalClient((sql, params) => {
    if (sql.includes("SELECT status")) return { rows: [{ status: "running" }] };
    if (sql.includes("SELECT id FROM backup_artifacts")) return { rows: hasArtifact ? [{ id: "artifact-1" }] : [] };
    if (sql.includes("UPDATE backup_runs")) return { rows: [{
      id: "run-1", scope_type: "system", scope_id: "", trigger_type: "scheduled",
      status: params[1], requested_by: null, started_at: new Date(), completed_at: new Date(),
      error_message: params[2]
    }] };
    return { rows: [] };
  });
  await assert.rejects(completeBackupRun(harness.pool, "run-1"), /没有可用工件/);
  hasArtifact = true;
  assert.equal((await completeBackupRun(harness.pool, "run-1")).status, "succeeded");
  const failed = await failBackupRun(harness.pool, "run-1", new Error("disk full"));
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorMessage, "disk full");
});

test("最近运行查询使用参数化范围和上限并映射工件元数据", async () => {
  const calls = [];
  const pool = { async query(sql, params) {
    calls.push({ sql, params });
    return { rows: [{
      id: "run-1", scope_type: "exam", scope_id: "exam-1", trigger_type: "scheduled",
      status: "succeeded", requested_by: null, started_at: new Date(), completed_at: new Date(),
      error_message: null, artifact_id: "artifact-1", artifact_storage_type: "filesystem",
      artifact_filename: "exam.t12backup", artifact_content_type: "application/zip",
      artifact_storage_key: "backups/exam.t12backup", artifact_sha256: "a".repeat(64),
      artifact_size_bytes: "42", artifact_retention_expires_at: null, artifact_created_at: new Date()
    }] };
  } };
  const runs = await listRecentBackupRuns(pool, { scopeType: "exam", scopeId: "exam-1", limit: 20 });
  assert.equal(runs[0].artifact.sizeBytes, 42);
  assert.deepEqual(calls[0].params, ["exam", "exam-1", 20]);
  assert.match(calls[0].sql, /scope_type = \$1/);
  assert.match(calls[0].sql, /LIMIT \$3/);
});

test("只有成功运行的工件可以读取且数据库正文不进入列表接口", async () => {
  const content = Buffer.from("backup");
  const pool = { async query(sql, params) {
    assert.match(sql, /br\.status = 'succeeded'/);
    assert.deepEqual(params, ["artifact-1"]);
    return { rows: [{
      id: "artifact-1", run_id: "run-1", storage_type: "database",
      filename: "exam.t12backup", content_type: "application/zip", content,
      storage_key: null, sha256: "a".repeat(64), size_bytes: content.length,
      retention_expires_at: null, created_at: new Date()
    }] };
  } };
  const artifact = await getBackupArtifact(pool, "artifact-1");
  assert.deepEqual(artifact.content, content);
  assert.equal(artifact.storageKey, "");
});

test("保留策略按每个 scope 保留最近 N 份并返回待删除文件键", async () => {
  const rows = [
    { id: "e-new", scope_type: "exam", scope_id: "exam-1" },
    { id: "e-old", scope_type: "exam", scope_id: "exam-1" },
    { id: "q-new", scope_type: "question-bank", scope_id: "bank-1" },
    { id: "q-old", scope_type: "question-bank", scope_id: "bank-1" }
  ];
  const harness = transactionalClient((sql, params) => {
    if (sql.includes("FROM backup_runs") && sql.includes("FOR UPDATE")) return { rows };
    if (sql.includes("FROM backup_artifacts")) {
      assert.deepEqual(params[0], ["e-old", "q-old"]);
      return { rows: [{ storage_key: "backups/e-old" }, { storage_key: "backups/q-old" }] };
    }
    return { rows: [] };
  });
  const result = await applyBackupRetention(harness.pool, { keepLatest: 1 });
  assert.deepEqual(result, {
    deletedRunCount: 2,
    filesystemKeys: ["backups/e-old", "backups/q-old"]
  });
  const deletion = harness.calls.find((call) => call.sql.includes("DELETE FROM backup_runs"));
  assert.deepEqual(deletion.params[0], ["e-old", "q-old"]);
  assert.equal(harness.calls.at(-2).sql, "COMMIT");
});
