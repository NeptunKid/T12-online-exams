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
