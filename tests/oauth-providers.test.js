const assert = require("node:assert/strict");
const test = require("node:test");
const { createDingtalkProvider, createFeishuProvider } = require("../src/auth/oauth-providers");

function response(body, ok = true) {
  return { ok, json: async () => body };
}

test("OAuth providers create state-bound authorization URLs without secrets", () => {
  const dingtalk = createDingtalkProvider({ clientId: "ding-id", clientSecret: "ding-secret", redirectUri: "https://exam.test/auth/dingtalk/callback" });
  const feishu = createFeishuProvider({ appId: "fei-id", appSecret: "fei-secret", redirectUri: "https://exam.test/auth/feishu/callback" });
  const dingUrl = new URL(dingtalk.getAuthorizationUrl("state-1"));
  const feiUrl = new URL(feishu.getAuthorizationUrl("state-2"));

  assert.equal(dingtalk.enabled, true);
  assert.equal(dingUrl.searchParams.get("state"), "state-1");
  assert.equal(dingUrl.searchParams.get("client_id"), "ding-id");
  assert.equal(dingUrl.toString().includes("ding-secret"), false);
  assert.equal(feishu.enabled, true);
  assert.equal(feiUrl.searchParams.get("state"), "state-2");
  assert.equal(feiUrl.searchParams.get("app_id"), "fei-id");
  assert.equal(feiUrl.toString().includes("fei-secret"), false);
});

test("DingTalk provider exchanges code and normalizes user identity", async () => {
  const calls = [];
  const provider = createDingtalkProvider({ clientId: "id", clientSecret: "secret", redirectUri: "https://exam.test/ding" }, async (url, options) => {
    calls.push({ url, options });
    if (url.includes("userAccessToken")) return response({ accessToken: "access" });
    return response({ unionId: "union-1", openId: "open-1", name: "钉钉真实姓名", nick: "平台昵称", avatarUrl: "https://avatar.test/ding" });
  });

  const user = await provider.exchangeCode("code-1");

  assert.deepEqual(user, {
    provider: "dingtalk", providerSubject: "open-1", unionId: "union-1", openId: "open-1",
    name: "钉钉真实姓名", avatarUrl: "https://avatar.test/ding"
  });
  assert.equal(JSON.parse(calls[0].options.body).code, "code-1");
});

test("DingTalk provider reads the enterprise directory name instead of the OAuth nickname", async () => {
  const provider = createDingtalkProvider({ clientId: "id", clientSecret: "secret", redirectUri: "https://exam.test/ding" }, async (url) => {
    if (url.includes("userAccessToken")) return response({ accessToken: "user-access" });
    if (url.includes("contact/users/me")) return response({ unionId: "union-2", openId: "open-2", nick: "Neptun Fox" });
    if (url.includes("oauth2/accessToken")) return response({ accessToken: "app-access" });
    if (url.includes("getbyunionid")) return response({ errcode: 0, result: { userid: "staff-2" } });
    if (url.includes("user/get")) return response({ errcode: 0, result: { name: "员工真实姓名" } });
    throw new Error(`Unexpected URL: ${url}`);
  });

  const user = await provider.exchangeCode("code-2");
  assert.equal(user.name, "员工真实姓名");
});

test("Feishu provider exchanges OAuth v2 code and reads current user", async () => {
  const calls = [];
  const provider = createFeishuProvider({ appId: "app-id", appSecret: "app-secret", redirectUri: "https://exam.test/fei" }, async (url, options) => {
    calls.push({ url, options });
    if (url.includes("oauth/token")) return response({ code: 0, access_token: "access" });
    return response({ code: 0, data: { open_id: "ou_open", union_id: "on_union", name: "飞书员工", avatar_url: "https://avatar.test/fei" } });
  });

  const user = await provider.exchangeCode("code-2");

  assert.deepEqual(user, {
    provider: "feishu", providerSubject: "ou_open", unionId: "on_union", openId: "ou_open",
    name: "飞书员工", avatarUrl: "https://avatar.test/fei"
  });
  assert.equal(JSON.parse(calls[0].options.body).client_secret, "app-secret");
  assert.equal(calls[1].options.headers.Authorization, "Bearer access");
});
