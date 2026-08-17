const assert = require("node:assert/strict");
const test = require("node:test");
const { createNotificationWorker } = require("../src/notifications/notification-worker");

function setup(options = {}) {
  const calls = [];
  const repository = {
    compactError(error) { return error.message; },
    async claimNotifications(pool, input) {
      calls.push(["claim", input]);
      return options.notifications || [];
    },
    async markNotificationDelivered(pool, id, receipt) { calls.push(["delivered", id, receipt]); },
    async markNotificationFailed(pool, notification, error) {
      calls.push(["failed", notification.id, error.message]);
      return { status: options.abandon ? "abandoned" : "failed" };
    }
  };
  const config = {
    enabled: options.enabled !== false,
    channels: ["feishu"], batchSize: 10, maxAttempts: 3, staleAfterSeconds: 300,
    retryBaseSeconds: 60, retryMaximumSeconds: 240, intervalMs: 1000, startDelayMs: 10,
    notBefore: "2026-08-17T00:00:00.000Z"
  };
  const worker = createNotificationWorker({
    config,
    getPool: () => ({ name: "pool" }),
    repository,
    transports: { feishu: { async send(notification) {
      calls.push(["send", notification.id]);
      if (options.fail) throw new Error("send failed");
      return { messageId: `message-${notification.id}` };
    } } },
    logger: { error() {} },
    now: () => new Date("2026-08-17T00:00:00Z")
  });
  return { calls, worker };
}

test("Worker 领取配置通道任务并记录送达回执", async () => {
  const { calls, worker } = setup({ notifications: [{ id: "n-1", channel: "feishu" }] });
  const summary = await worker.runOnce();
  assert.equal(summary.delivered, 1);
  assert.deepEqual(calls[0][1].channels, ["feishu"]);
  assert.ok(calls.some((item) => item[0] === "delivered" && item[1] === "n-1"));
});

test("单个发送失败被记录且不会中断同批其他任务", async () => {
  const { calls, worker } = setup({ fail: true, notifications: [
    { id: "n-1", channel: "feishu" }, { id: "n-2", channel: "feishu" }
  ] });
  const summary = await worker.runOnce();
  assert.equal(summary.failed, 2);
  assert.equal(calls.filter((item) => item[0] === "failed").length, 2);
});

test("Worker 默认关闭时不领取任务", async () => {
  const { calls, worker } = setup({ enabled: false });
  worker.start();
  await assert.rejects(worker.runOnce(), /尚未启用/);
  assert.equal(calls.length, 0);
});
