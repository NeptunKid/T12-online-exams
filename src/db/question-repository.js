const crypto = require("node:crypto");

const OPTION_TYPES = new Set(["single", "multi", "judge"]);

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
    options: options.map((option) => ({
      label: option.label,
      text: option.text,
      hasImage: Boolean(option.image)
    })),
    answer: row.answer_json,
    explanation: row.explanation || "",
    score: Number(row.score),
    version: Number(row.version),
    status: row.status,
    exams: Array.isArray(row.exam_refs) ? row.exam_refs : []
  };
}

const QUESTION_SELECT = `
  SELECT q.id, q.bank_id, qb.name AS bank_name, q.external_id, q.type, q.stem,
    q.options_json, q.answer_json, q.explanation, q.score, q.version, q.status,
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
    WHERE q.status = 'active'
    ORDER BY qb.name, COALESCE(q.external_id, q.id), q.id;`);
  return result.rows.map(mapQuestion);
}

function normalizeEditedOptions(type, options, existingOptions) {
  if (!OPTION_TYPES.has(type)) return [];
  if (!Array.isArray(options) || options.length < 2) throw new Error("选择题至少需要两个选项");

  const imageByLabel = new Map(normalizeStoredOptions(existingOptions).map((option) => [option.label, option.image]));
  const normalized = options.map((option) => ({
    label: String(option?.label || "").trim().toUpperCase(),
    text: String(option?.text || "").trim()
  }));
  if (normalized.some((option) => !/^[A-J]$/.test(option.label))) throw new Error("选项编号只允许 A 到 J");
  if (new Set(normalized.map((option) => option.label)).size !== normalized.length) throw new Error("选项编号不能重复");
  if (normalized.some((option) => !option.text && !imageByLabel.get(option.label))) {
    throw new Error("没有图片的选项内容不能为空");
  }

  normalized.sort((left, right) => left.label.localeCompare(right.label));
  return normalized.map((option) => ({
    ...option,
    ...(imageByLabel.get(option.label) ? { image: imageByLabel.get(option.label) } : {})
  }));
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
    const source = Array.isArray(answer) ? answer : [answer];
    const normalized = [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))];
    if (!normalized.length) throw new Error("填空题至少需要一个参考答案");
    return normalized;
  }
  const normalized = String(answer || "").trim();
  if (!normalized) throw new Error("参考答案不能为空");
  return normalized;
}

function normalizeQuestionEdit(existing, input) {
  const stem = String(input?.stem || "").trim();
  if (!stem) throw new Error("题干不能为空");
  if (stem.length > 20_000) throw new Error("题干内容过长");
  const explanation = String(input?.explanation || "").trim();
  if (explanation.length > 50_000) throw new Error("题目解析内容过长");
  const options = normalizeEditedOptions(existing.type, input?.options, existing.options_json);
  const answer = normalizeEditedAnswer(existing.type, input?.answer, options);
  return { stem, options, answer, explanation };
}

async function getQuestion(client, questionId) {
  const result = await client.query(`${QUESTION_SELECT} WHERE q.id = $1;`, [questionId]);
  return result.rows[0] ? mapQuestion(result.rows[0]) : null;
}

async function updateQuestion(pool, questionId, input, actorUserId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(`
      SELECT id, bank_id, external_id, type, stem, options_json, answer_json,
        explanation, score, version, status
      FROM questions
      WHERE id = $1
      FOR UPDATE;`, [questionId]);
    const existing = locked.rows[0];
    if (!existing || existing.status !== "active") throw new Error("未找到可编辑的题目");
    if (!Number.isInteger(Number(input?.version)) || Number(input.version) !== Number(existing.version)) {
      throw new Error("题目已被其他管理员修改，请刷新后重试");
    }

    const edited = normalizeQuestionEdit(existing, input);
    const before = {
      stem: existing.stem,
      options: existing.options_json,
      answer: existing.answer_json,
      explanation: existing.explanation,
      version: Number(existing.version)
    };
    await client.query(`
      UPDATE questions
      SET stem = $2,
          options_json = $3::jsonb,
          answer_json = $4::jsonb,
          explanation = $5,
          version = version + 1
      WHERE id = $1;`, [
      questionId,
      edited.stem,
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

module.exports = {
  listQuestions,
  mapQuestion,
  normalizeEditedAnswer,
  normalizeEditedOptions,
  normalizeQuestionEdit,
  normalizeStoredOptions,
  updateQuestion
};
