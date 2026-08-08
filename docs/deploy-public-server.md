# 东京阿里云公网部署

本文对应当前架构：

```text
exam.t12group.com -> Cloudflare DNS/代理 -> 阿里云 80/443 -> Caddy -> Node.js 127.0.0.1:3001 -> PostgreSQL 127.0.0.1:5432
```

本方案不使用 Cloudflare Tunnel。Cloudflare 只负责 DNS、可选代理/WAF 和 TLS 模式；源站证书由 Caddy 自动申请和续期。

## 1. 外部控制台操作

执行位置：Cloudflare 控制台。

为 `exam.t12group.com` 建立一条 A 记录，指向 `8.211.178.187`。测试阶段可开启 Proxied（橙色云）；SSL/TLS 模式设为 `Full (strict)`。删除或停用该子域名上旧的 Tunnel 路由，避免同一主机名同时存在两套入口。

执行位置：阿里云控制台 -> 轻量应用服务器 -> 防火墙/安全组。

仅放行 TCP `80`、`443`；保留现有 SSH/Workbench 管理规则；不要放行 `3001` 或 `5432`。如果启用了服务器内置 UFW，也只允许 `80/tcp` 和 `443/tcp`。

## 2. 安装 Caddy

执行位置：阿里云 Workbench，使用 `admin` 登录。

```bash
sudo apt update
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

## 3. 部署应用目录

执行位置：阿里云 Workbench。

首次部署（目标目录不存在时）：

```bash
sudo git clone https://github.com/NeptunKid/T12-online-exams.git /opt/t12-online-exams
sudo chown -R codexdeploy:codexdeploy /opt/t12-online-exams
```

后续更新（目标目录已存在时）：

```bash
sudo -u codexdeploy git -C /opt/t12-online-exams pull --ff-only origin main
```

不要将本机 `.env`、`data/submissions.json` 或备份复制到 Git 工作树。生产答卷已在 PostgreSQL 中，应用目录只保留代码和静态资源。

## 4. 写入生产环境变量

执行位置：阿里云 Workbench。以下命令会打开编辑器，不会在终端回显凭证：

```bash
sudo install -d -o root -g codexdeploy -m 750 /etc/t12-online-exams
sudo nano /etc/t12-online-exams/t12-online-exams.env
```

文件格式如下，`DINGTALK_CLIENT_SECRET`、`DB_PASSWORD` 和飞书 Secret 必须替换为你已保存的真实值：

```dotenv
NODE_ENV=production
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

保存后执行位置仍为阿里云 Workbench：

```bash
sudo chown root:codexdeploy /etc/t12-online-exams/t12-online-exams.env
sudo chmod 640 /etc/t12-online-exams/t12-online-exams.env
```

## 5. 安装并启动 Node 服务

执行位置：阿里云 Workbench。

```bash
sudo -u codexdeploy bash -lc 'cd /opt/t12-online-exams && npm ci --omit=dev'
sudo -u codexdeploy env T12_ENV_FILE=/etc/t12-online-exams/t12-online-exams.env bash -lc 'cd /opt/t12-online-exams && npm run migrate'
sudo install -m 644 /opt/t12-online-exams/deploy/t12-exams.service /etc/systemd/system/t12-exams.service
sudo systemctl daemon-reload
sudo systemctl enable --now t12-exams
sudo systemctl status --no-pager t12-exams
```

预期：状态为 `active (running)`。应用仍只监听 `127.0.0.1:3001`。

如果你已经在 `/tmp/t12-online-exams` 中完成了代码更新，不要从该目录直接复制 `.env`。请先按上面的“部署应用目录”步骤确保 `/opt/t12-online-exams` 是最新代码，再执行迁移命令；迁移命令通过 `T12_ENV_FILE` 读取 `/etc/t12-online-exams/t12-online-exams.env`。

## 6. 安装并启动 Caddy

执行位置：阿里云 Workbench。

```bash
sudo install -m 644 /opt/t12-online-exams/deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
sudo systemctl status --no-pager caddy
```

预期：Caddy 为 `exam.t12group.com` 申请证书，并将 HTTPS 请求反代至 Node。若 Cloudflare 使用橙色云，证书申请仍需确保阿里云安全组和服务器防火墙允许 `80/443`。

## 7. 验证

执行位置：本机终端（不要在服务器上验证域名回环）。

```bash
curl -I https://exam.t12group.com/
curl -fsS https://exam.t12group.com/healthz
curl -fsS https://exam.t12group.com/readyz
```

预期：首页返回 `200` 或登录跳转；`/healthz` 返回 `{"status":"ok"...}`；`/readyz` 返回 `{"status":"ready","database":"ok"}`。随后使用手机蜂窝网络实际完成钉钉登录、考试读取和交卷验证。

## 回滚

执行位置：阿里云 Workbench。

只回滚应用代码时，先记录当前提交，再切换到已验证提交并重启服务：

```bash
sudo -u codexdeploy git -C /opt/t12-online-exams rev-parse HEAD
sudo -u codexdeploy git -C /opt/t12-online-exams checkout <已验证提交SHA>
sudo systemctl restart t12-exams
```

入口异常时先停止 Caddy（Node 和 PostgreSQL 数据不删除），修复或恢复 DNS 后再启动：

```bash
sudo systemctl stop caddy
sudo systemctl restart t12-exams
```

不要删除 PostgreSQL 数据、`.env` 或历史答卷备份；恢复数据库请遵循 [backup-restore.md](backup-restore.md)。
