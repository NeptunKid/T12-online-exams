#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "db", "migrations");
const DOWN_MIGRATIONS_DIR = path.join(MIGRATIONS_DIR, "down");
const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  checksum char(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);`;

function loadEnvFile() {
  const dbKeys = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"];
  if (dbKeys.every((key) => process.env[key] !== undefined)) return;

  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function listMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{4}_.+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name: name.replace(/\.sql$/, ""),
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"),
      downPath: path.join(DOWN_MIGRATIONS_DIR, name)
    }));
}

function checksum(sql) {
  return crypto.createHash("sha256").update(sql).digest("hex");
}

function databaseEnvironment() {
  const required = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`缺少数据库配置：${missing.join(", ")}`);

  return {
    ...process.env,
    PGHOST: process.env.DB_HOST,
    PGPORT: process.env.DB_PORT,
    PGDATABASE: process.env.DB_NAME,
    PGUSER: process.env.DB_USER,
    PGPASSWORD: process.env.DB_PASSWORD,
    PGSSLMODE: String(process.env.DB_SSL).toLowerCase() === "true" ? "require" : "disable"
  };
}

function runPsql(input, environment, variables = {}, options = {}) {
  const args = ["--no-psqlrc", "--set", "ON_ERROR_STOP=1"];
  if (options.tuplesOnly) args.push("--tuples-only", "--no-align");
  for (const [key, value] of Object.entries(variables)) args.push("--set", `${key}=${value}`);

  const result = spawnSync("psql", args, {
    input,
    encoding: "utf8",
    env: environment
  });
  if (result.error) throw new Error(`无法运行 psql：${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "未知 PostgreSQL 错误").trim();
    throw new Error(`数据库迁移失败：${detail}`);
  }
  return String(result.stdout || "");
}

function readApplied(environment) {
  const output = runPsql(`${MIGRATIONS_TABLE_SQL}\nSELECT name || E'\\t' || checksum FROM schema_migrations ORDER BY name;`, environment, {}, { tuplesOnly: true });
  return new Map(output.split(/\r?\n/).filter(Boolean).map((line) => line.split("\t", 2)));
}

function printPlan(migrations) {
  for (const migration of migrations) {
    const rollback = fs.existsSync(migration.downPath) ? "有" : "无";
    console.log(`${migration.name}  回滚：${rollback}`);
  }
}

function applyMigrations(migrations, environment) {
  const applied = readApplied(environment);
  for (const migration of migrations) {
    const digest = checksum(migration.sql);
    if (applied.has(migration.name)) {
      if (applied.get(migration.name) !== digest) {
        throw new Error(`已执行的迁移 ${migration.name} 校验值不一致，拒绝继续执行`);
      }
      console.log(`跳过已执行迁移：${migration.name}`);
      continue;
    }

    runPsql(`BEGIN;\n${migration.sql}\nINSERT INTO schema_migrations (name, checksum) VALUES (:'migration_name', :'migration_checksum');\nCOMMIT;`, environment, {
      migration_name: migration.name,
      migration_checksum: digest
    });
    console.log(`已执行迁移：${migration.name}`);
  }
}

function rollbackMigration(migrations, environment, migrationName) {
  const index = migrations.findIndex((migration) => migration.name === migrationName);
  if (index < 0) throw new Error(`找不到迁移：${migrationName}`);
  const migration = migrations[index];
  if (!fs.existsSync(migration.downPath)) throw new Error(`迁移 ${migrationName} 没有回滚文件`);

  const applied = readApplied(environment);
  if (!applied.has(migrationName)) throw new Error(`迁移 ${migrationName} 尚未执行`);
  const laterApplied = migrations.slice(index + 1).find((item) => applied.has(item.name));
  if (laterApplied) throw new Error(`必须先回滚后续迁移：${laterApplied.name}`);

  const downSql = fs.readFileSync(migration.downPath, "utf8");
  runPsql(`BEGIN;\n${downSql}\nDELETE FROM schema_migrations WHERE name = :'migration_name';\nCOMMIT;`, environment, {
    migration_name: migrationName
  });
  console.log(`已回滚迁移：${migrationName}`);
}

function main(argv = process.argv.slice(2)) {
  const migrations = listMigrations();
  if (argv.includes("--help")) {
    console.log("用法：node scripts/migrate.js [--plan] [--rollback <迁移名> --allow-destructive]");
    return;
  }
  if (argv.includes("--plan")) {
    printPlan(migrations);
    return;
  }

  const rollbackIndex = argv.indexOf("--rollback");
  if (rollbackIndex >= 0) {
    const migrationName = argv[rollbackIndex + 1];
    if (!migrationName) throw new Error("--rollback 必须指定迁移名");
    if (!argv.includes("--allow-destructive")) {
      throw new Error("回滚会删除数据库数据，必须显式传入 --allow-destructive");
    }
    loadEnvFile();
    rollbackMigration(migrations, databaseEnvironment(), migrationName);
    return;
  }

  loadEnvFile();
  applyMigrations(migrations, databaseEnvironment());
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checksum, listMigrations, loadEnvFile, databaseEnvironment, runPsql, main };
