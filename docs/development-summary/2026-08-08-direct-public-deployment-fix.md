# 开发总结：公网部署环境文件修正

日期：2026-08-08

## 问题

服务器部署时，代码位于临时目录而不是 `/opt/t12-online-exams`，导致 Caddyfile 和 systemd 文件不存在；迁移脚本只读取项目 `.env`，没有读取 systemd 使用的 `/etc/t12-online-exams/t12-online-exams.env`。

## 修复

- `server.js` 和 `scripts/migrate.js` 支持 `T12_ENV_FILE` 指定环境文件。
- `.env.example` 端口统一为 `3001`。
- 公网部署文档改为使用系统环境文件执行迁移，并明确 `/tmp` 与 `/opt` 的区别。

## 验证、风险与回滚

本次代码变更需重新运行 `npm run check`。回滚方式是恢复上一提交并重新启动 `t12-exams`；不会删除或覆盖 PostgreSQL 数据、`.env` 或历史答卷。
