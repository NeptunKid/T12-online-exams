const crypto = require("node:crypto");
const { mapQuestionImages, mapQuestionOptions } = require("../resources/question-resources");
const { fillAnswerMatches } = require("../answer-rules");
const { lockUserIdentityMutation } = require("./user-repository");

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function mapAdminListItem(row) {
  return {
    id: row.id,
    examId: row.exam_id,
    examTitle: row.exam_title,
    studentName: row.student_name || "历史答卷用户",
    studentNo: row.employee_no || "",
    department: row.department || "",
    submittedAt: row.submitted_at,
    status: row.status,
    objectiveScore: asNumber(row.objective_score),
    qaScore: asNumber(row.qa_score),
    totalScore: row.total_score === null ? null : asNumber(row.total_score),
    pass: row.pass,
    passScore: asNumber(row.pass_score),
    attemptNo: asNumber(row.attempt_no, 1),
    gradedAt: row.graded_at,
    graderName: row.grader_name || ""
  };
}

function normalizeQuestionOptions(rawOptions) {
  const options = {};
  const optionImages = {};
  for (const option of mapQuestionOptions(rawOptions || [])) {
    options[option.label] = option.text || "";
    if (option.image) optionImages[option.label] = option.image;
  }
  return { options, optionImages };
}

function comparableQuestion(question) {
  return {
    type: question.type || "",
    text: question.text || "",
    options: question.options || {},
    images: question.images || { stem: [], options: {} },
    answer: question.answer ?? null,
    explanation: question.explanation || "",
    score: asNumber(question.score)
  };
}

function changedQuestionFields(snapshot, current) {
  const labels = {
    text: "题干",
    options: "选项",
    images: "图片",
    answer: "标准答案",
    explanation: "解析",
    score: "分值",
    type: "题型"
  };
  return Object.keys(labels).filter((key) => JSON.stringify(snapshot[key]) !== JSON.stringify(current[key]))
    .map((key) => labels[key]);
}

function mapAdminQuestion(row) {
  const snapshot = row.snapshot_json || {};
  const sourceId = snapshot.sourceId || snapshot.legacySourceKey || row.external_id || snapshot.id || row.question_id;
  const rawOptions = snapshot.options ?? row.current_options ?? [];
  const { options, optionImages } = normalizeQuestionOptions(rawOptions);
  const question = {
    id: row.question_id || snapshot.id,
    sourceId: String(sourceId ?? ""),
    no: asNumber(row.position),
    type: snapshot.type || row.current_type || "",
    text: snapshot.stem || snapshot.text || row.current_stem || "",
    options,
    answer: Object.hasOwn(snapshot, "answer") ? snapshot.answer : row.current_answer,
    explanation: Object.hasOwn(snapshot, "explanation") ? snapshot.explanation : (row.current_explanation || ""),
    score: asNumber(snapshot.score ?? row.current_score),
    images: {
      stem: mapQuestionImages(snapshot.images || row.current_images || []),
      options: optionImages
    },
    submittedAnswer: row.answer_json,
    earnedScore: asNumber(row.earned_score),
    automaticScore: row.automatic_score === null ? null : asNumber(row.automatic_score),
    manuallyAdjusted: Boolean(row.manually_adjusted)
  };
  const hasCurrentQuestion = Boolean(row.current_question_id || row.current_type);
  const currentActive = hasCurrentQuestion && row.current_status !== "archived";
  if (!currentActive) {
    return { ...question, referenceStatus: hasCurrentQuestion ? "deleted" : "unavailable", changedFields: [] };
  }
  const currentOptionData = normalizeQuestionOptions(row.current_options || []);
  const current = {
    type: row.current_type || "",
    text: row.current_stem || "",
    options: currentOptionData.options,
    images: {
      stem: mapQuestionImages(row.current_images || []),
      options: currentOptionData.optionImages
    },
    answer: row.current_answer,
    explanation: row.current_explanation || "",
    score: asNumber(row.current_score),
    version: asNumber(row.current_version, 1)
  };
  const changedFields = changedQuestionFields(comparableQuestion(question), comparableQuestion(current));
  return { ...question, current, referenceStatus: changedFields.length ? "modified" : "unchanged", changedFields };
}

