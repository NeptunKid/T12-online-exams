DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM notifications
    WHERE receipt_json <> '{}'::jsonb
  ) THEN
    RAISE EXCEPTION '拒绝回滚 0011：已有通知送达回执，请先保留数据库备份并完成回执迁移';
  END IF;
END;
$$;

DROP INDEX IF EXISTS notifications_processing_updated_idx;

ALTER TABLE notifications
  DROP COLUMN IF EXISTS receipt_json;
