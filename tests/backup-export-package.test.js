const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  buildBackupPackage,
  collectResourceReferences,
  exportExam,
  exportQuestionBank,
  serializeBackupPackage,
  stableStringify
} = require("../src/backup/export-package");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const PNG_SHA = crypto.createHash("sha256").update(PNG).digest("hex");
const WEBP = Buffer.from("524946460400000057454250", "hex");
const WEBP_SHA = crypto.createHash("sha256").update(WEBP).digest("hex");

function question(overrides = {}) {
  return {
    id: "q-1", bank_id: "bank-1", external_id: "1", type: "single", stem: "题干",
    images_json: ["/api/question-resources/question_resource_image-1"],
    options_json: [{ label: "A", text: "答案", image: "resource:static-a" }],
    answer_json: "A", explanation: "解析", score: 99, version: 2, status: "active",
    created_at: new Date("2026-08-11T00:00:00Z"), updated_at: new Date("2026-08-11T01:00:00Z"),
    ...overrides
  };
}

test("备份包格式固定并以 payload SHA-256 保护全部结构化数据和图片", () => {
  const pkg = buildBackupPackage({
    kind: "question-bank",
    exportedAt: "2026-08-11T02:00:00.000Z",
    questionBanks: [{ id: "bank-1", name: "题库" }],
    questions: [question()],
    resources: [{ id: "question_resource_image-1", mimeType: "image/png", content: PNG, sha256: PNG_SHA }]
  });

  assert.equal(pkg.manifest.format, BACKUP_FORMAT);
  assert.equal(pkg.manifest.formatVersion, BACKUP_FORMAT_VERSION);
  assert.equal(pkg.manifest.kind, "question-bank");
  assert.equal(pkg.manifest.counts.questions, 1);
  assert.equal(pkg.manifest.counts.resources, 1);
  assert.equal(pkg.resources[0].base64, PNG.toString("base64"));
  assert.equal(pkg.resources[0].sha256, PNG_SHA);
  assert.equal(pkg.manifest.payloadSha256, crypto.createHash("sha256").update(stableStringify({
    questionBanks: pkg.questionBanks,
    questions: pkg.questions,
    exams: pkg.exams,
    examQuestions: pkg.examQuestions,
    assignments: pkg.assignments,
    retakePermissions: pkg.retakePermissions,
    resources: pkg.resources
  })).digest("hex"));
  assert.equal(Object.hasOwn(pkg.questions[0], "score"), false, "题库题目不应携带分值");
  assert.deepEqual(JSON.parse(serializeBackupPackage(pkg)), JSON.parse(stableStringify(pkg)));
});

test("稳定序列化不受对象键插入顺序影响", () => {
  assert.equal(stableStringify({ b: 2, a: { d: 4, c: 3 } }), stableStringify({ a: { c: 3, d: 4 }, b: 2 }));
});

test("资源收集覆盖题干图片和选项图片并自动去重", () => {
  assert.deepEqual(collectResourceReferences([{
    images: ["/api/question-resources/question_resource_image-1", "resource:static-a", "/question-resources/static-b.png"],
    options: [{ image: "/api/question-resources/question_resource_image-1" }, { image: "https://unmanaged.test/a.png" }]
  }]), ["/question-resources/static-b.png", "question_resource_image-1", "resource:static-a"]);
});

test("资源正文、大小、MIME 或 SHA-256 不一致时拒绝构建", () => {
  assert.throws(() => buildBackupPackage({ resources: [{ id: "r", mimeType: "image/png", content: PNG, sha256: "0".repeat(64) }] }), /SHA-256/);
  assert.throws(() => buildBackupPackage({ resources: [{ id: "r", mimeType: "image/svg+xml", content: PNG }] }), /MIME/);
  assert.throws(() => buildBackupPackage({ resources: [{ id: "r", mimeType: "image/png", size_bytes: 1, content: PNG }] }), /大小/);
  assert.throws(() => buildBackupPackage({ resources: [{ id: "r", mimeType: "image/jpeg", content: WEBP, sha256: WEBP_SHA }] }), /MIME.*不一致/);
});

test("静态资源导出以图片真实 MIME 为准并可通过回导校验", async () => {
  const pool = { async query(sql) {
    if (sql.includes("FROM question_banks WHERE id")) return { rows: [{ id: "bank-1", name: "题库", status: "active" }] };
    if (sql.includes("FROM questions WHERE bank_id")) return { rows: [question({ images_json: ["resource:webp"], options_json: [] })] };
    if (sql.includes("FROM question_resources")) return { rows: [] };
    throw new Error(`未预期 SQL: ${sql}`);
  } };
  const pkg = await exportQuestionBank(pool, "bank-1", {
    staticManifest: { "resource:webp": { url: "/question-resources/cleaning/cleaning-12-1.jpeg", mediaType: "image/jpeg", sha256: "02d7e2a4a3263400c824b922e25ebe488999477c370af9f8dfd85564de0ac53f" } }
  });
  assert.equal(pkg.resources[0].mimeType, "image/webp");
});

test("导出端拒绝生成超过可回导范围的图片包", () => {
  const oversized = { id: "large", mimeType: "image/png", size_bytes: 101 * 1024 * 1024, content: Buffer.alloc(1) };
  assert.throws(() => buildBackupPackage({ resources: [oversized] }), /100MB/);
});

