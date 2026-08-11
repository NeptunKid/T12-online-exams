# T12 在线考试后台追踪系统交接说明

更新时间：2026-08-11
项目目录：`$HOME/Documents/Codex/003_考试后台追踪系统_钉钉飞书接入版`
GitHub：`git@github.com:NeptunKid/T12-online-exams.git`
生产域名：`https://exam.t12group.com/`

本文是后续 Agent 的接手入口。它汇总当前架构、已经完成的开发、验证结果、生产操作约束和未确认事项。遇到本文与用户本轮明确指令冲突时，以用户指令和项目 `AGENTS.md` 为准。

## 一、不可违反的约束

- 不修改 `$HOME/Documents/Codex/001_考试后台追踪系统` 和 `$HOME/Documents/Codex/002_考试后台追踪系统_钉钉登录版`。
- 不删除、覆盖或重置 `data/submissions.json`；003 使用 PostgreSQL 和独立数据目录。
- 不读取、输出或提交 `.env`、`/etc/t12-online-exams/t12-online-exams.env`、OAuth Secret、数据库密码、员工身份标识或答卷答案。
- 生产 PostgreSQL 发生写入前先执行 `pg_dump -Fc`，并记录备份文件路径；身份合并仅能由系统管理员在后台执行，命令行脚本只允许 dry-run，禁止 `--apply`。
- 历史答卷必须继续使用提交时保存的题目快照和评分依据。题库修改不得静默改变历史成绩。
- 每次只推进一个可独立验证、可回滚的步骤，并记录修改文件、测试、风险、回滚和飞书同步状态。
- GitHub 网络操作容易卡顿。用户已明确：`git push`、`gh pr create`、PR 检查和合并优先由用户在本机终端执行；连接异常时停止重试并请用户协助。
- 每条服务器命令必须标明执行位置（本机终端、阿里云 Workbench、GitHub 页面或飞书）。

## 二、当前 Git 与工作树

当前分支：`feature/exam-authoring-v2`

```text
本轮已提交：`9ce1a09` 管理员筛选/模型审计、`83c5464` 飞书管理员入口、`75a330a` 经核对的跨平台用户合并、`9393e3e` 试卷分值所有权兼容层
当前未提交：草稿组卷 Repository、API、管理员 UI、测试和交接文档
基线：`main` 的 `d93f17c fix: repair cleaning question bank content`
```

当前工作树的未跟踪文件是用户素材，不要删除、改名或提交：

- `咖啡基础知识-题库.xlsx`
- `餐饮相关法律法规-题库.xlsx`
- `清洁卫生-题库-a20ba7c8-9386-4864-9ae8-c21671931165.xlsx`
- `清洁卫生基础.xlsx`
- `基础知识题库图片/`
- `清洁卫生考试图片/`
- `package_副本.json`

`.env` 和 `.secrets/` 已被忽略，绝不能在命令输出或文档中展开内容。

最新提交的纯文本同步修复尚未由本 Agent 核实是否已创建/合并 PR、是否已部署生产。不要假设已上线。

## 三、生产架构与环境

生产服务器为阿里云东京 Ubuntu 24.04 轻量实例（2C/1G/30G，公网 IPv4 已配置）。当前架构：

```text
Cloudflare DNS/代理
  -> Caddy（公网 80/443，自动 HTTPS）
  -> Node.js systemd 服务（127.0.0.1:3001）
  -> PostgreSQL 16（127.0.0.1:5432）
```

- systemd 服务：`t12-exams.service`
- 服务文件仓库位置：`deploy/t12-exams.service`
- Caddy 配置仓库位置：`deploy/Caddyfile`
- 生产代码目录：`/opt/t12-online-exams`
- 生产配置文件：`/etc/t12-online-exams/t12-online-exams.env`（仅服务器读取）
- 数据库：`t12_exams`，应用用户：`t12_app`，监听 `127.0.0.1:5432`
- 健康检查：`https://exam.t12group.com/healthz`
- 数据库就绪：`https://exam.t12group.com/readyz`

成功标准是 `/readyz` 返回 `{"status":"ready","database":"ok"}`，且公网首页返回 HTTP 200。重启后首次本机 `curl 127.0.0.1:3001` 失败可能只是 Node 启动窗口，应继续轮询，不要立即判定故障。

