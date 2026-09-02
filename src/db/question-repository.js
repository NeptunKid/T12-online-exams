const crypto = require("node:crypto");
const {
  loadQuestionResourceManifest,
  mapQuestionImages,
  mapQuestionOptions,
  uploadedResourceId
} = require("../resources/question-resources");

const OPTION_TYPES = new Set(["single", "multi", "judge"]);
const QUESTION_TYPES = new Set(["single", "multi", "judge", "fill", "qa"]);

class QuestionBankError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "QuestionBankError";
    this.statusCode = statusCode;
  }
}

function normalizeBankVersion(value) {
  const version = Number(value);
  if ((typeof value !== "number" && typeof value !== "string") || !Number.isInteger(version) || version < 1) {
    throw new QuestionBankError("题库版本无效，请刷新后重试");
  }
  return version;
}

function normalizeBankMetadata(input, existing = null) {
  const name = String(input?.name ?? existing?.name ?? "").trim();
  if (!name) throw new QuestionBankError("题库名称不能为空");
  if (name.length > 500) throw new QuestionBankError("题库名称过长");
  const description = String(input?.description ?? existing?.description ?? "").trim();
  if (description.length > 50_000) throw new QuestionBankError("题库说明过长");
  let ownerId = input?.ownerId;
  if (ownerId === undefined) ownerId = existing?.owner_id;
  ownerId = String(ownerId || "").trim() || null;
  if (ownerId && ownerId.length > 500) throw new QuestionBankError("题库负责人标识过长");
  return { name, description, ownerId };
}

function mapQuestionBank(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    status: row.status,
    ownerId: row.owner_id || "",
    version: Number(row.version),
    questionCount: Number(row.question_count || 0),
    activeQuestionCount: Number(row.active_question_count ?? row.question_count ?? 0),
    examCount: Number(row.exam_count || 0)
  };
}

function normalizeStoredOptions(options) {
  const source = Array.isArray(options)
    ? options
    : options && typeof options === "object"
      ? Object.entries(options).map(([label, text]) => ({ label, text }))
      : [];
  return source.map((option) => ({
    label: String(option.label || "").trim().toUpperCase(),
    text: String(option.text || ""),
    ...(option.image ? { image: option.image } : {})
  }));
}

function mapQuestion(row) {
  const options = normalizeStoredOptions(row.options_json);
  return {
    id: row.id,
    bankId: row.bank_id,
    bankName: row.bank_name,
    externalId: row.external_id || "",
    type: row.type,
    stem: row.stem,
    images: mapQuestionImages(row.images_json || []),
    options: options.map((option) => {
      const image = mapQuestionOptions([option])[0]?.image || "";
      return {
        label: option.label,
        text: option.text,
        ...(image ? { image } : {}),
        hasImage: Boolean(option.image)
      };
    }),
    answer: row.answer_json,
    explanation: row.explanation || "",
    version: Number(row.version),
    status: row.status,
    exams: Array.isArray(row.exam_refs) ? row.exam_refs : []
  };
}

const QUESTION_SELECT = `
  SELECT q.id, q.bank_id, qb.name AS bank_name, q.external_id, q.type, q.stem,
    q.options_json, q.images_json, q.answer_json, q.explanation, q.version, q.status,
    refs.exam_refs
  FROM questions q
  JOIN question_banks qb ON qb.id = q.bank_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', e.id,
      'title', e.title,
      'status', e.status,
      'position', eq.position
    ) ORDER BY e.title, eq.position), '[]'::jsonb) AS exam_refs
    FROM exam_questions eq
    JOIN exams e ON e.id = eq.exam_id
    WHERE eq.question_id = q.id
  ) refs ON true`;

async function listQuestions(pool) {
  const result = await pool.query(`${QUESTION_SELECT}
    WHERE q.status = 'active' AND qb.status = 'active'
    ORDER BY qb.name, COALESCE(q.external_id, q.id), q.id;`);
  return result.rows.map(mapQuestion);
}

