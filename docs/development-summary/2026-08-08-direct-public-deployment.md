# 开发总结：公网直连部署基线

日期：2026-08-08

## 范围

- 将生产入口确定为阿里云东京服务器公网 `80/443`，移除 Cloudflare Tunnel 依赖。
- 增加 Node.js 存活检查 `/healthz` 和 PostgreSQL 就绪检查 `/readyz`。
- 提供 Caddy HTTPS 反向代理和 systemd 进程守护配置。
- 补充 DNS、安全组、环境变量、启动、验证和回滚步骤。

## 修改文件

- `server.js`
- `tests/server.test.js`
- `deploy/Caddyfile`
- `deploy/t12-exams.service`
- `docs/deploy-public-server.md`
- `docs/configuration.md`
- `README.md`
- `docs/adr/ADR-006-cloud-deployment-topology.md`

## 验证

- `npm run check`：待本机执行。
- 服务器端 Caddy、systemd、DNS、安全组和公网 HTTPS：待按部署文档执行。

## 风险与回滚

- 当前服务器为 2 vCPU/1 GiB，仅适合 1～2 名员工测试；扩大使用前应升级规格。
- Caddy 证书申请依赖 DNS、80/443 安全组和服务器防火墙配置。
- 回滚只需停止 Caddy 或将 Node 服务切回已验证提交；不删除 PostgreSQL、`.env` 或答卷备份。

## 外部同步

本总结可由已有 `npm run sync:feishu` 使用部署环境中的飞书凭证追加到指定在线文档；本次不在 Git 中写入任何凭证。
