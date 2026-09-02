const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  BANKS,
  ensureBank,
  ensureExam,
  ensureAssignmentsForActiveDingtalkUsers,
  ensureAssignmentsForActiveUsers,
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
  assert.deepEqual(preview.questions.find((question) => question.externalId === "coffee-078").imageUrls, ["resource:coffee-cherry-structure"]);
  assert.deepEqual(preview.questions.find((question) => question.externalId === "coffee-084").imageUrls, ["resource:coffee-siphon"]);
});

test("cupping basics draft contains 47 one-point questions", () => {
  const file = path.join(__dirname, "../docs/question-bank-drafts/cupping-questions.csv");
  const preview = previewQuestionCsv(fs.readFileSync(file, "utf8"));
  const counts = preview.questions.reduce((result, question) => {
    result[question.type] = (result[question.type] || 0) + 1;
    return result;
  }, {});

  assert.equal(preview.canCommit, true);
  assert.equal(preview.validRows, 47);
  assert.equal(preview.questions.reduce((sum, question) => sum + question.score, 0), 47);
  assert.deepEqual(counts, { qa: 14, fill: 4, judge: 19, multi: 1, single: 9 });
  assert.deepEqual(preview.questions.find((question) => question.externalId === "cupping-003").answer, ["强度、杯数", "严重程度、杯数"]);
});

test("cupping basics exam is published for 30 minutes with an 85 percent pass score", async () => {
  const bank = BANKS.find((item) => item.key === "cupping");
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
  const questions = Array.from({ length: 47 }, (_, index) => ({
    id: `question-cupping-${String(index + 2).padStart(3, "0")}`,
    position: index + 1,
    examScore: 1
  }));

  const result = await ensureExam(client, bank, questions, true);

  assert.deepEqual(bank, {
    key: "cupping",
    file: "cupping-questions.csv",
    bankId: "bank-cupping-basics",
    examId: "exam-cupping-basics",
    title: "杯测基础知识",
    duration: 30
  });
  assert.deepEqual(result, { total: 47, pass: 39.95, status: "published" });
  assert.deepEqual(inserts[0], ["exam-cupping-basics", "杯测基础知识", "published", 1800, 39.95, 47, "bank-cupping-basics"]);
});

test("legal regulations draft contains 53 questions totaling 100 points", () => {
  const file = path.join(__dirname, "../docs/question-bank-drafts/legal-questions.csv");
  const preview = previewQuestionCsv(fs.readFileSync(file, "utf8"));
  const counts = preview.questions.reduce((result, question) => {
    result[question.type] = (result[question.type] || 0) + 1;
    return result;
  }, {});
  const scores = preview.questions.reduce((result, question) => {
    result[question.score] = (result[question.score] || 0) + 1;
    return result;
  }, {});

  assert.equal(preview.canCommit, true);
  assert.equal(preview.validRows, 53);
  assert.equal(preview.questions.reduce((sum, question) => sum + question.score, 0), 100);
  assert.deepEqual(counts, { single: 19, multi: 19, judge: 15 });
  assert.deepEqual(scores, { 1: 34, 3: 10, 4: 9 });
});

test("legal regulations exam is published for 40 minutes with an 85 percent pass score", async () => {
  const bank = BANKS.find((item) => item.key === "legal");
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
  const questions = Array.from({ length: 53 }, (_, index) => ({
    id: `question-legal-${String(index + 2).padStart(3, "0")}`,
    position: index + 1,
    examScore: index < 34 ? 1 : index < 44 ? 3 : 4
  }));

  const result = await ensureExam(client, bank, questions, true);

  assert.deepEqual(bank, {
    key: "legal",
    file: "legal-questions.csv",
    bankId: "bank-legal-regulations",
    examId: "exam-legal-regulations",
    title: "餐饮相关法律法规",
    duration: 40
  });
  assert.deepEqual(result, { total: 100, pass: 85, status: "published" });
  assert.deepEqual(inserts[0], ["exam-legal-regulations", "餐饮相关法律法规", "published", 2400, 85, 100, "bank-legal-regulations"]);
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
    examScore: 1
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
  assert.deepEqual(inserts[0], ["exam-coffee-basics", "咖啡基础知识", "published", 3600, 85, 100, "bank-coffee-basics"]);
});

test("旧 CSV 分值只写入组卷关系而不写题库题目", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith("SELECT id, name")) return { rows: [] };
      if (sql.startsWith("SELECT bank_id")) return { rows: [] };
      return { rows: [] };
    }
  };
  const rows = await ensureBank(client, {
    key: "sample", bankId: "bank-sample", title: "测试题库"
  }, [{
    externalId: "1", type: "single", stem: "题干", options: [{ label: "A", text: "答案" }, { label: "B", text: "干扰项" }],
    optionImages: {}, imageUrls: [], answer: "A", explanation: "解析", score: 3
  }]);
  const insert = calls.find((call) => call.sql.includes("INSERT INTO questions"));
  assert.ok(insert);
  assert.equal(insert.sql.includes("score"), false);
  assert.deepEqual(rows, [{ id: "question-sample-1", position: 1, examScore: 3 }]);
});

test("parseArgs supports assigning all active DingTalk users", () => {
  const args = parseArgs(["--all-active-dingtalk-users", "--only", "coffee", "--publish"]);
  assert.equal(args.allActiveDingtalkUsers, true);
  assert.equal(args.publish, true);
  assert.equal(args.unionId, "");
  assert.equal(args.only, "coffee");
});

test("parseArgs supports importing a question bank without creating an exam or assignments", () => {
  const args = parseArgs(["--question-bank-only", "--only", "cupping"]);
  assert.equal(args.questionBankOnly, true);
  assert.equal(args.only, "cupping");
  assert.equal(args.publish, false);
  assert.equal(args.allActiveUsers, false);
});

test("question-bank-only mode rejects publish and assignment options", () => {
  assert.throws(
    () => parseArgs(["--question-bank-only", "--publish"]),
    /不能与 --publish 同时使用/
  );
  assert.throws(
    () => parseArgs(["--question-bank-only", "--all-active-users"]),
    /不能与考试授权参数同时使用/
  );
});

test("parseArgs requires exactly one assignment mode", () => {
  assert.throws(() => parseArgs([]), /--all-active-users/);
  assert.throws(
    () => parseArgs(["--union-id", "private-id", "--all-active-dingtalk-users"]),
    /不能同时使用/
  );
  assert.throws(
    () => parseArgs(["--all-active-users", "--all-active-dingtalk-users"]),
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

test("parseArgs supports assigning every active platform user", () => {
  const args = parseArgs(["--all-active-users", "--only", "legal", "--publish"]);
  assert.equal(args.allActiveUsers, true);
  assert.equal(args.allActiveDingtalkUsers, false);
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

test("active DingTalk and Feishu users receive cross-platform group assignments", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("SELECT DISTINCT u.id")) return { rows: [{ id: "user-ding" }, { id: "user-feishu" }] };
      return { rows: [] };
    }
  };
  const users = await ensureAssignmentsForActiveUsers(client, [{ examId: "exam-one" }]);
  assert.deepEqual(users, ["user-ding", "user-feishu"]);
  assert.equal(calls[0].sql.includes("'feishu'"), true);
  assert.equal(calls.some((call) => call.sql.includes("'all-active-users'")), true);
});