async function listQuestionBanks(pool) {
  const result = await pool.query(`
    SELECT qb.id, qb.name, qb.description, qb.status, qb.owner_id, qb.version,
      count(q.id)::integer AS question_count
    FROM question_banks qb
    LEFT JOIN questions q ON q.bank_id = qb.id AND q.status = 'active'
    WHERE qb.status = 'active'
    GROUP BY qb.id
    ORDER BY qb.name, qb.id;`);
  return result.rows.map(mapQuestionBank);
}

async function listManagedQuestionBanks(pool) {
  const result = await pool.query(`
    SELECT qb.id, qb.name, qb.description, qb.status, qb.owner_id, qb.version,
      count(DISTINCT q.id)::integer AS question_count,
      count(DISTINCT q.id) FILTER (WHERE q.status = 'active')::integer AS active_question_count,
      count(DISTINCT e.id)::integer AS exam_count
    FROM question_banks qb
    LEFT JOIN questions q ON q.bank_id = qb.id
    LEFT JOIN exams e ON e.question_bank_id = qb.id AND e.status <> 'archived'
    GROUP BY qb.id
    ORDER BY (qb.status = 'archived'), qb.name, qb.id;`);
  return result.rows.map(mapQuestionBank);
}

async function getQuestionBank(queryable, bankId) {
  const result = await queryable.query(`
    SELECT qb.id, qb.name, qb.description, qb.status, qb.owner_id, qb.version,
      count(DISTINCT q.id)::integer AS question_count,
      count(DISTINCT q.id) FILTER (WHERE q.status = 'active')::integer AS active_question_count,
      count(DISTINCT e.id)::integer AS exam_count
    FROM question_banks qb
    LEFT JOIN questions q ON q.bank_id = qb.id
    LEFT JOIN exams e ON e.question_bank_id = qb.id AND e.status <> 'archived'
    WHERE qb.id = $1
    GROUP BY qb.id;`, [bankId]);
  return result.rows[0] ? mapQuestionBank(result.rows[0]) : null;
}

async function insertQuestionBankAudit(client, actorUserId, action, bankId, before, after) {
  await client.query(`
    INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, before_json, after_json)
    VALUES ($1, $2, $3, 'question_bank', $4, $5::jsonb, $6::jsonb);`, [
    crypto.randomUUID(), actorUserId, action, bankId,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after)
  ]);
}

async function createQuestionBank(pool, input, actorUserId) {
  const metadata = normalizeBankMetadata({ ...input, ownerId: input?.ownerId ?? actorUserId });
  const bankId = `question_bank_${crypto.randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO question_banks (id, name, description, status, owner_id, version)
      VALUES ($1, $2, $3, 'active', $4, 1);`, [
      bankId, metadata.name, metadata.description, metadata.ownerId
    ]);
    const created = await getQuestionBank(client, bankId);
    await insertQuestionBankAudit(client, actorUserId, "create_question_bank", bankId, null, created);
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23503") throw new QuestionBankError("题库负责人不存在");
    throw error;
  } finally {
    client.release();
  }
}

async function lockQuestionBank(client, bankId, expectedVersion) {
  const result = await client.query(`
    SELECT id, name, description, status, owner_id, version
    FROM question_banks
    WHERE id = $1
    FOR UPDATE;`, [bankId]);
  const bank = result.rows[0];
  if (!bank) throw new QuestionBankError("未找到题库", 404);
  if (Number(bank.version) !== expectedVersion) {
    throw new QuestionBankError("题库已被其他管理员修改，请刷新后重试", 409);
  }
  return bank;
}

function bankSnapshot(bank) {
  return {
    name: bank.name,
    description: bank.description || "",
    status: bank.status,
    ownerId: bank.owner_id || bank.ownerId || "",
    version: Number(bank.version)
  };
}

