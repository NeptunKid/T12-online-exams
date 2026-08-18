const notificationRepository = require("../db/notification-repository");

function createNotificationWorker({
  config,
  getPool,
  transports,
  repository = notificationRepository,
  logger = console,
  now = () => new Date(),
  timers = { setTimeout, clearTimeout }
}) {
  let timer = null;
  let running = false;
  let currentPromise = null;
  let nextRunAt = null;
  let lastSummary = null;

  async function execute() {
    const pool = getPool();
    if (!pool) throw new Error("通知数据库尚未配置");
    const startedAt = now();
    const notifications = await repository.claimNotifications(pool, {
      channels: config.channels,
      limit: config.batchSize,
      maxAttempts: config.maxAttempts,
      staleAfterSeconds: config.staleAfterSeconds,
      notBefore: config.notBefore
    });
    let delivered = 0;
    let failed = 0;
    let abandoned = 0;
    for (const notification of notifications) {
      try {
        const transport = transports[notification.channel];
        if (!transport) throw new Error(`通知通道 ${notification.channel} 尚未配置`);
        const receipt = await transport.send(notification);
        await repository.markNotificationDelivered(pool, notification.id, receipt);
        delivered += 1;
      } catch (error) {
        const result = await repository.markNotificationFailed(pool, notification, error, config);
        if (result.status === "abandoned") abandoned += 1;
        else failed += 1;
        logger.error?.(`通知发送失败 [${notification.id}]：${repository.compactError(error)}`);
      }
    }
    lastSummary = {
      startedAt: startedAt.toISOString(),
      completedAt: now().toISOString(),
      claimed: notifications.length,
      delivered,
      failed,
      abandoned
    };
    return lastSummary;
  }

  function begin() {
    if (!config.enabled || running) return false;
    running = true;
    currentPromise = execute()
      .catch((error) => {
        lastSummary = {
          startedAt: now().toISOString(),
          completedAt: now().toISOString(),
          claimed: 0,
          delivered: 0,
          failed: 0,
          abandoned: 0,
          error: repository.compactError(error)
        };
        logger.error?.(`通知 Worker 运行失败：${repository.compactError(error)}`);
        return lastSummary;
      })
      .finally(() => {
        running = false;
        currentPromise = null;
      });
    return true;
  }

  function schedule(delay) {
    if (!config.enabled || timer) return;
    nextRunAt = new Date(now().getTime() + delay);
    timer = timers.setTimeout(() => {
      timer = null;
      nextRunAt = null;
      begin();
      Promise.resolve(currentPromise).finally(() => schedule(config.intervalMs));
    }, delay);
    timer?.unref?.();
  }

  function wake() {
    if (!config.enabled) return false;
    if (timer) timers.clearTimeout(timer);
    timer = null;
    nextRunAt = null;
    begin();
    Promise.resolve(currentPromise).finally(() => schedule(config.intervalMs));
    return true;
  }

  return {
    start() { schedule(config.startDelayMs); },
    stop() {
      if (timer) timers.clearTimeout(timer);
      timer = null;
      nextRunAt = null;
    },
    wake,
    async runOnce() {
      if (!config.enabled) throw new Error("通知 Worker 尚未启用");
      if (!begin()) return currentPromise;
      return currentPromise;
    },
    async waitForIdle() { return currentPromise ? currentPromise : lastSummary; },
    status() {
      return {
        running,
        nextRunAt: nextRunAt?.toISOString() || null,
        lastSummary
      };
    }
  };
}

module.exports = { createNotificationWorker };
