const crypto = require("node:crypto");

const BACKUP_SCOPE_TYPES = new Set(["system", "exam", "question-bank"]);
const BACKUP_TRIGGER_TYPES = new Set(["manual", "scheduled"]);
const BACKUP_STORAGE_TYPES = new Set(["database", "filesystem"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

class BackupRepositoryError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "BackupRepositoryError";
    this.statusCode = statusCode;
  }
}

function nonEmpty(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new BackupRepositoryError(`${label}不能为空`);
  return normalized;
}

function normalizeScope(scopeType, scopeId) {
  const type = String(scopeType || "").trim();
  if (!BACKUP_SCOPE_TYPES.has(type)) throw new BackupRepositoryError("备份范围类型无效");
  const id = String(scopeId || "").trim();
  if (type === "system" && id) throw new BackupRepositoryError("系统备份不能指定范围标识");
  if (type !== "system" && !id) throw new BackupRepositoryError("备份范围标识不能为空");
  return { scopeType: type, scopeId: id };
}

function normalizeDate(value, label, { optional = false } = {}) {
  if ((value === null || value === undefined || value === "") && optional) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new BackupRepositoryError(`${label}无效`);
  return date;
}

function normalizePositiveInteger(value, label, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new BackupRepositoryError(`${label}必须是 1 到 ${maximum} 的整数`);
  }
  return number;
}

function mapArtifact(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    storageType: row.storage_type,
    filename: row.filename,
    contentType: row.content_type,
    storageKey: row.storage_key || "",
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    retentionExpiresAt: row.retention_expires_at,
    createdAt: row.created_at
  };
}

function mapRun(row) {
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    triggerType: row.trigger_type,
    status: row.status,
    requestedBy: row.requested_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message || "",
    artifact: row.artifact_id ? mapArtifact({
      id: row.artifact_id,
      run_id: row.id,
      storage_type: row.artifact_storage_type,
      filename: row.artifact_filename,
      content_type: row.artifact_content_type,
      storage_key: row.artifact_storage_key,
      sha256: row.artifact_sha256,
      size_bytes: row.artifact_size_bytes,
      retention_expires_at: row.artifact_retention_expires_at,
      created_at: row.artifact_created_at
    }) : null
  };
}

async function createBackupRun(pool, input = {}) {
  const scope = normalizeScope(input.scopeType, input.scopeId);
  const triggerType = String(input.triggerType || "").trim();
  if (!BACKUP_TRIGGER_TYPES.has(triggerType)) throw new BackupRepositoryError("备份触发方式无效");
  const requestedBy = input.requestedBy === null || input.requestedBy === undefined
    ? null
    : nonEmpty(input.requestedBy, "备份发起人");
  if (triggerType === "manual" && !requestedBy) throw new BackupRepositoryError("手动备份必须记录发起人");
  const id = `backup_run_${crypto.randomUUID()}`;
  const result = await pool.query(`
    INSERT INTO backup_runs (id, scope_type, scope_id, trigger_type, requested_by)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id, scope_type, scope_id, trigger_type, status, requested_by,
      started_at, completed_at, error_message;`, [
    id, scope.scopeType, scope.scopeId, triggerType, requestedBy
  ]);
  return mapRun(result.rows[0]);
}

function normalizeArtifact(input = {}) {
  const storageType = String(input.storageType || "").trim();
  if (!BACKUP_STORAGE_TYPES.has(storageType)) throw new BackupRepositoryError("备份存储类型无效");
  const filename = nonEmpty(input.filename, "备份文件名");
  const contentType = nonEmpty(input.contentType || "application/vnd.t12.exam-backup+zip", "备份内容类型");
  const retentionExpiresAt = normalizeDate(input.retentionExpiresAt, "备份保留到期时间", { optional: true });

  if (storageType === "database") {
    if (!Buffer.isBuffer(input.content) || !input.content.length) throw new BackupRepositoryError("数据库备份正文无效");
    const sizeBytes = input.content.length;
    const sha256 = crypto.createHash("sha256").update(input.content).digest("hex");
    if (input.sizeBytes !== undefined && Number(input.sizeBytes) !== sizeBytes) {
      throw new BackupRepositoryError("备份大小校验失败");
    }
    if (input.sha256 !== undefined && String(input.sha256).toLowerCase() !== sha256) {
      throw new BackupRepositoryError("备份 SHA-256 校验失败");
    }
    if (input.storageKey) throw new BackupRepositoryError("数据库备份不能指定文件系统键");
    return { storageType, filename, contentType, content: input.content, storageKey: null, sha256, sizeBytes, retentionExpiresAt };
  }

  if (input.content !== null && input.content !== undefined) {
    throw new BackupRepositoryError("文件系统备份不能写入数据库正文");
  }
  const storageKey = nonEmpty(input.storageKey, "文件系统存储键");
  const sha256 = String(input.sha256 || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) throw new BackupRepositoryError("备份 SHA-256 无效");
  const sizeBytes = Number(input.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) throw new BackupRepositoryError("备份大小无效");
  return { storageType, filename, contentType, content: null, storageKey, sha256, sizeBytes, retentionExpiresAt };
}

