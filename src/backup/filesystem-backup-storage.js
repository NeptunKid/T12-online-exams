const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

function safeSegment(value, label) {
  const normalized = String(value || "");
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(normalized)) throw new Error(`${label} 格式无效`);
  return normalized;
}

function storageKey(runId, scopeType, sourceId) {
  const run = safeSegment(runId, "备份运行标识");
  const scope = safeSegment(scopeType, "备份范围类型");
  const sourceHash = crypto.createHash("sha256").update(String(sourceId || "")).digest("hex").slice(0, 24);
  return `${run}/${scope}-${sourceHash}.t12backup`;
}

function resolveStorageKey(root, key) {
  const normalized = String(key || "").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("备份存储路径无效");
  }
  const resolved = path.resolve(root, ...normalized.split("/"));
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error("备份存储路径无效");
  return resolved;
}

function createFilesystemBackupStorage(directory, fileSystem = fs) {
  const configured = String(directory || "");
  if (!path.isAbsolute(configured)) throw new Error("备份目录必须是绝对路径");
  const root = path.resolve(configured);
  return {
    type: "filesystem",
    async save({ runId, scopeType, sourceId, content }) {
      if (!Buffer.isBuffer(content) || !content.length) throw new Error("备份文件正文不能为空");
      const key = storageKey(runId, scopeType, sourceId);
      const target = resolveStorageKey(root, key);
      const folder = path.dirname(target);
      await fileSystem.mkdir(folder, { recursive: true, mode: 0o700 });
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      try {
        await fileSystem.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
        await fileSystem.rename(temporary, target);
      } catch (error) {
        await fileSystem.unlink(temporary).catch(() => {});
        throw error;
      }
      return { storageKey: key };
    },
    async read(key) {
      return fileSystem.readFile(resolveStorageKey(root, key));
    },
    async remove(key) {
      const target = resolveStorageKey(root, key);
      await fileSystem.unlink(target).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  };
}

module.exports = { createFilesystemBackupStorage, resolveStorageKey, storageKey };
