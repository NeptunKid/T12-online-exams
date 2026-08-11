# 试卷分值所有权兼容层

日期：2026-08-11

任务：试卷组卷新模型的可回滚前置步骤  
分支：`feature/exam-authoring-v2`

## 需求范围

- 题库题目不再具有业务分值；题目分值只属于试卷组卷关系 `exam_questions.score`。
- 手动录题和题库维护停止接收、返回或展示默认分值。
- 旧 CSV 兼容导入仍保留 `score` 列，但该值只用于创建初始试卷的组卷分值。
- 为试卷增加显式题库关联和通过率，为后续部分选题、全选、单题/批量改分及总分/通过分重算做准备。

## 数据库迁移

- 新增 `0007_exam_authoring_score_ownership.sql` 及同名 down migration。
- 保留 `questions.score`、现有值和 `NOT NULL`，仅设置 `DEFAULT 0`，避免破坏旧数据或旧导入审计。
- 新增可空 `exams.question_bank_id` 外键；只有当前全部选题恰好来自一个题库的试卷才自动回填。
- 新增 `exams.pass_rate numeric(7,6)`，现有总分大于 0 的试卷按 `pass_score / total_score` 回填；空试卷使用 60% 默认值。
- 迁移不包含对 `submissions` 或 `submission_questions` 的 UPDATE，不修改答卷归属、快照、分数或通过状态。

## 兼容性

- 考生取题、交卷快照、自动评分和管理员重阅继续读取 `exam_questions.score` 或答卷快照，不改变现有评分行为。
- 跨题库试卷和空试卷保持 `question_bank_id = NULL`，后续组卷编辑器必须拒绝直接编辑并要求人工整理，不能猜测题库。
- 生产代码部署顺序必须是：数据库备份 -> 只读模型审计 -> 执行 0007 -> 重启新代码。新代码在旧数据库上录题会因 `questions.score` 尚无默认值而失败。

## 验证

- `npm run check:syntax`：通过。
- `npm test`：131 项通过。
- `npm run check:secrets`：通过。
- `git diff --check`：通过。
- 新增测试覆盖迁移正反向文件、单题库安全回填、通过率约束、题库 API 不返回分值、手动录题不写分值，以及旧 CSV 分值仅写入 `exam_questions`。

## 风险与回滚

- 若历史数据存在 `pass_score > total_score`，0007 会因通过率约束失败并整笔回滚；禁止静默修正，需先审计确认业务值。
- 回滚迁移会删除 `question_bank_id` 和 `pass_rate`，并移除 `questions.score` 默认值，不删除旧题目分值、试卷题目或答卷数据。
- 尚未实现组卷 API/UI、图片上传、导入导出或自动备份；这些继续按独立步骤开发。

## 生产执行边界

- 执行位置：阿里云 Workbench。迁移前创建 `pg_dump -Fc` 并记录备份绝对路径。
- 执行位置：阿里云 Workbench。先运行 `npm run audit:exam-question-model -- --compact`；存在跨题库、总分差异或活动孤立题时，保留审计输出并停止开放相应试卷的组卷编辑。
- 本步骤尚未在生产执行，也未创建 GitHub PR 或同步飞书文档。
