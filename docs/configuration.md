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
```

飞书登录回调地址为 `https://exam.t12group.com/auth/feishu/callback`。飞书应用需要启用网页 OAuth 登录，并将该地址添加到应用的重定向 URL；服务器域名白名单按飞书开放平台页面要求填写 `exam.t12group.com`。登录接口必须返回员工真实姓名 `name`，系统不会用飞书昵称或英文昵称自动合并身份。

钉钉登录会优先使用 OAuth 用户信息中的真实姓名；如果该接口只返回 `nick`，服务会通过企业通讯录用户接口补取真实姓名。若登录提示“未能读取钉钉通讯录真实姓名”，请在钉钉开放平台为应用开启对应的通讯录/用户只读权限，再重新登录。系统只保存真实姓名，不把平台昵称写入用户显示名。

真实凭证只允许出现在本地 `.env`、部署 Secret 或 GitHub Actions Secret。不要写入 README、测试样例、日志或开发总结。

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
