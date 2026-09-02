#!/usr/bin/env bash
set -Eeuo pipefail

# T12 production deployment entrypoint.
# Run on the production host as an operator with sudo access:
#   sudo /opt/t12-online-exams/scripts/deploy-production.sh

ROOT="/opt/t12-online-exams"
DEPLOY_USER="codexdeploy"
ENV_FILE="/etc/t12-online-exams/t12-online-exams.env"
DATABASE="t12_exams"
BACKUP_DIR="/var/backups/t12-online-exams/postgres"
SERVICE="t12-exams"
PUBLIC_HEALTH_URL="https://exam.t12group.com/healthz"
LOCAL_READY_URL="http://127.0.0.1:3001/readyz"

die() { echo "部署失败：$*" >&2; exit 1; }
as_deploy() { sudo -u "$DEPLOY_USER" -H "$@"; }

[[ -d "$ROOT/.git" ]] || die "生产代码目录不存在：$ROOT"
[[ -f "$ROOT/package.json" ]] || die "生产代码目录缺少 package.json"
[[ -f "$ENV_FILE" ]] || die "生产环境文件不存在：$ENV_FILE"
id "$DEPLOY_USER" >/dev/null 2>&1 || die "系统用户不存在：$DEPLOY_USER"

owner="$(stat -c '%U' "$ROOT/.git")"
[[ "$owner" == "$DEPLOY_USER" ]] || die "$ROOT/.git 所有者应为 $DEPLOY_USER，实际为 $owner"

cd "$ROOT"
[[ -z "$(as_deploy git -C "$ROOT" status --porcelain)" ]] || die "生产代码目录存在未提交修改，已停止以保护现场"

echo "[1/7] 获取 origin/main"
as_deploy git -C "$ROOT" fetch --prune origin main
target_sha="$(as_deploy git -C "$ROOT" rev-parse origin/main)"
short_sha="$(as_deploy git -C "$ROOT" rev-parse --short "$target_sha")"
echo "目标版本：$short_sha"

echo "[2/7] 创建并校验 PostgreSQL 备份"
sudo install -d -m 700 -o postgres -g postgres "$BACKUP_DIR"
timestamp="$(date +%Y%m%d%H%M%S)"
backup_file="$BACKUP_DIR/t12_exams-before-${short_sha}-${timestamp}.dump"
sudo -u postgres pg_dump -Fc -f "$backup_file" "$DATABASE"
sudo test -s "$backup_file" || die "PostgreSQL 备份为空"
backup_size="$(sudo stat -c '%s' "$backup_file")"
backup_sha="$(sudo sha256sum "$backup_file" | awk '{print $1}')"
sudo -u postgres pg_restore -l "$backup_file" >/dev/null || die "PostgreSQL 备份格式校验失败"
echo "备份文件：$backup_file"
echo "备份大小：$backup_size bytes"
echo "备份 SHA-256：$backup_sha"

echo "[3/7] 快进更新到 main"
as_deploy git -C "$ROOT" switch main
as_deploy git -C "$ROOT" pull --ff-only origin main
actual_sha="$(as_deploy git -C "$ROOT" rev-parse HEAD)"
[[ "$actual_sha" == "$target_sha" ]] || die "代码版本不一致：目标 $target_sha，实际 $actual_sha"

echo "[4/7] 安装生产依赖"
as_deploy npm --prefix "$ROOT" ci --omit=dev

echo "[5/7] 执行数据库迁移"
sudo env T12_ENV_FILE="$ENV_FILE" /usr/bin/npm --prefix "$ROOT" run migrate

echo "[6/7] 重启应用并等待就绪"
sudo systemctl restart "$SERVICE"
for _ in $(seq 1 20); do
  if sudo systemctl is-active --quiet "$SERVICE" && curl -fsS --max-time 5 "$LOCAL_READY_URL" >/tmp/t12-ready.json; then
    break
  fi
  sleep 1
done
sudo systemctl is-active --quiet "$SERVICE" || die "$SERVICE 未处于 active 状态"
grep -q '"status":"ready"' /tmp/t12-ready.json || die "本机 readyz 未返回 ready"

echo "[7/7] 验证公网入口和最终版本"
public_health="$(curl -fsS --max-time 10 "$PUBLIC_HEALTH_URL")" || die "公网 healthz 检查失败"
grep -q '"status":"ok"' <<<"$public_health" || die "公网 healthz 返回异常：$public_health"
echo "运行版本：$(as_deploy git -C "$ROOT" rev-parse --short HEAD)"
echo "本机 readyz：$(cat /tmp/t12-ready.json)"
echo "公网 healthz：$public_health"
echo "部署完成。请保留备份路径、大小和 SHA-256，并按本次变更说明进行浏览器验收。"
