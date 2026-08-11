ALTER TABLE exams
  DROP CONSTRAINT exams_pass_rate_check;

ALTER TABLE exams
  DROP COLUMN pass_rate;

ALTER TABLE exams
  DROP CONSTRAINT exams_question_bank_id_fkey;

ALTER TABLE exams
  DROP COLUMN question_bank_id;

ALTER TABLE questions
  ALTER COLUMN score DROP DEFAULT;
