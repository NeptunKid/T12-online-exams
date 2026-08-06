# ADR-006：云端部署拓扑

日期：2026-08-06  
状态：已采纳，待资源创建

## 决策

第一版采用阿里云轻量应用服务器香港地域，部署单实例 Node.js 服务、SQLite WAL 和 Caddy：

```text
用户 -> Cloudflare DNS/代理 -> Caddy (HTTPS) -> Node.js -> SQLite WAL
                                             -> 备份任务 -> 对象存储
```

不再使用本地设备或 Cloudflare Tunnel 作为生产入口。

## 基线规格

- 地域：香港。
- 系统：Ubuntu 24.04 LTS 64-bit。
- 规格：至少 2 vCPU、4 GB RAM、60 GB SSD 和 1 TB 月流量。
- 公网入口：仅 80/443；SSH 仅使用阿里云 Workbench 或限定管理来源。
- 数据库端口：不开放公网访问。
- Cloudflare：使用 DNS/代理和 Full (strict) TLS，源站证书由 Caddy 管理。

## 风险与回滚

香港地域通常无需 ICP 备案，但中国大陆访问质量必须在手机蜂窝网络、家庭宽带和公司网络上实际验证。新入口上线前保留旧入口；异常时将 DNS/代理切回旧服务，数据库备份不删除。
