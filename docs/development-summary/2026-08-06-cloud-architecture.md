# 云端架构决策总结

日期：2026-08-06  
分支：`chore/cloud-architecture`

## 需求范围

将部署策略从本地设备和 PostgreSQL 安装调整为全云端第一版，选择香港轻量云服务器和 SQLite WAL。

## 修改文件

- `docs/adr/ADR-001-database-selection.md`
- `docs/adr/ADR-006-cloud-deployment-topology.md`
- `.env.example`
- `docs/configuration.md`
- 本总结文件

## 数据库迁移

未执行。002 的答卷仍保持原位置、未读取内容、未复制、未修改。

## 测试结果

```text
npm run check：通过
6 项测试通过
敏感信息扫描通过
```

## 风险与回滚

风险：香港地域不需要 ICP 备案，但中国大陆实际访问质量尚未验证；云资源、DNS、TLS、备份和迁移尚未创建。  
回滚：恢复到本提交前；本步骤仅修改文档与示例配置，不涉及业务数据或外部服务。

## 后续前置条件

在阿里云创建香港轻量应用服务器后，按 ADR 指定规格部署 Node.js、Caddy、SQLite WAL 和备份任务。Cloudflare DNS 切换及 002 数据迁移需要在独立步骤中执行。

## 飞书文档同步

自动同步能力尚未实现，本总结暂存于项目本地。
