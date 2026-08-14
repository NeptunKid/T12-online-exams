const assert = require("node:assert/strict");
const test = require("node:test");
const { createAdminQuestionBankHandler } = require("../src/http/admin-question-bank-handler");

const MANAGER = { userId: "admin-1", canManageQuestions: true };

function request(method, body = {}) {
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

function harness({ sameOrigin = true, pool = { id: "pool" }, error = null } = {}) {
  const calls = [];
  const repository = {};
  for (const name of [
    "listManagedQuestionBanks", "createQuestionBank", "updateQuestionBank",
    "copyQuestionBank", "archiveQuestionBank", "restoreQuestionBank", "deleteQuestionBank"
  ]) {
    repository[name] = async (...args) => {
      calls.push({ name, args });
      if (error && name !== "listManagedQuestionBanks") throw error;
      if (name === "listManagedQuestionBanks") return [{ id: "bank-1", status: "active", version: 2 }];
      return { id: args[1] || "bank-new", status: name === "archiveQuestionBank" ? "archived" : name === "deleteQuestionBank" ? "deleted" : "active", version: 3 };
    };
  }
  const handler = createAdminQuestionBankHandler({
    repository,
    getPool: () => pool,
    readBody: async (req) => req.body,
    json(res, status, body) { res.response = { status, body }; },
    isSameOriginJsonRequest: () => sameOrigin
  });
  return { calls, handler };
}

test("题库生命周期路由传递题库、版本和当前管理员", async () => {
  const cases = [
    ["POST", "/api/admin/question-banks", "createQuestionBank", { name: "新题库" }, 201],
    ["PATCH", "/api/admin/question-banks/bank%2F1", "updateQuestionBank", { version: 2, name: "新名称" }, 200],
    ["POST", "/api/admin/question-banks/bank%2F1/copy", "copyQuestionBank", { version: 2 }, 200],
    ["POST", "/api/admin/question-banks/bank%2F1/archive", "archiveQuestionBank", { version: 2 }, 200],
    ["POST", "/api/admin/question-banks/bank%2F1/restore", "restoreQuestionBank", { version: 2 }, 200],
    ["DELETE", "/api/admin/question-banks/bank%2F1", "deleteQuestionBank", { version: 4 }, 200]
  ];
  for (const [method, pathname, name, body, status] of cases) {
    const current = harness();
    const res = {};
    assert.equal(await current.handler(request(method, body), res, pathname, MANAGER), true);
    assert.equal(res.response.status, status);
    const call = current.calls.find((item) => item.name === name);
    const expectedId = name === "createQuestionBank" ? [] : ["bank/1"];
    assert.deepEqual(call.args, [{ id: "pool" }, ...expectedId, body, "admin-1"]);
  }
});

test("题库管理列表包含 active 和 archived 状态", async () => {
  const current = harness();
  const res = {};
  assert.equal(await current.handler(request("GET"), res, "/api/admin/question-banks", MANAGER), true);
  assert.deepEqual(res.response, {
    status: 200,
    body: { banks: [{ id: "bank-1", status: "active", version: 2 }] }
  });
});

test("题库写操作要求管理权限、数据库和同源 JSON", async () => {
  const forbidden = harness();
  const forbiddenRes = {};
  await forbidden.handler(request("POST", { name: "x" }), forbiddenRes, "/api/admin/question-banks", {
    userId: "grader-1", canManageQuestions: false
  });
  assert.equal(forbiddenRes.response.status, 403);
  assert.equal(forbidden.calls.length, 0);

  const unavailable = harness({ pool: null });
  const unavailableRes = {};
  await unavailable.handler(request("POST", { name: "x" }), unavailableRes, "/api/admin/question-banks", MANAGER);
  assert.equal(unavailableRes.response.status, 503);

  const crossOrigin = harness({ sameOrigin: false });
  const crossOriginRes = {};
  await crossOrigin.handler(request("POST", { name: "x" }), crossOriginRes, "/api/admin/question-banks", MANAGER);
  assert.equal(crossOriginRes.response.status, 403);
  assert.equal(crossOrigin.calls.length, 0);
});

test("题库版本冲突保留 repository 的 409 状态", async () => {
  const error = Object.assign(new Error("题库已被其他管理员修改，请刷新后重试"), { statusCode: 409 });
  const current = harness({ error });
  const res = {};
  await current.handler(request("PATCH", { version: 1 }), res, "/api/admin/question-banks/bank-1", MANAGER);
  assert.deepEqual(res.response, { status: 409, body: { error: error.message } });
});

test("未命中题库路由时不写响应", async () => {
  const current = harness();
  assert.equal(await current.handler(request("GET"), {}, "/api/admin/questions", MANAGER), false);
});