async function listAdminSubmissions(pool) {
  const result = await pool.query(`
    SELECT s.id, s.exam_id, e.title AS exam_title,
      COALESCE(u.name, s.legacy_student_name, '历史答卷用户') AS student_name,
      u.employee_no, u.department, s.submitted_at, s.status,
      s.objective_score, s.qa_score, s.total_score, s.pass, s.pass_score,
      s.attempt_no, s.graded_at, s.grader_name
    FROM submissions s
    JOIN exams e ON e.id = s.exam_id
    LEFT JOIN users u ON u.id = s.user_id
    ORDER BY s.submitted_at DESC, s.id DESC;`);
  const submissions = result.rows.map(mapAdminListItem);
  return {
    submissions,
    stats: {
      total: submissions.length,
      pending: submissions.filter((item) => item.status === "pending").length,
      graded: submissions.filter((item) => item.status === "graded").length
    }
  };
}

async function loadAdminQuestions(queryable, submissionId, examId, lock = false) {
  const result = await queryable.query(`
    SELECT sq.question_id, sq.position, sq.snapshot_json, sq.answer_json,
      sq.earned_score, sq.automatic_score, sq.manually_adjusted,
      q.id AS current_question_id, q.external_id, q.status AS current_status, q.version AS current_version,
      q.type AS current_type, q.stem AS current_stem,
      q.options_json AS current_options, q.images_json AS current_images,
      q.answer_json AS current_answer,
      q.explanation AS current_explanation, eq.score AS current_score
    FROM submission_questions sq
    LEFT JOIN questions q ON q.id = sq.question_id
    LEFT JOIN exam_questions eq ON eq.exam_id = $2 AND eq.question_id = sq.question_id
    WHERE sq.submission_id = $1
    ORDER BY sq.position
    ${lock ? "FOR UPDATE OF sq" : ""};`, [submissionId, examId]);
  return result.rows.map(mapAdminQuestion);
}

async function getAdminSubmission(pool, submissionId) {
  const result = await pool.query(`
    SELECT s.*, e.title AS exam_title, e.total_score AS exam_total_score,
      e.pass_score AS exam_pass_score, e.version AS exam_version,
      COALESCE(u.name, s.legacy_student_name, '历史答卷用户') AS student_name,
      u.employee_no, u.department,
      COALESCE(di.union_id, s.legacy_dingtalk_union_id) AS dingtalk_union_id
    FROM submissions s
    JOIN exams e ON e.id = s.exam_id
    LEFT JOIN users u ON u.id = s.user_id
    LEFT JOIN LATERAL (
      SELECT ui.union_id
      FROM user_identities ui
      WHERE ui.user_id = s.user_id AND ui.union_id IS NOT NULL
      ORDER BY (ui.provider = 'dingtalk') DESC, ui.created_at
      LIMIT 1
    ) di ON true
    WHERE s.id = $1;`, [submissionId]);
  if (!result.rows.length) return null;
  const row = result.rows[0];
  const questions = await loadAdminQuestions(pool, submissionId, row.exam_id);
  const answers = {};
  const objectiveDetail = {};
  const qaScores = {};
  const storedDetail = row.scores_json?.objectiveDetail || {};
  const reviewReferences = row.scores_json?.reviewReferences || {};
  for (const question of questions) {
    question.reviewSource = reviewReferences[question.id]?.source || "snapshot";
    answers[question.id] = question.submittedAnswer;
    if (question.type === "qa") {
      qaScores[question.id] = question.earnedScore;
    } else {
      const prior = storedDetail[question.id] || storedDetail[question.sourceId] || {};
      const automatic = question.automaticScore ?? question.earnedScore;
      objectiveDetail[question.id] = {
        ...prior,
        answer: question.submittedAnswer,
        correctAnswer: question.answer,
        earned: question.earnedScore,
        automaticEarned: automatic,
        manuallyAdjusted: question.manuallyAdjusted,
        correct: prior.correct ?? automatic === question.score
      };
    }
  }
  const images = Object.fromEntries(questions.map((question) => [question.id, question.images]));
  const retakeResult = row.user_id
    ? await pool.query("SELECT remaining_count FROM retake_permissions WHERE exam_id = $1 AND user_id = $2", [row.exam_id, row.user_id])
    : { rows: [] };
  return {
    submission: {
      ...mapAdminListItem(row),
      durationSeconds: asNumber(row.duration_seconds),
      dingtalkUnionId: row.dingtalk_union_id || "",
      answers,
      objectiveDetail,
      qaScores,
      graderComment: row.grader_comment || ""
    },
    exam: {
      id: row.exam_id,
      title: row.exam_title,
      version: asNumber(row.exam_version, 1),
      totalScore: asNumber(row.exam_total_score),
      passScore: asNumber(row.exam_pass_score),
      images,
      questions
    },
    retake: row.user_id ? { remainingExtraAttempts: asNumber(retakeResult.rows[0]?.remaining_count) } : null
  };
}

