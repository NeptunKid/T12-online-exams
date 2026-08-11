const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildBackupPackage,
  serializeBackupPackage,
  sha256,
  stableStringify
} = require("../src/backup/export-package");
const {
  importBackupPackage,
  parseBackupPackage
} = require("../src/backup/import-package");
const { crc32 } = require("../src/backup/zip-archive");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function examPackage(overrides = {}) {
  return buildBackupPackage({
    kind: "exam",
    exportedAt: "2026-08-11T08:00:00.000Z",
    questionBanks: [{
      id: "bank-source", name: "来源题库", description: "完整说明", status: "active",
      ownerId: "old-admin", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z"
    }],
    questions: [{
      id: "question-source", bankId: "bank-source", externalId: "1", type: "single",
      stem: "图片中的内容是什么？", images: ["/api/question-resources/question_resource_source"],
      options: [{ label: "A", text: "答案", image: "resource:static-source" }, { label: "B", text: "其他" }],
      answer: "A", explanation: "参考解析", version: 3, status: "active",
      createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z"
    }],
    exams: [{
      id: "exam-source", title: "来源试卷", status: "published", durationSeconds: 1800,
      passScore: 8, totalScore: 10, passRate: 0.8, version: 5, answerRules: { shuffle: false },
      questionBankId: "bank-source", createdBy: "old-admin",
      createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z"
    }],
    examQuestions: [{ examId: "exam-source", questionId: "question-source", position: 1, score: 10, section: "" }],
    assignments: [{
      id: "assignment-source", examId: "exam-source", subjectType: "group", subjectId: "all-active-users",
      startsAt: null, endsAt: null
    }],
    retakePermissions: [],
    resources: [
      { id: "question_resource_source", mimeType: "image/png", content: PNG },
      { id: "resource:static-source", mimeType: "image/png", content: PNG }
    ],
    ...overrides
  });
}

function refreshManifest(pkg) {
  const payload = Object.fromEntries([
    "questionBanks", "questions", "exams", "examQuestions", "assignments", "retakePermissions", "resources"
  ].map((key) => [key, pkg[key]]));
  pkg.manifest.counts = Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, value.length]));
  pkg.manifest.payloadSha256 = sha256(stableStringify(payload));
  return pkg;
}

function storedZip(name, content) {
  const fileName = Buffer.from(name);
  const checksum = crc32(content);
  const local = Buffer.alloc(30 + fileName.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  fileName.copy(local, 30);

  const central = Buffer.alloc(46 + fileName.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt32LE(0, 42);
  fileName.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + content.length, 16);
  return Buffer.concat([local, content, central, eocd]);
}

test("解析自包含 JSON 或 ZIP 备份并验证 manifest、资源正文与引用", () => {
  const source = examPackage();
  const json = serializeBackupPackage(source);
  const parsedJson = parseBackupPackage(json);
  const parsedZip = parseBackupPackage(storedZip("backup.json", json));

  assert.equal(parsedJson.manifest.kind, "exam");
  assert.equal(parsedJson.resourceContents.get("question_resource_source").equals(PNG), true);
  assert.equal(parsedZip.questions[0].stem, "图片中的内容是什么？");
});

test("拒绝被篡改的 payload SHA-256、图片 SHA-256、伪装 MIME 和缺失资源", () => {
  const tampered = examPackage();
  tampered.questions[0].stem = "篡改内容";
  assert.throws(() => parseBackupPackage(serializeBackupPackage(tampered)), /数据 SHA-256 校验失败/);

  const wrongImageHash = examPackage();
  wrongImageHash.resources[0].sha256 = "0".repeat(64);
  refreshManifest(wrongImageHash);
  assert.throws(() => parseBackupPackage(serializeBackupPackage(wrongImageHash)), /图片资源 .* SHA-256 校验失败/);

  const disguised = examPackage();
  disguised.resources[0].base64 = Buffer.from([0xff, 0xd8, 0xff]).toString("base64");
  disguised.resources[0].sizeBytes = 3;
  disguised.resources[0].sha256 = sha256(Buffer.from([0xff, 0xd8, 0xff]));
  refreshManifest(disguised);
  assert.throws(() => parseBackupPackage(serializeBackupPackage(disguised)), /内容与声明的 MIME 类型不一致/);

  const missing = examPackage({ resources: [] });
  assert.throws(() => parseBackupPackage(serializeBackupPackage(missing)), /缺少资源正文/);
});

test("ZIP 解析拒绝路径穿越、错误文件名及 CRC 篡改", () => {
  const json = serializeBackupPackage(examPackage());
  assert.throws(() => parseBackupPackage(storedZip("../backup.json", json)), /路径无效/);
  assert.throws(() => parseBackupPackage(storedZip("payload.json", json)), /必须且只能包含 backup.json/);
  const corrupted = storedZip("backup.json", json);
  corrupted[corrupted.indexOf(json) + 10] ^= 0xff;
  assert.throws(() => parseBackupPackage(corrupted), /文件校验失败/);
});

function fakeDatabase(options = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const compact = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: compact, params });
      if (options.failOn && compact.includes(options.failOn)) throw new Error("database failure");
      if (compact.startsWith("SELECT id FROM users WHERE id = $1")) return { rows: [{ id: params[0] }] };
      if (compact.includes("FROM question_resources") && compact.includes("WHERE sha256")) {
        return options.existingResource ? { rows: [{
          id: "question_resource_existing", mime_type: "image/png", size_bytes: PNG.length, content_matches: true
        }] } : { rows: [] };
      }
      if (compact.startsWith("SELECT id FROM users WHERE id = ANY")) return { rows: params[0].map((id) => ({ id })) };
      return { rows: [] };
    },
    release() { calls.push({ sql: "RELEASE", params: [] }); }
  };
  return { pool: { connect: async () => client }, calls };
}

