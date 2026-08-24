# 阿里云服务器工具与配置总账

最后更新：2026-08-24（根据 T12 项目仓库、生产部署记录和用户提供的 Workbench 输出整理；实际版本与共享组件待现场盘点）

> 这份文档是公司共享阿里云服务器的配置总账。Codex 根目录中的同名文件是共享副本的目标位置。以后任何 Agent 修改服务器软件、服务、端口、环境文件、备份策略、防火墙或域名入口，都必须先更新本账，再执行变更或在变更完成后立即追加记录。

## 0. 证据边界

- “已确认”表示有仓库部署文件、生产记录或用户 Workbench 输出支持。
- “未确认”表示当前仓库没有证据，必须在阿里云 Workbench 现场查询后才能写成已安装/已启用。
- 本文不保存任何 OAuth Secret、数据库密码、飞书/钉钉 App Secret、员工身份标识或答卷内容；只记录变量名、路径和权限边界。

## 1. 主机与公网入口

| 项目 | 当前记录 |
|---|---|
| 云平台 | 阿里云轻量应用服务器 |
| 区域 | 东京 |
| 操作系统 | Ubuntu 24.04 |
| 规格 | 2 vCPU、1 GiB RAM、30 GiB 系统盘 |
| 公网 IPv4 | `8.211.178.187`（需 Workbench/阿里云控制台复核） |
| 公网域名 | `https://exam.t12group.com/` |
| DNS/代理 | Cloudflare DNS，可选代理/WAF；当前不是 Cloudflare Tunnel |
| 源站入口 | Caddy 监听公网 80/443，自动申请/续期 HTTPS 证书 |
| 应用入口 | Caddy 反向代理到 `127.0.0.1:3001` |
| 数据库入口 | PostgreSQL 只监听 `127.0.0.1:5432` |

Cloudflare 当前配置记录：`exam.t12group.com` A 记录指向 `8.211.178.187`，SSL/TLS 使用 `Full (strict)`；旧 Tunnel 路由已移除。公网安全组/防火墙应只开放 80、443 和已有 SSH/Workbench 管理规则，不开放 3001、5432。

## 2. 已确认安装并使用的工具

### 2.1 PostgreSQL

- 版本：PostgreSQL 16（仓库配置和生产记录确认）。
- systemd 依赖：`postgresql.service`；`t12-exams.service` 使用 `After=postgresql.service` 和 `Requires=postgresql.service`。
- 监听：`127.0.0.1:5432`，不对公网开放。
- 数据库：`t12_exams`；应用数据库用户：`t12_app`。
- 连接变量名：`DB_CLIENT`、`DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_USER`、`DB_PASSWORD`、`DB_SSL`。
- 迁移入口：`npm run migrate`；计划检查：`npm run migrate:plan`。
- 最新已知迁移：`0012_organization_directory`，已由用户在生产查询确认存在。
- 生产原则：任何数据库写入/迁移前先 `pg_dump -Fc`；记录备份绝对路径、文件大小和 SHA-256。

### 2.2 Node.js / npm

- 运行方式：`/usr/bin/node /opt/t12-online-exams/server.js`。
- 版本要求：`package.json` 声明 Node.js `>=18`；实际版本必须由 Workbench 查询确认。
- 应用目录：`/opt/t12-online-exams`，所有者应为 `codexdeploy:codexdeploy`。
- 依赖安装：以 `codexdeploy` 执行 `npm ci --omit=dev`，禁止使用 `admin` 直接改写 `node_modules`。
- 生产服务不从 `/tmp` 或本机目录启动。

### 2.3 Caddy

- 已安装并作为公网反向代理使用；当前不使用 Nginx。
- 配置文件：仓库 `deploy/Caddyfile`，生产 `/etc/caddy/Caddyfile`。
- 服务：`caddy.service`，通过 systemd 启用/重载。
- 配置行为：`exam.t12group.com`、gzip、JSON 访问日志到 journald、安全响应头、`reverse_proxy 127.0.0.1:3001`。
- 校验/重载：`sudo caddy validate --config /etc/caddy/Caddyfile`，然后 `sudo systemctl reload caddy`。

### 2.4 systemd

- 应用服务：`t12-exams.service`。
- 服务用户/组：`codexdeploy`；工作目录：`/opt/t12-online-exams`。
- 环境文件：`/etc/t12-online-exams/t12-online-exams.env`。
- 自动重启：`Restart=on-failure`、`RestartSec=5`。
- 加固：`NoNewPrivileges=true`、`PrivateTmp=true`、`ProtectHome=true`、`ProtectSystem=strict`、`UMask=0077`。
- 可写路径：应用 data 目录和 `/var/backups/t12-online-exams/portable`。
- 通知 Worker 当前嵌入 Node 服务，是否运行由环境变量控制，不是独立 systemd 服务。

