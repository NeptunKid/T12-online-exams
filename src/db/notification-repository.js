const crypto = require("node:crypto");

function notificationEventKey(eventType, resourceId, channel, recipient) {
  return `${eventType}:${resourceId}:${channel}:${recipient}`;
}

function supportedRecipient(row) {
  return (row.provider === "dingtalk" || row.provider === "feishu") && Boolean(row.provider_subject);
}

async function listActiveGraderRecipients(queryable) {
  const result = await queryable.query(`
    SELECT DISTINCT ui.provider, ui.provider_subject
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
    .map((row) => ({ channel: row.provider, recipient: row.provider_subject }));
}

async function listActiveUserRecipients(queryable, userId) {
  if (!userId) return [];
  const result = await queryable.query(`
    SELECT DISTINCT ui.provider, ui.provider_subject
    FROM users u
    JOIN user_identities ui ON ui.user_id = u.id
    WHERE u.id = $1
      AND u.status = 'active'
      AND ui.provider IN ('dingtalk', 'feishu')
      AND ui.provider_subject <> ''
    ORDER BY ui.provider, ui.provider_subject;`, [userId]);
  return result.rows
    .filter(supportedRecipient)
    .map((row) => ({ channel: row.provider, recipient: row.provider_subject }));
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
  const recipients = await listActiveUserRecipients(queryable, input.userId);
  return enqueueNotificationEvents(queryable, "submission.graded", input.submissionId, recipients, {
    submissionId: input.submissionId,
    examId: input.examId,
    examTitle: input.examTitle,
    totalScore: input.totalScore,
    passScore: input.passScore,
    pass: Boolean(input.pass),
    gradedAt: input.gradedAt,
    kind: "student"
  });
}

module.exports = {
  enqueueNotificationEvents,
  enqueueSubmissionCreated,
  enqueueSubmissionGraded,
  listActiveGraderRecipients,
  listActiveUserRecipients,
  notificationEventKey
};