### 服务器权限规则

仓库归 `codexdeploy` 所有，Workbench 当前常用登录用户可能是 `admin`。`safe.directory` 只能解决 Git 的 dubious ownership 检查，不能解决文件权限。生产更新应遵循：

1. 以 `codexdeploy` 执行 Git 和 npm（包括 `npm ci`）。
2. `admin` 只用 `sudo` 执行数据库迁移、systemd、Caddy 等系统操作。
3. 若权限已被错误改变，先检查并恢复 `/opt/t12-online-exams` 的所有权，再运行 npm；不要用 `admin` 直接改写 `node_modules`。

推荐的 Workbench 更新骨架（执行前先确认本次提交/PR 已合并）：

```bash
cd /opt/t12-online-exams
sudo git config --global --add safe.directory /opt/t12-online-exams
sudo -u codexdeploy -H git switch main
sudo -u codexdeploy -H git pull --ff-only origin main
sudo -u codexdeploy -H npm ci --omit=dev
sudo env T12_ENV_FILE=/etc/t12-online-exams/t12-online-exams.env /usr/bin/npm run migrate
sudo systemctl restart t12-exams
```

最后用轮询检查 `/readyz`，再检查 `systemctl status --no-pager -l t12-exams caddy`。命令必须在阿里云 Workbench 执行，不是在本机 macOS 终端执行。

## 四、已经完成的开发

### Phase 0 / Sprint 1：工程和安全基线

- 已创建 GitHub 仓库、`main`/`develop` 分支和 GitHub Actions 质量门。
- 已建立 `.env.example`、敏感信息扫描、语法检查、单元测试和部署文档。
- 已从 Tunnel 架构切换为阿里云公网服务器 + Caddy；生产域名端到端 HTTPS 已验收。
- 已记录数据库备份/恢复流程、systemd/Caddy 配置和部署故障诊断。

### Phase 1 / Sprint 2：PostgreSQL 多考试与历史迁移

- PostgreSQL schema/migrations、考试/题目/用户/身份/答卷/快照/阅卷和审计边界已建立。
- 旧版 JSON 答卷已备份并迁移；历史快照、成绩和状态保持兼容。
- 考生工作台、考试读取、提交、个人记录和管理员阅卷已切换 PostgreSQL API。
- 已补充填空题类型、自动判分和人工改分。

### Phase 2 / Sprint 3：题库、图片和考试发布

- 支持 CSV/XLSX 题库预览、校验、事务导入、幂等导入和受控题目/选项图片资源。
- 题库按试卷/题库分类展示；管理员可手动录入单选、多选、判断、填空、问答题，并编辑题干、选项、参考答案和解析。
- 空白的 `【】`、`「」`、`[]` 会在展示层转换为带下划线的空白；括号内有文字时不转换。
- 题库修改会递增题目/考试版本、写入审计日志；历史答卷读取原快照。重新阅卷时会提示题目已修改或删除，并允许选择是否采用新版本。
- 分值业务所有权已收敛到 `exam_questions.score`：题库 API、手动录题和题库 UI 不再读写分值；`questions.score` 仅作为旧数据兼容列保留并默认 0。
- `0007_exam_authoring_score_ownership` 为单题库试卷回填可空 `exams.question_bank_id`，跨题库或空试卷保持 NULL；同时保存 `pass_rate`，后续组卷改分应据此重算试卷总分和通过分。该迁移不更新历史答卷或快照。
- 草稿试卷已支持绑定单题库、部分/全选 active 题、完整排序、单题分值和全部已选题统一分值。每次写入均校验 `version`，重算总分/通过分并记录审计；非草稿试卷只读，历史答卷和快照不变。
- 已发布考试包括：萃取原理、消防基础、IT 基础、清洁卫生入职培训、咖啡基础知识、餐饮相关法律法规。生产题数和最终状态以 PostgreSQL 查询为准，不要依赖旧 CSV 统计。
- 《餐饮相关法律法规》已按用户确认配置：40 分钟、总分 100、通过分 85；题型方案为 19 单选、19 多选、15 判断。
- 《咖啡基础知识》已生成 100 题导入稿，60 分钟、总分 100、通过分 85；生产导入状态曾因未拉取含 `0005` 的版本而未确认，接手时必须查询数据库核实。
- 清洁卫生题库已用两份原始 Excel 修复，补充受控图片资源；修复脚本默认 dry-run，生产执行前要求备份。

