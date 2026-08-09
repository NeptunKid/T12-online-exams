# 生产考试流程修复部署

本次修复包含：清洁卫生考试 45 分钟时长、四份考试的全员授权、PostgreSQL 答卷阅卷和已批阅答卷完整题目内容。

## 阿里云 Workbench

先更新代码并创建不可覆盖的数据库备份：

```bash
sudo -u codexdeploy -H git -C /opt/t12-online-exams pull --ff-only origin main
sudo -u codexdeploy -H /usr/bin/npm --prefix /opt/t12-online-exams ci

sudo install -d -o postgres -g postgres -m 700 /var/backups/t12-online-exams
BACKUP="/var/backups/t12-online-exams/t12_exams-before-workflow-fix-$(date +%Y%m%d%H%M%S).dump"
sudo -u postgres pg_dump -Fc -f "$BACKUP" t12_exams
sudo test -s "$BACKUP" && sudo ls -lh "$BACKUP"
```

备份成功后执行迁移：

```bash
sudo env T12_ENV_FILE=/etc/t12-online-exams/t12-online-exams.env \
  /usr/bin/npm --prefix /opt/t12-online-exams run migrate
```

对账考试时长、全员授权和答卷数量：

```bash
sudo -u postgres psql -d t12_exams -c "
SELECT e.title, e.duration_seconds / 60 AS duration_minutes,
  count(DISTINCT ea.id) FILTER (
    WHERE ea.subject_type = 'group'
      AND ea.subject_id = 'all-active-dingtalk-users'
  ) AS global_assignments,
  count(DISTINCT s.id) AS submissions
FROM exams e
LEFT JOIN exam_assignments ea ON ea.exam_id = e.id
LEFT JOIN submissions s ON s.exam_id = e.id
WHERE e.status IN ('scheduled', 'published', 'paused')
GROUP BY e.id
ORDER BY e.created_at, e.id;"
```

每份已开放考试的 `global_assignments` 应为 `1`，清洁卫生考试的 `duration_minutes` 应为 `45`。

重启并等待就绪：

```bash
sudo systemctl restart t12-exams
for i in {1..20}; do
  curl -fsS http://127.0.0.1:3001/readyz && echo && break
  sleep 1
done
curl -I https://exam.t12group.com/
```

## 验收

- 新考生重新登录后能看到四份考试，清洁卫生考试显示 45 分钟。
- 管理员后台能搜索“消防基础考试”并看到新提交答卷。
- 管理员可保存阅卷分数，考生已批阅详情显示题干、选项、作答、标准答案、解析和得分。

任一数量、分数或历史答卷不一致时停止验收，保留备份并不执行手工删除。
