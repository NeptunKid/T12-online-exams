const assert = require("node:assert/strict");
const test = require("node:test");
const zlib = require("node:zlib");
const { createZip, crc32, normalizeEntryName, readZip } = require("../src/backup/zip-archive");

test("受限 ZIP 可无损保存 manifest 和图片资源", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const archive = createZip([
    { name: "manifest.json", content: JSON.stringify({ formatVersion: 1 }) },
    { name: "resources/image.png", content: png }
  ]);
  const files = readZip(archive);
  assert.deepEqual(JSON.parse(files.get("manifest.json")), { formatVersion: 1 });
  assert.deepEqual(files.get("resources/image.png"), png);
});

test("ZIP 输出固定且 CRC-32 与常用校验向量一致", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.deepEqual(createZip([{ name: "a.txt", content: "same" }]), createZip([{ name: "a.txt", content: "same" }]));
});

test("ZIP 路径拒绝绝对路径、上级目录、空段和重复文件", () => {
  for (const value of ["/a", "../a", "a/../b", "a//b", "a\\..\\b"]) {
    assert.throws(() => normalizeEntryName(value), /路径无效/);
  }
  assert.throws(() => createZip([{ name: "a", content: "1" }, { name: "a", content: "2" }]), /重复/);
});

test("ZIP 读取限制包体、文件数、单文件和解压总大小", () => {
  const archive = createZip([{ name: "a", content: Buffer.alloc(20) }, { name: "b", content: Buffer.alloc(20) }]);
  assert.throws(() => readZip(archive, { maxArchiveBytes: 10 }), /大小无效/);
  assert.throws(() => readZip(archive, { maxEntries: 1 }), /文件数量/);
  assert.throws(() => readZip(archive, { maxEntryBytes: 10 }), /解压后过大/);
  assert.throws(() => readZip(archive, { maxTotalBytes: 30 }), /解压后过大/);
});

test("ZIP 读取拒绝校验损坏和无效格式", () => {
  const archive = createZip([{ name: "a.txt", content: "hello" }]);
  const corrupted = Buffer.from(archive);
  const contentOffset = 30 + Buffer.byteLength("a.txt");
  corrupted[contentOffset] ^= 0xff;
  assert.throws(() => readZip(corrupted), /校验失败/);
  assert.throws(() => readZip(Buffer.from("not zip")), /大小无效|有效/);
});

test("ZIP 读取兼容标准 deflate 条目", () => {
  const original = Buffer.from("hello deflate");
  const stored = createZip([{ name: "a.txt", content: original }]);
  const compressed = zlib.deflateRawSync(original);
  const nameLength = stored.readUInt16LE(26);
  const centralOffset = stored.readUInt32LE(stored.length - 6);
  const end = stored.subarray(centralOffset);
  const local = Buffer.from(stored.subarray(0, 30 + nameLength));
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  const shiftedEnd = Buffer.from(end);
  shiftedEnd.writeUInt16LE(8, 10);
  shiftedEnd.writeUInt32LE(compressed.length, 20);
  const endOffset = shiftedEnd.length - 22;
  shiftedEnd.writeUInt32LE(local.length + compressed.length, endOffset + 16);
  const archive = Buffer.concat([local, compressed, shiftedEnd]);
  assert.deepEqual(readZip(archive).get("a.txt"), original);
});