function scoreInput(value, maxScore, label, required) {
  if (value === "" || value === undefined || value === null) {
    if (required) throw new Error(`请填写${label}的分数`);
    return null;
  }
  const score = Number(value);
  if (!Number.isFinite(score)) throw new Error(`${label}的分数必须是数字`);
  return Math.max(0, Math.min(maxScore, score));
}

function sameAnswer(actual, expected) {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
    return actual.length === expected.length && [...actual].sort().every((item, index) => item === [...expected].sort()[index]);
  }
  return actual === expected;
}

function automaticScore(question) {
  if (question.type === "qa") return null;
  const answer = question.submittedAnswer ?? (question.type === "multi" ? [] : "");
  const expected = question.answer;
  if (question.type === "fill") {
    return fillAnswerMatches(answer, expected) ? question.score : 0;
  }
  if (sameAnswer(answer, expected)) return question.score;
  if (question.type === "multi" && Array.isArray(answer) && Array.isArray(expected)
    && answer.length > 0 && answer.every((item) => expected.includes(item))) return question.score / 2;
  return 0;
}

async function gradeAdminSubmission(pool, submissionId, input, grader) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockUserIdentityMutation(client);
    if (grader.userId) {
      const activeGrader = await client.query(
        "SELECT id FROM users WHERE id = $1 AND status = 'active' FOR KEY SHARE;",
        [grader.userId]
      );
      if (!activeGrader.rows.length) throw new Error("管理员账号归属已更新，请刷新后重新保存阅卷结果");
    }
    const submissionResult = await client.query(`
      SELECT s.id, s.exam_id, s.user_id, s.pass_score, s.scores_json, e.total_score
      FROM submissions s
      JOIN exams e ON e.id = s.exam_id
      WHERE s.id = $1
      FOR UPDATE OF s;`, [submissionId]);
    if (!submissionResult.rows.length) throw new Error("未找到该答卷");
    const submission = submissionResult.rows[0];
    const questions = await loadAdminQuestions(client, submissionId, submission.exam_id, true);
    const objectiveDetail = {};
    const qaScores = {};
    const reviewReferences = {};
    const requestedCurrentIds = new Set(Array.isArray(input.useCurrentQuestionIds)
      ? input.useCurrentQuestionIds.map((value) => String(value))
      : []);
    let objectiveScore = 0;
    let qaScore = 0;

    for (const question of questions) {
      const useCurrent = requestedCurrentIds.has(String(question.id));
      if (useCurrent && question.referenceStatus !== "modified") {
        throw new Error(`题目 ${question.no} 不存在可采用的当前题库版本`);
      }
      const gradingQuestion = useCurrent ? { ...question, ...question.current } : question;
      const isQa = gradingQuestion.type === "qa";
      const raw = isQa ? input.qaScores?.[question.id] : input.objectiveScores?.[question.id];
      const requested = scoreInput(raw, gradingQuestion.score, `${isQa ? "问答题" : "客观题"} ${question.no}`, isQa);
      const recalculated = useCurrent && !isQa ? automaticScore(gradingQuestion) : null;
      const automatic = recalculated ?? question.automaticScore ?? question.earnedScore;
      const earned = useCurrent && !isQa ? automatic : requested === null ? question.earnedScore : requested;
      await client.query(`
        UPDATE submission_questions
        SET earned_score = $3,
          manually_adjusted = $4
        WHERE submission_id = $1 AND position = $2;`, [
        submissionId, question.no, earned, isQa ? true : earned !== automatic
      ]);
      if (isQa) {
        qaScores[question.id] = earned;
        qaScore += earned;
      } else {
        objectiveDetail[question.id] = {
          answer: question.submittedAnswer,
          correctAnswer: gradingQuestion.answer,
          earned,
          automaticEarned: automatic,
          manuallyAdjusted: earned !== automatic,
          correct: automatic === question.score
        };
        objectiveScore += earned;
      }
      reviewReferences[question.id] = {
        source: useCurrent ? "current" : "snapshot",
        currentQuestionVersion: useCurrent ? gradingQuestion.version : null
      };
    }

    const totalMax = asNumber(submission.total_score);
    const requestedPass = scoreInput(input.passScore ?? submission.pass_score, totalMax, "通过分数", true);
    const totalScore = objectiveScore + qaScore;
    const gradedAt = new Date().toISOString();
    const scores = { ...(submission.scores_json || {}), objectiveDetail, qaScores, reviewReferences };
    await client.query(`
      UPDATE submissions
      SET status = 'graded', objective_score = $2, qa_score = $3,
        total_score = $4, pass_score = $5, pass = $6,
        scores_json = $7::jsonb, grader_id = $8, grader_name = $9,
        grader_comment = $10, graded_at = $11
      WHERE id = $1;`, [
      submissionId, objectiveScore, qaScore, totalScore, requestedPass,
      totalScore >= requestedPass, JSON.stringify(scores), grader.userId || null,
      grader.name || "", String(input.graderComment || "").trim(), gradedAt
    ]);
    const detail = await getAdminSubmission(client, submissionId);
    await client.query("COMMIT");
    return detail;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function grantRetakePermission(pool, submissionId, grantedBy) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockUserIdentityMutation(client);
    if (grantedBy) {
      const activeGrader = await client.query(
        "SELECT id FROM users WHERE id = $1 AND status = 'active' FOR KEY SHARE;",
        [grantedBy]
      );
      if (!activeGrader.rows.length) throw new Error("管理员账号归属已更新，请刷新后重新授权补考");
    }
    const result = await client.query(`
      INSERT INTO retake_permissions (id, exam_id, user_id, remaining_count, granted_by, granted_at)
      SELECT $1, s.exam_id, s.user_id, 1, $3, CURRENT_TIMESTAMP
      FROM submissions s
      JOIN users u ON u.id = s.user_id AND u.status = 'active'
      WHERE s.id = $2 AND s.user_id IS NOT NULL
      ON CONFLICT (exam_id, user_id) DO UPDATE
      SET remaining_count = retake_permissions.remaining_count + 1,
        granted_by = EXCLUDED.granted_by,
        granted_at = CURRENT_TIMESTAMP
      RETURNING remaining_count;`, [crypto.randomUUID(), submissionId, grantedBy || null]);
    if (!result.rows.length) throw new Error("未找到可授权补考的答卷");
    await client.query("COMMIT");
    return { remainingExtraAttempts: asNumber(result.rows[0].remaining_count) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  automaticScore,
  getAdminSubmission,
  gradeAdminSubmission,
  grantRetakePermission,
  listAdminSubmissions,
  changedQuestionFields,
  mapAdminListItem,
  mapAdminQuestion,
  scoreInput
};
