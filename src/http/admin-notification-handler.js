class NotificationRequestError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "NotificationRequestError";
    this.statusCode = statusCode;
  }
}

function createAdminNotificationHandler({
  repository,
  getPool,
  json,
  worker,
  publicConfig,
  isSameOriginJsonRequest
}) {
  return async function handleAdminNotification(req, res, pathname, adminAccess) {
    const isList = req.method === "GET" && pathname === "/api/admin/notifications";
    const retryMatch = req.method === "POST" && pathname.match(/^\/api\/admin\/notifications\/([^/]+)\/retry$/);
    if (!isList && !retryMatch) return false;
    if (!adminAccess?.canManageAdmins) {
      json(res, 403, { error: "当前账号没有通知管理权限" });
      return true;
    }
    const pool = getPool();
    if (!pool) {
      json(res, 503, { error: "通知数据库尚未配置" });
      return true;
    }
    try {
      if (isList) {
        const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const result = await repository.listNotifications(pool, {
          status: url.searchParams.get("status") || "all",
          limit: url.searchParams.get("limit") || 100,
          monitorThresholds: publicConfig
        });
        json(res, 200, {
          ...result,
          notifications: result.notifications.map((item) => ({
            ...item,
            retryable: Boolean(publicConfig.enabled
              && publicConfig.channels.includes(item.channel)
              && ["failed", "abandoned"].includes(item.status))
          })),
          worker: { ...publicConfig, ...worker.status() }
        });
        return true;
      }
      if (!isSameOriginJsonRequest(req)) throw new NotificationRequestError("通知重发请求来源无效", 403);
      const notification = await repository.retryNotification(
        pool,
        decodeURIComponent(retryMatch[1]),
        adminAccess.userId,
        publicConfig.enabled ? publicConfig.channels : []
      );
      worker.wake();
      json(res, 202, { notification });
      return true;
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 503;
      json(res, status, { error: status === 503 ? "通知服务暂不可用" : error.message });
      return true;
    }
  };
}

module.exports = { NotificationRequestError, createAdminNotificationHandler };
