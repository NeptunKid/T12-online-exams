const assert = require("node:assert/strict");
const test = require("node:test");
const { loadNotificationConfig, publicNotificationConfig } = require("../src/notifications/notification-config");

test("通知 Worker 默认关闭且公开配置不包含地址或凭证", () => {
  const config = loadNotificationConfig({});
  assert.equal(config.enabled, false);
  assert.deepEqual(config.channels, []);
  assert.deepEqual(publicNotificationConfig(config), {
    enabled: false, channels: [], intervalSeconds: 30, batchSize: 10, maxAttempts: 5, notBefore: null
  });
  assert.equal(Object.hasOwn(publicNotificationConfig(config), "publicBaseUrl"), false);
});

test("通知配置限制通道、周期、重试和 HTTPS 公网地址", () => {
  const config = loadNotificationConfig({
    T12_NOTIFICATION_WORKER_ENABLED: "true",
    T12_NOTIFICATION_CHANNELS: "feishu",
    T12_NOTIFICATION_INTERVAL_SECONDS: "20",
    T12_NOTIFICATION_BATCH_SIZE: "5",
    T12_NOTIFICATION_MAX_ATTEMPTS: "4",
    T12_NOTIFICATION_RETRY_BASE_SECONDS: "30",
    T12_NOTIFICATION_STALE_AFTER_SECONDS: "120",
    T12_PUBLIC_BASE_URL: "https://exam.example.com/",
    T12_NOTIFICATION_NOT_BEFORE: "2026-08-17T18:00:00+08:00"
  });
  assert.equal(config.enabled, true);
  assert.equal(config.publicBaseUrl, "https://exam.example.com");
  assert.equal(config.retryMaximumSeconds, 240);
  assert.equal(config.notBefore, "2026-08-17T10:00:00.000Z");
  assert.throws(() => loadNotificationConfig({ T12_NOTIFICATION_WORKER_ENABLED: "true" }), /CHANNELS/);
  assert.throws(() => loadNotificationConfig({ T12_NOTIFICATION_CHANNELS: "wechat" }), /只允许 feishu 或 dingtalk/);
  assert.throws(() => loadNotificationConfig({
    T12_NOTIFICATION_WORKER_ENABLED: "true", T12_NOTIFICATION_CHANNELS: "dingtalk",
    T12_PUBLIC_BASE_URL: "https://exam.test", T12_NOTIFICATION_NOT_BEFORE: "2026-08-17T18:00:00+08:00"
  }), /DINGTALK_MESSAGE_APP_KEY/);
  const dingtalk = loadNotificationConfig({
    T12_NOTIFICATION_WORKER_ENABLED: "true", T12_NOTIFICATION_CHANNELS: "dingtalk",
    T12_DINGTALK_MESSAGE_APP_KEY: "app-key", T12_DINGTALK_MESSAGE_APP_SECRET: "secret",
    T12_DINGTALK_MESSAGE_AGENT_ID: "123", T12_PUBLIC_BASE_URL: "https://exam.test",
    T12_NOTIFICATION_NOT_BEFORE: "2026-08-17T18:00:00+08:00"
  });
  assert.deepEqual(dingtalk.channels, ["dingtalk"]);
  assert.throws(() => loadNotificationConfig({
    T12_NOTIFICATION_WORKER_ENABLED: "true", T12_NOTIFICATION_CHANNELS: "feishu", T12_PUBLIC_BASE_URL: "http://exam.test",
    T12_NOTIFICATION_NOT_BEFORE: "2026-08-17T18:00:00+08:00"
  }), /HTTPS/);
  assert.throws(() => loadNotificationConfig({
    T12_NOTIFICATION_WORKER_ENABLED: "true", T12_NOTIFICATION_CHANNELS: "feishu", T12_PUBLIC_BASE_URL: "https://exam.test"
  }), /NOT_BEFORE/);
});
