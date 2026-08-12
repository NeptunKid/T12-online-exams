# 自动备份目录权限修正

日期：2026-08-11

## 现象与原因

- 生产自动备份已启用，但 12 个试卷/题库对象全部失败。
- 错误为在 `portable` 下创建 `backup_run_*` 目录时收到 `EACCES`。
- 父目录属于 `postgres:postgres` 且权限为 `0750`，服务账号 `codexdeploy` 无法穿越；子目录本身的所有权正确也不能绕过父目录权限。

## 修正

- 父目录统一为 `root:root 0711`，只允许非所有者穿越，不允许列出或写入。
- PostgreSQL 完整备份迁入 `postgres:postgres 0700` 子目录。
- 可移植备份保留在 `codexdeploy:codexdeploy 0700` 子目录。
- 同步修正所有仍会把父目录改回 `postgres:postgres 0750` 的生产部署文档。

## 边界与验证

- 不修改应用逻辑、数据库迁移、环境变量或历史答卷。
- 已产生的失败运行记录保留作审计，不应直接删除。
- 在阿里云 Workbench 修正权限后，先以 `codexdeploy` 执行目录可写检查，再从管理员后台立即运行并下载一份成功工件。
- 旧 PostgreSQL dump 不移动、不删除；以后新 dump 写入 `postgres` 子目录。
