# 结构化题库草稿（2026-08-09）

来源为用户提供的四份 Excel。以下 CSV 是结构化审阅稿；前三份已导入 PostgreSQL，咖啡基础知识尚待本次 PR 合并后导入。

| 考试标题 | 草稿文件 | 题数 | 总分 | 考试时长 | 通过线（85%） | 预览状态 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 萃取原理考试 | `extraction-questions.csv` | 43 | 101 | 50 分钟 | 85.85 | 待补图片选项 |
| 消防基础考试 | `fire-questions.csv` | 32 | 100 | 30 分钟 | 85 | 通过 |
| IT 基础考试 | `it-questions.csv` | 34 | 86 | 30 分钟 | 73.10 | 通过 |
| 咖啡基础知识 | `coffee-questions.csv` | 100 | 100 | 60 分钟 | 85 | 通过 |

清洁卫生入职培训考试的原始题库另生成 `cleaning-question-repair.json`，仅用于修复现网题库中缺失的题干、选项、答案、解析及受控图片。该来源表的分值合计为 101，而现网考试维持既有 100 分，修复脚本不会更新分值或题型。

## 处理规则

- 萃取原理按：单选 2 分、多选 3 分、判断 2 分、填空 2 分、问答 2.5 分，总分 101。
- 消防保留源表分值，总分 100。
- IT 删除源表中全部 3 道带有“操作题”标记的题目；剩余总分 86。原始 Excel 未被修改。
- 咖啡基础知识源表没有分值列；按 100 题结构统一设为每题 1 分，总分 100。题型为 33 道单选、12 道多选、31 道判断、4 道填空和 20 道问答。
- 咖啡源表第 39 行的选项从 C 跳至 F；审阅稿将“苦味”压缩为选项 E，并将答案由 `A|B|C|F` 同步为 `A|B|C|E`，文字和答案含义未改变。
- 咖啡题库第 78、84 题已补充受控题干图片，资源 ID 为 `resource:coffee-cherry-structure` 和 `resource:coffee-siphon`，图片清单位于 `public/question-resources/manifest.json`。
- 问答题作为人工阅卷题；填空题进入自动判分流程。IT 的两道多空填空题已标记 `needs-review:multi-blank`，当前以完整答案别名暂存，正式发布前需确认输入规则。
- 萃取原理第 18、19 题是图表选项题，选项图片来自 `萃取原理考试图片`，当前 CSV 尚未写入图片资源 ID，因此只读预览会拒绝这两行。

## 本地验证

执行位置：项目目录。本命令只读取 CSV，不写数据库：

```bash
npm run import:questions:preview -- docs/question-bank-drafts/fire-questions.csv
npm run import:questions:preview -- docs/question-bank-drafts/it-questions.csv
npm run import:questions:preview -- docs/question-bank-drafts/extraction-questions.csv
npm run import:questions:preview -- docs/question-bank-drafts/coffee-questions.csv
```

结果：四份 CSV 均已通过预览；咖啡基础知识为 100/100 行有效、0 行跳过。
