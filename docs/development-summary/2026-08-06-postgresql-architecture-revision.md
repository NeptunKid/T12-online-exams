# PostgreSQL 架构修订总结

日期：2026-08-06  
分支：`chore/cloud-architecture`

## 需求范围

按项目负责人决定，将第一版云端数据库从 SQLite WAL 调整为 PostgreSQL 17；应用继续部署在阿里云香港轻量应用服务器，不使用本地设备或 Tunnel。

## 修改文件

- `.env.example`
- `docs/configuration.md`
- `docs/adr/ADR-001-database-selection.md`
- `docs/adr/ADR-006-cloud-deployment-topology.md`
- 本总结文件

## 数据库迁移

未执行。002 答卷、003 数据库和云端服务器均未创建或修改。

## 测试结果

```text
npm run check：通过
6 项测试通过
敏感信息扫描通过
```

## 风险与回滚

风险：同机 PostgreSQL 需要在云端设置定期 `pg_dump`、对象存储备份和磁盘告警；尚未实际验证香港网络访问。  
回滚：恢复到 SQLite ADR 版本即可；不涉及业务数据或外部服务变更。

## 飞书文档同步

自动同步能力尚未实现，本总结暂存于项目本地。
