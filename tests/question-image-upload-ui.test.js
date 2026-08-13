const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const script = fs.readFileSync(path.join(root, "public/admin.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");

test("新建和编辑题目共用图片附件编辑器", () => {
  assert.match(script, /questionImageEditor\(draft\.images\)/);
  assert.match(script, /questionImageEditor\(images\)/);
  assert.match(script, /accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(script, /remove-question-image-btn/);
});

test("图片上传使用同源 JSON 资源接口并在保存题目时提交 URL", () => {
  assert.match(script, /api\("\/api\/admin\/question-resources"/);
  assert.match(script, /JSON\.stringify\(\{ mimeType: file\.type, dataUrl \}\)/);
  assert.match(script, /images: questionImageDraft \|\| question\.images \|\| \[\]/);
  assert.match(script, /newQuestionDraft\.images = images/);
});

test("图片上传前保留新题草稿，且只刷新媒体区域", () => {
  assert.match(script, /if \(newQuestionDraft\) readNewQuestionDraft\(\);\n  questionImageUploadBusy = true;/);
  assert.match(script, /finally \{\n    questionImageUploadBusy = false;\n    refreshQuestionImageEditor\(\);/);
  assert.match(script, /function refreshQuestionImageEditor\(\)/);
  assert.match(script, /if \(newQuestionDraft\) readNewQuestionDraft\(\);\n  const images = editingQuestionImages\(\);/);
});

test("前端限制最多五张且单张不超过 5MB", () => {
  assert.match(script, /images\.length \+ files\.length > 5/);
  assert.match(script, /file\.size > 5 \* 1024 \* 1024/);
  assert.match(styles, /\.question-image-grid \{[\s\S]*grid-template-columns: repeat\(auto-fill/);
  assert.match(styles, /\.question-image-item \{[\s\S]*aspect-ratio: 4 \/ 3/);
});