async function updateQuestionBank(pool, bankId, input, actorUserId) {
  const expectedVersion = normalizeBankVersion(input?.version);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await lockQuestionBank(client, bankId, expectedVersion);
    const metadata = normalizeBankMetadata(input, existing);
    const before = bankSnapshot(existing);
    await client.query(`
      UPDATE question_banks
      SET name = $2, description = $3, owner_id = $4, version = version + 1
      WHERE id = $1;`, [bankId, metadata.name, metadata.description, metadata.ownerId]);
    const updated = await getQuestionBank(client, bankId);
    await insertQuestionBankAudit(client, actorUserId, "update_question_bank", bankId, before, updated);
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23503") throw new QuestionBankError("题库负责人不存在");
    throw error;
  } finally {
    client.release();
  }
}

async function copyQuestionBank(pool, sourceBankId, input, actorUserId) {
  const expectedVersion = normalizeBankVersion(input?.version);
  const targetBankId = `question_bank_${crypto.randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const source = await lockQuestionBank(client, sourceBankId, expectedVersion);
    const metadata = normalizeBankMetadata({
      name: input?.name ?? `${source.name}（副本）`,
      description: input?.description ?? source.description,
      ownerId: input?.ownerId ?? actorUserId
    });
    await client.query(`
      INSERT INTO question_banks (id, name, description, status, owner_id, version)
      VALUES ($1, $2, $3, 'active', $4, 1);`, [
      targetBankId, metadata.name, metadata.description, metadata.ownerId
    ]);
    const questionResult = await client.query(`
      SELECT id, external_id, type, stem, images_json, options_json, answer_json,
        explanation, version, status
      FROM questions
      WHERE bank_id = $1
      ORDER BY id
      FOR SHARE;`, [sourceBankId]);
    for (const question of questionResult.rows) {
      await client.query(`
        INSERT INTO questions (
          id, bank_id, external_id, type, stem, images_json, options_json, answer_json,
          explanation, version, status
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, 1, $10);`, [
        `question_copy_${crypto.randomUUID()}`,
        targetBankId,
        question.external_id,
        question.type,
        question.stem,
        JSON.stringify(question.images_json || []),
        JSON.stringify(question.options_json || []),
        JSON.stringify(question.answer_json),
        question.explanation || "",
        question.status
      ]);
    }
    const copied = await getQuestionBank(client, targetBankId);
    await insertQuestionBankAudit(client, actorUserId, "copy_question_bank", targetBankId, null, {
      ...copied,
      sourceBankId,
      sourceVersion: Number(source.version)
    });
    await client.query("COMMIT");
    return copied;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23503") throw new QuestionBankError("题库负责人不存在");
    throw error;
  } finally {
    client.release();
  }
}

async function setQuestionBankStatus(pool, bankId, input, actorUserId, targetStatus) {
  const expectedVersion = normalizeBankVersion(input?.version);
  const action = targetStatus === "archived" ? "archive_question_bank" : "restore_question_bank";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await lockQuestionBank(client, bankId, expectedVersion);
    if (existing.status === targetStatus) {
      throw new QuestionBankError(targetStatus === "archived" ? "题库已归档" : "题库已恢复", 409);
    }
    const before = bankSnapshot(existing);
    await client.query(`
      UPDATE question_banks
      SET status = $2, version = version + 1
      WHERE id = $1;`, [bankId, targetStatus]);
    const updated = await getQuestionBank(client, bankId);
    await insertQuestionBankAudit(client, actorUserId, action, bankId, before, updated);
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function archiveQuestionBank(pool, bankId, input, actorUserId) {
  return setQuestionBankStatus(pool, bankId, input, actorUserId, "archived");
}

async function restoreQuestionBank(pool, bankId, input, actorUserId) {
  return setQuestionBankStatus(pool, bankId, input, actorUserId, "active");
}

async function deleteQuestionBank(pool, bankId, input, actorUserId) {
  const expectedVersion = normalizeBankVersion(input?.version);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await lockQuestionBank(client, bankId, expectedVersion);
    if (existing.status !== "archived") {
      throw new QuestionBankError("请先删除题库，再执行永久删除", 409);
    }
    const examRefs = await client.query(`
      SELECT COUNT(*)::integer AS count
      FROM exams e
      WHERE e.status <> 'archived'
        AND (
          e.question_bank_id = $1
          OR EXISTS (
            SELECT 1
            FROM exam_questions eq
            JOIN questions q ON q.id = eq.question_id
            WHERE eq.exam_id = e.id AND q.bank_id = $1
          )
        );`, [bankId]);
    if (Number(examRefs.rows[0]?.count || 0) > 0) {
      throw new QuestionBankError("该题库仍被试卷引用，不能永久删除；可以保留为已删除状态", 409);
    }
    const questionCount = await client.query(
      "SELECT COUNT(*)::integer AS count FROM questions WHERE bank_id = $1;",
      [bankId]
    );
    const before = bankSnapshot(existing);
    // Archived exams are retained for audit/history, but no longer need live
    // question-bank foreign-key relationships after the bank is purged.
    await client.query(`
      DELETE FROM exam_questions eq
      USING exams e, questions q
      WHERE eq.exam_id = e.id
        AND eq.question_id = q.id
        AND e.status = 'archived'
        AND q.bank_id = $1;`, [bankId]);
    await client.query(`
      UPDATE exams
      SET question_bank_id = NULL
      WHERE status = 'archived' AND question_bank_id = $1;`, [bankId]);
    await client.query("DELETE FROM questions WHERE bank_id = $1;", [bankId]);
    await client.query("DELETE FROM question_banks WHERE id = $1;", [bankId]);
    await insertQuestionBankAudit(client, actorUserId, "delete_question_bank", bankId, before, {
      ...before,
      status: "deleted",
      version: Number(existing.version) + 1,
      questionCount: Number(questionCount.rows[0]?.count || 0),
      examCount: 0
    });
    await client.query("COMMIT");
    return { id: bankId, status: "deleted", version: Number(existing.version) + 1 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function normalizeEditedOptions(type, options, existingOptions) {
  if (!OPTION_TYPES.has(type)) return [];
  if (!Array.isArray(options) || options.length < 2) throw new Error("选择题至少需要两个选项");

  const imageByLabel = new Map(normalizeStoredOptions(existingOptions).map((option) => [option.label, option.image]));
  const normalized = options.map((option) => ({
    label: String(option?.label || "").trim().toUpperCase(),
    text: String(option?.text || "").trim(),
    image: option?.image === undefined ? imageByLabel.get(String(option?.label || "").trim().toUpperCase()) : String(option.image || "").trim()
  }));
  if (normalized.some((option) => !/^[A-J]$/.test(option.label))) throw new Error("选项编号只允许 A 到 J");
  if (new Set(normalized.map((option) => option.label)).size !== normalized.length) throw new Error("选项编号不能重复");
  if (normalized.some((option) => !option.text && !option.image)) {
    throw new Error("没有图片的选项内容不能为空");
  }

  normalized.sort((left, right) => left.label.localeCompare(right.label));
  const staticUrls = new Set(Object.values(loadQuestionResourceManifest()).map((item) => item?.url).filter(Boolean));
  for (const option of normalized) {
    if (!option.image) continue;
    if (!staticUrls.has(option.image) && !uploadedResourceId(option.image) && !/^resource:[A-Za-z0-9_-]+$/.test(option.image)) {
      throw new Error("选项图片必须使用已登记的受控资源");
    }
  }
  return normalized.map((option) => option.image ? option : { label: option.label, text: option.text });
}

function normalizeEditedAnswer(type, answer, options) {
  const labels = new Set(options.map((option) => option.label));
  if (type === "multi") {
    if (!Array.isArray(answer) || !answer.length) throw new Error("多选题至少需要一个参考答案");
    const normalized = [...new Set(answer.map((item) => String(item || "").trim().toUpperCase()).filter(Boolean))].sort();
    if (normalized.some((item) => !labels.has(item))) throw new Error("参考答案必须来自现有选项");
    return normalized;
  }
  if (type === "single" || type === "judge") {
    const normalized = String(answer || "").trim().toUpperCase();
    if (!labels.has(normalized)) throw new Error("参考答案必须来自现有选项");
    return normalized;
  }
  if (type === "fill") {
    if (answer && typeof answer === "object" && !Array.isArray(answer)) {
      const blanks = Array.isArray(answer.blanks) ? answer.blanks : [];
      const normalizedBlanks = blanks.map((blank) => [...new Set((Array.isArray(blank) ? blank : [blank])
        .map((item) => String(item || "").trim()).filter(Boolean))]);
      if (!normalizedBlanks.length || normalizedBlanks.some((blank) => !blank.length)) throw new Error("填空题每个空至少需要一个参考答案");
      return { ordered: answer.ordered !== false, blanks: normalizedBlanks };
    }
    const source = Array.isArray(answer) ? answer : [answer];
    const normalized = [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))];
    if (!normalized.length) throw new Error("填空题至少需要一个参考答案");
    return normalized;
  }
  const normalized = String(answer || "").trim();
  if (!normalized) throw new Error("参考答案不能为空");
  return normalized;
}

function normalizeEditedImages(images, existingImages = []) {
  const source = images === undefined ? mapQuestionImages(existingImages) : images;
  if (!Array.isArray(source)) throw new Error("题目图片格式无效");
  if (source.length > 5) throw new Error("每道题最多上传 5 张图片");
  const normalized = source.map((value) => String(value || "").trim());
  if (normalized.some((value) => !value)) throw new Error("题目图片地址不能为空");
  if (new Set(normalized).size !== normalized.length) throw new Error("题目图片不能重复");

  const staticUrls = new Set(Object.values(loadQuestionResourceManifest()).map((item) => item?.url).filter(Boolean));
  if (normalized.some((value) => !staticUrls.has(value) && !uploadedResourceId(value))) {
    throw new Error("题目图片必须使用已登记的受控资源");
  }
  return normalized;
}

async function assertUploadedImagesExist(queryable, images) {
  const ids = images.flatMap((image) => Array.isArray(image) ? image : [image])
    .map(uploadedResourceId).filter(Boolean);
  if (!ids.length) return;
  const result = await queryable.query(`
    SELECT id
    FROM question_resources
    WHERE id = ANY($1::text[]);`, [ids]);
  if (result.rows.length !== new Set(ids).size) throw new Error("题目图片资源不存在，请重新上传");
}

function questionImageReferences(images, options) {
  return [
    ...(Array.isArray(images) ? images : []),
    ...(Array.isArray(options) ? options.map((option) => option.image).filter(Boolean) : [])
  ];
}

function normalizeQuestionEdit(existing, input) {
  const stem = String(input?.stem || "").trim();
  if (!stem) throw new Error("题干不能为空");
  if (stem.length > 20_000) throw new Error("题干内容过长");
  const explanation = String(input?.explanation || "").trim();
  if (explanation.length > 50_000) throw new Error("题目解析内容过长");
  const options = normalizeEditedOptions(existing.type, input?.options, existing.options_json);
  const answer = normalizeEditedAnswer(existing.type, input?.answer, options);
  const images = normalizeEditedImages(input?.images, existing.images_json);
  return { stem, images, options, answer, explanation };
}

function normalizeQuestionCreate(input) {
  const bankId = String(input?.bankId || "").trim();
  if (!bankId) throw new Error("请选择题库");
  const type = String(input?.type || "").trim();
  if (!QUESTION_TYPES.has(type)) throw new Error("不支持的题型");
  const externalId = String(input?.externalId || "").trim();
  if (externalId.length > 200) throw new Error("题目编号内容过长");
  const base = { type, options_json: [], images_json: [] };
  const edited = normalizeQuestionEdit(base, input);
  return { bankId, type, externalId: externalId || null, ...edited };
}

async function getQuestion(client, questionId) {
  const result = await client.query(`${QUESTION_SELECT} WHERE q.id = $1;`, [questionId]);
  return result.rows[0] ? mapQuestion(result.rows[0]) : null;
}

async function updateQuestion(pool, questionId, input, actorUserId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const bank = await client.query(`
      SELECT id
      FROM question_banks
      WHERE id = (SELECT bank_id FROM questions WHERE id = $1)
        AND status = 'active'
      FOR SHARE;`, [questionId]);
    if (!bank.rows.length) throw new Error("未找到可编辑的题目，或题库已归档");
    const locked = await client.query(`
      SELECT id, bank_id, external_id, type, stem, options_json, answer_json,
        images_json, explanation, version, status
      FROM questions
      WHERE id = $1
      FOR UPDATE;`, [questionId]);
    const existing = locked.rows[0];
    if (!existing || existing.status !== "active") throw new Error("未找到可编辑的题目");
    if (!Number.isInteger(Number(input?.version)) || Number(input.version) !== Number(existing.version)) {
      throw new Error("题目已被其他管理员修改，请刷新后重试");
    }

    const edited = normalizeQuestionEdit(existing, input);
    await assertUploadedImagesExist(client, questionImageReferences(edited.images, edited.options));
    const before = {
      stem: existing.stem,
      images: mapQuestionImages(existing.images_json || []),
      options: existing.options_json,
      answer: existing.answer_json,
      explanation: existing.explanation,
      version: Number(existing.version)
    };
    await client.query(`
      UPDATE questions
      SET stem = $2,
          images_json = $3::jsonb,
          options_json = $4::jsonb,
          answer_json = $5::jsonb,
          explanation = $6,
          version = version + 1
      WHERE id = $1;`, [
      questionId,
      edited.stem,
      JSON.stringify(edited.images),
      JSON.stringify(edited.options),
      JSON.stringify(edited.answer),
      edited.explanation
    ]);
    const affected = await client.query(`
      UPDATE exams
      SET version = version + 1
      WHERE id IN (SELECT exam_id FROM exam_questions WHERE question_id = $1)
      RETURNING id;`, [questionId]);
    const after = {
      ...edited,
      version: Number(existing.version) + 1,
      affectedExamIds: affected.rows.map((row) => row.id)
    };
    await client.query(`
      INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, before_json, after_json)
      VALUES ($1, $2, 'update_question', 'question', $3, $4::jsonb, $5::jsonb);`, [
      crypto.randomUUID(), actorUserId, questionId, JSON.stringify(before), JSON.stringify(after)
    ]);
    const updated = await getQuestion(client, questionId);
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function createQuestion(pool, input, actorUserId) {
  const created = normalizeQuestionCreate(input);
  const questionId = `question_manual_${crypto.randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const bank = await client.query(`
      SELECT id, name
      FROM question_banks
      WHERE id = $1 AND status = 'active'
      FOR UPDATE;`, [created.bankId]);
    if (!bank.rows.length) throw new Error("未找到可用题库");
    await assertUploadedImagesExist(client, questionImageReferences(created.images, created.options));
    await client.query(`
      INSERT INTO questions (
        id, bank_id, external_id, type, stem, images_json, options_json, answer_json,
        explanation, version, status
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, 1, 'active');`, [
      questionId,
      created.bankId,
      created.externalId,
      created.type,
      created.stem,
      JSON.stringify(created.images),
      JSON.stringify(created.options),
      JSON.stringify(created.answer),
      created.explanation
    ]);
    await client.query(`
      INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, before_json, after_json)
      VALUES ($1, $2, 'create_question', 'question', $3, '{}'::jsonb, $4::jsonb);`, [
      crypto.randomUUID(),
      actorUserId,
      questionId,
      JSON.stringify({
        bankId: created.bankId,
        externalId: created.externalId,
        type: created.type,
        images: created.images,
        version: 1,
        status: "active",
        examIds: []
      })
    ]);
    const question = await getQuestion(client, questionId);
    await client.query("COMMIT");
    return question;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") throw new Error("当前题库中已存在相同题目编号");
    throw error;
  } finally {
    client.release();
  }
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function exportQuestionBankCsv(pool, bankId) {
  const result = await pool.query(`${QUESTION_SELECT}
    WHERE q.bank_id = $1 AND q.status = 'active'
    ORDER BY COALESCE(q.external_id, q.id), q.id;`, [bankId]);
  const headers = require("../import/question-csv").CSV_HEADERS;
  const rows = result.rows.map((row) => {
    const question = mapQuestion(row);
    const values = Object.fromEntries(headers.map((header) => [header, ""]));
    values.external_id = question.externalId;
    values.type = question.type;
    values.stem = question.stem;
    for (const option of question.options || []) {
      values[`option_${String(option.label).toLowerCase()}`] = option.text || "";
      // Preserve both static controlled assets and database-uploaded resources.
      values[`option_image_${String(option.label).toLowerCase()}`] = option.image || "";
    }
    values.answer = Array.isArray(question.answer) ? question.answer.join("|") : (question.answer || "");
    values.score = "0";
    values.explanation = question.explanation || "";
    values.image_urls = (question.images || []).join("|");
    return headers.map((header) => csvCell(values[header])).join(",");
  });
  return `${headers.join(",")}\n${rows.join("\n")}\n`;
}

