const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DINGTALK_DEPARTMENT_URL,
  DINGTALK_TOKEN_URL,
  DINGTALK_USER_URL,
  FEISHU_DEPARTMENT_URL,
  FEISHU_TOKEN_URL,
  FEISHU_USER_URL,
  syncDingtalkDirectory,
  syncFeishuDirectory
} = require("../src/integrations/organization-directory");

function response(body, ok = true) {
  return { ok, json: async () => body };
}

test("钉钉通讯录同步返回部门、人员和多部门关系", async () => {
  const calls = [];
  const result = await syncDingtalkDirectory({ clientId: "id", clientSecret: "secret" }, async (url, options) => {
    calls.push({ url, options });
    if (url === DINGTALK_TOKEN_URL) return response({ accessToken: "token" });
    if (url.startsWith(DINGTALK_DEPARTMENT_URL)) {
      const body = JSON.parse(options.body);
      return response(body.dept_id === 1 ? { errcode: 0, result: [{ dept_id: 10, name: "运营部" }] } : { errcode: 0, result: [] });
    }
    if (url.startsWith(DINGTALK_USER_URL)) {
      return response({ errcode: 0, result: {
        list: [{ unionid: "union-1", userid: "userid-1", name: "张三", job_number: "A01", dept_id_list: [10] }],
        has_more: false
      } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  assert.deepEqual(result.departments, [{ provider: "dingtalk", externalId: "10", name: "运营部", parentExternalId: null }]);
  assert.equal(result.users[0].providerSubject, "union-1");
  assert.deepEqual(result.users[0].departmentExternalIds, ["10"]);
  assert.equal(calls.some((call) => call.url.startsWith(DINGTALK_USER_URL)), true);
});

test("飞书通讯录同步分页读取部门和人员", async () => {
  const calls = [];
  const result = await syncFeishuDirectory({ appId: "app", appSecret: "secret" }, async (url, options) => {
    calls.push({ url, options });
    if (url === FEISHU_TOKEN_URL) return response({ code: 0, data: { tenant_access_token: "token" } });
    const parsed = new URL(url);
    if (parsed.origin + parsed.pathname === FEISHU_DEPARTMENT_URL) {
      const parent = parsed.searchParams.get("parent_department_id");
      return response({ code: 0, data: parent === "0"
        ? { items: [{ department_id: "dep-1", name: "门店" }], has_more: false }
        : { items: [], has_more: false } });
    }
    if (parsed.origin + parsed.pathname === FEISHU_USER_URL) {
      return response({ code: 0, data: { items: [{ open_id: "ou-1", union_id: "on-1", name: "李四", employee_no: "F01" }], has_more: false } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  assert.equal(result.departments[0].externalId, "dep-1");
  assert.deepEqual(result.users[0], {
    provider: "feishu", providerSubject: "ou-1", openId: "ou-1", unionId: "on-1",
    name: "李四", employeeNo: "F01", departmentExternalIds: ["dep-1"]
  });
  assert.equal(calls.length >= 3, true);
});
