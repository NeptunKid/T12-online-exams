const crypto = require("node:crypto");

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

class QuestionResourceError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "QuestionResourceError";
    this.statusCode = statusCode;
  }
}

function normalizeMimeType(value) {
  const mimeType = String(value || "").trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new QuestionResourceError("只允许上传 JPEG、PNG 或 WebP 图片");
  }
  return mimeType;
}

function decodeStrictBase64(value) {
  if (typeof value !== "string" || !value) {
    throw new QuestionResourceError("图片内容不能为空");
  }
  if (value.length > Math.ceil(MAX_IMAGE_SIZE_BYTES / 3) * 4) {
    throw new QuestionResourceError("单张图片不能超过 5MB");
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new QuestionResourceError("图片内容不是有效的 Base64 数据");
  }
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) {
    throw new QuestionResourceError("图片内容不是有效的 Base64 数据");
  }
  return content;
}

function detectImageMimeType(content) {
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return "image/jpeg";
  }
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
  ]))) {
    return "image/png";
  }
  if (
    content.length >= 12
    && content.subarray(0, 4).toString("ascii") === "RIFF"
    && content.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "";
}

function validateAndDecodeUpload(input) {
  const mimeType = normalizeMimeType(input?.mimeType);
  const hasBase64 = typeof input?.base64 === "string";
  const hasDataUrl = typeof input?.dataUrl === "string";
  if (hasBase64 === hasDataUrl) {
    throw new QuestionResourceError("必须且只能提供一种图片内容格式");
  }

  let encoded = input.base64;
  if (hasDataUrl) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(input.dataUrl);
    if (!match) throw new QuestionResourceError("图片 Data URL 格式无效");
    const dataUrlMimeType = normalizeMimeType(match[1]);
    if (dataUrlMimeType !== mimeType) {
      throw new QuestionResourceError("图片声明的 MIME 类型不一致");
    }
    encoded = match[2];
  }

  const content = decodeStrictBase64(encoded);
  if (content.length === 0) throw new QuestionResourceError("图片内容不能为空");
  if (content.length > MAX_IMAGE_SIZE_BYTES) {
    throw new QuestionResourceError("单张图片不能超过 5MB");
  }
  const detectedMimeType = detectImageMimeType(content);
  if (!detectedMimeType) {
    throw new QuestionResourceError("文件内容不是受支持的图片格式");
  }
  if (detectedMimeType !== mimeType) {
    throw new QuestionResourceError("图片内容与声明的 MIME 类型不一致");
  }

  return {
    mimeType,
    content,
    sizeBytes: content.length,
    sha256: crypto.createHash("sha256").update(content).digest("hex")
  };
}

function mapResourceMetadata(row) {
  return {
    id: row.id,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

async function createQuestionResource(pool, input, actorUserId) {
  const actorId = String(actorUserId || "").trim();
  if (!actorId) throw new QuestionResourceError("上传操作人无效");
  const upload = validateAndDecodeUpload(input);
  const resourceId = `question_resource_${crypto.randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(`
      INSERT INTO question_resources (id, mime_type, content, size_bytes, sha256, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (sha256) DO NOTHING
      RETURNING id, mime_type, size_bytes, sha256, created_by, created_at;`, [
      resourceId,
      upload.mimeType,
      upload.content,
      upload.sizeBytes,
      upload.sha256,
      actorId
    ]);

    let resource;
    let deduplicated = false;
    if (inserted.rows.length) {
      resource = inserted.rows[0];
    } else {
      const existing = await client.query(`
        SELECT id, mime_type, size_bytes, sha256, created_by, created_at,
          content = $2::bytea AS content_matches
        FROM question_resources
        WHERE sha256 = $1;`, [upload.sha256, upload.content]);
      resource = existing.rows[0];
      if (
        !resource
        || resource.content_matches !== true
        || resource.mime_type !== upload.mimeType
        || Number(resource.size_bytes) !== upload.sizeBytes
      ) {
        throw new QuestionResourceError("图片资源校验冲突，拒绝保存", 409);
      }
      deduplicated = true;
    }
    await client.query("COMMIT");
    return { ...mapResourceMetadata(resource), deduplicated };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getQuestionResource(pool, resourceId) {
  const id = String(resourceId || "").trim();
  if (!id) throw new QuestionResourceError("图片资源标识不能为空");
  const result = await pool.query(`
    SELECT id, mime_type, content, size_bytes, sha256, created_by, created_at
    FROM question_resources
    WHERE id = $1;`, [id]);
  if (!result.rows.length) throw new QuestionResourceError("未找到图片资源", 404);
  const row = result.rows[0];
  return { ...mapResourceMetadata(row), content: row.content };
}

module.exports = {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_SIZE_BYTES,
  QuestionResourceError,
  createQuestionResource,
  detectImageMimeType,
  getQuestionResource,
  validateAndDecodeUpload
};
