const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DINGTALK_DEPARTMENT_URL,
  DINGTALK_TOKEN_URL,
  DINGTALK_USER_URL,
  FEISHU_DEPARTMENT_URL,
  FEISHU_TOKEN_URL,
  FEISHU_USER_URL,
  extractDingtalkDepartments,
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
  const tokenCall = calls.find((call) => call.url === DINGTALK_TOKEN_URL);
  assert.deepEqual(JSON.parse(tokenCall.options.body), { appKey: "id", appSecret: "secret" });
  assert.deepEqual(result.departments, [{ provider: "dingtalk", externalId: "10", name: "运营部", parentExternalId: null }]);
  assert.equal(result.users[0].providerSubject, "userid-1");
  assert.deepEqual(result.users[0].departmentExternalIds, ["10"]);
  assert.equal(calls.some((call) => call.url.startsWith(DINGTALK_USER_URL)), true);
});

test("钉钉部门接口返回 result 对象时也能解析部门列表", () => {
  assert.deepEqual(extractDingtalkDepartments({ result: {
    dept_id_list: [{ dept_id: 10, name: "运营部" }]
  }}), [{ dept_id: 10, name: "运营部" }]);
  assert.deepEqual(extractDingtalkDepartments({ result: {
    department_list: [{ id: 11, name: "门店" }]
  }}), [{ id: 11, name: "门店" }]);
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

test("飞书通讯录兼容 open_department_id 返回字段", async () => {
  const result = await syncFeishuDirectory({ appId: "app", appSecret: "secret" }, async (url) => {
    if (url === FEISHU_TOKEN_URL) return response({ code: 0, data: { tenant_access_token: "token" } });
    const parsed = new URL(url);
    if (parsed.origin + parsed.pathname === FEISHU_DEPARTMENT_URL) {
      return response({ code: 0, data: {
        items: parsed.searchParams.get("parent_department_id") === "0"
          ? [{ open_department_id: "od-dep-1", name: "总部" }]
          : [],
        has_more: false
      } });
    }
    if (parsed.origin + parsed.pathname === FEISHU_USER_URL) {
      return response({ code: 0, data: { items: [{ open_id: "ou-2", name: "王五" }], has_more: false } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  assert.deepEqual(result.departments, [{
    provider: "feishu", externalId: "od-dep-1", name: "总部", parentExternalId: "0"
  }]);
  assert.equal(result.users[0].providerSubject, "ou-2");
  assert.deepEqual(result.users[0].departmentExternalIds, ["od-dep-1"]);
});

test("飞书没有部门结果时仍尝试读取全量人员", async () => {
  let userUrl;
  const result = await syncFeishuDirectory({ appId: "app", appSecret: "secret" }, async (url) => {
    if (url === FEISHU_TOKEN_URL) return response({ code: 0, data: { tenant_access_token: "token" } });
    const parsed = new URL(url);
    if (parsed.origin + parsed.pathname === FEISHU_DEPARTMENT_URL) {
      return response({ code: 0, data: { items: [], has_more: false } });
    }
    if (parsed.origin + parsed.pathname === FEISHU_USER_URL) {
      userUrl = parsed;
      return response({ code: 0, data: { items: [{ open_id: "ou-3", name: "赵六" }], has_more: false } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  assert.equal(userUrl.searchParams.has("department_id"), false);
  assert.equal(result.users[0].name, "赵六");
  assert.deepEqual(result.users[0].departmentExternalIds, []);
});

test("飞书部门和人员均为空时拒绝静默成功", async () => {
  await assert.rejects(
    syncFeishuDirectory({ appId: "app", appSecret: "secret" }, async (url) => {
      if (url === FEISHU_TOKEN_URL) return response({ code: 0, data: { tenant_access_token: "token" } });
      return response({ code: 0, data: { items: [], has_more: false } });
    }),
    (error) => error.statusCode === 502 && /未读取到部门或人员/.test(error.message)
  );
});

test("通讯录凭证缺失或平台拒绝访问时返回可操作错误", async () => {
  await assert.rejects(
    syncDingtalkDirectory({ clientId: "", clientSecret: "" }, async () => response({})),
    (error) => error.statusCode === 503 && /检查登录应用凭证/.test(error.message)
  );
  await assert.rejects(
    syncFeishuDirectory({ appId: "app", appSecret: "secret" }, async () => response({ code: 999, msg: "denied" }, false)),
    (error) => error.statusCode === 502 && /开通通讯录读取权限/.test(error.message)
  );
});
