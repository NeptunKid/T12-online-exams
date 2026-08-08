# 结构化题库草稿（2026-08-09）

来源为用户 iCloud 目录中的三份 Excel。以下 CSV 是审阅稿，尚未导入 PostgreSQL，也未发布考试。

| 考试标题 | 草稿文件 | 题数 | 总分 | 考试时长 | 通过线（85%） | 预览状态 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 萃取原理考试 | `extraction-questions.csv` | 43 | 101 | 50 分钟 | 85.85 | 待补图片选项 |
| 消防基础考试 | `fire-questions.csv` | 32 | 100 | 30 分钟 | 85 | 通过 |
| IT 基础考试 | `it-questions.csv` | 34 | 86 | 30 分钟 | 73.10 | 通过 |

## 处理规则

- 萃取原理按：单选 2 分、多选 3 分、判断 2 分、填空 2 分、问答 2.5 分，总分 101。
- 消防保留源表分值，总分 100。
- IT 删除源表中全部 3 道带有“操作题”标记的题目；剩余总分 86。原始 Excel 未被修改。
- 问答题作为人工阅卷题；填空题进入自动判分流程。IT 的两道多空填空题已标记 `needs-review:multi-blank`，当前以完整答案别名暂存，正式发布前需确认输入规则。
- 萃取原理第 18、19 题是图表选项题，选项图片来自 `萃取原理考试图片`，当前 CSV 尚未写入图片资源 ID，因此只读预览会拒绝这两行。

## 本地验证

执行位置：项目目录。本命令只读取 CSV，不写数据库：

```bash
npm run import:questions:preview -- docs/question-bank-drafts/fire-questions.csv
npm run import:questions:preview -- docs/question-bank-drafts/it-questions.csv
npm run import:questions:preview -- docs/question-bank-drafts/extraction-questions.csv
```

结果：消防 32/32 行通过，IT 34/34 行通过；萃取原理 41/43 行通过，失败的两行正是缺少图片选项的第 18、19 题。
