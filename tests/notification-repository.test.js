const assert = require("node:assert/strict");
const test = require("node:test");
const {
  enqueueNotificationEvents,
  enqueueSubmissionCreated,
  enqueueSubmissionGraded,
  listActiveGraderRecipients,
  listActiveUserRecipients,
  notificationEventKey
} = require("../src/db/notification-repository");

test("通知事件键稳定且包含通道和收件人", () => {
  assert.equal(notificationEventKey("submission.created", "s-1", "feishu", "ou-1"), "submission.created:s-1:feishu:ou-1");
});

test("Outbox 只为有效管理员身份创建待发送任务", async () => {
  const calls = [];
  const queryable = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM users u") && sql.includes("user_roles")) {
        return { rows: [
          { provider: "dingtalk", provider_subject: "union-1" },
          { provider: "feishu", provider_subject: "ou-1" },
          { provider: "legacy", provider_subject: "old-1" }
        ] };
      }
      return { rowCount: 1, rows: [] };
    }
  };
  const queued = await enqueueSubmissionCreated(queryable, {
    submissionId: "s-1", examId: "exam-1", examTitle: "测试考试", studentName: "学员甲", submittedAt: "2026-08-15T00:00:00Z"
  });
  assert.equal(queued, 2);
  assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO notifications")).length, 2);
  assert.equal(calls[1].params[1], "submission.created:s-1:dingtalk:union-1");
  assert.deepEqual(JSON.parse(calls[2].params[5]), {
    submissionId: "s-1", examId: "exam-1", examTitle: "测试考试", studentName: "学员甲",
    submittedAt: "2026-08-15T00:00:00Z", kind: "grader"
  });
});

test("成绩通知只发给答卷人的有效平台身份且不包含答案", async () => {
  const calls = [];
  const queryable = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("WHERE u.id = $1")) {
        assert.deepEqual(params, ["user-1"]);
        return { rows: [{ provider: "feishu", provider_subject: "ou-1" }] };
      }
      return { rowCount: 1, rows: [] };
    }
  };
  const queued = await enqueueSubmissionGraded(queryable, {
    submissionId: "s-1", userId: "user-1", examId: "exam-1", examTitle: "测试考试",
    totalScore: 86, passScore: 60, pass: true, gradedAt: "2026-08-15T00:05:00Z"
  });
  assert.equal(queued, 1);
  const insert = calls.find((call) => call.sql.includes("INSERT INTO notifications"));
  const payload = JSON.parse(insert.params[5]);
  assert.equal(payload.kind, "student");
  assert.equal(Object.hasOwn(payload, "answers"), false);
});

test("重复事件依赖 event_key 幂等，冲突时不计入新增", async () => {
  const queryable = { async query() { return { rowCount: 0, rows: [] }; } };
  assert.equal(await enqueueNotificationEvents(queryable, "submission.graded", "s-1", [
    { channel: "dingtalk", recipient: "union-1" }
  ], {}), 0);
});

test("收件人查询过滤禁用账号和不支持的身份", async () => {
  const queryable = {
    async query(sql) {
      if (sql.includes("user_roles")) return { rows: [{ provider: "dingtalk", provider_subject: "u1" }] };
      return { rows: [{ provider: "feishu", provider_subject: "ou1" }] };
    }
  };
  assert.deepEqual(await listActiveGraderRecipients(queryable), [{ channel: "dingtalk", recipient: "u1" }]);
  assert.deepEqual(await listActiveUserRecipients(queryable, "user-1"), [{ channel: "feishu", recipient: "ou1" }]);
  assert.deepEqual(await listActiveUserRecipients(queryable, null), []);
});
