const assert = require("node:assert/strict");
const test = require("node:test");
const {
  choiceAnswerText,
  filterQuestions,
  listQuestionFilters,
  parseChoiceAnswer
} = require("../public/question-admin-model");

const questions = [
  { id: "q-1", stem: "消防题", bankName: "消防题库", externalId: "1", exams: [{ id: "exam-fire", title: "消防基础考试", status: "published" }] },
  { id: "q-2", stem: "IT题", bankName: "IT题库", externalId: "2", exams: [{ id: "exam-it", title: "IT基础考试", status: "published" }] },
  { id: "q-3", stem: "共用题", bankName: "通用题库", externalId: "3", exams: [{ id: "exam-fire", title: "消防基础考试", status: "published" }, { id: "exam-it", title: "IT基础考试", status: "published" }] }
];

test("题库维护分类只包含题库且不接受试卷筛选", () => {
  const banks = [
    { id: "bank-fire", name: "消防题库" },
    { id: "bank-unused", name: "待组卷题库" }
  ];
  const withBankIds = questions.map((question, index) => ({
    ...question,
    bankId: index === 1 ? "bank-it" : "bank-fire"
  }));
  const filters = listQuestionFilters(withBankIds, banks);
  assert.deepEqual(filters.banks.map((bank) => bank.value).sort(), ["bank:bank-fire", "bank:bank-unused"]);
  assert.equal(Object.hasOwn(filters, "exams"), false);
  assert.deepEqual(filterQuestions(withBankIds, "exam:exam-fire"), []);
  assert.deepEqual(filterQuestions(withBankIds, "bank:bank-fire").map((question) => question.id), ["q-1", "q-3"]);
});

test("选择题参考答案 helper 兼容勾选值和历史文本", () => {
  assert.equal(choiceAnswerText("multi", ["A", "C"]), "A|C");
  assert.deepEqual(parseChoiceAnswer("multi", "c | A、C"), ["A", "C"]);
  assert.equal(parseChoiceAnswer("single", " b "), "B");
});
