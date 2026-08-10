# 考试后台追踪系统（钉钉飞书接入版）Memory

2026-08-05 [Codex] 创建 `003_考试后台追踪系统_钉钉飞书接入版` 项目目录，用于在 `002` 钉钉登录版的基础上规划钉钉与飞书双平台接入、多考试、题库、通知、GitHub、飞书文档同步及公网跨设备访问；当前仅放入概要与详细计划，尚未复制源码或生产答卷。
2026-08-08 [Codex] 已确定移除 Cloudflare Tunnel，采用阿里云东京服务器公网 80/443 + Caddy + Node.js 127.0.0.1:3001 + PostgreSQL 127.0.0.1:5432；新增 `deploy/Caddyfile`、`deploy/t12-exams.service`、公网部署文档与 `/healthz`、`/readyz` 检查，提交于 `chore/direct-public-deployment` 的 `1873bd0`。本机质量门 26 项测试、语法检查和敏感信息扫描均通过；因本机到 `ssh.github.com:443` 被限制，分支尚未推送/创建 PR。
2026-08-08 [Codex] 针对服务器部署报错补充 `T12_ENV_FILE` 支持，迁移可读取 `/etc/t12-online-exams/t12-online-exams.env`；补充 `/opt` 目录和 Caddy 旧配置诊断说明，修复提交为 `3a968a6`、`d8cca72`，本机质量门仍为 26 项通过。
2026-08-08 [Codex] 公网验收完成：`/healthz`、`/readyz` 和 `https://exam.t12group.com/` 均通过，架构为 Cloudflare -> Caddy -> Node.js -> PostgreSQL。已新增 Phase 2 CSV 题库校验预览（`6fe6b68`）：只读解析、无数据库写入；来源核对得到萃取原理 43 题（无分数列、含填空与 9 张图片）、消防 32 题/100 分、IT 37 题/99 分（需先脱敏）和候选咖啡师招聘笔试 23 题/72 分；“5 个剩余考试”中仍有两份未确认。
2026-08-08 [Codex] 在 `feature/phase2-csv-preview` 提交 `27e1249`：新增 `fill` 填空题题型、CSV 校验、PostgreSQL `0003_fill_question_type` 迁移、自动判分（答案别名/去首尾空格/不区分大小写）、考生输入框与阅卷人工改分，质量门 34 项测试通过；用户已明确不纳入咖啡师招聘笔试，餐饮法规和咖啡基础各 3 份 PDF 为扫描试卷，待 OCR 与逐题复核。当前推送仍受本机 `ssh.github.com:443` 限制，未重复尝试。
2026-08-08 [Codex] 复核 PDF OCR：法规 18 页、咖啡 20 页均未生成有效文字；macOS Vision 对所有页面返回 `Failed to create CVPixelBuffer`，因此没有题目/选项/答案可供确认，未写入仓库或题库。
2026-08-09 [Codex] 在 `feature/phase2-xlsx-question-drafts` 提交 `d90fc7f`：从萃取原理、消防基础、IT 基础 Excel 生成 CSV 审阅稿；分值/时长分别为 101/50 分钟、100/30 分钟、剔除 3 道操作题后 86/30 分钟。消防和 IT CSV 预览通过；萃取第 18、19 题为图表图片选项，因尚未建立受控资源映射而暂不允许提交。CSV 模板扩展到 `option_j`，`npm run check` 34 项通过。
2026-08-09 [Codex] 修正萃取图表题号：Excel 表头占第 1 行，因此第 17 题使用 `17-A.png` 至 `17-D.png`，第 18 题使用 `18-A.png` 至 `18-E.png`。新增 `public/question-resources/` 受控资源目录及 SHA-256 清单，CSV 增加 `option_image_a` 至 `option_image_j`，PostgreSQL API 和考生页支持受控选项图片；新增事务、幂等的三份题库/考试导入脚本与 Workbench 部署文档。本机质量门 36 项通过；尚未写入生产数据库。
2026-08-09 [Codex] 在 `feature/admin-role-management` 实现 PostgreSQL 管理员角色管理：钉钉登录登记/关联用户，首位管理员由 `DINGTALK_GRADER_UNION_IDS` 引导，后台可检索已登录钉钉用户并授予/撤销 `grader + system_admin`，权限变更写入 `audit_logs`，禁止自我撤权和移除最后系统管理员；本机质量门 32 项通过，尚未部署生产。
2026-08-09 [Codex] 已解决 PR #23 与最新 `main` 的 `MEMORY.md`、`package.json` 冲突：保留双方全部进展记录，并合并 Phase 2 与管理员 repository 的语法检查项；合并后质量门 42 项通过。
2026-08-09 [Codex] 在 `feature/admin-question-editing` 实现管理员会话提前校验、题干 `【】` 下划线显示和 PostgreSQL 已有试题编辑；仅 `exam_admin/system_admin` 可修改题干、选项、参考答案和解析，事务保存时递增题目及引用考试版本并写入审计日志，历史答卷快照保持不变；交卷增加试卷版本校验以避免编辑期间静默错分，完整质量门 64 项测试通过。
2026-08-09 [Codex] 在 `fix/t12-page-branding` 将考生首页及浏览器标题统一为“T12学习考核中心”，副标题为“我的学习与考核”；管理员登录页和后台顶栏以“T12学习考核中心”为主标题、“管理员阅卷后台”为副标题，未涉及数据库或业务逻辑，完整质量门 66 项测试通过。
2026-08-09 [Codex] 在 `fix/question-bank-layout-placeholders` 将题库维护改为先选试卷再显示对应题目，选择题当前答案在选项区高亮且统一通过单个文本框编辑；题干仅将内容为空白的 `【】`、`「」`、`[]` 转换为带下划线格式的连续空白字符，含文字括号保持原样，完整质量门 70 项测试通过。
2026-08-09 [Codex] 在 `feature/coffee-basics-exam` 从本地《咖啡基础知识》XLSX 生成 100 题 CSV 审阅稿，配置 `exam-coffee-basics` 为 60 分钟、总分 100、通过分 85，并沿用发布后全员有效钉钉用户授权；源表第 39 行跳号选项已无损压缩，另有 1 道问答题缺少源图片并列为上线风险。阶段进度估算约 65%，完整质量门 72 项测试通过；尚未导入生产 PostgreSQL。
2026-08-10 [Codex] 用户提供咖啡题库图片 `8-1.jpeg`、`36-1.jpeg`；在 `fix/coffee-question-images` 增加受控资源、副本最长边 1600px、`0005_question_stem_images` 可回滚迁移，并让题库导入、考生试卷、阅卷页和答卷快照保存题干图片；完整质量门 74 项测试通过。生产服务器此前因未拉取 PR #31 使用旧脚本，`--only` 报错但数据库备份成功且未写入；下一步在 Workbench 拉取最新 main、执行迁移后再导入 coffee。
2026-08-10 [Codex] 生产部署再次暴露用户混用：admin 在 codexdeploy 所有的仓库运行 npm ci，因无法 unlink `node_modules/.package-lock.json` 报 EACCES；随后迁移仅列出 0001-0004，说明服务器仍未拉到含 0005 的 `70a5f35`。固定修复为恢复仓库所有权并统一以 codexdeploy 执行 Git/npm，迁移与服务操作再由 admin sudo 执行。
2026-08-10 [Codex] 在 `feature/legal-cleaning-question-repair` 完成移动端工作台顶部栏自适应、首次/补考/额外补考文案和 PostgreSQL 额外授权事务扣减；阅卷页默认保留交卷快照，并可逐题提示题库变更后选择采用当前版本重新阅卷，评分依据保存到 `scores_json.reviewReferences`。本机质量门 78 项测试、语法检查和敏感信息扫描全部通过；未修改数据库结构或历史答卷。
2026-08-10 [Codex] 清洁卫生题库修复准备完成：由两份原始 Excel 生成 36 题来源数据，新增 47 个受控图片资源及默认 dry-run 的 PostgreSQL 修复脚本。脚本仅补当前题库空字段、记录审计并递增题目/考试版本；拒绝题目数或历史标识不一致，不更新分值、题型、授权、`data/submissions.json` 或任何历史答卷快照。质量门 83 项测试、语法检查与敏感信息扫描全部通过；生产执行前必须 `pg_dump -Fc` 备份。
2026-08-10 [Codex] 用户明确要求减少流程卡顿：后续 GitHub 外部网络操作（`git push`、`gh pr create`、PR checks/merge）优先由用户在本机终端执行；Codex 只准备代码、提交与最短命令。不得因网络问题反复等待或重试；如需代理或连接异常，立即暂停并说明。每条服务器命令须明确执行位置（本机终端或阿里云 Workbench）。
