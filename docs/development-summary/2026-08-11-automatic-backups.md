# 定期自动备份

日期：2026-08-11

## 本步完成

- 新增可回滚 `0009_automatic_backups`，记录每个试卷/题库的运行状态和备份工件。
- 自动备份可保存到 PostgreSQL `bytea` 或受控服务器目录，默认关闭。
- 周期、启动延迟和每个对象的保留数量由环境变量配置；服务器目录不返回前端。
- 每个题库和试卷独立运行，单个对象失败不会阻断其余对象。
- PostgreSQL advisory lock 防止多应用实例重复执行。
- 文件系统采用受控相对键、原子写入和路径穿越防护；数据库正文校验大小和 SHA-256。
- 管理员可查看公开配置与最近运行、立即触发备份并下载成功的历史工件。
- 保留策略按每个对象保存最近 N 份；过期文件清理失败会单独记录，不否定已成功生成的工件。
- `0009` 回滚在存在工件时主动拒绝，避免静默删除备份。

## 修改范围

- `db/migrations/0009_automatic_backups.sql` 及 down migration。
- `src/db/backup-repository.js`。
- `src/backup/automatic-backup-config.js`、`automatic-backup-service.js`、`filesystem-backup-storage.js`。
- `src/http/admin-backup-handler.js`、`server.js`。
- `public/admin.html`、`public/admin.js`、`public/styles.css`。
- `.env.example`、`deploy/t12-exams.service`、`docs/automatic-backups.md`。
- 自动备份 repository/service/config/storage/handler/UI/migration 测试。

## 验证

- `npm run check`：232 项测试通过。
- 语法检查通过。
- 敏感信息扫描通过。
- `git diff --check` 通过。

## 风险与回滚

- 未执行真实 PostgreSQL 迁移或写入，未启用本机或生产自动备份。
- 本机服务启动命令输出正常，但受执行环境生命周期限制，随后无法连接本机端口，因此未完成浏览器/真实数据库端到端验收。
- 数据库存储不能替代 `pg_dump -Fc` 灾难恢复；文件系统目录也不能暴露为静态目录。
- 生产启用前必须先完整备份数据库、部署 `0009`、确认存储容量和目录权限，再开启环境变量。
