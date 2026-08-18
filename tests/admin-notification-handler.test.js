const assert = require("node:assert/strict");
const test = require("node:test");
const { createAdminNotificationHandler } = require("../src/http/admin-notification-handler");

function setup(options = {}) {
  const calls = [];
  const repository = {
    async listNotifications(pool, input) { calls.push(["list", pool, input]); return { notifications: [], stats: { pending: 2 } }; },
    async retryNotification(pool, id, actor) { calls.push(["retry", pool, id, actor]); return { id, status: "pending" }; }
  };
  const worker = { status: () => ({ running: false }), wake: () => { calls.push(["wake"]); return true; } };
  const json = (res, status, body) => { res.status = status; res.body = body; };
  return { calls, handler: createAdminNotificationHandler({
    repository,
    getPool: () => options.pool === undefined ? { name: "pool" } : options.pool,
    json,
    worker,
    publicConfig: { enabled: true, channels: ["feishu"] },
    isSameOriginJsonRequest: () => options.sameOrigin !== false
  }) };
}

test("系统管理员可以读取脱敏通知状态和 Worker 状态", async () => {
  const { calls, handler } = setup();
  const res = {};
  await handler({ method: "GET", url: "/api/admin/notifications?status=failed", headers: { host: "exam.test" } }, res, "/api/admin/notifications", { canManageAdmins: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.worker.enabled, true);
  assert.equal(calls[0][2].status, "failed");
});

test("人工重发要求系统管理员和同源 JSON，并唤醒 Worker", async () => {
  let setupResult = setup();
  let res = {};
  await setupResult.handler({ method: "POST", headers: {} }, res, "/api/admin/notifications/n-1/retry", { canManageAdmins: true, userId: "admin-1" });
  assert.equal(res.status, 202);
  assert.deepEqual(setupResult.calls.map((item) => item[0]), ["retry", "wake"]);
  setupResult = setup({ sameOrigin: false });
  res = {};
  await setupResult.handler({ method: "POST", headers: {} }, res, "/api/admin/notifications/n-1/retry", { canManageAdmins: true });
  assert.equal(res.status, 403);
  res = {};
  await setup().handler({ method: "GET", headers: {} }, res, "/api/admin/notifications", { canManageAdmins: false });
  assert.equal(res.status, 403);
});
