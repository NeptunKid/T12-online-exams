#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { previewQuestionCsv } = require("../src/import/question-csv");

function parseArgs(argv) {
  const args = { file: "", allowedImageHosts: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--allow-image-host") args.allowedImageHosts.push(argv[++index] || "");
    else if (value === "--help") return null;
    else if (!args.file) args.file = value;
    else throw new Error(`不支持的参数：${value}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args || !args.file) {
    console.log("用法：node scripts/preview-question-csv.js <题库.csv> [--allow-image-host images.example.com]");
    return 2;
  }
  const sourcePath = path.resolve(args.file);
  if (!fs.existsSync(sourcePath)) throw new Error(`文件不存在：${sourcePath}`);
  const preview = previewQuestionCsv(fs.readFileSync(sourcePath, "utf8"), args);
  console.log(JSON.stringify({
    source: path.basename(sourcePath),
    totalRows: preview.totalRows,
    skippedRows: preview.skippedRows,
    validRows: preview.validRows,
    canCommit: preview.canCommit,
    errors: preview.errors
  }, null, 2));
  return preview.canCommit ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error.message || "CSV 预览失败");
  process.exitCode = 2;
}
