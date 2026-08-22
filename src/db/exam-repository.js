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

const { mapQuestionImages, mapQuestionOptions } = require("../resources/question-resources");
const { fillAnswerMatches } = require("../answer-rules");
const { lockUserIdentityMutation } = require("./user-repository");
const { enqueueSubmissionCreated } = require("./notification-repository");

function mapQuestion(row) {
  const options = mapQuestionOptions(row.options_json || []);
  return {
    id: row.question_id,
    sourceId: row.external_id || row.question_id,
    no: Number(row.position),
    type: row.type,
    stem: row.stem,
    options,
    images: {
      stem: mapQuestionImages(row.images_json || []),
      options: Object.fromEntries(options.filter((option) => option.image).map((option) => [option.label, option.image]))
    },
    score: Number(row.score),
    ...(Number(row.fill_slot_count || 0) > 0 ? { fillSlotCount: Number(row.fill_slot_count) } : {})
  };
}

function identityValues(identity) {
  if (identity && typeof identity === "object") {
    const provider = String(identity.provider || "dingtalk");
    return {
      provider,
      providerSubject: String(identity.providerSubject || identity.openId || identity.unionId || ""),
      unionId: String(identity.unionId || "")
    };
  }
  const value = String(identity || "");
  return { provider: "dingtalk", providerSubject: value, unionId: value };
}

function currentIdentityCte(providerParameter, subjectParameter, unionParameter) {
  return `
    current_identity AS (
      SELECT ui.user_id, ui.provider
      FROM user_identities ui
      JOIN users u ON u.id = ui.user_id
      WHERE u.status = 'active'
        AND (
          (ui.provider = ${providerParameter} AND ui.provider_subject = ${subjectParameter})
          OR (${providerParameter} = 'dingtalk'
            AND ui.provider IN ('dingtalk', 'legacy')
            AND ui.union_id = ${unionParameter})
        )
      ORDER BY (ui.provider = ${providerParameter} AND ui.provider_subject = ${subjectParameter}) DESC,
        (ui.provider = 'dingtalk') DESC, ui.created_at
      LIMIT 1
    )`;
}

function activeAssignmentFilter() {
  return `
      AND EXISTS (
        SELECT 1 FROM exam_assignments ea
        WHERE ea.exam_id = e.id
          AND (ea.starts_at IS NULL OR ea.starts_at <= CURRENT_TIMESTAMP)
          AND (ea.ends_at IS NULL OR ea.ends_at > CURRENT_TIMESTAMP)
          AND (
            (ea.subject_type = 'user' AND ea.subject_id = ci.user_id)
            OR (ea.subject_type = 'group' AND ea.subject_id = 'all-active-users')
            OR (ea.subject_type = 'group'
              AND ea.subject_id = 'all-active-dingtalk-users'
              AND ci.provider IN ('dingtalk', 'legacy'))
            OR (ea.subject_type = 'department'
              AND EXISTS (
                SELECT 1
                FROM user_departments assigned_department
                JOIN organization_departments assigned_org
                  ON assigned_org.id = assigned_department.department_id
                 AND assigned_org.status = 'active'
                WHERE assigned_department.user_id = ci.user_id
                  AND (assigned_department.department_id = ea.subject_id
                    OR assigned_org.name = ea.subject_id)
              ))
          )
      )`;
}

async function listPublishedExams(pool, identity) {
  const current = identityValues(identity);
  const result = await pool.query(`
    WITH ${currentIdentityCte("$1", "$2", "$3")}
    SELECT e.id, e.title, e.status, e.duration_seconds, e.total_score, e.pass_score, e.version
    FROM exams e
    CROSS JOIN current_identity ci
    WHERE e.status IN ('scheduled', 'published', 'paused')
      ${activeAssignmentFilter()}
    ORDER BY e.created_at, e.id;`, [current.provider, current.providerSubject, current.unionId]);
  return result.rows.map(mapExam);
}

