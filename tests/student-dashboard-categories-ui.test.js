const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/exam.html"), "utf8");
const script = fs.readFileSync(path.join(root, "public/exam.js"), "utf8");

test("学员工作台使用待考核科目并提供已通过区域", () => {
  assert.match(html, /<h1>待考核科目<\/h1>/);
  assert.match(html, /<h2>已通过<\/h2>/);
  assert.match(html, /id="passedExamCatalog"/);
  assert.doesNotMatch(html, /待考核项目/);
});

test("已批阅且通过的考试不会继续显示在待考核科目", () => {
  assert.match(script, /item\.status === "graded" && item\.pass === true/);
  assert.match(script, /const pendingExams = exams\.filter\(\(item\) => !passedExamIds\.has\(item\.id\)\)/);
  assert.match(script, /const passedExams = exams\.filter\(\(item\) => passedExamIds\.has\(item\.id\)\)/);
  assert.match(script, /该科目已通过/);
});
