ALTER TABLE questions
  ADD COLUMN images_json jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE questions
  ADD CONSTRAINT questions_images_json_array_check
  CHECK (jsonb_typeof(images_json) = 'array');
