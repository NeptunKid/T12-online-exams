const assert = require("node:assert/strict");
const test = require("node:test");
const { listExamAssignmentDepartments, listOrganizationDirectory, syncOrganizationDirectory } = require("../src/db/organization-repository");

test("组织目录列表只返回有效部门和有效人员的受控字段", async () => {
  const calls = [];
  const result = await listOrganizationDirectory({
    query: async (sql) => {
      calls.push(sql);
      if (sql.includes("organization_departments")) return { rows: [{ id: "department-1", provider: "dingtalk", external_id: "10", name: "运营部", status: "active" }] };
      return { rows: [{ id: "user-1", name: "张三", employee_no: "A01", department: "运营部", providers: ["dingtalk"] }] };
    }
  });
  assert.deepEqual(result.departments[0], { id: "department-1", provider: "dingtalk", externalId: "10", name: "运营部", parentExternalId: null, status: "active" });
  assert.deepEqual(result.users[0], { id: "user-1", name: "张三", employeeNo: "A01", department: "运营部", providers: ["dingtalk"] });
  assert.equal(calls.length, 2);
});

test("目录同步在同一事务写入部门、用户、身份、成员关系和审计", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("FROM user_identities")) return { rows: [] };
      if (sql.includes("FROM users WHERE employee_no")) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  const result = await syncOrganizationDirectory({ connect: async () => client }, {
    provider: "dingtalk",
    departments: [{ externalId: "10", name: "运营部" }],
    users: [{ provider: "dingtalk", providerSubject: "union-1", unionId: "union-1", name: "张三", employeeNo: "A01", departmentExternalIds: ["10"] }]
  }, "admin-1");
  assert.deepEqual(result, { provider: "dingtalk", departmentCount: 1, userCount: 1 });
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.some((call) => call.sql.includes("organization_departments")), true);
  assert.equal(calls.some((call) => call.sql.includes("user_departments")), true);
  assert.equal(calls.some((call) => call.sql.includes("sync_organization_directory")), true);
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("考试授权部门目录按名称和来源稳定排序", async () => {
  const result = await listExamAssignmentDepartments({ query: async () => ({ rows: [
    { id: "d-1", provider: "feishu", external_id: "2", name: "门店", status: "active" }
  ] }) });
  assert.equal(result[0].provider, "feishu");
  assert.equal(result[0].externalId, "2");
});
