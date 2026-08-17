ALTER TABLE notifications
  ADD COLUMN receipt_json jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX notifications_processing_updated_idx
  ON notifications (updated_at)
  WHERE status = 'processing';
