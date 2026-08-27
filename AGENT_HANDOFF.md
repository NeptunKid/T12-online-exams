# T12 在线考试后台追踪系统交接说明

更新时间：2026-08-27
项目目录：`/Users/neptun/Documents/Codex/003_考试后台追踪系统_钉钉飞书接入版`
GitHub：`NeptunKid/T12-online-exams`
生产域名：`https://exam.t12group.com/`

本文是后续 Agent 的快速接手入口。详细历史放在 `docs/development-summary/`；生产步骤以 `docs/production-deployment-runbook.md` 为准；共享服务器以 Codex 根目录的 `/Users/neptun/Documents/Codex/aliyun-server-inventory.md` 为唯一总账。发生冲突时，以用户当前指令和项目 `AGENTS.md` 为准。

## 1. 当前状态

- 核心业务已在生产验收：钉钉/飞书登录、RBAC、同名账号人工合并、题库/试卷生命周期、整体组卷保存、题目及选项图片、答案规则、`.t12backup` 导入导出、考试授权、阅卷和钉钉/飞书通知。
- 用户已确认生产版本 `c80cb83` 的飞书通讯录同步成功，钉钉/飞书通知均实测成功。生产数据库已执行迁移 `0001` 至 `0012`。
- 生产架构和备份现状见服务器总账：Caddy + Node.js + PostgreSQL；自动逻辑备份当前关闭；服务器最多保留一份完整 PostgreSQL dump。
- PR #72、PR #73 已合并。当前本地分支可能包含后续文档/备份开发提交；部署版本必须以用户确认的 `main` 合并 SHA 为准，不要按分支名猜测。
- 最近本机质量门：`npm test` 368 项通过，语法检查、敏感信息扫描和 `git diff --check` 通过。

## 2. 不可违反的约束

- 不修改 `001_考试后台追踪系统` 和 `002_考试后台追踪系统_钉钉登录版`；003 不与它们共用数据库、答卷、资源或环境文件。
- 不读取、输出或提交 `.env`、`/etc/t12-online-exams/t12-online-exams.env`、OAuth/消息 Secret、数据库密码、员工身份标识、答卷答案或通知正文。
- 历史答卷使用提交时快照和评分依据；题库、试卷或答案修改不得静默改变历史成绩。
- 生产数据库写入、迁移、身份合并或回导前，先执行 `pg_dump -Fc`，记录绝对路径、大小和 SHA-256，并保留回滚方案。
- 删除优先软删除/归档；永久删除必须确认有效引用、备份和恢复路径。命令行身份整理脚本只允许 dry-run。
- 每次只推进一个可验证、可回滚的步骤，并记录修改文件、测试、风险、回滚和文档同步状态。
- 每条服务器命令必须标注执行位置。GitHub 网络卡顿时停止重复重试，交给用户本机终端处理；用户负责生产部署和真实桌面/手机验收。

## 3. 生产架构与权限

```text
Cloudflare DNS/代理
  -> Caddy（公网 80/443，HTTPS）
  -> t12-exams.service（Node.js，127.0.0.1:3001）
  -> PostgreSQL 16（127.0.0.1:5432）
```

- 代码目录：`/opt/t12-online-exams`，所有者 `codexdeploy`。
- 环境文件：`/etc/t12-online-exams/t12-online-exams.env`，仅服务器读取。
- 数据库：`t12_exams` / `t12_app`，仅监听本机；Caddy 配置和 systemd 单元分别对应仓库 `deploy/Caddyfile`、`deploy/t12-exams.service`。
- 管理员 Workbench 登录用户通常是 `admin`；Git/npm 使用 `sudo -u codexdeploy -H`，迁移、systemd、Caddy 使用 `admin + sudo`。
- SSH 已加固为 `PermitRootLogin no`、`PubkeyAuthentication yes`、`PasswordAuthentication no`；安全组和 nftables/UFW 仍需按服务器总账核对。

## 4. 已完成能力

### 业务与数据

- 题目只属于题库；试卷从绑定题库选择题目，分值属于试卷组卷关系。
- 支持单选、多选、判断、填空、简答；题干和选项均可有图片；答案、解析、填空顺序规则均受校验。
- 题库支持新建、编辑、复制、归档、恢复、软删除和满足引用条件后的永久删除；试卷支持新建、复制、版本化修订、发布、删除和整体保存。
- 组卷一次保存题库、选题、顺序、分值和参数；按题型批量设分后仍可手动调整。
- 历史答卷快照、评分、审计和通知 outbox 保持独立，不被后续内容修改破坏。

