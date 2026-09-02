const { previewQuestionCsv } = require("../import/question-csv");
const { loadQuestionResourceManifest } = require("../resources/question-resources");

function extractCsvMultipart(body, contentType) {
  const boundary = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)?.[1] || String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)?.[2];
  if (!boundary || /[\r\n]/.test(boundary)) throw Object.assign(new Error("题库文件上传格式无效"), { statusCode: 400 });
  const marker = `--${boundary}`;
  const text = body.toString("utf8");
  const start = text.indexOf("\r\n\r\n");
  const end = text.lastIndexOf(`\r\n${marker}`);
  if (start < 0 || end < start) throw Object.assign(new Error("题库文件上传内容无效"), { statusCode: 400 });
  return text.slice(start + 4, end);
}

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
    { method: "DELETE", pattern: /^\/api\/admin\/question-banks\/([^/]+)$/, action: "delete" },
    { method: "POST", pattern: /^\/api\/admin\/question-banks\/([^/]+)\/copy$/, action: "copy" },
    { method: "POST", pattern: /^\/api\/admin\/question-banks\/([^/]+)\/archive$/, action: "archive" },
    { method: "POST", pattern: /^\/api\/admin\/question-banks\/([^/]+)\/restore$/, action: "restore" },
    { method: "GET", pattern: /^\/api\/admin\/question-banks\/([^/]+)\/export\.csv$/, action: "export" },
    { method: "POST", pattern: /^\/api\/admin\/question-banks\/([^/]+)\/import\.csv$/, action: "import" }
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
      if (route.action === "export") {
        const csv = await repository.exportQuestionBankCsv(pool, bankId);
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''question-bank-${encodeURIComponent(bankId)}.csv`, "Cache-Control": "no-store" });
        res.end(`\uFEFF${csv}`);
        return true;
      }
      if (route.action === "import") {
        // Boundary 参数大小写敏感，不能把整个 Content-Type 转小写。
        const contentType = String(req.headers["content-type"] || "");
        const origin = String(req.headers.origin || "").trim();
        if (origin) { try { if (new URL(origin).host.toLowerCase() !== String(req.headers.host || "").toLowerCase()) throw new Error(); } catch (_) { json(res, 403, { error: "题库上传请求来源无效" }); return true; } }
        if (!contentType.toLowerCase().startsWith("multipart/form-data;")) { json(res, 400, { error: "请上传 CSV 文件" }); return true; }
        const csv = extractCsvMultipart(await new Promise((resolve, reject) => {
          const chunks = []; let size = 0;
          req.on("data", (chunk) => { size += chunk.length; if (size > 12 * 1024 * 1024) { reject(Object.assign(new Error("题库文件不能超过 12MB"), { statusCode: 413 })); req.destroy?.(); return; } chunks.push(Buffer.from(chunk)); });
          req.on("end", () => resolve(Buffer.concat(chunks))); req.on("error", reject);
        }), contentType);
        let preview;
        try {
          preview = previewQuestionCsv(csv, { allowedResourceIds: Object.keys(loadQuestionResourceManifest()) });
        } catch (error) {
          json(res, 400, { error: error.message || "CSV 格式无效" });
          return true;
        }
        if (!preview.canCommit) { json(res, 400, { error: "CSV 校验未通过", preview }); return true; }
        const result = await repository.importQuestionBankCsv(pool, bankId, preview.questions, adminAccess.userId);
        json(res, 200, { ...result, preview: { totalRows: preview.totalRows, validRows: preview.validRows, skippedRows: preview.skippedRows } });
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
      } else if (route.action === "delete") {
        bank = await repository.deleteQuestionBank(pool, bankId, body, adminAccess.userId);
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
  createAdminQuestionBankHandler,
  extractCsvMultipart
};
