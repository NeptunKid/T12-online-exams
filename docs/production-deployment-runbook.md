# 生产部署固定流程

这份文档用于每次 GitHub PR 合并到 `main` 后，将新版部署到阿里云生产服务器。

除非某次开发说明明确写了不同的前置条件，否则按本流程执行即可。所有命令都在**阿里云 Workbench**执行，不是在本机 Mac 终端执行。

服务器软件、端口、防火墙、SSH、备份目录和其他项目占用情况的唯一事实来源是 Codex 根目录的 `/Users/neptun/Documents/Codex/aliyun-server-inventory.md`。常规应用部署不自动修改这些配置；涉及服务器配置时，先更新总账并单独记录回滚方式。

## 先记住三件事

1. 代码仓库 `/opt/t12-online-exams` 属于 `codexdeploy` 用户。Git 和 npm 命令必须以 `codexdeploy` 身份运行，否则会出现 `.git/FETCH_HEAD: Permission denied`。
2. 每次部署前都创建一个 PostgreSQL 完整备份。即使本次只是改界面，也可能有用户在新版本运行后产生新的业务数据；备份是出现严重问题时的恢复点。
3. 数据库迁移命令可以每次都运行。它会自动跳过已经执行过的迁移，不需要人工判断本次有没有迁移。

## 使用时机

在 GitHub 页面确认 PR 已经合并到 `main` 后开始。不要部署尚未合并的分支，也不要直接在服务器修改代码。

## 第 1 步：进入生产目录并确认本次版本

执行位置：**阿里云 Workbench**。

```bash
cd /opt/t12-online-exams

# 从 GitHub 获取 main 的最新提交信息；这里必须使用代码目录的所有者 codexdeploy。
sudo -u codexdeploy -H git fetch origin main

# 显示本次将要部署的短 SHA，例如 06998ef。请记下它，后面的备份文件名会使用它。
sudo -u codexdeploy -H git rev-parse --short origin/main
```

预期结果：最后一行是 7 位左右的提交号，例如 `06998ef`。如果 `git fetch` 报权限错误，确认命令中包含 `sudo -u codexdeploy -H`，不要改 `.git` 目录权限。

## 第 2 步：创建数据库完整备份

执行位置：**阿里云 Workbench**。

下面会自动读取第 1 步已经获取的远程 `main` SHA，不需要手工替换版本号。整段一次粘贴执行即可。

```bash
# 自动读取本次准备部署的版本，例如 06998ef，并显示出来供核对。
DEPLOY_SHA="$(sudo -u codexdeploy -H git rev-parse --short origin/main)"
echo "准备部署版本：$DEPLOY_SHA"

# 备份文件名包含版本和时间，避免覆盖以前的备份。
BACKUP_FILE="/var/backups/t12-online-exams/postgres/t12_exams-before-${DEPLOY_SHA}-$(date +%Y%m%d%H%M%S).dump"

# 将全部 PostgreSQL 数据导出为可恢复的压缩备份文件。
sudo -u postgres pg_dump -Fc -f "$BACKUP_FILE" t12_exams

# 检查备份文件确实存在且不是空文件。
sudo test -s "$BACKUP_FILE"

# 显示文件大小，正常情况下会看到一行以 -rw 开头的信息。
sudo ls -lh "$BACKUP_FILE"

# 生成文件指纹。把这一行保存到部署记录中，未来可用于确认备份没有损坏。
sudo sha256sum "$BACKUP_FILE"
```

预期结果：先看到“准备部署版本”和第 1 步相同；`ls` 能显示备份文件，`sha256sum` 输出一串很长的字符和文件路径。任何一条失败都应停止，不要继续部署，并保留错误信息。

说明：备份目录由 `postgres` 管理，所以用普通 `admin` 用户直接 `ls` 或 `sha256sum` 可能显示权限不足。上面的 `sudo` 已处理此问题。

## 第 3 步：拉取代码并安装依赖

执行位置：**阿里云 Workbench**。

```bash
cd /opt/t12-online-exams

# 切换到生产分支 main。不会删除数据库或答卷。
sudo -u codexdeploy -H git switch main

# 只允许快进更新，避免服务器意外产生合并提交。
sudo -u codexdeploy -H git pull --ff-only origin main

# 按 package-lock.json 安装本版本依赖；使用 codexdeploy 可避免 node_modules 权限混乱。
sudo -u codexdeploy -H npm ci --omit=dev

# 再次确认服务器当前代码就是第 1 步确认的 SHA。
sudo -u codexdeploy -H git rev-parse --short HEAD

# 自动比较当前代码和准备部署的版本；显示“版本一致”才可以继续。
test "$(sudo -u codexdeploy -H git rev-parse --short HEAD)" = "$DEPLOY_SHA" && echo "版本一致"
```

