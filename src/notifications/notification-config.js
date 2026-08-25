function booleanValue(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error("T12_NOTIFICATION_WORKER_ENABLED 必须是布尔值");
}

function integerValue(value, fallback, label, minimum, maximum) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 的整数`);
  }
  return parsed;
}

function channelList(value) {
  const channels = String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (channels.some((channel) => !["feishu", "dingtalk"].includes(channel))) {
    throw new Error("T12_NOTIFICATION_CHANNELS 只允许 feishu 或 dingtalk");
  }
  return [...new Set(channels)];
}

function publicBaseUrl(value, required) {
  const raw = String(value || "").trim().replace(/\/$/, "");
  if (!raw) {
    if (required) throw new Error("启用通知 Worker 时必须配置 T12_PUBLIC_BASE_URL");
    return "";
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error("T12_PUBLIC_BASE_URL 必须是有效的 HTTPS 地址");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("T12_PUBLIC_BASE_URL 必须是无凭证、查询或片段的 HTTPS 地址");
  }
  return raw;
}

function notificationNotBefore(value, required) {
  const raw = String(value || "").trim();
  if (!raw) {
    if (required) throw new Error("启用通知 Worker 时必须配置 T12_NOTIFICATION_NOT_BEFORE");
    return null;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(raw) || !/(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw new Error("T12_NOTIFICATION_NOT_BEFORE 必须是带时区的 ISO 时间");
  }
  return parsed.toISOString();
}

function loadNotificationConfig(env = process.env) {
  const enabled = booleanValue(env.T12_NOTIFICATION_WORKER_ENABLED, false);
  const channels = channelList(env.T12_NOTIFICATION_CHANNELS);
  if (enabled && !channels.length) throw new Error("启用通知 Worker 时必须配置 T12_NOTIFICATION_CHANNELS");
  if (enabled && channels.includes("dingtalk")
    && (!String(env.T12_DINGTALK_MESSAGE_APP_KEY || "").trim()
      || !String(env.T12_DINGTALK_MESSAGE_APP_SECRET || "").trim()
      || !String(env.T12_DINGTALK_MESSAGE_AGENT_ID || "").trim())) {
    throw new Error("启用 dingtalk 通道时必须配置 T12_DINGTALK_MESSAGE_APP_KEY、T12_DINGTALK_MESSAGE_APP_SECRET 和 T12_DINGTALK_MESSAGE_AGENT_ID");
  }
  const intervalSeconds = integerValue(env.T12_NOTIFICATION_INTERVAL_SECONDS, 30, "T12_NOTIFICATION_INTERVAL_SECONDS", 5, 300);
  const startDelaySeconds = integerValue(env.T12_NOTIFICATION_START_DELAY_SECONDS, 15, "T12_NOTIFICATION_START_DELAY_SECONDS", 5, 300);
  const batchSize = integerValue(env.T12_NOTIFICATION_BATCH_SIZE, 10, "T12_NOTIFICATION_BATCH_SIZE", 1, 50);
  const maxAttempts = integerValue(env.T12_NOTIFICATION_MAX_ATTEMPTS, 5, "T12_NOTIFICATION_MAX_ATTEMPTS", 1, 10);
  const retryBaseSeconds = integerValue(env.T12_NOTIFICATION_RETRY_BASE_SECONDS, 60, "T12_NOTIFICATION_RETRY_BASE_SECONDS", 10, 3600);
  const staleAfterSeconds = integerValue(env.T12_NOTIFICATION_STALE_AFTER_SECONDS, 300, "T12_NOTIFICATION_STALE_AFTER_SECONDS", 60, 3600);
  const pendingAlertThreshold = integerValue(env.T12_NOTIFICATION_PENDING_ALERT_THRESHOLD, 25, "T12_NOTIFICATION_PENDING_ALERT_THRESHOLD", 0, 100000);
  const failedAlertThreshold = integerValue(env.T12_NOTIFICATION_FAILED_ALERT_THRESHOLD, 0, "T12_NOTIFICATION_FAILED_ALERT_THRESHOLD", 0, 100000);
  const abandonedAlertThreshold = integerValue(env.T12_NOTIFICATION_ABANDONED_ALERT_THRESHOLD, 0, "T12_NOTIFICATION_ABANDONED_ALERT_THRESHOLD", 0, 100000);
  return {
    enabled,
    channels,
    intervalSeconds,
    intervalMs: intervalSeconds * 1000,
    startDelaySeconds,
    startDelayMs: startDelaySeconds * 1000,
    batchSize,
    maxAttempts,
    retryBaseSeconds,
    retryMaximumSeconds: Math.min(24 * 60 * 60, retryBaseSeconds * (2 ** Math.max(0, maxAttempts - 1))),
    staleAfterSeconds,
    pendingAlertThreshold,
    failedAlertThreshold,
    abandonedAlertThreshold,
    publicBaseUrl: publicBaseUrl(env.T12_PUBLIC_BASE_URL, enabled),
    notBefore: notificationNotBefore(env.T12_NOTIFICATION_NOT_BEFORE, enabled)
  };
}

function publicNotificationConfig(config) {
  return {
    enabled: Boolean(config.enabled),
    channels: [...config.channels],
    intervalSeconds: config.intervalSeconds,
    batchSize: config.batchSize,
    maxAttempts: config.maxAttempts,
    notBefore: config.notBefore,
    pendingAlertThreshold: config.pendingAlertThreshold,
    failedAlertThreshold: config.failedAlertThreshold,
    abandonedAlertThreshold: config.abandonedAlertThreshold,
    processingStaleAfterSeconds: config.staleAfterSeconds
  };
}

module.exports = { loadNotificationConfig, publicNotificationConfig };
