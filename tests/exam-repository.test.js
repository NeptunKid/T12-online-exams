const assert = require("node:assert/strict");
const test = require("node:test");
const { getPublishedExam, listPublishedExams } = require("../src/db/exam-repository");

test("考试 repository 映射 PostgreSQL 数值字段且不暴露答案", async () => {
  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("FROM exams e")) {
        return { rows: [{ id: "exam-1", title: "测试考试", status: "published", duration_seconds: "600", total_score: "100", pass_score: "60", version: 1, question_id: "q-1", type: "single", stem: "题目", options_json: [{ label: "A", text: "选项" }], position: 1, score: "100" }] };
      }
      return { rows: [{ id: "exam-1", title: "测试考试", status: "published", duration_seconds: "600", total_score: "100", pass_score: "60", version: 1 }] };
    }
  };

  const exams = await listPublishedExams(pool, "u1");
  assert.deepEqual(exams[0], { id: "exam-1", title: "测试考试", status: "published", duration: 600, totalScore: 100, passScore: 60, version: 1 });
  const exam = await getPublishedExam(pool, "exam-1", "u1");
  assert.equal(exam.questions[0].score, 100);
  assert.equal(Object.hasOwn(exam.questions[0], "answer"), false);
  assert.equal(Object.hasOwn(exam.questions[0], "explanation"), false);
  assert.equal(queries.some((sql) => sql.includes("answer_json") || sql.includes("explanation")), false);
  assert.equal(queries.every((sql) => sql.includes("exam_assignments")), true);
});

test("考试 repository 未找到考试时返回 null", async () => {
  const pool = { query: async () => ({ rows: [] }) };
  assert.equal(await getPublishedExam(pool, "missing", "u1"), null);
});
