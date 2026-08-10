const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getAdminAccess,
  getIdentityAccess,
  mapAdminUser,
  maskIdentity,
  setAdminRole,
  upsertDingtalkUser,
  upsertFeishuUser
} = require("../src/db/user-repository");

test("管理员用户映射会遮蔽钉钉身份标识", () => {
  assert.equal(maskIdentity("union-1234567890"), "unio...7890");
  const user = mapAdminUser({
    id: "user-1", name: "测试用户", employee_no: null, department: "运营",
    status: "active", union_id: "union-1234567890", roles: ["student", "system_admin"]
  });
  assert.equal(user.identityHint, "unio...7890");
  assert.equal(user.isAdmin, true);
});

test("数据库系统管理员和环境引导账号均可管理管理员", async () => {
  const pool = { query: async () => ({ rows: [{ id: "user-1", roles: ["grader", "system_admin"] }] }) };
  const databaseAccess = await getAdminAccess(pool, "union-1", new Set());
  assert.equal(databaseAccess.canAccess, true);
  assert.equal(databaseAccess.canManageAdmins, true);
  assert.equal(databaseAccess.canManageQuestions, true);

  const bootstrapAccess = await getAdminAccess(null, "bootstrap-1", new Set(["bootstrap-1"]));
  assert.equal(bootstrapAccess.canAccess, true);
  assert.equal(bootstrapAccess.canManageAdmins, true);
  assert.equal(bootstrapAccess.canManageQuestions, true);
});

test("考试管理员可以维护题库但不能管理系统管理员", async () => {
  const pool = { query: async () => ({ rows: [{ id: "user-2", roles: ["exam_admin"] }] }) };
  const access = await getAdminAccess(pool, "union-2", new Set());
  assert.equal(access.canAccess, true);
  assert.equal(access.canManageQuestions, true);
  assert.equal(access.canManageAdmins, false);
});

test("普通阅卷人不能维护题库", async () => {
  const pool = { query: async () => ({ rows: [{ id: "user-3", roles: ["grader"] }] }) };
  const access = await getAdminAccess(pool, "union-3", new Set());
  assert.equal(access.canAccess, true);
  assert.equal(access.canManageQuestions, false);
});

test("钉钉登录会复用相同 unionId 的历史用户", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("SELECT id, user_id")) {
        return { rows: [{ id: "legacy-identity", user_id: "legacy-user", provider: "legacy", provider_subject: "legacy-subject" }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const userId = await upsertDingtalkUser({ connect: async () => client }, {
    unionId: "union-1", openId: "open-1", name: "历史用户"
  });
  assert.equal(userId, "legacy-user");
  const identityInsert = calls.find((call) => call.sql.includes("INSERT INTO user_identities"));
  assert.equal(identityInsert.params[1], "legacy-user");
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("飞书登录按 open_id 建立独立身份且不按姓名自动合并", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
    release() {}
  };
  const userId = await upsertFeishuUser({ connect: async () => client }, {
    providerSubject: "ou_feishu_1", openId: "ou_feishu_1", unionId: "on_feishu_1", name: "同名员工"
  });
  const identityInsert = calls.find((call) => call.sql.includes("INSERT INTO user_identities"));

  assert.match(userId, /^user_[a-f0-9]{32}$/);
  assert.equal(identityInsert.params[2], "ou_feishu_1");
  assert.equal(identityInsert.params[3], "on_feishu_1");
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("飞书身份可以读取数据库角色但不使用钉钉引导名单", async () => {
  const pool = { query: async () => ({ rows: [{ id: "user-feishu", roles: ["student"] }] }) };
  const access = await getIdentityAccess(pool, "feishu", "ou_feishu_1");

  assert.equal(access.userId, "user-feishu");
  assert.equal(access.canAccess, false);
  assert.deepEqual(access.roles, ["student"]);
});

test("授予管理员同时写入角色和审计日志", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("SELECT u.id, u.name")) return { rows: [{ id: "target-1", name: "目标用户" }] };
      if (sql.includes("SELECT role_code")) return { rows: [{ role_code: "student" }] };
      return { rows: [] };
    },
    release() {}
  };
  const result = await setAdminRole({ connect: async () => client }, "target-1", true, "actor-1");
  assert.equal(result.isAdmin, true);
  assert.deepEqual(result.roles, ["grader", "student", "system_admin"]);
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO audit_logs")), true);
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("管理员不能移除自己的权限", async () => {
  const client = {
    async query(sql) {
      if (sql.includes("SELECT u.id, u.name")) return { rows: [{ id: "admin-1", name: "当前管理员" }] };
      if (sql.includes("SELECT role_code")) return { rows: [{ role_code: "system_admin" }] };
      return { rows: [] };
    },
    release() {}
  };
  await assert.rejects(
    setAdminRole({ connect: async () => client }, "admin-1", false, "admin-1"),
    /不能移除自己的管理员权限/
  );
});

test("最后一名系统管理员不能被移除", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("SELECT u.id, u.name")) return { rows: [{ id: "admin-1", name: "唯一管理员" }] };
      if (sql.includes("SELECT role_code")) return { rows: [{ role_code: "grader" }, { role_code: "system_admin" }] };
      if (sql.includes("COUNT(DISTINCT user_id)")) return { rows: [{ count: 1 }] };
      return { rows: [] };
    },
    release() {}
  };
  await assert.rejects(
    setAdminRole({ connect: async () => client }, "admin-1", false, "admin-2"),
    /不能移除最后一名系统管理员/
  );
  assert.equal(calls.some((sql) => sql === "ROLLBACK"), true);
});
