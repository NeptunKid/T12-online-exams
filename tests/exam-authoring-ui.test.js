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
});

test("组卷界面读取试卷列表并开放已发布版本编辑", () => {
  assert.match(script, /api\("\/api\/admin\/exams"\)/);
  assert.match(script, /api\(`\/api\/admin\/exams\/\$\{encodeURIComponent\(examId\)\}\/authoring`\)/);
  assert.match(script, /const editable = exam\.status === "draft" \|\| examRevisionEditing/);
  assert.match(script, /id="startExamRevisionBtn"/);
  assert.match(script, /只有保存实际修改时才会转为草稿/);
  assert.doesNotMatch(script, /api\(`\/api\/admin\/exams\/\$\{encodeURIComponent\(exam\.id\)\}\/revision`/);
  assert.match(script, /id="examSettingsForm"/);
  assert.match(script, /版本号已更新/);
});

test("组卷支持新增、复制、参数修改和重新发布", () => {
  assert.match(html, /id="newExamBtn"/);
  assert.match(script, /id="newExamForm"/);
  assert.match(script, /api\("\/api\/admin\/exams", \{\s*method: "POST"/);
  assert.match(script, /\/\$\{encodeURIComponent\(exam\.id\)\}\/copy`/);
  assert.match(script, /\/\$\{encodeURIComponent\(exam\.id\)\}\/publish`/);
  assert.match(script, /method: "PATCH"/);
  assert.match(script, /"重新发布"/);
  assert.match(script, /durationSeconds: durationMinutes \* 60/);
});

test("题库维护分类只显示题库而不显示试卷", () => {
  assert.match(html, /placeholder="搜索当前题库题目"/);
  assert.match(script, /当前题库 \$\{filtered\.length\} 道题/);
  assert.match(script, /const values = filters\.banks\.map/);
  assert.doesNotMatch(script, /<optgroup label="按试卷">/);
});

test("所有组卷写请求携带乐观锁版本", () => {
  const routes = ["question-bank", "questions", "question-order", "question-scores"];
  for (const route of routes) assert.match(script, new RegExp(`/\\$\\{${route === "questions" ? "encodeURIComponent\\(exam\\.id\\)" : "encodeURIComponent\\(exam\\.id\\)"}\\}/${route}`));
  assert.match(script, /questions\/\$\{encodeURIComponent\(questionId\)\}\/score/);
  assert.ok((script.match(/version: exam\.version/g) || []).length >= 5);
  assert.match(script, /applyExamMutationResponse\(data\)/);
});

test("组卷支持全选、稳定排序、单题与批量分值", () => {
  assert.match(script, /id="selectAllExamQuestionsBtn"/);
  assert.match(script, /id="clearExamQuestionsBtn"/);
  assert.match(script, /\{ revision: examRevisionEditing, version: exam\.version, selectAll: true \}/);
  assert.match(script, /selected\.forEach\(\(question, position\) => \{ question\.position = position \+ 1; \}\)/);
  assert.match(script, /id="examBulkScoreInput"/);
  assert.match(script, /class="exam-question-score-input"/);
  assert.match(script, /总分和通过分已按最新分值重新计算/);
});

test("组卷弹窗具备桌面双栏和手机单栏布局", () => {
  assert.match(css, /\.exam-authoring-layout \{[\s\S]*grid-template-columns: minmax\(240px, 0\.65fr\) minmax\(0, 1\.8fr\)/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*\.exam-authoring-layout \{\s*grid-template-columns: 1fr/);
  assert.match(css, /\.exam-question-row \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(css, /\.exam-settings-grid \{[\s\S]*grid-template-columns:/);
});
