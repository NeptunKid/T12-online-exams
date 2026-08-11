# 管理员统计筛选与试卷题库模型审计

日期：2026-08-11  
分支：`feature/exam-authoring-v2`

## 需求范围

- 将管理员后台的总提交、待批阅、已批阅统计卡改为可操作的状态筛选按钮。
- 增加只读审计工具，为后续将分值从 `questions` 收敛到 `exam_questions` 提供生产数据盘点能力。
- 本步骤不修改数据库结构、题目、试卷、用户、答卷或生产环境。

## 修改文件

- `public/admin.html`
- `public/admin.js`
- `public/styles.css`
- `scripts/audit-exam-question-model.js`
- `tests/admin-mobile-layout.test.js`
- `tests/exam-question-model-audit.test.js`
- `package.json`
- `MEMORY.md`

## 数据库迁移

无。审计工具只执行两条聚合 `SELECT`，不读取题干、答案、用户身份或答卷内容，也不提供写入参数。

## 测试结果

- `npm run check`：通过，120 项测试全部通过。
- `npm run check:syntax`：通过。
- `npm run check:secrets`：通过。
- `git diff --check`：通过。

## 风险

- 统计按钮只改变前端筛选入口，统计数据仍来自现有管理员答卷 API。
- 审计结果反映执行时数据库状态；生产执行时只能在阿里云 Workbench 使用只读命令，不得添加写入逻辑。

## 回滚方式

- 回滚本次代码提交即可恢复原统计卡和移除审计工具。
- 本步骤没有数据库写入，不需要恢复 PostgreSQL 或资源文件。

## 文档与部署状态

- 开发总结：已记录。
- 飞书文档同步：未执行。
- GitHub PR：未创建。
- 生产部署：未执行。
- 公网、手机和电脑端验收：待后续部署后执行。
