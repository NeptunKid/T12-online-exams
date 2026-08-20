const FEISHU_APP_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal";
const FEISHU_MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id";
const DINGTALK_APP_TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
const DINGTALK_UNION_USER_URL = "https://oapi.dingtalk.com/topapi/user/getbyunionid";
const DINGTALK_MESSAGE_URL = "https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2";

async function readJson(response) {
  return response.json().catch(() => ({}));
}

function compactProviderError(payload, fallback) {
  return String(payload?.msg || payload?.message || payload?.error_description || fallback)
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

function formatNotificationText(notification, publicBaseUrl) {
  const payload = notification.payload || {};
  if (notification.eventType === "submission.created") {
    return [
      "【待批阅提醒】",
      `考试：${payload.examTitle || "未命名考试"}`,
      `考生：${payload.studentName || "学员"}`,
      `提交时间：${payload.submittedAt || "-"}`,
      `进入管理员后台：${publicBaseUrl}/admin`
    ].join("\n");
  }
  if (notification.eventType === "submission.graded") {
    return [
      "【考试结果】",
      `考试：${payload.examTitle || "未命名考试"}`,
      `考生：${payload.studentName || "学员"}`,
      `成绩：${payload.totalScore ?? "-"}`,
      `通过线：${payload.passScore ?? "-"}`,
      `结果：${payload.pass ? "通过" : "未通过"}`,
      `查看详情：${publicBaseUrl}/`
    ].join("\n");
  }
  throw new Error(`不支持的通知事件：${notification.eventType}`);
}

function createFeishuNotificationTransport(config, fetchImpl = fetch, now = () => new Date()) {
  const appId = String(config.appId || "");
  const appSecret = String(config.appSecret || "");
  const publicBaseUrl = String(config.publicBaseUrl || "");
  if (!appId || !appSecret) throw new Error("飞书通知需要 FEISHU_APP_ID 和 FEISHU_APP_SECRET");
  let token = "";
  let tokenExpiresAt = 0;

  async function accessToken() {
    if (token && tokenExpiresAt > now().getTime() + 60_000) return token;
    const response = await fetchImpl(FEISHU_APP_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    });
    const payload = await readJson(response);
    if (!response.ok || Number(payload.code || 0) !== 0 || !payload.tenant_access_token) {
      throw new Error(compactProviderError(payload, "飞书应用凭证获取失败"));
    }
    token = payload.tenant_access_token;
    tokenExpiresAt = now().getTime() + Math.max(60, Number(payload.expire || 7200)) * 1000;
    return token;
  }

  return {
    channel: "feishu",
    async send(notification) {
      const response = await fetchImpl(FEISHU_MESSAGE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
          receive_id: notification.recipient,
          msg_type: "text",
          content: JSON.stringify({ text: formatNotificationText(notification, publicBaseUrl) })
        })
      });
      const payload = await readJson(response);
      if (!response.ok || Number(payload.code || 0) !== 0) {
        throw new Error(compactProviderError(payload, "飞书消息发送失败"));
      }
      return {
        provider: "feishu",
        messageId: String(payload.data?.message_id || ""),
        sentAt: now().toISOString()
      };
    }
  };
}

function createDingtalkNotificationTransport(config, fetchImpl = fetch, now = () => new Date()) {
  const appKey = String(config.appKey || "");
  const appSecret = String(config.appSecret || "");
  const agentId = String(config.agentId || "");
  const publicBaseUrl = String(config.publicBaseUrl || "");
  if (!appKey || !appSecret || !agentId) {
    throw new Error("钉钉通知需要消息应用 AppKey、AppSecret 和 AgentId");
  }
  let token = "";
  let tokenExpiresAt = 0;

  async function accessToken() {
    if (token && tokenExpiresAt > now().getTime() + 60_000) return token;
    const response = await fetchImpl(DINGTALK_APP_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appKey, appSecret })
    });
    const payload = await readJson(response);
    const nextToken = payload.accessToken || payload.access_token;
    if (!response.ok || !nextToken) throw new Error(compactProviderError(payload, "钉钉应用凭证获取失败"));
    token = nextToken;
    tokenExpiresAt = now().getTime() + Math.max(60, Number(payload.expireIn || payload.expire || 7200)) * 1000;
    return token;
  }

  async function resolveUserId(unionId, appToken) {
    const response = await fetchImpl(`${DINGTALK_UNION_USER_URL}?access_token=${encodeURIComponent(appToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unionid: unionId })
    });
    const payload = await readJson(response);
    const userId = payload.result?.userid;
    if (!response.ok || Number(payload.errcode || 0) !== 0 || !userId) {
      throw new Error(compactProviderError(payload, "钉钉收件人解析失败"));
    }
    return String(userId);
  }

  return {
    channel: "dingtalk",
    async send(notification) {
      const appToken = await accessToken();
      const userId = await resolveUserId(notification.recipient, appToken);
      const response = await fetchImpl(`${DINGTALK_MESSAGE_URL}?access_token=${encodeURIComponent(appToken)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId,
          userid_list: userId,
          msg: { msgtype: "text", text: { content: formatNotificationText(notification, publicBaseUrl) } }
        })
      });
      const payload = await readJson(response);
      if (!response.ok || Number(payload.errcode || 0) !== 0) {
        throw new Error(compactProviderError(payload, "钉钉消息发送失败"));
      }
      return {
        provider: "dingtalk",
        taskId: String(payload.task_id || payload.taskId || ""),
        sentAt: now().toISOString()
      };
    }
  };
}

module.exports = {
  FEISHU_APP_TOKEN_URL,
  FEISHU_MESSAGE_URL,
  DINGTALK_APP_TOKEN_URL,
  DINGTALK_UNION_USER_URL,
  DINGTALK_MESSAGE_URL,
  createDingtalkNotificationTransport,
  createFeishuNotificationTransport,
  formatNotificationText
};
