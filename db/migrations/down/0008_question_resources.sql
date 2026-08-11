DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM submission_questions
    WHERE snapshot_json::text LIKE '%/api/question-resources/question_resource_%'
  ) THEN
    RAISE EXCEPTION '历史答卷已引用上传图片，请保留 0008 或恢复迁移前数据库备份';
  END IF;
END
$$;

UPDATE questions q
SET images_json = COALESCE((
  SELECT jsonb_agg(image_ref)
  FROM jsonb_array_elements(q.images_json) image_ref
  WHERE image_ref #>> '{}' !~ '^/api/question-resources/question_resource_[A-Za-z0-9-]+$'
), '[]'::jsonb)
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(q.images_json) image_ref
  WHERE image_ref #>> '{}' ~ '^/api/question-resources/question_resource_[A-Za-z0-9-]+$'
);

DROP TABLE question_resources;
