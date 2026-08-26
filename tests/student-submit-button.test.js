const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const script = fs.readFileSync(path.join(__dirname, "..", "public", "exam.js"), "utf8");

test("考生开始新考试时恢复提交按钮可点击状态", () => {
  assert.match(script, /submitted = false;[\s\S]*const submitButton = document\.getElementById\("submitBtn"\);[\s\S]*submitButton\.disabled = false;/);
});

test("提交失败时恢复提交按钮并允许再次提交", () => {
  assert.match(script, /catch \(err\) \{[\s\S]*submitted = false;[\s\S]*document\.getElementById\("submitBtn"\)\.disabled = false;/);
});

test("考生接口请求有超时和可见的 HTTP 错误提示，避免首页无限载入", () => {
  assert.match(script, /AbortController/);
  assert.match(script, /请求超时，请检查服务状态后重试/);
  assert.match(script, /请求失败（HTTP \$\{response\.status\}）/);
  assert.match(script, /showOnly\("loginPage"\)/);
  assert.match(script, /fetchJson\("\/api\/auth\/config"\)/);
});
