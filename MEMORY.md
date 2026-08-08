# 考试后台追踪系统（钉钉飞书接入版）Memory

2026-08-05 [Codex] 创建 `003_考试后台追踪系统_钉钉飞书接入版` 项目目录，用于在 `002` 钉钉登录版的基础上规划钉钉与飞书双平台接入、多考试、题库、通知、GitHub、飞书文档同步及公网跨设备访问；当前仅放入概要与详细计划，尚未复制源码或生产答卷。
2026-08-08 [Codex] 已确定移除 Cloudflare Tunnel，采用阿里云东京服务器公网 80/443 + Caddy + Node.js 127.0.0.1:3001 + PostgreSQL 127.0.0.1:5432；新增 `deploy/Caddyfile`、`deploy/t12-exams.service`、公网部署文档与 `/healthz`、`/readyz` 检查，提交于 `chore/direct-public-deployment` 的 `1873bd0`。本机质量门 26 项测试、语法检查和敏感信息扫描均通过；因本机到 `ssh.github.com:443` 被限制，分支尚未推送/创建 PR。
2026-08-08 [Codex] 针对服务器部署报错补充 `T12_ENV_FILE` 支持，迁移可读取 `/etc/t12-online-exams/t12-online-exams.env`；补充 `/opt` 目录和 Caddy 旧配置诊断说明，修复提交为 `3a968a6`、`d8cca72`，本机质量门仍为 26 项通过。
2026-08-08 [Codex] 公网验收完成：`/healthz`、`/readyz` 和 `https://exam.t12group.com/` 均通过，架构为 Cloudflare -> Caddy -> Node.js -> PostgreSQL。已新增 Phase 2 CSV 题库校验预览（`6fe6b68`）：只读解析、无数据库写入；来源核对得到萃取原理 43 题（无分数列、含填空与 9 张图片）、消防 32 题/100 分、IT 37 题/99 分（需先脱敏）和候选咖啡师招聘笔试 23 题/72 分；“5 个剩余考试”中仍有两份未确认。
2026-08-08 [Codex] 在 `feature/phase2-csv-preview` 提交 `27e1249`：新增 `fill` 填空题题型、CSV 校验、PostgreSQL `0003_fill_question_type` 迁移、自动判分（答案别名/去首尾空格/不区分大小写）、考生输入框与阅卷人工改分，质量门 34 项测试通过；用户已明确不纳入咖啡师招聘笔试，餐饮法规和咖啡基础各 3 份 PDF 为扫描试卷，待 OCR 与逐题复核。当前推送仍受本机 `ssh.github.com:443` 限制，未重复尝试。
2026-08-08 [Codex] 复核 PDF OCR：法规 18 页、咖啡 20 页均未生成有效文字；macOS Vision 对所有页面返回 `Failed to create CVPixelBuffer`，因此没有题目/选项/答案可供确认，未写入仓库或题库。
