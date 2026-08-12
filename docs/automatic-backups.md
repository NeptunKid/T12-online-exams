# 自动备份与保留

## 范围与边界

自动备份复用 `.t12backup` v1 格式，分别为每个题库和试卷生成一份自包含工件。每次运行保存题目、答案解析、组卷分值和图片正文，不读取或改写 `submissions`、`submission_questions`、历史快照及成绩。

数据库存储适合恢复误删或误改后的题库/试卷定义，但它与业务数据处于同一 PostgreSQL 中，不能替代服务器或数据库故障场景的 `pg_dump -Fc`。生产数据库迁移、身份合并、导入和恢复前仍必须先执行 PostgreSQL 完整备份。

## 配置

默认关闭。以下变量只可写入服务器环境文件，不能写入 Git：

```dotenv
T12_AUTO_BACKUP_ENABLED=false
T12_AUTO_BACKUP_STORAGE=database
T12_AUTO_BACKUP_INTERVAL_HOURS=24
T12_AUTO_BACKUP_RETENTION=7
T12_AUTO_BACKUP_START_DELAY_SECONDS=60
T12_AUTO_BACKUP_DIR=/var/backups/t12-online-exams/portable
```

- `T12_AUTO_BACKUP_STORAGE`：`database` 或 `filesystem`。
- `T12_AUTO_BACKUP_INTERVAL_HOURS`：1 到 720。
- `T12_AUTO_BACKUP_RETENTION`：每个题库或试卷保留最近 1 到 30 份成功工件。
- 单个可移植包延续 v1 的 200MB 上传限制，图片正文合计最多 100MB。
- 进程启动后会等待配置的启动延迟，再执行首次定时备份；PostgreSQL advisory lock 会阻止多个应用实例重复运行。

管理员可在“备份与迁移”窗口查看运行状态、立即触发一次自动备份以及下载成功的历史工件。立即运行不会覆盖现有数据；恢复时仍通过普通“一键导入”生成新的草稿副本。

## 生产启用

以下命令均在**阿里云 Workbench**执行。先确认代码已合并，并在任何数据库写入前创建完整备份：

```bash
sudo install -d -m 711 -o root -g root /var/backups/t12-online-exams
sudo install -d -m 700 -o postgres -g postgres /var/backups/t12-online-exams/postgres
sudo -u postgres pg_dump -Fc \
  -f "/var/backups/t12-online-exams/postgres/t12_exams-before-automatic-backups-$(date +%Y%m%d%H%M%S).dump" \
  t12_exams
```

选择数据库存储时，只需在 `/etc/t12-online-exams/t12-online-exams.env` 配置 `T12_AUTO_BACKUP_ENABLED=true` 与 `T12_AUTO_BACKUP_STORAGE=database`。选择文件系统存储时，还必须创建目录并交给服务账号：

```bash
sudo install -d -m 700 -o codexdeploy -g codexdeploy /var/backups/t12-online-exams/portable
```

父目录必须允许 `postgres` 和 `codexdeploy` 穿越，但不允许列出或写入；两个子目录各自仅对对应服务账号开放。不能把父目录设为 `postgres:postgres 0750`，否则 `codexdeploy` 即使拥有 `portable` 子目录也无法进入，并会在创建 `backup_run_*` 目录时得到 `EACCES`。

部署新 unit 和代码、执行 `0009_automatic_backups` 后重启服务。确认 `/readyz` 后，以系统管理员身份打开后台“备份”，点击“立即运行”，核对每个工件的成功状态和下载结果。不要将自动备份目录映射到公网或作为静态文件目录。

## 回滚

`0009` 的 down migration 在任何 `backup_artifacts` 仍存在时会拒绝执行，避免静默删除备份。需要回滚时先保留 PostgreSQL 完整 dump，确认不再需要工件后再执行受控清理和迁移回滚；不要直接删除数据库表或服务器备份文件。
