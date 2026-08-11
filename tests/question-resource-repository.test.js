const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { listMigrations } = require("../scripts/migrate");
const {
  MAX_IMAGE_SIZE_BYTES,
  createQuestionResource,
  getQuestionResource,
  validateAndDecodeUpload
} = require("../src/db/question-resource-repository");

const IMAGE_FIXTURES = {
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  "image/png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
  "image/webp": Buffer.from("RIFF\u0004\u0000\u0000\u0000WEBP", "binary")
};

test("0008 创建可回滚的受限图片资源表且不写历史答卷", () => {
  const migration = listMigrations().find((item) => item.name === "0008_question_resources");
  assert.ok(migration);
  assert.match(migration.sql, /CREATE TABLE question_resources/);
  assert.match(migration.sql, /content bytea NOT NULL/);
  assert.match(migration.sql, /mime_type IN \('image\/jpeg', 'image\/png', 'image\/webp'\)/);
  assert.match(migration.sql, /size_bytes BETWEEN 1 AND 5242880/);
  assert.match(migration.sql, /sha256 text NOT NULL UNIQUE/);
  assert.match(migration.sql, /created_by text NOT NULL REFERENCES users \(id\)/);
  assert.match(migration.sql, /octet_length\(content\) = size_bytes/);
  assert.doesNotMatch(migration.sql, /\b(submissions|submission_questions)\b/i);
  const down = fs.readFileSync(migration.downPath, "utf8");
  assert.match(down, /FROM submission_questions/);
  assert.match(down, /RAISE EXCEPTION/);
  assert.match(down, /UPDATE questions/);
  assert.match(down, /\/api\/question-resources\/question_resource_/);
  assert.match(down, /DROP TABLE question_resources/);
});

test("JPEG、PNG 和 WebP 的声明 MIME 与 magic bytes 一致时通过", () => {
  for (const [mimeType, content] of Object.entries(IMAGE_FIXTURES)) {
    const upload = validateAndDecodeUpload({ mimeType, base64: content.toString("base64") });
    assert.equal(upload.mimeType, mimeType);
    assert.deepEqual(upload.content, content);
    assert.equal(upload.sizeBytes, content.length);
    assert.match(upload.sha256, /^[0-9a-f]{64}$/);
  }
});

test("Data URL 必须与单独声明的 MIME 一致", () => {
  const content = IMAGE_FIXTURES["image/png"];
  const upload = validateAndDecodeUpload({
    mimeType: "image/png",
    dataUrl: `data:image/png;base64,${content.toString("base64")}`
  });
  assert.equal(upload.mimeType, "image/png");
  assert.throws(() => validateAndDecodeUpload({
    mimeType: "image/jpeg",
    dataUrl: `data:image/png;base64,${content.toString("base64")}`
  }), /MIME 类型不一致/);
});

test("拒绝伪装 MIME、SVG、非法 Base64 和超过 5MB 的内容", () => {
  assert.throws(() => validateAndDecodeUpload({
    mimeType: "image/jpeg",
    base64: IMAGE_FIXTURES["image/png"].toString("base64")
  }), /内容与声明的 MIME 类型不一致/);
  assert.throws(() => validateAndDecodeUpload({
    mimeType: "image/svg+xml",
    base64: Buffer.from("<svg/>").toString("base64")
  }), /只允许上传 JPEG、PNG 或 WebP/);
  assert.throws(() => validateAndDecodeUpload({ mimeType: "image/png", base64: "not-base64" }), /Base64/);

  const oversized = Buffer.alloc(MAX_IMAGE_SIZE_BYTES + 1);
  oversized.set(IMAGE_FIXTURES["image/png"]);
  assert.throws(() => validateAndDecodeUpload({
    mimeType: "image/png",
    base64: oversized.toString("base64")
  }), /不能超过 5MB/);
});

test("创建资源写入正文与元数据并返回非正文结果", async () => {
  const calls = [];
  const fixture = IMAGE_FIXTURES["image/png"];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("INSERT INTO question_resources")) return { rows: [{
        id: params[0], mime_type: params[1], size_bytes: params[3], sha256: params[4],
        created_by: params[5], created_at: new Date("2026-08-11T00:00:00Z")
      }] };
      return { rows: [] };
    },
    release() {}
  };
  const created = await createQuestionResource({ connect: async () => client }, {
    mimeType: "image/png",
    base64: fixture.toString("base64")
  }, "admin-1");

  const insert = calls.find((call) => call.sql.includes("INSERT INTO question_resources"));
  assert.deepEqual(insert.params[2], fixture);
  assert.equal(insert.params[3], fixture.length);
  assert.equal(insert.params[5], "admin-1");
  assert.equal(created.deduplicated, false);
  assert.equal(Object.hasOwn(created, "content"), false);
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("相同 SHA-256 复用已有资源并校验正文一致", async () => {
  const fixture = IMAGE_FIXTURES["image/jpeg"];
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("INSERT INTO question_resources")) return { rows: [] };
      if (sql.includes("content_matches")) return { rows: [{
        id: "question_resource_existing", mime_type: "image/jpeg", size_bytes: fixture.length,
        sha256: params[0], created_by: "admin-previous", created_at: new Date(), content_matches: true
      }] };
      return { rows: [] };
    },
    release() {}
  };
  const created = await createQuestionResource({ connect: async () => client }, {
    mimeType: "image/jpeg",
    base64: fixture.toString("base64")
  }, "admin-1");

  assert.equal(created.id, "question_resource_existing");
  assert.equal(created.deduplicated, true);
  assert.equal(Object.hasOwn(created, "content"), false);
  const existingQuery = calls.find((call) => call.sql.includes("content_matches"));
  assert.deepEqual(existingQuery.params[1], fixture);
});

test("SHA-256 冲突但资源元数据或正文不一致时回滚", async () => {
  const fixture = IMAGE_FIXTURES["image/jpeg"];
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("INSERT INTO question_resources")) return { rows: [] };
      if (sql.includes("content_matches")) return { rows: [{
        id: "question_resource_conflict", mime_type: "image/png", size_bytes: fixture.length,
        sha256: params[0], created_by: "admin-previous", created_at: new Date(), content_matches: false
      }] };
      return { rows: [] };
    },
    release() {}
  };

  await assert.rejects(createQuestionResource({ connect: async () => client }, {
    mimeType: "image/jpeg",
    base64: fixture.toString("base64")
  }, "admin-1"), (error) => error.statusCode === 409);
  assert.equal(calls.at(-1).sql, "ROLLBACK");
});

test("读取资源按 ID 返回内容与安全元数据，缺失时返回 404 错误", async () => {
  const content = IMAGE_FIXTURES["image/webp"];
  const pool = {
    async query(_sql, params) {
      if (params[0] === "missing") return { rows: [] };
      return { rows: [{
        id: params[0], mime_type: "image/webp", content, size_bytes: content.length,
        sha256: "a".repeat(64), created_by: "admin-1", created_at: new Date()
      }] };
    }
  };
  const resource = await getQuestionResource(pool, "question_resource_1");
  assert.deepEqual(resource.content, content);
  assert.equal(resource.mimeType, "image/webp");
  await assert.rejects(getQuestionResource(pool, "missing"), (error) => error.statusCode === 404);
});
