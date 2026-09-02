# 杯测基础知识题库导入准备：2026-09-02

## 本轮范围

- 读取用户提供的 `杯测入门题库-题库-8828eb2c-46d5-4a78-8ea2-6eae64b23abe.xlsx`，未读取或修改 001/002 项目。
- 新增 `cupping` 导入 key，对应题库 `bank-cupping-basics`、考试 `exam-cupping-basics`，显示名称为“杯测基础知识”。
- Excel 单页共 47 道题：问答 14、填空 4、判断 19、多选 1、单选 9；源表没有分值列，按每题 1 分，总分 47，考试时长按 30 分钟（1800 秒）配置，通过线为 39.95。
- 生成 `docs/question-bank-drafts/cupping-questions.csv`，保留标签、解析和填空答案别名；源文件未包含可导入图片资源。

## 修改文件

- `scripts/generate-xlsx-drafts.py`
- `scripts/import-question-banks.js`
- `tests/question-bank-import.test.js`
- `docs/question-bank-drafts/README.md`
- `docs/question-bank-import-deploy.md`
- `docs/question-source-inventory-2026-08-08.md`
- `docs/question-bank-drafts/cupping-questions.csv`
- `杯测入门题库-题库-8828eb2c-46d5-4a78-8ea2-6eae64b23abe.xlsx`

## 验证结果

- `npm run import:questions:preview -- docs/question-bank-drafts/cupping-questions.csv`：47/47 行有效，`canCommit: true`。
- 新增题库导入测试及既有导入测试共 13 项通过。
- 全量 `npm test`：370 项通过。
- `npm run check:syntax`、`npm run check:secrets`、`git diff --check`：通过。

## 数据库与生产状态

本轮未连接 PostgreSQL，未执行数据库写入、生产部署或通知调用；本机未配置数据库连接。生产导入必须在阿里云 Workbench 按 `docs/question-bank-import-deploy.md` 执行，先创建并记录 `pg_dump -Fc` 备份，再使用 `--question-bank-only --only cupping` 导入。该模式不会创建考试、组卷或授权。

## 风险与回滚

- 每题 1 分和 30 分钟为缺少源字段时的显式默认值；若业务负责人要求不同分值/时长，应在生产导入前修改草稿和测试。
- 题库导入脚本使用事务，重复导入会校验内容一致性；内容不一致会整体回滚。生产回滚优先使用导入前 PostgreSQL 备份，不通过代码回退删除答卷或快照。