async function importQuestionBankCsv(pool, bankId, questions, actorUserId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const bank = await client.query("SELECT id, status FROM question_banks WHERE id = $1 FOR UPDATE", [bankId]);
    if (!bank.rows.length) throw new QuestionBankError("未找到题库", 404);
    if (bank.rows[0].status !== "active") throw new QuestionBankError("已归档题库不可导入题目", 409);
    const inserted = [];
    for (const question of questions) {
      const options = (question.options || []).map((option) => ({
        label: option.label,
        text: option.text,
        ...(question.optionImages?.[option.label] ? { image: question.optionImages[option.label] } : {})
      }));
      await assertUploadedImagesExist(client, questionImageReferences(question.imageUrls || [], options));
      const id = `question_import_${crypto.randomUUID()}`;
      await client.query(`
        INSERT INTO questions (id, bank_id, external_id, type, stem, images_json, options_json, answer_json, explanation, score, version, status)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, 1, 'active');`, [
        id, bankId, question.externalId || null, question.type, question.stem,
        JSON.stringify(question.imageUrls || []), JSON.stringify(options), JSON.stringify(question.answer), question.explanation || "", Number(question.score || 0)
      ]);
      inserted.push(id);
      await client.query(`INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, before_json, after_json)
        VALUES ($1, $2, 'import_question', 'question', $3, '{}'::jsonb, $4::jsonb);`, [
        crypto.randomUUID(), actorUserId, id, JSON.stringify({ bankId, externalId: question.externalId, type: question.type, version: 1 })
      ]);
    }
    await client.query("UPDATE question_banks SET version = version + 1 WHERE id = $1", [bankId]);
    await client.query("COMMIT");
    return { importedCount: inserted.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") throw new QuestionBankError("题库中存在重复题目编号", 409);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  QuestionBankError,
  archiveQuestionBank,
  deleteQuestionBank,
  copyQuestionBank,
  createQuestionBank,
  createQuestion,
  getQuestionBank,
  listManagedQuestionBanks,
  listQuestions,
  listQuestionBanks,
  mapQuestion,
  mapQuestionBank,
  normalizeBankMetadata,
  normalizeBankVersion,
  normalizeEditedImages,
  normalizeEditedAnswer,
  normalizeEditedOptions,
  normalizeQuestionCreate,
  normalizeQuestionEdit,
  normalizeStoredOptions,
  restoreQuestionBank,
  updateQuestionBank,
  updateQuestion,
  exportQuestionBankCsv,
  importQuestionBankCsv
};
