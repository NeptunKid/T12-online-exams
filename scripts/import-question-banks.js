#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { previewQuestionCsv } = require("../src/import/question-csv");
const { createPostgresPool } = require("../src/db/postgres-client");
const { loadQuestionResourceManifest } = require("../src/resources/question-resources");
const { loadEnvFile } = require("./migrate");

const BANKS = [
  { key: "extraction", file: "extraction-questions.csv", bankId: "bank-extraction-principle", examId: "exam-extraction-principle", title: "萃取原理考试", duration: 50 },
  { key: "fire", file: "fire-questions.csv", bankId: "bank-fire-basics", examId: "exam-fire-basics", title: "消防基础考试", duration: 30 },
  { key: "it", file: "it-questions.csv", bankId: "bank-it-basics", examId: "exam-it-basics", title: "IT基础考试", duration: 30 },
  { key: "coffee", file: "coffee-questions.csv", bankId: "bank-coffee-basics", examId: "exam-coffee-basics", title: "咖啡基础知识", duration: 60 },
  { key: "legal", file: "legal-questions.csv", bankId: "bank-legal-regulations", examId: "exam-legal-regulations", title: "餐饮相关法律法规", duration: 40 }
];

function parseArgs(argv) {
  const args = {
    inputDir: path.join(__dirname, "../docs/question-bank-drafts"),
    unionId: "",
    userName: "授权员工",
    publish: false,
    allActiveDingtalkUsers: false,
    only: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--input-dir") args.inputDir = argv[++index] || args.inputDir;
    else if (value === "--union-id") args.unionId = argv[++index] || "";
    else if (value === "--user-name") args.userName = argv[++index] || args.userName;
    else if (value === "--publish") args.publish = true;
    else if (value === "--all-active-dingtalk-users") args.allActiveDingtalkUsers = true;
    else if (value === "--only") {
      const only = argv[++index];
      if (!only || only.startsWith("--")) throw new Error("--only 必须提供题库 key");
      args.only = only;
    }
    else if (value === "--help") return null;
    else throw new Error(`不支持的参数：${value}`);
  }
  if (args.unionId && args.allActiveDingtalkUsers) {
    throw new Error("--union-id 与 --all-active-dingtalk-users 不能同时使用");
  }
  if (!args.unionId && !args.allActiveDingtalkUsers) {
    throw new Error("必须提供 --union-id 或 --all-active-dingtalk-users");
  }
  if (args.only && !BANKS.some((bank) => bank.key === args.only)) {
    throw new Error(`未知题库：${args.only}`);
  }
  return args;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function questionOptions(question) {
  const images = question.optionImages || {};
  return question.options.map((option) => ({ label: option.label, text: option.text, ...(images[option.label] ? { image: images[option.label] } : {}) }));
}

async function ensureBank(client, bank, questions) {
  const existing = await client.query("SELECT id, name, description, status FROM question_banks WHERE id = $1", [bank.bankId]);
  const values = [bank.bankId, bank.title, `${bank.title}（CSV 结构化题库）`];
  if (!existing.rows.length) {
    await client.query("INSERT INTO question_banks (id, name, description, status) VALUES ($1, $2, $3, 'active')", values);
  } else if (existing.rows[0].name !== bank.title || existing.rows[0].status !== "active") {
    throw new Error(`题库 ${bank.bankId} 已存在但元数据不一致，拒绝覆盖`);
  }
  for (const question of questions) {
    const id = `question-${bank.key}-${question.externalId}`;
    const options = questionOptions(question);
    const answer = question.answer;
    const images = question.imageUrls || [];
    const existingQuestion = await client.query(
      "SELECT bank_id, external_id, type, stem, options_json, images_json, answer_json, explanation, score, status FROM questions WHERE id = $1",
      [id]
    );
    if (!existingQuestion.rows.length) {
      await client.query(`
        INSERT INTO questions (id, bank_id, external_id, type, stem, options_json, images_json, answer_json, explanation, score, version, status)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, 1, 'active')`,
      [id, bank.bankId, question.externalId, question.type, question.stem, JSON.stringify(options), JSON.stringify(images), JSON.stringify(answer), question.explanation, question.score]);
    } else {
      const row = existingQuestion.rows[0];
      if (row.bank_id !== bank.bankId || row.external_id !== question.externalId || row.type !== question.type || row.stem !== question.stem
        || !sameJson(row.options_json || [], options) || !sameJson(row.images_json || [], images)
        || !sameJson(row.answer_json, answer) || row.explanation !== question.explanation
        || Number(row.score) !== Number(question.score) || row.status !== "active") {
        throw new Error(`题目 ${id} 已存在但内容不一致，拒绝覆盖`);
      }
    }
  }
  return questions.map((question, index) => ({ id: `question-${bank.key}-${question.externalId}`, position: index + 1, score: question.score }));
}

async function ensureExam(client, bank, questionRows, publish) {
  const total = questionRows.reduce((sum, question) => sum + Number(question.score), 0);
  const pass = Number((total * 0.85).toFixed(2));
  const status = publish ? "published" : "draft";
  const existing = await client.query("SELECT id, title, status, duration_seconds, pass_score, total_score, version FROM exams WHERE id = $1", [bank.examId]);
  if (!existing.rows.length) {
    await client.query(`INSERT INTO exams (id, title, status, duration_seconds, pass_score, total_score, version)
      VALUES ($1, $2, $3, $4, $5, $6, 1)`, [bank.examId, bank.title, status, bank.duration * 60, pass, total]);
  } else {
    const row = existing.rows[0];
    const allowedStatus = publish ? ["draft", "published"] : ["draft"];
    if (row.title !== bank.title || Number(row.duration_seconds) !== bank.duration * 60 || Number(row.pass_score) !== pass || Number(row.total_score) !== total || !allowedStatus.includes(row.status)) {
      throw new Error(`考试 ${bank.examId} 已存在但元数据不一致，拒绝覆盖`);
    }
    if (publish && row.status === "draft") await client.query("UPDATE exams SET status = 'published' WHERE id = $1", [bank.examId]);
  }
  for (const question of questionRows) {
    const existingQuestion = await client.query("SELECT score, position FROM exam_questions WHERE exam_id = $1 AND question_id = $2", [bank.examId, question.id]);
    if (!existingQuestion.rows.length) {
      await client.query("INSERT INTO exam_questions (exam_id, question_id, position, score) VALUES ($1, $2, $3, $4)", [bank.examId, question.id, question.position, question.score]);
    } else if (Number(existingQuestion.rows[0].score) !== Number(question.score) || Number(existingQuestion.rows[0].position) !== question.position) {
      throw new Error(`考试 ${bank.examId} 的题目顺序或分值不一致，拒绝覆盖`);
    }
  }
  return { total, pass, status };
}

async function ensureAssignment(client, unionId, userName, exams) {
  const identity = await client.query("SELECT user_id FROM user_identities WHERE provider = 'dingtalk' AND union_id = $1", [unionId]);
  let userId = identity.rows[0]?.user_id;
  if (!userId) {
    userId = `user-dingtalk-${stableHash(unionId)}`;
    await client.query("INSERT INTO users (id, name, status) VALUES ($1, $2, 'active') ON CONFLICT (id) DO NOTHING", [userId, userName]);
    await client.query(`INSERT INTO user_identities (id, user_id, provider, provider_subject, union_id)
      VALUES ($1, $2, 'dingtalk', $3, $3) ON CONFLICT (provider, provider_subject) DO NOTHING`, [`identity-dingtalk-${stableHash(unionId)}`, userId, unionId]);
  }
  await ensureAssignmentsForUserIds(client, [userId], exams);
  return userId;
}

async function ensureAssignmentsForUserIds(client, userIds, exams) {
  for (const userId of userIds) {
    for (const exam of exams) {
      await client.query(`INSERT INTO exam_assignments (id, exam_id, subject_type, subject_id)
        VALUES ($1, $2, 'user', $3) ON CONFLICT (exam_id, subject_type, subject_id) DO NOTHING`,
      [`assignment-${exam.examId}-${stableHash(userId)}`, exam.examId, userId]);
    }
  }
}

async function ensureAssignmentsForActiveDingtalkUsers(client, exams) {
  const result = await client.query(`
    SELECT DISTINCT u.id
    FROM users u
    JOIN user_identities ui ON ui.user_id = u.id
    WHERE u.status = 'active'
      AND ui.provider = 'dingtalk'
    ORDER BY u.id;`);
  const userIds = result.rows.map((row) => row.id);
  if (!userIds.length) {
    throw new Error("没有找到已登录且状态为 active 的钉钉用户，未写入考试授权");
  }
  await ensureAssignmentsForUserIds(client, userIds, exams);
  for (const exam of exams) {
    await client.query(`INSERT INTO exam_assignments (id, exam_id, subject_type, subject_id)
      VALUES ($1, $2, 'group', 'all-active-dingtalk-users')
      ON CONFLICT (exam_id, subject_type, subject_id) DO NOTHING`,
    [`global_assignment_${stableHash(exam.examId)}`, exam.examId]);
  }
  return userIds;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.log("用法：node scripts/import-question-banks.js (--union-id <钉钉unionId> | --all-active-dingtalk-users) [--user-name 姓名] [--input-dir 目录] [--only 题库key] [--publish]");
    return;
  }
  loadEnvFile();
  const inputDir = path.resolve(args.inputDir);
  const pool = createPostgresPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const imported = [];
    const selectedBanks = args.only ? BANKS.filter((bank) => bank.key === args.only) : BANKS;
    for (const bank of selectedBanks) {
      const file = path.join(inputDir, bank.file);
      if (!fs.existsSync(file)) throw new Error(`缺少题库文件：${file}`);
      const preview = previewQuestionCsv(fs.readFileSync(file, "utf8"), { allowedResourceIds: Object.keys(loadQuestionResourceManifest()) });
      if (!preview.canCommit) throw new Error(`${bank.file} 校验失败：${JSON.stringify(preview.errors)}`);
      const questionRows = await ensureBank(client, bank, preview.questions);
      const exam = await ensureExam(client, bank, questionRows, args.publish);
      imported.push({ ...bank, ...exam, questions: questionRows.length });
    }
    const userIds = args.allActiveDingtalkUsers
      ? await ensureAssignmentsForActiveDingtalkUsers(client, imported)
      : [await ensureAssignment(client, args.unionId, args.userName, imported)];
    await client.query("COMMIT");
    console.log(JSON.stringify({
      assignmentMode: args.allActiveDingtalkUsers ? "all_active_dingtalk_users" : "single_dingtalk_user",
      assignmentCount: userIds.length,
      publish: args.publish,
      exams: imported
    }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || "题库导入失败");
    process.exitCode = 1;
  });
}

module.exports = {
  BANKS,
  ensureExam,
  ensureAssignment,
  ensureAssignmentsForActiveDingtalkUsers,
  ensureAssignmentsForUserIds,
  parseArgs,
  stableHash
};