test("事务导入总是生成新 ID、转成草稿并将全部图片引用改写为数据库资源", async () => {
  const database = fakeDatabase();
  const imported = await importBackupPackage(database.pool, serializeBackupPackage(examPackage()), "admin-current", {
    idFactory: (prefix, sourceId) => `${prefix}__${String(sourceId).replace(/[^A-Za-z0-9_-]/g, "-")}`
  });

  assert.equal(imported.questionBanks[0].id, "question_bank_import__bank-source");
  assert.deepEqual(imported.exams[0], { id: "exam_import__exam-source", title: "来源试卷", status: "draft" });
  const bankInsert = database.calls.find((call) => call.sql.startsWith("INSERT INTO question_banks"));
  assert.notEqual(bankInsert.params[0], "bank-source");
  assert.equal(bankInsert.params[4], "admin-current");
  const questionInsert = database.calls.find((call) => call.sql.startsWith("INSERT INTO questions"));
  assert.deepEqual(JSON.parse(questionInsert.params[5]), ["/api/question-resources/question_resource__question_resource_source"]);
  assert.equal(JSON.parse(questionInsert.params[6])[0].image, "/api/question-resources/question_resource__question_resource_source");
  const examInsert = database.calls.find((call) => call.sql.startsWith("INSERT INTO exams"));
  assert.match(examInsert.sql, /'draft'/);
  assert.notEqual(examInsert.params[0], "exam-source");
  assert.equal(database.calls.at(-2).sql, "COMMIT");
  assert.equal(database.calls.at(-1).sql, "RELEASE");
});

test("相同 SHA-256 复用已有图片，任何数据库失败都整体回滚", async () => {
  const deduplicated = fakeDatabase({ existingResource: true });
  await importBackupPackage(deduplicated.pool, examPackage(), "admin-current");
  assert.equal(deduplicated.calls.some((call) => call.sql.startsWith("INSERT INTO question_resources")), false);
  const questionInsert = deduplicated.calls.find((call) => call.sql.startsWith("INSERT INTO questions"));
  assert.deepEqual(JSON.parse(questionInsert.params[5]), ["/api/question-resources/question_resource_existing"]);

  const failed = fakeDatabase({ failOn: "INSERT INTO exams" });
  await assert.rejects(importBackupPackage(failed.pool, examPackage(), "admin-current"), /database failure/);
  assert.equal(failed.calls.some((call) => call.sql === "COMMIT"), false);
  assert.equal(failed.calls.at(-2).sql, "ROLLBACK");
  assert.equal(failed.calls.at(-1).sql, "RELEASE");
});

test("导入前拒绝跨题库关系、分值不一致和非连续题序", () => {
  const wrongTotal = examPackage();
  wrongTotal.exams[0].totalScore = 11;
  refreshManifest(wrongTotal);
  assert.throws(() => parseBackupPackage(wrongTotal), /总分与题目分值不一致/);

  const wrongPosition = examPackage();
  wrongPosition.examQuestions[0].position = 2;
  refreshManifest(wrongPosition);
  assert.throws(() => parseBackupPackage(wrongPosition), /题目顺序不连续/);

  const wrongBank = examPackage();
  wrongBank.questions[0].bankId = "bank-missing";
  refreshManifest(wrongBank);
  assert.throws(() => parseBackupPackage(wrongBank), /包内不存在的题库/);
});
