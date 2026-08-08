#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ALLOWED = [
  ["17-A.png", "resource:extraction-17-a"], ["17-B.png", "resource:extraction-17-b"],
  ["17-C.png", "resource:extraction-17-c"], ["17-D.png", "resource:extraction-17-d"],
  ["18-A.png", "resource:extraction-18-a"], ["18-B.png", "resource:extraction-18-b"],
  ["18-C.png", "resource:extraction-18-c"], ["18-D.png", "resource:extraction-18-d"],
  ["18-E.png", "resource:extraction-18-e"]
];

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function parseArgs(argv) {
  const args = { sourceDir: "", outputDir: path.join(__dirname, "../public/question-resources") };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--source-dir") args.sourceDir = argv[++index] || "";
    else if (argv[index] === "--output-dir") args.outputDir = argv[++index] || args.outputDir;
    else throw new Error(`不支持的参数：${argv[index]}`);
  }
  if (!args.sourceDir) throw new Error("必须提供 --source-dir");
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = path.resolve(args.sourceDir);
  const outputDir = path.resolve(args.outputDir);
  const extractionDir = path.join(outputDir, "extraction");
  fs.mkdirSync(extractionDir, { recursive: true });
  const resources = {};
  for (const [sourceName, resourceId] of ALLOWED) {
    const source = path.join(sourceDir, sourceName);
    if (!fs.existsSync(source)) throw new Error(`缺少图片资源：${source}`);
    const targetName = `${resourceId.replace(/^resource:/, "")}.png`;
    const target = path.join(extractionDir, targetName);
    const sourceHash = sha256(source);
    if (fs.existsSync(target) && sha256(target) !== sourceHash) {
      throw new Error(`受控资源已存在但内容不同，拒绝覆盖：${target}`);
    }
    if (!fs.existsSync(target)) fs.copyFileSync(source, target);
    const stat = fs.statSync(target);
    resources[resourceId] = {
      file: `extraction/${targetName}`,
      url: `/question-resources/extraction/${targetName}`,
      mediaType: "image/png",
      bytes: stat.size,
      sha256: sourceHash
    };
  }
  const manifest = { version: 1, generatedAt: new Date().toISOString(), resources };
  fs.writeFileSync(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`已建立 ${Object.keys(resources).length} 个受控资源映射：${path.join(outputDir, "manifest.json")}`);
}

try {
  main();
} catch (error) {
  console.error(error.message || "资源映射失败");
  process.exitCode = 1;
}
