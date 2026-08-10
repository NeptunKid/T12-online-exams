# 题库与受控图片部署

本步骤包含五份已确认的 Excel 题库：萃取原理、消防基础、IT 基础、咖啡基础知识、餐饮相关法律法规。两组待人工审核的 PDF 和咖啡师招聘笔试不在导入范围内。

## 本机验证

```bash
cd $HOME/Documents/Codex/003_考试后台追踪系统_钉钉飞书接入版
npm run check
node scripts/preview-question-csv.js docs/question-bank-drafts/extraction-questions.csv
node scripts/preview-question-csv.js docs/question-bank-drafts/fire-questions.csv
node scripts/preview-question-csv.js docs/question-bank-drafts/it-questions.csv
node scripts/preview-question-csv.js docs/question-bank-drafts/coffee-questions.csv
```

萃取原理第 17 题绑定 `resource:extraction-17-a` 至 `resource:extraction-17-d`，第 18 题绑定 `resource:extraction-18-a` 至 `resource:extraction-18-e`。资源清单和 SHA-256 位于 `public/question-resources/manifest.json`。

## 阿里云 Workbench：拉取并导入

以下命令在服务器 Workbench 执行。先确认项目路径，若 `test` 失败不要继续：

```bash
cd /opt/t12-online-exams
test -f package.json && test -f public/question-resources/manifest.json
git pull --ff-only origin main
npm ci
```

导入前先备份 PostgreSQL（不会修改答卷）：

```bash
sudo install -d -m 750 -o postgres -g postgres /var/backups/t12-online-exams
T12_BACKUP_FILE="/var/backups/t12-online-exams/t12_exams-before-question-import-$(date +%Y%m%d%H%M%S).dump"
sudo -u postgres pg_dump -Fc -f "$T12_BACKUP_FILE" t12_exams
sudo -u postgres test -s "$T12_BACKUP_FILE" && echo "数据库备份完成：$T12_BACKUP_FILE"
```

确认备份命令成功后，在同一目录执行迁移。迁移会新增可回滚的 `0005_question_stem_images` 字段：

```bash
sudo env T12_ENV_FILE=/etc/t12-online-exams/t12-online-exams.env \
  /usr/bin/npm run migrate
```

迁移成功后执行事务导入。`--publish` 会将选中的考试设为 `published`；`--all-active-dingtalk-users` 会给所有已登录、状态为 `active` 的钉钉用户建立授权。餐饮法规只导入该题库时：

```bash
cd /opt/t12-online-exams
sudo env T12_ENV_FILE=/etc/t12-online-exams/t12-online-exams.env \
  /usr/bin/node scripts/import-question-banks.js \
  --all-active-dingtalk-users \
  --only legal \
  --publish
```

`--only legal` 确保本次只导入餐饮相关法律法规，不核对或修改已经上线的考试。若需导入咖啡基础知识，可改为 `--only coffee`；若需完整初始化五份结构化题库，可移除该参数。若只需给单个员工授权，可改用 `--union-id '<钉钉 unionId>' --user-name '<员工姓名>'`；真实身份值不得写入 Git。导入脚本会校验题库数量、题目内容、总分、考试时长和 85% 通过线；重复执行不会重复创建，已有内容不一致时会整笔回滚并报错。

导入完成后重启服务并验证资源与数据库：

```bash
sudo systemctl restart t12-exams
curl -fsS http://127.0.0.1:3001/healthz
curl -fsS http://127.0.0.1:3001/readyz
curl -I https://exam.t12group.com/question-resources/extraction/extraction-17-a.png
curl -I https://exam.t12group.com/question-resources/coffee/coffee-cherry-structure.jpeg
curl -I https://exam.t12group.com/question-resources/coffee/coffee-siphon.jpeg
sudo -u postgres psql -d t12_exams -c \
  "SELECT e.id, e.title, e.status, count(eq.question_id) AS questions, e.total_score, e.pass_score \
   FROM exams e LEFT JOIN exam_questions eq ON eq.exam_id = e.id \
   WHERE e.id IN ('exam-extraction-principle','exam-fire-basics','exam-it-basics','exam-coffee-basics','exam-legal-regulations') \
   GROUP BY e.id ORDER BY e.id;"

sudo -u postgres psql -d t12_exams -c \
  "SELECT e.id, count(DISTINCT ea.subject_id) AS assigned_users \
   FROM exams e LEFT JOIN exam_assignments ea \
     ON ea.exam_id = e.id AND ea.subject_type = 'user' \
   WHERE e.id IN ('exam-extraction-principle','exam-fire-basics','exam-it-basics','exam-coffee-basics','exam-legal-regulations') \
   GROUP BY e.id ORDER BY e.id;"
```

预期题目数和分值为：萃取原理 `43 / 101 / 85.85`，消防基础 `32 / 100 / 85`，IT 基础 `34 / 86 / 73.10`，咖啡基础知识 `100 / 100 / 85`，餐饮相关法律法规 `53 / 100 / 85`；咖啡考试时长为 `3600` 秒，餐饮法规考试时长为 `2400` 秒。两个咖啡图片地址应返回 HTTP 200。任何一项不一致都应停止验收，保留数据库备份并联系管理员处理。

## 清洁卫生题库修复

执行位置：阿里云 Workbench。本步骤只补现网清洁卫生题库的空字段，保留已有管理员编辑、分值、题型、考试授权和全部历史答卷快照。

先拉取已合并的 `main`。仓库归 `codexdeploy` 所有，Git 操作必须使用该账户：

```bash
sudo -u codexdeploy -H git -C /opt/t12-online-exams pull --ff-only origin main
```

在写数据库前备份，并先运行只读预览。预览输出应为 36 道题中的待补字段清单；若出现题目数量或历史标识不一致，停止，不执行下一步：

```bash
sudo install -d -m 750 -o postgres -g postgres /var/backups/t12-online-exams
T12_BACKUP_FILE="/var/backups/t12-online-exams/t12_exams-before-cleaning-repair-$(date +%Y%m%d%H%M%S).dump"
sudo -u postgres pg_dump -Fc -f "$T12_BACKUP_FILE" t12_exams
sudo -u postgres test -s "$T12_BACKUP_FILE" && echo "数据库备份完成：$T12_BACKUP_FILE"

sudo env T12_ENV_FILE=/etc/t12-online-exams/t12-online-exams.env \
  /usr/bin/node /opt/t12-online-exams/scripts/repair-cleaning-question-bank.js
```

确认备份和预览均成功后，执行事务修复并重启服务：

```bash
sudo env T12_ENV_FILE=/etc/t12-online-exams/t12-online-exams.env \
  /usr/bin/node /opt/t12-online-exams/scripts/repair-cleaning-question-bank.js --apply

sudo systemctl restart t12-exams
curl -fsS http://127.0.0.1:3001/readyz
```

预期最后输出 `{"status":"ready","database":"ok"}`。修复结果会逐题写入 `audit_logs`，回滚优先使用上述 PostgreSQL 备份；代码回滚不应删除已产生的答卷快照。
