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

如果执行 `install .../deploy/...: No such file or directory`，说明 `/opt` 目录不是最新仓库。请在**阿里云 Workbench**先执行：

```bash
sudo test -f /opt/t12-online-exams/deploy/Caddyfile && echo "部署文件已存在" || echo "请先按上面的首次部署命令重新 clone"
```

不要从 `/tmp/t12-online-exams` 直接启动生产服务；`/tmp` 只用于临时拉取代码，systemd 固定使用 `/opt/t12-online-exams`。

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
T12_NOTIFICATION_WORKER_ENABLED=false
T12_NOTIFICATION_CHANNELS=feishu
T12_NOTIFICATION_INTERVAL_SECONDS=30
T12_NOTIFICATION_START_DELAY_SECONDS=15
T12_NOTIFICATION_BATCH_SIZE=10
T12_NOTIFICATION_MAX_ATTEMPTS=5
T12_NOTIFICATION_RETRY_BASE_SECONDS=60
T12_NOTIFICATION_STALE_AFTER_SECONDS=300
T12_PUBLIC_BASE_URL=https://exam.t12group.com
T12_NOTIFICATION_NOT_BEFORE=
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
sudo install -d -o codexdeploy -g codexdeploy -m 750 /opt/t12-online-exams/data
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

预期：Caddy 为 `exam.t12group.com` 申请证书，并将 HTTPS 请求反代至 Node。访问日志写入 systemd journal，不再依赖 `/var/log/caddy` 文件权限。若 Cloudflare 使用橙色云，证书申请仍需确保阿里云安全组和服务器防火墙允许 `80/443`。

如果 `caddy validate` 成功但 `systemctl enable --now caddy` 失败，请先在**阿里云 Workbench**执行只读诊断，不要重复启动：

```bash
sudo systemctl status --no-pager -l caddy
sudo journalctl -u caddy -n 80 --no-pager
sudo ss -ltnp | grep -E ':(80|443)\\b' || true
```

重点查看是否出现 `address already in use`（端口被占用）或 `permission denied`（日志目录权限不足）。

如果日志仍提示 `server is listening only on the HTTP port`，请检查：

```bash
sudo sed -n '1,80p' /etc/caddy/Caddyfile
```

第一行必须是 `exam.t12group.com {`，不能是旧的 `:80 {` 或空白占位配置。

## 7. 验证

执行位置：本机终端（不要在服务器上验证域名回环）。

```bash
curl -I https://exam.t12group.com/
curl -fsS https://exam.t12group.com/healthz
curl -fsS https://exam.t12group.com/readyz
```

预期：首页返回 `200` 或登录跳转；`/healthz` 返回 `{"status":"ok"...}`；`/readyz` 返回 `{"status":"ready","database":"ok"}`。随后使用手机蜂窝网络实际完成钉钉登录、考试读取和交卷验证。

## 8. 双平台用户与历史身份整理

执行位置：阿里云 Workbench。以下步骤用于本次跨平台身份版本首次上线；代码更新和 `0006` 迁移完成后再执行。

```bash
sudo install -d -m 711 -o root -g root /var/backups/t12-online-exams
sudo install -d -m 700 -o postgres -g postgres /var/backups/t12-online-exams/postgres
T12_BACKUP_FILE="/var/backups/t12-online-exams/postgres/t12_exams-before-cross-platform-$(date +%Y%m%d%H%M%S).dump"
sudo -u postgres pg_dump -Fc -f "$T12_BACKUP_FILE" t12_exams
sudo -u postgres test -s "$T12_BACKUP_FILE" && echo "数据库备份完成：$T12_BACKUP_FILE"

sudo env T12_ENV_FILE=/etc/t12-online-exams/t12-online-exams.env \
  /usr/bin/node /opt/t12-online-exams/scripts/migrate.js
```

迁移成功后重启服务。每名员工至少分别用钉钉、飞书登录一次：钉钉登录会更新其真实姓名，飞书登录会使用相同真实姓名寻找唯一的钉钉/历史用户并绑定；同名候选超过一个时会拒绝自动绑定，不会猜测。

如果飞书身份在旧版本已经单独登记，或历史钉钉显示名尚未更新，请先完成两平台登录，再在**阿里云 Workbench**执行默认 dry-run：

```bash
sudo env T12_ENV_FILE=/etc/t12-online-exams/t12-online-exams.env \
  /usr/bin/node /opt/t12-online-exams/scripts/reconcile-cross-platform-users.js
```

确认输出中 `ambiguous` 为空、`merges` 仅包含正确员工后，才允许显式执行：

```bash
sudo env T12_ENV_FILE=/etc/t12-online-exams/t12-online-exams.env \
  /usr/bin/node /opt/t12-online-exams/scripts/reconcile-cross-platform-users.js --apply
sudo systemctl restart t12-exams
```

合并会保留答卷快照、分数和逐题成绩，将身份、角色、个人授权、补考次数归并到钉钉用户，并按提交时间重排合并后的考核次数。`--apply` 没有独立 down migration；需要撤销身份合并时必须停止服务并恢复本节开头的 `pg_dump -Fc` 备份，不能只回滚代码。

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
