const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const script = fs.readFileSync(path.join(__dirname, "../public/admin.js"), "utf8");

test("图片上传前同步新题草稿，避免题干和选项文本被重绘清空", () => {
  assert.match(script, /if \(newQuestionDraft\) readNewQuestionDraft\(\);\n  const images = editingQuestionImages\(\);/);
  assert.match(script, /refreshQuestionImageEditor\(\);\n    showQuestionImageMessage\(message\.textContent\);/);
  assert.doesNotMatch(script, /finally \{\n    questionImageUploadBusy = false;\n    if \(newQuestionDraft\) renderNewQuestionEditor\(\); else renderQuestionEditor\(\);/);
});

test("上传任一图片后只刷新媒体区域并恢复保存和其他上传控件", () => {
  assert.match(script, /refreshQuestionOptionMedia\(label\);/);
  assert.match(script, /const saveButton = document\.getElementById\("saveQuestionBtn"\);\n    if \(saveButton\) saveButton\.disabled = false;/);
  assert.match(script, /function refreshQuestionOptionMedia\(label\)/);
  assert.match(script, /function refreshQuestionImageEditor\(\)/);
});
