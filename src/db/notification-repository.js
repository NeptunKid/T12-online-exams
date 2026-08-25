const crypto = require("node:crypto");
const { createNotificationMonitor } = require("../notifications/notification-monitor");

function notificationEventKey(eventType, resourceId, channel, recipient) {
  return `${eventType}:${resourceId}:${channel}:${recipient}`;
}

function supportedRecipient(row) {
  return (row.provider === "dingtalk" || row.provider === "feishu") && Boolean(row.provider_subject);
}

function recipientSubject(row) {
  return row.provider === "dingtalk"
    ? String(row.union_id || row.provider_subject || "")
    : String(row.provider_subject || "");
}

function compactError(error) {
  return String(error?.message || error || "通知发送失败").replace(/[\r\n]+/g, " ").trim().slice(0, 1000) || "通知发送失败";
}

function mapNotification(row) {
  return {
    id: row.id,
    eventType: row.event_type,
    channel: row.channel,
    recipient: row.recipient,
    status: row.status,
    attempts: Number(row.attempts || 0),
    payload: row.payload_json || {},
    lastError: row.last_error || "",
    nextAttemptAt: row.next_attempt_at || null,
    deliveredAt: row.delivered_at || null,
    receipt: row.receipt_json || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function publicNotification(notification) {
  const recipientRef = crypto.createHash("sha256").update(String(notification.recipient || "")).digest("hex").slice(0, 10);
  return {
    id: notification.id,
    eventType: notification.eventType,
    channel: notification.channel,
    recipientRef,
    status: notification.status,
    attempts: notification.attempts,
    examTitle: String(notification.payload?.examTitle || ""),
    lastError: notification.lastError,
    nextAttemptAt: notification.nextAttemptAt,
    deliveredAt: notification.deliveredAt,
    createdAt: notification.createdAt,
    updatedAt: notification.updatedAt
  };
}

async function listActiveGraderRecipients(queryable) {
  const result = await queryable.query(`
    SELECT DISTINCT ui.provider, ui.provider_subject, ui.union_id
    FROM users u
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN user_identities ui ON ui.user_id = u.id
    WHERE u.status = 'active'
      AND ur.role_code IN ('grader', 'exam_admin', 'system_admin')
      AND ui.provider IN ('dingtalk', 'feishu')
      AND ui.provider_subject <> ''
    ORDER BY ui.provider, ui.provider_subject;`);
  return result.rows
    .filter(supportedRecipient)
    .map((row) => ({ channel: row.provider, recipient: recipientSubject(row) }));
}

async function listActiveUserRecipients(queryable, userId) {
  if (!userId) return [];
  const result = await queryable.query(`
    SELECT DISTINCT ui.provider, ui.provider_subject, ui.union_id
    FROM users u
    JOIN user_identities ui ON ui.user_id = u.id
    WHERE u.id = $1
      AND u.status = 'active'
      AND ui.provider IN ('dingtalk', 'feishu')
      AND ui.provider_subject <> ''
    ORDER BY ui.provider, ui.provider_subject;`, [userId]);
  return result.rows
    .filter(supportedRecipient)
    .map((row) => ({ channel: row.provider, recipient: recipientSubject(row) }));
}

function mergeRecipients(...recipientLists) {
  const seen = new Set();
  return recipientLists.flat().filter((recipient) => {
    const key = `${recipient.channel}:${recipient.recipient}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function enqueueNotificationEvents(queryable, eventType, resourceId, recipients, payload) {
  let queued = 0;
  for (const recipient of recipients) {
    const eventKey = notificationEventKey(eventType, resourceId, recipient.channel, recipient.recipient);
    const result = await queryable.query(`
      INSERT INTO notifications (
        id, event_key, event_type, channel, recipient, status, payload_json, next_attempt_at
      ) VALUES ($1, $2, $3, $4, $5, 'pending', $6::jsonb, CURRENT_TIMESTAMP)
      ON CONFLICT (event_key) DO NOTHING;`, [
      crypto.randomUUID(), eventKey, eventType, recipient.channel, recipient.recipient,
      JSON.stringify(payload)
    ]);
    queued += Number(result.rowCount || 0);
  }
  return queued;
}

async function enqueueSubmissionCreated(queryable, input) {
  const recipients = await listActiveGraderRecipients(queryable);
  return enqueueNotificationEvents(queryable, "submission.created", input.submissionId, recipients, {
    submissionId: input.submissionId,
    examId: input.examId,
    examTitle: input.examTitle,
    studentName: input.studentName || "历史答卷用户",
    submittedAt: input.submittedAt,
    kind: "grader"
  });
}

async function enqueueSubmissionGraded(queryable, input) {
  const studentRecipients = await listActiveUserRecipients(queryable, input.userId);
  const adminRecipients = await listActiveGraderRecipients(queryable);
  const recipients = mergeRecipients(studentRecipients, adminRecipients);
  return enqueueNotificationEvents(queryable, "submission.graded", input.submissionId, recipients, {
    submissionId: input.submissionId,
    examId: input.examId,
    examTitle: input.examTitle,
    studentName: input.studentName || "历史答卷用户",
    totalScore: input.totalScore,
    passScore: input.passScore,
    pass: Boolean(input.pass),
    gradedAt: input.gradedAt,
    kind: "result"
  });
}

async function claimNotifications(pool, options) {
  const channels = Array.isArray(options.channels) ? options.channels : [];
  if (!channels.length) return [];
  const limit = Math.max(1, Math.min(50, Number(options.limit || 10)));
  const maxAttempts = Math.max(1, Math.min(10, Number(options.maxAttempts || 5)));
  const staleAfterSeconds = Math.max(60, Math.min(3600, Number(options.staleAfterSeconds || 300)));
  const notBefore = options.notBefore || new Date(0).toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      UPDATE notifications
      SET status = 'pending', next_attempt_at = CURRENT_TIMESTAMP,
        last_error = COALESCE(last_error, '发送进程中断，任务已自动恢复')
      WHERE status = 'processing'
        AND channel = ANY($2::text[])
        AND updated_at < CURRENT_TIMESTAMP - make_interval(secs => $1);`, [staleAfterSeconds, channels]);
    await client.query(`
      UPDATE notifications
      SET status = 'abandoned', next_attempt_at = NULL
      WHERE status IN ('pending', 'failed')
        AND channel = ANY($2::text[])
        AND attempts >= $1;`, [maxAttempts, channels]);
    const result = await client.query(`
      WITH candidates AS (
        SELECT id
        FROM notifications
        WHERE channel = ANY($1::text[])
          AND status IN ('pending', 'failed')
          AND attempts < $3
          AND (created_at >= $4::timestamptz OR next_attempt_at >= $4::timestamptz)
          AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
        ORDER BY COALESCE(next_attempt_at, created_at), created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT $2
      )
      UPDATE notifications n
      SET status = 'processing', attempts = n.attempts + 1,
        last_error = NULL, next_attempt_at = NULL
      FROM candidates c
      WHERE n.id = c.id
      RETURNING n.*;`, [channels, limit, maxAttempts, notBefore]);
    await client.query("COMMIT");
    return result.rows.map(mapNotification);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function markNotificationDelivered(pool, notificationId, receipt) {
  const result = await pool.query(`
    UPDATE notifications
    SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP,
      next_attempt_at = NULL, last_error = NULL, receipt_json = $2::jsonb
    WHERE id = $1 AND status = 'processing'
    RETURNING *;`, [notificationId, JSON.stringify(receipt || {})]);
  if (!result.rows.length) throw new Error("通知任务状态已变化，无法记录送达结果");
  return mapNotification(result.rows[0]);
}

async function markNotificationFailed(pool, notification, error, options) {
  const maxAttempts = Math.max(1, Math.min(10, Number(options.maxAttempts || 5)));
  const baseSeconds = Math.max(10, Number(options.retryBaseSeconds || 60));
  const maximumSeconds = Math.max(baseSeconds, Number(options.retryMaximumSeconds || 86400));
  const attempts = Math.max(1, Number(notification.attempts || 1));
  const abandoned = attempts >= maxAttempts;
  const retrySeconds = Math.min(maximumSeconds, baseSeconds * (2 ** Math.max(0, attempts - 1)));
  const result = await pool.query(`
    UPDATE notifications
    SET status = $2,
      last_error = $3,
      next_attempt_at = CASE WHEN $2 = 'failed'
        THEN CURRENT_TIMESTAMP + make_interval(secs => $4)
        ELSE NULL END
    WHERE id = $1 AND status = 'processing'
    RETURNING *;`, [notification.id, abandoned ? "abandoned" : "failed", compactError(error), retrySeconds]);
  if (!result.rows.length) throw new Error("通知任务状态已变化，无法记录失败结果");
  return mapNotification(result.rows[0]);
}

async function listNotifications(pool, options = {}) {
  const status = String(options.status || "all");
  if (!new Set(["all", "pending", "processing", "delivered", "failed", "abandoned"]).has(status)) {
    throw new Error("通知状态筛选无效");
  }
  const limit = Math.max(1, Math.min(200, Number(options.limit || 100)));
  const result = await pool.query(`
    SELECT *
    FROM notifications
    WHERE ($1 = 'all' OR status = $1)
    ORDER BY created_at DESC, id DESC
    LIMIT $2;`, [status, limit]);
  const statsResult = await pool.query(`
    SELECT status, COUNT(*)::integer AS count,
      MIN(created_at) AS oldest_created_at,
      MIN(updated_at) AS oldest_updated_at
    FROM notifications
    GROUP BY status;`);
  const stats = { pending: 0, processing: 0, delivered: 0, failed: 0, abandoned: 0 };
  for (const row of statsResult.rows) {
    if (!Object.hasOwn(stats, row.status)) continue;
    stats[row.status] = Number(row.count || 0);
    if (row.status === "pending") stats.oldestPendingAt = row.oldest_created_at || null;
    if (row.status === "failed") stats.oldestFailedAt = row.oldest_created_at || null;
    if (row.status === "processing") stats.oldestProcessingUpdatedAt = row.oldest_updated_at || null;
  }
  const monitor = createNotificationMonitor({ stats, thresholds: options.monitorThresholds, now: options.now });
  return { notifications: result.rows.map(mapNotification).map(publicNotification), stats, monitor };
}

async function retryNotification(pool, notificationId, actorUserId, allowedChannels = ["feishu", "dingtalk"]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT * FROM notifications WHERE id = $1 FOR UPDATE;", [notificationId]);
    if (!locked.rows.length) {
      const error = new Error("未找到通知任务");
      error.statusCode = 404;
      throw error;
    }
    const before = mapNotification(locked.rows[0]);
    if (!allowedChannels.includes(before.channel)) {
      const error = new Error(`通知通道 ${before.channel} 尚未启用，不能人工重发`);
      error.statusCode = 409;
      throw error;
    }
    if (!new Set(["failed", "abandoned"]).has(before.status)) {
      const error = new Error("只有发送失败或已放弃的任务可以人工重发");
      error.statusCode = 409;
      throw error;
    }
    const updated = await client.query(`
      UPDATE notifications
      SET status = 'pending', attempts = 0, last_error = NULL,
        next_attempt_at = CURRENT_TIMESTAMP, delivered_at = NULL,
        receipt_json = '{}'::jsonb
      WHERE id = $1
      RETURNING *;`, [notificationId]);
    await client.query(`
      INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, before_json, after_json)
      VALUES ($1, $2, 'retry_notification', 'notification', $3, $4::jsonb, $5::jsonb);`, [
      crypto.randomUUID(), actorUserId || null, notificationId,
      JSON.stringify({ status: before.status, attempts: before.attempts, lastError: before.lastError }),
      JSON.stringify({ status: "pending", attempts: 0 })
    ]);
    await client.query("COMMIT");
    return publicNotification(mapNotification(updated.rows[0]));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  claimNotifications,
  compactError,
  enqueueNotificationEvents,
  enqueueSubmissionCreated,
  enqueueSubmissionGraded,
  listNotifications,
  listActiveGraderRecipients,
  listActiveUserRecipients,
  mapNotification,
  markNotificationDelivered,
  markNotificationFailed,
  notificationEventKey,
  publicNotification,
  retryNotification
};
