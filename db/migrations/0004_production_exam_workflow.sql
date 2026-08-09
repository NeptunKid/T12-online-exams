-- 将当前已开放考试授权给所有有效钉钉员工，并修正历史考试时长单位。
INSERT INTO exam_assignments (id, exam_id, subject_type, subject_id)
SELECT
  'global_assignment_' || md5(e.id),
  e.id,
  'group',
  'all-active-dingtalk-users'
FROM exams e
WHERE e.status IN ('scheduled', 'published', 'paused')
ON CONFLICT (exam_id, subject_type, subject_id) DO NOTHING;

UPDATE exams
SET duration_seconds = 2700
WHERE title = '清洁卫生入职培训考试'
  AND duration_seconds = 30;

-- 纯客观题答卷也必须经管理员确认；只回退从未人工阅卷的自动完成记录。
UPDATE submissions
SET status = 'pending', total_score = NULL, pass = NULL
WHERE exam_id IN ('exam-extraction-principle', 'exam-fire-basics', 'exam-it-basics')
  AND status = 'graded'
  AND grader_id IS NULL
  AND graded_at IS NULL;
