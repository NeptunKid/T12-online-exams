const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { listMigrations } = require("../scripts/migrate");
const {
  claimNotifications,
  listNotifications,
  markNotificationDelivered,
  markNotificationFailed,
  retryNotification
} = require("../src/db/notification-repository");

function row(overrides = {}) {
  return {
    id: "n-1", event_type: "submission.graded", channel: "feishu", recipient: "ou-private",
    status: "processing", attempts: 1, payload_json: { examTitle: "测试考试" }, last_error: null,
    next_attempt_at: null, delivered_at: null, receipt_json: {},
    created_at: "created", updated_at: "updated", ...overrides
  };
}

test("0011 只为通知增加回执且提供同名回滚", () => {
  const migration = listMigrations().find((item) => item.name === "0011_notification_delivery_receipts");
  assert.ok(migration);
  assert.match(migration.sql, /ADD COLUMN receipt_json jsonb/);
  assert.match(migration.sql, /notifications_processing_updated_idx/);
  assert.doesNotMatch(migration.sql, /\b(submissions|submission_questions)\b/i);
  const down = fs.readFileSync(migration.downPath, "utf8");
  assert.match(down, /拒绝回滚 0011/);
  assert.match(down, /DROP COLUMN IF EXISTS receipt_json/);
});

test("领取任务恢复超时 processing、放弃超限任务并使用 SKIP LOCKED", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("RETURNING n.*")) return { rows: [row()] };
      return { rows: [] };
    },
    release() { calls.push({ sql: "RELEASE" }); }
  };
  const notifications = await claimNotifications({ connect: async () => client }, {
    channels: ["feishu"], limit: 10, maxAttempts: 5, staleAfterSeconds: 300
  });
  assert.equal(notifications[0].recipient, "ou-private");
  const claim = calls.find((call) => call.sql.includes("RETURNING n.*"));
  assert.match(claim.sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(claim.sql, /created_at >= \$4::timestamptz OR next_attempt_at >= \$4::timestamptz/);
  assert.deepEqual(claim.params, [["feishu"], 10, 5, "1970-01-01T00:00:00.000Z"]);
  assert.equal(calls.at(-2).sql, "COMMIT");
});

test("送达写入受控回执，失败按次数重试或放弃", async () => {
  const calls = [];
  const pool = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes("receipt_json")) return { rows: [row({ status: "delivered", receipt_json: JSON.parse(params[1]) })] };
    return { rows: [row({ status: params[1], last_error: params[2] })] };
  } };
  const delivered = await markNotificationDelivered(pool, "n-1", { messageId: "m-1" });
  assert.equal(delivered.receipt.messageId, "m-1");
  const failed = await markNotificationFailed(pool, { id: "n-1", attempts: 2 }, new Error("temporary\nerror"), {
    maxAttempts: 3, retryBaseSeconds: 60, retryMaximumSeconds: 600
  });
  assert.equal(failed.status, "failed");
  assert.equal(calls.at(-1).params[3], 120);
  const abandoned = await markNotificationFailed(pool, { id: "n-1", attempts: 3 }, new Error("final"), {
    maxAttempts: 3, retryBaseSeconds: 60, retryMaximumSeconds: 600
  });
  assert.equal(abandoned.status, "abandoned");
});

test("通知列表隐藏原始收件人和正文，并返回状态统计", async () => {
  let queryNo = 0;
  const pool = { async query() {
    queryNo += 1;
    return queryNo === 1
      ? { rows: [row({ status: "failed", last_error: "timeout" })] }
      : { rows: [{ status: "failed", count: 1 }] };
  } };
  const result = await listNotifications(pool, { status: "all", limit: 20 });
  assert.equal(result.notifications[0].recipientRef.length, 10);
  assert.equal(Object.hasOwn(result.notifications[0], "recipient"), false);
  assert.equal(Object.hasOwn(result.notifications[0], "payload"), false);
  assert.equal(result.stats.failed, 1);
});

test("人工重发只接受 failed 或 abandoned 并写审计", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith("SELECT *")) return { rows: [row({ status: "abandoned", attempts: 5, last_error: "final" })] };
      if (sql.includes("UPDATE notifications")) return { rows: [row({ status: "pending", attempts: 0 })] };
      return { rows: [] };
    },
    release() {}
  };
  const retried = await retryNotification({ connect: async () => client }, "n-1", "admin-1");
  assert.equal(retried.status, "pending");
  const audit = calls.find((call) => call.sql.includes("INSERT INTO audit_logs"));
  assert.equal(audit.params[1], "admin-1");
  assert.equal(calls.at(-1).sql, "COMMIT");
});
