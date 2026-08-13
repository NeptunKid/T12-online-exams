const assert = require("node:assert/strict");
const test = require("node:test");
const { fillAnswerMatches, normalizeFillRule } = require("../src/answer-rules");
const {
  fillRuleText,
  judgeAnswerText,
  normalizeFillRule: normalizeAdminFillRule,
  parseChoiceAnswer,
  parseFillAnswer,
  parseFillRuleText,
  parseJudgeAnswer
} = require("../public/question-admin-model");

test("填空答案规则兼容历史单空别名数组", () => {
  assert.deepEqual(normalizeFillRule([" 浓缩咖啡 ", "espresso", "ESPRESSO"]), {
    ordered: true,
    blanks: [["浓缩咖啡", "espresso"]]
  });
  assert.equal(fillAnswerMatches(" Espresso ", ["浓缩咖啡", "espresso"]), true);
  assert.equal(fillAnswerMatches(["espresso"], ["浓缩咖啡", "espresso"]), true);
  assert.equal(fillAnswerMatches(["浓缩咖啡", "espresso"], ["浓缩咖啡", "espresso"]), false);
});

test("结构化填空规则按默认顺序逐空匹配", () => {
  const rule = { ordered: true, blanks: [["北京", "北京市"], ["中国", "中华人民共和国"]] };
  assert.equal(fillAnswerMatches(["北京市", "中国"], rule), true);
  assert.equal(fillAnswerMatches(["中国", "北京市"], rule), false);
  assert.equal(fillAnswerMatches(["北京市"], rule), false);
});

test("结构化填空规则关闭顺序后进行一对一匹配", () => {
  const rule = { ordered: false, blanks: [["甲", "通用"], ["乙", "通用"]] };
  assert.equal(fillAnswerMatches(["乙", "通用"], rule), true);
  assert.equal(fillAnswerMatches(["通用", "通用"], rule), true);
  assert.equal(fillAnswerMatches(["通用", "丙"], rule), false);
});

test("无效或空的填空规则不会匹配答案", () => {
  assert.equal(fillAnswerMatches("答案", { ordered: true, blanks: [] }), false);
  assert.equal(fillAnswerMatches([""], { ordered: true, blanks: [["答案"]] }), false);
  assert.deepEqual(normalizeFillRule({ ordered: false, blanks: [["A", "a"]] }), {
    ordered: false,
    blanks: [["a"]]
  });
});

test("管理端选择、判断和填空答案 helper 使用稳定导出", () => {
  assert.deepEqual(parseChoiceAnswer("multi", "c | A、C"), ["A", "C"]);
  assert.equal(parseChoiceAnswer("single", " b "), "B");
  assert.equal(parseJudgeAnswer("正确"), "A");
  assert.equal(parseJudgeAnswer("错误"), "B");
  assert.equal(judgeAnswerText("A"), "正确");
  assert.deepEqual(parseFillRuleText("北京|北京市\n中国|中华人民共和国"), {
    ordered: true,
    blanks: [["北京", "北京市"], ["中国", "中华人民共和国"]]
  });
  assert.deepEqual(parseFillAnswer("答案", false), {
    ordered: false,
    blanks: [["答案"]]
  });
  assert.equal(fillRuleText({ ordered: false, blanks: [["北京", "北京市"], ["中国"]] }), "北京|北京市\n中国");
  assert.deepEqual(normalizeAdminFillRule(["答案", "别名"]), {
    ordered: true,
    blanks: [["答案", "别名"]]
  });
});
