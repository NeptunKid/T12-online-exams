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

真实凭证只允许出现在本地 `.env`、部署 Secret 或 GitHub Actions Secret。不要写入 README、测试样例、日志或开发总结。

## GitHub Actions

在仓库 `Settings -> Secrets and variables -> Actions` 中配置：

```text
FEISHU_APP_ID
FEISHU_APP_SECRET
FEISHU_DOCUMENT_ID
```

回调地址和数据库连接等非秘密配置可使用 Actions Variables 或部署环境变量。当前测试服务器在云端主机内运行 PostgreSQL 16，数据库只监听本机回环地址；`DB_PASSWORD` 只能放在部署环境变量或 `.env`，备份不得提交到 Git。
