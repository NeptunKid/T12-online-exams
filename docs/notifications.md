# 通知发送与重试

## 当前范围

- 交卷生成 `submission.created`，通知有效阅卷管理员。
- 阅卷完成生成 `submission.graded`，同时通知考生和所有有效管理员，消息包含考生姓名。
- 当前实际发送只支持飞书应用消息；钉钉任务保留在 `pending`。
- 消息只包含必要摘要和站内链接，不包含答案、解析或完整作答。

## 安全启用顺序

执行位置：阿里云 Workbench。

1. 按生产部署固定流程创建 `pg_dump -Fc`。
2. 拉取新版本，执行 `0011_notification_delivery_receipts` 迁移。
3. 保持 `T12_NOTIFICATION_WORKER_ENABLED=false` 重启，先在管理员后台确认“通知”列表可读。
4. 在飞书开放平台确认应用已发布到企业，并具备应用消息/机器人发送权限。
5. 编辑 `/etc/t12-online-exams/t12-online-exams.env`，只修改：

```dotenv
T12_NOTIFICATION_WORKER_ENABLED=true
T12_NOTIFICATION_CHANNELS=feishu
T12_PUBLIC_BASE_URL=https://exam.t12group.com
T12_NOTIFICATION_NOT_BEFORE=2026-08-17T18:00:00+08:00
```

`T12_NOTIFICATION_NOT_BEFORE` 应替换为实际启用时刻。早于此时间的现有任务不会补发，避免向员工发送过期提醒。

6. 重启 `t12-exams`，检查 `/readyz`，再提交一份新的测试答卷并观察后台通知状态从“待发送”变为“已送达”。

## 状态

- `pending`：等待 Worker 领取。
- `processing`：已被一个 Worker 锁定发送。
- `failed`：发送失败，等待指数退避后自动重试。
- `abandoned`：达到最大尝试次数，只能由系统管理员人工重发。
- `delivered`：平台返回成功并保存回执，不能人工重复发送。

Worker 崩溃时，超过 `T12_NOTIFICATION_STALE_AFTER_SECONDS` 的 `processing` 任务会自动恢复为 `pending`。管理员列表只显示收件人哈希摘要，不返回真实平台身份或通知正文。
人工重发会更新任务的下一次尝试时间，因此即使原任务早于启用阈值，也能在管理员明确确认后由 Worker 处理。

## 回滚

关闭 `T12_NOTIFICATION_WORKER_ENABLED` 并重启即可停止领取新任务，不影响交卷和阅卷。`0011` 回滚会在存在送达回执时主动拒绝；应保留迁移或先在隔离库完成回执迁移，禁止直接删除通知记录。
