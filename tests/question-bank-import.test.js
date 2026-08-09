const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  BANKS,
  ensureExam,
  ensureAssignmentsForActiveDingtalkUsers,
  parseArgs
} = require("../scripts/import-question-banks");
const { previewQuestionCsv } = require("../src/import/question-csv");

test("coffee basics draft contains 100 one-point questions", () => {
  const file = path.join(__dirname, "../docs/question-bank-drafts/coffee-questions.csv");
  const preview = previewQuestionCsv(fs.readFileSync(file, "utf8"));
  const counts = preview.questions.reduce((result, question) => {
    result[question.type] = (result[question.type] || 0) + 1;
    return result;
  }, {});

  assert.equal(preview.canCommit, true);
  assert.equal(preview.validRows, 100);
  assert.equal(preview.questions.reduce((sum, question) => sum + question.score, 0), 100);
  assert.deepEqual(counts, { single: 33, multi: 12, judge: 31, fill: 4, qa: 20 });
});

test("coffee basics exam is published for 60 minutes with an 85 percent pass score", async () => {
  const bank = BANKS.find((item) => item.key === "coffee");
  const inserts = [];
  const client = {
    async query(sql, params) {
      if (sql.startsWith("SELECT id, title")) return { rows: [] };
      if (sql.startsWith("INSERT INTO exams")) {
        inserts.push(params);
        return { rows: [] };
      }
      if (sql.startsWith("SELECT score")) return { rows: [] };
      if (sql.startsWith("INSERT INTO exam_questions")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const questions = Array.from({ length: 100 }, (_, index) => ({
    id: `question-coffee-${String(index + 1).padStart(3, "0")}`,
    position: index + 1,
    score: 1
  }));

  const result = await ensureExam(client, bank, questions, true);

  assert.deepEqual(bank, {
    key: "coffee",
    file: "coffee-questions.csv",
    bankId: "bank-coffee-basics",
    examId: "exam-coffee-basics",
    title: "咖啡基础知识",
    duration: 60
  });
  assert.deepEqual(result, { total: 100, pass: 85, status: "published" });
  assert.deepEqual(inserts[0], ["exam-coffee-basics", "咖啡基础知识", "published", 3600, 85, 100]);
});

test("parseArgs supports assigning all active DingTalk users", () => {
  const args = parseArgs(["--all-active-dingtalk-users", "--only", "coffee", "--publish"]);
  assert.equal(args.allActiveDingtalkUsers, true);
  assert.equal(args.publish, true);
  assert.equal(args.unionId, "");
  assert.equal(args.only, "coffee");
});

test("parseArgs requires exactly one assignment mode", () => {
  assert.throws(() => parseArgs([]), /--union-id 或 --all-active-dingtalk-users/);
  assert.throws(
    () => parseArgs(["--union-id", "private-id", "--all-active-dingtalk-users"]),
    /不能同时使用/
  );
  assert.throws(
    () => parseArgs(["--all-active-dingtalk-users", "--only", "unknown"]),
    /未知题库/
  );
  assert.throws(
    () => parseArgs(["--all-active-dingtalk-users", "--only"]),
    /必须提供题库 key/
  );
});

test("active DingTalk users receive every imported exam idempotently", async () => {
  const inserts = [];
  const client = {
    async query(sql, params) {
      if (sql.includes("SELECT DISTINCT u.id")) return { rows: [{ id: "user-a" }, { id: "user-b" }] };
      if (sql.includes("INSERT INTO exam_assignments")) {
        assert.match(sql, /ON CONFLICT \(exam_id, subject_type, subject_id\) DO NOTHING/);
        inserts.push(params);
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const exams = [{ examId: "exam-one" }, { examId: "exam-two" }, { examId: "exam-three" }];

  const userIds = await ensureAssignmentsForActiveDingtalkUsers(client, exams);

  assert.deepEqual(userIds, ["user-a", "user-b"]);
  const directAssignments = inserts.filter((params) => params.length === 3);
  const groupAssignments = inserts.filter((params) => params.length === 2);
  assert.equal(directAssignments.length, 6);
  assert.equal(groupAssignments.length, 3);
  assert.deepEqual(new Set(directAssignments.map((params) => `${params[1]}:${params[2]}`)).size, 6);
});

test("bulk assignment aborts when no active DingTalk user exists", async () => {
  const client = { query: async () => ({ rows: [] }) };
  await assert.rejects(
    ensureAssignmentsForActiveDingtalkUsers(client, [{ examId: "exam-one" }]),
    /没有找到已登录且状态为 active 的钉钉用户/
  );
});
