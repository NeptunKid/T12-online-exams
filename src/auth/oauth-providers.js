const FEISHU_AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const FEISHU_USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";

async function readJson(response) {
  return response.json().catch(() => ({}));
}

function providerError(payload, fallback) {
  return payload?.message || payload?.msg || payload?.error_description || fallback;
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
      return {
        provider: "dingtalk",
        providerSubject: String(user.openId || user.unionId),
        unionId: String(user.unionId),
        openId: String(user.openId || ""),
        name: String(user.nick || user.name || "钉钉用户").trim() || "钉钉用户",
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
      return {
        provider: "feishu",
        providerSubject: String(user.open_id),
        unionId: String(user.union_id || ""),
        openId: String(user.open_id),
        name: String(user.name || user.en_name || "飞书用户").trim() || "飞书用户",
        avatarUrl: String(user.avatar_url || user.avatar_big || "")
      };
    }
  };
}

module.exports = {
  FEISHU_AUTHORIZE_URL,
  FEISHU_TOKEN_URL,
  FEISHU_USER_INFO_URL,
  createDingtalkProvider,
  createFeishuProvider
};