### Phase 3 / Sprint 4：钉钉、飞书、权限和移动端

- 已完成钉钉/飞书 OAuth Provider 抽象、登录回调、身份登记和双入口。
- 两个平台均以真实姓名登记，但绝不只凭姓名自动绑定；首次登录始终创建或复用对应 Provider 身份。
- 系统管理员后台可查看同名候选并进行人工确认。只有“纯钉钉/历史钉钉账号 + 纯飞书账号”的唯一候选可合并；任何多重候选或已绑定双平台账号均阻断。
- 合并以事务迁移身份、角色、考试授权、补考权限和答卷归属；题目快照、作答和分数保持不变。副本保留为 `disabled`，历史审计不改写，新审计记录保存迁移统计。
- `scripts/reconcile-cross-platform-users.js` 只生成 dry-run 预览；`--apply` 已明确停用。生产合并前仍必须在阿里云 Workbench 执行 `pg_dump -Fc`，再由系统管理员在后台逐项确认。
- 管理员角色管理已完成：首位管理员由 `DINGTALK_GRADER_UNION_IDS` 引导，后台可授予/撤销 `grader`、`system_admin`，禁止自我撤权和移除最后系统管理员。
- 管理员会话在打开、恢复前台和运行期间检查，失效时提前锁定并要求登录。
- 考生端和管理员端已做手机自适应；管理员阅卷默认筛选待批阅项，非待批阅内容可折叠。
- 页面品牌已统一为“T12学习考核中心”，考生副标题为“我的学习与考核”，管理员副标题为“管理员阅卷后台”。

### Phase 4 / Sprint 5：阅卷工作流和总结同步

- 已完成客观题自动评分、问答题阅卷、补考授权和额外补考事务流程。
- 已保留交卷快照并记录 `scores_json.reviewReferences`，确保复核时可追溯评分依据。
- `scripts/sync-feishu-document.js` 已支持 `T12_ENV_FILE`。
- 最新 `7cb7b7e` 将 Markdown 总结转换为纯文本后同步，移除标题、列表、表格分隔、粗体、斜体、代码围栏和链接语法，使用 `plain-text-v1` 标识保持幂等。旧飞书文档中的 Markdown 不会自动删除。

## 五、质量验证记录

截至当前未提交组卷步骤，本机质量门结果：

```text
npm run check:syntax   通过
npm test               160 项通过
npm run check:secrets  通过
```

新增/主要覆盖的测试包括：迁移、遗留答卷导入、考试 API、题库导入、题目资源、题目格式、题目编辑、手动录题、草稿组卷仓储/API/UI、跨平台身份、管理员移动布局、OAuth、飞书同步等。本步内置浏览器连接本机页面时卡住已立即终止；生产验收仍需真实 PostgreSQL、浏览器和手机端复核，不能只以单元测试替代。

## 六、未确认事项与风险

以下状态不能假设为已完成：

1. `fix/feishu-plain-text-sync` 的 PR 是否已创建、合并、部署。
2. 纯文本同步代码是否已拉取到生产服务器；旧 Markdown 段落是否已在飞书文档中人工删除。
3. 是否已在生产以系统管理员身份核对同名候选；不得使用脚本或仅凭同名完成合并。执行前必须在阿里云 Workbench 创建 `pg_dump -Fc`。
4. 《咖啡基础知识》是否已执行含 `0005_question_stem_images` 迁移的生产导入；导入前必须确认图片资源和题数。
5. 手动录题、手机管理员阅卷、飞书成员考试授权是否已由真实账号验收。
6. 生产服务器公网仍经 Cloudflare 代理；域名解析、缓存和 Caddy 证书状态变更时需重新做 `/healthz`、`/readyz`、首页、登录回调和提交链路验收。
7. `0007_exam_authoring_score_ownership` 尚未在生产执行。部署时必须先备份、执行迁移并确认成功，再重启依赖题目分值默认值的新代码。
8. 草稿组卷尚未连接真实 PostgreSQL 做管理员浏览器/手机验收，也尚未部署。

## 七、接手后的最小行动顺序