async function getPublishedExam(pool, examId, identity) {
  const current = identityValues(identity);
  const result = await pool.query(`
    WITH ${currentIdentityCte("$2", "$3", "$4")}
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
      q.images_json,
      CASE WHEN q.type = 'fill' AND jsonb_typeof(to_jsonb(q) -> ('answer_' || 'json')) = 'object'
        THEN jsonb_array_length(COALESCE((to_jsonb(q) -> ('answer_' || 'json'))->'blanks', '[]'::jsonb)) ELSE 0 END AS fill_slot_count,
      eq.position,
      eq.score
    FROM exams e
    CROSS JOIN current_identity ci
    JOIN exam_questions eq ON eq.exam_id = e.id
    JOIN questions q ON q.id = eq.question_id
    WHERE e.id = $1
      AND e.status IN ('scheduled', 'published', 'paused')
      ${activeAssignmentFilter()}
    ORDER BY eq.position;`, [examId, current.provider, current.providerSubject, current.unionId]);

  if (!result.rows.length) return null;
  const exam = mapExam(result.rows[0]);
  const questions = result.rows.map(mapQuestion);
  return {
    ...exam,
    images: Object.fromEntries(questions.map((question) => [question.id, question.images])),
    questions
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
  return fillAnswerMatches(actual, expected);
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

async function createSubmission(pool, examId, identity, input = {}) {
  if (!input.answers || typeof input.answers !== "object" || Array.isArray(input.answers)) {
    throw new Error("answers 必须是对象");
  }
  const client = await pool.connect();
  const current = identityValues(identity);
  try {
    await client.query("BEGIN");
    await lockUserIdentityMutation(client);
    const examResult = await client.query(`
      WITH ${currentIdentityCte("$2", "$3", "$4")}
      SELECT e.id, e.title, e.version, e.pass_score, e.total_score,
        q.id AS question_id, q.external_id, q.type,
        COALESCE(NULLIF(q.stem, ''), (
          SELECT NULLIF(sq.snapshot_json->>'text', '')
          FROM submission_questions sq
          WHERE sq.question_id = q.id
          ORDER BY sq.created_at
          LIMIT 1
        ), '') AS stem,
        q.options_json, q.images_json, q.answer_json, q.explanation,
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
              OR (ea.subject_type = 'group' AND ea.subject_id = 'all-active-users')
              OR (ea.subject_type = 'group'
                AND ea.subject_id = 'all-active-dingtalk-users'
                AND ci.provider IN ('dingtalk', 'legacy'))
              OR (ea.subject_type = 'department'
                AND EXISTS (
                  SELECT 1
                  FROM user_departments assigned_department
                  JOIN organization_departments assigned_org
                    ON assigned_org.id = assigned_department.department_id
                   AND assigned_org.status = 'active'
                  WHERE assigned_department.user_id = ci.user_id
                    AND (assigned_department.department_id = ea.subject_id
                      OR assigned_org.name = ea.subject_id)
                ))
            )
        )
      ORDER BY eq.position;`, [examId, current.provider, current.providerSubject, current.unionId]);
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
    const lockedUser = await client.query(
      "SELECT id FROM users WHERE id = $1 AND status = 'active' FOR UPDATE;",
      [userId]
    );
    if (!lockedUser.rows.length) throw new Error("账号归属已更新，请刷新页面后重新提交");
    const attemptResult = await client.query(
      "SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no FROM submissions WHERE exam_id = $1 AND user_id = $2",
      [examId, userId]
    );
    const attemptNo = Number(attemptResult.rows[0].attempt_no);
    if (attemptNo > 2) {
      const retakeResult = await client.query(
        "SELECT remaining_count FROM retake_permissions WHERE exam_id = $1 AND user_id = $2 FOR UPDATE",
        [examId, userId]
      );
      const remaining = Number(retakeResult.rows[0]?.remaining_count || 0);
      if (remaining < 1) throw new Error("已完成可用考核次数，请联系管理员开放额外补考权限");
      await client.query(
        "UPDATE retake_permissions SET remaining_count = remaining_count - 1 WHERE exam_id = $1 AND user_id = $2",
        [examId, userId]
      );
    }
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
        images: row.images_json || [], answer: row.answer_json, explanation: row.explanation || "",
        score: Number(row.score), position: Number(row.position)
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
    await enqueueSubmissionCreated(client, {
      submissionId,
      examId,
      examTitle: first.title,
      studentName: identity?.name || "历史答卷用户",
      submittedAt
    });
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

function attemptInfo(completedAttempts, awaitingGrade, remainingExtraAttempts) {
  const attemptNo = Number(completedAttempts) + 1;
  const remaining = Math.max(0, Number(remainingExtraAttempts));
  const available = !awaitingGrade && (attemptNo <= 2 || remaining > 0);
  let message = "本次为第1次考核，仅有一次补考机会。";
  if (awaitingGrade) message = "上一份答卷正在阅卷，阅卷完成后才能参加补考。";
  else if (attemptNo === 2) message = "本次为补考。";
  else if (attemptNo > 2 && available) message = `本次为第${attemptNo - 2}次额外补考。`;
  else if (attemptNo > 2) message = "已完成可用考核次数，请联系管理员开放额外补考权限。";
  return {
    attemptNo,
    completedAttempts: Number(completedAttempts),
    available,
    awaitingGrade: Boolean(awaitingGrade),
    remainingExtraAttempts: remaining,
    message
  };
}

async function listStudentSubmissions(pool, identity) {
  const current = identityValues(identity);
  const result = await pool.query(`
    WITH ${currentIdentityCte("$1", "$2", "$3")}
    SELECT s.id, s.exam_id, e.title AS exam_title, s.submitted_at, s.status,
      s.objective_score, s.qa_score, s.total_score, s.pass, s.pass_score,
      s.attempt_no, s.graded_at, s.grader_name
    FROM submissions s
    JOIN exams e ON e.id = s.exam_id
    CROSS JOIN current_identity ci
    WHERE s.user_id = ci.user_id
    ORDER BY s.submitted_at DESC, s.id DESC;`, [current.provider, current.providerSubject, current.unionId]);
  return result.rows.map(mapStudentSubmission);
}

async function getStudentDashboard(pool, identity) {
  const current = identityValues(identity);
  const examResult = await pool.query(`
    WITH ${currentIdentityCte("$1", "$2", "$3")}
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
            OR (ea.subject_type = 'group' AND ea.subject_id = 'all-active-users')
            OR (ea.subject_type = 'group'
              AND ea.subject_id = 'all-active-dingtalk-users'
              AND ci.provider IN ('dingtalk', 'legacy'))
            OR (ea.subject_type = 'department'
              AND EXISTS (
                SELECT 1
                FROM user_departments assigned_department
                JOIN organization_departments assigned_org
                  ON assigned_org.id = assigned_department.department_id
                 AND assigned_org.status = 'active'
                WHERE assigned_department.user_id = ci.user_id
                  AND (assigned_department.department_id = ea.subject_id
                    OR assigned_org.name = ea.subject_id)
              ))
          )
      )
    GROUP BY e.id, e.title, e.duration_seconds, e.total_score, e.pass_score, e.version, rp.remaining_count
    ORDER BY e.created_at, e.id;`, [current.provider, current.providerSubject, current.unionId]);

  const exams = examResult.rows.map((row) => {
    const completedAttempts = Number(row.completed_attempts);
    const awaitingGrade = Boolean(row.awaiting_grade);
    const remainingExtraAttempts = Number(row.remaining_extra_attempts);
    const attempt = attemptInfo(completedAttempts, awaitingGrade, remainingExtraAttempts);
    return {
      id: row.id,
      title: row.title,
      duration: Number(row.duration_seconds) / 60,
      totalScore: Number(row.total_score),
      passScore: Number(row.pass_score),
      version: Number(row.version),
      studyStatus: "考核已开放",
      attempt
    };
  });
  return { exams, submissions: await listStudentSubmissions(pool, current) };
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
    images: {
      stem: mapQuestionImages(snapshot.images || row.current_images || []),
      options: Object.fromEntries(mapQuestionOptions(snapshot.options || row.current_options || [])
        .filter((option) => option.image).map((option) => [option.label, option.image]))
    },
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

async function getStudentSubmission(pool, submissionId, identity) {
  const current = identityValues(identity);
  const submissionResult = await pool.query(`
    WITH ${currentIdentityCte("$2", "$3", "$4")}
    SELECT s.id, s.exam_id, e.title AS exam_title, s.submitted_at, s.status,
      s.objective_score, s.qa_score, s.total_score, s.pass, s.pass_score,
      s.attempt_no, s.graded_at, s.grader_name
    FROM submissions s
    JOIN exams e ON e.id = s.exam_id
    CROSS JOIN current_identity ci
    WHERE s.id = $1 AND s.user_id = ci.user_id;`, [
    submissionId, current.provider, current.providerSubject, current.unionId
  ]);
  if (!submissionResult.rows.length) return null;
  const submission = mapStudentSubmission(submissionResult.rows[0]);
  const questionsResult = await pool.query(`
    SELECT sq.question_id, sq.position, sq.snapshot_json, sq.answer_json, sq.earned_score,
      sq.automatic_score, sq.manually_adjusted, q.external_id,
      q.type AS current_type, q.stem AS current_stem, q.options_json AS current_options,
      q.images_json AS current_images,
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
  attemptInfo,
  createSubmission,
  getStudentDashboard,
  getPublishedExam,
  getStudentSubmission,
  gradePublishedQuestions,
  identityValues,
  listPublishedExams,
  listStudentSubmissions,
  mapExam,
  mapQuestion,
  mapStudentSubmission
};
const crypto = require("node:crypto");
