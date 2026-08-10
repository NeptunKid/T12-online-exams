# 飞书管理员登录与跨平台授权

日期：2026-08-11  
分支：`feature/exam-authoring-v2`

## 需求范围

- 管理员登录页增加飞书入口，并按服务端 Provider 配置分别显示钉钉和飞书按钮。
- 管理员会话失效和权限提示改为平台中性文案。
- 管理员用户列表及角色授予支持飞书独立用户和已绑定双平台身份的用户。
- 返回浏览器的身份标识继续遮蔽，不暴露完整 union ID、open ID 或 provider subject。

## 修改文件

- `public/admin.html`
- `public/admin.js`
- `src/db/user-repository.js`
- `tests/page-branding.test.js`
- `tests/user-repository.test.js`
- `MEMORY.md`

## 数据库迁移

无。复用现有 `users`、`user_identities` 和 `user_roles`。

## 测试结果

- `npm run check`：通过，121 项测试全部通过。
- `npm run check:syntax`：通过。
- `npm run check:secrets`：通过。
- `git diff --check`：通过。

## 风险

- 飞书账号必须先完成一次 OAuth 登录并在内部用户上拥有后台角色，才能进入管理员后台。
- 本步骤不执行历史同名用户归并；归并预览和人工确认将在独立步骤实现。
- 真实飞书管理员登录需要部署后的企业应用回调和权限端到端验收。

## 回滚方式

- 回滚本次代码提交即可恢复钉钉单入口和原管理员用户查询。
- 本步骤没有数据库结构或生产数据写入，不需要恢复备份。

## 文档与部署状态

- 开发总结：已记录。
- 飞书文档同步：未执行。
- GitHub PR：未创建。
- 生产部署：未执行。
- 公网、手机和电脑端双平台管理员验收：待部署后执行。
