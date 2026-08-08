# 003 考试后台追踪系统：阶段性总总结

日期：2026-08-08
项目：`003_考试后台追踪系统_钉钉飞书接入版`
当前进度：约 32%（按六个 Sprint 的交付工作量粗略估算）

## 1. 项目边界与技术决策

- `001_考试后台追踪系统` 和 `002_考试后台追踪系统_钉钉登录版` 保持不变，只读使用 `002` 作为迁移来源。
- 新系统使用独立 PostgreSQL 数据库，不与旧版本共用 `data/submissions.json`。
- 部署目标为阿里云东京轻量服务器：Ubuntu 24.04、2 vCPU、1 GiB RAM、30 GiB 系统盘；PostgreSQL 16 只监听 `127.0.0.1:5432`。
- 公网域名为 `https://exam.t12group.com/`；数据库不暴露公网。
- 凭证只放在本地 `.env`、服务器部署环境或 GitHub Secrets；开发总结不包含真实凭证、答卷答案或员工身份值。

## 2. 已完成工作

### 工程与交付基线

- 建立 GitHub 仓库、`main`/功能分支流程、分支保护和 GitHub Actions 质量门。
- 修复 Actions 缺少 lockfile 的问题，CI 统一先执行 `npm ci`。
- 建立 `.env.example`、配置说明、备份策略、迁移执行器和敏感信息扫描。
- 保留每一步开发总结、测试结果、风险和回滚方式。

### 云端 PostgreSQL

- 编写并修复 Ubuntu PostgreSQL 初始化脚本。
- 云端数据库已创建：`t12_exams`，应用账户为 `t12_app`，数据库仅本机监听。
- 已执行 `0001_phase1_core_schema` 和 `0002_legacy_exam_assignments` 迁移。

### 历史答卷迁移

- 从 `002` 创建带时间戳的只读备份，保留 SHA-256 校验值：
  `f2645a75df11612fa6fb1f9ce7310fc157d18ef77bc39baef27aa7b8ac52af33`。
- 历史答卷已导入 PostgreSQL，并通过逐条对账：2 份答卷、72 个题目快照、36 道题、1 个用户和 1 个身份映射；答卷状态均为 `graded`。
- 导入器具备幂等性，重复执行不会生成重复答卷。
- `0002` 为历史用户回填个人考试授权，查询按当前钉钉 `unionId` 和授权时间窗口过滤。

### PostgreSQL 考试 API

- `GET /api/exams`：返回当前身份被授权的已发布考试。
- `GET /api/exams/:examId`：返回去答案、去解析的发布版本题目。
- `POST /api/exams/:examId/submissions`：事务写入答卷和题目快照；客观题自动评分，问答题保留 `pending`。
- `GET /api/exams/submissions`：返回当前用户自己的 PostgreSQL 答卷列表。
- `GET /api/exams/submissions/:submissionId`：返回当前用户自己的答卷详情，剔除标准答案和解析。
- 旧 JSON 考生端、交卷、阅卷和补考接口均保留，确保历史答卷兼容。

## 3. GitHub 交付记录

- PR #5：PostgreSQL bootstrap 修复。
- PR #6：Phase 1 PostgreSQL schema。
- PR #7：`002` 历史答卷备份与幂等导入。
- PR #8：历史答卷逐条只读对账。
- PR #9：PostgreSQL 只读考试 API。
- PR #10：考试个人授权过滤。
- PR #11：PostgreSQL 新考试交卷 API。
- PR #12：PostgreSQL 本人答卷查询 API。
- 所有相关 PR 的 CI `quality` 均已通过；PR #12 无冲突并已合并。

## 4. 当前验证结果

- `npm test`：22 项通过。
- `npm run check:syntax`：通过。
- `npm run check:secrets`：通过。
- `git diff --check`：通过。
- 云端数据库迁移和历史答卷对账已由服务器端执行并与预期一致。

## 5. 当前未完成事项

- Phase 1：创建第二份真实考试并完成两份考试并行、历史成绩和前端切换验证。
- Phase 2：题库 CRUD、CSV/XLSX 校验预览、手动组卷、发布版本管理和管理员页面。
- Phase 3：飞书 OAuth、身份绑定、用户同步和完整 RBAC。
- Phase 4：阅卷分派、Outbox、飞书/钉钉通知、重试和结果回执。
- Phase 5/6：GitHub 自动发布、飞书文档自动总结、监控、备份演练和移动端公网端到端验证。

## 6. 风险与回滚

- 目前新 PostgreSQL API 尚未切换旧前端；旧 JSON 路径仍是现有页面的兼容路径。
- 服务器规格仅适合 1～2 名员工测试，不能视为生产容量承诺。
- 新 API 无新增数据库迁移；出现问题时回退应用版本即可。
- 历史数据回滚以停止新服务、保留 PostgreSQL 数据和恢复旧 JSON 只读副本为原则，不删除 `001`、`002` 或备份。

## 7. 下一步

先完成第二份考试的可复现发布和双考试验收，再进入题库与组卷；飞书登录、RBAC 和文档同步按计划后续实施。

本总结不包含真实凭证、答卷答案或员工身份信息。
