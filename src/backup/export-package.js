const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  loadQuestionResourceManifest,
  resourceUrl,
  uploadedResourceId
} = require("../resources/question-resources");

const BACKUP_FORMAT = "t12-online-exams-backup";
const BACKUP_FORMAT_VERSION = 1;
const MAX_TOTAL_RESOURCE_BYTES = 100 * 1024 * 1024;
const STATIC_RESOURCE_ROOT = path.join(__dirname, "../../public");

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch (_) { return value; }
  }
  return value;
}

// JSON object key ordering makes exported files and their checksums reproducible.
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function asIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizeQuestion(row) {
  return {
    id: String(row.id),
    bankId: String(row.bank_id || row.bankId),
    externalId: row.external_id ?? row.externalId ?? "",
    type: row.type,
    stem: row.stem || "",
    images: parseJson(row.images_json ?? row.images, []),
    options: parseJson(row.options_json ?? row.options, []),
    answer: parseJson(row.answer_json ?? row.answer, null),
    explanation: row.explanation || "",
    version: Number(row.version || 1),
    status: row.status || "active",
    createdAt: asIso(row.created_at ?? row.createdAt),
    updatedAt: asIso(row.updated_at ?? row.updatedAt)
  };
}

function normalizeQuestionBank(row) {
  return {
    id: String(row.id),
    name: row.name || "",
    description: row.description || "",
    status: row.status || "active",
    ownerId: row.owner_id ?? row.ownerId ?? null,
    createdAt: asIso(row.created_at ?? row.createdAt),
    updatedAt: asIso(row.updated_at ?? row.updatedAt)
  };
}

function normalizeExam(row) {
  return {
    id: String(row.id),
    title: row.title || "",
    status: row.status || "draft",
    durationSeconds: Number(row.duration_seconds ?? row.durationSeconds),
    passScore: Number(row.pass_score ?? row.passScore ?? 0),
    totalScore: Number(row.total_score ?? row.totalScore ?? 0),
    passRate: Number(row.pass_rate ?? row.passRate ?? 0.6),
    version: Number(row.version || 1),
    answerRules: parseJson(row.answer_rules_json ?? row.answerRules, {}),
    questionBankId: row.question_bank_id ?? row.questionBankId ?? null,
    createdBy: row.created_by ?? row.createdBy ?? null,
    createdAt: asIso(row.created_at ?? row.createdAt),
    updatedAt: asIso(row.updated_at ?? row.updatedAt)
  };
}

function normalizeExamQuestion(row) {
  return {
    examId: String(row.exam_id ?? row.examId),
    questionId: String(row.question_id ?? row.questionId),
    position: Number(row.position),
    score: Number(row.score || 0),
    section: row.section || ""
  };
}

function normalizeAssignment(row) {
  return {
    id: String(row.id),
    examId: String(row.exam_id ?? row.examId),
    subjectType: row.subject_type ?? row.subjectType,
    subjectId: row.subject_id ?? row.subjectId,
    startsAt: asIso(row.starts_at ?? row.startsAt),
    endsAt: asIso(row.ends_at ?? row.endsAt)
  };
}

function normalizeRetakePermission(row) {
  return {
    id: String(row.id),
    examId: String(row.exam_id ?? row.examId),
    userId: String(row.user_id ?? row.userId),
    remainingCount: Number(row.remaining_count ?? row.remainingCount ?? 0),
    grantedBy: row.granted_by ?? row.grantedBy ?? null,
    grantedAt: asIso(row.granted_at ?? row.grantedAt)
  };
}

function collectResourceReferences(questions) {
  const references = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") {
      if (typeof value === "string") {
        const uploaded = uploadedResourceId(value);
        if (uploaded) references.add(uploaded);
        else if (/^resource:[A-Za-z0-9_-]+$/.test(value)) references.add(value);
        else if (/^\/question-resources\/[A-Za-z0-9_./-]+$/.test(value) && !value.includes("..")) references.add(value);
      }
      return;
    }
    Object.values(value).forEach(visit);
  };
  questions.forEach((question) => {
    visit(question.images);
    visit(question.options);
  });
  return [...references].sort();
}

