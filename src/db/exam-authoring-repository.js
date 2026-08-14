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

function normalizeTitle(value) {
  const title = String(value || "").trim();
  if (!title) throw new ExamAuthoringError("试卷名称不能为空");
  if (title.length > 200) throw new ExamAuthoringError("试卷名称过长");
  return title;
}

function normalizeDuration(value) {
  const duration = Number(value);
  if (!Number.isInteger(duration) || duration < 60 || duration > 86_400) {
    throw new ExamAuthoringError("考试时长必须是 1 分钟至 24 小时之间的整秒数");
  }
  return duration;
}

function normalizePassRate(value) {
  const passRate = Number(value);
  if (!Number.isFinite(passRate) || passRate < 0 || passRate > 1) {
    throw new ExamAuthoringError("通过比例必须为 0 到 1 之间的数值");
  }
  if (Math.abs(Math.round(passRate * 1_000_000) - passRate * 1_000_000) > 1e-8) {
    throw new ExamAuthoringError("通过比例最多保留六位小数");
  }
  return passRate;
}

function normalizeAnswerRules(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExamAuthoringError("作答规则格式无效");
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 20_000) throw new ExamAuthoringError("作答规则内容过长");
  return value;
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
    questionCount: Number(row.question_count || 0),
    answerRules: row.answer_rules_json || {}
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
      e.pass_rate, e.version, e.answer_rules_json, e.question_bank_id, qb.name AS question_bank_name,
      count(eq.question_id)::integer AS question_count
    FROM exams e
    LEFT JOIN question_banks qb ON qb.id = e.question_bank_id
    LEFT JOIN exam_questions eq ON eq.exam_id = e.id
    GROUP BY e.id, qb.name
    ORDER BY (e.status = 'archived'), e.updated_at DESC, e.id;`);
  return result.rows.map(mapExamSummary);
}

async function getExamAuthoring(queryable, examId) {
  const examResult = await queryable.query(`
    SELECT e.id, e.title, e.status, e.duration_seconds, e.total_score, e.pass_score,
      e.pass_rate, e.version, e.answer_rules_json, e.question_bank_id, qb.name AS question_bank_name,
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

async function lockDraftExam(client, examId, expectedVersion, allowRevision = false) {
  const result = await client.query(`
    SELECT e.id, e.title, e.status, e.duration_seconds, e.total_score, e.pass_score,
      e.pass_rate, e.version, e.answer_rules_json, e.question_bank_id, qb.name AS question_bank_name
    FROM exams e
    LEFT JOIN question_banks qb ON qb.id = e.question_bank_id
    WHERE e.id = $1
    FOR UPDATE OF e;`, [examId]);
  const exam = result.rows[0];
  if (!exam) throw new ExamAuthoringError("未找到试卷", 404);
  if (exam.status !== "draft") {
    if (!allowRevision || !new Set(["published", "scheduled", "paused", "closed"]).has(exam.status)) {
      throw new ExamAuthoringError("只能修改草稿试卷的题目", 409);
    }
  }
  if (Number(exam.version) !== expectedVersion) {
    throw new ExamAuthoringError("试卷已被其他管理员修改，请刷新后重试", 409);
  }
  return exam;
}

async function insertExamAudit(client, actorUserId, action, examId, before, after) {
  await client.query(`
    INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, before_json, after_json)
    VALUES ($1, $2, $3, 'exam', $4, $5::jsonb, $6::jsonb);`, [
    crypto.randomUUID(), actorUserId, action, examId,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after)
  ]);
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

async function assertActiveQuestionBank(client, bankId) {
  if (!bankId) throw new ExamAuthoringError("请先为试卷绑定题库");
  const result = await client.query(`
    SELECT id
    FROM question_banks
    WHERE id = $1 AND status = 'active'
    FOR SHARE;`, [bankId]);
  if (!result.rows.length) throw new ExamAuthoringError("当前题库已归档，不能用于新组卷", 409);
}

function assertSelectionBelongsToBank(selected, bankId) {
  if (!bankId) throw new ExamAuthoringError("请先为试卷绑定题库");
  if (selected.some((item) => item.bankId !== bankId || item.status !== "active")) {
    throw new ExamAuthoringError("试卷包含其他题库或已归档题目，请先重新选题", 409);
  }
}

function snapshotExam(exam, questions) {
  return {
    title: exam.title,
    status: exam.status,
    duration: Number(exam.duration_seconds),
    version: Number(exam.version),
    questionBankId: exam.question_bank_id || "",
    totalScore: asNumber(exam.total_score),
    passScore: asNumber(exam.pass_score),
    passRate: asNumber(exam.pass_rate),
    answerRules: exam.answer_rules_json || {},
    questions
  };
}

