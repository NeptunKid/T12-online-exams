# PostgreSQL 初始化脚本错误修复

日期：2026-08-06

## 问题

Ubuntu 24.04 成功安装 PostgreSQL 16，但初始化应用账户时，`DO $$` 块中的 psql 变量没有被 PostgreSQL 正确解析，脚本在角色创建前退出。

## 修复

- 使用 psql `\\gexec` 生成并执行安全引用的 `CREATE ROLE`、`ALTER ROLE` 和 `CREATE DATABASE` 语句。
- 将实际云服务器地域记录为东京。

## 兼容性

PostgreSQL 16 是 Ubuntu 24.04 软件源提供的稳定版本，满足当前系统要求；数据库模型和后续迁移脚本不依赖 17 的专有特性。

## 验证

```text
bash -n scripts/bootstrap-postgres-cloud.sh：通过
npm run check：通过
6 项测试通过，敏感信息扫描通过
```

首次执行只完成 PostgreSQL 软件与空集群安装，未创建业务数据库或导入历史答卷；重新运行修复脚本即可继续。