## 3. 已完成的应用配置

### 3.1 环境文件

生产环境文件：`/etc/t12-online-exams/t12-online-exams.env`。

要求：目录 `root:codexdeploy`、权限 750；文件 `root:codexdeploy`、权限 640。只允许记录变量名，不复制值。

已知变量组：

- 基础：`NODE_ENV`、`HOST=127.0.0.1`、`PORT=3001`。
- 钉钉 OAuth：`DINGTALK_CLIENT_ID`、`DINGTALK_CLIENT_SECRET`、`DINGTALK_REDIRECT_URI`、`DINGTALK_GRADER_UNION_IDS`。
- 飞书 OAuth/文档：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_REDIRECT_URI`、`FEISHU_DOCUMENT_ID`。
- PostgreSQL：`DB_CLIENT=postgres`、`DB_HOST=127.0.0.1`、`DB_PORT=5432`、`DB_NAME=t12_exams`、`DB_USER=t12_app`、`DB_PASSWORD`、`DB_SSL=false`。
- 自动备份：`T12_AUTO_BACKUP_ENABLED`、`T12_AUTO_BACKUP_STORAGE`、`T12_AUTO_BACKUP_INTERVAL_HOURS`、`T12_AUTO_BACKUP_RETENTION`、`T12_AUTO_BACKUP_START_DELAY_SECONDS`、`T12_AUTO_BACKUP_DIR`。
- 通知 Worker：`T12_NOTIFICATION_WORKER_ENABLED`、`T12_NOTIFICATION_CHANNELS`、`T12_NOTIFICATION_INTERVAL_SECONDS`、`T12_NOTIFICATION_START_DELAY_SECONDS`、`T12_NOTIFICATION_BATCH_SIZE`、`T12_NOTIFICATION_MAX_ATTEMPTS`、`T12_NOTIFICATION_RETRY_BASE_SECONDS`、`T12_NOTIFICATION_STALE_AFTER_SECONDS`、`T12_PUBLIC_BASE_URL`、`T12_NOTIFICATION_NOT_BEFORE`。
- 钉钉消息 transport：`T12_DINGTALK_MESSAGE_APP_KEY`、`T12_DINGTALK_MESSAGE_APP_SECRET`、`T12_DINGTALK_MESSAGE_AGENT_ID`。

### 3.2 备份目录与权限

- 灾难恢复 PostgreSQL dump：`/var/backups/t12-online-exams/postgres/`，应由 `postgres:postgres` 管理，通常权限 0700。
- 应用逻辑备份工件：`/var/backups/t12-online-exams/portable/`，由 `codexdeploy` 使用，通常权限 0700。
- 父目录：`/var/backups/t12-online-exams` 必须允许两个服务账号穿越，当前修正原则为 `root:root`、权限 0711；不要把父目录改回 `postgres:postgres 0750`。
- 自动备份默认可关闭；启用前必须确认目录、容量、保留策略和恢复路径。

## 4. 明确未采用或尚未确认的工具

| 工具/能力 | 当前结论 | 说明 |
|---|---|---|
| Nginx | 未采用 | 当前公网反向代理是 Caddy；不要在没有端口规划的情况下安装或启用 Nginx。 |
| Redis | 未确认/仓库未发现 | 当前会话、通知 Worker 和锁使用 Node/PostgreSQL；未发现 Redis 配置或依赖。需 Workbench 实测后才能确认系统是否另有其他项目使用。 |
| 阿里云 OSS | 未确认/当前 T12 未使用 | T12 图片和备份使用 PostgreSQL 或受控服务器目录；未发现 OSS bucket、AK/SK 或 ossutil 配置。其他项目如需 OSS，必须单独记录 bucket、地域、权限和生命周期，禁止写入本账的 Secret。 |
| Docker/Podman | 未确认/仓库未使用 | 当前采用 systemd + 原生 Node + PostgreSQL + Caddy。 |
| Cloudflare Tunnel | 已明确不使用 | 当前采用阿里云公网 80/443 + Caddy。 |
| 独立通知 Worker 服务 | 未采用 | Worker 嵌入 Node，环境变量关闭/启用。 |
| MySQL/MongoDB | 仓库未发现 | T12 数据库为 PostgreSQL。其他项目需自行确认。 |

## 5. Workbench 现场盘点命令

以下命令只读，不显示 Secret 值。执行位置：阿里云 Workbench。输出应保存到服务器运维记录，但不要把环境文件内容复制到聊天。

```bash
# 操作系统、内核、CPU、内存、磁盘
hostnamectl
uname -a
nproc
free -h
df -hT

