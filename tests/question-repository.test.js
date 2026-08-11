const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createQuestion,
  mapQuestion,
  normalizeEditedImages,
  normalizeQuestionCreate,
  normalizeQuestionEdit,
  updateQuestion
} = require("../src/db/question-repository");

test("题库映射返回可编辑字段但不暴露图片资源标识", () => {
  const question = mapQuestion({
    id: "q-1", bank_id: "bank-1", bank_name: "测试题库", external_id: "1",
    type: "single", stem: "题干", images_json: ["/api/question-resources/question_resource_123"],
    options_json: [{ label: "A", text: "选项", image: "resource:secret" }],
    answer_json: "A", explanation: "解析", score: "2", version: "3", status: "active", exam_refs: []
  });
  assert.deepEqual(question.options, [{ label: "A", text: "选项", hasImage: true }]);
  assert.deepEqual(question.images, ["/api/question-resources/question_resource_123"]);
  assert.equal(JSON.stringify(question).includes("resource:secret"), false);
  assert.equal(Object.hasOwn(question, "score"), false);
});

test("题干图片只接受已登记静态资源或上传资源 URL", () => {
  assert.deepEqual(normalizeEditedImages([
    "/question-resources/coffee/coffee-siphon.jpeg",
    "/api/question-resources/question_resource_123"
  ]), [
    "/question-resources/coffee/coffee-siphon.jpeg",
    "/api/question-resources/question_resource_123"
  ]);
  assert.throws(() => normalizeEditedImages(["https://example.com/image.png"]), /受控资源/);
  assert.throws(() => normalizeEditedImages(Array(6).fill(0).map((_, index) =>
    `/api/question-resources/question_resource_${index}`)), /最多上传 5 张/);
});

test("题目编辑校验答案必须来自现有选项", () => {
  const existing = { type: "single", options_json: [{ label: "A", text: "甲" }, { label: "B", text: "乙" }] };
  assert.throws(() => normalizeQuestionEdit(existing, {
    stem: "题干", options: [{ label: "A", text: "甲" }, { label: "B", text: "乙" }], answer: "C", explanation: ""
  }), /参考答案必须来自现有选项/);
});

test("手动录题校验题库、题型、选项和答案且不接收题库分值", () => {
  const created = normalizeQuestionCreate({
    bankId: "bank-1",
    externalId: " manual-1 ",
    type: "multi",
    stem: "哪些选项正确？",
    options: [{ label: "A", text: "甲" }, { label: "B", text: "乙" }],
    answer: ["B", "A"],
    explanation: "解析",
    score: "2.5"
  });
  assert.equal(created.externalId, "manual-1");
  assert.equal(Object.hasOwn(created, "score"), false);
  assert.deepEqual(created.answer, ["A", "B"]);
  assert.throws(() => normalizeQuestionCreate({ ...created, bankId: "" }), /请选择题库/);
});

test("手动新增题目写入题库和审计日志但不加入试卷", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM question_banks") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: "bank-1", name: "测试题库" }] };
      }
      if (sql.includes("FROM question_resources")) {
        return { rows: [{ id: "question_resource_123" }] };
      }
      if (sql.includes("LEFT JOIN LATERAL")) {
        return { rows: [{
          id: params[0], bank_id: "bank-1", bank_name: "测试题库", external_id: "manual-1",
          type: "single", stem: "题干", images_json: ["/api/question-resources/question_resource_123"],
          options_json: [{ label: "A", text: "甲" }, { label: "B", text: "乙" }],
          answer_json: "A", explanation: "解析", score: "1", version: "1", status: "active", exam_refs: []
        }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const question = await createQuestion({ connect: async () => client }, {
    bankId: "bank-1", externalId: "manual-1", type: "single", stem: "题干",
    images: ["/api/question-resources/question_resource_123"],
    options: [{ label: "A", text: "甲" }, { label: "B", text: "乙" }],
    answer: "A", explanation: "解析"
  }, "admin-1");

  assert.equal(question.bankId, "bank-1");
  assert.deepEqual(question.exams, []);
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO questions")), true);
  const insert = calls.find((call) => call.sql.includes("INSERT INTO questions"));
  assert.equal(insert.sql.includes("score"), false);
  assert.deepEqual(JSON.parse(insert.params[5]), ["/api/question-resources/question_resource_123"]);
  assert.equal(calls.some((call) => call.sql.includes("FROM question_resources")), true);
  assert.equal(calls.some((call) => call.sql.includes("'create_question'")), true);
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO exam_questions")), false);
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("只有图片的既有选项可以在编辑时保留空文本", () => {
  const edited = normalizeQuestionEdit({
    type: "single",
    options_json: [{ label: "A", text: "", image: "resource:image-a" }, { label: "B", text: "文字选项" }]
  }, {
    stem: "图表题",
    options: [{ label: "A", text: "" }, { label: "B", text: "文字选项" }],
    answer: "A",
    explanation: ""
  });
  assert.equal(edited.options[0].image, "resource:image-a");
});

test("保存题目保留选项图片、递增引用考试版本并写审计日志", async () => {
  const calls = [];
  const existing = {
    id: "q-1", bank_id: "bank-1", external_id: "1", type: "single", stem: "旧题干",
    options_json: [{ label: "A", text: "旧选项", image: "resource:image-a" }, { label: "B", text: "其他" }],
    answer_json: "A", explanation: "旧解析", score: "2", version: "2", status: "active"
  };
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM questions") && sql.includes("FOR UPDATE")) return { rows: [existing] };
      if (sql.includes("UPDATE exams")) return { rows: [{ id: "exam-1" }] };
      if (sql.includes("LEFT JOIN LATERAL")) {
        return { rows: [{
          ...existing,
          bank_name: "测试题库",
          stem: "新题干",
          images_json: JSON.parse(calls.find((call) => call.sql.includes("UPDATE questions")).params[2]),
          options_json: JSON.parse(calls.find((call) => call.sql.includes("UPDATE questions")).params[3]),
          answer_json: "B",
          explanation: "新解析",
          version: 3,
          exam_refs: [{ id: "exam-1", title: "测试考试", status: "published", position: 1 }]
        }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const updated = await updateQuestion({ connect: async () => client }, "q-1", {
    version: 2,
    stem: "新题干",
    options: [{ label: "A", text: "新选项" }, { label: "B", text: "其他" }],
    answer: "B",
    explanation: "新解析"
  }, "admin-1");

  const questionUpdate = calls.find((call) => call.sql.includes("UPDATE questions"));
  assert.equal(JSON.parse(questionUpdate.params[3])[0].image, "resource:image-a");
  assert.equal(calls.some((call) => call.sql.includes("UPDATE exams")), true);
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO audit_logs")), true);
  assert.equal(updated.version, 3);
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("题目版本过期时拒绝覆盖其他管理员的修改", async () => {
  const client = {
    async query(sql) {
      if (sql.includes("FOR UPDATE")) return { rows: [{
        id: "q-1", type: "qa", stem: "题干", options_json: [], answer_json: "答案",
        explanation: "", score: "5", version: "4", status: "active"
      }] };
      return { rows: [] };
    },
    release() {}
  };
  await assert.rejects(
    updateQuestion({ connect: async () => client }, "q-1", {
      version: 3, stem: "新题干", options: [], answer: "答案", explanation: ""
    }, "admin-1"),
    /题目已被其他管理员修改/
  );
});
