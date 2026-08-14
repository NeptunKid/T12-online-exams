# 通知 Outbox 事务入队

日期：2026-08-15

## 需求范围

继续总计划 Phase 5 的第一步：让交卷和阅卷结果变成可追踪的通知事件。此步只写入 PostgreSQL 既有 `notifications` 表，不调用钉钉或飞书 API。

## 修改内容

- 新增 `src/db/notification-repository.js`：
  - 查询有效的阅卷人、考试管理员和系统管理员的钉钉/飞书身份；
  - 查询答卷人的有效钉钉/飞书身份；
  - 使用 `event_key` 幂等写入 `pending` Outbox 任务；
  - 通知正文只保存考试、答卷、成绩和通过状态等必要摘要，不保存答案或解析。
- 交卷事务在保存答卷快照后、`COMMIT` 前入队 `submission.created`。
- 阅卷事务在保存成绩后、`COMMIT` 前入队 `submission.graded`。
- 没有新增数据库迁移，复用 Phase 1 已存在的 `notifications` 表。
- 没有接入外部消息发送、重试 worker 或管理端重发按钮，这些留待后续独立步骤。

## 验证结果

```text
npm run check
语法检查：通过
测试：300 项通过
敏感信息扫描：通过
git diff --check：通过
```

## 风险与回滚

- 当前没有发送 worker，任务会保持 `pending`，不会影响用户交卷或管理员保存阅卷。
- 若生产暂不启用通知，可不启动后续 worker；Outbox 记录仍可审计。
- 回滚代码即可移除入队调用；数据库无需回滚迁移，也不会删除已有答卷、快照或题库资源。

## 部署状态

本步骤尚未提交、推送、合并或部署生产。生产部署前仍须按 `docs/production-deployment-runbook.md` 在阿里云 Workbench 执行 PostgreSQL `pg_dump -Fc`，再进行版本确认、重启和健康检查。
