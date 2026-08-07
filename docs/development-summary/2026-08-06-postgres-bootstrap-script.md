# PostgreSQL 云端初始化脚本总结

日期：2026-08-06  
分支：`chore/cloud-architecture`

## 任务

为无法从外部 SSH 连接的云服务器准备可由阿里云 Workbench 执行的 PostgreSQL 初始化脚本。

## 修改文件

- `scripts/bootstrap-postgres-cloud.sh`

脚本会安装 Ubuntu 仓库中的 PostgreSQL、创建 `t12_exams` 数据库和 `t12_app` 应用账户，写入适合 1 GiB 测试实例的低内存参数，并将监听地址限制为 `127.0.0.1`。数据库密码通过 Workbench 交互输入，不写入脚本或 Git。

## 数据迁移

未执行。脚本不读取 002 答卷、不下载应用代码，也不创建业务表。

## 验证

```text
bash -n scripts/bootstrap-postgres-cloud.sh：通过
npm run check：通过
6 项测试通过，敏感信息扫描通过
```

## 风险与回滚

风险：脚本执行需要服务器具备 apt 网络访问；PostgreSQL 版本以 Ubuntu 软件源实际版本为准。  
回滚：卸载 PostgreSQL 或删除脚本创建的数据库/账户；执行前应确认没有业务数据写入。

## 2026-08-06 修订

首次执行发现 PostgreSQL `DO $$` 块不能直接解析 psql 变量 `:'db_user'`。脚本已改为使用 `\\gexec` 生成并执行角色、密码和数据库语句；Ubuntu 24.04 当前安装的 PostgreSQL 16 可直接使用。实际云服务器地域已确认按东京记录。
