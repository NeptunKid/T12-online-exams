#!/usr/bin/env node

const { createPostgresPool } = require("../src/db/postgres-client");
const {
  buildMergeCandidateGroups,
  loadIdentityRows,
  mergeUser
} = require("../src/db/user-merge-repository");
const { loadEnvFile } = require("./migrate");

function parseArgs(argv) {
  const unknown = argv.filter((value) => value !== "--help");
  if (unknown.length) {
    throw new Error(`${unknown[0]} 已停用；身份合并必须由系统管理员在后台预览并确认`);
  }
  return { help: argv.includes("--help") };
}

function buildReconciliationPlan(rows) {
  const groups = buildMergeCandidateGroups(rows);
  return {
    merges: groups.filter((group) => !group.ambiguous).map((group) => ({
      realName: group.displayName,
      ...group.pairs[0]
    })),
    ambiguous: groups.filter((group) => group.ambiguous).map((group) => ({
      realName: group.displayName,
      candidates: group.users.map((user) => ({ id: user.id, providers: user.providers }))
    }))
  };
}

async function reconcile(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const plan = buildReconciliationPlan(await loadIdentityRows(client));
    await client.query("ROLLBACK");
    return { mode: "dry-run", ...plan, applied: 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("用法：node scripts/reconcile-cross-platform-users.js");
    console.log("该脚本只预览同名候选；实际合并必须由系统管理员在后台确认。");
    return;
  }
  loadEnvFile();
  const pool = createPostgresPool();
  try {
    console.log(JSON.stringify(await reconcile(pool), null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || "跨平台用户整理失败");
    process.exitCode = 1;
  });
}

module.exports = { buildReconciliationPlan, mergeUser, parseArgs, reconcile };
