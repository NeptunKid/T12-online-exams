# 钉钉通知发送适配器

日期：2026-08-21

## 实现内容

- 新增钉钉工作通知 transport：使用消息应用 AppKey/AppSecret 获取应用凭证，按 unionId 查询 userid，再使用 AgentId 发送文本工作通知。
- 通知 Worker 通道配置现在支持 `feishu,dingtalk`；启用 dingtalk 时强制校验三个消息应用配置。
- 新创建的钉钉通知任务优先使用 `user_identities.union_id`，不把 OAuth `open_id` 直接当作工作通知收件人。
- 保留现有重试、放弃、回执和审计逻辑，无新数据库迁移。

## 历史任务边界

旧的钉钉 pending 任务可能保存了 OAuth `open_id`，不能在不对账的情况下自动改写。启用钉钉 Worker 前，管理员应先按创建时间和事件核对旧任务；可选择继续保留、在管理员确认后单独处理，或仅在有明确映射时执行一次性整理。本步骤不回填或删除任务。

## 生产前置条件

- 钉钉开放平台应用已发布，已开启工作通知能力和通讯录用户查询权限。
- 已配置 `T12_DINGTALK_MESSAGE_APP_KEY`、`T12_DINGTALK_MESSAGE_APP_SECRET` 和 `T12_DINGTALK_MESSAGE_AGENT_ID`，凭证只存在服务器 Secret。
- 先以 `T12_NOTIFICATION_CHANNELS=feishu` 部署验收，再在新的时间阈值后启用 `dingtalk`，不要直接释放旧钉钉 pending。

## 验证与回滚

`npm run check` 应包含语法检查、通知配置、传输器、工作人、Outbox 和原有业务回归。本次无数据库迁移，可回滚代码提交并重启服务；不要删除通知记录。
