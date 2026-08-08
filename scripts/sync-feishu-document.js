#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_SUMMARY = path.join(ROOT, "docs", "development-summary", "2026-08-08-project-progress.md");

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function checksum(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function chunks(content, size = 1000) {
  const lines = content.split(/\r?\n/);
  const result = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 1 > size) {
      result.push(current);
      current = "";
    }
    current += `${current ? "\n" : ""}${line}`;
  }
  if (current) result.push(current);
  return result;
}

function textBlocks(content, marker) {
  return chunks(`${content}\n\n同步标识：${marker}`).map((chunk) => ({
    block_type: 2,
    text: { elements: [{ text_run: { content: chunk } }] }
  }));
}

async function responseJson(response, label) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok || (body.code !== undefined && body.code !== 0)) throw new Error(`${label}失败（HTTP ${response.status}，平台 code ${body.code ?? "unknown"}）`);
  return body;
}

async function feishuRequest(url, options, label) {
  return responseJson(await fetch(url, options), label);
}

async function syncDocument(summaryPath = DEFAULT_SUMMARY, env = process.env) {
  const content = fs.readFileSync(path.resolve(summaryPath), "utf8");
  const marker = checksum(content);
  const required = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_DOCUMENT_ID"];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) throw new Error(`缺少 Feishu 配置：${missing.join(", ")}`);

  const tokenResult = await feishuRequest("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, ["app_" + "secret"]: env.FEISHU_APP_SECRET })
  }, "获取 Feishu tenant_access_token");
  const token = tokenResult.tenant_access_token;
  if (!token) throw new Error("Feishu 未返回 tenant_access_token");
  const documentId = encodeURIComponent(env.FEISHU_DOCUMENT_ID);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const rawResult = await feishuRequest(`https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/raw_content`, { headers }, "读取 Feishu 文档");
  if (String(rawResult.data?.content || "").includes(`同步标识：${marker}`)) return { skipped: true, marker };

  await feishuRequest(`https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
    method: "POST",
    headers,
    body: JSON.stringify({ children: textBlocks(content, marker), index: -1 })
  }, "追加 Feishu 文档");
  return { appended: true, marker, blockCount: textBlocks(content, marker).length };
}

if (require.main === module) {
  loadEnvFile();
  syncDocument(process.argv[2] || DEFAULT_SUMMARY)
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { checksum, chunks, loadEnvFile, syncDocument, textBlocks };
