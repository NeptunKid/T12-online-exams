# 钉钉与飞书应用接入指南

本指南用于后续需要接入钉钉、飞书 OAuth、通讯录和工作通知的项目。它记录可复用的配置顺序和故障边界，不记录任何真实 App Secret、Access Token、员工身份 ID 或答卷数据。

## 1. 先确定能力边界

接入前先列出项目需要的能力，并分别验收：

| 能力 | 钉钉 | 飞书 | 说明 |
|---|---|---|---|
| OAuth 登录 | 企业内部应用 | 企业自建应用 OAuth | 回调地址必须 HTTPS 且与环境变量完全一致 |
| 组织通讯录 | 部门、成员、部门关系 | 部门、成员、部门关系 | 需要读取权限和应用可见范围 |
| 工作通知 | 消息应用 AgentId | 应用身份消息 | 通知凭证与 OAuth 凭证分别核对 |
| 开发总结同步 | 不适用 | 飞书云文档 | 文档 ID 只放部署环境 |

不要因为登录应用已经存在，就默认它已经具备通讯录或消息发送权限。每项能力都要在开放平台单独确认并做真实消息/目录验收。

## 2. 钉钉应用配置

执行位置：**钉钉开放平台**。

1. 创建或选择企业内部应用，记录 AppKey（新版界面可能称 Client ID）和 AppSecret。
2. 在 OAuth 设置中登记项目回调地址，例如 `https://example.company.com/auth/dingtalk/callback`。地址必须与 `DINGTALK_REDIRECT_URI` 完全一致。
3. 开通登录所需的身份读取权限。若项目要同步组织目录，另外开通通讯录部门、成员读取权限，并设置正确的应用可见范围。
4. 若项目要发送工作通知，在同一应用或独立消息应用中开通工作通知和通讯录用户查询能力，记录 AgentId。AgentId 不是 AppKey，也不是回调地址。
5. 发布应用的新版本；仅保存草稿不会让生产接口立即具备新权限。

执行位置：**部署 Secret 管理或阿里云 Workbench 环境文件**。只写变量名和值，不把值写入 Git、文档或聊天：

```dotenv
DINGTALK_CLIENT_ID=
DINGTALK_CLIENT_SECRET=
DINGTALK_REDIRECT_URI=https://example.company.com/auth/dingtalk/callback
DINGTALK_GRADER_UNION_IDS=
T12_DINGTALK_MESSAGE_APP_KEY=
T12_DINGTALK_MESSAGE_APP_SECRET=
T12_DINGTALK_MESSAGE_AGENT_ID=
```

说明：登录和消息可以使用同一个钉钉应用，但配置仍建议分成两组变量。这样代码能明确区分 OAuth 身份凭证和消息应用 AgentId；如果未来拆成两个应用，不需要改代码结构。

## 3. 飞书应用配置

执行位置：**飞书开放平台**。

1. 创建企业自建应用，记录 App ID 和 App Secret。
2. 在 OAuth/安全设置中登记 `https://example.company.com/auth/feishu/callback`，与 `FEISHU_REDIRECT_URI` 完全一致。
3. 开通 OAuth 用户身份读取权限，并发布应用版本。
4. 若项目要同步组织目录，开通通讯录部门、用户和部门成员关系读取权限，确认应用可见范围覆盖需要同步的组织。
5. 若项目要发送应用消息，开通应用身份发送消息权限（例如 `im:message:send`、`im:message` 或 `im:message:send_as_bot` 中平台允许的权限），启用 Bot 能力并发布新版本。权限开通但未发布时，生产 Token 可能仍无法调用接口。
6. 开发总结同步到云文档时，记录目标文档 ID，但不要把文档内容或凭证写进 Secret 以外的位置。

执行位置：**部署 Secret 管理或阿里云 Workbench 环境文件**：

