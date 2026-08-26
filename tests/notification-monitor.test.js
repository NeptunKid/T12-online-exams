const assert = require("node:assert/strict");
const test = require("node:test");
const { createNotificationMonitor } = require("../src/notifications/notification-monitor");

const now = new Date("2026-08-25T12:00:00.000Z");

test("通知队列在阈值以内时报告正常", () => {
  const result = createNotificationMonitor({
    now,
    stats: { pending: 2, failed: 0, abandoned: 0, processing: 0 },
    thresholds: { pendingAlertThreshold: 2 }
  });
  assert.equal(result.healthy, true);
  assert.deepEqual(result.alerts, []);
});

test("通知监控报告积压、失败和已放弃任务", () => {
  const result = createNotificationMonitor({
    now,
    stats: { pending: 3, failed: 1, abandoned: 2, processing: 0 },
    thresholds: { pendingAlertThreshold: 2, failedAlertThreshold: 0, abandonedAlertThreshold: 1 }
  });
  assert.equal(result.healthy, false);
  assert.deepEqual(result.alerts.map((alert) => alert.code), [
    "pending_backlog", "failed_tasks", "abandoned_tasks"
  ]);
});

test("发送中任务超过恢复窗口时报告陈旧任务", () => {
  const result = createNotificationMonitor({
    now,
    stats: {
      pending: 0, failed: 0, abandoned: 0, processing: 1,
      oldestProcessingUpdatedAt: "2026-08-25T11:54:00.000Z"
    },
    thresholds: { processingStaleAfterSeconds: 300 }
  });
  assert.equal(result.healthy, false);
  assert.equal(result.alerts[0].code, "stale_processing");
});

