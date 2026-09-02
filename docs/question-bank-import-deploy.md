# 题库与受控图片部署

## 题库维护页 CSV 导入导出

部署最新 `main` 后，管理员进入“题库维护”，选择题库即可使用“导出 CSV”或“导入 CSV”。导入采用 `docs/templates/question-import-template.csv` 的固定表头，服务端会先校验题型、编号、答案、分数和受控图片，再在单一事务中写入指定题库；重复 `external_id` 或任一行失败会整批回滚，不会创建试卷、考试授权或修改其他题库。题库导出的 `score` 固定为 `0`，实际分值由组卷设置。

问答题的 `answer` 列是阅卷参考答案（不参与自动判分），`explanation` 列仍是题目解析。旧 Excel 中若参考答案位于“答案解析”列，转换脚本会自动兼容迁移到 `answer`。

本步骤包含六份已确认的 Excel 题库：萃取原理、消防基础、IT 基础、杯测基础知识、咖啡基础知识、餐饮相关法律法规。两组待人工审核的 PDF 和咖啡师招聘笔试不在导入范围内。

## 本机验证

```bash
cd $HOME/Documents/Codex/003_考试后台追踪系统_钉钉飞书接入版
npm run check
node scripts/preview-question-csv.js docs/question-bank-drafts/extraction-questions.csv
node scripts/preview-question-csv.js docs/question-bank-drafts/fire-questions.csv
node scripts/preview-question-csv.js docs/question-bank-drafts/it-questions.csv
node scripts/preview-question-csv.js docs/question-bank-drafts/cupping-questions.csv
node scripts/preview-question-csv.js docs/question-bank-drafts/coffee-questions.csv
```

萃取原理第 17 题绑定 `resource:extraction-17-a` 至 `resource:extraction-17-d`，第 18 题绑定 `resource:extraction-18-a` 至 `resource:extraction-18-e`。资源清单和 SHA-256 位于 `public/question-resources/manifest.json`。

## 阿里云 Workbench：拉取并导入

以下命令在服务器 Workbench 执行。先确认项目路径，若 `test` 失败不要继续：

```bash
cd /opt/t12-online-exams
test -f package.json && test -f public/question-resources/manifest.json
sudo -u codexdeploy -H git -C /opt/t12-online-exams pull --ff-only origin main
sudo -u codexdeploy -H sh -c 'cd /opt/t12-online-exams && npm ci'
```

导入前先备份 PostgreSQL（不会修改答卷）：

```bash
sudo install -d -m 711 -o root -g root /var/backups/t12-online-exams
sudo install -d -m 700 -o postgres -g postgres /var/backups/t12-online-exams/postgres
T12_BACKUP_FILE="/var/backups/t12-online-exams/postgres/t12_exams-before-question-import-$(date +%Y%m%d%H%M%S).dump"
sudo -u postgres pg_dump -Fc -f "$T12_BACKUP_FILE" t12_exams
sudo -u postgres test -s "$T12_BACKUP_FILE" && echo "数据库备份完成：$T12_BACKUP_FILE"
```

确认备份命令成功后，在同一目录执行迁移。迁移会新增可回滚的 `0005_question_stem_images` 字段：

```bash
sudo env T12_ENV_FILE=/etc/t12-online-exams/t12-online-exams.env \
  /usr/bin/npm run migrate
```

迁移成功后，如本次需求只是新增题库（不创建考试、组卷或授权），执行以下“仅题库”命令。它只写入 `question_banks` 和 `questions`，不会写入 `exams`、`exam_questions` 或 `exam_assignments`：

```bash
cd /opt/t12-online-exams
sudo env T12_ENV_FILE=/etc/t12-online-exams/t12-online-exams.env \
  /usr/bin/node /opt/t12-online-exams/scripts/import-question-banks.js \
  --question-bank-only \
  --only cupping
```

预期输出中的 `assignmentMode` 为 `question_bank_only`、`assignmentCount` 为 `0`、`exams` 为空数组，并列出 `banks: [{"bankId":"bank-cupping-basics","questions":47,...}]`。若以后需要从题库创建并发布考试，再使用下面的“考试导入”模式；本次不要执行该模式。

仅题库导入后的核对（仍在阿里云 Workbench 执行）：

