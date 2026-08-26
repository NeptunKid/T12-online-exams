const { Pool } = require("pg");

function isPostgresConfigured(env = process.env) {
  return Boolean(env.DB_HOST && env.DB_PORT && env.DB_NAME && env.DB_USER && env.DB_PASSWORD);
}

function poolConfigFromEnv(env = process.env) {
  if (!isPostgresConfigured(env)) throw new Error("PostgreSQL 配置不完整");
  const statementTimeout = Number(env.DB_STATEMENT_TIMEOUT_MS || 15000);
  if (!Number.isInteger(statementTimeout) || statementTimeout < 1000 || statementTimeout > 120000) {
    throw new Error("DB_STATEMENT_TIMEOUT_MS 必须是 1000 到 120000 的整数");
  }
  return {
    host: env.DB_HOST,
    port: Number(env.DB_PORT),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    max: Number(env.DB_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: statementTimeout,
    ssl: String(env.DB_SSL).toLowerCase() === "true" ? { rejectUnauthorized: false } : false
  };
}

function createPostgresPool(env = process.env) {
  return new Pool(poolConfigFromEnv(env));
}

module.exports = { createPostgresPool, isPostgresConfigured, poolConfigFromEnv };
