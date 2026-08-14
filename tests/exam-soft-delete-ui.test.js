const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const script = fs.readFileSync(path.join(__dirname, "../public/admin.js"), "utf8");

test("试卷管理提供带明确确认的可恢复删除和恢复操作", () => {
  assert.match(script, /id="archiveExamBtn"[\s\S]*>删除试卷<\/button>/);
  assert.match(script, /id="restoreExamBtn"[\s\S]*>恢复试卷<\/button>/);
  assert.match(script, /确认删除试卷/);
  assert.match(script, /不会物理删除试卷、版本和历史答卷/);
  assert.match(script, /\/archive`, \{/);
  assert.match(script, /\/restore`, \{/);
  assert.match(script, /恢复为草稿/);
});

test("已删除试卷继续显示在管理员列表供恢复", () => {
  assert.match(script, /archived: "已删除（可恢复）"/);
  assert.match(script, /该试卷已删除并保留在系统中/);
});