### 1. 本机终端：提交并创建 PR

由于 GitHub 网络连接可能受限，优先让用户在本机终端执行：

```bash
cd "$HOME/Documents/Codex/003_考试后台追踪系统_钉钉飞书接入版"
git push -u origin fix/feishu-plain-text-sync
gh pr create --base main --head fix/feishu-plain-text-sync \
  --title "fix: 飞书开发总结改为纯文本同步" \
  --body-file docs/development-summary/2026-08-10-feishu-plain-text-sync.md
```

让用户提供 PR 链接或确认已合并；不要反复重试网络命令，也不要擅自改动远程分支。

### 2. 阿里云 Workbench：部署已合并提交

以 `codexdeploy` 执行 Git/npm，以 `admin` 执行 systemd/迁移。先做数据库备份，再执行迁移或导入：

```bash
sudo install -d -m 750 -o postgres -g postgres /var/backups/t12-online-exams
sudo -u postgres pg_dump -Fc -f "/var/backups/t12-online-exams/t12_exams-before-<purpose>-$(date +%Y%m%d%H%M%S).dump" t12_exams
```

部署后轮询：

```bash
for i in {1..20}; do curl -fsS http://127.0.0.1:3001/readyz && echo && break; sleep 1; done
curl -I https://exam.t12group.com/
```

### 3. 阿里云 Workbench：复核身份与考试

先运行：

```bash
cd /opt/t12-online-exams
sudo -u codexdeploy -H node scripts/reconcile-cross-platform-users.js --dry-run
```

命令行整理脚本永久只读，禁止 `--apply`。只有用户核对唯一候选后，才可在系统管理员后台执行逐项合并。再用 PostgreSQL 查询考试 ID、标题、状态、时长、题数、总分和通过线，核实六份考试；不要输出答卷正文或身份敏感字段。

### 4. 飞书：同步总结

在服务器已配置生产环境文件、并确认飞书文档 ID 后，在 Workbench 执行：

```bash
cd /opt/t12-online-exams
sudo env T12_ENV_FILE=/etc/t12-online-exams/t12-online-exams.env \
  /usr/bin/node scripts/sync-feishu-document.js docs/development-summary/2026-08-10-project-progress.md
sudo env T12_ENV_FILE=/etc/t12-online-exams/t12-online-exams.env \
  /usr/bin/node scripts/sync-feishu-document.js docs/development-summary/2026-08-10-manual-question-entry.md
sudo env T12_ENV_FILE=/etc/t12-online-exams/t12-online-exams.env \
  /usr/bin/node scripts/sync-feishu-document.js docs/development-summary/2026-08-10-feishu-plain-text-sync.md
```

脚本只追加新的纯文本版本，不删除旧内容；旧 Markdown 段落需在飞书文档中人工删除。

## 八、回滚方法

- 代码回滚：在 GitHub 回滚已合并 PR，或在服务器以 `codexdeploy` checkout 上一个已验证提交后重启服务。
- 应用恢复：恢复对应 `/var/backups/t12-online-exams/*.dump` 前，先停止写入并确认目标数据库；严禁直接覆盖 `data/submissions.json`。
- 题库修复/导入：优先使用脚本的 dry-run 和事务；失败时事务自动回滚，使用导入前 PostgreSQL dump 恢复。
- 身份合并：后台事务失败会自动回滚；若已提交但确认误合并，先停止相关账号操作，优先从合并前 `pg_dump -Fc` 恢复到隔离库核对后再执行修复，禁止直接删除用户或手改答卷快照。
- Caddy/服务：恢复上一版 `Caddyfile` 或 systemd unit，执行 `systemctl daemon-reload`、重启并重新检查证书和 `/readyz`。

## 九、后续计划建议

按详细实施计划继续：

1. 完整题库 CRUD、归档/恢复和操作审计。
2. 题目图片附件上传，以及已发布试卷复制为新草稿/发布流程。
3. 部门/组织同步与考试授权管理。
4. 通知 Outbox、失败重试、人工重发和结果回执。
5. 试卷/题库自包含备份包的导入导出，以及自动备份、监控告警和恢复演练。

每项仍按“复现/方案 -> 单步实现 -> 本机质量门 -> PR -> 用户部署 -> 端到端验收 -> 开发总结/飞书同步”推进。
