const crypto = require("node:crypto");
const {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  MAX_TOTAL_RESOURCE_BYTES,
  stableStringify,
  sha256
} = require("./export-package");
const { readZip } = require("./zip-archive");
const { validateAndDecodeUpload } = require("../db/question-resource-repository");

const PACKAGE_ARRAY_KEYS = [
  "questionBanks",
  "questions",
  "exams",
  "examQuestions",
  "assignments",
  "retakePermissions",
  "resources"
];
const ALLOWED_QUESTION_TYPES = new Set(["single", "multi", "judge", "fill", "qa"]);
const ALLOWED_QUESTION_STATUSES = new Set(["active", "archived"]);
const ALLOWED_EXAM_STATUSES = new Set(["draft", "scheduled", "published", "paused", "closed", "archived"]);
const ALLOWED_SUBJECT_TYPES = new Set(["user", "department", "group"]);
const MAX_ENTITY_COUNT = 20_000;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

class BackupImportError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "BackupImportError";
    this.statusCode = statusCode;
  }
}

function fail(message) {
  throw new BackupImportError(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requireObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} 格式无效`);
  return value;
}

function requireArray(value, label, maximum = MAX_ENTITY_COUNT) {
  if (!Array.isArray(value)) fail(`${label} 必须是数组`);
  if (value.length > maximum) fail(`${label} 数量超过限制`);
  return value;
}

function requireString(value, label, maximum = 20_000, { empty = false } = {}) {
  if (typeof value !== "string" || (!empty && !value.trim())) fail(`${label} 无效`);
  if (value.length > maximum) fail(`${label} 内容过长`);
  return value;
}

function nullableString(value, label, maximum = 500) {
  if (value === null || value === undefined || value === "") return null;
  return requireString(value, label, maximum);
}

function finiteNumber(value, label, { minimum = 0, maximum = 99_999_999.99, integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) fail(`${label} 无效`);
  if (integer && !Number.isInteger(value)) fail(`${label} 必须是整数`);
  return value;
}

function decimalScore(value, label) {
  const number = finiteNumber(value, label);
  if (Math.abs(number * 100 - Math.round(number * 100)) > 1e-8) fail(`${label} 最多保留两位小数`);
  return number;
}

function optionalIso(value, label) {
  if (value === null || value === undefined) return null;
  requireString(value, label, 100);
  if (!Number.isFinite(Date.parse(value))) fail(`${label} 不是有效时间`);
  return value;
}

function assertUnique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) fail(`${label} 包含重复项：${value}`);
    seen.add(value);
  }
}

function jsonByteLength(value, label, maximum) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (_) {
    fail(`${label} 不是有效 JSON`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > maximum) fail(`${label} 内容过大`);
}

function assertJsonComplexity(value) {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > 1_000_000) fail("备份包 JSON 节点数量超过限制");
    if (current.depth > 40) fail("备份包 JSON 嵌套层级超过限制");
    if (Array.isArray(current.value)) {
      current.value.forEach((item) => stack.push({ value: item, depth: current.depth + 1 }));
    } else if (current.value && typeof current.value === "object") {
      if (!isPlainObject(current.value)) fail("备份包只能包含标准 JSON 数据");
      Object.values(current.value).forEach((item) => stack.push({ value: item, depth: current.depth + 1 }));
    } else if (!["string", "number", "boolean"].includes(typeof current.value) && current.value !== null) {
      fail("备份包只能包含标准 JSON 数据");
    }
  }
}

function parseBackupPackage(input) {
  let value = input;
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    let buffer = Buffer.from(input);
    if (buffer.length > MAX_ARCHIVE_BYTES) fail("备份包不能超过 200MB");
    if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
      let files;
      try {
        files = readZip(buffer, {
          maxEntries: 1,
          maxEntryBytes: MAX_ARCHIVE_BYTES,
          maxTotalBytes: MAX_ARCHIVE_BYTES,
          maxArchiveBytes: MAX_ARCHIVE_BYTES
        });
      } catch (error) {
        fail(error.message);
      }
      if (files.size !== 1 || !files.has("backup.json")) fail("ZIP 备份包必须且只能包含 backup.json");
      buffer = files.get("backup.json");
    }
    value = buffer.toString("utf8");
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > MAX_ARCHIVE_BYTES) fail("备份包不能超过 200MB");
    try {
      value = JSON.parse(value);
    } catch (_) {
      fail("备份包 JSON 无法解析");
    }
  }
  return validateBackupPackage(value);
}

function validateQuestionBank(bank) {
  requireObject(bank, "题库");
  requireString(bank.id, "题库标识", 500);
  requireString(bank.name, "题库名称", 500);
  requireString(bank.description, "题库说明", 50_000, { empty: true });
  if (!ALLOWED_QUESTION_STATUSES.has(bank.status)) fail("题库状态无效");
  nullableString(bank.ownerId, "题库所有人", 500);
  optionalIso(bank.createdAt, "题库创建时间");
  optionalIso(bank.updatedAt, "题库更新时间");
}

function validateQuestion(question) {
  requireObject(question, "题目");
  requireString(question.id, "题目标识", 500);
  requireString(question.bankId, "题库标识", 500);
  requireString(question.externalId, "题目编号", 200, { empty: true });
  if (!ALLOWED_QUESTION_TYPES.has(question.type)) fail(`题目 ${question.id} 的题型无效`);
  requireString(question.stem, `题目 ${question.id} 的题干`, 20_000);
  requireArray(question.images, `题目 ${question.id} 的图片`, 5).forEach((image) => requireString(image, "题目图片引用", 1_000));
  if (!Array.isArray(question.options) && !isPlainObject(question.options)) fail(`题目 ${question.id} 的选项格式无效`);
  jsonByteLength(question.options, "题目选项", 100_000);
  jsonByteLength(question.answer, "参考答案", 100_000);
  requireString(question.explanation, "题目解析", 50_000, { empty: true });
  finiteNumber(question.version, "题目版本", { minimum: 1, maximum: 2_147_483_647, integer: true });
  if (!ALLOWED_QUESTION_STATUSES.has(question.status)) fail(`题目 ${question.id} 的状态无效`);
  optionalIso(question.createdAt, "题目创建时间");
  optionalIso(question.updatedAt, "题目更新时间");
}

function validateExam(exam) {
  requireObject(exam, "试卷");
  requireString(exam.id, "试卷标识", 500);
  requireString(exam.title, "试卷标题", 1_000);
  if (!ALLOWED_EXAM_STATUSES.has(exam.status)) fail("试卷状态无效");
  finiteNumber(exam.durationSeconds, "考试时长", { minimum: 1, maximum: 31_536_000, integer: true });
  decimalScore(exam.passScore, "通过分");
  decimalScore(exam.totalScore, "总分");
  finiteNumber(exam.passRate, "通过比例", { minimum: 0, maximum: 1 });
  finiteNumber(exam.version, "试卷版本", { minimum: 1, maximum: 2_147_483_647, integer: true });
  requireObject(exam.answerRules, "作答规则");
  jsonByteLength(exam.answerRules, "作答规则", 100_000);
  nullableString(exam.questionBankId, "试卷题库标识", 500);
  nullableString(exam.createdBy, "试卷创建人", 500);
  optionalIso(exam.createdAt, "试卷创建时间");
  optionalIso(exam.updatedAt, "试卷更新时间");
}

function validateExamQuestion(item) {
  requireObject(item, "组卷题目");
  requireString(item.examId, "试卷标识", 500);
  requireString(item.questionId, "题目标识", 500);
  finiteNumber(item.position, "题目顺序", { minimum: 1, maximum: MAX_ENTITY_COUNT, integer: true });
  decimalScore(item.score, "题目分值");
  requireString(item.section, "试卷分区", 1_000, { empty: true });
}

function validateAssignment(item) {
  requireObject(item, "考试分配");
  requireString(item.id, "考试分配标识", 500);
  requireString(item.examId, "考试分配的试卷标识", 500);
  if (!ALLOWED_SUBJECT_TYPES.has(item.subjectType)) fail("考试分配对象类型无效");
  requireString(item.subjectId, "考试分配对象", 1_000);
  const startsAt = optionalIso(item.startsAt, "考试开始时间");
  const endsAt = optionalIso(item.endsAt, "考试结束时间");
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) fail("考试结束时间必须晚于开始时间");
}

function validateRetakePermission(item) {
  requireObject(item, "补考权限");
  requireString(item.id, "补考权限标识", 500);
  requireString(item.examId, "补考权限的试卷标识", 500);
  requireString(item.userId, "补考用户标识", 500);
  finiteNumber(item.remainingCount, "剩余补考次数", { minimum: 0, maximum: 1_000_000, integer: true });
  nullableString(item.grantedBy, "补考授权人", 500);
  optionalIso(item.grantedAt, "补考授权时间");
}

function validateResource(resource) {
  requireObject(resource, "图片资源");
  requireString(resource.id, "图片资源标识", 1_000);
  requireString(resource.mimeType, "图片 MIME 类型", 100);
  finiteNumber(resource.sizeBytes, "图片大小", { minimum: 1, maximum: 5 * 1024 * 1024, integer: true });
  const declaredHash = requireString(resource.sha256, "图片 SHA-256", 64);
  if (!/^[0-9a-f]{64}$/.test(declaredHash)) fail("图片 SHA-256 格式无效");
  let upload;
  try {
    upload = validateAndDecodeUpload({ mimeType: resource.mimeType, base64: resource.base64 });
  } catch (error) {
    fail(`图片资源 ${resource.id} 无效：${error.message}`);
  }
  if (upload.sizeBytes !== resource.sizeBytes) fail(`图片资源 ${resource.id} 的大小校验失败`);
  if (upload.sha256 !== declaredHash) fail(`图片资源 ${resource.id} 的 SHA-256 校验失败`);
  return upload.content;
}

function resourceAliases(resourceId) {
  const aliases = [resourceId];
  if (/^question_resource_[A-Za-z0-9-]+$/.test(resourceId)) {
    aliases.push(`/api/question-resources/${resourceId}`);
  }
  return aliases;
}

function collectRecognizedReferences(value, references) {
  if (Array.isArray(value)) return value.forEach((item) => collectRecognizedReferences(item, references));
  if (isPlainObject(value)) return Object.values(value).forEach((item) => collectRecognizedReferences(item, references));
  if (typeof value !== "string") return;
  if (/^resource:[A-Za-z0-9_-]+$/.test(value)
    || /^\/api\/question-resources\/question_resource_[A-Za-z0-9-]+$/.test(value)
    || /^\/question-resources\/[A-Za-z0-9_./-]+$/.test(value)) references.add(value);
}

function validateRelations(pkg) {
  const bankIds = new Set(pkg.questionBanks.map((item) => item.id));
  const questionIds = new Set(pkg.questions.map((item) => item.id));
  const examIds = new Set(pkg.exams.map((item) => item.id));
  for (const question of pkg.questions) {
    if (!bankIds.has(question.bankId)) fail(`题目 ${question.id} 引用了包内不存在的题库`);
  }
  for (const exam of pkg.exams) {
    if (exam.questionBankId && !bankIds.has(exam.questionBankId)) fail(`试卷 ${exam.id} 引用了包内不存在的题库`);
  }
  for (const item of pkg.examQuestions) {
    if (!examIds.has(item.examId) || !questionIds.has(item.questionId)) fail("组卷关系引用了包内不存在的试卷或题目");
    const exam = pkg.exams.find((candidate) => candidate.id === item.examId);
    const question = pkg.questions.find((candidate) => candidate.id === item.questionId);
    if (exam.questionBankId && question.bankId !== exam.questionBankId) fail("试卷包含了其他题库的题目");
  }
  for (const item of [...pkg.assignments, ...pkg.retakePermissions]) {
    if (!examIds.has(item.examId)) fail("考试权限引用了包内不存在的试卷");
  }
  for (const exam of pkg.exams) {
    const selected = pkg.examQuestions.filter((item) => item.examId === exam.id).sort((a, b) => a.position - b.position);
    if (selected.some((item, index) => item.position !== index + 1)) fail(`试卷 ${exam.id} 的题目顺序不连续`);
    const total = selected.reduce((sum, item) => sum + item.score, 0);
    if (Math.abs(total - exam.totalScore) > 0.005) fail(`试卷 ${exam.id} 的总分与题目分值不一致`);
    if (exam.passScore > exam.totalScore) fail(`试卷 ${exam.id} 的通过分不能高于总分`);
  }

  const aliases = new Set(pkg.resources.flatMap((resource) => resourceAliases(resource.id)));
  const references = new Set();
  pkg.questions.forEach((question) => {
    collectRecognizedReferences(question.images, references);
    collectRecognizedReferences(question.options, references);
  });
  for (const reference of references) {
    if (!aliases.has(reference)) fail(`图片引用 ${reference} 在备份包中缺少资源正文`);
  }
}

function validateBackupPackage(value) {
  const pkg = requireObject(value, "备份包");
  assertJsonComplexity(pkg);
  const allowedTopLevel = new Set(["manifest", ...PACKAGE_ARRAY_KEYS]);
  if (Object.keys(pkg).some((key) => !allowedTopLevel.has(key))) fail("备份包包含未知的顶层字段");
  const manifest = requireObject(pkg.manifest, "备份清单");
  const allowedManifestKeys = new Set(["format", "formatVersion", "kind", "exportedAt", "counts", "payloadSha256"]);
  if (Object.keys(manifest).some((key) => !allowedManifestKeys.has(key))) fail("备份清单包含未知字段");
  if (manifest.format !== BACKUP_FORMAT) fail("不支持的备份包格式");
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) fail("不支持的备份包版本");
  if (manifest.kind !== "exam" && manifest.kind !== "question-bank") fail("备份包类型无效");
  requireString(manifest.exportedAt, "导出时间", 100);
  optionalIso(manifest.exportedAt, "导出时间");
  requireObject(manifest.counts, "备份数量清单");
  requireString(manifest.payloadSha256, "数据 SHA-256", 64);
  if (!/^[0-9a-f]{64}$/.test(manifest.payloadSha256)) fail("数据 SHA-256 格式无效");

  const payload = {};
  for (const key of PACKAGE_ARRAY_KEYS) {
    payload[key] = requireArray(pkg[key], key);
    if (!Number.isInteger(manifest.counts[key]) || manifest.counts[key] !== payload[key].length) {
      fail(`备份数量清单与 ${key} 实际数量不一致`);
    }
  }
  if (Object.keys(manifest.counts).some((key) => !PACKAGE_ARRAY_KEYS.includes(key))) fail("备份数量清单包含未知字段");
  const actualPayloadHash = sha256(stableStringify(payload));
  if (actualPayloadHash !== manifest.payloadSha256) fail("备份包数据 SHA-256 校验失败");

  payload.questionBanks.forEach(validateQuestionBank);
  payload.questions.forEach(validateQuestion);
  payload.exams.forEach(validateExam);
  payload.examQuestions.forEach(validateExamQuestion);
  payload.assignments.forEach(validateAssignment);
  payload.retakePermissions.forEach(validateRetakePermission);
  let totalResourceBytes = 0;
  const resourceContents = new Map();
  payload.resources.forEach((resource) => {
    const content = validateResource(resource);
    totalResourceBytes += content.length;
    if (totalResourceBytes > MAX_TOTAL_RESOURCE_BYTES) fail("备份包图片资源总大小超过 100MB");
    resourceContents.set(resource.id, content);
  });

  assertUnique(payload.questionBanks, (item) => item.id, "题库");
  assertUnique(payload.questions, (item) => item.id, "题目");
  assertUnique(payload.exams, (item) => item.id, "试卷");
  assertUnique(payload.examQuestions, (item) => `${item.examId}:${item.questionId}`, "组卷关系");
  assertUnique(payload.examQuestions, (item) => `${item.examId}:${item.position}`, "题目顺序");
  assertUnique(payload.assignments, (item) => item.id, "考试分配");
  assertUnique(payload.assignments, (item) => `${item.examId}:${item.subjectType}:${item.subjectId}`, "考试分配对象");
  assertUnique(payload.retakePermissions, (item) => item.id, "补考权限");
  assertUnique(payload.retakePermissions, (item) => `${item.examId}:${item.userId}`, "补考用户");
  assertUnique(payload.resources, (item) => item.id, "图片资源");

  if (manifest.kind === "question-bank") {
    if (payload.questionBanks.length !== 1 || payload.exams.length || payload.examQuestions.length
      || payload.assignments.length || payload.retakePermissions.length) fail("题库备份包的内容范围无效");
  } else if (payload.exams.length !== 1 || payload.questionBanks.length > 1) {
    fail("试卷备份包必须包含一份试卷，且最多包含一个题库");
  } else if (payload.exams[0].questionBankId && payload.questionBanks.length !== 1) {
    fail("已绑定题库的试卷备份包必须包含对应题库");
  } else if (!payload.exams[0].questionBankId && (payload.questions.length || payload.examQuestions.length)) {
    fail("未绑定题库的试卷备份包不能包含题目");
  }
  validateRelations(payload);
  return { manifest: { ...manifest }, ...payload, resourceContents };
}

function rewriteResourceReferences(value, resourceIdMap) {
  if (Array.isArray(value)) return value.map((item) => rewriteResourceReferences(item, resourceIdMap));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteResourceReferences(item, resourceIdMap)]));
  }
  if (typeof value === "string" && resourceIdMap.has(value)) {
    return `/api/question-resources/${resourceIdMap.get(value)}`;
  }
  return value;
}

function defaultIdFactory(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function importBackupPackage(pool, input, actorUserId, options = {}) {
  const actorId = requireString(actorUserId, "导入操作人", 500);
  const pkg = parseBackupPackage(input);
  const makeId = options.idFactory || defaultIdFactory;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const actor = await client.query("SELECT id FROM users WHERE id = $1 AND status = 'active' FOR SHARE;", [actorId]);
    if (!actor.rows.length) throw new BackupImportError("导入操作人不存在或已停用", 403);

    const resourceIdMap = new Map();
    const resourceBySha = new Map();
    for (const resource of pkg.resources) {
      let targetId = resourceBySha.get(resource.sha256);
      if (!targetId) {
        const content = pkg.resourceContents.get(resource.id);
        const existing = await client.query(`
          SELECT id, mime_type, size_bytes, content = $2::bytea AS content_matches
          FROM question_resources
          WHERE sha256 = $1
          FOR SHARE;`, [resource.sha256, content]);
        if (existing.rows.length) {
          const row = existing.rows[0];
          if (row.mime_type !== resource.mimeType || Number(row.size_bytes) !== resource.sizeBytes || row.content_matches !== true) {
            throw new BackupImportError("数据库中的同 SHA-256 图片资源校验冲突", 409);
          }
          targetId = row.id;
        } else {
          targetId = makeId("question_resource", resource.id);
          await client.query(`
            INSERT INTO question_resources (id, mime_type, content, size_bytes, sha256, created_by)
            VALUES ($1, $2, $3, $4, $5, $6);`, [
            targetId, resource.mimeType, content, resource.sizeBytes, resource.sha256, actorId
          ]);
        }
        resourceBySha.set(resource.sha256, targetId);
      }
      for (const alias of resourceAliases(resource.id)) resourceIdMap.set(alias, targetId);
    }

    const bankIdMap = new Map();
    for (const bank of pkg.questionBanks) {
      const targetId = makeId("question_bank_import", bank.id);
      bankIdMap.set(bank.id, targetId);
      await client.query(`
        INSERT INTO question_banks (id, name, description, status, owner_id)
        VALUES ($1, $2, $3, $4, $5);`, [targetId, bank.name, bank.description, bank.status, actorId]);
    }

    const questionIdMap = new Map();
    for (const question of pkg.questions) {
      const targetId = makeId("question_import", question.id);
      questionIdMap.set(question.id, targetId);
      await client.query(`
        INSERT INTO questions (
          id, bank_id, external_id, type, stem, images_json, options_json, answer_json,
          explanation, score, version, status
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, 0, 1, $10);`, [
        targetId,
        bankIdMap.get(question.bankId),
        question.externalId || null,
        question.type,
        question.stem,
        JSON.stringify(rewriteResourceReferences(question.images, resourceIdMap)),
        JSON.stringify(rewriteResourceReferences(question.options, resourceIdMap)),
        JSON.stringify(question.answer),
        question.explanation,
        question.status
      ]);
    }

    const examIdMap = new Map();
    for (const exam of pkg.exams) {
      const targetId = makeId("exam_import", exam.id);
      examIdMap.set(exam.id, targetId);
      await client.query(`
        INSERT INTO exams (
          id, title, status, duration_seconds, pass_score, total_score, pass_rate,
          version, answer_rules_json, question_bank_id, created_by
        ) VALUES ($1, $2, 'draft', $3, $4, $5, $6, 1, $7::jsonb, $8, $9);`, [
        targetId,
        exam.title,
        exam.durationSeconds,
        exam.passScore,
        exam.totalScore,
        exam.passRate,
        JSON.stringify(exam.answerRules),
        exam.questionBankId ? bankIdMap.get(exam.questionBankId) : null,
        actorId
      ]);
    }

    for (const item of pkg.examQuestions) {
      await client.query(`
        INSERT INTO exam_questions (exam_id, question_id, position, score, section)
        VALUES ($1, $2, $3, $4, $5);`, [
        examIdMap.get(item.examId), questionIdMap.get(item.questionId), item.position, item.score, item.section
      ]);
    }
    for (const item of pkg.assignments) {
      await client.query(`
        INSERT INTO exam_assignments (id, exam_id, subject_type, subject_id, starts_at, ends_at)
        VALUES ($1, $2, $3, $4, $5, $6);`, [
        makeId("exam_assignment_import", item.id), examIdMap.get(item.examId), item.subjectType,
        item.subjectId, item.startsAt, item.endsAt
      ]);
    }
    const referencedUserIds = [...new Set([
      ...pkg.assignments.filter((item) => item.subjectType === "user").map((item) => item.subjectId),
      ...pkg.retakePermissions.map((item) => item.userId)
    ])];
    if (referencedUserIds.length) {
      const userIds = referencedUserIds;
      const users = await client.query("SELECT id FROM users WHERE id = ANY($1::text[]) AND status = 'active';", [userIds]);
      if (users.rows.length !== userIds.length) fail("备份中的用户分配或补考权限包含当前系统不存在或已停用的用户");
    }
    for (const item of pkg.retakePermissions) {
      await client.query(`
        INSERT INTO retake_permissions (id, exam_id, user_id, remaining_count, granted_by, granted_at)
        VALUES ($1, $2, $3, $4, $5, $6);`, [
        makeId("retake_permission_import", item.id), examIdMap.get(item.examId), item.userId,
        item.remainingCount, actorId, item.grantedAt || new Date().toISOString()
      ]);
    }

    const imported = {
      kind: pkg.manifest.kind,
      sourcePayloadSha256: pkg.manifest.payloadSha256,
      questionBanks: pkg.questionBanks.map((bank) => ({ id: bankIdMap.get(bank.id), name: bank.name })),
      exams: pkg.exams.map((exam) => ({ id: examIdMap.get(exam.id), title: exam.title, status: "draft" })),
      counts: { questions: pkg.questions.length, resources: new Set(resourceIdMap.values()).size }
    };
    const resourceType = pkg.manifest.kind === "exam" ? "exam" : "question_bank";
    const resourceId = pkg.manifest.kind === "exam" ? imported.exams[0].id : imported.questionBanks[0].id;
    await client.query(`
      INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, before_json, after_json)
      VALUES ($1, $2, 'import_backup', $3, $4, '{}'::jsonb, $5::jsonb);`, [
      makeId("audit_log", resourceId), actorId, resourceType, resourceId, JSON.stringify(imported)
    ]);
    await client.query("COMMIT");
    return imported;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  BackupImportError,
  importBackupPackage,
  parseBackupPackage,
  rewriteResourceReferences,
  validateBackupPackage
};
