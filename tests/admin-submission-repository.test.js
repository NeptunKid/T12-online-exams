const assert = require("node:assert/strict");
const test = require("node:test");
const {
  gradeAdminSubmission,
  listAdminSubmissions,
  mapAdminQuestion,
  automaticScore,
  scoreInput
} = require("../src/db/admin-submission-repository");

test("管理员题目映射兼容历史 text 题干和对象选项", () => {
  const question = mapAdminQuestion({
    question_id: "q-1",
    position: 1,
    snapshot_json: {
      legacySourceKey: "legacy-1",
      type: "single",
      text: "历史题干",
      options: { A: "选项 A", B: "选项 B" },
      answer: "A",
      score: 10
    },
    answer_json: "B",
    earned_score: "0",
    automatic_score: "0",
    manually_adjusted: false
  });
  assert.equal(question.text, "历史题干");
  assert.deepEqual(question.options, { A: "选项 A", B: "选项 B" });
  assert.equal(question.answer, "A");
  assert.equal(question.sourceId, "legacy-1");
});

test("管理员阅卷使用交卷快照，并标识后来被修改或删除的题目", () => {
  const modified = mapAdminQuestion({
    question_id: "q-1", current_question_id: "q-1", current_status: "active", current_version: "2",
    position: 1,
    snapshot_json: { type: "single", stem: "旧题干", options: { A: "甲", B: "乙" }, answer: "A", explanation: "旧解析", score: 2 },
    current_type: "single", current_stem: "新题干", current_options: [{ label: "A", text: "甲" }, { label: "B", text: "乙" }],
    current_images: [], current_answer: "B", current_explanation: "新解析", current_score: "2",
    answer_json: "A", earned_score: "2", automatic_score: "2", manually_adjusted: false
  });
  assert.equal(modified.referenceStatus, "modified");
  assert.deepEqual(modified.changedFields, ["题干", "标准答案", "解析"]);
  assert.equal(modified.current.answer, "B");

  const deleted = mapAdminQuestion({ question_id: "q-2", position: 2, snapshot_json: { type: "qa", stem: "历史题目", score: 5 }, answer_json: "作答", earned_score: "0", manually_adjusted: false });
  assert.equal(deleted.referenceStatus, "unavailable");
});

test("管理员列表从 PostgreSQL 汇总待阅卷和已批阅答卷", async () => {
  const pool = {
    query: async () => ({ rows: [
      { id: "s-1", exam_id: "exam-1", exam_title: "消防基础考试", student_name: "学员甲", submitted_at: "2026-08-09T00:00:00Z", status: "pending", objective_score: "80", qa_score: "0", total_score: null, pass: null, pass_score: "85", attempt_no: "1" },
      { id: "s-2", exam_id: "exam-2", exam_title: "IT基础考试", student_name: "学员乙", submitted_at: "2026-08-08T00:00:00Z", status: "graded", objective_score: "86", qa_score: "0", total_score: "86", pass: true, pass_score: "73.1", attempt_no: "1" }
    ] })
  };
  const result = await listAdminSubmissions(pool);
  assert.deepEqual(result.stats, { total: 2, pending: 1, graded: 1 });
  assert.equal(result.submissions[0].examTitle, "消防基础考试");
});

test("阅卷事务保存逐题分数并重算总分", async () => {
  const earned = new Map([[1, 0], [2, 0]]);
  let submissionUpdate = null;
  const questionRows = () => [
    { question_id: "q-1", current_question_id: "q-1", current_status: "active", current_version: "2", position: 1, snapshot_json: { type: "single", stem: "客观题", options: { A: "A", B: "B" }, answer: "A", score: 60 }, current_type: "single", current_stem: "修订题干", current_options: [{ label: "A", text: "A" }, { label: "B", text: "B" }], current_images: [], current_answer: "B", current_explanation: "修订解析", current_score: "60", answer_json: "B", earned_score: String(earned.get(1)), automatic_score: "0", manually_adjusted: earned.get(1) !== 0 },
    { question_id: "q-2", position: 2, snapshot_json: { type: "qa", stem: "问答题", answer: "参考", score: 40 }, answer_json: "作答", earned_score: String(earned.get(2)), automatic_score: null, manually_adjusted: earned.get(2) !== 0 }
  ];
  const client = {
    async query(sql, params) {
      if (sql.includes("SELECT s.id") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: "s-1", exam_id: "exam-1", user_id: "user-1", pass_score: "60", total_score: "100", scores_json: {} }] };
      }
      if (sql.includes("SELECT s.*")) {
        return { rows: [{
          id: "s-1", exam_id: "exam-1", exam_title: "测试考试", exam_total_score: "100", exam_pass_score: "60", exam_version: "1",
          student_name: "学员甲", submitted_at: "2026-08-09T00:00:00Z", status: "graded", objective_score: "60", qa_score: "20",
          total_score: "80", pass: true, pass_score: "60", attempt_no: "1", duration_seconds: "120", scores_json: JSON.parse(submissionUpdate[6]),
          grader_name: "阅卷人", grader_comment: "已复核", graded_at: submissionUpdate[10], user_id: "user-1", dingtalk_union_id: "masked-in-test"
        }] };
      }
      if (sql.includes("FROM submission_questions sq")) return { rows: questionRows() };
      if (sql.includes("retake_permissions")) return { rows: [] };
      if (sql.includes("UPDATE submission_questions")) {
        earned.set(params[1], params[2]);
        return { rows: [] };
      }
      if (sql.includes("UPDATE submissions")) {
        submissionUpdate = params;
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const pool = {
    connect: async () => client
  };

  const detail = await gradeAdminSubmission(pool, "s-1", {
    objectiveScores: { "q-1": "50" },
    qaScores: { "q-2": "20" },
    useCurrentQuestionIds: ["q-1"],
    passScore: "60",
    graderComment: "已复核"
  }, { userId: "grader-1", name: "阅卷人" });

  assert.equal(submissionUpdate[1], 60);
  assert.equal(submissionUpdate[2], 20);
  assert.equal(submissionUpdate[3], 80);
  assert.equal(submissionUpdate[5], true);
  assert.equal(JSON.parse(submissionUpdate[6]).objectiveDetail["q-1"].correctAnswer, "B");
  assert.equal(JSON.parse(submissionUpdate[6]).reviewReferences["q-1"].source, "current");
  assert.equal(detail.submission.totalScore, 80);
});

test("分数输入限制在题目分值范围内", () => {
  assert.equal(scoreInput("12", 10, "题目 1", true), 10);
  assert.equal(scoreInput("-1", 10, "题目 1", true), 0);
  assert.throws(() => scoreInput("", 10, "问答题 1", true), /请填写/);
});

test("采用当前题库答案时按当前答案重新自动判分", () => {
  assert.equal(automaticScore({ type: "single", submittedAnswer: "B", answer: "B", score: 2 }), 2);
  assert.equal(automaticScore({ type: "multi", submittedAnswer: ["A"], answer: ["A", "B"], score: 4 }), 2);
  assert.equal(automaticScore({ type: "fill", submittedAnswer: " Espresso ", answer: ["espresso"], score: 2 }), 2);
});
