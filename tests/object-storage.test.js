const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createMemoryObjectStorage,
  createObjectStorage,
  normalizeObjectKey,
  objectStorageKey,
  sha256
} = require("../src/backup/object-storage");

test("对象存储使用受控键保存元数据并读取时校验正文", async () => {
  const { storage, calls } = createMemoryObjectStorage();
  const content = Buffer.from("portable-backup");
  const saved = await storage.save({
    runId: "backup_run_1",
    scopeType: "exam",
    sourceId: "exam/中文",
    filename: "exam.t12backup",
    content
  });
  assert.match(saved.storageKey, /^backup_run_1\/exam-[a-f0-9]{24}\.t12backup$/);
  assert.equal(saved.sha256, sha256(content));
  assert.equal(saved.sizeBytes, content.length);
  assert.deepEqual(calls[0].metadata, { sha256: saved.sha256, sizeBytes: String(content.length), filename: "exam.t12backup" });
  assert.deepEqual(await storage.read(saved.storageKey, saved), content);
});

test("对象存储拒绝路径穿越、覆盖写入和损坏正文", async () => {
  const { storage } = createMemoryObjectStorage();
  assert.throws(() => normalizeObjectKey("../secret"), /对象存储键无效/);
  assert.throws(() => objectStorageKey({ prefix: "backup/../x", runId: "run", scopeType: "exam", sourceId: "1" }), /对象存储键无效/);
  const input = { runId: "run", scopeType: "exam", sourceId: "1", content: Buffer.from("x") };
  const first = await storage.save(input);
  await assert.rejects(storage.save(input), { code: "PRECONDITION_FAILED" });
  await assert.rejects(storage.read(first.storageKey, { sha256: "0".repeat(64) }), /SHA-256/);
});

test("对象存储删除是幂等的，未来 SDK 只需实现三项客户端方法", async () => {
  const { storage, calls } = createMemoryObjectStorage();
  const saved = await storage.save({ runId: "run", scopeType: "question-bank", sourceId: "bank", content: Uint8Array.from([1, 2, 3]) });
  await storage.remove(saved.storageKey);
  await storage.remove(saved.storageKey);
  await assert.rejects(storage.read(saved.storageKey), { code: "NOT_FOUND" });
  assert.equal(calls.filter((call) => call.method === "deleteObject").length, 2);
});

test("对象存储客户端配置和返回正文必须符合契约", () => {
  assert.throws(() => createObjectStorage({ bucket: "b" }), /putObject/);
  assert.throws(() => createObjectStorage({ client: {}, bucket: "b" }), /putObject/);
  assert.throws(() => createObjectStorage({ client: { putObject() {}, getObject() {}, deleteObject() {} }, bucket: "" }), /Bucket/);
});
