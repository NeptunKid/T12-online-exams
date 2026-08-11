-- 题库题目保留历史分值列以兼容旧写入；新组卷以 exam_questions.score 为分值来源。
ALTER TABLE questions
  ALTER COLUMN score SET DEFAULT 0;

ALTER TABLE exams
  ADD COLUMN question_bank_id text;

ALTER TABLE exams
  ADD CONSTRAINT exams_question_bank_id_fkey
  FOREIGN KEY (question_bank_id) REFERENCES question_banks (id);

-- 只有当前全部试题都来自同一题库时才建立试卷与题库的显式关联。
UPDATE exams e
SET question_bank_id = source.bank_id
FROM (
  SELECT eq.exam_id, MIN(q.bank_id) AS bank_id
  FROM exam_questions eq
  JOIN questions q ON q.id = eq.question_id
  GROUP BY eq.exam_id
  HAVING COUNT(DISTINCT q.bank_id) = 1
) source
WHERE e.id = source.exam_id;

ALTER TABLE exams
  ADD COLUMN pass_rate numeric(7, 6);

-- 空试卷没有可计算的通过比例，采用新试卷默认的 60%。
UPDATE exams
SET pass_rate = CASE
  WHEN total_score > 0 THEN ROUND(pass_score / total_score, 6)
  ELSE 0.600000
END;

ALTER TABLE exams
  ALTER COLUMN pass_rate SET DEFAULT 0.600000,
  ALTER COLUMN pass_rate SET NOT NULL;

ALTER TABLE exams
  ADD CONSTRAINT exams_pass_rate_check
  CHECK (pass_rate >= 0 AND pass_rate <= 1);
