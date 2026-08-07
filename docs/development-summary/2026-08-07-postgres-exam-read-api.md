# Phase 1：PostgreSQL 考试只读 API

日期：2026-08-07

## 任务与范围

新增 PostgreSQL 连接池、考试 repository 和只读考试 API。现有 JSON `/api/exam`、答卷提交和阅卷接口保持不变，后续步骤再逐步切换写入路径。

## 变更

- 新增 `pg` 依赖与 `src/db/postgres-client.js`。
- 新增 `src/db/exam-repository.js`，读取已发布考试和去答案题目。
- 新增认证后的 `GET /api/exams` 与 `GET /api/exams/:examId`。
- 数据库未配置时返回明确 `503`，不回退到未授权的匿名数据库读取。

## 兼容性与风险

旧 JSON API 保持原行为；新 API 当前只检查登录和考试发布状态，按人员/部门的 `exam_assignments` 授权将在后续 RBAC Sprint 增加。题目 API 不查询 `answer_json` 或解析字段。

## 验证与回滚

- `npm run check`：通过，17 项测试通过，敏感信息扫描通过。
- 临时 PostgreSQL 集成验证：读取 1 个已发布考试、36 道题；响应不包含 `answer` 或 `explanation` 字段。
- CI 首次失败原因是工作流未安装新增依赖；已补充 `npm ci` 步骤，等待重新运行质量门。
- 回滚为停止使用新 API 并回退到上一个版本；本步骤不修改数据库数据。
