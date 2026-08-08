# 题库 CSV 导入预览

第一版只做 CSV 的解析和校验预览，不连接数据库、不上传图片，也不会写入题库。确认预览无误后，后续步骤才会增加管理员确认与事务写入。

## 模板与字段

模板位于 [question-import-template.csv](templates/question-import-template.csv)。固定表头如下：

```text
external_id,type,stem,option_a,option_b,option_c,option_d,option_e,option_f,answer,score,explanation,tags,difficulty,image_urls
```

- `type` 仅允许 `single`、`multi`、`judge`、`fill`、`qa`。
- 单选、判断题答案填一个选项字母；多选题用 `A|B|C`；问答题的 `answer` 留空，参考答案写入 `explanation`。
- 填空题不填写选项，`answer` 填写一个或多个可接受答案，用 `|` 分隔；自动判分会忽略首尾空格并按不区分大小写匹配，阅卷人仍可人工改分。
- `external_id` 在同一题库内必须唯一；`score` 必须为非负数字。
- 选项从 A 开始连续填写，不能跳过；答案必须存在于选项中。
- `image_urls` 用 `|` 分隔。只允许已经登记的 HTTPS 图片域名，或 `resource:<资源ID>`。

## 本机预览

执行位置：本机终端或阿里云 Workbench 的项目目录。该命令只读取 CSV：

```bash
npm run import:questions:preview -- /path/to/question-bank.csv --allow-image-host images.example.com
```

输出包含总行数、跳过空行数、有效行数和逐行错误。只有 `canCommit: true` 时，后续的确认写入步骤才允许执行。

## 当前 Excel 来源的处理原则

现有萃取原理、IT、消防等 Excel 将在 CSV 校验稳定后增加 XLSX 适配器；不直接把 Excel 上传即写库。萃取原理缺少分数列，填空题也需要先明确评分规则。含有员工、客户或其他个人信息的题干必须先脱敏，再进入题库。
