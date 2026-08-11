const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/admin.html"), "utf8");
const script = fs.readFileSync(path.join(root, "public/admin.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");

test("管理员后台提供题库和试卷备份入口", () => {
  assert.match(html, /id="manageBackupsBtn"/);
  assert.match(html, /id="backupManagerDialog"/);
  assert.match(html, /id="backupExamSelect"/);
  assert.match(html, /id="backupQuestionBankSelect"/);
  assert.match(script, /document\.getElementById\("manageBackupsBtn"\)\.addEventListener\("click", openBackupManager\)/);
});

test("导出接口携带类型和记录 ID 并下载二进制备份包", () => {
  assert.match(script, /new URLSearchParams\(\{ kind, id \}\)/);
  assert.match(script, /fetch\(`\/api\/admin\/backups\/export\?\$\{query\.toString\(\)\}`\)/);
  assert.match(script, /exportBackup\("exam", document\.getElementById\("backupExamSelect"\)\.value\)/);
  assert.match(script, /exportBackup\("question-bank", document\.getElementById\("backupQuestionBankSelect"\)\.value\)/);
  assert.match(script, /URL\.createObjectURL\(blob\)/);
  assert.match(script, /content-disposition/);
});

test("导入使用 backup 字段上传完整文件且不手工设置 multipart boundary", () => {
  assert.match(html, /id="backupImportFile"[^>]*accept="\.t12backup,\.zip/);
  assert.match(script, /const form = new FormData\(\)/);
  assert.match(script, /form\.append\("backup", file, file\.name\)/);
  assert.match(script, /fetch\("\/api\/admin\/backups\/import", \{ method: "POST", body: form \}\)/);
  assert.doesNotMatch(script, /multipart\/form-data/);
});

test("导入导出在进行中禁止重复操作或关闭弹窗", () => {
  assert.match(script, /if \(backupBusy \|\| !id\) return/);
  assert.match(script, /if \(backupBusy \|\| !file\) return/);
  assert.match(script, /if \(backupBusy\) event\.preventDefault\(\)/);
  assert.match(html, /id="importBackupBtn"[^>]*disabled/);
});

test("自动备份显示公开状态、支持立即运行和下载历史工件", () => {
  assert.match(html, /id="backupAutomationMeta"/);
  assert.match(html, /id="runBackupAutomationBtn"[^>]*disabled/);
  assert.match(html, /id="backupRunList"/);
  assert.match(script, /api\("\/api\/admin\/backups\/automation"\)/);
  assert.match(script, /api\("\/api\/admin\/backups\/automation\/run", \{ method: "POST", body: "\{\}" \}\)/);
  assert.match(script, /\/api\/admin\/backups\/artifacts\/\$\{encodeURIComponent\(artifactId\)\}/);
  assert.match(script, /stored-backup-download-btn/);
  assert.doesNotMatch(script, /storageKey/);
});

test("备份界面具备桌面双栏和手机单栏布局", () => {
  assert.match(css, /\.backup-manager-grid \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*\.backup-manager-grid,[\s\S]*\.backup-control-row \{\s*grid-template-columns: 1fr/);
});
