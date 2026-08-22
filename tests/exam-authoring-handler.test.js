const assert = require("node:assert/strict");
const test = require("node:test");
const { createAdminExamAuthoringHandler } = require("../src/http/admin-exam-authoring-handler");

const MANAGER_ACCESS = {
  userId: "admin-1",
  canManageQuestions: true
};

function createHarness({ pool = { name: "pool" }, sameOrigin = true, overrides = {} } = {}) {
  const calls = [];
  const responses = [];
  const repositoryNames = [
    "listAuthoringExams",
    "listExamAssignments",
    "addExamAssignment",
    "removeExamAssignment",
    "getExamAuthoring",
    "createExam",
    "copyExam",
    "reopenExamRevision",
    "publishExam",
    "archiveExam",
    "saveExamAuthoring",
    "updateExamSettings",
    "bindExamQuestionBank",
    "setExamQuestions",
    "reorderExamQuestions",
    "updateExamQuestionScore",
    "updateAllExamQuestionScores"
  ];
  const repository = {};
  const dependencies = {
    repository,
    getPool() {
      calls.push({ name: "getPool", args: [] });
      return pool;
    },
    async readBody(req) {
      calls.push({ name: "readBody", args: [req] });
      return req.body || {};
    },
    json(res, status, body) {
      const response = { status, body };
      responses.push(response);
      res.response = response;
    },
    isSameOriginJsonRequest(req) {
      calls.push({ name: "isSameOriginJsonRequest", args: [req] });
      return sameOrigin;
    },
    async listManagedQuestionBanks(receivedPool) {
      calls.push({ name: "listManagedQuestionBanks", args: [receivedPool] });
      return [{ id: "bank-1", name: "测试题库", status: "active" }];
    }
  };
  dependencies.listExamAssignmentUsers = async (receivedPool) => {
    calls.push({ name: "listExamAssignmentUsers", args: [receivedPool] });
    return [{ id: "user-1", name: "测试用户", department: "运营部", employeeNo: "A01" }];
  };

  for (const name of repositoryNames) {
    repository[name] = async (...args) => {
      calls.push({ name, args });
      if (overrides[name]) return overrides[name](...args);
      if (name === "listAuthoringExams") return [{ id: "exam-1", title: "测试试卷" }];
      if (name === "getExamAuthoring") {
        return { id: args[1], title: "测试试卷", version: 3, questions: [] };
      }
      return { id: args[1], title: "测试试卷", version: 4, questions: [] };
    };
  }

  return {
    calls,
    responses,
    handler: createAdminExamAuthoringHandler(dependencies)
  };
}

function request(method, body) {
  return {
    method,
    body,
    headers: {
      host: "exam.example.test",
      origin: "https://exam.example.test",
      "content-type": "application/json"
    }
  };
}

function callFor(harness, name) {
  return harness.calls.find((call) => call.name === name);
}

test("试卷列表和组卷详情返回约定的响应结构并解码路径参数", async () => {
  const listHarness = createHarness();
  const listRes = {};
  assert.equal(await listHarness.handler(
    request("GET"), listRes, "/api/admin/exams", MANAGER_ACCESS
  ), true);
  assert.deepEqual(listRes.response, {
    status: 200,
    body: { exams: [{ id: "exam-1", title: "测试试卷" }] }
  });
  assert.deepEqual(callFor(listHarness, "listAuthoringExams").args, [{ name: "pool" }]);

  const detailHarness = createHarness();
  const detailRes = {};
  assert.equal(await detailHarness.handler(
    request("GET"), detailRes, "/api/admin/exams/exam%2F2026/authoring", MANAGER_ACCESS
  ), true);
  assert.equal(detailRes.response.status, 200);
  assert.deepEqual(detailRes.response.body.authoring, {
    exam: { id: "exam/2026", title: "测试试卷", version: 3 },
    banks: [{ id: "bank-1", name: "测试题库", status: "active" }],
    questions: []
  });
  assert.deepEqual(callFor(detailHarness, "getExamAuthoring").args, [{ name: "pool" }, "exam/2026"]);
});

