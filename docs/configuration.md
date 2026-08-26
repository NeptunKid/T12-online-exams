# 配置说明

## 本地运行

复制 `.env.example` 为项目根目录的 `.env`，再填写本地或测试环境值。`.env` 已被 Git 忽略，不能提交。

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3001
DINGTALK_CLIENT_ID=
DINGTALK_CLIENT_SECRET=
DINGTALK_REDIRECT_URI=https://exam.t12group.com/auth/dingtalk/callback
DINGTALK_GRADER_UNION_IDS=
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_REDIRECT_URI=https://exam.t12group.com/auth/feishu/callback
FEISHU_DOCUMENT_ID=
DB_CLIENT=postgres
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=t12_exams
DB_USER=t12_app
DB_PASSWORD=
DB_SSL=false
T12_NOTIFICATION_WORKER_ENABLED=false
T12_NOTIFICATION_CHANNELS=feishu
T12_DINGTALK_MESSAGE_APP_KEY=
T12_DINGTALK_MESSAGE_APP_SECRET=
T12_DINGTALK_MESSAGE_AGENT_ID=
T12_NOTIFICATION_INTERVAL_SECONDS=30
T12_NOTIFICATION_START_DELAY_SECONDS=15
T12_NOTIFICATION_BATCH_SIZE=10
T12_NOTIFICATION_MAX_ATTEMPTS=5
T12_NOTIFICATION_RETRY_BASE_SECONDS=60
T12_NOTIFICATION_STALE_AFTER_SECONDS=300
T12_NOTIFICATION_PENDING_ALERT_THRESHOLD=25
T12_NOTIFICATION_FAILED_ALERT_THRESHOLD=0
T12_NOTIFICATION_ABANDONED_ALERT_THRESHOLD=0
T12_PUBLIC_BASE_URL=https://exam.t12group.com
T12_NOTIFICATION_NOT_BEFORE=
```

飞书登录回调地址为 `https://exam.t12group.com/auth/feishu/callback`。飞书应用需要启用网页 OAuth 登录，并将该地址添加到应用的重定向 URL；服务器域名白名单按飞书开放平台页面要求填写 `exam.t12group.com`。登录接口必须返回员工真实姓名 `name`，系统不会用飞书昵称或英文昵称自动合并身份。

钉钉登录会优先使用 OAuth 用户信息中的真实姓名；如果该接口只返回 `nick`，服务会通过企业通讯录用户接口补取真实姓名。若登录提示“未能读取钉钉通讯录真实姓名”，请在钉钉开放平台为应用开启对应的通讯录/用户只读权限，再重新登录。系统只保存真实姓名，不把平台昵称写入用户显示名。

真实凭证只允许出现在本地 `.env`、部署 Secret 或 GitHub Actions Secret。不要写入 README、测试样例、日志或开发总结。

## 通知 Worker

通知 Worker 默认关闭。部署包含通知发送代码后，先保持 `T12_NOTIFICATION_WORKER_ENABLED=false` 执行迁移和后台列表验收；确认飞书应用已启用机器人/应用消息能力并具备发送消息权限后，再改为 `true` 并重启服务。

当前发送通道支持 `feishu` 和 `dingtalk`。钉钉使用消息应用的 AppKey/AppSecret/AgentId，并在发送时将新任务中的 unionId 解析为工作通知所需的 userid；这些凭证与钉钉 OAuth 登录凭证分开。旧的钉钉 pending 任务可能保留旧收件人标识，启用前必须先对账。Worker 使用 PostgreSQL 锁避免多实例重复发送，失败按指数退避重试，超过上限后进入“已放弃”，系统管理员可在后台人工重发。

通知页会根据队列只读统计显示监控状态。`T12_NOTIFICATION_PENDING_ALERT_THRESHOLD` 默认是 25，`T12_NOTIFICATION_FAILED_ALERT_THRESHOLD` 和 `T12_NOTIFICATION_ABANDONED_ALERT_THRESHOLD` 默认是 0，分别表示超过这些数量就告警；发送中任务超过 `T12_NOTIFICATION_STALE_AFTER_SECONDS` 也会告警。阈值只影响后台监控提示，不会暂停、删除或改变通知任务，也不会把通知服务异常判定为数据库未就绪。

`T12_PUBLIC_BASE_URL` 必须是无凭证、查询参数和片段的 HTTPS 地址。`T12_NOTIFICATION_NOT_BEFORE` 必须在首次启用时设置为带时区的 ISO 时间；早于该时间的历史 pending 任务只保留审计，不会突然补发。通知只包含考试名、考生显示名或成绩摘要和站内链接，不包含标准答案、题目解析或完整作答。

## 首位管理员

`DINGTALK_GRADER_UNION_IDS` 是首位管理员的安全引导名单。首次部署时，将负责人的钉钉 `unionId` 填入该变量并重启服务；该账号下一次登录时会被登记到 PostgreSQL，并获得 `system_admin` 与 `grader` 角色。之后可在管理员后台的“管理员”窗口授予或撤销其他已登录用户的权限，无需继续修改环境变量。

当前登录用户可通过 `https://exam.t12group.com/api/auth/me` 查看自己的 `unionId`。该值属于员工身份数据，只能写入服务器环境文件，不能提交到 Git、开发总结或公开聊天记录。

## GitHub Actions

在仓库 `Settings -> Secrets and variables -> Actions` 中配置：

```text
FEISHU_APP_ID
FEISHU_APP_SECRET
FEISHU_DOCUMENT_ID
```

回调地址和数据库连接等非秘密配置可使用 Actions Variables 或部署环境变量。当前测试服务器在云端主机内运行 PostgreSQL 16，数据库只监听本机回环地址；`DB_PASSWORD` 只能放在部署环境变量或 `.env`，备份不得提交到 Git。
