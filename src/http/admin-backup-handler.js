const { createZip } = require("../backup/zip-archive");
const { serializeBackupPackage } = require("../backup/export-package");

const MAX_BACKUP_UPLOAD_BYTES = 200 * 1024 * 1024;

class BackupRequestError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "BackupRequestError";
    this.statusCode = statusCode;
  }
}

function isSameOriginMultipartRequest(req) {
  const contentType = String(req.headers?.["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("multipart/form-data;")) return false;
  const origin = String(req.headers?.origin || "").trim();
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === String(req.headers?.host || "").toLowerCase();
  } catch (_) {
    return false;
  }
}

function readRawBody(req, maximum = MAX_BACKUP_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > maximum) {
        rejected = true;
        reject(new BackupRequestError("备份包不能超过 200MB", 413));
        req.destroy?.();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks, size));
    });
    req.on("error", (error) => {
      if (!rejected) reject(error);
    });
  });
}

function multipartBoundary(contentType) {
  const match = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = match?.[1] || match?.[2] || "";
  if (!boundary || boundary.length > 70 || /[\r\n]/.test(boundary)) {
    throw new BackupRequestError("备份上传边界无效");
  }
  return boundary;
}

function parseDisposition(value) {
  const name = value.match(/(?:^|;)\s*name="([^"]+)"/i)?.[1] || "";
  const filename = value.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1] || "";
  return { name, filename };
}

function extractMultipartBackup(body, contentType) {
  const boundary = multipartBoundary(contentType);
  const delimiter = Buffer.from(`--${boundary}`);
  if (!body.subarray(0, delimiter.length).equals(delimiter)) throw new BackupRequestError("备份上传格式无效");
  let cursor = delimiter.length;
  let backup = null;
  let parts = 0;
  while (cursor < body.length) {
    if (body.subarray(cursor, cursor + 2).toString() === "--") {
      cursor += 2;
      if (cursor === body.length || body.subarray(cursor, cursor + 2).toString() === "\r\n") return backup;
      throw new BackupRequestError("备份上传结束标记无效");
    }
    if (body.subarray(cursor, cursor + 2).toString() !== "\r\n") throw new BackupRequestError("备份上传分段无效");
    cursor += 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), cursor);
    if (headerEnd < cursor || headerEnd - cursor > 16 * 1024) throw new BackupRequestError("备份上传头部无效");
    const headers = new Map();
    for (const line of body.subarray(cursor, headerEnd).toString("utf8").split("\r\n")) {
      const separator = line.indexOf(":");
      if (separator < 1) throw new BackupRequestError("备份上传头部无效");
      headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
    const nextBoundary = body.indexOf(Buffer.concat([Buffer.from("\r\n"), delimiter]), headerEnd + 4);
    if (nextBoundary < 0) throw new BackupRequestError("备份上传内容不完整");
    const disposition = parseDisposition(headers.get("content-disposition") || "");
    parts += 1;
    if (parts > 1 || disposition.name !== "backup" || !disposition.filename) {
      throw new BackupRequestError("备份上传只能包含一个 backup 文件");
    }
    backup = {
      filename: disposition.filename,
      contentType: headers.get("content-type") || "application/octet-stream",
      content: Buffer.from(body.subarray(headerEnd + 4, nextBoundary))
    };
    cursor = nextBoundary + 2 + delimiter.length;
  }
  throw new BackupRequestError("备份上传内容不完整");
}

function safeFilename(kind, title) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const readable = String(title || kind).replace(/[\u0000-\u001f\\/:*?"<>|]/g, "-").slice(0, 80) || kind;
  return {
    ascii: `t12-${kind}-${date}.t12backup`,
    encoded: encodeURIComponent(`${readable}-${date}.t12backup`)
  };
}

function createAdminBackupHandler({ repository, getPool, json, readBody = readRawBody }) {
  return async function handleAdminBackup(req, res, pathname, adminAccess) {
    const isExport = req.method === "GET" && pathname === "/api/admin/backups/export";
    const isImport = req.method === "POST" && pathname === "/api/admin/backups/import";
    if (!isExport && !isImport) return false;
    if (!adminAccess?.canManageQuestions) {
      json(res, 403, { error: "当前账号没有备份管理权限" });
      return true;
    }
    const pool = getPool();
    if (!pool) {
      json(res, 503, { error: "备份数据库尚未配置" });
      return true;
    }

    try {
      if (isExport) {
        const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const kind = url.searchParams.get("kind");
        const id = url.searchParams.get("id") || "";
        if (kind !== "exam" && kind !== "question-bank") throw new BackupRequestError("备份类型无效");
        const pkg = kind === "exam"
          ? await repository.exportExam(pool, id)
          : await repository.exportQuestionBank(pool, id);
        if (!pkg) {
          json(res, 404, { error: kind === "exam" ? "未找到试卷" : "未找到题库" });
          return true;
        }
        const archive = createZip([{ name: "backup.json", content: serializeBackupPackage(pkg) }]);
        const title = kind === "exam" ? pkg.exams[0]?.title : pkg.questionBanks[0]?.name;
        const filename = safeFilename(kind, title);
        res.writeHead(200, {
          "Content-Type": "application/vnd.t12.exam-backup+zip",
          "Content-Length": archive.length,
          "Content-Disposition": `attachment; filename="${filename.ascii}"; filename*=UTF-8''${filename.encoded}`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        res.end(archive);
        return true;
      }

      if (!isSameOriginMultipartRequest(req)) throw new BackupRequestError("备份导入请求来源无效", 403);
      const upload = extractMultipartBackup(await readBody(req), req.headers["content-type"]);
      if (!upload?.content.length) throw new BackupRequestError("请选择非空备份包");
      const imported = await repository.importBackupPackage(pool, upload.content, adminAccess.userId);
      json(res, 201, {
        questionBank: imported.questionBanks?.[0] || null,
        exam: imported.exams?.[0] || null,
        summary: { kind: imported.kind, counts: imported.counts }
      });
      return true;
    } catch (error) {
      if (Number.isInteger(error?.statusCode)) json(res, error.statusCode, { error: error.message });
      else json(res, 503, { error: isExport ? "备份导出暂不可用" : "备份导入暂不可用" });
      return true;
    }
  };
}

module.exports = {
  BackupRequestError,
  MAX_BACKUP_UPLOAD_BYTES,
  createAdminBackupHandler,
  extractMultipartBackup,
  isSameOriginMultipartRequest,
  readRawBody,
  safeFilename
};