test("考试授权用户目录只返回受控用户字段", async () => {
  const harness = createHarness();
  const res = {};
  assert.equal(await harness.handler(
    request("GET"), res, "/api/admin/exam-assignment-users", MANAGER_ACCESS
  ), true);
  assert.deepEqual(res.response, {
    status: 200,
    body: { users: [{ id: "user-1", name: "测试用户", department: "运营部", employeeNo: "A01" }] }
  });
});

test("绑定题库路由传递试卷、请求体和当前管理员", async () => {
  const harness = createHarness();
  const req = request("PUT", { version: 2, bankId: "bank-1" });
  const res = {};
  assert.equal(await harness.handler(
    req, res, "/api/admin/exams/exam-1/question-bank", MANAGER_ACCESS
  ), true);
  assert.equal(res.response.status, 200);
  assert.deepEqual(res.response.body, { authoring: {
    exam: { id: "exam-1", title: "测试试卷", version: 4 },
    banks: [{ id: "bank-1", name: "测试题库", status: "active" }],
    questions: []
  } });
  assert.deepEqual(callFor(harness, "bindExamQuestionBank").args, [
    { name: "pool" }, "exam-1", { ...req.body, bankId: "bank-1" }, "admin-1"
  ]);
});

test("考试授权路由支持读取、添加和移除用户授权", async () => {
  const detailHarness = createHarness({ overrides: {
    listExamAssignments: async () => [{ id: "assignment-1", subjectType: "user", subjectId: "user-1" }]
  }});
  const detailRes = {};
  await detailHarness.handler(request("GET"), detailRes, "/api/admin/exams/exam-1/authoring", MANAGER_ACCESS);
  assert.deepEqual(detailRes.response.body.authoring.assignments, [
    { id: "assignment-1", subjectType: "user", subjectId: "user-1" }
  ]);

  const addHarness = createHarness();
  const addBody = { version: 3, revision: true, subjectType: "user", subjectId: "user-2" };
  const addRes = {};
  await addHarness.handler(request("POST", addBody), addRes, "/api/admin/exams/exam-1/assignments", MANAGER_ACCESS);
  assert.equal(addRes.response.status, 200);
  assert.deepEqual(callFor(addHarness, "addExamAssignment").args, [
    { name: "pool" }, "exam-1", addBody, "admin-1"
  ]);

  const removeHarness = createHarness();
  const removeBody = { version: 4, revision: true };
  const removeRes = {};
  await removeHarness.handler(request("DELETE", removeBody), removeRes, "/api/admin/exams/exam-1/assignments/assignment%2F1", MANAGER_ACCESS);
  assert.equal(removeRes.response.status, 200);
  assert.deepEqual(callFor(removeHarness, "removeExamAssignment").args, [
    { name: "pool" }, "exam-1", "assignment/1", removeBody, "admin-1"
  ]);
});

test("选择部分题目或全选都透传给同一组卷操作", async () => {
  for (const body of [
    { version: 3, questionIds: ["q-2", "q-1"] },
    { version: 3, selectAll: true }
  ]) {
    const harness = createHarness();
    const res = {};
    assert.equal(await harness.handler(
      request("PUT", body), res, "/api/admin/exams/exam-1/questions", MANAGER_ACCESS
    ), true);
    assert.equal(res.response.status, 200);
    assert.deepEqual(callFor(harness, "setExamQuestions").args, [
      { name: "pool" }, "exam-1", body, "admin-1"
    ]);
  }
});

test("整体组卷保存路由一次透传参数、选题和分值", async () => {
  const harness = createHarness();
  const body = {
    revision: true,
    version: 7,
    title: "新版试卷",
    durationSeconds: 1800,
    passRate: 0.8,
    questionBankId: "bank-1",
    questionIds: ["q-2", "q-1"],
    scores: { "q-2": 4, "q-1": 2 }
  };
  const res = {};
  assert.equal(await harness.handler(
    request("PATCH", body), res, "/api/admin/exams/exam-1/authoring", MANAGER_ACCESS
  ), true);
  assert.equal(res.response.status, 200);
  assert.deepEqual(callFor(harness, "saveExamAuthoring").args, [
    { name: "pool" }, "exam-1", body, "admin-1"
  ]);
});

