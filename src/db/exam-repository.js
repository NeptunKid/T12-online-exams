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
    no: Number(row.position),
    type: row.type,
    stem: row.stem,
    options: mapQuestionOptions(row.options_json || []),
    score: Number(row.score)
  };
}

const ASSIGNMENT_FILTER = `
      AND EXISTS (
        SELECT 1
        FROM exam_assignments ea
        JOIN user_identities ui ON ui.user_id = ea.subject_id
        WHERE ea.exam_id = e.id
          AND ea.subject_type = 'user'
          AND ui.union_id = $1
          AND ui.provider IN ('dingtalk', 'legacy')
          AND (ea.starts_at IS NULL OR ea.starts_at <= CURRENT_TIMESTAMP)
          AND (ea.ends_at IS NULL OR ea.ends_at > CURRENT_TIMESTAMP)
      )`;

async function listPublishedExams(pool, unionId) {
  const result = await pool.query(`
    SELECT e.id, e.title, e.status, e.duration_seconds, e.total_score, e.pass_score, e.version
    FROM exams e
    WHERE e.status IN ('scheduled', 'published', 'paused')
      ${ASSIGNMENT_FILTER}
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
      q.type,
      q.stem,
      q.options_json,
      eq.position,
      eq.score
    FROM exams e
    JOIN exam_questions eq ON eq.exam_id = e.id
    JOIN questions q ON q.id = eq.question_id
    WHERE e.id = $1
      AND e.status IN ('scheduled', 'published', 'paused')
      ${ASSIGNMENT_FILTER.replace('$1', '$2')}
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
      SELECT e.id, e.title, e.version, e.pass_score, e.total_score,
        q.id AS question_id, q.type, q.stem, q.options_json, q.answer_json, q.explanation,
        eq.position, eq.score, ui.user_id
      FROM exams e
      JOIN exam_questions eq ON eq.exam_id = e.id
      JOIN questions q ON q.id = eq.question_id
      JOIN exam_assignments ea ON ea.exam_id = e.id AND ea.subject_type = 'user'
      JOIN user_identities ui ON ui.user_id = ea.subject_id
        AND ui.union_id = $2 AND ui.provider IN ('dingtalk', 'legacy')
      WHERE e.id = $1
        AND e.status IN ('scheduled', 'published', 'paused')
        AND (ea.starts_at IS NULL OR ea.starts_at <= CURRENT_TIMESTAMP)
        AND (ea.ends_at IS NULL OR ea.ends_at > CURRENT_TIMESTAMP)
      ORDER BY eq.position, (ui.provider = 'dingtalk') DESC;`, [examId, unionId]);
    if (!examResult.rows.length) {
      await client.query("ROLLBACK");
      return null;
    }

    const first = examResult.rows[0];
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
    const hasQa = grading.qaMaxScore > 0;
    const status = hasQa ? "pending" : "graded";
    const totalScore = hasQa ? null : grading.objectiveScore;
    const pass = hasQa ? null : grading.objectiveScore >= Number(first.pass_score);
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
        id: row.question_id, type: row.type, stem: row.stem, options: mapQuestionOptions(row.options_json || []),
        explanation: row.explanation || "", score: Number(row.score), position: Number(row.position)
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
      WHERE ui.union_id = $1
        AND ui.provider IN ('dingtalk', 'legacy')
      ORDER BY (ui.provider = 'dingtalk') DESC, ui.created_at
      LIMIT 1
    )
    SELECT e.id, e.title, e.duration_seconds, e.total_score, e.pass_score, e.version,
      COUNT(s.id)::integer AS completed_attempts,
      COALESCE(bool_or(s.status = 'pending'), false) AS awaiting_grade,
      COALESCE(rp.remaining_count, 0)::integer AS remaining_extra_attempts
    FROM exams e
    JOIN exam_assignments ea ON ea.exam_id = e.id AND ea.subject_type = 'user'
    JOIN current_identity ci ON ci.user_id = ea.subject_id
    LEFT JOIN submissions s ON s.exam_id = e.id AND s.user_id = ci.user_id
    LEFT JOIN retake_permissions rp ON rp.exam_id = e.id AND rp.user_id = ci.user_id
    WHERE e.status IN ('scheduled', 'published', 'paused')
      AND (ea.starts_at IS NULL OR ea.starts_at <= CURRENT_TIMESTAMP)
      AND (ea.ends_at IS NULL OR ea.ends_at > CURRENT_TIMESTAMP)
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
      studyStatus: "学习资料待配置",
      attempt: { attemptNo, completedAttempts, available, awaitingGrade, remainingExtraAttempts, message }
    };
  });
  return { exams, submissions: await listStudentSubmissions(pool, unionId) };
}

function mapStudentQuestion(row, graded) {
  const snapshot = row.snapshot_json || {};
  return {
    id: row.question_id || snapshot.id || null,
    no: Number(row.position),
    type: snapshot.type || "",
    stem: snapshot.stem || "",
    options: mapQuestionOptions(snapshot.options || []),
    score: Number(snapshot.score || 0),
    submittedAnswer: row.answer_json,
    ...(graded ? { earnedScore: Number(row.earned_score), automaticScore: row.automatic_score === null ? null : Number(row.automatic_score), manuallyAdjusted: Boolean(row.manually_adjusted) } : {})
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
    SELECT question_id, position, snapshot_json, answer_json, earned_score,
      automatic_score, manually_adjusted
    FROM submission_questions
    WHERE submission_id = $1
    ORDER BY position;`, [submissionId]);
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
