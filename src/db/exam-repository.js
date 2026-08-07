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

async function listPublishedExams(pool) {
  const result = await pool.query(`
    SELECT id, title, status, duration_seconds, total_score, pass_score, version
    FROM exams
    WHERE status IN ('scheduled', 'published', 'paused')
    ORDER BY created_at, id;`);
  return result.rows.map(mapExam);
}

async function getPublishedExam(pool, examId) {
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
    ORDER BY eq.position;`, [examId]);

  if (!result.rows.length) return null;
  const exam = mapExam(result.rows[0]);
  return {
    ...exam,
    images: {},
    questions: result.rows.map(mapQuestion)
  };
}

module.exports = { getPublishedExam, listPublishedExams, mapExam, mapQuestion };
