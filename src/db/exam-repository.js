function mapExam(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    duration: Number(row.duration_seconds),
    totalScore: Number(row.total_score),
    passScore: Number(row.pass_score),
    version: Number(row.version)
  };
}

const { mapQuestionOptions } = require("../resources/question-resources");

function mapQuestion(row) {
  return {
    id: row.question_id,
    sourceId: row.external_id || row.question_id,
    no: Number(row.position),
    type: row.type,
    stem: row.stem,
    options: mapQuestionOptions(row.options_json || []),
    score: Number(row.score)
  };
}

function assignmentFilter(identityParameter) {
  return `
      AND EXISTS (
        SELECT 1
        FROM exam_assignments ea
        WHERE ea.exam_id = e.id
          AND (ea.starts_at IS NULL OR ea.starts_at <= CURRENT_TIMESTAMP)
          AND (ea.ends_at IS NULL OR ea.ends_at > CURRENT_TIMESTAMP)
          AND (
            (ea.subject_type = 'user' AND EXISTS (
              SELECT 1
              FROM user_identities ui
              JOIN users u ON u.id = ui.user_id
              WHERE ui.user_id = ea.subject_id
                AND ui.union_id = ${identityParameter}
                AND ui.provider IN ('dingtalk', 'legacy')
                AND u.status = 'active'
            ))
            OR
            (ea.subject_type = 'group'
              AND ea.subject_id = 'all-active-dingtalk-users'
              AND EXISTS (
                SELECT 1
                FROM user_identities ui
                JOIN users u ON u.id = ui.user_id
                WHERE ui.union_id = ${identityParameter}
                  AND ui.provider IN ('dingtalk', 'legacy')
                  AND u.status = 'active'
              ))
          )
      )`;
}

async function listPublishedExams(pool, unionId) {
  const result = await pool.query(`
    SELECT e.id, e.title, e.status, e.duration_seconds, e.total_score, e.pass_score, e.version
    FROM exams e
    WHERE e.status IN ('scheduled', 'published', 'paused')
      ${assignmentFilter("$1")}
    ORDER BY e.created_at, e.id;`, [unionId]);
  return result.rows.map(mapExam);
}

async function getPublishedExam(pool, examId, unionId) {
  const result = await pool.query(`
    SELECT
      e.id,
      e.title,
      e.status,
      e.duration_seconds,
      e.total_score,
      e.pass_score,
      e.version,
      q.id AS question_id,
      q.external_id,
      q.type,
      COALESCE(NULLIF(q.stem, ''), (
        SELECT NULLIF(sq.snapshot_json->>'text', '')
        FROM submission_questions sq
        WHERE sq.question_id = q.id
        ORDER BY sq.created_at
        LIMIT 1
      ), '') AS stem,
      q.options_json,
      eq.position,
      eq.score
    FROM exams e
    JOIN exam_questions eq ON eq.exam_id = e.id
    JOIN questions q ON q.id = eq.question_id
    WHERE e.id = $1
      AND e.status IN ('scheduled', 'published', 'paused')
      ${assignmentFilter("$2")}
    ORDER BY eq.position;`, [examId, unionId]);

  if (!result.rows.length) return null;
  const exam = mapExam(result.rows[0]);
  return {
    ...exam,
    images: {},
    questions: result.rows.map(mapQuestion)
  };
}

function sameAnswer(actual, expected) {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
    return actual.length === expected.length && [...actual].sort().every((item, index) => item === [...expected].sort()[index]);
  }
  return actual === expected;
}

function matchesFillAnswer(actual, expected) {
  const normalizedActual = String(actual ?? "").trim().toLocaleLowerCase();
  if (!normalizedActual) return false;
  const accepted = Array.isArray(expected) ? expected : [expected];
  return accepted.some((item) => normalizedActual === String(item ?? "").trim().toLocaleLowerCase());
}

