const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildReconciliationPlan,
  mergeUser,
  parseArgs,
  reconcile
} = require("../scripts/reconcile-cross-platform-users");

test("历史身份整理只规划唯一的钉钉飞书真实姓名匹配", () => {
  const plan = buildReconciliationPlan([
    { user_id: "ding-1", name: "张 三", provider: "dingtalk" },
    { user_id: "fei-1", name: "张　三", provider: "feishu" },
    { user_id: "ding-2", name: "同名员工", provider: "dingtalk" },
    { user_id: "ding-3", name: "同名员工", provider: "dingtalk" },
    { user_id: "fei-2", name: "同名员工", provider: "feishu" }
  ]);
  assert.deepEqual(plan.merges, [{ realName: "张 三", canonicalUserId: "ding-1", duplicateUserId: "fei-1" }]);
  assert.equal(plan.ambiguous.length, 1);
});

test("身份整理默认为 dry-run 且只回滚", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("SELECT u.id AS user_id")) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  const result = await reconcile({ connect: async () => client }, false);
  assert.equal(result.mode, "dry-run");
  assert.deepEqual(calls, ["BEGIN", calls[1], "ROLLBACK"]);
  assert.equal(calls.some((sql) => sql.includes("UPDATE submissions")), false);
});

test("合并保留答卷题目快照与成绩，仅归并用户并校正考核次数", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("FROM retake_permissions") && sql.includes("WHERE user_id")) return { rows: [] };
      return { rows: [] };
    }
  };
  await mergeUser(client, { realName: "张三", canonicalUserId: "ding-1", duplicateUserId: "fei-1" });
  assert.equal(calls.some((sql) => sql.includes("UPDATE submissions SET user_id")), true);
  assert.equal(calls.some((sql) => sql.includes("row_number() OVER")), true);
  assert.equal(calls.some((sql) => sql.includes("submission_questions")), false);
  assert.equal(calls.some((sql) => /objective_score|total_score|scores_json/.test(sql)), false);
  assert.equal(calls.some((sql) => sql.includes("merge_cross_platform_user")), true);
  assert.equal(calls.some((sql) => sql.includes("UPDATE users SET status = 'disabled'")), true);
  assert.equal(calls.some((sql) => sql.includes("DELETE FROM users")), false);
});

test("身份整理脚本只允许预览并拒绝命令行 apply", () => {
  assert.deepEqual(parseArgs([]), { help: false });
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  assert.throws(() => parseArgs(["--apply"]), /已停用/);
});
