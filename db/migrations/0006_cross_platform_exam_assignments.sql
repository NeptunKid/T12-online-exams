-- 已开放考试同时授权给所有有效钉钉、飞书员工。
INSERT INTO exam_assignments (id, exam_id, subject_type, subject_id)
SELECT
  'all_users_assignment_' || md5(e.id),
  e.id,
  'group',
  'all-active-users'
FROM exams e
WHERE e.status IN ('scheduled', 'published', 'paused')
ON CONFLICT (exam_id, subject_type, subject_id) DO NOTHING;
