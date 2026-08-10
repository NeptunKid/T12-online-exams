#!/usr/bin/env node

const crypto = require("node:crypto");
const { createPostgresPool } = require("../src/db/postgres-client");
const { normalizeRealName } = require("../src/db/user-repository");
const { loadEnvFile } = require("./migrate");

function parseArgs(argv) {
  const unknown = argv.filter((value) => value !== "--apply" && value !== "--help");
  if (unknown.length) throw new Error(`不支持的参数：${unknown[0]}`);
  return { apply: argv.includes("--apply"), help: argv.includes("--help") };
}

function buildReconciliationPlan(rows) {
  const users = new Map();
  for (const row of rows) {
    if (!users.has(row.user_id)) {
      users.set(row.user_id, {
        id: row.user_id,
        name: row.name,
        normalizedName: normalizeRealName(row.name),
        providers: new Set()
      });
    }
    users.get(row.user_id).providers.add(row.provider);
  }

  const names = new Map();
  for (const user of users.values()) {
    if (!user.normalizedName) continue;
    if (!names.has(user.normalizedName)) names.set(user.normalizedName, []);
    names.get(user.normalizedName).push(user);
  }

  const merges = [];
  const ambiguous = [];
  for (const group of names.values()) {
    const dingtalk = group.filter((user) => user.providers.has("dingtalk") || user.providers.has("legacy"));
    const feishu = group.filter((user) => user.providers.has("feishu"));
    if (!dingtalk.length || !feishu.length) continue;
    const dingtalkIds = new Set(dingtalk.map((user) => user.id));
    const feishuIds = new Set(feishu.map((user) => user.id));
    if (dingtalkIds.size === 1 && feishuIds.size === 1) {
      const canonical = dingtalk[0];
      const duplicate = feishu[0];
      if (canonical.id !== duplicate.id) {
        merges.push({
          realName: canonical.name,
          canonicalUserId: canonical.id,
          duplicateUserId: duplicate.id
        });
      }
      continue;
    }
    ambiguous.push({
      realName: group[0].name,
      dingtalkUserIds: [...dingtalkIds],
      feishuUserIds: [...feishuIds]
    });
  }
  return { merges, ambiguous };
}

async function loadIdentityRows(queryable) {
  const result = await queryable.query(`
    SELECT u.id AS user_id, u.name, ui.provider
    FROM users u
    JOIN user_identities ui ON ui.user_id = u.id
    WHERE u.status = 'active'
      AND ui.provider IN ('dingtalk', 'feishu', 'legacy')
    ORDER BY u.created_at, u.id, ui.provider;`);
  return result.rows;
}

async function mergeRetakePermissions(client, canonicalUserId, duplicateUserId) {
  const result = await client.query(`
    SELECT id, exam_id, remaining_count, granted_by, granted_at, created_at
    FROM retake_permissions
    WHERE user_id = $1
    ORDER BY exam_id
    FOR UPDATE;`, [duplicateUserId]);
  for (const permission of result.rows) {
    const target = await client.query(`
      SELECT id, remaining_count
      FROM retake_permissions
      WHERE exam_id = $1 AND user_id = $2
      FOR UPDATE;`, [permission.exam_id, canonicalUserId]);
    if (target.rows.length) {
      await client.query(`
        UPDATE retake_permissions
        SET remaining_count = remaining_count + $2,
          granted_at = GREATEST(granted_at, $3::timestamptz)
        WHERE id = $1;`, [target.rows[0].id, Number(permission.remaining_count), permission.granted_at]);
      await client.query("DELETE FROM retake_permissions WHERE id = $1;", [permission.id]);
    } else {
      await client.query("UPDATE retake_permissions SET user_id = $2 WHERE id = $1;", [permission.id, canonicalUserId]);
    }
  }
}

async function mergeUser(client, item) {
  const { canonicalUserId, duplicateUserId, realName } = item;
  await client.query("SELECT id FROM users WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE;", [[canonicalUserId, duplicateUserId]]);

  await client.query(`
    INSERT INTO user_roles (user_id, role_code)
    SELECT $1, role_code FROM user_roles WHERE user_id = $2
    ON CONFLICT (user_id, role_code) DO NOTHING;`, [canonicalUserId, duplicateUserId]);
  await client.query("DELETE FROM user_roles WHERE user_id = $1;", [duplicateUserId]);

  await client.query(`
    INSERT INTO exam_assignments (id, exam_id, subject_type, subject_id, starts_at, ends_at)
    SELECT 'merged_assignment_' || md5(exam_id || ':' || $1), exam_id, subject_type, $1, starts_at, ends_at
    FROM exam_assignments
    WHERE subject_type = 'user' AND subject_id = $2
    ON CONFLICT (exam_id, subject_type, subject_id) DO NOTHING;`, [canonicalUserId, duplicateUserId]);
  await client.query("DELETE FROM exam_assignments WHERE subject_type = 'user' AND subject_id = $1;", [duplicateUserId]);

  await mergeRetakePermissions(client, canonicalUserId, duplicateUserId);
  await client.query("UPDATE user_identities SET user_id = $1 WHERE user_id = $2;", [canonicalUserId, duplicateUserId]);
  await client.query("UPDATE submissions SET user_id = $1 WHERE user_id = $2;", [canonicalUserId, duplicateUserId]);
  await client.query(`
    WITH numbered AS (
      SELECT id, row_number() OVER (PARTITION BY exam_id ORDER BY submitted_at, id) AS attempt_no
      FROM submissions WHERE user_id = $1
    )
    UPDATE submissions s SET attempt_no = numbered.attempt_no
    FROM numbered WHERE s.id = numbered.id;`, [canonicalUserId]);

  for (const sql of [
    "UPDATE question_banks SET owner_id = $1 WHERE owner_id = $2;",
    "UPDATE exams SET created_by = $1 WHERE created_by = $2;",
    "UPDATE submissions SET grader_id = $1 WHERE grader_id = $2;",
    "UPDATE retake_permissions SET granted_by = $1 WHERE granted_by = $2;",
    "UPDATE audit_logs SET actor_id = $1 WHERE actor_id = $2;"
  ]) await client.query(sql, [canonicalUserId, duplicateUserId]);

  await client.query(`
    INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, before_json, after_json)
    VALUES ($1, $2, 'merge_cross_platform_user', 'user', $2, $3::jsonb, $4::jsonb);`, [
    crypto.randomUUID(), canonicalUserId,
    JSON.stringify({ duplicateUserId }),
    JSON.stringify({ canonicalUserId, realName, reason: "unique_normalized_real_name" })
  ]);
  await client.query("DELETE FROM users WHERE id = $1;", [duplicateUserId]);
}

async function reconcile(pool, apply = false) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const plan = buildReconciliationPlan(await loadIdentityRows(client));
    if (apply && plan.ambiguous.length) {
      throw new Error("存在同名歧义用户，已停止全部自动合并，请先由管理员核对");
    }
    if (apply) {
      for (const item of plan.merges) await mergeUser(client, item);
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }
    return { mode: apply ? "apply" : "dry-run", ...plan, applied: apply ? plan.merges.length : 0 };
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
    console.log("用法：node scripts/reconcile-cross-platform-users.js [--apply]");
    console.log("默认仅预览；生产执行 --apply 前必须完成 PostgreSQL pg_dump -Fc 备份。");
    return;
  }
  loadEnvFile();
  const pool = createPostgresPool();
  try {
    console.log(JSON.stringify(await reconcile(pool, args.apply), null, 2));
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
