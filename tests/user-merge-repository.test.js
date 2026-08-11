const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildMergeCandidateGroups,
  mergePlatformUsers
} = require("../src/db/user-merge-repository");

test("同名候选只返回跨钉钉和飞书的不同内部用户", () => {
  const groups = buildMergeCandidateGroups([
    { user_id: "ding-1", name: "张 三", employee_no: "A01", department: "运营", provider: "dingtalk" },
    { user_id: "fei-1", name: "张　三", employee_no: "", department: "运营", provider: "feishu" },
    { user_id: "linked-1", name: "李四", provider: "dingtalk" },
    { user_id: "linked-1", name: "李四", provider: "feishu" },
    { user_id: "fei-only", name: "王五", provider: "feishu" }
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].displayName, "张 三");
  assert.equal(groups[0].ambiguous, false);
  assert.deepEqual(groups[0].pairs, [{ canonicalUserId: "ding-1", duplicateUserId: "fei-1" }]);
});

test("同名组包含已绑定双平台账号时标记为歧义且不作为归并对象", () => {
  const groups = buildMergeCandidateGroups([
    { user_id: "ding-1", name: "张三", provider: "dingtalk" },
    { user_id: "fei-1", name: "张三", provider: "feishu" },
    { user_id: "linked-1", name: "张三", provider: "dingtalk" },
    { user_id: "linked-1", name: "张三", provider: "feishu" }
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].ambiguous, true);
  assert.deepEqual(groups[0].pairs, [{ canonicalUserId: "ding-1", duplicateUserId: "fei-1" }]);
});

test("管理员确认合并会锁定用户、校验平台、提交事务并保留禁用副本", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("SELECT id, name, employee_no, department, status")) return { rows: [
        { id: "ding-1", name: "张 三", employee_no: "", department: "运营", status: "active" },
        { id: "fei-1", name: "张　三", employee_no: "F01", department: "运营", status: "active" }
      ] };
      if (sql.includes("SELECT u.id AS user_id, u.name")) return { rows: [
        { user_id: "ding-1", name: "张 三", employee_no: "", department: "运营", provider: "dingtalk" },
        { user_id: "fei-1", name: "张　三", employee_no: "F01", department: "运营", provider: "feishu" }
      ] };
      if (sql.includes("SELECT user_id, array_agg")) return { rows: [
        { user_id: "ding-1", providers: ["dingtalk"] },
        { user_id: "fei-1", providers: ["feishu"] }
      ] };
      if (sql.includes("identity_count")) return { rows: [{
        identity_count: 1, role_count: 1, assignment_count: 1, retake_permission_count: 0,
        submission_count: 2, question_bank_owner_count: 0, exam_owner_count: 0, graded_submission_count: 0
      }] };
      if (sql.includes("FROM retake_permissions") && sql.includes("WHERE user_id")) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  const result = await mergePlatformUsers({ connect: async () => client }, {
    canonicalUserId: "ding-1",
    duplicateUserId: "fei-1",
    expectedName: " 张　三 "
  }, "admin-1");
  assert.equal(result.merged, true);
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-1).sql, "COMMIT");
  assert.equal(calls.some((call) => call.sql.includes("pg_advisory_xact_lock")), true);
  assert.equal(calls.some((call) => call.sql.includes("submission_questions")), false);
  assert.equal(calls.some((call) => call.sql.includes("UPDATE users SET status = 'disabled'")), true);
  assert.equal(calls.some((call) => call.sql.includes("UPDATE audit_logs SET actor_id")), false);
  assert.equal(calls.some((call) => call.sql.includes("LEAST(exam_assignments.starts_at")), true);
  const clearDuplicateEmployeeNo = calls.findIndex((call) => call.sql.includes("UPDATE users SET employee_no = NULL"));
  const copyEmployeeNo = calls.findIndex((call) => call.sql.includes("SET employee_no = COALESCE"));
  assert.ok(clearDuplicateEmployeeNo >= 0 && clearDuplicateEmployeeNo < copyEmployeeNo);
});

test("姓名变化或平台方向错误时整笔合并回滚", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("SELECT id, name, employee_no, department, status")) return { rows: [
        { id: "ding-1", name: "张三", status: "active" },
        { id: "fei-1", name: "李四", status: "active" }
      ] };
      return { rows: [] };
    },
    release() {}
  };
  await assert.rejects(
    mergePlatformUsers({ connect: async () => client }, {
      canonicalUserId: "ding-1", duplicateUserId: "fei-1", expectedName: "张三"
    }, "admin-1"),
    /姓名已变化/
  );
  assert.equal(calls.includes("ROLLBACK"), true);
});

test("候选在确认前变得歧义时拒绝提交且不迁移身份", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("SELECT id, name, employee_no, department, status")) return { rows: [
        { id: "ding-1", name: "张三", employee_no: "", department: "", status: "active" },
        { id: "fei-1", name: "张三", employee_no: "", department: "", status: "active" }
      ] };
      if (sql.includes("SELECT u.id AS user_id, u.name")) return { rows: [
        { user_id: "ding-1", name: "张三", provider: "dingtalk" },
        { user_id: "ding-2", name: "张三", provider: "dingtalk" },
        { user_id: "fei-1", name: "张三", provider: "feishu" }
      ] };
      return { rows: [] };
    },
    release() {}
  };
  await assert.rejects(
    mergePlatformUsers({ connect: async () => client }, {
      canonicalUserId: "ding-1", duplicateUserId: "fei-1", expectedName: "张三"
    }, "admin-1"),
    /存在歧义/
  );
  assert.equal(calls.some((sql) => sql.includes("UPDATE user_identities")), false);
  assert.equal(calls.includes("ROLLBACK"), true);
});
