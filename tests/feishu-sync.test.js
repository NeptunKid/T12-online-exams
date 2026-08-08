const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chunks, checksum, syncDocument, textBlocks } = require("../scripts/sync-feishu-document");

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