test("题目排序路由保留客户端提交的稳定顺序", async () => {
  const harness = createHarness();
  const body = { version: 4, questionIds: ["q-3", "q-1", "q-2"] };
  const res = {};
  assert.equal(await harness.handler(
    request("PUT", body), res, "/api/admin/exams/exam-1/question-order", MANAGER_ACCESS
  ), true);
  assert.equal(res.response.status, 200);
  assert.deepEqual(callFor(harness, "reorderExamQuestions").args, [
    { name: "pool" }, "exam-1", body, "admin-1"
  ]);
});

test("单题分值路由解码试卷和题目标识并传递版本", async () => {
  const harness = createHarness();
  const body = { version: 5, score: 2.5 };
  const res = {};
  assert.equal(await harness.handler(
    request("PATCH", body),
    res,
    "/api/admin/exams/exam%2F2026/questions/question%2F7/score",
    MANAGER_ACCESS
  ), true);
  assert.equal(res.response.status, 200);
  assert.deepEqual(callFor(harness, "updateExamQuestionScore").args, [
    { name: "pool" }, "exam/2026", "question/7", body, "admin-1"
  ]);
});

test("批量分值路由调用当前试卷的全题分值操作", async () => {
  const harness = createHarness();
  const body = { version: 6, score: 3 };
  const res = {};
  assert.equal(await harness.handler(
    request("PATCH", body), res, "/api/admin/exams/exam-1/question-scores", MANAGER_ACCESS
  ), true);
  assert.equal(res.response.status, 200);
  assert.deepEqual(callFor(harness, "updateAllExamQuestionScores").args, [
    { name: "pool" }, "exam-1", body, "admin-1"
  ]);
});

test("新增、复制、开始修订、参数修改和发布路由使用统一响应结构", async () => {
  const cases = [
    ["POST", "/api/admin/exams", "createExam", { title: "新试卷", durationSeconds: 600, passRate: 0.6 }, []],
    ["POST", "/api/admin/exams/exam-1/copy", "copyExam", { version: 3, title: "副本" }, ["exam-1"]],
    ["POST", "/api/admin/exams/exam-1/revision", "getExamAuthoring", { version: 3 }, ["exam-1"]],
    ["PATCH", "/api/admin/exams/exam-1", "updateExamSettings", { version: 3, title: "新标题", durationSeconds: 900, passRate: 0.8 }, ["exam-1"]],
    ["POST", "/api/admin/exams/exam-1/publish", "publishExam", { version: 3 }, ["exam-1"]],
    ["POST", "/api/admin/exams/exam-1/archive", "archiveExam", { version: 3 }, ["exam-1"]]
  ];
  for (const [method, pathname, repositoryName, body, idArgs] of cases) {
    const harness = createHarness();
    const res = {};
    assert.equal(await harness.handler(request(method, body), res, pathname, MANAGER_ACCESS), true);
    assert.equal(res.response.status, 200, pathname);
    const expectedArgs = repositoryName === "getExamAuthoring"
      ? [{ name: "pool" }, ...idArgs]
      : [{ name: "pool" }, ...idArgs, body, "admin-1"];
    assert.deepEqual(callFor(harness, repositoryName).args, expectedArgs, pathname);
    assert.deepEqual(Object.keys(res.response.body), ["authoring"]);
  }
});

test("组卷路由要求题库管理权限且数据库必须已配置", async () => {
  const forbiddenHarness = createHarness();
  const forbiddenRes = {};
  assert.equal(await forbiddenHarness.handler(
    request("GET"), forbiddenRes, "/api/admin/exams", { userId: "grader-1", canManageQuestions: false }
  ), true);
  assert.equal(forbiddenRes.response.status, 403);
  assert.equal(callFor(forbiddenHarness, "listAuthoringExams"), undefined);

  const unavailableHarness = createHarness({ pool: null });
  const unavailableRes = {};
  assert.equal(await unavailableHarness.handler(
    request("GET"), unavailableRes, "/api/admin/exams", MANAGER_ACCESS
  ), true);
  assert.equal(unavailableRes.response.status, 503);
  assert.equal(callFor(unavailableHarness, "listAuthoringExams"), undefined);
});