```dotenv
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_REDIRECT_URI=https://example.company.com/auth/feishu/callback
FEISHU_DOCUMENT_ID=
```

## 4. 应用代码接入约定

- OAuth、通讯录和消息发送分别使用 provider/transport 适配器；业务层不要直接拼接平台请求。
- 只使用环境变量读取凭证；日志最多保留脱敏平台错误码和短消息，绝不记录 Token、Secret、完整请求 URL 或原始人员 ID。
- 通讯录同步必须支持分页、去重、多部门关系和空目录诊断。飞书部门 API 需兼容 `open_department_id` 与 `department_id`；部门树为空时仍应显式查询根范围的用户，不能静默显示 0/0。
- 目录同步失败不得只返回“请求失败”，应返回 HTTP 状态、平台错误码和可操作提示；权限不足、可见范围为空、网络超时和平台返回空数据要区分。
- 钉钉目录同步优先使用与登录一致的 `userid/openId` 作为身份主体，`unionId` 只作为匹配字段；不要把 `unionId` 错当成唯一登录主体。
- 消息发送要区分事件收件人：待阅卷提醒只发有效管理员，成绩通知发考生和有效管理员；以事件键保证幂等，不自动回填历史 pending 任务。

## 5. 配置后的验收顺序

执行位置：**本机终端**。先运行项目质量门：

```bash
npm test
npm run check:syntax
npm run check:secrets
git diff --check
```

执行位置：**GitHub**。创建 PR，合并后记录合并提交 SHA。不要在服务器直接修改代码；网络卡顿时停止重试，由用户本机终端完成 `git push`/PR 操作。

执行位置：**阿里云 Workbench**。按项目部署手册先创建 PostgreSQL 完整备份，再拉取合并后的 SHA、安装依赖、执行迁移、重启服务和检查 `/readyz`/公网 `/healthz`。环境文件修改后要重启服务，但不要把环境文件内容复制到聊天。

执行位置：**真实电脑/手机、钉钉和飞书客户端**。至少完成：

1. 钉钉 OAuth 登录和回调。
2. 飞书 OAuth 登录和回调。
3. 钉钉通讯录同步，确认部门、人员和多部门关系数量合理。
4. 飞书通讯录同步，确认部门、人员数量不为意外的 0/0。
5. 提交考试后管理员收到待阅卷通知。
6. 阅卷完成后考生和管理员收到成绩通知，消息包含考生姓名。
7. 权限拒绝、空目录和网络异常时界面显示平台错误码/短消息，不显示凭证。

## 6. 常见故障判断

| 现象 | 优先检查 |
|---|---|
| OAuth 回调失败 | 回调地址、应用发布状态、客户端 ID/Secret 是否来自同一应用 |
| 钉钉同步失败 | token 字段使用 `appKey/appSecret`、通讯录权限、应用可见范围、`userid/openId` 映射 |
| 飞书同步显示 0/0 | `open_department_id`/`department_id` 类型、根部门查询、通讯录可见范围和人员接口权限 |
| 飞书返回 Bot 未启用 | 开启 Bot 能力并发布应用新版本 |
| 飞书提示缺少 `im:message:*` | 在应用身份权限中开通任一平台要求的发送消息 scope，并重新发布 |
| 钉钉消息不送达 | 消息应用 AppKey/AppSecret、AgentId、unionId 到 userid 查询权限和收件人是否已激活 |
| 前端只显示“请求失败” | 先查 HTTP 状态和服务日志；不要先重启或删除通知/用户数据 |

## 7. 凭证轮换与下线

- 轮换前先确认新凭证已在开放平台生效，再在 Secret 环境中替换，重启服务并分别验收 OAuth、同步和消息。
- 旧凭证失效后再撤销，不要把新旧 Secret 同时提交 Git 或粘贴到聊天。
- 下线应用前先停用对应通知通道和同步任务，保留数据库中的身份、授权和审计记录；不要级联删除业务历史。
