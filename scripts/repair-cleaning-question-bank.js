#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createPostgresPool } = require("../src/db/postgres-client");
const { loadQuestionResourceManifest } = require("../src/resources/question-resources");
const { buildCleaningPatch, validateCleaningRows } = require("../src/import/cleaning-question-repair");
const { loadEnvFile } = require("./migrate");

const ROOT = path.join(__dirname, "..");
const DEFAULT_SOURCE = path.join(ROOT, "docs/question-bank-drafts/cleaning-question-repair.json");

function parseArgs(argv) {
  const args = { apply: false, source: DEFAULT_SOURCE };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--apply") args.apply = true;
    else if (argv[index] === "--source") args.source = argv[++index] || args.source;
    else if (argv[index] === "--help") return null;
    else throw new Error(`不支持的参数：${argv[index]}`);
  }
  return args;
}

function readSource(file) {
  const source = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  if (!source?.title || !Array.isArray(source.questions) || source.questions.length !== 36) {
    throw new Error("清洁卫生修复源数据无效");
  }
  return source;
}

async function loadRows(client, title, lock = false) {
  const result = await client.query(`
    SELECT e.id AS exam_id, q.id, q.external_id, q.stem, q.options_json, q.images_json,
      q.answer_json, q.explanation, q.version
    FROM exams e
    JOIN exam_questions eq ON eq.exam_id = e.id
    JOIN questions q ON q.id = eq.question_id
    WHERE e.title = $1
    ORDER BY eq.position${lock ? " FOR UPDATE OF e, q" : ""};`, [title]);
  return result.rows;
}

async function repair(client, source, resources, apply) {
  if (apply) await client.query("BEGIN");
  try {
    const rows = await loadRows(client, source.title, apply);
    validateCleaningRows(rows, source);
    const sourceById = new Map(source.questions.map((question) => [String(question.legacyExternalId), question]));
    const changes = rows.map((row) => ({ row, patch: buildCleaningPatch({
      stem: row.stem,
      optionsJson: row.options_json,
      imagesJson: row.images_json,
      answerJson: row.answer_json,
      explanation: row.explanation
    }, sourceById.get(String(row.external_id)), resources) })).filter((item) => Object.keys(item.patch).length);

    if (!apply) return { mode: "dry-run", examId: rows[0]?.exam_id || "", changedQuestions: changes.map(({ row, patch }) => ({ id: row.id, externalId: row.external_id, fields: Object.keys(patch) })) };

    for (const { row, patch } of changes) {
      const after = {
        stem: patch.stem ?? row.stem,
        optionsJson: patch.optionsJson ?? row.options_json,
        imagesJson: patch.imagesJson ?? row.images_json,
        answerJson: patch.answerJson ?? row.answer_json,
        explanation: patch.explanation ?? row.explanation
      };
      await client.query(`
        UPDATE questions
        SET stem = $2,
            options_json = $3::jsonb,
            images_json = $4::jsonb,
            answer_json = $5::jsonb,
            explanation = $6,
            version = version + 1
        WHERE id = $1;`, [row.id, after.stem, JSON.stringify(after.optionsJson), JSON.stringify(after.imagesJson), JSON.stringify(after.answerJson), after.explanation]);
      await client.query(`
        INSERT INTO audit_logs (id, action, resource_type, resource_id, before_json, after_json)
        VALUES ($1, 'repair_cleaning_question_missing_fields', 'question', $2, $3::jsonb, $4::jsonb);`,
      [crypto.randomUUID(), row.id, JSON.stringify({ stem: row.stem, optionsJson: row.options_json, imagesJson: row.images_json, answerJson: row.answer_json, explanation: row.explanation }), JSON.stringify({ ...after, patchedFields: Object.keys(patch) })]);
    }
    if (changes.length) await client.query("UPDATE exams SET version = version + 1 WHERE id = $1", [rows[0].exam_id]);
    await client.query("COMMIT");
    return { mode: "apply", examId: rows[0]?.exam_id || "", changedQuestions: changes.map(({ row, patch }) => ({ id: row.id, externalId: row.external_id, fields: Object.keys(patch) })) };
  } catch (error) {
    if (apply) await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.log("用法：node scripts/repair-cleaning-question-bank.js [--source <json>] [--apply]");
    return;
  }
  loadEnvFile();
  const pool = createPostgresPool();
  const client = await pool.connect();
  try {
    console.log(JSON.stringify(await repair(client, readSource(args.source), loadQuestionResourceManifest(), args.apply), null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || "清洁卫生题库修复失败");
    process.exitCode = 1;
  });
}

module.exports = { loadRows, parseArgs, readSource, repair };
