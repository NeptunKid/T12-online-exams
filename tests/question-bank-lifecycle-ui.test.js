const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/admin.html"), "utf8");
const script = fs.readFileSync(path.join(root, "public/admin.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");

test("题库维护弹窗提供启用和可恢复删除题库管理", () => {
  assert.match(html, /id="questionBankManagerTitle"/);
  assert.match(html, /id="newQuestionBankBtn"/);
  assert.match(html, /id="questionBankList"/);
  assert.doesNotMatch(html, /id="questionExamFilter"/);
  assert.match(html, /id="questionBankEditor"/);
  assert.match(script, /bank\?\.status === "archived" \? "已删除（可恢复）" : "启用中"/);
  assert.match(script, /已删除题库不可新增题目/);
});

test("题库支持新建、编辑、复制、可恢复删除和恢复", () => {
  assert.match(script, /api\("\/api\/admin\/question-banks", \{\s*method: "POST"/);
  assert.match(script, /api\(`\/api\/admin\/question-banks\/\$\{encodeURIComponent\(bank\.id\)\}`, \{\s*method: "PATCH"/);
  for (const action of ["copy", "archive", "restore"]) {
    assert.match(script, new RegExp(`question-banks\\/\\$\\{encodeURIComponent\\(bank\\.id\\)\\}\\/${action}`));
  }
  assert.match(script, /window\.confirm\(`确认删除题库/);
  assert.match(script, />删除题库<\/button>/);
});

test("题库变更携带乐观锁版本并在成功后重新读取题目", () => {
  assert.ok((script.match(/JSON\.stringify\(\{ version: bank\.version/g) || []).length >= 4);
  assert.match(script, /await loadQuestions\(\)/);
  assert.match(script, /"Content-Type": "application\/json"/);
  assert.match(script, /adminQuestionBanks\.filter\(\(bank\) => bank\.status !== "archived"\)/);
});

test("题目和备份界面从管理接口读取已归档题库", () => {
  assert.ok((script.match(/api\("\/api\/admin\/question-banks"\)/g) || []).length >= 2);
  assert.match(script, /const \[questionData, bankData\] = await Promise\.all\(\[\s*api\("\/api\/admin\/questions"\),\s*api\("\/api\/admin\/question-banks"\)/);
  assert.match(script, /adminQuestions = questionData\.questions \|\| \[\]/);
  assert.match(script, /adminQuestionBanks = bankData\.banks \|\| \[\]/);
});

test("历史试卷显示当前归档题库但不允许新绑定", () => {
  assert.match(script, /banks\.filter\(\(bank\) => bank\.status !== "archived" \|\| bank\.id === bankId\)/);
  assert.match(script, /bank\.status === "archived" \? "disabled" : ""/);
  assert.match(script, /bank\.status === "archived" \? "·已删除" : ""/);
});

test("题库管理保持无嵌套卡片的双栏与手机单栏布局", () => {
  assert.match(styles, /\.question-bank-manager \{[\s\S]*border-bottom: 1px solid var\(--line\)/);
  assert.match(styles, /\.question-bank-list \{[\s\S]*max-height: 190px/);
  assert.match(styles, /@media \(max-width: 820px\)[\s\S]*\.question-bank-actions,[\s\S]*flex-direction: column/);
  assert.doesNotMatch(html, /question-bank-manager[\s\S]*class="panel/);
});
