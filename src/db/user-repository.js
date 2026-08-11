const crypto = require("node:crypto");

const ADMIN_ROLES = ["grader", "system_admin"];
const ACCESS_ROLES = new Set(["grader", "exam_admin", "system_admin"]);

function stableId(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32)}`;
}

function normalizeRealName(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

function requireRealName(value) {
  const name = String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!name) throw new Error("平台未返回员工真实姓名，无法建立考试账号");
  return name;
}

// Login and a reviewed identity merge must not observe different ownership for one provider identity.
async function lockUserIdentityMutation(client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1));", ["t12:user-identity-mutation"]);
}

function maskIdentity(value) {
  const text = String(value || "");
  if (!text) return "未记录";
  if (text.length <= 8) return "****";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function mapAdminUser(row) {
  const roles = Array.isArray(row.roles) ? row.roles.filter(Boolean) : [];
  const identities = Array.isArray(row.identities) ? row.identities.map((identity) => ({
    provider: identity.provider,
    hint: maskIdentity(identity.identifier)
  })) : [];
  return {
    id: row.id,
    name: row.name,
    employeeNo: row.employee_no || "",
    department: row.department || "",
    status: row.status,
    identityHint: identities.map((identity) => `${identity.provider}: ${identity.hint}`).join(" / ") || "未记录",
    providers: [...new Set(identities.map((identity) => identity.provider))],
    roles,
    isAdmin: roles.includes("system_admin")
  };
}

async function upsertDingtalkUser(pool, user) {
  const unionId = String(user.unionId || "").trim();
  if (!unionId) throw new Error("钉钉用户缺少 unionId");
  const realName = requireRealName(user.name);
  let providerSubject = String(user.openId || unionId).trim();
  const fallbackUserId = stableId("user", `dingtalk:${unionId}`);
  let identityId = stableId("identity", `dingtalk:${providerSubject}`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockUserIdentityMutation(client);
    const existing = await client.query(`
      SELECT id, user_id, provider, provider_subject
      FROM user_identities
      WHERE union_id = $1 AND provider IN ('dingtalk', 'legacy')
      ORDER BY (provider = 'dingtalk') DESC, created_at
      LIMIT 1;`, [unionId]);
    const userId = existing.rows[0]?.user_id || fallbackUserId;
    if (existing.rows[0]?.provider === "dingtalk") {
      identityId = existing.rows[0].id;
      providerSubject = existing.rows[0].provider_subject;
    }
    await client.query(`
      INSERT INTO users (id, name)
      VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = CURRENT_TIMESTAMP;`, [userId, realName]);
    await client.query(`
      INSERT INTO user_identities (id, user_id, provider, provider_subject, union_id, open_id)
      VALUES ($1, $2, 'dingtalk', $3, $4, $5)
      ON CONFLICT (provider, provider_subject) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          union_id = EXCLUDED.union_id,
          open_id = COALESCE(EXCLUDED.open_id, user_identities.open_id),
          updated_at = CURRENT_TIMESTAMP;`, [identityId, userId, providerSubject, unionId, user.openId || null]);
    await client.query(`
      INSERT INTO user_roles (user_id, role_code)
      VALUES ($1, 'student')
      ON CONFLICT (user_id, role_code) DO NOTHING;`, [userId]);
    await client.query("COMMIT");
    return userId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function upsertFeishuUser(pool, user) {
  const providerSubject = String(user.providerSubject || user.openId || "").trim();
  if (!providerSubject) throw new Error("飞书用户缺少 open_id");
  const realName = requireRealName(user.name);
  const unionId = String(user.unionId || "").trim() || null;
  const fallbackUserId = stableId("user", `feishu:${providerSubject}`);
  const identityId = stableId("identity", `feishu:${providerSubject}`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockUserIdentityMutation(client);
    const existing = await client.query(`
      SELECT id, user_id
      FROM user_identities
      WHERE provider = 'feishu' AND provider_subject = $1
      LIMIT 1;`, [providerSubject]);
    const userId = existing.rows[0]?.user_id || fallbackUserId;
    await client.query(`
      INSERT INTO users (id, name)
      VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = CURRENT_TIMESTAMP;`, [userId, realName]);
    await client.query(`
      INSERT INTO user_identities (id, user_id, provider, provider_subject, union_id, open_id)
      VALUES ($1, $2, 'feishu', $3, $4, $3)
      ON CONFLICT (provider, provider_subject) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          union_id = EXCLUDED.union_id,
          open_id = EXCLUDED.open_id,
          updated_at = CURRENT_TIMESTAMP;`, [identityId, userId, providerSubject, unionId]);
    await client.query(`
      INSERT INTO user_roles (user_id, role_code)
      VALUES ($1, 'student')
      ON CONFLICT (user_id, role_code) DO NOTHING;`, [userId]);
    await client.query("COMMIT");
    return userId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureBootstrapAdmin(pool, userId) {
  const result = await pool.query(`
    INSERT INTO user_roles (user_id, role_code)
    SELECT $1, role_code
    FROM unnest($2::text[]) AS role_code
    ON CONFLICT (user_id, role_code) DO NOTHING
    RETURNING role_code;`, [userId, ADMIN_ROLES]);
  if (result.rows.length) {
    await pool.query(`
      INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, before_json, after_json)
      VALUES ($1, $2, 'bootstrap_admin', 'user', $2, $3::jsonb, $4::jsonb);`, [
      crypto.randomUUID(), userId, JSON.stringify({ roles: [] }), JSON.stringify({ roles: ADMIN_ROLES })
    ]);
  }
}

async function getAdminAccess(pool, unionId, bootstrapUnionIds = new Set()) {
  const bootstrap = bootstrapUnionIds.has(unionId);
  if (!pool) {
    return {
      userId: null,
      roles: [],
      canAccess: bootstrap,
      canManageAdmins: bootstrap,
      canManageQuestions: bootstrap
    };
  }
  const result = await pool.query(`
    SELECT u.id,
      COALESCE(array_agg(DISTINCT ur.role_code ORDER BY ur.role_code)
        FILTER (WHERE ur.role_code IS NOT NULL), ARRAY[]::text[]) AS roles
    FROM users u
    JOIN user_identities ui ON ui.user_id = u.id
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    WHERE u.status = 'active'
      AND (ui.union_id = $1 OR ui.provider_subject = $1 OR ui.open_id = $1)
      AND ui.provider IN ('dingtalk', 'legacy')
    GROUP BY u.id
    ORDER BY bool_or(ui.provider = 'dingtalk') DESC
    LIMIT 1;`, [unionId]);
  const row = result.rows[0];
  const roles = Array.isArray(row?.roles) ? row.roles.filter(Boolean) : [];
  return {
    userId: row?.id || null,
    roles,
    canAccess: bootstrap || roles.some((role) => ACCESS_ROLES.has(role)),
    canManageAdmins: bootstrap || roles.includes("system_admin"),
    canManageQuestions: bootstrap || roles.includes("system_admin") || roles.includes("exam_admin")
  };
}

async function getIdentityAccess(pool, provider, providerSubject) {
  if (!pool) {
    return { userId: null, roles: [], canAccess: false, canManageAdmins: false, canManageQuestions: false };
  }
  const result = await pool.query(`
    SELECT u.id,
      COALESCE(array_agg(DISTINCT ur.role_code ORDER BY ur.role_code)
        FILTER (WHERE ur.role_code IS NOT NULL), ARRAY[]::text[]) AS roles
    FROM users u
    JOIN user_identities ui ON ui.user_id = u.id
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    WHERE u.status = 'active'
      AND ui.provider = $1 AND ui.provider_subject = $2
    GROUP BY u.id
    LIMIT 1;`, [provider, providerSubject]);
  const row = result.rows[0];
  const roles = Array.isArray(row?.roles) ? row.roles.filter(Boolean) : [];
  return {
    userId: row?.id || null,
    roles,
    canAccess: roles.some((role) => ACCESS_ROLES.has(role)),
    canManageAdmins: roles.includes("system_admin"),
    canManageQuestions: roles.includes("system_admin") || roles.includes("exam_admin")
  };
}

async function listAdminUsers(pool) {
  const result = await pool.query(`
    SELECT u.id, u.name, u.employee_no, u.department, u.status,
      jsonb_agg(DISTINCT jsonb_build_object(
        'provider', ui.provider,
        'identifier', COALESCE(ui.union_id, ui.provider_subject, ui.open_id)
      )) AS identities,
      COALESCE(array_agg(DISTINCT ur.role_code ORDER BY ur.role_code)
        FILTER (WHERE ur.role_code IS NOT NULL), ARRAY[]::text[]) AS roles
    FROM users u
    JOIN user_identities ui ON ui.user_id = u.id
      AND ui.provider IN ('dingtalk', 'feishu', 'legacy')
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    GROUP BY u.id, u.name, u.employee_no, u.department, u.status
    ORDER BY u.name, u.id;`);
  return result.rows.map(mapAdminUser);
}

async function setAdminRole(pool, targetUserId, enabled, actorUserId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const targetResult = await client.query(`
      SELECT u.id, u.name
      FROM users u
      WHERE u.id = $1
        AND u.status = 'active'
        AND EXISTS (
          SELECT 1 FROM user_identities ui
          WHERE ui.user_id = u.id
            AND ui.provider IN ('dingtalk', 'feishu', 'legacy')
        )
      FOR UPDATE OF u;`, [targetUserId]);
    const target = targetResult.rows[0];
    if (!target) throw new Error("未找到可授权的平台用户");
    const rolesResult = await client.query(
      "SELECT role_code FROM user_roles WHERE user_id = $1 ORDER BY role_code;",
      [targetUserId]
    );
    const beforeRoles = rolesResult.rows.map((row) => row.role_code);

    if (enabled) {
      await client.query(`
        INSERT INTO user_roles (user_id, role_code)
        SELECT $1, role_code
        FROM unnest($2::text[]) AS role_code
        ON CONFLICT (user_id, role_code) DO NOTHING;`, [targetUserId, ADMIN_ROLES]);
    } else {
      if (targetUserId === actorUserId) throw new Error("不能移除自己的管理员权限");
      const countResult = await client.query(
        "SELECT COUNT(DISTINCT user_id)::integer AS count FROM user_roles WHERE role_code = 'system_admin';"
      );
      if (Number(countResult.rows[0]?.count || 0) <= 1) throw new Error("不能移除最后一名系统管理员");
      await client.query(
        "DELETE FROM user_roles WHERE user_id = $1 AND role_code = ANY($2::text[]);",
        [targetUserId, ADMIN_ROLES]
      );
    }

    const afterRoles = enabled
      ? [...new Set([...beforeRoles, ...ADMIN_ROLES])].sort()
      : beforeRoles.filter((role) => !ADMIN_ROLES.includes(role));
    await client.query(`
      INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, before_json, after_json)
      VALUES ($1, $2, $3, 'user', $4, $5::jsonb, $6::jsonb);`, [
      crypto.randomUUID(), actorUserId, enabled ? "grant_admin" : "revoke_admin", targetUserId,
      JSON.stringify({ roles: beforeRoles }), JSON.stringify({ roles: afterRoles })
    ]);
    await client.query("COMMIT");
    return { id: targetUserId, name: target.name, roles: afterRoles, isAdmin: afterRoles.includes("system_admin") };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  ADMIN_ROLES,
  ensureBootstrapAdmin,
  getAdminAccess,
  getIdentityAccess,
  listAdminUsers,
  mapAdminUser,
  maskIdentity,
  lockUserIdentityMutation,
  normalizeRealName,
  setAdminRole,
  stableId,
  upsertDingtalkUser,
  upsertFeishuUser
};
