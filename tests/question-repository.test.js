const assert = require("node:assert/strict");
const test = require("node:test");
const {
  mapQuestion,
  normalizeQuestionEdit,
  updateQuestion
} = require("../src/db/question-repository");

test("题库映射返回可编辑字段但不暴露图片资源标识", () => {
  const question = mapQuestion({
    id: "q-1", bank_id: "bank-1", bank_name: "测试题库", external_id: "1",
    type: "single", stem: "题干", options_json: [{ label: "A", text: "选项", image: "resource:secret" }],
    answer_json: "A", explanation: "解析", score: "2", version: "3", status: "active", exam_refs: []
  });
  assert.deepEqual(question.options, [{ label: "A", text: "选项", hasImage: true }]);
  assert.equal(JSON.stringify(question).includes("resource:secret"), false);
});

test("题目编辑校验答案必须来自现有选项", () => {
  const existing = { type: "single", options_json: [{ label: "A", text: "甲" }, { label: "B", text: "乙" }] };
  assert.throws(() => normalizeQuestionEdit(existing, {
    stem: "题干", options: [{ label: "A", text: "甲" }, { label: "B", text: "乙" }], answer: "C", explanation: ""
  }), /参考答案必须来自现有选项/);
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
          options_json: JSON.parse(calls.find((call) => call.sql.includes("UPDATE questions")).params[2]),
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
  assert.equal(JSON.parse(questionUpdate.params[2])[0].image, "resource:image-a");
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
