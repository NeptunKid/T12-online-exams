const path = require("node:path");

function booleanValue(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error("T12_AUTO_BACKUP_ENABLED 必须是布尔值");
}

function integerValue(value, fallback, label, minimum, maximum) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 的整数`);
  }
  return parsed;
}

function loadAutomaticBackupConfig(env = process.env, root = path.join(__dirname, "../..")) {
  const enabled = booleanValue(env.T12_AUTO_BACKUP_ENABLED, false);
  const storageType = String(env.T12_AUTO_BACKUP_STORAGE || "database").trim().toLowerCase();
  if (!new Set(["database", "filesystem"]).has(storageType)) {
    throw new Error("T12_AUTO_BACKUP_STORAGE 只允许 database 或 filesystem");
  }
  const intervalHours = integerValue(env.T12_AUTO_BACKUP_INTERVAL_HOURS, 24, "T12_AUTO_BACKUP_INTERVAL_HOURS", 1, 720);
  const retentionCount = integerValue(env.T12_AUTO_BACKUP_RETENTION, 7, "T12_AUTO_BACKUP_RETENTION", 1, 30);
  const startDelaySeconds = integerValue(env.T12_AUTO_BACKUP_START_DELAY_SECONDS, 60, "T12_AUTO_BACKUP_START_DELAY_SECONDS", 5, 3600);
  const staleAfterMinutes = integerValue(env.T12_AUTO_BACKUP_STALE_AFTER_MINUTES, 120, "T12_AUTO_BACKUP_STALE_AFTER_MINUTES", 5, 720);
  const scopeDelaySeconds = integerValue(env.T12_AUTO_BACKUP_SCOPE_DELAY_SECONDS, 30, "T12_AUTO_BACKUP_SCOPE_DELAY_SECONDS", 0, 3600);
  const configuredDirectory = String(env.T12_AUTO_BACKUP_DIR || "").trim();
  const directory = configuredDirectory || path.join(root, "data", "automatic-backups");
  if (storageType === "filesystem" && !path.isAbsolute(directory)) {
    throw new Error("T12_AUTO_BACKUP_DIR 必须是绝对路径");
  }
  return {
    enabled,
    storageType,
    intervalHours,
    intervalMs: intervalHours * 60 * 60 * 1000,
    retentionCount,
    startDelaySeconds,
    startDelayMs: startDelaySeconds * 1000,
    staleAfterMinutes,
    staleAfterMs: staleAfterMinutes * 60 * 1000,
    scopeDelaySeconds,
    scopeDelayMs: scopeDelaySeconds * 1000,
    directory: path.resolve(directory)
  };
}

function publicAutomaticBackupConfig(config) {
  return {
    enabled: Boolean(config.enabled),
    storageType: config.storageType,
    intervalHours: config.intervalHours,
    retentionCount: config.retentionCount,
    staleAfterMinutes: config.staleAfterMinutes,
    scopeDelaySeconds: config.scopeDelaySeconds
  };
}

module.exports = { loadAutomaticBackupConfig, publicAutomaticBackupConfig };
