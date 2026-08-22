const crypto = require("node:crypto");

function stableId(prefix, value) {
  return `${prefix}-${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32)}`;
}

function mapDepartment(row) {
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.external_id,
    name: row.name,
    parentExternalId: row.parent_external_id || null,
    status: row.status
  };
}

function mapDirectoryUser(row) {
  return {
    id: row.id,
    name: row.name || "未命名用户",
    employeeNo: row.employee_no || "",
    department: row.department || "",
    providers: Array.isArray(row.providers) ? row.providers : []
  };
}

async function listOrganizationDirectory(pool) {
  const [departments, users] = await Promise.all([
    pool.query(`
      SELECT id, provider, external_id, name, parent_external_id, status
      FROM organization_departments
      WHERE status = 'active'
      ORDER BY name, provider, external_id;`),
    pool.query(`
      SELECT u.id, u.name, u.employee_no, u.department,
        COALESCE(array_agg(DISTINCT ui.provider) FILTER (WHERE ui.provider IS NOT NULL), ARRAY[]::text[]) AS providers
      FROM users u
      LEFT JOIN user_identities ui ON ui.user_id = u.id
        AND ui.provider IN ('dingtalk', 'feishu', 'legacy')
      WHERE u.status = 'active'
      GROUP BY u.id, u.name, u.employee_no, u.department
      ORDER BY u.name, u.id;`)
  ]);
  return {
    departments: departments.rows.map(mapDepartment),
    users: users.rows.map(mapDirectoryUser)
  };
}

async function upsertDirectoryUser(client, directoryUser, departmentNames) {
  const provider = String(directoryUser.provider || "").trim();
  const providerSubject = String(directoryUser.providerSubject || "").trim();
  if (!provider || !providerSubject) return null;
  const identityId = stableId("identity", `${provider}:${providerSubject}`);
  const fallbackUserId = stableId("user", `${provider}:${directoryUser.unionId || providerSubject}`);
  const existing = await client.query(`
    SELECT id, user_id
    FROM user_identities
    WHERE provider = $1 AND provider_subject = $2
    LIMIT 1;`, [provider, providerSubject]);
  const userId = existing.rows[0]?.user_id || fallbackUserId;
  const department = departmentNames[0] || "";
  const employeeNo = String(directoryUser.employeeNo || "").trim();
  let usableEmployeeNo = employeeNo || null;
  if (usableEmployeeNo) {
    const employeeOwner = await client.query(
      "SELECT id FROM users WHERE employee_no = $1 AND id <> $2 LIMIT 1;",
      [usableEmployeeNo, userId]
    );
    if (employeeOwner.rows.length) usableEmployeeNo = null;
  }
  await client.query(`
    INSERT INTO users (id, name, employee_no, department)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name,
        employee_no = COALESCE(EXCLUDED.employee_no, users.employee_no),
        department = CASE WHEN EXCLUDED.department <> '' THEN EXCLUDED.department ELSE users.department END,
        updated_at = CURRENT_TIMESTAMP;`, [
    userId, String(directoryUser.name || providerSubject).trim(), usableEmployeeNo, department
  ]);
  await client.query(`
    INSERT INTO user_identities (id, user_id, provider, provider_subject, union_id, open_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (provider, provider_subject) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        union_id = COALESCE(EXCLUDED.union_id, user_identities.union_id),
        open_id = COALESCE(EXCLUDED.open_id, user_identities.open_id),
        updated_at = CURRENT_TIMESTAMP;`, [
    identityId, userId, provider, providerSubject,
    directoryUser.unionId || null, directoryUser.openId || null
  ]);
  await client.query(`
    INSERT INTO user_roles (user_id, role_code)
    VALUES ($1, 'student')
    ON CONFLICT (user_id, role_code) DO NOTHING;`, [userId]);
  return userId;
}

async function syncOrganizationDirectory(pool, directory, actorUserId) {
  if (!directory || !["dingtalk", "feishu"].includes(directory.provider)) {
    throw new Error("组织目录来源无效");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1));", ["t12:organization-directory-sync"]);
    const departmentIds = new Map();
    const departmentNames = new Map();
    for (const item of directory.departments || []) {
      const externalId = String(item.externalId || "").trim();
      if (!externalId) continue;
      const id = stableId("department", `${directory.provider}:${externalId}`);
      const name = String(item.name || externalId).trim();
      departmentIds.set(externalId, id);
      departmentNames.set(externalId, name);
      await client.query(`
        INSERT INTO organization_departments (id, provider, external_id, name, parent_external_id, status)
        VALUES ($1, $2, $3, $4, $5, 'active')
        ON CONFLICT (provider, external_id) DO UPDATE
        SET name = EXCLUDED.name,
            parent_external_id = EXCLUDED.parent_external_id,
            status = 'active',
            updated_at = CURRENT_TIMESTAMP;`, [
        id, directory.provider, externalId, name, item.parentExternalId || null
      ]);
    }
    let userCount = 0;
    for (const item of directory.users || []) {
      const names = (item.departmentExternalIds || [])
        .map((externalId) => departmentNames.get(String(externalId)))
        .filter(Boolean);
      const userId = await upsertDirectoryUser(client, item, names);
      if (!userId) continue;
      userCount += 1;
      for (const externalId of item.departmentExternalIds || []) {
        const departmentId = departmentIds.get(String(externalId));
        if (!departmentId) continue;
        await client.query(`
          INSERT INTO user_departments (user_id, department_id)
          VALUES ($1, $2)
          ON CONFLICT (user_id, department_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP;`, [userId, departmentId]);
      }
    }
    await client.query(`
      INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, before_json, after_json)
      VALUES ($1, $2, 'sync_organization_directory', 'organization', $3, NULL, $4::jsonb);`, [
      crypto.randomUUID(), actorUserId, directory.provider,
      JSON.stringify({ provider: directory.provider, departmentCount: departmentIds.size, userCount })
    ]);
    await client.query("COMMIT");
    return { provider: directory.provider, departmentCount: departmentIds.size, userCount };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function listExamAssignmentDepartments(pool) {
  const result = await pool.query(`
    SELECT id, provider, external_id, name, parent_external_id, status
    FROM organization_departments
    WHERE status = 'active'
    ORDER BY name, provider, external_id;`);
  return result.rows.map(mapDepartment);
}

module.exports = {
  listExamAssignmentDepartments,
  listOrganizationDirectory,
  syncOrganizationDirectory,
  stableId
};
