-- 支持可自动判分、可人工改分的填空题。
ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_type_check;
ALTER TABLE questions
  ADD CONSTRAINT questions_type_check
  CHECK (type IN ('single', 'multi', 'judge', 'fill', 'qa'));
