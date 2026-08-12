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
  healthStatus,
  isSameOriginJsonRequest,
  questionResourceUrl,
  sendQuestionResource,
  publicUser,
  matchesFillAnswer,
  attachLegacyExamImages,
  attachLegacyStudentImages
} = require("../server");

test("清洁卫生入职培训考试时长为 45 分钟", () => {
  assert.equal(examData.duration, 45);
});

test("答案比较不受多选顺序影响", () => {
  assert.equal(sameAnswer(["B", "A"], ["A", "B"]), true);
  assert.equal(sameAnswer(["A"], ["A", "B"]), false);
});

test("填空题答案忽略首尾空格和大小写并支持别名", () => {
  assert.equal(matchesFillAnswer("  Espresso ", ["浓缩咖啡", "espresso"]), true);
  assert.equal(matchesFillAnswer("拿铁", ["浓缩咖啡", "espresso"]), false);
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

test("静态题目图片响应使用文件真实 MIME 而不是错误扩展名", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../server.js"), "utf8");
  assert.match(source, /resolved\.startsWith\(path\.join\(PUBLIC_DIR, "question-resources"\)/);
  assert.match(source, /detectImageMimeType\(data\)/);
  assert.match(source, /detectedImageType \|\| MIME\[extension\]/);
});

test("当前题库与旧版路径指向同一图片时只返回一次", () => {
  const exam = attachLegacyExamImages({
    title: examData.title,
    questions: [{ id: "current-0", sourceId: "0" }],
    images: { "current-0": { stem: [
      "/question-resources/cleaning/cleaning-1-1.png",
      "/question-resources/cleaning/cleaning-1-1.png"
    ], options: {} } }
  });
  assert.deepEqual(exam.images["current-0"].stem, [
    "/question-resources/cleaning/cleaning-1-1.png",
    "images/1-2.jpeg"
  ]);
});

test("考生试卷与管理员阅卷接口共用图片去重层", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../server.js"), "utf8");
  assert.match(source, /attachLegacyExamImages\(await getPublishedExam/);
  assert.match(source, /exam: attachLegacyExamImages\(detail\.exam\)/);
});

test("考生成绩详情保留答卷快照图片并只补充不同的旧图片", () => {
  const current = "/question-resources/cleaning/cleaning-1-1.png";
  const detail = attachLegacyStudentImages({
    submission: { examTitle: examData.title },
    questions: [{
      id: "snapshot-0",
      sourceId: "0",
      images: { stem: [current], options: { A: current } }
    }]
  });
  assert.deepEqual(detail.questions[0].images.stem, [current, "images/1-2.jpeg"]);
  assert.equal(detail.questions[0].images.options.A, current);
});

test("非清洁卫生试卷不会进入旧图片兼容层", () => {
  const otherExam = { title: "其他试卷", questions: [{ id: "q" }], images: {} };
  const otherDetail = { submission: { examTitle: "其他试卷" }, questions: [{ id: "q" }] };
  assert.equal(attachLegacyExamImages(otherExam), otherExam);
  assert.equal(attachLegacyStudentImages(otherDetail), otherDetail);
});

test("旧版兼容图片保留不同内容且不跨选项标签合并", () => {
  const currentA = "/question-resources/cleaning/cleaning-2-a.jpeg";
  const exam = attachLegacyExamImages({
    title: examData.title,
    questions: [{ id: "current-1", sourceId: "1" }],
    images: { "current-1": { stem: [currentA, "images/1-2.jpeg"], options: { A: currentA, E: currentA } } }
  });
  assert.deepEqual(exam.images["current-1"].stem, [currentA, "images/1-2.jpeg"]);
  assert.equal(exam.images["current-1"].options.A, currentA);
  assert.equal(exam.images["current-1"].options.B, "images/2-B.jpeg");
  assert.equal(exam.images["current-1"].options.E, currentA);
});

test("高影响用户归并仅接受同源 JSON 请求", () => {
  assert.equal(isSameOriginJsonRequest({ headers: {
    "content-type": "application/json; charset=utf-8", origin: "https://exam.t12group.com", host: "exam.t12group.com"
  } }), true);
  assert.equal(isSameOriginJsonRequest({ headers: {
    "content-type": "application/json", origin: "https://evil.example", host: "exam.t12group.com"
  } }), false);
  assert.equal(isSameOriginJsonRequest({ headers: { "content-type": "text/plain" } }), false);
});

test("题目上传资源使用站内 URL 和不可嗅探的图片响应", () => {
  assert.equal(
    questionResourceUrl("question_resource_123"),
    "/api/question-resources/question_resource_123"
  );
  const calls = [];
  const res = {
    writeHead(status, headers) { calls.push({ status, headers }); },
    end(content) { calls.push({ content }); }
  };
  const content = Buffer.from([0x89, 0x50]);
  sendQuestionResource({ headers: {} }, res, {
    mimeType: "image/png",
    sizeBytes: content.length,
    sha256: "a".repeat(64),
    content
  });
  assert.equal(calls[0].status, 200);
  assert.equal(calls[0].headers["Content-Type"], "image/png");
  assert.equal(calls[0].headers["X-Content-Type-Options"], "nosniff");
  assert.match(calls[0].headers["Cache-Control"], /private/);
  assert.deepEqual(calls[1].content, content);
});

test("浏览器用户信息不暴露 provider subject", () => {
  assert.deepEqual(publicUser({
    provider: "feishu", providerSubject: "ou_private", unionId: "on_current", name: "飞书员工", roles: ["student"]
  }), {
    provider: "feishu", unionId: "on_current", name: "飞书员工", roles: ["student"]
  });
});

test("补考状态兼容旧答卷", () => {
  const user = { unionId: "legacy-user" };
  const examTitle = examData.title;
  const empty = { submissions: [] };
  assert.equal(getAttemptInfo(empty, user).available, true);
  assert.equal(getAttemptInfo(empty, user).message, "本次为第1次考核，仅有一次补考机会。");

  const pending = { submissions: [{ dingtalkUnionId: user.unionId, examTitle, status: "pending" }] };
  assert.equal(getAttemptInfo(pending, user).available, false);

  const graded = { submissions: [{ dingtalkUnionId: user.unionId, examTitle, status: "graded" }] };
  assert.equal(getAttemptInfo(graded, user).attemptNo, 2);
  assert.equal(getAttemptInfo(graded, user).available, true);
  assert.equal(getAttemptInfo(graded, user).message, "本次为补考。");

  const extra = {
    submissions: [
      { dingtalkUnionId: user.unionId, examTitle, status: "graded" },
      { dingtalkUnionId: user.unionId, examTitle, status: "graded" }
    ],
    retakePermissions: { [`${user.unionId}:${examTitle}`]: { remainingExtraAttempts: 1 } }
  };
  assert.equal(getAttemptInfo(extra, user).message, "本次为第1次额外补考。");
});