function normalizeResource(resource) {
  const content = Buffer.isBuffer(resource.content)
    ? resource.content
    : Buffer.from(resource.base64 || "", "base64");
  const digest = sha256(content);
  if (resource.sha256 && resource.sha256 !== digest) throw new Error(`资源 ${resource.id} 的 SHA-256 校验失败`);
  if (!/^image\/(jpeg|png|webp)$/.test(resource.mime_type ?? resource.mimeType ?? "")) {
    throw new Error(`资源 ${resource.id} 的 MIME 类型无效`);
  }
  if (resource.size_bytes !== undefined && Number(resource.size_bytes) !== content.length) {
    throw new Error(`资源 ${resource.id} 的大小校验失败`);
  }
  return {
    id: String(resource.id),
    mimeType: resource.mime_type ?? resource.mimeType,
    sizeBytes: content.length,
    sha256: digest,
    base64: content.toString("base64")
  };
}

function staticResource(id, resources) {
  const canonicalId = /^resource:/.test(id)
    ? id
    : Object.keys(resources).find((resourceId) => resources[resourceId]?.url === id);
  const entry = resources[canonicalId];
  const url = resourceUrl(canonicalId, resources);
  if (!url) return null;
  const file = path.join(STATIC_RESOURCE_ROOT, url.replace(/^\//, ""));
  if (!file.startsWith(STATIC_RESOURCE_ROOT + path.sep) || !fs.existsSync(file)) return null;
  const content = fs.readFileSync(file);
  return normalizeResource({ id, mimeType: entry?.mediaType, sha256: entry?.sha256, content });
}

function buildBackupPackage(input = {}) {
  const kind = input.kind === "exam" ? "exam" : "question-bank";
  const questionBanks = (input.questionBanks || []).map(normalizeQuestionBank).sort((a, b) => a.id.localeCompare(b.id));
  const questions = (input.questions || []).map(normalizeQuestion).sort((a, b) => a.id.localeCompare(b.id));
  const exams = (input.exams || []).map(normalizeExam).sort((a, b) => a.id.localeCompare(b.id));
  const examQuestions = (input.examQuestions || []).map(normalizeExamQuestion).sort((a, b) => a.examId.localeCompare(b.examId) || a.position - b.position);
  const assignments = (input.assignments || []).map(normalizeAssignment).sort((a, b) => a.id.localeCompare(b.id));
  const retakePermissions = (input.retakePermissions || []).map(normalizeRetakePermission).sort((a, b) => a.id.localeCompare(b.id));
  const resourceInputs = input.resources || [];
  if (resourceInputs.some((resource) => Number(resource.size_bytes ?? 0) > MAX_TOTAL_RESOURCE_BYTES
    || (Buffer.isBuffer(resource.content) && resource.content.length > MAX_TOTAL_RESOURCE_BYTES)
    || (typeof resource.base64 === "string" && resource.base64.length > Math.ceil(MAX_TOTAL_RESOURCE_BYTES / 3) * 4 + 4))) {
    throw new Error("备份包图片资源总大小超过 100MB");
  }
  const resources = resourceInputs.map(normalizeResource).sort((a, b) => a.id.localeCompare(b.id));
  if (resources.reduce((sum, resource) => sum + resource.sizeBytes, 0) > MAX_TOTAL_RESOURCE_BYTES) {
    throw new Error("备份包图片资源总大小超过 100MB");
  }
  const payload = { questionBanks, questions, exams, examQuestions, assignments, retakePermissions, resources };
  const manifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    kind,
    exportedAt: input.exportedAt || new Date().toISOString(),
    counts: Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, value.length])),
    payloadSha256: sha256(stableStringify(payload))
  };
  return { manifest, ...payload };
}

function serializeBackupPackage(pkg) {
  if (!pkg?.manifest || pkg.manifest.format !== BACKUP_FORMAT) throw new Error("无效的备份包");
  return Buffer.from(stableStringify(pkg), "utf8");
}

