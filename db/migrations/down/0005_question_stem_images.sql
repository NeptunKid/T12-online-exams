ALTER TABLE questions
  DROP CONSTRAINT questions_images_json_array_check;

ALTER TABLE questions
  DROP COLUMN images_json;