```bash
sudo -u postgres psql -d t12_exams -c \
  "SELECT qb.id, qb.name, qb.status, count(q.id) AS questions \
   FROM question_banks qb LEFT JOIN questions q ON q.bank_id = qb.id \
   WHERE qb.id = 'bank-cupping-basics' GROUP BY qb.id, qb.name, qb.status;"
sudo -u postgres psql -d t12_exams -c \
  "SELECT count(*) AS exam_rows FROM exams WHERE id = 'exam-cupping-basics';"
```

预期题库核对为 `bank-cupping-basics / 杯测基础知识 / active / 47`，`exam_rows` 必须为 `0`。

## 考试导入模式（其他题库或明确需要创建考试时）

`--publish` 会将选中的考试设为 `published`；`--all-active-dingtalk-users` 会给所有已登录、状态为 `active` 的钉钉用户建立授权。餐饮法规只导入该题库时：

```bash
cd /opt/t12-online-exams
sudo env T12_ENV_FILE=/etc/t12-online-exams/t12-online-exams.env \
  /usr/bin/node scripts/import-question-banks.js \
  --all-active-dingtalk-users \
  --only legal \
  --publish
```

`--only legal` 确保本次只导入餐饮相关法律法规，不核对或修改已经上线的考试。若需导入杯测基础知识，可改为 `--only cupping`；若需导入咖啡基础知识，可改为 `--only coffee`；若需完整初始化六份结构化题库，可移除该参数。杯测基础知识按每题 1 分、30 分钟考试时长和 85% 通过线配置。若只需给单个员工授权，可改用 `--union-id '<钉钉 unionId>' --user-name '<员工姓名>'`；真实身份值不得写入 Git。导入脚本会校验题库数量、题目内容、总分、考试时长和 85% 通过线；重复执行不会重复创建，已有内容不一致时会整笔回滚并报错。

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
   WHERE e.id IN ('exam-extraction-principle','exam-fire-basics','exam-it-basics','exam-cupping-basics','exam-coffee-basics','exam-legal-regulations') \
   GROUP BY e.id ORDER BY e.id;"

sudo -u postgres psql -d t12_exams -c \
  "SELECT e.id, count(DISTINCT ea.subject_id) AS assigned_users \
   FROM exams e LEFT JOIN exam_assignments ea \
     ON ea.exam_id = e.id AND ea.subject_type = 'user' \
   WHERE e.id IN ('exam-extraction-principle','exam-fire-basics','exam-it-basics','exam-cupping-basics','exam-coffee-basics','exam-legal-regulations') \
   GROUP BY e.id ORDER BY e.id;"
```

预期题目数和分值为：萃取原理 `43 / 101 / 85.85`，消防基础 `32 / 100 / 85`，IT 基础 `34 / 86 / 73.10`，杯测基础知识 `47 / 47 / 39.95`，咖啡基础知识 `100 / 100 / 85`，餐饮相关法律法规 `53 / 100 / 85`；杯测考试时长为 `1800` 秒，咖啡考试时长为 `3600` 秒，餐饮法规考试时长为 `2400` 秒。两个咖啡图片地址应返回 HTTP 200。任何一项不一致都应停止验收，保留数据库备份并联系管理员处理。

## 清洁卫生题库修复

执行位置：阿里云 Workbench。本步骤只补现网清洁卫生题库的空字段，保留已有管理员编辑、分值、题型、考试授权和全部历史答卷快照。

先拉取已合并的 `main`。仓库归 `codexdeploy` 所有，Git 操作必须使用该账户：

```bash
sudo -u codexdeploy -H git -C /opt/t12-online-exams pull --ff-only origin main
```

在写数据库前备份，并先运行只读预览。预览输出应为 36 道题中的待补字段清单；若出现题目数量或历史标识不一致，停止，不执行下一步：

```bash
sudo install -d -m 711 -o root -g root /var/backups/t12-online-exams
sudo install -d -m 700 -o postgres -g postgres /var/backups/t12-online-exams/postgres
T12_BACKUP_FILE="/var/backups/t12-online-exams/postgres/t12_exams-before-cleaning-repair-$(date +%Y%m%d%H%M%S).dump"
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
