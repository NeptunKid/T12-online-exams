-- 为已导入历史答卷的用户回填默认考试的个人授权。
INSERT INTO exam_assignments (id, exam_id, subject_type, subject_id)
SELECT
  'legacy_assignment_' || md5(s.exam_id || ':user:' || s.user_id),
  s.exam_id,
  'user',
  s.user_id
FROM submissions s
WHERE s.user_id IS NOT NULL
GROUP BY s.exam_id, s.user_id
ON CONFLICT (id) DO NOTHING;
