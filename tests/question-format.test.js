const assert = require("node:assert/strict");
const test = require("node:test");
const { formatQuestionText } = require("../public/question-format");

test("题目空白占位符渲染为安全的下划线元素", () => {
  const rendered = formatQuestionText("请填写【】并避免 <script>");
  assert.match(rendered, /class="blank-placeholder"/);
  assert.doesNotMatch(rendered, /【】/);
  assert.match(rendered, /&lt;script&gt;/);
});
