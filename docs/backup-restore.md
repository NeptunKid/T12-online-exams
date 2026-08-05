# 备份与恢复

003 不会自动读取或修改 001、002 的答卷。任何历史数据迁移前，必须先得到明确确认，并保留来源文件的只读副本和校验值。

备份脚本需要显式传入来源文件和目标目录，目标文件已存在时会拒绝覆盖：

```bash
node scripts/backup-submissions.js /path/to/submissions.json backups/
```

脚本会创建带时间戳的 JSON 副本和同名 SHA-256 校验文件，不删除来源文件。备份目录已加入 `.gitignore`，不能提交到 GitHub。

恢复前应先停止写入服务，核对 SHA-256，再将副本恢复到经过确认的独立数据位置。不要直接覆盖 002 的 `data/submissions.json`。