### 平台、权限与通知

- 钉钉/飞书 OAuth 双入口、统一内部用户、RBAC、系统管理员和人工同名合并已完成；不凭姓名自动合并。
- 授权支持用户、已同步部门、全部有效用户和全部有效钉钉用户；组织同步支持部门树、分页、去重、多部门关系和空目录诊断。
- `submission.created` 只通知有效管理员；`submission.graded` 通知考生和有效管理员，并包含考生姓名。
- Worker 使用 outbox 幂等键、数据库锁、超时恢复、指数退避、最大尝试、送达回执和人工重发；钉钉、飞书发送均已用户实测。

### 导入、导出与备份

- `.t12backup` 是自包含、带版本和 SHA-256 校验的 ZIP，包含题库/试卷关系、分值、答案解析、授权和图片正文；导入总是生成新对象并整体回滚。
- 自动逻辑备份代码仍保留但生产关闭。服务器灾难恢复点使用单独的 PostgreSQL `pg_dump -Fc`；当前完整恢复点和校验值见服务器总账。
- 外部对象存储目前只有提供商无关契约和内存模拟器，尚未连接 OSS/S3/R2、未创建 Bucket、未产生费用。

## 5. 当前未完成与优先级

1. 通知 Worker 监控告警的生产部署、管理员验收和定期积压对账。
2. 外部对象存储真实适配、私有权限、生命周期、容量监控和隔离恢复演练；供应商、区域、预算确认前不得创建云资源。
3. 通讯录差异同步：离职/禁用、改名、多部门变化、历史授权保留和审计。
4. 电脑、手机、蜂窝网络和公司外网络的定期回归清单。
5. 飞书总结同步纳入受控发布步骤；不要把 Secret 放入 GitHub 或文档。

## 6. 故障入口

- 管理员或考生页面无限加载：确认实际 `admin.js`/`exam.js` 缓存版本，再检查对应 API、服务日志和 PostgreSQL 活动；代码应在约 15 秒后显示错误而不是一直等待。
- 通知页面显示 `--`：表示统计请求尚未成功，不等于 0。只读检查 `systemctl is-active`、本机 `/healthz`、指定时间段 `journalctl`、通知状态聚合和 `pg_stat_activity`；不要删除或重置通知。
- 第三方同步或消息失败：保留安全的平台错误码和短消息，检查应用权限、可见范围、发布状态、ID 类型、分页和网络；不要只看“请求失败”，也不要输出 Token/Secret/完整 URL/原始身份 ID。
- Workbench 无输出或提示 `Failed to restore initial working directory`：新建会话，切换到可访问目录，逐条执行并检查退出码；不要因无输出重复重启或清理数据。

## 7. 标准交付流程

1. **本机终端**：阅读 `MEMORY.md`、计划、`docs/agent-development-handbook.md` 和相关开发摘要；建立 `codex/`、`feature/` 或 `fix/` 分支，先复现再做最小改动。
2. **本机终端**：运行 `npm test`、`npm run check:syntax`、`npm run check:secrets`、`git diff --check`；提交后 `git push`，优先用 `gh pr create` 自动创建 PR。
3. **GitHub**：合并后记录完整 merge SHA；不要把未合并分支或本地 SHA 当生产版本。
4. **阿里云 Workbench**：按 `docs/production-deployment-runbook.md` 执行版本确认、`pg_dump -Fc`、以 `codexdeploy` 拉取和安装、迁移、重启、`/readyz`/公网 `/healthz` 检查。
5. **用户电脑/手机**：由用户完成真实验收；通过后在本文件、`MEMORY.md` 和对应开发摘要记录结果。服务器配置变化必须同步更新 `/Users/neptun/Documents/Codex/aliyun-server-inventory.md`。

## 8. 文档索引

- 生产部署：`docs/production-deployment-runbook.md`
- 服务器唯一总账：`/Users/neptun/Documents/Codex/aliyun-server-inventory.md`
- 钉钉/飞书接入：`docs/dingtalk-feishu-integration-guide.md`
- 通用开发手册：`docs/agent-development-handbook.md`
- 备份格式：`docs/backup-format-v1.md`
- 自动备份说明：`docs/automatic-backups.md`
- 阶段开发摘要：`docs/development-summary/`
