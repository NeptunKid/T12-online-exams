#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createBackup } = require("./backup-submissions");
const { databaseEnvironment, loadEnvFile, runPsql } = require("./migrate");

const ROOT = path.join(__dirname, "..");
const DEFAULT_SOURCE = path.resolve(ROOT, "../002_考试后台追踪系统_钉钉登录版/data/submissions.json");
const DEFAULT_EXAM_DATA = path.resolve(ROOT, "../002_考试后台追踪系统_钉钉登录版/public/exam_data.js");

function usage() {
  console.log("用法：node scripts/import-legacy-submissions.js --source <002 submissions.json> --exam-data <002 exam_data.js> --backup-dir <独立备份目录> [--dry-run]");
}

function parseArgs(argv) {
  const args = { source: DEFAULT_SOURCE, examData: DEFAULT_EXAM_DATA, backupDir: "", dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--source") args.source = argv[++index];
    else if (flag === "--exam-data") args.examData = argv[++index];
    else if (flag === "--backup-dir") args.backupDir = argv[++index];
    else if (flag === "--help") return null;
    else throw new Error(`不支持的参数：${flag}`);
  }
  return args;
}

function stableId(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32)}`;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("数据包含非有限数字");
    return String(value);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function jsonLiteral(value) {
  return `${sqlLiteral(JSON.stringify(value === undefined ? null : value))}::jsonb`;
}

function readJson(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`文件不存在：${resolved}`);
  try {
    return JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`JSON 无法解析：${resolved}（${error.message}）`);
  }
}

function readExamData(filePath) {
  const raw = fs.readFileSync(path.resolve(filePath), "utf8");
  const match = raw.match(/const\s+EXAM_DATA\s*=\s*([\s\S]*?);\s*$/);
  if (!match) throw new Error("无法解析 exam_data.js");
  return JSON.parse(match[1]);
}

function asFiniteNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("答卷包含无效数字");
  return number;
}

function timestamp(value, field, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`答卷字段 ${field} 不是有效时间`);
  return parsed.toISOString();
}

function validateAndNormalize(parsed, examData) {
  if (!parsed || !Array.isArray(parsed.submissions)) throw new Error("来源 JSON 必须包含 submissions 数组");
  if (!examData || !Array.isArray(examData.questions) || !examData.title) throw new Error("题库文件缺少 title 或 questions");

  const seenIds = new Set();
  const rows = parsed.submissions.map((row, index) => {
    if (!row || typeof row !== "object" || !row.id) throw new Error(`第 ${index + 1} 条答卷缺少 id`);
    if (seenIds.has(String(row.id))) throw new Error(`答卷 ID 重复：${row.id}`);
    seenIds.add(String(row.id));
    if (row.examTitle && row.examTitle !== examData.title) throw new Error(`答卷 ${row.id} 的 examTitle 与题库标题不一致`);
    const status = row.status || "pending";
    if (!["pending", "graded", "cancelled"].includes(status)) throw new Error(`答卷 ${row.id} 的状态不受支持`);
    return { ...row, id: String(row.id), status };
  });

  const questionIds = new Set();
  for (const question of examData.questions) {
    if (question?.id && questionIds.has(String(question.id))) throw new Error("题库包含重复题目 ID");
    if (question?.id) questionIds.add(String(question.id));
  }
  const answerKeys = new Set(rows.flatMap((row) => [
    ...Object.keys(row.answers || {}),
    ...Object.keys(row.objectiveDetail || {}),
    ...Object.keys(row.qaScores || {})
  ]));
  const unmatchedAnswerKeys = [...answerKeys].filter((key) => !questionIds.has(key));
  const missingQuestionCount = examData.questions.filter((question) => !question?.id).length;
  if (unmatchedAnswerKeys.length > missingQuestionCount) throw new Error("题库缺少题目 ID，且无法与答卷字段一一对应");
  let unmatchedIndex = 0;
  const questions = examData.questions.map((question, index) => ({
    ...question,
    legacySourceKey: String(question.id || unmatchedAnswerKeys[unmatchedIndex++] || `position:${index + 1}`)
  }));

  return { rows, questions, examData };
}

function buildImportSql(normalized) {
  const { rows, questions, examData } = normalized;
  const examId = stableId("legacy_exam", examData.title);
  const bankId = stableId("legacy_bank", examData.title);
  const statements = ["BEGIN;"];
  statements.push(`INSERT INTO question_banks (id, name, description, status) VALUES (${sqlLiteral(bankId)}, ${sqlLiteral(`002 历史题库：${examData.title}`)}, '从 002 只读导入', 'active') ON CONFLICT (id) DO NOTHING;`);
  statements.push(`INSERT INTO exams (id, title, status, duration_seconds, pass_score, total_score, version, answer_rules_json) VALUES (${sqlLiteral(examId)}, ${sqlLiteral(examData.title)}, 'published', ${asFiniteNumber(examData.duration) * 60}, ${asFiniteNumber(examData.passScore)}, ${asFiniteNumber(examData.totalScore)}, 1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;`);

  questions.forEach((question, index) => {
    const questionId = stableId("legacy_question", `${examId}:${question.legacySourceKey}`);
    const snapshot = { ...question };
    statements.push(`INSERT INTO questions (id, bank_id, external_id, type, stem, options_json, answer_json, explanation, score, version, status) VALUES (${sqlLiteral(questionId)}, ${sqlLiteral(bankId)}, ${sqlLiteral(question.legacySourceKey)}, ${sqlLiteral(question.type)}, ${sqlLiteral(question.stem || question.text || "")}, ${jsonLiteral(question.options || [])}, ${jsonLiteral(question.answer)}, ${sqlLiteral(question.explanation || "")}, ${asFiniteNumber(question.score)}, 1, 'active') ON CONFLICT (id) DO NOTHING;`);
    statements.push(`INSERT INTO exam_questions (exam_id, question_id, position, score, section) VALUES (${sqlLiteral(examId)}, ${sqlLiteral(questionId)}, ${index + 1}, ${asFiniteNumber(question.score)}, '') ON CONFLICT (exam_id, question_id) DO NOTHING;`);
    question.__legacyQuestionId = questionId;
    question.__legacySnapshot = { ...snapshot, legacySourceKey: question.legacySourceKey };
  });

  const users = new Map();
  for (const row of rows) {
    const identityKey = String(row.dingtalkUnionId || row.studentNo || (row.studentName || row.department ? `${row.studentName || "unknown"}:${row.department || ""}` : `submission:${row.id}`));
    const userId = stableId("legacy_user", identityKey);
    users.set(userId, { userId, identityKey, row });
  }
  for (const { userId, identityKey, row } of users.values()) {
    const unmatched = !row.dingtalkUnionId && !row.studentNo;
    statements.push(`INSERT INTO users (id, name, employee_no, department, status) VALUES (${sqlLiteral(userId)}, ${sqlLiteral(row.studentName || "历史答卷用户")}, ${sqlLiteral(row.studentNo || null)}, ${sqlLiteral(row.department || null)}, ${sqlLiteral(unmatched ? "legacy_unmatched" : "active")}) ON CONFLICT (id) DO NOTHING;`);
    statements.push(`INSERT INTO user_identities (id, user_id, provider, provider_subject, union_id) VALUES (${sqlLiteral(stableId("legacy_identity", identityKey))}, ${sqlLiteral(userId)}, 'legacy', ${sqlLiteral(`legacy:${identityKey}`)}, ${sqlLiteral(row.dingtalkUnionId || null)}) ON CONFLICT (id) DO NOTHING;`);
    statements.push(`INSERT INTO user_roles (user_id, role_code) VALUES (${sqlLiteral(userId)}, 'student') ON CONFLICT (user_id, role_code) DO NOTHING;`);
    const assignmentId = `legacy_assignment_${crypto.createHash("md5").update(`${examId}:user:${userId}`).digest("hex")}`;
    statements.push(`INSERT INTO exam_assignments (id, exam_id, subject_type, subject_id) VALUES (${sqlLiteral(assignmentId)}, ${sqlLiteral(examId)}, 'user', ${sqlLiteral(userId)}) ON CONFLICT (id) DO NOTHING;`);
  }

  for (const row of rows) {
    const identityKey = String(row.dingtalkUnionId || row.studentNo || (row.studentName || row.department ? `${row.studentName || "unknown"}:${row.department || ""}` : `submission:${row.id}`));
    const userId = stableId("legacy_user", identityKey);
    const submittedAt = timestamp(row.submittedAt, "submittedAt");
    const startedAt = timestamp(row.startedAt, "startedAt", true);
    const pass = typeof row.pass === "boolean" ? row.pass : null;
    const scores = { objectiveDetail: row.objectiveDetail || {}, objectiveSummary: row.objectiveSummary || {}, qaScores: row.qaScores || {}, qaMaxScore: row.qaMaxScore ?? null };
    statements.push(`INSERT INTO submissions (id, legacy_submission_id, exam_id, exam_version, user_id, legacy_student_name, legacy_dingtalk_union_id, attempt_no, status, started_at, submitted_at, duration_seconds, objective_score, qa_score, total_score, pass_score, pass, scores_json, grader_name, grader_comment, graded_at) VALUES (${sqlLiteral(row.id)}, ${sqlLiteral(row.id)}, ${sqlLiteral(examId)}, 1, ${sqlLiteral(userId)}, ${sqlLiteral(row.studentName || null)}, ${sqlLiteral(row.dingtalkUnionId || null)}, ${Math.max(1, Math.trunc(asFiniteNumber(row.attemptNo, 1)))}, ${sqlLiteral(row.status)}, ${sqlLiteral(startedAt)}, ${sqlLiteral(submittedAt)}, ${Math.max(0, Math.trunc(asFiniteNumber(row.durationSeconds)))}, ${asFiniteNumber(row.objectiveScore)}, ${asFiniteNumber(row.qaScore)}, ${sqlLiteral(row.totalScore === null || row.totalScore === undefined ? null : asFiniteNumber(row.totalScore))}, ${asFiniteNumber(row.passScore, asFiniteNumber(examData.passScore))}, ${sqlLiteral(pass)}, ${jsonLiteral(scores)}, ${sqlLiteral(row.graderName || null)}, ${sqlLiteral(row.graderComment || "")}, ${sqlLiteral(timestamp(row.gradedAt, "gradedAt", true))}) ON CONFLICT (id) DO NOTHING;`);
    questions.forEach((question, index) => {
      const detail = row.objectiveDetail?.[question.legacySourceKey] || {};
      const answer = row.answers?.[question.legacySourceKey] ?? (question.type === "multi" ? [] : "");
      const earned = question.type === "qa" ? asFiniteNumber(row.qaScores?.[question.legacySourceKey]) : asFiniteNumber(detail.earned);
      const automatic = question.type === "qa" ? null : asFiniteNumber(detail.automaticEarned, earned);
      const manuallyAdjusted = question.type !== "qa" && Boolean(detail.manuallyAdjusted);
      statements.push(`INSERT INTO submission_questions (submission_id, question_id, position, snapshot_json, answer_json, earned_score, automatic_score, manually_adjusted) VALUES (${sqlLiteral(row.id)}, ${sqlLiteral(question.__legacyQuestionId)}, ${index + 1}, ${jsonLiteral(question.__legacySnapshot)}, ${jsonLiteral(answer)}, ${earned}, ${sqlLiteral(automatic)}, ${sqlLiteral(manuallyAdjusted)}) ON CONFLICT (submission_id, position) DO NOTHING;`);
    });
  }
  statements.push("COMMIT;");
  return statements.join("\n");
}

function summarize(normalized) {
  const { rows, questions, examData } = normalized;
  return {
    sourceRecordCount: rows.length,
    gradedCount: rows.filter((row) => row.status === "graded").length,
    pendingCount: rows.filter((row) => row.status === "pending").length,
    cancelledCount: rows.filter((row) => row.status === "cancelled").length,
    questionCount: questions.length,
    examTitle: examData.title,
    uniqueStudentCount: new Set(rows.map((row) => row.dingtalkUnionId || row.studentNo || row.studentName || row.id)).size
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args) return usage();
  const parsed = readJson(args.source);
  const examData = readExamData(args.examData);
  const normalized = validateAndNormalize(parsed, examData);
  const summary = summarize(normalized);
  if (args.dryRun) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (!args.backupDir) throw new Error("实际导入必须指定 --backup-dir，以便先创建不可覆盖的来源备份");
  loadEnvFile();
  const backup = createBackup(args.source, args.backupDir);
  runPsql(buildImportSql(normalized), databaseEnvironment());
  console.log(JSON.stringify({ ...summary, backupChecksum: backup.checksum }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { buildImportSql, main, parseArgs, readExamData, readJson, summarize, validateAndNormalize };
