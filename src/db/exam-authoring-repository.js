const crypto = require("node:crypto");

class ExamAuthoringError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "ExamAuthoringError";
    this.statusCode = statusCode;
  }
}

function asNumber(value) {
  return Number(value || 0);
}

function normalizeVersion(value) {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new ExamAuthoringError("试卷版本无效，请刷新后重试");
  }
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new ExamAuthoringError("试卷版本无效，请刷新后重试");
  }
  return version;
}

function normalizeScore(value) {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new ExamAuthoringError("题目分值必须是有效的非负数");
  }
  const source = typeof value === "string" ? value.trim() : value;
  const score = Number(source);
  if (source === "" || !Number.isFinite(score) || score < 0 || score > 99_999_999.99) {
    throw new ExamAuthoringError("题目分值必须是有效的非负数");
  }
  if (Math.abs(Math.round(score * 100) - score * 100) > 1e-8) {
    throw new ExamAuthoringError("题目分值最多保留两位小数");
  }
  return score;
}

function normalizeQuestionIds(questionIds, { allowEmpty = true } = {}) {
  if (!Array.isArray(questionIds)) throw new ExamAuthoringError("题目列表格式无效");
  const normalized = questionIds.map((id) => String(id || "").trim());
  if (normalized.some((id) => !id)) throw new ExamAuthoringError("题目标识不能为空");
  if (new Set(normalized).size !== normalized.length) throw new ExamAuthoringError("题目列表不能包含重复项");
  if (!allowEmpty && normalized.length === 0) throw new ExamAuthoringError("题目列表不能为空");
  return normalized;
}

function mapExamSummary(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    duration: Number(row.duration_seconds),
    totalScore: asNumber(row.total_score),
    passScore: asNumber(row.pass_score),
    passRate: asNumber(row.pass_rate),
    version: Number(row.version),
    questionBankId: row.question_bank_id || "",
    questionBankName: row.question_bank_name || "",
    questionCount: Number(row.question_count || 0)
  };
}

function mapAuthoringQuestion(row) {
  return {
    id: row.id,
    externalId: row.external_id || "",
    type: row.type,
    stem: row.stem,
    status: row.status,
    selected: row.position !== null && row.position !== undefined,
    position: row.position === null || row.position === undefined ? null : Number(row.position),
    score: row.score === null || row.score === undefined ? null : asNumber(row.score)
  };
}

async function listAuthoringExams(pool) {
  const result = await pool.query(`
    SELECT e.id, e.title, e.status, e.duration_seconds, e.total_score, e.pass_score,
      e.pass_rate, e.version, e.question_bank_id, qb.name AS question_bank_name,
      count(eq.question_id)::integer AS question_count
    FROM exams e
    LEFT JOIN question_banks qb ON qb.id = e.question_bank_id
    LEFT JOIN exam_questions eq ON eq.exam_id = e.id
    WHERE e.status <> 'archived'
    GROUP BY e.id, qb.name
    ORDER BY e.updated_at DESC, e.id;`);
  return result.rows.map(mapExamSummary);
}

async function getExamAuthoring(queryable, examId) {
  const examResult = await queryable.query(`
    SELECT e.id, e.title, e.status, e.duration_seconds, e.total_score, e.pass_score,
      e.pass_rate, e.version, e.question_bank_id, qb.name AS question_bank_name,
      count(eq.question_id)::integer AS question_count
    FROM exams e
    LEFT JOIN question_banks qb ON qb.id = e.question_bank_id
    LEFT JOIN exam_questions eq ON eq.exam_id = e.id
    WHERE e.id = $1
    GROUP BY e.id, qb.name;`, [examId]);
  if (!examResult.rows.length) return null;

  const exam = mapExamSummary(examResult.rows[0]);
  if (!exam.questionBankId) return { ...exam, questions: [] };
  const questions = await queryable.query(`
    SELECT q.id, q.external_id, q.type, q.stem, q.status, eq.position, eq.score
    FROM questions q
    LEFT JOIN exam_questions eq ON eq.exam_id = $1 AND eq.question_id = q.id
    WHERE q.bank_id = $2
      AND (q.status = 'active' OR eq.question_id IS NOT NULL)
    ORDER BY (eq.position IS NULL), eq.position,
      COALESCE(NULLIF(q.external_id, ''), q.id), q.id;`, [examId, exam.questionBankId]);
  return { ...exam, questions: questions.rows.map(mapAuthoringQuestion) };
}

