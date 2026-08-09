const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const publicDir = path.join(__dirname, "../public");

test("考生首页使用 T12 主标题和学习考核副标题", () => {
  const html = fs.readFileSync(path.join(publicDir, "exam.html"), "utf8");
  assert.match(html, /<title>T12学习考核中心<\/title>/);
  assert.match(html, /<h1>T12学习考核中心<\/h1>/);
  assert.match(html, /<div class="brand-title">T12学习考核中心<\/div>/);
  assert.match(html, /<div class="brand-sub">我的学习与考核<\/div>/);
});

test("管理员页面以 T12 学习考核中心作为主标题", () => {
  const html = fs.readFileSync(path.join(publicDir, "admin.html"), "utf8");
  assert.match(html, /<title>T12学习考核中心 - 管理员阅卷后台<\/title>/);
  assert.match(html, /<h1>T12学习考核中心<\/h1>/);
  assert.match(html, /<div class="brand-title">T12学习考核中心<\/div>/);
  assert.match(html, /<div class="brand-sub">管理员阅卷后台<\/div>/);
});
