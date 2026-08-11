const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createFilesystemBackupStorage, resolveStorageKey, storageKey } = require("../src/backup/filesystem-backup-storage");

test("文件系统备份使用受控路径原子保存、读取和删除", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t12-auto-backup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = createFilesystemBackupStorage(root);
  const saved = await storage.save({ runId: "backup_run_1", scopeType: "exam", sourceId: "exam/中文", content: Buffer.from("backup") });
  assert.match(saved.storageKey, /^backup_run_1\/exam-[a-f0-9]{24}\.t12backup$/);
  assert.deepEqual(await storage.read(saved.storageKey), Buffer.from("backup"));
  await storage.remove(saved.storageKey);
  await assert.rejects(storage.read(saved.storageKey), { code: "ENOENT" });
});

test("文件系统备份拒绝路径穿越和不受控运行标识", () => {
  assert.throws(() => resolveStorageKey("/backup", "../secret"), /路径无效/);
  assert.throws(() => resolveStorageKey("/backup", "/absolute"), /路径无效/);
  assert.throws(() => storageKey("run/unsafe", "exam", "x"), /运行标识/);
});
