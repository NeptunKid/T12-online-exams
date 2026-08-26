# 2026-08-26 自动备份调度安全改造

## 背景

生产自动逻辑备份在服务重启后的启动延迟一到，就会重新打包全部题库和试卷。2026-08-26 的多次重启叠加生成了约 879MB 文件系统工件，造成云盘读写峰值并触发 IOPS 限流。

生产已经暂停自动备份。此改造只降低未来重新启用前的调度风险，不会重新启用生产功能。

## 改动

- 在现有 `backup_runs` 表中使用 `system + scheduled` 运行作为完整定时周期记录，无需数据库迁移。
- 服务启动后的定时检查会在 advisory lock 内读取最近成功周期；还未到 `T12_AUTO_BACKUP_INTERVAL_HOURS` 时跳过本轮，并在剩余时间后重查。
- 仅当一个周期内所有题库和试卷都生成成功时，才完成系统周期记录；部分失败会保留失败状态，不会错误抑制下一次周期。
- `T12_AUTO_BACKUP_STALE_AFTER_MINUTES` 默认 120，下一次定时检查会将早于该阈值且仍为 `running` 的定时运行标记为失败。
- `T12_AUTO_BACKUP_SCOPE_DELAY_SECONDS` 默认 30，仅对定时运行的相邻对象生效；管理员手动“立即运行”保持立即执行。

## 行为边界

- 未修改题库、试卷、题目、答卷、历史快照、用户、通知或审计数据。
- 未新增迁移，`0009_automatic_backups` 不变。
- 未改变可移植 `.t12backup` 的导出、导入、校验、下载或手动触发接口。
- 生产仍必须保持 `T12_AUTO_BACKUP_ENABLED=false`，直到完成异地恢复、低峰调度和容量复核。

## 验证

- `node --test tests/automatic-backup-config.test.js tests/automatic-backup-repository.test.js tests/automatic-backup-service.test.js`：24 项通过。
- `npm run check:syntax`：通过。
- `git diff --check`：通过。

## 风险与回滚

- 默认 30 秒节流会延长大规模全量定时备份的总时长，这是为降低瞬时 IOPS 的明确权衡；可在未来容量测试后通过环境变量调整。
- 120 分钟后仍在运行的定时任务会被下一轮检查标记失败，因此单次完整周期应在该阈值内完成；重新启用前必须先在低峰期验证实际耗时。
- 纯代码回滚可恢复上一已验证提交；生产自动备份继续关闭时，不会产生新的工件或数据库运行记录。
