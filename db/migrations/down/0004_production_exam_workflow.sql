DELETE FROM exam_assignments
WHERE id LIKE 'global_assignment_%'
  AND subject_type = 'group'
  AND subject_id = 'all-active-dingtalk-users';

UPDATE exams
SET duration_seconds = 30
WHERE title = '清洁卫生入职培训考试'
  AND duration_seconds = 2700;

UPDATE submissions
SET status = 'graded',
  total_score = objective_score + qa_score,
  pass = (objective_score + qa_score) >= pass_score
WHERE exam_id IN ('exam-extraction-principle', 'exam-fire-basics', 'exam-it-basics')
  AND status = 'pending'
  AND grader_id IS NULL
  AND graded_at IS NULL;
