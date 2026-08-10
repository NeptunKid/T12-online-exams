#!/usr/bin/env node

const { createPostgresPool } = require("../src/db/postgres-client");
const { loadEnvFile } = require("./migrate");

const EXAM_AUDIT_SQL = `
  SELECT
    e.id AS exam_id,
    e.title AS exam_title,
    e.status AS exam_status,
    COUNT(eq.question_id)::integer AS question_count,
    COUNT(DISTINCT q.bank_id)::integer AS question_bank_count,
    COALESCE(SUM(eq.score), 0)::numeric AS exam_question_score_total,
    e.total_score AS declared_total_score,
    (COALESCE(SUM(eq.score), 0) - e.total_score)::numeric AS total_score_difference,
    COUNT(eq.question_id) FILTER (
      WHERE q.score IS DISTINCT FROM eq.score
    )::integer AS question_score_mismatch_count
  FROM exams e
  LEFT JOIN exam_questions eq ON eq.exam_id = e.id
  LEFT JOIN questions q ON q.id = eq.question_id
  GROUP BY e.id, e.title, e.status, e.total_score, e.created_at
  ORDER BY e.created_at, e.id;`;

const ORPHAN_QUESTION_AUDIT_SQL = `
  SELECT
    COUNT(*)::integer AS orphan_question_count,
    COUNT(*) FILTER (WHERE q.status = 'active')::integer AS active_orphan_question_count
  FROM questions q
  WHERE NOT EXISTS (
    SELECT 1
    FROM exam_questions eq
    WHERE eq.question_id = q.id
  );`;

function parseArgs(argv) {
  const unknown = argv.filter((value) => value !== "--compact" && value !== "--help");
  if (unknown.length) throw new Error(`不支持的参数：${unknown[0]}`);
  return {
    compact: argv.includes("--compact"),
    help: argv.includes("--help")
  };
}

function numeric(value, field) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`审计结果字段 ${field} 不是有效数字`);
  return result;
}

function mapExamAuditRow(row) {
  const difference = numeric(row.total_score_difference, "total_score_difference");
  return {
    examId: String(row.exam_id),
    examTitle: String(row.exam_title || ""),
    examStatus: String(row.exam_status || ""),
    questionCount: numeric(row.question_count, "question_count"),
    questionBankCount: numeric(row.question_bank_count, "question_bank_count"),
    examQuestionScoreTotal: numeric(row.exam_question_score_total, "exam_question_score_total"),
    declaredTotalScore: numeric(row.declared_total_score, "declared_total_score"),
    totalScoreDifference: difference,
    totalScoreMatches: difference === 0,
    questionScoreMismatchCount: numeric(row.question_score_mismatch_count, "question_score_mismatch_count")
  };
}

function buildAuditReport(examRows, orphanRow = {}) {
  const exams = (examRows || []).map(mapExamAuditRow);
  return {
    mode: "read-only",
    summary: {
      examCount: exams.length,
      multiBankExamCount: exams.filter((exam) => exam.questionBankCount > 1).length,
      totalScoreMismatchExamCount: exams.filter((exam) => !exam.totalScoreMatches).length,
      questionScoreMismatchReferenceCount: exams.reduce(
        (total, exam) => total + exam.questionScoreMismatchCount,
        0
      ),
      orphanQuestionCount: numeric(orphanRow.orphan_question_count ?? 0, "orphan_question_count"),
      activeOrphanQuestionCount: numeric(
        orphanRow.active_orphan_question_count ?? 0,
        "active_orphan_question_count"
      )
    },
    exams
  };
}

async function auditExamQuestionModel(queryable) {
  const [examResult, orphanResult] = await Promise.all([
    queryable.query(EXAM_AUDIT_SQL),
    queryable.query(ORPHAN_QUESTION_AUDIT_SQL)
  ]);
  return buildAuditReport(examResult.rows, orphanResult.rows[0]);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("用法：node scripts/audit-exam-question-model.js [--compact]");
    console.log("该工具只执行 SELECT，不读取题干、答案、用户身份或答卷内容。");
    return;
  }

  loadEnvFile();
  const pool = createPostgresPool();
  try {
    const report = await auditExamQuestionModel(pool);
    console.log(JSON.stringify(report, null, args.compact ? 0 : 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || "试卷与题库数据审计失败");
    process.exitCode = 1;
  });
}

module.exports = {
  EXAM_AUDIT_SQL,
  ORPHAN_QUESTION_AUDIT_SQL,
  auditExamQuestionModel,
  buildAuditReport,
  mapExamAuditRow,
  parseArgs
};