test("所有组卷写路由都拒绝非同源 JSON 请求", async () => {
  const writes = [
    ["POST", "/api/admin/exams", "createExam"],
    ["POST", "/api/admin/exams/exam-1/copy", "copyExam"],
    ["POST", "/api/admin/exams/exam-1/revision", "reopenExamRevision"],
    ["PATCH", "/api/admin/exams/exam-1", "updateExamSettings"],
    ["POST", "/api/admin/exams/exam-1/publish", "publishExam"],
    ["POST", "/api/admin/exams/exam-1/archive", "archiveExam"],
    ["PUT", "/api/admin/exams/exam-1/question-bank", "bindExamQuestionBank"],
    ["PUT", "/api/admin/exams/exam-1/questions", "setExamQuestions"],
    ["PUT", "/api/admin/exams/exam-1/question-order", "reorderExamQuestions"],
    ["PATCH", "/api/admin/exams/exam-1/questions/q-1/score", "updateExamQuestionScore"],
    ["PATCH", "/api/admin/exams/exam-1/question-scores", "updateAllExamQuestionScores"]
  ];
  for (const [method, pathname, repositoryName] of writes) {
    const harness = createHarness({ sameOrigin: false });
    const res = {};
    assert.equal(await harness.handler(
      request(method, { version: 1 }), res, pathname, MANAGER_ACCESS
    ), true);
    assert.equal(res.response.status, 403, pathname);
    assert.equal(callFor(harness, repositoryName), undefined, pathname);
    assert.equal(callFor(harness, "readBody"), undefined, pathname);
  }
});

test("版本冲突和非草稿修改保留 repository 的 409 状态", async () => {
  for (const message of [
    "试卷已被其他管理员修改，请刷新后重试",
    "只能修改草稿试卷的题目"
  ]) {
    const harness = createHarness({
      overrides: {
        bindExamQuestionBank() {
          throw Object.assign(new Error(message), { statusCode: 409 });
        }
      }
    });
    const res = {};
    assert.equal(await harness.handler(
      request("PUT", { version: 1, bankId: "bank-1" }),
      res,
      "/api/admin/exams/exam-1/question-bank",
      MANAGER_ACCESS
    ), true);
    assert.deepEqual(res.response, { status: 409, body: { error: message } });
  }
});

test("跨题库或已归档题目被作为业务输入错误返回", async () => {
  const message = "选中的题目包含其他题库或已归档题目";
  const harness = createHarness({
    overrides: {
      setExamQuestions() {
        throw Object.assign(new Error(message), { statusCode: 400 });
      }
    }
  });
  const res = {};
  assert.equal(await harness.handler(
    request("PUT", { version: 2, questionIds: ["foreign-q"] }),
    res,
    "/api/admin/exams/exam-1/questions",
    MANAGER_ACCESS
  ), true);
  assert.deepEqual(res.response, { status: 400, body: { error: message } });
});

test("只有整数 statusCode 会从 repository 原样映射，未知故障返回不泄露细节的 503", async () => {
  const harness = createHarness({
    overrides: {
      updateExamQuestionScore() {
        throw Object.assign(new Error("分值无效"), { statusCode: "422" });
      }
    }
  });
  const res = {};
  await harness.handler(
    request("PATCH", { version: 1, score: -1 }),
    res,
    "/api/admin/exams/exam-1/questions/q-1/score",
    MANAGER_ACCESS
  );
  assert.deepEqual(res.response, { status: 503, body: { error: "试卷组卷服务暂不可用" } });
});

test("未命中组卷路由时返回 false 且不写响应", async () => {
  const harness = createHarness();
  const res = {};
  assert.equal(await harness.handler(
    request("GET"), res, "/api/admin/submissions", MANAGER_ACCESS
  ), false);
  assert.equal(await harness.handler(
    request("POST", { version: 4 }), res, "/api/admin/exams/exam-1/restore", MANAGER_ACCESS
  ), false);
  assert.equal(res.response, undefined);
  assert.deepEqual(harness.calls, []);
});
