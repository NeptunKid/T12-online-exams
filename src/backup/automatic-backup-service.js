const crypto = require("node:crypto");
const { createZip } = require("./zip-archive");
const { exportExam, exportQuestionBank, serializeBackupPackage } = require("./export-package");
const { createFilesystemBackupStorage } = require("./filesystem-backup-storage");
const backupRepository = require("../db/backup-repository");

const BACKUP_ADVISORY_LOCK = "742120260811";
const BACKUP_CONTENT_TYPE = "application/vnd.t12.exam-backup+zip";

class AutomaticBackupError extends Error {
  constructor(message, statusCode = 503) {
    super(message);
    this.name = "AutomaticBackupError";
    this.statusCode = statusCode;
  }
}

function archivePackage(pkg) {
  return createZip([{ name: "backup.json", content: serializeBackupPackage(pkg) }]);
}

function artifactFilename(scopeType, sourceId, now = new Date()) {
  const sourceHash = crypto.createHash("sha256").update(String(sourceId || "")).digest("hex").slice(0, 16);
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `t12-${scopeType}-${sourceHash}-${timestamp}.t12backup`;
}

async function listBackupScopes(pool) {
  const [banks, exams] = await Promise.all([
    pool.query("SELECT id, name AS label FROM question_banks ORDER BY id;"),
    pool.query("SELECT id, title AS label FROM exams ORDER BY id;")
  ]);
  return [
    ...banks.rows.map((row) => ({ scopeType: "question-bank", scopeId: row.id, label: row.label })),
    ...exams.rows.map((row) => ({ scopeType: "exam", scopeId: row.id, label: row.label }))
  ];
}

function compactError(error) {
  const message = String(error?.message || "自动备份失败").replace(/[\r\n]+/g, " ").trim();
  return message.slice(0, 1000) || "自动备份失败";
}

