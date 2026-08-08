# PostgreSQL 本人答卷查询 API

日期：2026-08-08

## 本次范围

- 新增 `GET /api/exams/submissions`，按当前钉钉身份返回本人 PostgreSQL 答卷列表。
- 新增 `GET /api/exams/submissions/:submissionId`，返回本人答卷详情和交卷时题目快照。
- 历史快照中的标准答案、解析字段在返回前统一剔除；考生只看到自己的作答，已阅卷答卷才显示逐题得分。
- 旧 `/api/student/dashboard` 与 `/api/student/submissions/:id` JSON 接口保持不变。

## 验证结果

- `npm test`：22 项通过。
- `npm run check:syntax`：通过。
- `npm run check:secrets`：通过。
- `git diff --check`：通过。

## 风险与回滚

- 新查询接口尚未接入旧前端页面；前端切换将在后续独立步骤进行。
- 本步骤无数据库迁移，回滚应用版本即可；不影响历史答卷和快照数据。

## 外部文档同步

飞书在线文档同步能力尚未接入，本次仅保留仓库内开发总结。
