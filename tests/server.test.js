const assert = require("node:assert/strict");
const test = require("node:test");
const {
  examData,
  sameAnswer,
  gradeObjective,
  reviewObjectiveScores,
  validReturnTo,
  getAttemptInfo,
  roleForUnionId,
  healthStatus
} = require("../server");

test("答案比较不受多选顺序影响", () => {
  assert.equal(sameAnswer(["B", "A"], ["A", "B"]), true);
  assert.equal(sameAnswer(["A"], ["A", "B"]), false);
});

test("客观题评分覆盖正确、漏选半分和错选零分", () => {
  const multi = examData.questions.find((question) => question.type === "multi" && question.answer.length > 1);
  assert.ok(multi, "题库应包含至少一道多选题");
  const partial = { [multi.id]: [multi.answer[0]] };
  const partialResult = gradeObjective(partial);
  assert.equal(partialResult.objectiveDetail[multi.id].earned, multi.score / 2);

  const wrong = { [multi.id]: [...multi.answer, "INVALID"] };
  const wrongResult = gradeObjective(wrong);
  assert.equal(wrongResult.objectiveDetail[multi.id].earned, 0);

  const allCorrect = Object.fromEntries(
    examData.questions.filter((question) => question.type !== "qa").map((question) => [question.id, question.answer])
  );
  const correctResult = gradeObjective(allCorrect);
  const maxObjective = examData.questions
    .filter((question) => question.type !== "qa")
    .reduce((sum, question) => sum + question.score, 0);
  assert.equal(correctResult.objectiveScore, maxObjective);
});

test("阅卷改分被限制在题目分值范围内", () => {
  const graded = gradeObjective({});
  const item = { answers: {}, objectiveDetail: graded.objectiveDetail };
  const firstObjective = examData.questions.find((question) => question.type !== "qa");
  const result = reviewObjectiveScores(item, { [firstObjective.id]: firstObjective.score + 100 });
  assert.equal(result.objectiveDetail[firstObjective.id].earned, firstObjective.score);
});

test("回跳地址只允许站内路径", () => {
  assert.equal(validReturnTo("/admin"), "/admin");
  assert.equal(validReturnTo("//evil.example"), "/");
  assert.equal(validReturnTo("https://evil.example"), "/");
});

test("阅卷角色和普通考生角色分离", () => {
  const graders = new Set(["grader-1"]);
  assert.equal(roleForUnionId("grader-1", graders), "grader");
  assert.equal(roleForUnionId("student-1", graders), "student");
});

test("健康检查不暴露配置或凭证", () => {
  assert.deepEqual(healthStatus(), { status: "ok", service: "t12-online-exams" });
});

test("补考状态兼容旧答卷", () => {
  const user = { unionId: "legacy-user" };
  const examTitle = examData.title;
  const empty = { submissions: [] };
  assert.equal(getAttemptInfo(empty, user).available, true);

  const pending = { submissions: [{ dingtalkUnionId: user.unionId, examTitle, status: "pending" }] };
  assert.equal(getAttemptInfo(pending, user).available, false);

  const graded = { submissions: [{ dingtalkUnionId: user.unionId, examTitle, status: "graded" }] };
  assert.equal(getAttemptInfo(graded, user).attemptNo, 2);
  assert.equal(getAttemptInfo(graded, user).available, true);
});
