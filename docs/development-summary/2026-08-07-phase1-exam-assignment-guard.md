# Phase 1：考试个人授权过滤

日期：2026-08-07

## 本次范围

- 新增 `0002_legacy_exam_assignments` 增量迁移，为已有历史答卷用户回填默认考试的个人授权。
- 历史导入器为新导入用户幂等创建个人授权，保持重复导入不产生重复记录。
- PostgreSQL 考试列表和考试详情只返回当前钉钉 `unionId` 对应用户已获授权、且处于有效时间窗口的已发布考试。
- 兼容 `legacy` 身份记录和后续 `dingtalk` 身份记录；未匹配身份的用户不会看到考试。

## 验证结果

- `npm test`：18 项通过。
- `npm run check:syntax`：通过。
- `npm run check:secrets`：通过，未读取或输出真实凭证。
- 迁移提供同名回滚文件；回滚只删除本步骤使用的 `legacy_assignment_` 授权记录，不删除考试、用户或答卷。

## 风险与回滚

- 风险：尚未建立身份映射的全新用户不会看到 PostgreSQL 考试，需要后续身份同步步骤补齐用户记录。
- 回滚：停止应用后执行 `node scripts/migrate.js --rollback 0002_legacy_exam_assignments --allow-destructive`，再回退本次应用版本；历史答卷和考试数据不受影响。

## 外部文档同步

飞书在线文档同步能力尚未接入，本次仅保留仓库内开发总结。
