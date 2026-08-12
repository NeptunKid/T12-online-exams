function createAdminQuestionBankHandler({
  repository,
  getPool,
  readBody,
  json,
  isSameOriginJsonRequest
}) {
  const routes = [
    { method: "GET", pattern: /^\/api\/admin\/question-banks$/, action: "list" },
    { method: "POST", pattern: /^\/api\/admin\/question-banks$/, action: "create" },
    { method: "PATCH", pattern: /^\/api\/admin\/question-banks\/([^/]+)$/, action: "update" },
    { method: "POST", pattern: /^\/api\/admin\/question-banks\/([^/]+)\/copy$/, action: "copy" },
    { method: "POST", pattern: /^\/api\/admin\/question-banks\/([^/]+)\/archive$/, action: "archive" },
    { method: "POST", pattern: /^\/api\/admin\/question-banks\/([^/]+)\/restore$/, action: "restore" }
  ];

  return async function handleAdminQuestionBank(req, res, pathname, adminAccess) {
    const route = routes.find((candidate) => candidate.method === req.method && candidate.pattern.test(pathname));
    if (!route) return false;
    if (!adminAccess?.canManageQuestions) {
      json(res, 403, { error: "当前账号没有题库维护权限" });
      return true;
    }

    const pool = getPool();
    if (!pool) {
      json(res, 503, { error: "题库数据库尚未配置" });
      return true;
    }

    const match = pathname.match(route.pattern);
    const bankId = match?.[1] ? decodeURIComponent(match[1]) : "";
    try {
      if (route.action === "list") {
        json(res, 200, { banks: await repository.listManagedQuestionBanks(pool) });
        return true;
      }
      if (!isSameOriginJsonRequest(req)) {
        json(res, 403, { error: "题库修改请求来源无效" });
        return true;
      }
      const body = await readBody(req);
      let bank;
      if (route.action === "create") {
        bank = await repository.createQuestionBank(pool, body, adminAccess.userId);
      } else if (route.action === "update") {
        bank = await repository.updateQuestionBank(pool, bankId, body, adminAccess.userId);
      } else if (route.action === "copy") {
        bank = await repository.copyQuestionBank(pool, bankId, body, adminAccess.userId);
      } else if (route.action === "archive") {
        bank = await repository.archiveQuestionBank(pool, bankId, body, adminAccess.userId);
      } else {
        bank = await repository.restoreQuestionBank(pool, bankId, body, adminAccess.userId);
      }
      json(res, route.action === "create" ? 201 : 200, { bank });
      return true;
    } catch (error) {
      if (Number.isInteger(error?.statusCode)) {
        json(res, error.statusCode, { error: error.message });
      } else if (error?.message === "JSON 格式错误" || error?.message === "请求内容过大") {
        json(res, 400, { error: error.message });
      } else {
        json(res, 503, { error: "题库维护服务暂不可用" });
      }
      return true;
    }
  };
}

module.exports = {
  createAdminQuestionBankHandler
};
