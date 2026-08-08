# 考生端切换 PostgreSQL 接口

日期：2026-08-08

## 本次范围

- 考生端优先读取 PostgreSQL `/api/exams/dashboard`、`/api/exams/:examId`、`/api/exams/:examId/submissions` 和 `/api/exams/submissions/:id`。
- PostgreSQL 工作台支持多考试入口、考试次数和待阅卷状态；新交卷结果返回后直接进入结果页。
- PostgreSQL 成绩详情只展示考生自己的作答和得分，不展示标准答案或解析。
- PostgreSQL 工作台接口不可用时保留旧 JSON 工作台路径，避免历史功能中断。
- 更新 `exam.js` 缓存版本参数，确保浏览器获取最新前端代码。

## 验证结果

- `npm test`：25 项通过。
- `npm run check:syntax`：通过，包含 `public/exam.js`。
- `npm run check:secrets`：通过。
- `git diff --check`：通过。

## 风险与回滚

- 新 PostgreSQL 详情页不再显示标准答案，这是数据安全预期；旧 JSON 详情接口保持原兼容行为。
- 回滚方式：回退应用版本或恢复旧 `public/exam.js`；不涉及数据库迁移，不修改历史答卷。

## 外部文档同步

使用 `npm run sync:feishu` 追加本总结，脚本按内容 SHA 幂等去重。
