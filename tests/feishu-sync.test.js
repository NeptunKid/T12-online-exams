const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  chunks,
  checksum,
  loadEnvFile,
  markdownToPlainText,
  plainTextMarker,
  syncDocument,
  textBlocks
} = require("../scripts/sync-feishu-document");

test("Feishu 总结同步按长度拆分文本并生成稳定标识", () => {
  const content = "第一行\n第二行\n".repeat(150);
  const marker = checksum(content);
  const parts = chunks(content, 1000);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 1000));
  const blocks = textBlocks(content, marker);
  assert.ok(blocks.length > 1);
  assert.match(blocks.at(-1).text.elements[0].text_run.content, new RegExp(`同步标识：${marker}`));
});

test("Feishu 同步缺少配置时不发起网络请求", async () => {
  await assert.rejects(() => syncDocument(path.join(__dirname, "../docs/development-summary/2026-08-08-project-progress.md"), {}), /缺少 Feishu 配置/);
});

test("Feishu 同步发送前移除 Markdown 格式并保留正文", () => {
  const markdown = [
    "# 开发总结",
    "---",
    "",
    "***范围***",
    "- 修改 `server.js`",
    "  - 保留正文",
    "- 查看 [PR](https://example.test/pr/1)",
    "",
    "| 字段 | 结果 |",
    "| --- | --- |",
    "| 测试 | 通过 |",
    "",
    "```text",
    "npm run check",
    "```"
  ].join("\n");
  const plainText = markdownToPlainText(markdown);
  assert.equal(plainText, [
    "开发总结",
    "",
    "范围",
    "修改 server.js",
    "保留正文",
    "查看 PR（https://example.test/pr/1）",
    "",
    "字段；结果",
    "测试；通过",
    "",
    "npm run check"
  ].join("\n"));
  assert.doesNotMatch(plainText, /[#*`|\[\]]/);
});

test("纯文本同步标识与旧 Markdown 标识不同且保持稳定", () => {
  const markdown = "# 标题\n\n- 内容";
  assert.notEqual(plainTextMarker(markdown), checksum(markdown));
  assert.equal(plainTextMarker(markdown), plainTextMarker(markdown));
});

test("Feishu 同步可以读取生产环境指定的配置文件", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t12-feishu-env-"));
  const envPath = path.join(directory, "production.env");
  const key = "T12_FEISHU_SYNC_TEST_VALUE";
  fs.writeFileSync(envPath, `${key}=loaded\n`);
  t.after(() => {
    delete process.env[key];
    fs.rmSync(directory, { recursive: true });
  });
  delete process.env[key];
  loadEnvFile(envPath);
  assert.equal(process.env[key], "loaded");
});