async function saveBackupArtifact(pool, runId, input = {}, options = {}) {
  const normalizedRunId = nonEmpty(runId, "备份运行标识");
  const artifact = normalizeArtifact(input);
  const artifactId = `backup_artifact_${crypto.randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const run = await client.query("SELECT status FROM backup_runs WHERE id = $1 FOR UPDATE;", [normalizedRunId]);
    if (!run.rows.length) throw new BackupRepositoryError("未找到备份运行", 404);
    if (run.rows[0].status !== "running") throw new BackupRepositoryError("只能为运行中的备份保存工件", 409);
    const result = await client.query(`
      INSERT INTO backup_artifacts (
        id, run_id, storage_type, filename, content_type, content, storage_key,
        sha256, size_bytes, retention_expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, run_id, storage_type, filename, content_type, storage_key,
        sha256, size_bytes, retention_expires_at, created_at;`, [
      artifactId,
      normalizedRunId,
      artifact.storageType,
      artifact.filename,
      artifact.contentType,
      artifact.content,
      artifact.storageKey,
      artifact.sha256,
      artifact.sizeBytes,
      artifact.retentionExpiresAt
    ]);
    if (options.completeRun === true) {
      await client.query(`
        UPDATE backup_runs
        SET status = 'succeeded', completed_at = CURRENT_TIMESTAMP, error_message = NULL
        WHERE id = $1;`, [normalizedRunId]);
    }
    await client.query("COMMIT");
    return mapArtifact(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function finishRun(pool, runId, status, errorMessage) {
  const normalizedRunId = nonEmpty(runId, "备份运行标识");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const run = await client.query("SELECT status FROM backup_runs WHERE id = $1 FOR UPDATE;", [normalizedRunId]);
    if (!run.rows.length) throw new BackupRepositoryError("未找到备份运行", 404);
    if (run.rows[0].status !== "running") throw new BackupRepositoryError("备份运行已经结束", 409);
    if (status === "succeeded") {
      const artifact = await client.query("SELECT id FROM backup_artifacts WHERE run_id = $1;", [normalizedRunId]);
      if (!artifact.rows.length) throw new BackupRepositoryError("备份运行没有可用工件", 409);
    }
    const result = await client.query(`
      UPDATE backup_runs
      SET status = $2, completed_at = CURRENT_TIMESTAMP, error_message = $3
      WHERE id = $1
      RETURNING id, scope_type, scope_id, trigger_type, status, requested_by,
        started_at, completed_at, error_message;`, [normalizedRunId, status, errorMessage]);
    await client.query("COMMIT");
    return mapRun(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function completeBackupRun(pool, runId) {
  return finishRun(pool, runId, "succeeded", null);
}

async function failBackupRun(pool, runId, error) {
  const message = nonEmpty(error instanceof Error ? error.message : error, "备份失败原因").slice(0, 2000);
  return finishRun(pool, runId, "failed", message);
}

async function completeScheduledBackupCycle(pool, runId) {
  const normalizedRunId = nonEmpty(runId, "备份运行标识");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const run = await client.query(
      "SELECT status, scope_type, trigger_type FROM backup_runs WHERE id = $1 FOR UPDATE;",
      [normalizedRunId]
    );
    if (!run.rows.length) throw new BackupRepositoryError("未找到备份运行", 404);
    const current = run.rows[0];
    if (current.status !== "running") throw new BackupRepositoryError("备份运行已经结束", 409);
    if (current.scope_type !== "system" || current.trigger_type !== "scheduled") {
      throw new BackupRepositoryError("只有定时系统备份周期可以无工件完成", 409);
    }
    const result = await client.query(`
      UPDATE backup_runs
      SET status = 'succeeded', completed_at = CURRENT_TIMESTAMP, error_message = NULL
      WHERE id = $1
      RETURNING id, scope_type, scope_id, trigger_type, status, requested_by,
        started_at, completed_at, error_message;`, [normalizedRunId]);
    await client.query("COMMIT");
    return mapRun(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getLatestSuccessfulScheduledCycle(pool) {
  const result = await pool.query(`
    SELECT id, completed_at
    FROM backup_runs
    WHERE scope_type = 'system'
      AND trigger_type = 'scheduled'
      AND status = 'succeeded'
    ORDER BY completed_at DESC, id DESC
    LIMIT 1;`);
  if (!result.rows.length) return null;
  return { id: result.rows[0].id, completedAt: result.rows[0].completed_at };
}

async function failStaleScheduledBackupRuns(pool, input = {}) {
  const staleBefore = normalizeDate(input.staleBefore, "定时备份过期时间");
  const errorMessage = nonEmpty(input.errorMessage || "定时备份运行超时，已自动标记失败", "备份失败原因").slice(0, 2000);
  const result = await pool.query(`
    UPDATE backup_runs
    SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error_message = $2
    WHERE trigger_type = 'scheduled'
      AND status = 'running'
      AND started_at < $1
    RETURNING id;`, [staleBefore, errorMessage]);
  return result.rows.map((row) => row.id);
}

async function listRecentBackupRuns(pool, input = {}) {
  const limit = normalizePositiveInteger(input.limit ?? 50, "查询数量", 200);
  const params = [];
  const clauses = [];
  if (input.scopeType !== undefined || input.scopeId !== undefined) {
    const scope = normalizeScope(input.scopeType, input.scopeId);
    params.push(scope.scopeType, scope.scopeId);
    clauses.push(`br.scope_type = $${params.length - 1}`, `br.scope_id = $${params.length}`);
  }
  params.push(limit);
  const result = await pool.query(`
    SELECT br.id, br.scope_type, br.scope_id, br.trigger_type, br.status,
      br.requested_by, br.started_at, br.completed_at, br.error_message,
      ba.id AS artifact_id, ba.storage_type AS artifact_storage_type,
      ba.filename AS artifact_filename, ba.content_type AS artifact_content_type,
      ba.storage_key AS artifact_storage_key, ba.sha256 AS artifact_sha256,
      ba.size_bytes AS artifact_size_bytes,
      ba.retention_expires_at AS artifact_retention_expires_at,
      ba.created_at AS artifact_created_at
    FROM backup_runs br
    LEFT JOIN backup_artifacts ba ON ba.run_id = br.id
    ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY br.started_at DESC, br.id DESC
    LIMIT $${params.length};`, params);
  return result.rows.map(mapRun);
}

async function getBackupArtifact(pool, artifactId) {
  const id = nonEmpty(artifactId, "备份工件标识");
  const result = await pool.query(`
    SELECT ba.id, ba.run_id, ba.storage_type, ba.filename, ba.content_type,
      ba.content, ba.storage_key, ba.sha256, ba.size_bytes,
      ba.retention_expires_at, ba.created_at
    FROM backup_artifacts ba
    JOIN backup_runs br ON br.id = ba.run_id
    WHERE ba.id = $1 AND br.status = 'succeeded';`, [id]);
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return { ...mapArtifact(row), content: row.content || null };
}

async function applyBackupRetention(pool, input = {}) {
  const keepLatest = normalizePositiveInteger(input.keepLatest, "备份保留数量", 1000);
  let scope = null;
  if (input.scopeType !== undefined || input.scopeId !== undefined) {
    scope = normalizeScope(input.scopeType, input.scopeId);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const params = [];
    const clauses = ["status = 'succeeded'"];
    if (scope) {
      params.push(scope.scopeType, scope.scopeId);
      clauses.push(`scope_type = $${params.length - 1}`, `scope_id = $${params.length}`);
    }
    const result = await client.query(`
      SELECT id, scope_type, scope_id
      FROM backup_runs
      WHERE ${clauses.join(" AND ")}
      ORDER BY scope_type, scope_id, completed_at DESC, id DESC
      FOR UPDATE;`, params);
    const counts = new Map();
    const obsoleteRunIds = [];
    for (const row of result.rows) {
      const key = `${row.scope_type}\u0000${row.scope_id}`;
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      if (count > keepLatest) obsoleteRunIds.push(row.id);
    }

    let filesystemKeys = [];
    if (obsoleteRunIds.length) {
      const artifacts = await client.query(`
        SELECT storage_key
        FROM backup_artifacts
        WHERE run_id = ANY($1::text[]) AND storage_type = 'filesystem'
        ORDER BY storage_key;`, [obsoleteRunIds]);
      filesystemKeys = artifacts.rows.map((row) => row.storage_key);
      await client.query("DELETE FROM backup_runs WHERE id = ANY($1::text[]);", [obsoleteRunIds]);
    }
    await client.query("COMMIT");
    return { deletedRunCount: obsoleteRunIds.length, filesystemKeys };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  BACKUP_SCOPE_TYPES,
  BACKUP_STORAGE_TYPES,
  BACKUP_TRIGGER_TYPES,
  BackupRepositoryError,
  applyBackupRetention,
  completeScheduledBackupCycle,
  completeBackupRun,
  createBackupRun,
  failBackupRun,
  failStaleScheduledBackupRuns,
  getLatestSuccessfulScheduledCycle,
  getBackupArtifact,
  listRecentBackupRuns,
  mapArtifact,
  mapRun,
  normalizeArtifact,
  normalizeScope,
  saveBackupArtifact
};
