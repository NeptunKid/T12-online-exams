const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/admin.html"), "utf8");
const script = fs.readFileSync(path.join(root, "public/admin.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");

test("题库侧栏只保留当前题库下拉且题目列表不重复题库名", () => {
  assert.match(script, /id="questionBankSelect"/);
  assert.doesNotMatch(html, /id="questionExamFilter"/);
  assert.doesNotMatch(html, />分类<\/label>/);
  assert.doesNotMatch(script, /\$\{esc\(question\.bankName\)\} · \$\{typeLabel/);
  assert.match(script, /question\.externalId \? `\$\{esc\(question\.externalId\)\} · ` : ""/);
});

test("单选和多选答案直接在选项行勾选", () => {
  assert.match(script, /class="question-option-answer"/);
  assert.match(script, /name="questionAnswerChoice"/);
  assert.match(script, /draft\.type === "multi" \? "checkbox" : "radio"/);
  assert.match(script, /question\.type === "multi" \? "checkbox" : "radio"/);
  assert.match(styles, /\.question-option-answer \{/);
});

test("判断题不渲染选项栏且只显示正确错误答案", () => {
  assert.match(script, /const optionTypes = \["single", "multi"\]\.includes\(draft\.type\)/);
  assert.match(script, /\["single", "multi"\]\.includes\(question\.type\) && question\.options\.length/);
  assert.match(script, /value="A"[^\n]+<span>正确<\/span>/);
  assert.match(script, /value="B"[^\n]+<span>错误<\/span>/);
  assert.match(script, /question\.type === "judge"\s*\? \[\{ label: "A", text: "正确" \}, \{ label: "B", text: "错误" \}\]/);
});
