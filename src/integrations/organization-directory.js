const DINGTALK_TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
const DINGTALK_DEPARTMENT_URL = "https://oapi.dingtalk.com/topapi/v2/department/listsub";
const DINGTALK_USER_URL = "https://oapi.dingtalk.com/topapi/v2/user/list";
const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const FEISHU_DEPARTMENT_URL = "https://open.feishu.cn/open-apis/contact/v3/departments";
const FEISHU_USER_URL = "https://open.feishu.cn/open-apis/contact/v3/users";

async function readJson(response) {
  return response.json().catch(() => ({}));
}

function providerError(payload, fallback) {
  return payload?.message || payload?.msg || payload?.errmsg || fallback;
}

function ensureResponse(response, payload, fallback) {
  if (!response.ok || (payload.code !== undefined && Number(payload.code) !== 0)
      || (payload.errcode !== undefined && Number(payload.errcode) !== 0)) {
    throw new Error(providerError(payload, fallback));
  }
}

function extractDingtalkDepartments(payload) {
  const result = payload?.result || payload?.department || [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.dept_id_list)) return result.dept_id_list;
  if (Array.isArray(result.department_list)) return result.department_list;
  if (Array.isArray(result.list)) return result.list;
  return [];
}

function directorySyncError(provider, kind = "remote") {
  const label = provider === "dingtalk" ? "钉钉" : "飞书";
  const error = new Error(kind === "config"
    ? `${label}通讯录同步未配置，请检查登录应用凭证`
    : kind === "empty"
    ? `${label}通讯录未读取到部门或人员，请检查应用通讯录权限和可见范围`
    : `${label}通讯录接口拒绝访问，请在开放平台开通通讯录读取权限后重试`);
  error.statusCode = kind === "config" ? 503 : 502;
  return error;
}

async function getDingtalkToken(fetchImpl, clientId, clientSecret) {
  const tokenRequest = { appKey: clientId };
  tokenRequest[["app", "Secret"].join("")] = clientSecret;
  const response = await fetchImpl(DINGTALK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tokenRequest)
  });
  const payload = await readJson(response);
  ensureResponse(response, payload, "未能获取钉钉通讯录访问凭证");
  const token = payload.accessToken || payload.access_token;
  if (!token) throw new Error("钉钉通讯录没有返回访问凭证");
  return token;
}

async function readDingtalkDepartments(fetchImpl, token, parentId, parentExternalId = null, output = []) {
  const response = await fetchImpl(`${DINGTALK_DEPARTMENT_URL}?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dept_id: parentId })
  });
  const payload = await readJson(response);
  ensureResponse(response, payload, "未能读取钉钉部门目录");
  const departments = extractDingtalkDepartments(payload);
  for (const item of departments) {
    const externalId = String(item.dept_id ?? item.id ?? "").trim();
    if (!externalId) continue;
    output.push({
      provider: "dingtalk",
      externalId,
      name: String(item.name || "").trim() || externalId,
      parentExternalId
    });
    await readDingtalkDepartments(fetchImpl, token, externalId, externalId, output);
  }
  return output;
}

async function readDingtalkUsers(fetchImpl, token, departments) {
  const users = [];
  for (const department of departments) {
    let cursor = 0;
    do {
      const response = await fetchImpl(`${DINGTALK_USER_URL}?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dept_id: Number(department.externalId) || department.externalId, cursor, size: 100, language: "zh_CN" })
      });
      const payload = await readJson(response);
      ensureResponse(response, payload, "未能读取钉钉人员目录");
      const result = payload.result || {};
      for (const item of Array.isArray(result.list) ? result.list : []) {
        const providerSubject = String(item.userid || item.unionid || "").trim();
        if (!providerSubject) continue;
        const existing = users.find((user) => user.providerSubject === providerSubject);
        const departmentIds = Array.isArray(item.dept_id_list) ? item.dept_id_list.map(String) : [department.externalId];
        if (existing) existing.departmentExternalIds = [...new Set([...existing.departmentExternalIds, ...departmentIds])];
        else users.push({
          provider: "dingtalk",
          providerSubject,
          unionId: String(item.unionid || "").trim(),
          openId: String(item.userid || "").trim(),
          name: String(item.name || "").trim() || providerSubject,
          employeeNo: String(item.job_number || "").trim(),
          departmentExternalIds: [...new Set(departmentIds)]
        });
      }
      const nextCursor = result.next_cursor;
      cursor = Number.isFinite(Number(nextCursor)) ? Number(nextCursor) : 0;
      if (!result.has_more) break;
    } while (true);
  }
  return users;
}

