#!/usr/bin/env node

const assert = require("node:assert/strict");
const path = require("path");
const { databaseEnvironment, loadEnvFile, runPsql } = require("./migrate");
const { readExamData, readJson, validateAndNormalize } = require("./import-legacy-submissions");

const ROOT = path.join(__dirname, "..");
const DEFAULT_SOURCE = path.resolve(ROOT, "../002_考试后台追踪系统_钉钉登录版/data/submissions.json");
const DEFAULT_EXAM_DATA = path.resolve(ROOT, "../002_考试后台追踪系统_钉钉登录版/public/exam_data.js");

function parseArgs(argv) {
  const args = { source: DEFAULT_SOURCE, examData: DEFAULT_EXAM_DATA };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--source") args.source = argv[++index];
    else if (flag === "--exam-data") args.examData = argv[++index];
    else if (flag === "--help") return null;
    else throw new Error(`不支持的参数：${flag}`);
  }
  return args;
}

function queryJsonRows(environment, sql) {
  const output = runPsql(sql, environment, {}, { tuplesOnly: true });
  return output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

function expectedSubmissions(normalized) {
  return new Map(normalized.rows.map((row) => [row.id, {
    id: row.id,
    status: row.status,
    attemptNo: Math.max(1, Math.trunc(Number(row.attemptNo || 1))),
    objectiveScore: Number(row.objectiveScore || 0),
    qaScore: Number(row.qaScore || 0),
    totalScore: numberOrNull(row.totalScore),
    passScore: Number(row.passScore ?? normalized.examData.passScore),
    pass: typeof row.pass === "boolean" ? row.pass : null
  }]));
}

function expectedSnapshots(normalized) {
  const records = new Map();
  for (const row of normalized.rows) {
    normalized.questions.forEach((question, index) => {
      const detail = row.objectiveDetail?.[question.legacySourceKey] || {};
      const answer = row.answers?.[question.legacySourceKey] ?? (question.type === "multi" ? [] : "");
      const earnedScore = question.type === "qa" ? Number(row.qaScores?.[question.legacySourceKey] || 0) : Number(detail.earned || 0);
      const automaticScore = question.type === "qa" ? null : Number(detail.automaticEarned ?? earnedScore);
      records.set(`${row.id}:${index + 1}`, {
        submissionId: row.id,
        position: index + 1,
        answer,
        earnedScore,
        automaticScore,
        manuallyAdjusted: question.type !== "qa" && Boolean(detail.manuallyAdjusted),
        snapshot: question
      });
    });
  }
  return records;
}

function compareSubmissions(expected, actualRows) {
  assert.equal(actualRows.length, expected.size, "历史答卷数量不一致");
  for (const actual of actualRows) {
    const source = expected.get(actual.id);
    assert.ok(source, `数据库存在来源中没有的历史答卷：${actual.id}`);
    for (const field of ["status", "attemptNo", "objectiveScore", "qaScore", "totalScore", "passScore", "pass"]) {
      assert.deepEqual(actual[field], source[field], `答卷 ${actual.id} 的 ${field} 不一致`);
    }
  }
}

function compareSnapshots(expected, actualRows) {
  assert.equal(actualRows.length, expected.size, "逐题快照数量不一致");
  for (const actual of actualRows) {
    const source = expected.get(`${actual.submissionId}:${actual.position}`);
    assert.ok(source, `数据库存在来源中没有的逐题快照：${actual.submissionId}:${actual.position}`);
    for (const field of ["answer", "earnedScore", "automaticScore", "manuallyAdjusted", "snapshot"]) {
      assert.deepEqual(actual[field], source[field], `答卷 ${actual.submissionId} 第 ${actual.position} 题的 ${field} 不一致`);
    }
  }
}

function verify(normalized, environment) {
  const submissions = queryJsonRows(environment, `
    SELECT json_build_object(
      'id', id,
      'status', status,
      'attemptNo', attempt_no,
      'objectiveScore', objective_score,
      'qaScore', qa_score,
      'totalScore', total_score,
      'passScore', pass_score,
      'pass', pass
    )::text
    FROM submissions
    WHERE legacy_submission_id IS NOT NULL
    ORDER BY id;`);
  const snapshots = queryJsonRows(environment, `
    SELECT json_build_object(
      'submissionId', submission_id,
      'position', position,
      'answer', answer_json,
      'earnedScore', earned_score,
      'automaticScore', automatic_score,
      'manuallyAdjusted', manually_adjusted,
      'snapshot', snapshot_json
    )::text
    FROM submission_questions
    WHERE submission_id IN (SELECT id FROM submissions WHERE legacy_submission_id IS NOT NULL)
    ORDER BY submission_id, position;`);
  compareSubmissions(expectedSubmissions(normalized), submissions);
  compareSnapshots(expectedSnapshots(normalized), snapshots);
  return {
    sourceRecordCount: normalized.rows.length,
    verifiedSubmissionCount: submissions.length,
    verifiedSnapshotCount: snapshots.length,
    result: "passed"
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args) {
    console.log("用法：node scripts/verify-legacy-import.js --source <历史 submissions.json> --exam-data <历史 exam_data.js>");
    return;
  }
  const normalized = validateAndNormalize(readJson(args.source), readExamData(args.examData));
  loadEnvFile();
  console.log(JSON.stringify(verify(normalized, databaseEnvironment()), null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`历史答卷对账失败：${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { compareSnapshots, compareSubmissions, expectedSnapshots, expectedSubmissions, parseArgs, verify };