async function recalculateExam(client, examId, allowRevision = false) {
  const result = await client.query(`
    UPDATE exams e
    SET status = CASE WHEN $2::boolean AND e.status <> 'draft' THEN 'draft' ELSE e.status END,
      total_score = totals.total_score,
      pass_score = ROUND(totals.total_score * e.pass_rate, 2),
      version = e.version + 1
    FROM (
      SELECT COALESCE(SUM(eq.score), 0)::numeric AS total_score
      FROM exam_questions eq
    WHERE eq.exam_id = $1
    ) totals
    WHERE e.id = $1
    RETURNING e.id, e.title, e.status, e.duration_seconds, e.total_score, e.pass_score,
      e.pass_rate, e.version, e.answer_rules_json, e.question_bank_id;`, [examId, allowRevision]);
  return result.rows[0];
}

async function mutateExam(pool, examId, input, actorUserId, action, mutation) {
  const expectedVersion = normalizeVersion(input?.version);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const allowRevision = input?.revision === true;
    const exam = await lockDraftExam(client, examId, expectedVersion, allowRevision);
    const beforeQuestions = await loadSelection(client, examId, true);
    const before = snapshotExam(exam, beforeQuestions);
    await mutation(client, exam, beforeQuestions);
    const updated = await recalculateExam(client, examId, allowRevision);
    const afterQuestions = await loadSelection(client, examId);
    const after = snapshotExam(updated, afterQuestions);
    await insertExamAudit(client, actorUserId, action, examId, before, after);
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

function normalizeExamSettings(input, existing = null) {
  const title = normalizeTitle(input?.title ?? existing?.title);
  const duration = normalizeDuration(input?.durationSeconds ?? input?.duration ?? existing?.duration_seconds);
  const answerRules = normalizeAnswerRules(input?.answerRules ?? existing?.answer_rules_json) || {};
  let passRate;
  if (input?.passRate !== undefined) {
    passRate = normalizePassRate(input.passRate);
  } else if (input?.passScore !== undefined) {
    const totalScore = asNumber(existing?.total_score);
    const passScore = normalizeScore(input.passScore);
    if (totalScore <= 0 && passScore > 0) throw new ExamAuthoringError("空试卷的通过分必须为 0");
    if (passScore > totalScore) throw new ExamAuthoringError("通过分不能高于试卷总分");
    passRate = totalScore > 0 ? normalizePassRate(passScore / totalScore) : 0;
  } else {
    passRate = normalizePassRate(existing?.pass_rate ?? 0.6);
  }
  return { title, duration, passRate, answerRules };
}

async function createExam(pool, input, actorUserId) {
  const settings = normalizeExamSettings(input);
  const bankId = String(input?.questionBankId || input?.bankId || "").trim() || null;
  const examId = `exam-${crypto.randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (bankId) {
      const bank = await client.query(
        "SELECT id FROM question_banks WHERE id = $1 AND status = 'active' FOR SHARE;",
        [bankId]
      );
      if (!bank.rows.length) throw new ExamAuthoringError("未找到可用题库");
    }
    await client.query(`
      INSERT INTO exams (
        id, title, status, duration_seconds, pass_score, total_score, pass_rate,
        version, answer_rules_json, question_bank_id, created_by
      ) VALUES ($1, $2, 'draft', $3, 0, 0, $4, 1, $5::jsonb, $6, $7);`, [
      examId, settings.title, settings.duration, settings.passRate,
      JSON.stringify(settings.answerRules), bankId, actorUserId
    ]);
    await client.query(`
      INSERT INTO exam_assignments (id, exam_id, subject_type, subject_id)
      VALUES ('assignment-' || md5($1), $1, 'group', 'all-active-users');`, [examId]);
    const detail = await getExamAuthoring(client, examId);
    const after = snapshotExam({
      title: settings.title, status: "draft", duration_seconds: settings.duration,
      version: 1, question_bank_id: bankId, total_score: 0, pass_score: 0,
      pass_rate: settings.passRate, answer_rules_json: settings.answerRules
    }, []);
    await insertExamAudit(client, actorUserId, "create_exam", examId, null, after);
    await client.query("COMMIT");
    return detail;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function copyExam(pool, sourceExamId, input, actorUserId) {
  const expectedVersion = normalizeVersion(input?.version);
  const newExamId = `exam-${crypto.randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sourceResult = await client.query(`
      SELECT id, title, status, duration_seconds, total_score, pass_score, pass_rate,
        version, answer_rules_json, question_bank_id
      FROM exams
      WHERE id = $1 AND status <> 'archived'
      FOR SHARE;`, [sourceExamId]);
    const source = sourceResult.rows[0];
    if (!source) throw new ExamAuthoringError("未找到可复制的试卷", 404);
    if (Number(source.version) !== expectedVersion) {
      throw new ExamAuthoringError("试卷已被其他管理员修改，请刷新后重试", 409);
    }
    if (source.question_bank_id) await assertActiveQuestionBank(client, source.question_bank_id);
    const title = input?.title === undefined ? `${source.title}（副本）` : normalizeTitle(input.title);
    await client.query(`
      INSERT INTO exams (
        id, title, status, duration_seconds, pass_score, total_score, pass_rate,
        version, answer_rules_json, question_bank_id, created_by
      ) VALUES ($1, $2, 'draft', $3, $4, $5, $6, 1, $7::jsonb, $8, $9);`, [
      newExamId, title, source.duration_seconds, source.pass_score, source.total_score,
      source.pass_rate, JSON.stringify(source.answer_rules_json || {}), source.question_bank_id, actorUserId
    ]);
    await client.query(`
      INSERT INTO exam_questions (exam_id, question_id, position, score, section)
      SELECT $2, question_id, position, score, section
      FROM exam_questions
      WHERE exam_id = $1
      ORDER BY position;`, [sourceExamId, newExamId]);
    await client.query(`
      INSERT INTO exam_assignments (id, exam_id, subject_type, subject_id, starts_at, ends_at)
      SELECT 'assignment-' || md5($2 || ':' || id), $2, subject_type, subject_id, starts_at, ends_at
      FROM exam_assignments
      WHERE exam_id = $1;`, [sourceExamId, newExamId]);
    const detail = await getExamAuthoring(client, newExamId);
    await insertExamAudit(client, actorUserId, "copy_exam", newExamId, null, {
      sourceExamId,
      sourceVersion: Number(source.version),
      ...snapshotExam({ ...source, id: newExamId, title, status: "draft", version: 1 },
        await loadSelection(client, newExamId))
    });
    await client.query("COMMIT");
    return detail;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function reopenExamRevision(pool, examId, input, actorUserId) {
  const expectedVersion = normalizeVersion(input?.version);
  if (input?.legacy === true) return getExamAuthoring(pool, examId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`
      SELECT id, title, status, duration_seconds, total_score, pass_score, pass_rate,
        version, answer_rules_json, question_bank_id
      FROM exams
      WHERE id = $1
      FOR UPDATE;`, [examId]);
    const exam = result.rows[0];
    if (!exam) throw new ExamAuthoringError("未找到试卷", 404);
    if (Number(exam.version) !== expectedVersion) {
      throw new ExamAuthoringError("试卷已被其他管理员修改，请刷新后重试", 409);
    }
    if (exam.status === "draft") throw new ExamAuthoringError("试卷已处于可编辑草稿状态", 409);
    if (!new Set(["published", "scheduled", "paused", "closed"]).has(exam.status)) {
      throw new ExamAuthoringError("当前试卷状态不支持开始新版本", 409);
    }
    await assertActiveQuestionBank(client, exam.question_bank_id);
    const questions = await loadSelection(client, examId, true);
    const before = snapshotExam(exam, questions);
    const updated = await client.query(`
      UPDATE exams
      SET status = 'draft', version = version + 1
      WHERE id = $1
      RETURNING id, title, status, duration_seconds, total_score, pass_score, pass_rate,
        version, answer_rules_json, question_bank_id;`, [examId]);
    const after = snapshotExam(updated.rows[0], questions);
    await insertExamAudit(client, actorUserId, "reopen_exam_revision", examId, before, after);
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

async function updateExamSettings(pool, examId, input, actorUserId) {
  return mutateExam(pool, examId, input, actorUserId, "update_exam_settings", async (client, exam) => {
    await assertActiveQuestionBank(client, exam.question_bank_id);
    const settings = normalizeExamSettings(input, exam);
    await client.query(`
      UPDATE exams
      SET title = $2, duration_seconds = $3, pass_rate = $4, answer_rules_json = $5::jsonb
      WHERE id = $1;`, [
      examId, settings.title, settings.duration, settings.passRate, JSON.stringify(settings.answerRules)
    ]);
  });
}

async function publishExam(pool, examId, input, actorUserId) {
  const expectedVersion = normalizeVersion(input?.version);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const exam = await lockDraftExam(client, examId, expectedVersion);
    await assertActiveQuestionBank(client, exam.question_bank_id);
    const questions = await loadSelection(client, examId, true);
    if (!questions.length) throw new ExamAuthoringError("试卷至少需要选择一道试题");
    assertSelectionBelongsToBank(questions, exam.question_bank_id);
    if (asNumber(exam.total_score) <= 0) throw new ExamAuthoringError("试卷总分必须大于 0");
    const before = snapshotExam(exam, questions);
    const result = await client.query(`
      UPDATE exams
      SET status = 'published', version = version + 1
      WHERE id = $1
      RETURNING id, title, status, duration_seconds, total_score, pass_score, pass_rate,
        version, answer_rules_json, question_bank_id;`, [examId]);
    const after = snapshotExam(result.rows[0], questions);
    await insertExamAudit(client, actorUserId, "publish_exam_revision", examId, before, after);
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

async function setExamArchiveStatus(pool, examId, input, actorUserId, restore = false) {
  const expectedVersion = normalizeVersion(input?.version);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`
      SELECT id, title, status, duration_seconds, total_score, pass_score, pass_rate,
        version, answer_rules_json, question_bank_id
      FROM exams
      WHERE id = $1
      FOR UPDATE;`, [examId]);
    const exam = result.rows[0];
    if (!exam) throw new ExamAuthoringError("未找到试卷", 404);
    if (Number(exam.version) !== expectedVersion) {
      throw new ExamAuthoringError("试卷已被其他管理员修改，请刷新后重试", 409);
    }
    if (restore ? exam.status !== "archived" : exam.status === "archived") {
      throw new ExamAuthoringError(restore ? "试卷未处于已删除状态" : "试卷已删除", 409);
    }
    const questions = await loadSelection(client, examId, true);
    const before = snapshotExam(exam, questions);
    const targetStatus = restore ? "draft" : "archived";
    const updated = await client.query(`
      UPDATE exams
      SET status = $2, version = version + 1
      WHERE id = $1
      RETURNING id, title, status, duration_seconds, total_score, pass_score, pass_rate,
        version, answer_rules_json, question_bank_id;`, [examId, targetStatus]);
    const after = snapshotExam(updated.rows[0], questions);
    await insertExamAudit(client, actorUserId, restore ? "restore_exam" : "archive_exam", examId, before, after);
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

async function archiveExam(pool, examId, input, actorUserId) {
  return setExamArchiveStatus(pool, examId, input, actorUserId, false);
}

async function restoreExam(pool, examId, input, actorUserId) {
  return setExamArchiveStatus(pool, examId, input, actorUserId, true);
}

async function bindExamQuestionBank(pool, examId, input, actorUserId) {
  const bankId = String(input?.bankId || "").trim();
  if (!bankId) throw new ExamAuthoringError("请选择题库");
  return mutateExam(pool, examId, input, actorUserId, "bind_exam_question_bank", async (client, exam) => {
    const bank = await client.query(`
      SELECT id, name
      FROM question_banks
      WHERE id = $1 AND status = 'active'
      FOR SHARE;`, [bankId]);
    if (!bank.rows.length) throw new ExamAuthoringError("未找到可用题库");
    if (exam.question_bank_id !== bankId) {
      await client.query("DELETE FROM exam_questions WHERE exam_id = $1;", [examId]);
    }
    await client.query("UPDATE exams SET question_bank_id = $2 WHERE id = $1;", [examId, bankId]);
  });
}

async function setExamQuestions(pool, examId, input, actorUserId) {
  const selectAll = input?.selectAll === true;
  const requestedIds = selectAll ? null : normalizeQuestionIds(input?.questionIds);
  return mutateExam(pool, examId, input, actorUserId, "set_exam_questions", async (client, exam, selected) => {
    await assertActiveQuestionBank(client, exam.question_bank_id);
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
    await assertActiveQuestionBank(client, _exam.question_bank_id);
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
    await assertActiveQuestionBank(client, exam.question_bank_id);
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
    await assertActiveQuestionBank(client, _exam.question_bank_id);
    if (!selected.length) throw new ExamAuthoringError("当前试卷没有可修改分值的题目");
    assertSelectionBelongsToBank(selected, _exam.question_bank_id);
    await client.query("UPDATE exam_questions SET score = $2 WHERE exam_id = $1;", [examId, score]);
  });
}

module.exports = {
  ExamAuthoringError,
  archiveExam,
  bindExamQuestionBank,
  copyExam,
  createExam,
  getExamAuthoring,
  listAuthoringExams,
  mapAuthoringQuestion,
  mapExamSummary,
  normalizeQuestionIds,
  normalizeScore,
  publishExam,
  restoreExam,
  reopenExamRevision,
  reorderExamQuestions,
  setExamQuestions,
  updateAllExamQuestionScores,
  updateExamQuestionScore,
  updateExamSettings
};
