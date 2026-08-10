const assert = require("node:assert/strict");
const test = require("node:test");
const {
  EXAM_AUDIT_SQL,
  ORPHAN_QUESTION_AUDIT_SQL,
  auditExamQuestionModel,
  buildAuditReport,
  mapExamAuditRow,
  parseArgs
} = require("../scripts/audit-exam-question-model");

const examRows = [
  {
    exam_id: "exam-1",
    exam_title: "测试考试",
    exam_status: "published",
    question_count: "2",
    question_bank_count: "1",
    exam_question_score_total: "100.00",
    declared_total_score: "100.00",
    total_score_difference: "0.00",
    question_score_mismatch_count: "0"
  },
  {
    exam_id: "exam-2",
    exam_title: "待整理考试",
    exam_status: "draft",
    question_count: "3",
    question_bank_count: "2",
    exam_question_score_total: "90.00",
    declared_total_score: "100.00",
    total_score_difference: "-10.00",
    question_score_mismatch_count: "2"
  }
];

test("审计参数默认只读运行并拒绝写入开关", () => {
  assert.deepEqual(parseArgs([]), { compact: false, help: false });
  assert.deepEqual(parseArgs(["--compact"]), { compact: true, help: false });
  assert.deepEqual(parseArgs(["--help"]), { compact: false, help: true });
  assert.throws(() => parseArgs(["--apply"]), /不支持的参数/);
});

test("审计行使用白名单映射且不输出题干答案或身份", () => {
  const mapped = mapExamAuditRow({
    ...examRows[0],
    stem: "不得输出",
    answer_json: "不得输出",
    user_id: "user-private",
    submission_id: "submission-private"
  });
  assert.deepEqual(Object.keys(mapped), [
    "examId", "examTitle", "examStatus", "questionCount", "questionBankCount",
    "examQuestionScoreTotal", "declaredTotalScore", "totalScoreDifference",
    "totalScoreMatches", "questionScoreMismatchCount"
  ]);
  assert.equal(JSON.stringify(mapped).includes("不得输出"), false);
  assert.equal(JSON.stringify(mapped).includes("private"), false);
});

test("审计报告汇总多题库、总分、题目分值和孤立题差异", () => {
  const report = buildAuditReport(examRows, {
    orphan_question_count: "4",
    active_orphan_question_count: "3"
  });
  assert.deepEqual(report.summary, {
    examCount: 2,
    multiBankExamCount: 1,
    totalScoreMismatchExamCount: 1,
    questionScoreMismatchReferenceCount: 2,
    orphanQuestionCount: 4,
    activeOrphanQuestionCount: 3
  });
  assert.equal(report.exams[0].totalScoreMatches, true);
  assert.equal(report.exams[1].totalScoreDifference, -10);
});

test("数据库审计只执行两条 SELECT", async () => {
  const calls = [];
  const queryable = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("FROM exams e")) return { rows: examRows };
      return { rows: [{ orphan_question_count: 4, active_orphan_question_count: 3 }] };
    }
  };
  const report = await auditExamQuestionModel(queryable);
  assert.equal(report.summary.examCount, 2);
  assert.deepEqual(calls, [EXAM_AUDIT_SQL, ORPHAN_QUESTION_AUDIT_SQL]);
  assert.equal(calls.every((sql) => /^\s*SELECT\b/i.test(sql)), true);
  assert.equal(calls.some((sql) => /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i.test(sql)), false);
  assert.equal(calls.some((sql) => /\b(?:stem|answer_json|users|submissions|user_id)\b/i.test(sql)), false);
});
