const assert = require("node:assert/strict");
const test = require("node:test");
const source = require("../docs/question-bank-drafts/cleaning-question-repair.json");
const resources = require("../public/question-resources/manifest.json").resources;
const { buildCleaningPatch, validateCleaningRows } = require("../src/import/cleaning-question-repair");
const { repair } = require("../scripts/repair-cleaning-question-bank");

test("清洁卫生修复源覆盖 36 道历史题目且保留来源总分", () => {
  assert.equal(source.questions.length, 36);
  assert.equal(new Set(source.questions.map((question) => question.legacyExternalId)).size, 36);
  assert.equal(source.questions.reduce((sum, question) => sum + (question.sourceScore || 0), 0), 101);
});

test("清洁卫生修复只补空字段，并为图片选项补受控资源", () => {
  const sourceQuestion = source.questions.find((question) => question.imageNo === 2);
  const patch = buildCleaningPatch({
    stem: "",
    optionsJson: [],
    imagesJson: [],
    answerJson: [],
    explanation: ""
  }, sourceQuestion, resources);
  assert.equal(patch.stem, sourceQuestion.stem);
  assert.deepEqual(patch.answerJson, ["A", "D"]);
  assert.equal(patch.optionsJson.length, 4);
  assert.equal(patch.optionsJson[0].image, "resource:cleaning-2-a");
});

test("清洁卫生修复不覆盖已有管理员题目内容", () => {
  const sourceQuestion = source.questions[0];
  const patch = buildCleaningPatch({
    stem: "管理员修订题干",
    optionsJson: [{ label: "A", text: "管理员修订选项" }],
    imagesJson: ["resource:existing"],
    answerJson: "A",
    explanation: "管理员修订解析"
  }, sourceQuestion, resources);
  assert.deepEqual(patch, {});
});

test("清洁卫生修复拒绝题目数量或历史标识不一致的考试", () => {
  const rows = source.questions.map((question) => ({ external_id: question.legacyExternalId }));
  assert.doesNotThrow(() => validateCleaningRows(rows, source));
  assert.throws(() => validateCleaningRows(rows.slice(1), source), /题目数不一致/);
  assert.throws(() => validateCleaningRows([{ external_id: "unknown" }, ...rows.slice(1)], source), /历史标识不匹配/);
});

test("清洁卫生修复事务不修改分值或历史答卷", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("FROM exams e")) {
        return { rows: source.questions.map((question) => ({
          exam_id: "exam-cleaning", id: `question-${question.legacyExternalId}`,
          external_id: question.legacyExternalId, stem: "", options_json: [], images_json: [],
          answer_json: null, explanation: "", version: 1
        })) };
      }
      return { rows: [] };
    }
  };
  const result = await repair(client, source, resources, true);
  assert.equal(result.mode, "apply");
  assert.equal(result.changedQuestions.length, 36);
  assert.equal(calls.filter((call) => call.sql.includes("UPDATE questions")).length, 36);
  assert.equal(calls.some((call) => call.sql.includes("submission_questions")), false);
  assert.equal(calls.some((call) => /SET[^;]*score/i.test(call.sql)), false);
  assert.equal(calls.filter((call) => call.sql.includes("repair_cleaning_question_missing_fields")).length, 36);
});
