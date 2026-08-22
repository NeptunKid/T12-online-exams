const assert = require("node:assert/strict");
const test = require("node:test");
const { createAdminOrganizationHandler } = require("../src/http/admin-organization-handler");

const QUESTION_MANAGER = { userId: "manager-1", canManageQuestions: true, canManageAdmins: false };
const SYSTEM_ADMIN = { userId: "admin-1", canManageQuestions: true, canManageAdmins: true };

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

function createHarness({ sameOrigin = true, syncProviders = { dingtalk: async () => ({ provider: "dingtalk" }) } } = {}) {
  const responses = [];
  const calls = [];
  const pool = { id: "pool" };
  const handler = createAdminOrganizationHandler({
    listOrganizationDirectory: async (receivedPool) => {
      calls.push(["list", receivedPool]);
      return { departments: [{ id: "department-1", name: "运营部" }], users: [{ id: "user-1", name: "张三" }] };
    },
    syncOrganizationDirectory: async (...args) => {
      calls.push(["syncRepository", ...args]);
      return { provider: "dingtalk", departmentCount: 1, userCount: 1 };
    },
    syncProviders,
    getPool: () => pool,
    readBody: async (req) => req.body,
    json: (_res, status, body) => responses.push({ status, body }),
    isSameOriginJsonRequest: () => sameOrigin
  });
  return { handler, responses, calls };
}

test("组织目录 GET 返回已同步部门和人员", async () => {
  const harness = createHarness();
  const res = {};
  assert.equal(await harness.handler(request("GET"), res, "/api/admin/organization/directory", QUESTION_MANAGER), true);
  assert.deepEqual(harness.responses[0], {
    status: 200,
    body: { directory: { departments: [{ id: "department-1", name: "运营部" }], users: [{ id: "user-1", name: "张三" }] } }
  });
  assert.equal(harness.calls[0][0], "list");
});

test("只有系统管理员可以执行组织目录同步", async () => {
  const harness = createHarness();
  assert.equal(await harness.handler(request("POST", { provider: "dingtalk" }), {}, "/api/admin/organization/sync", QUESTION_MANAGER), true);
  assert.deepEqual(harness.responses[0], { status: 403, body: { error: "只有系统管理员可以同步组织目录" } });
  assert.equal(harness.calls.length, 0);
});

test("未配置的通讯录来源返回 400", async () => {
  const harness = createHarness({ syncProviders: {} });
  assert.equal(await harness.handler(request("POST", { provider: "feishu" }), {}, "/api/admin/organization/sync", SYSTEM_ADMIN), true);
  assert.deepEqual(harness.responses[0], { status: 400, body: { error: "组织目录来源未配置" } });
});

test("系统管理员同步成功后返回统计和最新目录", async () => {
  const harness = createHarness();
  assert.equal(await harness.handler(request("POST", { provider: "dingtalk" }), {}, "/api/admin/organization/sync", SYSTEM_ADMIN), true);
  assert.equal(harness.responses[0].status, 200);
  assert.deepEqual(harness.responses[0].body.result, { provider: "dingtalk", departmentCount: 1, userCount: 1 });
  assert.equal(harness.calls.filter((call) => call[0] === "list").length, 1);
  assert.equal(harness.calls.some((call) => call[0] === "syncRepository"), true);
});

test("组织目录同步拒绝跨站请求", async () => {
  const harness = createHarness({ sameOrigin: false });
  assert.equal(await harness.handler(request("POST", { provider: "dingtalk" }), {}, "/api/admin/organization/sync", SYSTEM_ADMIN), true);
  assert.deepEqual(harness.responses[0], { status: 403, body: { error: "组织目录同步请求来源无效" } });
  assert.equal(harness.calls.length, 0);
});
