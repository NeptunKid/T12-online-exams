const assert = require("node:assert/strict");
const test = require("node:test");
const {
  choiceAnswerText,
  filterQuestionsByExam,
  listQuestionExams,
  parseChoiceAnswer
} = require("../public/question-admin-model");

const questions = [
  { id: "q-1", stem: "消防题", bankName: "消防题库", externalId: "1", exams: [{ id: "exam-fire", title: "消防基础考试", status: "published" }] },
  { id: "q-2", stem: "IT题", bankName: "IT题库", externalId: "2", exams: [{ id: "exam-it", title: "IT基础考试", status: "published" }] },
  { id: "q-3", stem: "共用题", bankName: "通用题库", externalId: "3", exams: [{ id: "exam-fire", title: "消防基础考试", status: "published" }, { id: "exam-it", title: "IT基础考试", status: "published" }] }
];

test("题库先按试卷去重分类再筛选对应题目", () => {
  assert.deepEqual(listQuestionExams(questions).map((exam) => exam.id), ["exam-fire", "exam-it"]);
  assert.deepEqual(filterQuestionsByExam(questions, "exam-fire").map((question) => question.id), ["q-1", "q-3"]);
  assert.deepEqual(filterQuestionsByExam(questions, "exam-it", "共用").map((question) => question.id), ["q-3"]);
});

test("选择题参考答案使用单个文本框格式读写", () => {
  assert.equal(choiceAnswerText("multi", ["A", "C"]), "A|C");
  assert.deepEqual(parseChoiceAnswer("multi", "c | A、C"), ["A", "C"]);
  assert.equal(parseChoiceAnswer("single", " b "), "B");
});
