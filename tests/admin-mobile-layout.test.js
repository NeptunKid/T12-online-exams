const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/admin.html"), "utf8");
const script = fs.readFileSync(path.join(root, "public/admin.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");

test("管理员后台默认只筛选待批阅答卷", () => {
  assert.match(html, /<option value="pending" selected>待批阅<\/option>/);
});

test("管理员统计按钮与状态下拉筛选同步", () => {
  assert.match(html, /data-status-filter="all"[^>]*aria-pressed="false"/);
  assert.match(html, /data-status-filter="pending"[^>]*aria-pressed="true"/);
  assert.match(html, /data-status-filter="graded"[^>]*aria-pressed="false"/);
  assert.match(script, /select\.value = status;\s*renderList\(\);/);
  assert.match(script, /button\.setAttribute\("aria-pressed", String\(button\.dataset\.statusFilter === status\)\)/);
  assert.match(script, /button\.addEventListener\("click", \(\) => setStatusFilter\(button\.dataset\.statusFilter\)\)/);
});

test("统计筛选按钮支持键盘焦点和手机三列布局", () => {
  assert.match(css, /\.stat-filter:focus-visible/);
  assert.match(css, /\.stat-filter\[aria-pressed="true"\]/);
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*\.stats \{\s*gap: 6px;/);
});

test("手机端答卷列表与当前阅卷详情互斥显示", () => {
  assert.match(html, /id="submissionPanel"/);
  assert.match(script, /setAdminWorkspace\("detail"\)/);
  assert.match(script, /返回答卷列表/);
  assert.match(css, /\.admin-layout:not\(\.show-detail\) #detailPanel/);
  assert.match(css, /\.admin-layout\.show-detail #submissionPanel/);
});

test("手机端管理员操作按钮使用固定四列对齐", () => {
  assert.match(html, /class="btn-row admin-actions"/);
  assert.match(css, /\.admin-actions[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
});

test("系统管理员可以预览并人工确认同名跨平台账号", () => {
  assert.match(html, /id="identityMergeList"/);
  assert.match(html, /id="refreshMergeCandidatesBtn"/);
  assert.match(script, /api\("\/api\/admin\/user-merge-candidates"\)/);
  assert.match(script, /api\("\/api\/admin\/user-merges", \{/);
  assert.match(script, /window\.confirm\(/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*\.identity-merge-pair \{[\s\S]*flex-direction: column/);
});
