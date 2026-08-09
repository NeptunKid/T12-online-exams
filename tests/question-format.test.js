const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { formatQuestionText } = require("../public/question-format");

test("三种空白占位符渲染为安全的下划线空白字符", () => {
  const rendered = formatQuestionText("请填写【 】、「\t」和[  ]并避免 <script>");
  assert.equal(rendered.match(/class="blank-placeholder"/g).length, 3);
  assert.match(rendered, /(?:&nbsp;){8}/);
  assert.match(rendered, /&lt;script&gt;/);
});

test("含有非空白文字的括号不会被转换", () => {
  const rendered = formatQuestionText("保留【答案】、「提示」和[A]，仅转换[]");
  assert.match(rendered, /【答案】/);
  assert.match(rendered, /「提示」/);
  assert.match(rendered, /\[A\]/);
  assert.equal(rendered.match(/class="blank-placeholder"/g).length, 1);
});

test("空白占位符使用文字下划线而不是元素边框", () => {
  const css = fs.readFileSync(path.join(__dirname, "../public/styles.css"), "utf8");
  const rule = css.match(/\.blank-placeholder\s*\{([^}]+)\}/)?.[1] || "";
  assert.match(rule, /text-decoration-line:\s*underline/);
  assert.doesNotMatch(rule, /border-bottom/);
});
