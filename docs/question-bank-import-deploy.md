# 题库与受控图片部署

本步骤包含三份已确认的 Excel 题库：萃取原理、消防基础、IT 基础。两组待人工审核的 PDF 和咖啡师招聘笔试不在导入范围内。

## 本机验证

```bash
cd $HOME/Documents/Codex/003_考试后台追踪系统_钉钉飞书接入版
npm run check
node scripts/preview-question-csv.js docs/question-bank-drafts/extraction-questions.csv
node scripts/preview-question-csv.js docs/question-bank-drafts/fire-questions.csv
node scripts/preview-question-csv.js docs/question-bank-drafts/it-questions.csv
```

萃取原理第 17 题绑定 `resource:extraction-17-a` 至 `resource:extraction-17-d`，第 18 题绑定 `resource:extraction-18-a` 至 `resource:extraction-18-e`。资源清单和 SHA-256 位于 `public/question-resources/manifest.json`。

## 阿里云 Workbench：拉取并导入

以下命令在服务器 Workbench 执行。先确认项目路径，若 `test` 失败不要继续：

```bash
cd /opt/t12-online-exams
test -f package.json && test -f public/question-resources/manifest.json
git pull --ff-only origin main
npm ci
npm run migrate
```

导入前先备份 PostgreSQL（不会修改答卷）：

```bash
sudo -u postgres pg_dump -Fc t12_exams > "/var/backups/t12_exams-before-question-import-$(date +%Y%m%d%H%M%S).dump"
```

确认备份命令成功后，在同一目录执行事务导入。`--publish` 会将三份考试设为 `published` 并给指定钉钉 `unionId` 建立授权；不加 `--publish` 只写入草稿：

```bash
cd /opt/t12-online-exams
node scripts/import-question-banks.js \
  --union-id '9yuUiPzleiPnEeaiSviSSlXEVwiEiE' \
  --user-name '授权员工' \
  --publish
```

导入脚本会校验题库数量、题目内容、总分、考试时长和 85% 通过线；重复执行不会重复创建，已有内容不一致时会整笔回滚并报错。

导入完成后重启服务并验证资源与数据库：

```bash
sudo systemctl restart t12-exams
curl -fsS http://127.0.0.1:3001/healthz
curl -fsS http://127.0.0.1:3001/readyz
curl -I https://exam.t12group.com/question-resources/extraction/extraction-17-a.png
sudo -u postgres psql -d t12_exams -c \
  "SELECT e.id, e.title, e.status, count(eq.question_id) AS questions, e.total_score, e.pass_score \
   FROM exams e LEFT JOIN exam_questions eq ON eq.exam_id = e.id \
   WHERE e.id IN ('exam-extraction-principle','exam-fire-basics','exam-it-basics') \
   GROUP BY e.id ORDER BY e.id;"
```

预期题目数和分值为：萃取原理 `43 / 101 / 85.85`，消防基础 `32 / 100 / 85`，IT 基础 `34 / 86 / 73.10`。任何一项不一致都应停止验收，保留数据库备份并联系管理员处理。
