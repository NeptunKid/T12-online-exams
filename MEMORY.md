# 考试后台追踪系统（钉钉飞书接入版）Memory

2026-08-05 [Codex] 创建 `003_考试后台追踪系统_钉钉飞书接入版` 项目目录，用于在 `002` 钉钉登录版的基础上规划钉钉与飞书双平台接入、多考试、题库、通知、GitHub、飞书文档同步及公网跨设备访问；当前仅放入概要与详细计划，尚未复制源码或生产答卷。
2026-08-08 [Codex] 已确定移除 Cloudflare Tunnel，采用阿里云东京服务器公网 80/443 + Caddy + Node.js 127.0.0.1:3001 + PostgreSQL 127.0.0.1:5432；新增 `deploy/Caddyfile`、`deploy/t12-exams.service`、公网部署文档与 `/healthz`、`/readyz` 检查，提交于 `chore/direct-public-deployment` 的 `1873bd0`。本机质量门 26 项测试、语法检查和敏感信息扫描均通过；因本机到 `ssh.github.com:443` 被限制，分支尚未推送/创建 PR。
