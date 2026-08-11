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

test("考生首页提供独立的钉钉和飞书 OAuth 入口", () => {
  const html = fs.readFileSync(path.join(publicDir, "exam.html"), "utf8");
  assert.match(html, /id="dingtalkLogin" href="\/auth\/dingtalk\/login\?returnTo=\/"/);
  assert.match(html, /id="feishuLogin" href="\/auth\/feishu\/login\?returnTo=\/"/);
});

test("管理员页面以 T12 学习考核中心作为主标题", () => {
  const html = fs.readFileSync(path.join(publicDir, "admin.html"), "utf8");
  assert.match(html, /<title>T12学习考核中心 - 管理员阅卷后台<\/title>/);
  assert.match(html, /<h1>T12学习考核中心<\/h1>/);
  assert.match(html, /<div class="brand-title">T12学习考核中心<\/div>/);
  assert.match(html, /<div class="brand-sub">管理员阅卷后台<\/div>/);
  assert.match(html, /id="dingtalkAdminLogin" href="\/auth\/dingtalk\/login\?returnTo=\/admin"/);
  assert.match(html, /id="feishuAdminLogin" href="\/auth\/feishu\/login\?returnTo=\/admin"/);
});

test("管理员题库提供手动新增题目入口", () => {
  const html = fs.readFileSync(path.join(publicDir, "admin.html"), "utf8");
  const script = fs.readFileSync(path.join(publicDir, "admin.js"), "utf8");
  assert.match(html, /id="newQuestionBtn"/);
  assert.match(html, /<label for="questionExamFilter">分类<\/label>/);
  assert.match(script, /api\("\/api\/admin\/questions", \{/);
  assert.match(script, /保存后进入题库，但不会自动加入任何试卷/);
  assert.doesNotMatch(script, /newQuestionScore|默认分值/);
});
