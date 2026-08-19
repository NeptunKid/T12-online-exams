const assert = require("node:assert/strict");
const test = require("node:test");
const {
  FEISHU_APP_TOKEN_URL,
  FEISHU_MESSAGE_URL,
  DINGTALK_APP_TOKEN_URL,
  DINGTALK_UNION_USER_URL,
  DINGTALK_MESSAGE_URL,
  createDingtalkNotificationTransport,
  createFeishuNotificationTransport,
  formatNotificationText
} = require("../src/notifications/notification-transports");

function jsonResponse(payload, ok = true) {
  return { ok, async json() { return payload; } };
}

test("通知文本只包含必要摘要和站内入口", () => {
  const created = formatNotificationText({
    eventType: "submission.created",
    payload: { examTitle: "测试考试", studentName: "学员甲", submittedAt: "2026-08-17T00:00:00Z", answers: { q1: "A" } }
  }, "https://exam.test");
  assert.match(created, /待批阅提醒/);
  assert.match(created, /https:\/\/exam\.test\/admin/);
  assert.doesNotMatch(created, /q1|答案|"A"/);
  const graded = formatNotificationText({
    eventType: "submission.graded",
    payload: { examTitle: "测试考试", studentName: "学员甲", totalScore: 86, passScore: 60, pass: true }
  }, "https://exam.test");
  assert.match(graded, /考生：学员甲/);
  assert.match(graded, /成绩：86/);
  assert.match(graded, /结果：通过/);
});

test("飞书 transport 获取应用凭证后按 open_id 发送文本并返回回执", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === FEISHU_APP_TOKEN_URL) return jsonResponse({ code: 0, tenant_access_token: "token-private", expire: 7200 });
    assert.equal(url, FEISHU_MESSAGE_URL);
    return jsonResponse({ code: 0, data: { message_id: "message-1" } });
  };
  const transport = createFeishuNotificationTransport({
    appId: "app-id", appSecret: "app-secret", publicBaseUrl: "https://exam.test"
  }, fetchImpl, () => new Date("2026-08-17T01:00:00Z"));
  const receipt = await transport.send({
    eventType: "submission.graded", recipient: "ou-user",
    payload: { examTitle: "测试考试", totalScore: 90, passScore: 60, pass: true }
  });
  assert.deepEqual(receipt, { provider: "feishu", messageId: "message-1", sentAt: "2026-08-17T01:00:00.000Z" });
  const sent = JSON.parse(calls[1].options.body);
  assert.equal(sent.receive_id, "ou-user");
  assert.equal(sent.msg_type, "text");
  assert.match(calls[1].options.headers.Authorization, /^Bearer /);
  assert.equal(calls[1].options.body.includes("app-secret"), false);
});

test("飞书 API 错误只抛出受限平台消息", async () => {
  const fetchImpl = async (url) => url === FEISHU_APP_TOKEN_URL
    ? jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 })
    : jsonResponse({ code: 230001, msg: "user not in app" }, false);
  const transport = createFeishuNotificationTransport({ appId: "id", appSecret: "secret", publicBaseUrl: "https://exam.test" }, fetchImpl);
  await assert.rejects(transport.send({ eventType: "submission.created", recipient: "ou", payload: {} }), /user not in app/);
});

test("钉钉 transport 按 unionId 解析 userid 并发送工作通知", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === DINGTALK_APP_TOKEN_URL) return jsonResponse({ accessToken: "app-token", expireIn: 7200 });
    if (url.startsWith(DINGTALK_UNION_USER_URL)) return jsonResponse({ errcode: 0, result: { userid: "userid-1" } });
    assert.equal(url.startsWith(DINGTALK_MESSAGE_URL), true);
    return jsonResponse({ errcode: 0, task_id: 12345 });
  };
  const transport = createDingtalkNotificationTransport({
    appKey: "app-key", appSecret: "app-secret", agentId: "agent-1", publicBaseUrl: "https://exam.test"
  }, fetchImpl, () => new Date("2026-08-20T01:00:00Z"));
  const receipt = await transport.send({
    eventType: "submission.graded", recipient: "union-1",
    payload: { examTitle: "测试考试", studentName: "学员甲", totalScore: 90, passScore: 60, pass: true }
  });
  assert.deepEqual(receipt, { provider: "dingtalk", taskId: "12345", sentAt: "2026-08-20T01:00:00.000Z" });
  const body = JSON.parse(calls[2].options.body);
  assert.equal(body.agent_id, "agent-1");
  assert.equal(body.userid_list, "userid-1");
  assert.match(body.msg.text.content, /考生：学员甲/);
});
