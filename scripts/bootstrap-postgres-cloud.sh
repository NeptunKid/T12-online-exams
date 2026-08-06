#!/usr/bin/env bash
set -euo pipefail

DB_NAME="${DB_NAME:-t12_exams}"
DB_USER="${DB_USER:-t12_app}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请使用 sudo 运行：sudo bash scripts/bootstrap-postgres-cloud.sh" >&2
  exit 2
fi

read -r -s -p "为 PostgreSQL 账户 ${DB_USER} 设置密码：" DB_PASSWORD
echo
if [[ -z "${DB_PASSWORD}" ]]; then
  echo "数据库密码不能为空" >&2
  exit 2
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y postgresql postgresql-contrib ca-certificates curl git

systemctl enable --now postgresql

PG_VERSION="$(runuser -u postgres -- psql -Atc 'SHOW server_version' | cut -d. -f1)"
PG_CONF_DIR="/etc/postgresql/${PG_VERSION}/main/conf.d"
install -d -m 755 "${PG_CONF_DIR}"
cat > "${PG_CONF_DIR}/t12-low-memory.conf" <<'EOF'
# Conservative settings for the 1 GiB test server.
listen_addresses = '127.0.0.1'
max_connections = 20
shared_buffers = 128MB
work_mem = 2MB
maintenance_work_mem = 32MB
EOF

runuser -u postgres -- psql -v ON_ERROR_STOP=1 \
  -v db_user="${DB_USER}" \
  -v db_password="${DB_PASSWORD}" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'db_user') THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', :'db_user', :'db_password');
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', :'db_user', :'db_password');
  END IF;
END
$$;
SQL

if ! runuser -u postgres -- psql -Atc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -qx 1; then
  runuser -u postgres -- createdb -O "${DB_USER}" "${DB_NAME}"
fi

systemctl restart postgresql
unset DB_PASSWORD

echo "PostgreSQL 已准备完成。"
echo "数据库：${DB_NAME}"
echo "账户：${DB_USER}"
echo "监听：127.0.0.1:5432"
echo "请将密码手工填写到应用部署环境变量，不要提交到 Git。"