function createAutomaticBackupService({
  config,
  getPool,
  repository = backupRepository,
  exporters = { exportExam, exportQuestionBank },
  listScopes = listBackupScopes,
  filesystemStorage,
  logger = console,
  now = () => new Date(),
  timers = { setTimeout, clearTimeout }
}) {
  const filesystemReader = filesystemStorage || createFilesystemBackupStorage(config.directory);
  const storage = config.storageType === "filesystem" ? filesystemReader : null;
  let running = false;
  let timer = null;
  let nextRunAt = null;
  let lastSummary = null;
  let currentPromise = null;

  async function saveScope(pool, scope, triggerType, requestedBy) {
    const run = await repository.createBackupRun(pool, {
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      triggerType,
      requestedBy
    });
    let storedKey = null;
    try {
      const pkg = scope.scopeType === "exam"
        ? await exporters.exportExam(pool, scope.scopeId)
        : await exporters.exportQuestionBank(pool, scope.scopeId);
      if (!pkg) throw new Error("备份对象在生成期间已不存在");
      const content = archivePackage(pkg);
      const sha256 = crypto.createHash("sha256").update(content).digest("hex");
      const filename = artifactFilename(scope.scopeType, scope.scopeId, now());
      let artifactInput;
      if (config.storageType === "filesystem") {
        const saved = await storage.save({ runId: run.id, scopeType: scope.scopeType, sourceId: scope.scopeId, content });
        storedKey = saved.storageKey;
        artifactInput = {
          storageType: "filesystem", storageKey: storedKey, filename,
          contentType: BACKUP_CONTENT_TYPE, sha256, sizeBytes: content.length
        };
      } else {
        artifactInput = { storageType: "database", content, filename, contentType: BACKUP_CONTENT_TYPE, sha256, sizeBytes: content.length };
      }
      await repository.saveBackupArtifact(pool, run.id, artifactInput, { completeRun: true });
      return { status: "succeeded", runId: run.id };
    } catch (error) {
      if (storedKey) await storage.remove(storedKey).catch(() => {});
      await repository.failBackupRun(pool, run.id, compactError(error)).catch(() => {});
      return { status: "failed", runId: run.id, error: compactError(error) };
    }
  }

  async function execute(triggerType, requestedBy) {
    const pool = getPool();
    if (!pool) throw new AutomaticBackupError("自动备份数据库尚未配置");
    const lockClient = await pool.connect();
    let locked = false;
    const startedAt = now();
    try {
      const lock = await lockClient.query("SELECT pg_try_advisory_lock($1::bigint) AS acquired;", [BACKUP_ADVISORY_LOCK]);
      locked = lock.rows[0]?.acquired === true;
      if (!locked) throw new AutomaticBackupError("已有自动备份正在其他实例运行", 409);
      const scopes = await listScopes(pool);
      const results = [];
      for (const scope of scopes) results.push(await saveScope(pool, scope, triggerType, requestedBy));
      const retention = await repository.applyBackupRetention(pool, { keepLatest: config.retentionCount });
      let cleanupFailed = 0;
      if (config.storageType === "filesystem") {
        for (const key of retention.filesystemKeys || []) {
          try {
            await storage.remove(key);
          } catch (error) {
            cleanupFailed += 1;
            logger.error?.(`自动备份过期文件清理失败：${compactError(error)}`);
          }
        }
      }
      const succeeded = results.filter((item) => item.status === "succeeded").length;
      const failed = results.length - succeeded;
      lastSummary = {
        triggerType,
        startedAt: startedAt.toISOString(),
        completedAt: now().toISOString(),
        total: results.length,
        succeeded,
        failed,
        cleanupFailed
      };
      return lastSummary;
    } finally {
      if (locked) await lockClient.query("SELECT pg_advisory_unlock($1::bigint);", [BACKUP_ADVISORY_LOCK]).catch(() => {});
      lockClient.release();
    }
  }

  function begin(triggerType, requestedBy = null) {
    if (!config.enabled) throw new AutomaticBackupError("自动备份尚未启用", 409);
    if (running) throw new AutomaticBackupError("自动备份正在运行", 409);
    running = true;
    currentPromise = execute(triggerType, requestedBy)
      .catch((error) => {
        lastSummary = {
          triggerType,
          startedAt: now().toISOString(),
          completedAt: now().toISOString(),
          total: 0,
          succeeded: 0,
          failed: 0,
          error: compactError(error)
        };
        logger.error?.(`自动备份失败：${compactError(error)}`);
        throw error;
      })
      .finally(() => {
        running = false;
        currentPromise = null;
      });
    currentPromise.catch(() => {});
    return { started: true, triggerType };
  }

  function schedule(delay) {
    if (!config.enabled || timer) return;
    nextRunAt = new Date(now().getTime() + delay);
    timer = timers.setTimeout(() => {
      timer = null;
      nextRunAt = null;
      try { begin("scheduled", null); } catch (error) { logger.error?.(`自动备份未启动：${compactError(error)}`); }
      Promise.resolve(currentPromise).catch(() => {}).finally(() => schedule(config.intervalMs));
    }, delay);
    timer?.unref?.();
  }

  return {
    start() { schedule(config.startDelayMs); },
    stop() {
      if (timer) timers.clearTimeout(timer);
      timer = null;
      nextRunAt = null;
    },
    triggerManual(requestedBy) { return begin("manual", requestedBy); },
    async waitForIdle() { if (currentPromise) return currentPromise; return lastSummary; },
    status() {
      return {
        running,
        nextRunAt: nextRunAt?.toISOString() || null,
        lastSummary
      };
    },
    readFilesystemArtifact(key) {
      return filesystemReader.read(key);
    }
  };
}

module.exports = {
  AutomaticBackupError,
  BACKUP_ADVISORY_LOCK,
  BACKUP_CONTENT_TYPE,
  archivePackage,
  artifactFilename,
  compactError,
  createAutomaticBackupService,
  listBackupScopes
};
