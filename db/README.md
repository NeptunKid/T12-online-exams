# 数据库迁移

`db/migrations/` 中的 SQL 文件按文件名顺序执行。`schema_migrations` 会记录文件名和 SHA-256；同一迁移重复执行会跳过，已执行文件被修改会直接失败。

先在目标服务器确认 PostgreSQL 已由 `scripts/bootstrap-postgres-cloud.sh` 创建 `t12_exams` 和 `t12_app`，并仅监听 `127.0.0.1:5432`。迁移工具从本地 `.env` 或进程环境读取 `DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_USER`、`DB_PASSWORD` 与 `DB_SSL`，从不输出连接密码。

```bash
npm run migrate:plan
npm run migrate
```

回滚会删除该迁移创建的表及其所有数据，因此只允许回滚最新迁移，且必须先完成 `pg_dump` 备份，再显式确认：

```bash
npm run migrate -- --rollback 0001_phase1_core_schema --allow-destructive
```

本迁移只创建空表，不导入或修改 `001`、`002` 的答卷。历史 JSON 导入会在下一独立步骤中执行，并先进行只读备份和数据对账。
