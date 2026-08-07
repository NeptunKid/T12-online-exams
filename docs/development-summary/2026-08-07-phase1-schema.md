# Phase 1：PostgreSQL schema 与迁移骨架

日期：2026-08-07

## 任务与范围

为 Sprint 2 建立 PostgreSQL 空库 schema、幂等迁移执行器和受控回滚入口。本步骤不连接云服务器、不导入历史答卷、不修改 `001`、`002` 数据。

## 变更

- 新增 `0001_phase1_core_schema.sql`：用户身份、预置 RBAC 角色、题库、考试、答卷快照、补考、通知和审计基础表。
- 新增 `scripts/migrate.js`：记录 SQL 校验值，重复执行跳过，已执行迁移被篡改时失败；完整 `DB_*` 环境变量存在时不读取本地 `.env`。
- 新增同名 down migration；回滚要求 `--allow-destructive`，并只允许回滚最新迁移。
- 修正实际测试环境为东京 Ubuntu 24.04 + PostgreSQL 16、2 vCPU / 1 GiB / 30 GiB。

## 数据兼容性与安全

答卷使用 `legacy_submission_id`、`legacy_student_name` 与 `legacy_dingtalk_union_id` 预留旧 JSON 字段；题目和作答使用 `snapshot_json`，后续编辑题库不改变已交卷历史。迁移工具只从环境变量或 `.env` 读取连接信息，绝不输出密码。

## 验证

- `npm run check`：通过，9 项测试通过，含语法检查、迁移结构检查、既有评分/权限测试与敏感信息扫描。
- `npm run migrate:plan`：通过，输出 `0001_phase1_core_schema` 且确认存在回滚文件。
- 临时 PostgreSQL 空库实测：首次运行创建 15 张表和 4 个预置角色；第二次运行跳过已执行迁移；受控回滚后仅保留 `schema_migrations` 记录表。测试结束后已停止并删除临时数据库目录。

## 风险与回滚

云端 `t12_exams` 尚未执行该迁移，也未导入历史 JSON；执行前仍需完成服务器端 PostgreSQL 初始化验证。回滚仅在空库或已完成 `pg_dump` 备份后执行，且会删除本迁移创建的表数据。
