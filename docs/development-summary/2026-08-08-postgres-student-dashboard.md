# PostgreSQL 考生工作台接口

日期：2026-08-08

## 本次范围

- 新增 `GET /api/exams/dashboard`，返回当前钉钉身份可参加的考试、考试次数、待阅卷状态和补考权限。
- 工作台考试数据来自 PostgreSQL `exams`、`exam_assignments`、`submissions` 和 `retake_permissions`。
- 同一接口同时返回当前用户的 PostgreSQL 答卷列表，便于后续考生端切换。
- 不修改旧 `/api/student/dashboard`，不修改历史 JSON 和数据库结构。

## 验证结果

- `npm test`：25 项通过。
- `npm run check:syntax`：通过。
- `npm run check:secrets`：通过。
- `git diff --check`：通过。

## 风险与回滚

- 当前旧考生页面仍使用 JSON 工作台；前端切换作为下一独立步骤实施。
- 本步骤无数据库迁移，回退应用版本即可；不会影响历史答卷。

## 外部文档同步

使用 `npm run sync:feishu` 追加本总结到指定 Feishu 在线文档；同步脚本按内容 SHA 幂等去重。
