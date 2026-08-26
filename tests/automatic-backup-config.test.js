const assert = require("node:assert/strict");
const test = require("node:test");
const { loadAutomaticBackupConfig, publicAutomaticBackupConfig } = require("../src/backup/automatic-backup-config");

test("自动备份默认关闭并使用数据库、每日周期和七份保留", () => {
  const config = loadAutomaticBackupConfig({}, "/app");
  assert.deepEqual(publicAutomaticBackupConfig(config), {
    enabled: false, storageType: "database", intervalHours: 24, retentionCount: 7,
    staleAfterMinutes: 120, scopeDelaySeconds: 30
  });
  assert.equal(config.startDelaySeconds, 60);
});

test("自动备份配置限制存储类型、周期、保留数和启动延迟", () => {
  const config = loadAutomaticBackupConfig({
    T12_AUTO_BACKUP_ENABLED: "true",
    T12_AUTO_BACKUP_STORAGE: "filesystem",
    T12_AUTO_BACKUP_INTERVAL_HOURS: "12",
    T12_AUTO_BACKUP_RETENTION: "10",
    T12_AUTO_BACKUP_START_DELAY_SECONDS: "30",
    T12_AUTO_BACKUP_STALE_AFTER_MINUTES: "90",
    T12_AUTO_BACKUP_SCOPE_DELAY_SECONDS: "15",
    T12_AUTO_BACKUP_DIR: "/var/backups/t12/portable"
  });
  assert.equal(config.enabled, true);
  assert.equal(config.directory, "/var/backups/t12/portable");
  assert.equal(config.intervalMs, 12 * 60 * 60 * 1000);
  assert.equal(config.staleAfterMs, 90 * 60 * 1000);
  assert.equal(config.scopeDelayMs, 15 * 1000);
  assert.throws(() => loadAutomaticBackupConfig({ T12_AUTO_BACKUP_STORAGE: "s3" }), /只允许/);
  assert.throws(() => loadAutomaticBackupConfig({ T12_AUTO_BACKUP_INTERVAL_HOURS: "0" }), /1 到 720/);
  assert.throws(() => loadAutomaticBackupConfig({ T12_AUTO_BACKUP_RETENTION: "31" }), /1 到 30/);
  assert.throws(() => loadAutomaticBackupConfig({ T12_AUTO_BACKUP_STALE_AFTER_MINUTES: "4" }), /5 到 720/);
  assert.throws(() => loadAutomaticBackupConfig({ T12_AUTO_BACKUP_SCOPE_DELAY_SECONDS: "3601" }), /0 到 3600/);
  assert.throws(() => loadAutomaticBackupConfig({ T12_AUTO_BACKUP_STORAGE: "filesystem", T12_AUTO_BACKUP_DIR: "relative" }), /绝对路径/);
});

test("公开配置不暴露服务器备份目录", () => {
  const config = loadAutomaticBackupConfig({ T12_AUTO_BACKUP_STORAGE: "filesystem", T12_AUTO_BACKUP_DIR: "/private/backup" });
  assert.equal(Object.hasOwn(publicAutomaticBackupConfig(config), "directory"), false);
});
