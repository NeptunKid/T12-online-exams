const DEFAULTS = Object.freeze({
  pendingAlertThreshold: 25,
  failedAlertThreshold: 0,
  abandonedAlertThreshold: 0,
  processingStaleAfterSeconds: 300
});

function countValue(value) {
  const count = Number(value || 0);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

function thresholdValue(value, fallback) {
  const threshold = Number(value);
  return Number.isFinite(threshold) && threshold >= 0 ? threshold : fallback;
}

function ageInSeconds(value, now) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, (now.getTime() - timestamp) / 1000);
}

function createNotificationMonitor({ stats = {}, thresholds = {}, now = new Date() } = {}) {
  const checkedAt = now instanceof Date ? now : new Date(now);
  const pending = countValue(stats.pending);
  const failed = countValue(stats.failed);
  const abandoned = countValue(stats.abandoned);
  const processing = countValue(stats.processing);
  const pendingAlertThreshold = thresholdValue(thresholds.pendingAlertThreshold, DEFAULTS.pendingAlertThreshold);
  const failedAlertThreshold = thresholdValue(thresholds.failedAlertThreshold, DEFAULTS.failedAlertThreshold);
  const abandonedAlertThreshold = thresholdValue(thresholds.abandonedAlertThreshold, DEFAULTS.abandonedAlertThreshold);
  const processingStaleAfterSeconds = thresholdValue(
    thresholds.processingStaleAfterSeconds,
    DEFAULTS.processingStaleAfterSeconds
  );
  const alerts = [];
  if (pending > pendingAlertThreshold) {
    alerts.push({
      code: "pending_backlog",
      severity: "warning",
      count: pending,
      threshold: pendingAlertThreshold,
      message: `待发送通知 ${pending} 条，超过阈值 ${pendingAlertThreshold} 条`
    });
  }
  if (failed > failedAlertThreshold) {
    alerts.push({
      code: "failed_tasks",
      severity: "error",
      count: failed,
      threshold: failedAlertThreshold,
      message: `通知发送失败 ${failed} 条，超过阈值 ${failedAlertThreshold} 条`
    });
  }
  if (abandoned > abandonedAlertThreshold) {
    alerts.push({
      code: "abandoned_tasks",
      severity: "error",
      count: abandoned,
      threshold: abandonedAlertThreshold,
      message: `通知已放弃 ${abandoned} 条，超过阈值 ${abandonedAlertThreshold} 条`
    });
  }
  const processingAge = ageInSeconds(stats.oldestProcessingUpdatedAt, checkedAt);
  if (processing > 0 && processingAge !== null && processingAge >= processingStaleAfterSeconds) {
    alerts.push({
      code: "stale_processing",
      severity: "error",
      count: processing,
      threshold: processingStaleAfterSeconds,
      message: `有 ${processing} 条通知发送中超过 ${processingStaleAfterSeconds} 秒`
    });
  }
  return {
    healthy: alerts.length === 0,
    checkedAt: checkedAt.toISOString(),
    thresholds: {
      pendingAlertThreshold,
      failedAlertThreshold,
      abandonedAlertThreshold,
      processingStaleAfterSeconds
    },
    alerts
  };
}

module.exports = { DEFAULTS, createNotificationMonitor };
