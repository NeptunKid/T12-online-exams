const assert = require("node:assert/strict");
const test = require("node:test");
const { CSV_HEADERS, parseCsv, previewQuestionCsv } = require("../src/import/question-csv");

const HEADER = CSV_HEADERS.join(",");

function csvRow(values) {
  return CSV_HEADERS.map((header) => {
    const value = String(values[header] ?? "");
    return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  }).join(",");
}

test("CSV 预览接受四种标准题型且不产生写入副作用", () => {
  const csv = [
    HEADER,
    csvRow({ external_id: "q-1", type: "single", stem: "单选题", option_a: "A选项", option_b: "B选项", answer: "A", score: 2, explanation: "解析", tags: "基础", difficulty: "normal" }),
    csvRow({ external_id: "q-2", type: "multi", stem: "多选题", option_a: "A选项", option_b: "B选项", option_c: "C选项", answer: "A|C", score: 3, difficulty: "hard" }),
    csvRow({ external_id: "q-3", type: "judge", stem: "判断题", option_a: "正确", option_b: "错误", answer: "B", score: 1, difficulty: "easy" }),
    csvRow({ external_id: "q-4", type: "qa", stem: "问答题", score: 5, explanation: "参考答案写在解析", tags: "沟通", difficulty: "hard" })
  ].join("\n");

  const preview = previewQuestionCsv(csv);
  assert.equal(preview.canCommit, true);
  assert.equal(preview.validRows, 4);
  assert.equal(preview.questions[1].answer[1], "C");
  assert.equal(preview.questions[3].answer, null);
});

test("CSV 预览逐行报告题型、分数、选项和重复编号错误", () => {
  const csv = [
    HEADER,
    "q-1,fill,填空题,甲,,乙,,,,A,2,,,,",
    "q-1,single,缺少分数,甲,乙,,,,C,,,,,",
    "q-3,multi,多选题,甲,乙,,,,Z,3,,,,"
  ].join("\n");
  const preview = previewQuestionCsv(csv);
  assert.equal(preview.canCommit, false);
  assert.equal(preview.validRows, 0);
  assert.equal(preview.errors.some((error) => error.row === 2 && error.column === "type"), true);
  assert.equal(preview.errors.some((error) => error.row === 3 && error.column === "external_id"), true);
  assert.equal(preview.errors.some((error) => error.row === 3 && error.column === "score"), true);
  assert.equal(preview.errors.some((error) => error.row === 4 && error.column === "answer"), true);
});

test("CSV 预览支持引号、换行和受控图片地址", () => {
  const csv = [HEADER, csvRow({
    external_id: "q-1", type: "qa", stem: "含有\n换行的题干", score: 4,
    explanation: "参考\n答案", image_urls: "resource:image-1|https://cdn.example.com/image.png"
  })].join("\n");
  const preview = previewQuestionCsv(csv, { allowedImageHosts: ["cdn.example.com"] });
  assert.equal(parseCsv(csv).length, 2);
  assert.equal(preview.canCommit, true);
  assert.equal(preview.questions[0].imageUrls.length, 2);
});

test("CSV 预览拒绝未允许的图片地址和不完整表头", () => {
  const invalidImage = `${HEADER}\nq-1,qa,题干,,,,,,,4,解析,,,,https://untrusted.example.com/image.png`;
  const preview = previewQuestionCsv(invalidImage, { allowedImageHosts: ["cdn.example.com"] });
  assert.equal(preview.errors.some((error) => error.column === "image_urls"), true);

  const missingHeader = previewQuestionCsv("external_id,type\nq-1,single");
  assert.equal(missingHeader.errors.some((error) => error.column === "stem"), true);
});