async function lockDraftExam(client, examId, expectedVersion) {
  const result = await client.query(`
    SELECT e.id, e.title, e.status, e.duration_seconds, e.total_score, e.pass_score,
      e.pass_rate, e.version, e.question_bank_id, qb.name AS question_bank_name
    FROM exams e
    LEFT JOIN question_banks qb ON qb.id = e.question_bank_id
    WHERE e.id = $1
    FOR UPDATE OF e;`, [examId]);
  const exam = result.rows[0];
  if (!exam) throw new ExamAuthoringError("未找到试卷", 404);
  if (exam.status !== "draft") throw new ExamAuthoringError("只能修改草稿试卷的题目", 409);
  if (Number(exam.version) !== expectedVersion) {
    throw new ExamAuthoringError("试卷已被其他管理员修改，请刷新后重试", 409);
  }
  return exam;
}

async function loadSelection(client, examId, lock = false) {
  const result = await client.query(`
    SELECT eq.question_id, eq.position, eq.score, q.bank_id, q.status AS question_status
    FROM exam_questions eq
    JOIN questions q ON q.id = eq.question_id
    WHERE eq.exam_id = $1
    ORDER BY eq.position${lock ? "\n    FOR UPDATE" : ""};`, [examId]);
  return result.rows.map((row) => ({
    questionId: row.question_id,
    position: Number(row.position),
    score: asNumber(row.score),
    bankId: row.bank_id,
    status: row.question_status
  }));
}

function assertSelectionBelongsToBank(selected, bankId) {
  if (!bankId) throw new ExamAuthoringError("请先为试卷绑定题库");
  if (selected.some((item) => item.bankId !== bankId || item.status !== "active")) {
    throw new ExamAuthoringError("试卷包含其他题库或已归档题目，请先重新选题", 409);
  }
}

function snapshotExam(exam, questions) {
  return {
    version: Number(exam.version),
    questionBankId: exam.question_bank_id || "",
    totalScore: asNumber(exam.total_score),
    passScore: asNumber(exam.pass_score),
    questions
  };
}

async function recalculateExam(client, examId) {
  const result = await client.query(`
    UPDATE exams e
    SET total_score = totals.total_score,
      pass_score = ROUND(totals.total_score * e.pass_rate, 2),
      version = e.version + 1
    FROM (
      SELECT COALESCE(SUM(eq.score), 0)::numeric AS total_score
      FROM exam_questions eq
      WHERE eq.exam_id = $1
    ) totals
    WHERE e.id = $1
    RETURNING e.id, e.title, e.status, e.duration_seconds, e.total_score, e.pass_score,
      e.pass_rate, e.version, e.question_bank_id;`, [examId]);
  return result.rows[0];
}

