-- 此回滚会删除 Phase 1 的全部数据库数据。只能通过 scripts/migrate.js 的显式确认执行。

DROP TABLE audit_logs;
DROP TABLE notifications;
DROP TABLE retake_permissions;
DROP TABLE submission_questions;
DROP TABLE submissions;
DROP TABLE exam_assignments;
DROP TABLE exam_questions;
DROP TABLE exams;
DROP TABLE questions;
DROP TABLE question_banks;
DROP TABLE user_roles;
DROP TABLE roles;
DROP TABLE user_identities;
DROP TABLE users;
DROP FUNCTION app_set_updated_at();