async function loadResources(pool, ids, staticManifest = loadQuestionResourceManifest()) {
  const uploadedIds = ids.filter((id) => /^question_resource_[A-Za-z0-9-]+$/.test(id));
  const rows = uploadedIds.length ? (await pool.query(`
    SELECT id, mime_type, content, size_bytes, sha256
    FROM question_resources WHERE id = ANY($1::text[]);`, [uploadedIds])).rows : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const resource = byId.get(id) || staticResource(id, staticManifest);
    if (!resource) throw new Error(`备份所引用的图片资源不存在：${id}`);
    return normalizeResource(resource);
  });
}

async function exportQuestionBank(pool, bankId, options = {}) {
  const id = String(bankId || "").trim();
  if (!id) throw new Error("题库标识不能为空");
  const bankResult = await pool.query("SELECT id, name, description, status, owner_id, created_at, updated_at FROM question_banks WHERE id = $1;", [id]);
  if (!bankResult.rows.length) return null;
  const questionResult = await pool.query(`
    SELECT id, bank_id, external_id, type, stem, images_json, options_json, answer_json,
      explanation, score, version, status, created_at, updated_at
    FROM questions WHERE bank_id = $1 ORDER BY id;`, [id]);
  const questions = questionResult.rows.map(normalizeQuestion);
  const resources = await loadResources(pool, collectResourceReferences(questions), options.staticManifest);
  return buildBackupPackage({ kind: "question-bank", questionBanks: [bankResult.rows[0]], questions, resources, exportedAt: options.exportedAt });
}

async function exportExam(pool, examId, options = {}) {
  const id = String(examId || "").trim();
  if (!id) throw new Error("试卷标识不能为空");
  const examResult = await pool.query(`
    SELECT id, title, status, duration_seconds, pass_score, total_score, pass_rate, version,
      answer_rules_json, question_bank_id, created_by, created_at, updated_at
    FROM exams WHERE id = $1;`, [id]);
  if (!examResult.rows.length) return null;
  const relationResult = await pool.query(`
    SELECT eq.exam_id, eq.question_id, eq.position, eq.score, eq.section,
      q.bank_id, q.external_id, q.type, q.stem, q.images_json, q.options_json,
      q.answer_json, q.explanation, q.version AS question_version, q.status AS question_status,
      q.created_at AS question_created_at, q.updated_at AS question_updated_at
    FROM exam_questions eq JOIN questions q ON q.id = eq.question_id
    WHERE eq.exam_id = $1 ORDER BY eq.position;`, [id]);
  const bankIds = new Set(relationResult.rows.map((row) => row.bank_id));
  if (examResult.rows[0].question_bank_id) bankIds.add(examResult.rows[0].question_bank_id);
  const banksResult = await pool.query(`
    SELECT qb.id, qb.name, qb.description, qb.status, qb.owner_id, qb.created_at, qb.updated_at
    FROM question_banks qb
    WHERE qb.id = ANY($1::text[]) ORDER BY qb.id;`, [[...bankIds]]);
  const questions = relationResult.rows.map((row) => normalizeQuestion({ ...row, id: row.question_id, version: row.question_version, status: row.question_status, created_at: row.question_created_at, updated_at: row.question_updated_at }));
  const resources = await loadResources(pool, collectResourceReferences(questions), options.staticManifest);
  const assignments = (await pool.query("SELECT id, exam_id, subject_type, subject_id, starts_at, ends_at FROM exam_assignments WHERE exam_id = $1 ORDER BY id;", [id])).rows;
  const retakePermissions = (await pool.query("SELECT id, exam_id, user_id, remaining_count, granted_by, granted_at FROM retake_permissions WHERE exam_id = $1 ORDER BY id;", [id])).rows;
  return buildBackupPackage({
    kind: "exam", exams: examResult.rows, questionBanks: banksResult.rows, questions,
    examQuestions: relationResult.rows, assignments, retakePermissions, resources,
    exportedAt: options.exportedAt
  });
}

module.exports = {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  MAX_TOTAL_RESOURCE_BYTES,
  buildBackupPackage,
  collectResourceReferences,
  exportExam,
  exportQuestionBank,
  serializeBackupPackage,
  stableStringify,
  sha256
};
