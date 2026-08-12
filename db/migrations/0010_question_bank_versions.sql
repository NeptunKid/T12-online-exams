ALTER TABLE question_banks
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
