#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const source = process.argv[2];
const destinationDir = process.argv[3] || path.join(process.cwd(), "backups");

function createBackup(sourcePath, destinationDir, now = new Date()) {
  const resolvedSource = path.resolve(sourcePath);
  if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isFile()) {
    throw new Error("备份来源不存在或不是文件");
  }

  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join(path.resolve(destinationDir), `submissions-${timestamp}.json`);
  const checksumPath = `${outputPath}.sha256`;
  if (fs.existsSync(outputPath) || fs.existsSync(checksumPath)) {
    throw new Error("目标备份已存在，拒绝覆盖");
  }

  const content = fs.readFileSync(resolvedSource);
  JSON.parse(content.toString("utf8"));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content, { flag: "wx" });
  const digest = crypto.createHash("sha256").update(content).digest("hex");
  fs.writeFileSync(checksumPath, `${digest}  ${path.basename(outputPath)}\n`, { flag: "wx" });
  return { outputPath, checksumPath, checksum: digest };
}

if (require.main === module) {
  if (!source) {
    console.error("用法：node scripts/backup-submissions.js <source.json> [destination-dir]");
    process.exit(2);
  }

  try {
    const result = createBackup(source, destinationDir);
    console.log(`已创建备份：${result.outputPath}`);
    console.log(`SHA-256：${result.checksum}`);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

module.exports = { createBackup };
