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