function gradePublishedQuestions(rows, answers) {
  const objectiveDetail = {};
  let objectiveScore = 0;
  let qaMaxScore = 0;
  for (const row of rows) {
    const answer = answers[row.question_id] ?? (row.type === "multi" ? [] : "");
    const score = Number(row.score);
    if (row.type === "qa") {
      qaMaxScore += score;
      continue;
    }
    const expected = row.answer_json;
    const exact = row.type === "fill" ? matchesFillAnswer(answer, expected) : sameAnswer(answer, expected);
    const partial = row.type === "multi" && Array.isArray(answer) && Array.isArray(expected)
      && answer.length > 0 && answer.every((item) => expected.includes(item));
    const earned = exact ? score : partial ? score / 2 : 0;
    objectiveScore += earned;
    objectiveDetail[row.question_id] = { earned, automaticEarned: earned, manuallyAdjusted: false };
  }
  return { objectiveScore, objectiveDetail, qaMaxScore };
}

async function createSubmission(pool, examId, unionId, input = {}) {
  if (!input.answers || typeof input.answers !== "object" || Array.isArray(input.answers)) {
    throw new Error("answers 必须是对象");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const examResult = await client.query(`
      WITH current_identity AS (
        SELECT ui.user_id
        FROM user_identities ui
        JOIN users u ON u.id = ui.user_id
        WHERE ui.union_id = $2
          AND ui.provider IN ('dingtalk', 'legacy')
          AND u.status = 'active'
        ORDER BY (ui.provider = 'dingtalk') DESC, ui.created_at
        LIMIT 1
      )
      SELECT e.id, e.title, e.version, e.pass_score, e.total_score,
        q.id AS question_id, q.external_id, q.type,
        COALESCE(NULLIF(q.stem, ''), (
          SELECT NULLIF(sq.snapshot_json->>'text', '')
          FROM submission_questions sq
          WHERE sq.question_id = q.id
          ORDER BY sq.created_at
          LIMIT 1
        ), '') AS stem,
        q.options_json, q.answer_json, q.explanation,
        eq.position, eq.score, ci.user_id
      FROM exams e
      CROSS JOIN current_identity ci
      JOIN exam_questions eq ON eq.exam_id = e.id
      JOIN questions q ON q.id = eq.question_id
      WHERE e.id = $1
        AND e.status IN ('scheduled', 'published', 'paused')
        AND EXISTS (
          SELECT 1
          FROM exam_assignments ea
          WHERE ea.exam_id = e.id
            AND (ea.starts_at IS NULL OR ea.starts_at <= CURRENT_TIMESTAMP)
            AND (ea.ends_at IS NULL OR ea.ends_at > CURRENT_TIMESTAMP)
            AND (
              (ea.subject_type = 'user' AND ea.subject_id = ci.user_id)
              OR (ea.subject_type = 'group' AND ea.subject_id = 'all-active-dingtalk-users')
            )
        )
      ORDER BY eq.position;`, [examId, unionId]);
    if (!examResult.rows.length) {
      await client.query("ROLLBACK");
      return null;
    }

    const first = examResult.rows[0];
    if (!Number.isInteger(Number(input.examVersion)) || Number(input.examVersion) !== Number(first.version)) {
      throw new Error("考试内容已更新，请刷新页面后重新开始考试");
    }
    const userId = first.user_id;
    const rows = [];
    const seen = new Set();
    for (const row of examResult.rows) {
      if (!seen.has(row.question_id)) {
        seen.add(row.question_id);
        rows.push(row);
      }
    }
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    const attemptResult = await client.query(
      "SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no FROM submissions WHERE exam_id = $1 AND user_id = $2",
      [examId, userId]
    );
    const attemptNo = Number(attemptResult.rows[0].attempt_no);
    const grading = gradePublishedQuestions(rows, input.answers);
    const status = "pending";
    const totalScore = null;
    const pass = null;
    const submittedAt = input.submittedAt || new Date().toISOString();
    const submissionId = input.submissionId || `postgres-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const scores = { objectiveDetail: grading.objectiveDetail, qaMaxScore: grading.qaMaxScore, qaScores: {} };
    await client.query(`
      INSERT INTO submissions (
        id, exam_id, exam_version, user_id, attempt_no, status, started_at, submitted_at,
        duration_seconds, objective_score, qa_score, total_score, pass_score, pass, scores_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12, $13, $14::jsonb);`, [
      submissionId, examId, first.version, userId, attemptNo, status, input.startedAt || null,
      submittedAt, Math.max(0, Math.trunc(Number(input.durationSeconds || 0))), grading.objectiveScore,
      totalScore, first.pass_score, pass, JSON.stringify(scores)
    ]);
    for (const row of rows) {
      const answer = input.answers[row.question_id] ?? (row.type === "multi" ? [] : "");
      const snapshot = {
        id: row.question_id, sourceId: row.external_id || row.question_id,
        type: row.type, stem: row.stem, options: mapQuestionOptions(row.options_json || []),
        answer: row.answer_json, explanation: row.explanation || "", score: Number(row.score), position: Number(row.position)
      };
      const detail = grading.objectiveDetail[row.question_id];
      await client.query(`
        INSERT INTO submission_questions
          (submission_id, question_id, position, snapshot_json, answer_json, earned_score, automatic_score)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7);`, [
        submissionId, row.question_id, row.position, JSON.stringify(snapshot), JSON.stringify(answer),
        detail?.earned || 0, detail ? detail.automaticEarned : null
      ]);
    }
    await client.query("COMMIT");
    return { id: submissionId, status, objectiveScore: grading.objectiveScore, attemptNo };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function mapStudentSubmission(row) {
  return {
    id: row.id,
    examId: row.exam_id,
    examTitle: row.exam_title,
    submittedAt: row.submitted_at,
    status: row.status,
    objectiveScore: Number(row.objective_score),
    qaScore: Number(row.qa_score),
    totalScore: row.total_score === null ? null : Number(row.total_score),
    pass: row.pass,
    passScore: Number(row.pass_score),
    attemptNo: Number(row.attempt_no),
    gradedAt: row.graded_at,
    graderName: row.grader_name || ""
  };
}

const STUDENT_IDENTITY_FILTER = `
      EXISTS (
        SELECT 1 FROM user_identities ui
        WHERE ui.user_id = s.user_id
          AND ui.union_id = $1
          AND ui.provider IN ('dingtalk', 'legacy')
      )`;

async function listStudentSubmissions(pool, unionId) {
  const result = await pool.query(`
    SELECT s.id, s.exam_id, e.title AS exam_title, s.submitted_at, s.status,
      s.objective_score, s.qa_score, s.total_score, s.pass, s.pass_score,
      s.attempt_no, s.graded_at, s.grader_name
    FROM submissions s
    JOIN exams e ON e.id = s.exam_id
    WHERE ${STUDENT_IDENTITY_FILTER}
    ORDER BY s.submitted_at DESC, s.id DESC;`, [unionId]);
  return result.rows.map(mapStudentSubmission);
}

async function getStudentDashboard(pool, unionId) {
  const examResult = await pool.query(`
    WITH current_identity AS (
      SELECT ui.user_id
      FROM user_identities ui
      JOIN users u ON u.id = ui.user_id
      WHERE ui.union_id = $1
        AND ui.provider IN ('dingtalk', 'legacy')
        AND u.status = 'active'
      ORDER BY (ui.provider = 'dingtalk') DESC, ui.created_at
      LIMIT 1
    )
    SELECT e.id, e.title, e.duration_seconds, e.total_score, e.pass_score, e.version,
      COUNT(s.id)::integer AS completed_attempts,
      COALESCE(bool_or(s.status = 'pending'), false) AS awaiting_grade,
      COALESCE(rp.remaining_count, 0)::integer AS remaining_extra_attempts
    FROM exams e
    CROSS JOIN current_identity ci
    LEFT JOIN submissions s ON s.exam_id = e.id AND s.user_id = ci.user_id
    LEFT JOIN retake_permissions rp ON rp.exam_id = e.id AND rp.user_id = ci.user_id
    WHERE e.status IN ('scheduled', 'published', 'paused')
      AND EXISTS (
        SELECT 1
        FROM exam_assignments ea
        WHERE ea.exam_id = e.id
          AND (ea.starts_at IS NULL OR ea.starts_at <= CURRENT_TIMESTAMP)
          AND (ea.ends_at IS NULL OR ea.ends_at > CURRENT_TIMESTAMP)
          AND (
            (ea.subject_type = 'user' AND ea.subject_id = ci.user_id)
            OR (ea.subject_type = 'group' AND ea.subject_id = 'all-active-dingtalk-users')
          )
      )
    GROUP BY e.id, e.title, e.duration_seconds, e.total_score, e.pass_score, e.version, rp.remaining_count
    ORDER BY e.created_at, e.id;`, [unionId]);

  const exams = examResult.rows.map((row) => {
    const completedAttempts = Number(row.completed_attempts);
    const awaitingGrade = Boolean(row.awaiting_grade);
    const remainingExtraAttempts = Number(row.remaining_extra_attempts);
    const attemptNo = completedAttempts + 1;
    const available = !awaitingGrade && (attemptNo <= 2 || remainingExtraAttempts > 0);
    let message = "本次为首次考核。";
    if (awaitingGrade) message = "上一份答卷正在阅卷，阅卷完成后才能参加补考。";
    else if (attemptNo === 2) message = "本次为一次免费补考。";
    else if (available) message = `管理员已额外开放补考，本次为第 ${attemptNo} 次考核。`;
    else message = "已完成可用考核次数，请联系管理员开放额外补考权限。";
    return {
      id: row.id,
      title: row.title,
      duration: Number(row.duration_seconds) / 60,
      totalScore: Number(row.total_score),
      passScore: Number(row.pass_score),
      version: Number(row.version),
      studyStatus: "考核已开放",
      attempt: { attemptNo, completedAttempts, available, awaitingGrade, remainingExtraAttempts, message }
    };
  });
  return { exams, submissions: await listStudentSubmissions(pool, unionId) };
}

function mapStudentQuestion(row, graded) {
  const snapshot = row.snapshot_json || {};
  const answer = Object.hasOwn(snapshot, "answer") ? snapshot.answer : row.current_answer;
  const explanation = Object.hasOwn(snapshot, "explanation") ? snapshot.explanation : row.current_explanation;
  return {
    id: row.question_id || snapshot.id || null,
    sourceId: snapshot.sourceId || snapshot.legacySourceKey || row.external_id || snapshot.id || row.question_id || null,
    no: Number(row.position),
    type: snapshot.type || row.current_type || "",
    stem: snapshot.stem || snapshot.text || row.current_stem || "",
    options: mapQuestionOptions(snapshot.options || row.current_options || []),
    score: Number(snapshot.score ?? row.current_score ?? 0),
    submittedAnswer: row.answer_json,
    ...(graded ? {
      correctAnswer: answer,
      explanation: explanation || "",
      earnedScore: Number(row.earned_score),
      automaticScore: row.automatic_score === null ? null : Number(row.automatic_score),
      manuallyAdjusted: Boolean(row.manually_adjusted)
    } : {})
  };
}

async function getStudentSubmission(pool, submissionId, unionId) {
  const submissionResult = await pool.query(`
    SELECT s.id, s.exam_id, e.title AS exam_title, s.submitted_at, s.status,
      s.objective_score, s.qa_score, s.total_score, s.pass, s.pass_score,
      s.attempt_no, s.graded_at, s.grader_name
    FROM submissions s
    JOIN exams e ON e.id = s.exam_id
    WHERE s.id = $1 AND ${STUDENT_IDENTITY_FILTER.replace('$1', '$2')};`, [submissionId, unionId]);
  if (!submissionResult.rows.length) return null;
  const submission = mapStudentSubmission(submissionResult.rows[0]);
  const questionsResult = await pool.query(`
    SELECT sq.question_id, sq.position, sq.snapshot_json, sq.answer_json, sq.earned_score,
      sq.automatic_score, sq.manually_adjusted, q.external_id,
      q.type AS current_type, q.stem AS current_stem, q.options_json AS current_options,
      q.answer_json AS current_answer, q.explanation AS current_explanation,
      eq.score AS current_score
    FROM submission_questions sq
    LEFT JOIN questions q ON q.id = sq.question_id
    LEFT JOIN exam_questions eq ON eq.exam_id = $2 AND eq.question_id = sq.question_id
    WHERE sq.submission_id = $1
    ORDER BY sq.position;`, [submissionId, submission.examId]);
  return {
    submission,
    questions: questionsResult.rows.map((row) => mapStudentQuestion(row, submission.status === "graded"))
  };
}

module.exports = {
  createSubmission,
  getStudentDashboard,
  getPublishedExam,
  getStudentSubmission,
  gradePublishedQuestions,
  listPublishedExams,
  listStudentSubmissions,
  mapExam,
  mapQuestion,
  mapStudentSubmission
};
const crypto = require("node:crypto");