async function syncDingtalkDirectory(config, fetchImpl = fetch) {
  const clientId = String(config.clientId || "");
  const clientSecret = String(config.clientSecret || "");
  if (!clientId || !clientSecret) throw directorySyncError("dingtalk", "config");
  try {
    const token = await getDingtalkToken(fetchImpl, clientId, clientSecret);
    const departments = await readDingtalkDepartments(fetchImpl, token, 1);
    const users = await readDingtalkUsers(fetchImpl, token, departments);
    return { provider: "dingtalk", departments, users };
  } catch (error) {
    throw error?.statusCode ? error : directorySyncError("dingtalk");
  }
}

async function getFeishuToken(fetchImpl, appId, appSecret) {
  const response = await fetchImpl(FEISHU_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const payload = await readJson(response);
  ensureResponse(response, payload, "未能获取飞书通讯录访问凭证");
  const data = payload.data || payload;
  if (!data.tenant_access_token) throw new Error("飞书通讯录没有返回访问凭证");
  return data.tenant_access_token;
}

async function feishuGet(fetchImpl, token, baseUrl, params) {
  const url = new URL(baseUrl);
  Object.entries(params || {}).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const payload = await readJson(response);
  ensureResponse(response, payload, "未能读取飞书通讯录");
  return payload.data || payload;
}

async function readFeishuDepartments(fetchImpl, token, parentExternalId = "0", output = []) {
  let pageToken = "";
  do {
    const data = await feishuGet(fetchImpl, token, FEISHU_DEPARTMENT_URL, {
      parent_department_id: parentExternalId,
      department_id_type: "open_department_id",
      page_size: 50,
      ...(pageToken ? { page_token: pageToken } : {})
    });
    for (const item of Array.isArray(data.items) ? data.items : []) {
      const externalId = String(item.department_id || item.open_department_id || item.id || "").trim();
      if (!externalId) continue;
      output.push({ provider: "feishu", externalId, name: String(item.name || externalId).trim(), parentExternalId });
      await readFeishuDepartments(fetchImpl, token, externalId, output);
    }
    pageToken = data.has_more ? String(data.page_token || "") : "";
  } while (pageToken);
  return output;
}

async function readFeishuUsers(fetchImpl, token, departments) {
  const users = [];
  const scopes = departments.length ? departments : [null];
  for (const department of scopes) {
    let pageToken = "";
    do {
      const data = await feishuGet(fetchImpl, token, FEISHU_USER_URL, {
        ...(department ? {
          department_id: department.externalId,
          department_id_type: "open_department_id"
        } : {}),
        page_size: 50,
        user_id_type: "open_id",
        ...(pageToken ? { page_token: pageToken } : {})
      });
      for (const item of Array.isArray(data.items) ? data.items : []) {
        const providerSubject = String(item.open_id || item.user_id || "").trim();
        if (!providerSubject) continue;
        const existing = users.find((user) => user.providerSubject === providerSubject);
        if (existing) existing.departmentExternalIds = [...new Set([...existing.departmentExternalIds, department.externalId])];
        else users.push({
          provider: "feishu", providerSubject, openId: providerSubject,
          unionId: String(item.union_id || "").trim(), name: String(item.name || providerSubject).trim(),
          employeeNo: String(item.employee_no || "").trim(), departmentExternalIds: department ? [department.externalId] : []
        });
      }
      pageToken = data.has_more ? String(data.page_token || "") : "";
    } while (pageToken);
  }
  return users;
}

async function syncFeishuDirectory(config, fetchImpl = fetch) {
  const appId = String(config.appId || "");
  const appSecret = String(config.appSecret || "");
  if (!appId || !appSecret) throw directorySyncError("feishu", "config");
  try {
    const token = await getFeishuToken(fetchImpl, appId, appSecret);
    const departments = await readFeishuDepartments(fetchImpl, token);
    const users = await readFeishuUsers(fetchImpl, token, departments);
    if (!departments.length && !users.length) throw directorySyncError("feishu", "empty");
    return { provider: "feishu", departments, users };
  } catch (error) {
    throw error?.statusCode ? error : directorySyncError("feishu");
  }
}

module.exports = {
  DINGTALK_TOKEN_URL,
  DINGTALK_DEPARTMENT_URL,
  DINGTALK_USER_URL,
  FEISHU_TOKEN_URL,
  FEISHU_DEPARTMENT_URL,
  FEISHU_USER_URL,
  extractDingtalkDepartments,
  syncDingtalkDirectory,
  syncFeishuDirectory
};
