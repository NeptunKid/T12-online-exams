const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/admin.html"), "utf8");
const script = fs.readFileSync(path.join(root, "public/admin.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");

test("系统管理员后台提供通知任务入口、筛选和脱敏列表", () => {
  assert.match(html, /id="manageNotificationsBtn"/);
  assert.match(html, /id="notificationManagerDialog"/);
  assert.match(html, /id="notificationStatusFilter"/);
  assert.match(script, /manageNotificationsBtn.*openNotificationManager/);
  assert.match(script, /recipientRef/);
  assert.doesNotMatch(script, /item\.recipient\b/);
});

test("只有失败或已放弃任务显示人工重发按钮", () => {
  assert.match(script, /item\.retryable/);
  assert.match(script, /\/api\/admin\/notifications\/\$\{encodeURIComponent\(notificationId\)\}\/retry/);
  assert.match(script, /method: "POST"/);
});

test("通知任务布局在手机端改为单列且操作按钮不溢出", () => {
  assert.match(styles, /\.notification-row\s*\{[\s\S]*min-width:\s*0/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*\.notification-row[\s\S]*flex-direction:\s*column/);
  assert.match(styles, /\.notification-row \.notification-retry-btn[\s\S]*width:\s*100%/);
});
