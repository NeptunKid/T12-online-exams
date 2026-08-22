function createAdminOrganizationHandler({
  listOrganizationDirectory,
  syncOrganizationDirectory,
  syncProviders,
  getPool,
  readBody,
  json,
  isSameOriginJsonRequest
}) {
  return async function handleAdminOrganization(req, res, pathname, adminAccess) {
    if (pathname !== "/api/admin/organization/directory"
        && pathname !== "/api/admin/organization/sync") return false;
    if (!adminAccess?.canManageQuestions) {
      json(res, 403, { error: "当前账号没有组织目录查看权限" });
      return true;
    }
    const pool = getPool();
    if (!pool) {
      json(res, 503, { error: "组织目录数据库尚未配置" });
      return true;
    }
    try {
      if (req.method === "GET" && pathname === "/api/admin/organization/directory") {
        json(res, 200, { directory: await listOrganizationDirectory(pool) });
        return true;
      }
      if (req.method !== "POST" || pathname !== "/api/admin/organization/sync") return false;
      if (!adminAccess.canManageAdmins) {
        json(res, 403, { error: "只有系统管理员可以同步组织目录" });
        return true;
      }
      if (!isSameOriginJsonRequest(req)) {
        json(res, 403, { error: "组织目录同步请求来源无效" });
        return true;
      }
      const body = await readBody(req);
      const provider = String(body.provider || "").trim();
      const sync = syncProviders[provider];
      if (!sync) {
        json(res, 400, { error: "组织目录来源未配置" });
        return true;
      }
      const directory = await sync();
      const result = await syncOrganizationDirectory(pool, directory, adminAccess.userId);
      json(res, 200, { result, directory: await listOrganizationDirectory(pool) });
      return true;
    } catch (error) {
      json(res, Number.isInteger(error?.statusCode) ? error.statusCode : 503, {
        error: Number.isInteger(error?.statusCode) ? error.message : "组织目录同步服务暂不可用"
      });
      return true;
    }
  };
}

module.exports = { createAdminOrganizationHandler };
