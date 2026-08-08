# 开发总结：Caddy 日志权限修正

日期：2026-08-08

## 问题与修复

Caddy 语法验证通过，但 reload 因 `caddy` 用户无法创建 `/var/log/caddy/t12-exams-access.log` 而失败。Caddyfile 已改为输出到 stdout，由 systemd journal 接收访问日志，避免文件权限和服务沙箱冲突。

## 验证与回滚

本次为配置变更，需在本机运行 `npm run check`，服务器更新后执行 `sudo caddy validate --config /etc/caddy/Caddyfile`。回滚时恢复上一版 Caddyfile 并 reload；不涉及数据库或答卷数据。
