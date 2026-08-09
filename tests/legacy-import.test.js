const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createBackup } = require("../scripts/backup-submissions");
const { buildImportSql, parseArgs, summarize, validateAndNormalize } = require("../scripts/import-legacy-submissions");

test("备份拒绝覆盖既有目标并保留 SHA-256 校验文件", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t12-backup-test-"));
  const source = path.join(tempDir, "source.json");
  const outputDir = path.join(tempDir, "backups");
  fs.writeFileSync(source, JSON.stringify({ submissions: [] }), "utf8");
  const now = new Date("2026-08-07T00:00:00.000Z");
  const first = createBackup(source, outputDir, now);
  assert.equal(fs.existsSync(first.outputPath), true);
  assert.equal(fs.existsSync(first.checksumPath), true);
  assert.throws(() => createBackup(source, outputDir, now), /目标备份已存在/);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("旧答卷校验保留 ID、状态和题目快照", () => {
  const examData = {
    title: "历史考试",
    duration: 10,
    passScore: 60,
    totalScore: 100,
    questions: [
      { id: "q1", type: "single", text: "历史题目", options: [{ label: "A", text: "选项" }], answer: "A", score: 100 }
    ]
  };
  const parsed = { submissions: [{ id: "legacy-1", examTitle: "历史考试", studentName: "甲", dingtalkUnionId: "u1", status: "graded", submittedAt: "2026-08-07T00:00:00Z", answers: { q1: "A" }, objectiveDetail: { q1: { earned: 100 } }, objectiveScore: 100, qaScore: 0, totalScore: 100, passScore: 60 }] };
  const normalized = validateAndNormalize(parsed, examData);
  const sql = buildImportSql(normalized);
  assert.equal(summarize(normalized).sourceRecordCount, 1);
  assert.match(sql, /legacy-1/);
  assert.match(sql, /snapshot_json/);
  assert.match(sql, /ON CONFLICT \(id\) DO NOTHING/);
  assert.match(sql, /INSERT INTO exam_assignments/);
  assert.match(sql, /legacy_assignment_/);
  assert.match(sql, /'published', 600,/);
  assert.match(sql, /历史题目/);
});

test("考试标题不一致时拒绝静默迁移", () => {
  const examData = { title: "新标题", questions: [{ id: "q1", type: "single", stem: "题目", answer: "A", score: 1 }] };
  const parsed = { submissions: [{ id: "legacy-2", examTitle: "旧标题", status: "graded", submittedAt: "2026-08-07T00:00:00Z" }] };
  assert.throws(() => validateAndNormalize(parsed, examData), /examTitle 与题库标题不一致/);
});

test("真实来源路径可通过 dry-run 统计且不要求数据库配置", () => {
  const projectRoot = path.join(__dirname, "..");
  const args = parseArgs(["--source", path.join(projectRoot, "../002_考试后台追踪系统_钉钉登录版/data/submissions.json"), "--exam-data", path.join(projectRoot, "../002_考试后台追踪系统_钉钉登录版/public/exam_data.js"), "--dry-run"]);
  assert.equal(args.dryRun, true);
});
