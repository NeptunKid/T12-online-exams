const assert = require("node:assert/strict");
const test = require("node:test");
const {
  archiveQuestionBank,
  copyQuestionBank,
  createQuestionBank,
  listManagedQuestionBanks,
  listQuestionBanks,
  normalizeBankMetadata,
  restoreQuestionBank,
  updateQuestionBank
} = require("../src/db/question-repository");

function bankRow(overrides = {}) {
  return {
    id: "bank-1", name: "测试题库", description: "说明", status: "active",
    owner_id: "admin-1", version: 2, question_count: 2, active_question_count: 1,
    exam_count: 3, ...overrides
  };
}

function lifecycleClient({ existing = bankRow(), questions = [] } = {}) {
  const calls = [];
  let current = { ...existing };
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM question_banks") && sql.includes("FOR UPDATE")) return { rows: current ? [{ ...current }] : [] };
      if (sql.includes("FROM questions") && sql.includes("FOR SHARE")) return { rows: questions };
      if (sql.includes("UPDATE question_banks")) {
        if (sql.includes("SET status")) current = { ...current, status: params[1], version: Number(current.version) + 1 };
        else current = { ...current, name: params[1], description: params[2], owner_id: params[3], version: Number(current.version) + 1 };
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO question_banks")) {
        current = bankRow({ id: params[0], name: params[1], description: params[2], owner_id: params[3], version: 1, question_count: 0, active_question_count: 0, exam_count: 0 });
        return { rows: [] };
      }
      if (sql.includes("GROUP BY qb.id")) return { rows: current ? [{ ...current }] : [] };
      return { rows: [] };
    },
    release() {}
  };
  return { calls, client };
}

test("题库元数据校验名称、说明和负责人", () => {
  assert.deepEqual(normalizeBankMetadata({ name: "  新题库  ", description: "  说明  ", ownerId: " admin-1 " }), {
    name: "新题库", description: "说明", ownerId: "admin-1"
  });
  assert.throws(() => normalizeBankMetadata({ name: "" }), /题库名称不能为空/);
});

test("新建题库使用独立事务、初始版本并写审计", async () => {
  const state = lifecycleClient({ existing: null });
  const created = await createQuestionBank({ connect: async () => state.client }, {
    name: "新题库", description: "说明"
  }, "admin-1");
  assert.equal(created.status, "active");
  assert.equal(created.version, 1);
  const audit = state.calls.find((call) => call.sql.includes("INSERT INTO audit_logs"));
  assert.match(audit.sql, /'question_bank'/);
  assert.equal(audit.params[2], "create_question_bank");
  assert.equal(audit.params[4], null);
  assert.equal(JSON.parse(audit.params[5]).version, 1);
  assert.equal(state.calls.at(-1).sql, "COMMIT");
});

test("编辑题库锁定行、检查版本、递增版本并写前后审计", async () => {
  const state = lifecycleClient();
  const updated = await updateQuestionBank({ connect: async () => state.client }, "bank-1", {
    version: 2, name: "新名称", description: "新说明", ownerId: "admin-2"
  }, "admin-1");
  assert.equal(updated.version, 3);
  assert.equal(updated.name, "新名称");
  const audit = state.calls.find((call) => call.sql.includes("'question_bank'"));
  assert.equal(audit.params[2], "update_question_bank");
  assert.equal(JSON.parse(audit.params[4]).version, 2);
  assert.equal(JSON.parse(audit.params[5]).version, 3);
});

test("过期版本在任何写入前回滚", async () => {
  const state = lifecycleClient();
  await assert.rejects(updateQuestionBank({ connect: async () => state.client }, "bank-1", {
    version: 1, name: "冲突"
  }, "admin-1"), /题库已被其他管理员修改/);
  assert.equal(state.calls.some((call) => call.sql.includes("UPDATE question_banks")), false);
  assert.equal(state.calls.at(-1).sql, "ROLLBACK");
});

test("普通列表只读取启用题库，维护列表读取全部状态", async () => {
  const calls = [];
  const pool = { async query(sql) { calls.push(sql); return { rows: [] }; } };
  await listQuestionBanks(pool);
  await listManagedQuestionBanks(pool);
  assert.match(calls[0], /WHERE qb\.status = 'active'/);
  assert.doesNotMatch(calls[1], /WHERE qb\.status = 'active'/);
  assert.match(calls[1], /ORDER BY \(qb\.status = 'archived'\)/);
});

test("复制题库包含题目内容，不复制试卷关系或答卷", async () => {
  const questions = [{
    id: "q-1", external_id: "1", type: "single", stem: "题干", images_json: [],
    options_json: [{ label: "A", text: "甲" }, { label: "B", text: "乙" }], answer_json: "A",
    explanation: "解析", version: 7, status: "active"
  }];
  const state = lifecycleClient({ questions });
  const copied = await copyQuestionBank({ connect: async () => state.client }, "bank-1", {
    version: 2, name: "题库副本"
  }, "admin-1");
  assert.equal(copied.version, 1);
  assert.equal(state.calls.filter((call) => call.sql.includes("INSERT INTO questions")).length, 1);
  const sql = state.calls.map((call) => call.sql).join("\n");
  assert.doesNotMatch(sql, /INSERT INTO exam_questions/);
  assert.doesNotMatch(sql, /\b(submissions|submission_questions)\b/);
  const audit = state.calls.find((call) => call.sql.includes("INSERT INTO audit_logs"));
  assert.match(audit.sql, /'question_bank'/);
  assert.equal(audit.params[2], "copy_question_bank");
  assert.equal(audit.params[4], null);
  assert.equal(JSON.parse(audit.params[5]).sourceBankId, "bank-1");
});

test("复制题库校验源版本后才创建副本", async () => {
  const state = lifecycleClient();
  await assert.rejects(copyQuestionBank({ connect: async () => state.client }, "bank-1", {
    version: 1, name: "冲突副本"
  }, "admin-1"), /题库已被其他管理员修改/);
  assert.equal(state.calls.some((call) => call.sql.includes("INSERT INTO question_banks")), false);
  assert.equal(state.calls.some((call) => call.sql.includes("INSERT INTO questions")), false);
  assert.equal(state.calls.at(-1).sql, "ROLLBACK");
});

test("归档和恢复只改题库状态，不物理删除题目、试卷或答卷", async () => {
  const state = lifecycleClient();
  const archived = await archiveQuestionBank({ connect: async () => state.client }, "bank-1", { version: 2 }, "admin-1");
  assert.equal(archived.status, "archived");
  const restored = await restoreQuestionBank({ connect: async () => state.client }, "bank-1", { version: 3 }, "admin-1");
  assert.equal(restored.status, "active");
  const sql = state.calls.map((call) => call.sql).join("\n");
  assert.doesNotMatch(sql, /\bDELETE\b/i);
  assert.doesNotMatch(sql, /UPDATE\s+(questions|exams|exam_questions|submissions|submission_questions)\b/i);
  const audits = state.calls.filter((call) => call.sql.includes("'question_bank'"));
  assert.deepEqual(audits.map((call) => call.params[2]), ["archive_question_bank", "restore_question_bank"]);
  assert.deepEqual(audits.map((call) => [
    JSON.parse(call.params[4]).status,
    JSON.parse(call.params[5]).status
  ]), [["active", "archived"], ["archived", "active"]]);
});