async function mutateExam(pool, examId, input, actorUserId, action, mutation) {
  const expectedVersion = normalizeVersion(input?.version);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const exam = await lockDraftExam(client, examId, expectedVersion);
    const beforeQuestions = await loadSelection(client, examId, true);
    const before = snapshotExam(exam, beforeQuestions);
    await mutation(client, exam, beforeQuestions);
    const updated = await recalculateExam(client, examId);
    const afterQuestions = await loadSelection(client, examId);
    const after = snapshotExam(updated, afterQuestions);
    await client.query(`
      INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, before_json, after_json)
      VALUES ($1, $2, $3, 'exam', $4, $5::jsonb, $6::jsonb);`, [
      crypto.randomUUID(), actorUserId, action, examId, JSON.stringify(before), JSON.stringify(after)
    ]);
    const detail = await getExamAuthoring(client, examId);
    await client.query("COMMIT");
    return detail;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function bindExamQuestionBank(pool, examId, input, actorUserId) {
  const bankId = String(input?.bankId || "").trim();
  if (!bankId) throw new ExamAuthoringError("请选择题库");
  return mutateExam(pool, examId, input, actorUserId, "bind_exam_question_bank", async (client, exam, selected) => {
    const bank = await client.query(`
      SELECT id, name
      FROM question_banks
      WHERE id = $1 AND status = 'active'
      FOR SHARE;`, [bankId]);
    if (!bank.rows.length) throw new ExamAuthoringError("未找到可用题库");
    if (exam.question_bank_id && exam.question_bank_id !== bankId && selected.length > 0) {
      throw new ExamAuthoringError("试卷已有题目，请先清空选题再更换题库", 409);
    }
    if (selected.length) assertSelectionBelongsToBank(selected, bankId);
    await client.query("UPDATE exams SET question_bank_id = $2 WHERE id = $1;", [examId, bankId]);
  });
}

async function setExamQuestions(pool, examId, input, actorUserId) {
  const selectAll = input?.selectAll === true;
  const requestedIds = selectAll ? null : normalizeQuestionIds(input?.questionIds);
  return mutateExam(pool, examId, input, actorUserId, "set_exam_questions", async (client, exam, selected) => {
    if (!exam.question_bank_id) throw new ExamAuthoringError("请先为试卷绑定题库");
    let questionIds = requestedIds;
    if (selectAll) {
      const result = await client.query(`
        SELECT q.id
        FROM questions q
        WHERE q.bank_id = $1 AND q.status = 'active'
        ORDER BY COALESCE(NULLIF(q.external_id, ''), q.id), q.id
        FOR SHARE;`, [exam.question_bank_id]);
      questionIds = result.rows.map((row) => row.id);
    } else if (questionIds.length) {
      const result = await client.query(`
        SELECT q.id
        FROM questions q
        WHERE q.id = ANY($1::text[])
          AND q.bank_id = $2
          AND q.status = 'active'
        FOR SHARE;`, [questionIds, exam.question_bank_id]);
      if (result.rows.length !== questionIds.length) {
        throw new ExamAuthoringError("选中的题目包含其他题库或已归档题目");
      }
    }

    const scoreByQuestion = new Map(selected.map((item) => [item.questionId, item.score]));
    await client.query("DELETE FROM exam_questions WHERE exam_id = $1;", [examId]);
    if (questionIds.length) {
      const positions = questionIds.map((_, index) => index + 1);
      const scores = questionIds.map((id) => scoreByQuestion.get(id) ?? 0);
      await client.query(`
        INSERT INTO exam_questions (exam_id, question_id, position, score)
        SELECT $1, selected.question_id, selected.position, selected.score
        FROM unnest($2::text[], $3::integer[], $4::numeric[]) AS selected(question_id, position, score);`, [
        examId, questionIds, positions, scores
      ]);
    }
  });
}

async function reorderExamQuestions(pool, examId, input, actorUserId) {
  const orderedIds = normalizeQuestionIds(input?.questionIds, { allowEmpty: false });
  return mutateExam(pool, examId, input, actorUserId, "reorder_exam_questions", async (client, _exam, selected) => {
    assertSelectionBelongsToBank(selected, _exam.question_bank_id);
    const selectedIds = new Set(selected.map((item) => item.questionId));
    if (orderedIds.length !== selected.length || orderedIds.some((id) => !selectedIds.has(id))) {
      throw new ExamAuthoringError("排序必须包含试卷当前的全部题目");
    }
    const offset = selected.length + 1;
    await client.query("UPDATE exam_questions SET position = position + $2 WHERE exam_id = $1;", [examId, offset]);
    await client.query(`
      UPDATE exam_questions eq
      SET position = ordered.position
      FROM unnest($2::text[]) WITH ORDINALITY AS ordered(question_id, position)
      WHERE eq.exam_id = $1 AND eq.question_id = ordered.question_id;`, [examId, orderedIds]);
  });
}

async function updateExamQuestionScore(pool, examId, questionId, input, actorUserId) {
  const normalizedQuestionId = String(questionId || "").trim();
  if (!normalizedQuestionId) throw new ExamAuthoringError("题目标识不能为空");
  const score = normalizeScore(input?.score);
  return mutateExam(pool, examId, input, actorUserId, "update_exam_question_score", async (client, exam, selected) => {
    assertSelectionBelongsToBank(selected, exam.question_bank_id);
    const result = await client.query(`
      UPDATE exam_questions
      SET score = $3
      WHERE exam_id = $1 AND question_id = $2
      RETURNING question_id;`, [examId, normalizedQuestionId, score]);
    if (!result.rows.length) throw new ExamAuthoringError("该题目不在当前试卷中", 404);
  });
}

async function updateAllExamQuestionScores(pool, examId, input, actorUserId) {
  const score = normalizeScore(input?.score);
  return mutateExam(pool, examId, input, actorUserId, "update_all_exam_question_scores", async (client, _exam, selected) => {
    if (!selected.length) throw new ExamAuthoringError("当前试卷没有可修改分值的题目");
    assertSelectionBelongsToBank(selected, _exam.question_bank_id);
    await client.query("UPDATE exam_questions SET score = $2 WHERE exam_id = $1;", [examId, score]);
  });
}

module.exports = {
  ExamAuthoringError,
  bindExamQuestionBank,
  getExamAuthoring,
  listAuthoringExams,
  mapAuthoringQuestion,
  mapExamSummary,
  normalizeQuestionIds,
  normalizeScore,
  reorderExamQuestions,
  setExamQuestions,
  updateAllExamQuestionScores,
  updateExamQuestionScore
};
