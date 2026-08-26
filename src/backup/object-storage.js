const crypto = require("node:crypto");

const MAX_OBJECT_KEY_LENGTH = 1_024;
const OBJECT_KEY_PART = /^[A-Za-z0-9._-]+$/;

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function bufferContent(content) {
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  throw new Error("对象存储正文必须是二进制内容");
}

function normalizeObjectKey(value) {
  const key = String(value || "").replace(/\\/g, "/");
  if (!key || key.length > MAX_OBJECT_KEY_LENGTH || key.startsWith("/") || key.includes("\0")) {
    throw new Error("对象存储键无效");
  }
  const parts = key.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || !OBJECT_KEY_PART.test(part))) {
    throw new Error("对象存储键无效");
  }
  return parts.join("/");
}

function normalizePrefix(value) {
  const prefix = String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!prefix) return "";
  return normalizeObjectKey(prefix);
}

function objectStorageKey({ prefix = "", runId, scopeType, sourceId }) {
  const normalizedPrefix = normalizePrefix(prefix);
  const run = normalizeObjectKey(runId);
  const scope = normalizeObjectKey(scopeType);
  const sourceHash = crypto.createHash("sha256").update(String(sourceId || "")).digest("hex").slice(0, 24);
  const key = `${run}/${scope}-${sourceHash}.t12backup`;
  return normalizedPrefix ? `${normalizedPrefix}/${key}` : key;
}

function normalizeMetadata(metadata = {}) {
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [String(key), String(value)]));
}

function responseBody(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return bufferContent(value);
  if (value && (Buffer.isBuffer(value.body) || value.body instanceof Uint8Array)) return bufferContent(value.body);
  if (value && (Buffer.isBuffer(value.Body) || value.Body instanceof Uint8Array)) return bufferContent(value.Body);
  if (value && Buffer.isBuffer(value.content)) return value.content;
  throw new Error("对象存储返回的正文无效");
}

function createObjectStorage({ client, bucket, prefix = "" }) {
  if (!client || typeof client.putObject !== "function" || typeof client.getObject !== "function" || typeof client.deleteObject !== "function") {
    throw new Error("对象存储客户端必须提供 putObject、getObject 和 deleteObject");
  }
  const normalizedBucket = String(bucket || "").trim();
  if (!normalizedBucket) throw new Error("对象存储 Bucket 不能为空");
  const normalizedPrefix = normalizePrefix(prefix);

  return {
    type: "object",
    async save({ runId, scopeType, sourceId, content, filename = "t12-backup.t12backup", contentType = "application/vnd.t12.exam-backup+zip" }) {
      const body = bufferContent(content);
      if (!body.length) throw new Error("备份文件正文不能为空");
      const key = objectStorageKey({ prefix: normalizedPrefix, runId, scopeType, sourceId });
      const digest = sha256(body);
      await client.putObject({
        bucket: normalizedBucket,
        key,
        body,
        contentType,
        metadata: normalizeMetadata({ sha256: digest, sizeBytes: body.length, filename }),
        ifNoneMatch: "*"
      });
      return { storageKey: key, sha256: digest, sizeBytes: body.length, contentType };
    },
    async read(key, expected = {}) {
      const normalizedKey = normalizeObjectKey(key);
      const body = responseBody(await client.getObject({ bucket: normalizedBucket, key: normalizedKey }));
      if (expected.sizeBytes !== undefined && Number(expected.sizeBytes) !== body.length) {
        throw new Error("对象存储正文大小校验失败");
      }
      if (expected.sha256 && String(expected.sha256).toLowerCase() !== sha256(body)) {
        throw new Error("对象存储正文 SHA-256 校验失败");
      }
      return body;
    },
    async remove(key) {
      await client.deleteObject({ bucket: normalizedBucket, key: normalizeObjectKey(key) });
    }
  };
}

function createMemoryObjectStorage() {
  const objects = new Map();
  const calls = [];
  const client = {
    async putObject(input) {
      calls.push({ method: "putObject", ...input });
      if (input.ifNoneMatch === "*" && objects.has(`${input.bucket}/${input.key}`)) {
        const error = new Error("对象已存在");
        error.code = "PRECONDITION_FAILED";
        throw error;
      }
      objects.set(`${input.bucket}/${input.key}`, Buffer.from(input.body));
    },
    async getObject(input) {
      calls.push({ method: "getObject", ...input });
      const body = objects.get(`${input.bucket}/${input.key}`);
      if (!body) {
        const error = new Error("对象不存在");
        error.code = "NOT_FOUND";
        throw error;
      }
      return { body: Buffer.from(body) };
    },
    async deleteObject(input) {
      calls.push({ method: "deleteObject", ...input });
      objects.delete(`${input.bucket}/${input.key}`);
    }
  };
  return { storage: createObjectStorage({ client, bucket: "memory" }), objects, calls };
}

module.exports = {
  MAX_OBJECT_KEY_LENGTH,
  createMemoryObjectStorage,
  createObjectStorage,
  normalizeObjectKey,
  objectStorageKey,
  sha256
};
