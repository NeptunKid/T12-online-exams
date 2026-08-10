#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function parseArgs(argv) {
  const args = {
    sourceDir: "",
    outputDir: path.join(__dirname, "../public/question-resources")
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--source-dir") args.sourceDir = argv[++index] || "";
    else if (argv[index] === "--output-dir") args.outputDir = argv[++index] || args.outputDir;
    else if (argv[index] === "--help") return null;
    else throw new Error(`不支持的参数：${argv[index]}`);
  }
  if (!args.sourceDir) throw new Error("必须提供 --source-dir");
  return args;
}

function loadManifest(file) {
  if (!fs.existsSync(file)) return { version: 1, resources: {} };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return { version: 1, resources: parsed.resources || {} };
}

function resourceFor(file) {
  const match = file.match(/^(\d+)-(\d+|[A-J])\.(png|jpe?g)$/i);
  if (!match) return null;
  const number = match[1];
  const part = match[2].toLowerCase();
  const extension = match[3].toLowerCase() === "jpg" ? "jpeg" : match[3].toLowerCase();
  return {
    id: `resource:cleaning-${number}-${part}`,
    filename: `cleaning-${number}-${part}.${extension}`,
    mediaType: extension === "png" ? "image/png" : "image/jpeg"
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.log("用法：node scripts/prepare-cleaning-question-resources.js --source-dir <清洁卫生图片目录> [--output-dir <目录>]");
    return;
  }
  const sourceDir = path.resolve(args.sourceDir);
  const outputDir = path.resolve(args.outputDir);
  const targetDir = path.join(outputDir, "cleaning");
  const manifestPath = path.join(outputDir, "manifest.json");
  const manifest = loadManifest(manifestPath);
  const prepared = [];

  fs.mkdirSync(targetDir, { recursive: true });
  for (const sourceName of fs.readdirSync(sourceDir).sort()) {
    const descriptor = resourceFor(sourceName);
    if (!descriptor) continue;
    const source = path.join(sourceDir, sourceName);
    if (!fs.statSync(source).isFile()) continue;
    const target = path.join(targetDir, descriptor.filename);
    const sourceHash = sha256(source);
    if (fs.existsSync(target) && sha256(target) !== sourceHash) {
      throw new Error(`受控资源已存在但内容不同，拒绝覆盖：${target}`);
    }
    if (!fs.existsSync(target)) fs.copyFileSync(source, target);
    const stat = fs.statSync(target);
    manifest.resources[descriptor.id] = {
      file: `cleaning/${descriptor.filename}`,
      url: `/question-resources/cleaning/${descriptor.filename}`,
      mediaType: descriptor.mediaType,
      bytes: stat.size,
      sha256: sourceHash
    };
    prepared.push(descriptor.id);
  }
  if (!prepared.length) throw new Error("没有找到符合 <题号>-<图片编号>.<扩展名> 的清洁卫生图片");
  fs.writeFileSync(manifestPath, `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), resources: manifest.resources }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ prepared: prepared.length, resources: prepared, manifestPath }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message || "清洁卫生图片资源准备失败");
  process.exitCode = 1;
}
