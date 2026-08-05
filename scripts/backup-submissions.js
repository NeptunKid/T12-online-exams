#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const source = process.argv[2];
const destinationDir = process.argv[3] || path.join(process.cwd(), "backups");

if (!source) {
  console.error("用法：node scripts/backup-submissions.js <source.json> [destination-dir]");
  process.exit(2);
}

const sourcePath = path.resolve(source);
if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
  console.error("备份来源不存在或不是文件");
  process.exit(2);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputPath = path.join(path.resolve(destinationDir), `submissions-${timestamp}.json`);
const checksumPath = `${outputPath}.sha256`;
if (fs.existsSync(outputPath) || fs.existsSync(checksumPath)) {
  console.error("目标备份已存在，拒绝覆盖");
  process.exit(3);
}

const content = fs.readFileSync(sourcePath);
JSON.parse(content.toString("utf8"));
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, content, { flag: "wx" });
const checksum = crypto.createHash("sha256").update(content).digest("hex");
fs.writeFileSync(checksumPath, `${checksum}  ${path.basename(outputPath)}\n`, { flag: "wx" });
console.log(`已创建备份：${outputPath}`);
console.log(`SHA-256：${checksum}`);
