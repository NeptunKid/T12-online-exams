const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const script = fs.readFileSync(path.join(__dirname, "../public/admin.js"), "utf8");

test("试卷管理提供删除操作并保留历史数据", () => {
  assert.match(script, /id="archiveExamBtn"[\s\S]*>删除试卷<\/button>/);
  assert.match(script, /确认删除试卷/);
  assert.match(script, /不会物理删除试卷、版本和历史答卷/);
  assert.match(script, /\/archive`, \{/);
  assert.match(script, /只能通过备份或数据库回滚/);
  assert.doesNotMatch(script, /id="restoreExamBtn"/);
  assert.doesNotMatch(script, /function restoreExam\(/);
  assert.doesNotMatch(script, /\/api\/admin\/exams\/\$\{encodeURIComponent\(exam\.id\)\}\/restore/);
});

test("已删除试卷从管理员列表隐藏", () => {
  assert.match(script, /adminExams = adminExams\.filter\(\(item\) => item\.id !== exam\.id\)/);
  assert.match(script, /从管理员列表隐藏/);
});
