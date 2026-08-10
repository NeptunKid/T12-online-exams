DELETE FROM exam_assignments
WHERE id LIKE 'all_users_assignment_%'
  AND subject_type = 'group'
  AND subject_id = 'all-active-users';