test("整题库导出包含归档题、完整答案解析和数据库图片正文", async () => {
  const calls = [];
  const pool = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes("FROM question_banks WHERE id")) return { rows: [{ id: "bank-1", name: "题库", description: "说明", status: "active" }] };
    if (sql.includes("FROM questions WHERE bank_id")) return { rows: [question({ status: "archived" })] };
    if (sql.includes("FROM question_resources")) return { rows: [{ id: "question_resource_image-1", mime_type: "image/png", content: PNG, size_bytes: PNG.length, sha256: PNG_SHA }] };
    throw new Error(`未预期 SQL: ${sql}`);
  } };

  const pkg = await exportQuestionBank(pool, "bank-1", {
    exportedAt: "2026-08-11T02:00:00.000Z",
    staticManifest: { "resource:static-a": { url: "/does-not-exist.png", mediaType: "image/png", sha256: "0".repeat(64) } }
  }).catch((error) => {
    assert.match(error.message, /static-a/);
    return null;
  });
  assert.equal(pkg, null, "缺失静态图片时必须整体拒绝导出");
  assert.ok(calls.some((call) => call.sql.includes("FROM questions WHERE bank_id")));

  const withoutStatic = question({ options_json: [{ label: "A", text: "答案" }], status: "archived" });
  pool.query = async (sql, params) => {
    if (sql.includes("FROM question_banks WHERE id")) return { rows: [{ id: "bank-1", name: "题库", status: "active" }] };
    if (sql.includes("FROM questions WHERE bank_id")) return { rows: [withoutStatic] };
    if (sql.includes("FROM question_resources")) return { rows: [{ id: "question_resource_image-1", mime_type: "image/png", content: PNG, size_bytes: PNG.length, sha256: PNG_SHA }] };
    throw new Error(`未预期 SQL: ${sql}`);
  };
  const complete = await exportQuestionBank(pool, "bank-1", { exportedAt: "2026-08-11T02:00:00.000Z" });
  assert.equal(complete.questions[0].status, "archived");
  assert.equal(complete.questions[0].answer, "A");
  assert.equal(complete.questions[0].explanation, "解析");
  assert.deepEqual(Buffer.from(complete.resources[0].base64, "base64"), PNG);
});

test("整张试卷导出包含题库、组卷顺序分值、答题规则、授权和补考权限", async () => {
  const pool = { async query(sql, params) {
    if (sql.includes("FROM exams WHERE id")) return { rows: [{
      id: "exam-1", title: "试卷", status: "draft", duration_seconds: 1800,
      pass_score: "6", total_score: "10", pass_rate: "0.6", version: 3,
      answer_rules_json: { partialCredit: true }, question_bank_id: "bank-1"
    }] };
    if (sql.includes("FROM exam_questions eq")) return { rows: [{
      ...question({ id: undefined, images_json: [], options_json: [{ label: "A", text: "答案" }] }),
      exam_id: "exam-1", question_id: "q-1", position: 1, score: "10", section: "第一部分",
      question_version: 2, question_status: "active"
    }] };
    if (sql.includes("FROM question_banks qb")) {
      assert.deepEqual(params[0], ["bank-1"]);
      return { rows: [{ id: "bank-1", name: "题库", status: "active" }] };
    }
    if (sql.includes("FROM exam_assignments")) return { rows: [{ id: "a-1", exam_id: "exam-1", subject_type: "group", subject_id: "all-active-users" }] };
    if (sql.includes("FROM retake_permissions")) return { rows: [{ id: "r-1", exam_id: "exam-1", user_id: "u-1", remaining_count: 2 }] };
    throw new Error(`未预期 SQL: ${sql}`);
  } };

  const pkg = await exportExam(pool, "exam-1", { exportedAt: "2026-08-11T02:00:00.000Z" });
  assert.equal(pkg.exams[0].answerRules.partialCredit, true);
  assert.deepEqual(pkg.examQuestions[0], { examId: "exam-1", questionId: "q-1", position: 1, score: 10, section: "第一部分" });
  assert.equal(pkg.assignments[0].subjectId, "all-active-users");
  assert.equal(pkg.retakePermissions[0].remainingCount, 2);
  assert.equal(pkg.questions[0].id, "q-1");
});

test("题库或试卷不存在时返回 null，空标识直接拒绝", async () => {
  const pool = { query: async () => ({ rows: [] }) };
  assert.equal(await exportQuestionBank(pool, "missing"), null);
  assert.equal(await exportExam(pool, "missing"), null);
  await assert.rejects(exportQuestionBank(pool, ""), /题库标识/);
  await assert.rejects(exportExam(pool, ""), /试卷标识/);
});

test("已绑定但尚未选题的空试卷仍导出对应题库", async () => {
  const pool = { async query(sql, params) {
    if (sql.includes("FROM exams WHERE id")) return { rows: [{
      id: "exam-empty", title: "空试卷", status: "draft", duration_seconds: 600,
      pass_score: 0, total_score: 0, pass_rate: 0.6, version: 1,
      answer_rules_json: {}, question_bank_id: "bank-1"
    }] };
    if (sql.includes("FROM exam_questions eq")) return { rows: [] };
    if (sql.includes("FROM question_banks qb")) {
      assert.deepEqual(params[0], ["bank-1"]);
      return { rows: [{ id: "bank-1", name: "题库", status: "active" }] };
    }
    if (sql.includes("FROM exam_assignments") || sql.includes("FROM retake_permissions")) return { rows: [] };
    throw new Error(`未预期 SQL: ${sql}`);
  } };
  const pkg = await exportExam(pool, "exam-empty");
  assert.equal(pkg.questionBanks[0].id, "bank-1");
  assert.equal(pkg.questions.length, 0);
});