# 关键工具版本
node --version
npm --version
psql --version
sudo -u postgres psql -d t12_exams -Atc 'SELECT version();'
caddy version

# 关键服务状态
sudo systemctl is-active postgresql caddy t12-exams
sudo systemctl is-enabled postgresql caddy t12-exams
sudo systemctl status --no-pager -l postgresql caddy t12-exams

# 监听端口；预期公网 80/443、Node 127.0.0.1:3001、PostgreSQL 127.0.0.1:5432
sudo ss -ltnp

# 检查 Nginx、Redis、OSS 客户端是否存在，不安装、不启动
command -v nginx || true
command -v redis-server || true
command -v ossutil || true
systemctl list-unit-files | grep -Ei 'nginx|redis|oss' || true

# 防火墙/安全规则（只读）
sudo ufw status verbose 2>/dev/null || true
sudo nft list ruleset 2>/dev/null | head -200 || true

# 关键目录所有权和权限，不展开环境文件
stat -c '%A %U:%G %n' /opt/t12-online-exams /etc/t12-online-exams /etc/t12-online-exams/t12-online-exams.env /var/backups/t12-online-exams /var/backups/t12-online-exams/postgres /var/backups/t12-online-exams/portable

# 迁移状态
sudo -u postgres psql -d t12_exams -P pager=off -c 'SELECT version, name FROM schema_migrations ORDER BY version;'

# 近期开机服务日志（不包含环境文件）
sudo journalctl -u t12-exams -u caddy -u postgresql -n 100 --no-pager
```

## 6. 共享服务器新增项目接入规则

其他 Agent 在同一服务器部署项目时必须：

1. 先在本账新增项目条目，写明项目名、Git 仓库、运行用户、工作目录、监听地址/端口、systemd 服务、数据库、域名和负责人。
2. 不占用 `80/443/3001/5432`；新项目使用独立本机端口、独立 systemd 服务、独立环境文件、独立数据库/用户和独立备份目录。
3. 不复用 T12 的 `t12_exams`、`t12_app`、`/etc/t12-online-exams/t12-online-exams.env` 或 data/备份目录；跨项目共享必须经过明确授权并记录原因。
4. 若使用 Caddy，新增独立域名块并先 `caddy validate`，再 reload；不要安装 Nginx 与 Caddy 争抢 80/443。
5. 生产写入前备份对应项目数据库；记录变更前后服务状态、健康检查、磁盘容量和回滚方式。
6. 不把任何 Secret、云存储 AK/SK、数据库密码或完整环境文件提交 Git、写入共享文档或粘贴到聊天。

## 7. 服务器配置变更记录

以后每次更新本账，在这里追加一行，并在同一提交/变更单中记录完整细节：

| 日期 | 项目/服务 | 变更 | 执行位置 | 备份/校验 | 回滚 |
|---|---|---|---|---|---|
| 2026-08-24 | T12 / 共享服务器 | 首次建立服务器工具与配置总账；根据仓库和生产记录登记 Caddy、Node.js、PostgreSQL、systemd、Cloudflare、备份目录及未确认组件 | 本机整理；Workbench 盘点命令待执行 | 未修改生产；待 Workbench 现场盘点 | 无生产变更 |

## 8. 文档维护流程

- 配置变更前：先更新“计划变更”或确认影响端口/服务/数据目录，必要时先做备份。
- 配置变更后：执行本账第 5 节相关只读命令，将实际版本、服务状态、端口和权限写入变更记录。
- 每次 PR/部署摘要必须引用本账变更日期；如果没有服务器变化，明确写“无服务器配置变化”。
- 发现本文与服务器实际不一致时，以 Workbench 现场输出为准，先标记“待核对”，再修正文档；禁止凭猜测覆盖记录。

## 9. 待补充的共享服务器信息

本账目前只包含 T12 项目已经能证明的配置。要让其他项目 Agent 复用服务器，还需要一次不改动生产的 Workbench 盘点，补充以下事实：

- Node.js、npm、PostgreSQL、Caddy 的实际版本；
- Redis、Nginx、`ossutil`、Docker/Podman 是否安装，以及是否被其他项目使用；
- 实际监听端口、UFW/nftables 规则和云安全组中已开放的管理端口；
- `codexdeploy`、`postgres`、Caddy 的服务状态和关键目录实际权限；
- 服务器上其他公司的项目、工作目录、systemd 服务、端口、域名、数据库和备份位置。

盘点结果只能由执行命令的 Agent 或用户根据 Workbench 输出填写。未确认项不得改写为“已安装”或“未安装”。
