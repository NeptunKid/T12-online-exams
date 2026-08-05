#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = process.cwd();
const ignored = /(^|[\\/])(?:\.git|node_modules|backups|logs|data)(?:[\\/]|$)|\.env(?:\.|$)/;
const privateKeyPattern = /-----BEGIN [A-Z ]+ PRIVATE KEY-----/;
const tokenPattern = /\b(?:ghp_|github_pat_|sk-|xox[baprs]-)[A-Za-z0-9_\-]{12,}/;
const assignmentPattern = /\b(?:client[_-]?secret|app[_-]?secret|access[_-]?token|api[_-]?key|private[_-]?key)\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_\-/.+=]+))/i;

function hasSecretValue(line) {
  if (privateKeyPattern.test(line) || tokenPattern.test(line)) return true;
  const match = line.match(assignmentPattern);
  if (!match) return false;
  const value = match.slice(1).find(Boolean) || "";
  if (/^[A-Z][A-Z0-9_]+$/.test(value)) return false;
  if (/^(?:example|placeholder|changeme|your[_-]?value|xxx)$/i.test(value)) return false;
  return value.length >= 12;
}

let files;
try {
  files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
} catch (_) {
  files = [];
}

const findings = [];
for (const relative of files) {
  if (ignored.test(relative)) continue;
  const absolute = path.join(root, relative);
  let text;
  try {
    const buffer = fs.readFileSync(absolute);
    if (buffer.includes(0)) continue;
    text = buffer.toString("utf8");
  } catch (_) {
    continue;
  }
  text.split(/\r?\n/).forEach((line, index) => {
    if (hasSecretValue(line)) {
      findings.push(`${relative}:${index + 1}`);
    }
  });
}

if (findings.length) {
  console.error("发现疑似敏感信息（仅输出文件位置，不输出内容）：");
  findings.forEach((item) => console.error(`- ${item}`));
  process.exit(1);
}

console.log("敏感信息扫描通过");