预期结果：最后显示 `版本一致`。若没有显示，停止并记录两个 SHA，不要迁移或重启服务。

## 第 4 步：执行数据库迁移并重启服务

执行位置：**阿里云 Workbench**。

```bash
# 迁移读取服务器上的保密环境文件；已执行的迁移会自动跳过。
sudo env T12_ENV_FILE=/etc/t12-online-exams/t12-online-exams.env \
  /usr/bin/npm run migrate

# 让 Node.js 服务加载新代码。短暂启动窗口内本机健康检查可能尚未可用。
sudo systemctl restart t12-exams
```

预期结果：迁移不报错，重启命令没有输出错误。若迁移失败，不要重启或继续尝试其他命令，把完整错误信息发回开发侧。

## 第 5 步：确认服务、数据库和公网入口

执行位置：**阿里云 Workbench**。

```bash
# 查看 systemd 服务是否正在运行。
sudo systemctl is-active t12-exams

# 最多等待约 20 秒，直到应用和数据库都准备完成。
for i in {1..20}; do
  curl -fsS http://127.0.0.1:3001/readyz && echo && break
  sleep 1
done

# 从公网验证服务本身是否健康，确认反向代理链路也正常。
curl -fsS https://exam.t12group.com/healthz && echo

# 最后再确认正在运行的代码版本。
cd /opt/t12-online-exams
sudo -u codexdeploy -H git rev-parse --short HEAD
```

预期结果：依次应看到：

```text
active
{"status":"ready","database":"ok"}
{"status":"ok","service":"t12-online-exams"}
<第 1 步确认的 SHA>
```

如果第一秒 `readyz` 连接失败，不一定是故障，循环会继续等待。若 20 秒后仍没有 `ready`，停止并执行下面的只读诊断：

```bash
sudo systemctl status --no-pager -l t12-exams
sudo journalctl -u t12-exams -n 100 --no-pager
```

不要把环境文件、数据库密码、OAuth 凭证或完整答卷内容复制到聊天记录。

## 第 6 步：功能验收和部署记录

执行位置：**浏览器和阿里云 Workbench**。

1. 按本次 PR 的验收项在电脑或手机真实操作一次。
2. 记录部署 SHA、备份绝对路径、SHA-256 指纹、`readyz` 结果和验收结果。
3. 只有全部验收通过，才把本次部署视为完成。

对于纯界面修复，至少确认页面显示的是新版本，而不是浏览器旧缓存。对于登录、交卷、阅卷、导入、身份合并等涉及写入的功能，必须按本次变更说明的边界执行真实验收。

## 发生问题时怎么处理

### 代码问题，但没有错误业务写入

先停止继续操作，记录正在运行的 SHA 和错误。通常可将 `main` 回退到上一份已验证提交后，按本流程再次部署并重启。不要直接删除数据库表或答卷。

### 已发生错误的数据库写入、迁移或身份合并

不要只回退代码，因为代码回退不会自动撤销数据库变化。停止相关写入，保留本次 `pg_dump` 文件；恢复必须先在隔离环境验证备份，再决定恢复范围。将备份路径、SHA、错误时间和发生的操作提供给开发侧。

### Git 权限错误

看到 `.git/FETCH_HEAD: Permission denied`、`dubious ownership` 或 `node_modules` 权限错误时，不要用 `admin` 直接运行 Git/npm，也不要 `chown -R`。重新使用：

```bash
sudo -u codexdeploy -H git <命令>
sudo -u codexdeploy -H npm <命令>
```

## 不属于每次常规部署的操作

以下操作风险更高，不能只套用本文流程；必须先遵循对应功能文档和本次开发说明：数据库恢复、题库/试卷导入、生产题库修复、身份合并、环境变量修改、Caddy 或 systemd 配置修改。

## 页面长时间载入时的诊断

本项目当前默认使用 `DB_STATEMENT_TIMEOUT_MS=15000`，限制单条 PostgreSQL 查询最长执行 15 秒。它不是迁移，也不会删除或修改数据。若需要调整，执行位置是**阿里云 Workbench**：在 `/etc/t12-online-exams/t12-online-exams.env` 中修改该变量后重启 `t12-exams`，并重新检查 `/readyz`。允许范围为 1000 至 120000 毫秒。

管理员用户列表、通知统计和考生首页现在也有 15 秒浏览器端超时。遇到 524 或无限载入时，先执行交接文档中的只读 `journalctl`、`pg_stat_activity` 和通知状态查询；不要先清理通知、重置数据库或反复重启。只有确认查询阻塞或服务异常后，才按本手册的备份、部署或回滚流程操作。
