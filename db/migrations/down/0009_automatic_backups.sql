DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM backup_artifacts) THEN
    RAISE EXCEPTION '自动备份工件仍存在，拒绝回滚 0009；请先保留完整 PostgreSQL 备份并清理工件';
  END IF;
END;
$$;

DROP TABLE backup_artifacts;
DROP TABLE backup_runs;
