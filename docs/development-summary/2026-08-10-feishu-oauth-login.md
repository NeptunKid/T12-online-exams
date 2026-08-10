# 飞书 OAuth 登录闭环

日期：2026-08-10

## 范围

- 新增钉钉/飞书 OAuth Provider 抽象，统一授权 URL、一次性 state 和 code 交换接口。
- 新增 `/auth/feishu/login` 与 `/auth/feishu/callback`。
- 飞书回调通过 PostgreSQL `user_identities(provider = 'feishu')` 登记用户，并默认授予 `student` 角色。
- 考生首页根据配置显示钉钉或飞书登录入口，工作台显示当前登录平台。

## 数据与安全

- 不新增数据库迁移；现有 `user_identities` 已支持 `feishu` provider。
- 不按姓名、头像或其他弱标识自动合并钉钉和飞书身份。
- OAuth `state` 绑定 provider、限制 10 分钟有效期，并使用站内回跳地址校验。
- Secret 只从环境变量读取，不写入源码、测试或文档。

## 当前边界

- 本步骤只完成登录和身份登记；飞书用户的考试授权、身份人工绑定、飞书管理员入口和组织同步在后续 Sprint 实施。
- 现有按 `all-active-dingtalk-users` 建立的考试授权不会被本步骤改写。

## 验证与回滚

- 本机质量门：92 项测试、语法检查和敏感信息扫描通过。
- 回滚：回滚应用代码即可；本步骤无数据库迁移，不需要恢复生产数据库。
