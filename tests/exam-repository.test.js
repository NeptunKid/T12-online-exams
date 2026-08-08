const assert = require("node:assert/strict");
const test = require("node:test");
const { createSubmission, getPublishedExam, getStudentDashboard, getStudentSubmission, gradePublishedQuestions, listPublishedExams, listStudentSubmissions } = require("../src/db/exam-repository");

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

test("发布考试交卷只保存服务端快照并自动计算客观题", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM exams e")) {
        return { rows: [{ id: "exam-1", title: "测试考试", version: 1, pass_score: "60", total_score: "100", user_id: "user-1", question_id: "q-1", type: "single", stem: "题目", options_json: [{ label: "A", text: "选项" }], answer_json: "A", explanation: "答案解析", position: 1, score: "100" }] };
      }
      if (sql.includes("MAX(attempt_no)")) return { rows: [{ attempt_no: "1" }] };
      return { rows: [] };
    },
    release() {}
  };
  const pool = { connect: async () => client };
  const result = await createSubmission(pool, "exam-1", "u1", { submissionId: "submission-1", answers: { "q-1": "A" } });
  assert.deepEqual(result, { id: "submission-1", status: "graded", objectiveScore: 100, attemptNo: 1 });
  assert.equal(Object.hasOwn(result, "answer"), false);
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("发布考试客观题评分兼容多选漏选半分", () => {
  const result = gradePublishedQuestions([
    { question_id: "q-1", type: "multi", answer_json: ["A", "B"], score: "20" }
  ], { "q-1": ["A"] });
  assert.equal(result.objectiveScore, 10);
  assert.equal(result.objectiveDetail["q-1"].automaticEarned, 10);
});

test("考生答卷列表按身份过滤并映射分数", async () => {
  const pool = {
    query: async () => ({ rows: [{ id: "s-1", exam_id: "exam-1", exam_title: "测试考试", submitted_at: "2026-08-08T00:00:00Z", status: "graded", objective_score: "80", qa_score: "0", total_score: "80", pass: true, pass_score: "60", attempt_no: 1, graded_at: "2026-08-08T01:00:00Z", grader_name: "阅卷人" }] })
  };
  const submissions = await listStudentSubmissions(pool, "u1");
  assert.deepEqual(submissions[0], { id: "s-1", examId: "exam-1", examTitle: "测试考试", submittedAt: "2026-08-08T00:00:00Z", status: "graded", objectiveScore: 80, qaScore: 0, totalScore: 80, pass: true, passScore: 60, attemptNo: 1, gradedAt: "2026-08-08T01:00:00Z", graderName: "阅卷人" });
});

test("考生答卷详情剔除历史快照中的标准答案和解析", async () => {
  const queries = [];
  const pool = {
    query: async (sql) => {
      queries.push(sql);
      if (sql.includes("FROM submissions s")) return { rows: [{ id: "s-1", exam_id: "exam-1", exam_title: "测试考试", submitted_at: "2026-08-08T00:00:00Z", status: "graded", objective_score: "80", qa_score: "0", total_score: "80", pass: true, pass_score: "60", attempt_no: 1, graded_at: null, grader_name: "" }] };
      return { rows: [{ question_id: "q-1", position: 1, snapshot_json: { id: "q-1", type: "single", stem: "题目", options: [], answer: "A", explanation: "解析", score: 80 }, answer_json: "B", earned_score: "0", automatic_score: "0", manually_adjusted: false }] };
    }
  };
  const detail = await getStudentSubmission(pool, "s-1", "u1");
  assert.equal(detail.questions[0].submittedAnswer, "B");
  assert.equal(Object.hasOwn(detail.questions[0], "answer"), false);
  assert.equal(Object.hasOwn(detail.questions[0], "explanation"), false);
  assert.equal(queries[0].includes("$2"), true);
});

test("考生工作台映射授权考试和补考状态", async () => {
  let call = 0;
  const pool = {
    query: async (sql) => {
      call += 1;
      if (call === 1) return { rows: [{ id: "exam-1", title: "测试考试", duration_seconds: "600", total_score: "100", pass_score: "60", version: 1, completed_attempts: "1", awaiting_grade: false, remaining_extra_attempts: "0" }] };
      return { rows: [{ id: "s-1", exam_id: "exam-1", exam_title: "测试考试", submitted_at: "2026-08-08T00:00:00Z", status: "graded", objective_score: "80", qa_score: "0", total_score: "80", pass: true, pass_score: "60", attempt_no: 1, graded_at: null, grader_name: "" }] };
    }
  };
  const dashboard = await getStudentDashboard(pool, "u1");
  assert.equal(dashboard.exams[0].duration, 10);
  assert.equal(dashboard.exams[0].attempt.attemptNo, 2);
  assert.equal(dashboard.exams[0].attempt.available, true);
  assert.equal(dashboard.submissions.length, 1);
});
