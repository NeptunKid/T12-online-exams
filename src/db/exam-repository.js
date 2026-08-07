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

function mapQuestion(row) {
  return {
    id: row.question_id,
    no: Number(row.position),
    type: row.type,
    stem: row.stem,
    options: row.options_json || [],
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

module.exports = { getPublishedExam, listPublishedExams, mapExam, mapQuestion };
