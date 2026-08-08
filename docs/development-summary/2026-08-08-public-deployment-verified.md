# 开发总结：公网部署验收完成

日期：2026-08-08

## 验收结果

- `http://127.0.0.1:3001/healthz` 返回 `status: ok`。
- `http://127.0.0.1:3001/readyz` 返回 `status: ready`、`database: ok`。
- `https://exam.t12group.com/` 返回 HTTP 200，响应链路包含 `via: 1.1 Caddy`。
- PostgreSQL、Node.js、Caddy 均已通过公网入口串联验证，不再使用 Cloudflare Tunnel。

## 兼容性与回滚

本次仅验证部署，不修改历史答卷、数据库结构或生产凭证。回滚仍为停止新服务、恢复上一应用提交和保留 PostgreSQL 数据。

## 下一步

Phase 1 的多考试 API 和数据库模型已具备；创建第二份真实考试前，需要明确考试标题、题目来源、时长、总分、通过线和授权员工范围。未收到这些定义前不写入第二份生产考试数据。
