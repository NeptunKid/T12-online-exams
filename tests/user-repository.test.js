const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getAdminAccess,
  getIdentityAccess,
  listAdminUsers,
  mapAdminUser,
  maskIdentity,
  normalizeRealName,
  setAdminRole,
  upsertDingtalkUser,
  upsertFeishuUser
} = require("../src/db/user-repository");

test("管理员用户映射会遮蔽钉钉和飞书身份标识", () => {
  assert.equal(maskIdentity("union-1234567890"), "unio...7890");
  const user = mapAdminUser({
    id: "user-1", name: "测试用户", employee_no: null, department: "运营",
    status: "active",
    identities: [
      { provider: "dingtalk", identifier: "union-1234567890" },
      { provider: "feishu", identifier: "ou-feishu-0987654321" }
    ],
    roles: ["student", "system_admin"]
  });
  assert.equal(user.identityHint, "dingtalk: unio...7890 / feishu: ou-f...4321");
  assert.deepEqual(user.providers, ["dingtalk", "feishu"]);
  assert.equal(user.isAdmin, true);
});

test("管理员列表包含飞书独立用户且不返回原始身份标识", async () => {
  let capturedSql = "";
  const users = await listAdminUsers({
    async query(sql) {
      capturedSql = sql;
      return { rows: [{
        id: "fei-user", name: "飞书管理员", employee_no: null, department: "运营", status: "active",
        identities: [{ provider: "feishu", identifier: "ou-feishu-1234567890" }], roles: ["grader"]
      }] };
    }
  });
  assert.match(capturedSql, /'feishu'/);
  assert.equal(users[0].identityHint, "feishu: ou-f...7890");
  assert.equal(JSON.stringify(users).includes("ou-feishu-1234567890"), false);
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

test("真实姓名标准化兼容全角字符和多余空白", () => {
  assert.equal(normalizeRealName("  Ａlice   张三 "), "alice 张三");
});

test("飞书登录没有同名钉钉用户时按 open_id 建立独立身份", async () => {
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

test("飞书登录只在唯一真实姓名匹配时绑定既有钉钉用户", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("WHERE provider = 'feishu'")) return { rows: [] };
      if (sql.includes("ui.provider = ANY")) return { rows: [{ id: "ding-user", name: " 张 三 " }] };
      return { rows: [] };
    },
    release() {}
  };
  const userId = await upsertFeishuUser({ connect: async () => client }, {
    providerSubject: "ou_feishu_2", name: "张　三"
  });
  assert.equal(userId, "ding-user");
  const identityInsert = calls.find((call) => call.sql.includes("INSERT INTO user_identities"));
  assert.equal(identityInsert.params[1], "ding-user");
  assert.equal(calls.some((call) => call.sql.includes("auto_link_identity_by_real_name")), true);
});

test("同名候选不唯一时拒绝自动绑定并回滚", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("WHERE provider = 'feishu'")) return { rows: [] };
      if (sql.includes("ui.provider = ANY")) {
        return { rows: [{ id: "ding-1", name: "同名员工" }, { id: "ding-2", name: "同名员工" }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  await assert.rejects(
    upsertFeishuUser({ connect: async () => client }, { providerSubject: "ou-3", name: "同名员工" }),
    /停止自动合并/
  );
  assert.equal(calls.includes("ROLLBACK"), true);
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
