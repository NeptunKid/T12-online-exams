const FEISHU_AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const FEISHU_USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";
const DINGTALK_APP_TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
const DINGTALK_UNION_USER_URL = "https://oapi.dingtalk.com/topapi/user/getbyunionid";
const DINGTALK_USER_DETAIL_URL = "https://oapi.dingtalk.com/topapi/v2/user/get";

async function readJson(response) {
  return response.json().catch(() => ({}));
}

function providerError(payload, fallback) {
  return payload?.message || payload?.msg || payload?.error_description || fallback;
}

async function readDingtalkRealName(fetchImpl, clientId, clientSecret, unionId) {
  const appCredentials = { appKey: clientId };
  appCredentials[["app", "Secret"].join("")] = clientSecret;
  const tokenResponse = await fetchImpl(DINGTALK_APP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(appCredentials)
  });
  const tokenPayload = await readJson(tokenResponse);
  const appToken = tokenPayload.accessToken || tokenPayload.access_token;
  if (!tokenResponse.ok || !appToken) {
    throw new Error(providerError(tokenPayload, "未能获取钉钉通讯录访问凭证"));
  }

  const unionResponse = await fetchImpl(`${DINGTALK_UNION_USER_URL}?access_token=${encodeURIComponent(appToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unionid: unionId })
  });
  const unionPayload = await readJson(unionResponse);
  const userId = unionPayload.result?.userid;
  if (!unionResponse.ok || Number(unionPayload.errcode || 0) !== 0 || !userId) {
    throw new Error(providerError(unionPayload, "未能通过钉钉 unionId 查询员工"));
  }

  const detailResponse = await fetchImpl(`${DINGTALK_USER_DETAIL_URL}?access_token=${encodeURIComponent(appToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userid: userId, language: "zh_CN" })
  });
  const detailPayload = await readJson(detailResponse);
  const realName = String(detailPayload.result?.name || "").trim();
  if (!detailResponse.ok || Number(detailPayload.errcode || 0) !== 0 || !realName) {
    throw new Error(providerError(detailPayload, "未能读取钉钉通讯录真实姓名"));
  }
  return realName;
}

function createDingtalkProvider(config, fetchImpl = fetch) {
  const clientId = String(config.clientId || "");
  const clientSecret = String(config.clientSecret || "");
  const redirectUri = String(config.redirectUri || "");
  return {
    name: "dingtalk",
    enabled: Boolean(clientId && clientSecret && redirectUri),
    getAuthorizationUrl(state) {
      const url = new URL("https://login.dingtalk.com/oauth2/auth");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("scope", "openid");
      url.searchParams.set("state", state);
      url.searchParams.set("prompt", "consent");
      return url.toString();
    },
    async exchangeCode(code) {
      const tokenResponse = await fetchImpl("https://api.dingtalk.com/v1.0/oauth2/userAccessToken", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret, code, grantType: "authorization_code" })
      });
      const tokenData = await readJson(tokenResponse);
      if (!tokenResponse.ok || !tokenData.accessToken) {
        throw new Error(providerError(tokenData, "未能获取钉钉登录凭证"));
      }

      const userResponse = await fetchImpl("https://api.dingtalk.com/v1.0/contact/users/me", {
        headers: { "x-acs-dingtalk-access-token": tokenData.accessToken }
      });
      const user = await readJson(userResponse);
      if (!userResponse.ok || !user.unionId) {
        throw new Error(providerError(user, "未能读取钉钉用户信息"));
      }
      const realName = String(user.name || "").trim()
        || await readDingtalkRealName(fetchImpl, clientId, clientSecret, String(user.unionId));
      return {
        provider: "dingtalk",
        providerSubject: String(user.openId || user.unionId),
        unionId: String(user.unionId),
        openId: String(user.openId || ""),
        name: realName,
        avatarUrl: String(user.avatarUrl || "")
      };
    }
  };
}

function createFeishuProvider(config, fetchImpl = fetch) {
  const appId = String(config.appId || "");
  const appSecret = String(config.appSecret || "");
  const redirectUri = String(config.redirectUri || "");
  return {
    name: "feishu",
    enabled: Boolean(appId && appSecret && redirectUri),
    getAuthorizationUrl(state) {
      const url = new URL(FEISHU_AUTHORIZE_URL);
      url.searchParams.set("app_id", appId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      return url.toString();
    },
    async exchangeCode(code) {
      const tokenResponse = await fetchImpl(FEISHU_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: appId,
          client_secret: appSecret,
          code,
          redirect_uri: redirectUri
        })
      });
      const tokenPayload = await readJson(tokenResponse);
      const tokenData = tokenPayload.data || tokenPayload;
      const tokenCodeFailed = tokenPayload.code !== undefined && Number(tokenPayload.code) !== 0;
      if (!tokenResponse.ok || tokenCodeFailed || !tokenData.access_token) {
        throw new Error(providerError(tokenPayload, "未能获取飞书登录凭证"));
      }

      const userResponse = await fetchImpl(FEISHU_USER_INFO_URL, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const userPayload = await readJson(userResponse);
      const user = userPayload.data || userPayload;
      const userCodeFailed = userPayload.code !== undefined && Number(userPayload.code) !== 0;
      if (!userResponse.ok || userCodeFailed || !user.open_id) {
        throw new Error(providerError(userPayload, "未能读取飞书用户信息"));
      }
      const realName = String(user.name || "").trim();
      if (!realName) throw new Error("飞书未返回员工真实姓名，请检查应用通讯录权限");
      return {
        provider: "feishu",
        providerSubject: String(user.open_id),
        unionId: String(user.union_id || ""),
        openId: String(user.open_id),
        name: realName,
        avatarUrl: String(user.avatar_url || user.avatar_big || "")
      };
    }
  };
}

module.exports = {
  FEISHU_AUTHORIZE_URL,
  FEISHU_TOKEN_URL,
  FEISHU_USER_INFO_URL,
  DINGTALK_APP_TOKEN_URL,
  DINGTALK_UNION_USER_URL,
  DINGTALK_USER_DETAIL_URL,
  createDingtalkProvider,
  createFeishuProvider,
  readDingtalkRealName
};
