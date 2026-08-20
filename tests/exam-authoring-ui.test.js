const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/admin.html"), "utf8");
const script = fs.readFileSync(path.join(root, "public/admin.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");

test("管理员后台提供独立试卷组卷入口和弹窗", () => {
  assert.match(html, /id="manageExamsBtn"/);
  assert.match(html, /id="examAuthoringDialog"/);
  assert.match(html, /id="examAuthoringList"/);
  assert.match(html, /id="examAuthoringEditor"/);
  assert.match(script, /document\.getElementById\("manageExamsBtn"\)\.addEventListener\("click", openExamAuthoring\)/);
  assert.match(html, /\/admin\.js\?v=20260820-1/);
});

test("组卷界面读取试卷列表并开放已发布版本编辑", () => {
  assert.match(script, /api\("\/api\/admin\/exams"\)/);
  assert.match(script, /api\(`\/api\/admin\/exams\/\$\{encodeURIComponent\(examId\)\}\/authoring`\)/);
  assert.match(script, /const editable = exam\.status === "draft" \|\| examRevisionEditing/);
  assert.match(script, /id="startExamRevisionBtn"/);
  assert.match(script, /只有保存实际修改时才会转为草稿/);
  assert.doesNotMatch(script, /api\(`\/api\/admin\/exams\/\$\{encodeURIComponent\(exam\.id\)\}\/revision`/);
  assert.match(script, /id="examSettingsForm"/);
  assert.match(script, /id="saveExamAuthoringBtn"/);
  assert.match(script, /\/authoring`/);
});

test("组卷支持新增、复制、参数修改和统一发布", () => {
  assert.match(html, /id="newExamBtn"/);
  assert.match(script, /id="newExamForm"/);
  assert.match(script, /api\("\/api\/admin\/exams", \{\s*method: "POST"/);
  assert.match(script, /\/\$\{encodeURIComponent\(exam\.id\)\}\/copy`/);
  assert.match(script, /\/\$\{encodeURIComponent\(exam\.id\)\}\/publish`/);
  assert.match(script, /method: "PATCH"/);
  assert.match(script, />发布<\/button>/);
  assert.match(script, /const canPublish = exam\.status === "draft"/);
  assert.match(script, /保存修改后才能发布新版本/);
  assert.doesNotMatch(script, /重新发布/);
  assert.match(script, /durationSeconds: durationMinutes \* 60/);
});

test("题库维护分类只显示题库而不显示试卷", () => {
  assert.match(html, /placeholder="搜索当前题库题目"/);
  assert.match(script, /当前题库 \$\{filtered\.length\} 道题/);
  assert.match(script, /const values = filters\.banks\.map/);
  assert.doesNotMatch(script, /<optgroup label="按试卷">/);
});

test("所有组卷写请求携带乐观锁版本", () => {
  assert.match(script, /method: "PATCH",\s*body: JSON\.stringify\(body\)/);
  assert.match(script, /version: exam\.version/);
  assert.match(script, /\/authoring`/);
  assert.match(script, /applyExamMutationResponse\(data\)/);
});

test("组卷支持全选、稳定排序、题型分组批量分值和单一保存", () => {
  assert.match(script, /id="selectAllExamQuestionsBtn"/);
  assert.match(script, /id="clearExamQuestionsBtn"/);
  assert.match(script, /selected\.forEach\(\(question, position\) => \{ question\.position = position \+ 1; \}\)/);
  assert.match(script, /class="exam-question-type-group/);
  assert.match(script, /class="exam-type-score-input"/);
  assert.match(script, /applyExamTypeScore/);
  assert.match(script, /class="exam-question-score-input"/);
  assert.match(script, /scores = Object\.fromEntries/);
  assert.match(script, /保存全部修改/);
  assert.doesNotMatch(script, /保存分值/);
  assert.doesNotMatch(script, /保存选题/);
});

test("更换题库自动清空选题并在操作前说明影响", () => {
  assert.match(script, /更换题库会自动清空当前试卷的全部选题和分值。历史答卷不受影响，确认继续吗？/);
  assert.match(script, /题库已更换，原有选题和分值已自动清空。/);
  assert.doesNotMatch(script, /更换题库前，请先清空并保存当前试卷的选题/);
});

test("组卷弹窗具备桌面双栏和手机单栏布局", () => {
  assert.match(css, /\.exam-authoring-layout \{[\s\S]*grid-template-columns: minmax\(240px, 0\.65fr\) minmax\(0, 1\.8fr\)/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*\.exam-authoring-layout \{\s*grid-template-columns: 1fr/);
  assert.match(css, /\.exam-question-row \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(css, /\.exam-settings-grid \{[\s\S]*grid-template-columns:/);
});
