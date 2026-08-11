const crypto = require("node:crypto");
const { lockUserIdentityMutation, normalizeRealName } = require("./user-repository");

class UserMergeError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "UserMergeError";
    this.statusCode = statusCode;
  }
}

function hasDingtalkIdentity(user) {
  return hasProvider(user, "dingtalk") || hasProvider(user, "legacy");
}

function hasFeishuIdentity(user) {
  return hasProvider(user, "feishu");
}

function hasProvider(user, provider) {
  return user.providers instanceof Set
    ? user.providers.has(provider)
    : Array.isArray(user.providers) && user.providers.includes(provider);
}

function buildMergeCandidateGroups(rows) {
  const users = new Map();
  for (const row of rows || []) {
    if (!users.has(row.user_id)) {
      users.set(row.user_id, {
        id: row.user_id,
        name: row.name,
        normalizedName: normalizeRealName(row.name),
        employeeNo: row.employee_no || "",
        department: row.department || "",
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

  const groups = [];
  for (const [normalizedName, members] of names) {
    // Only an unlinked DingTalk account and an unlinked Feishu account can be a merge pair.
    // A user already containing both identities is evidence that this name group needs manual review.
    const dingtalkUsers = members.filter((user) => hasDingtalkIdentity(user) && !hasFeishuIdentity(user));
    const feishuUsers = members.filter((user) => hasFeishuIdentity(user) && !hasDingtalkIdentity(user));
    const linkedUsers = members.filter((user) => hasDingtalkIdentity(user) && hasFeishuIdentity(user));
    const pairs = [];
    for (const canonical of dingtalkUsers) {
      for (const duplicate of feishuUsers) {
        if (canonical.id === duplicate.id) continue;
        pairs.push({ canonicalUserId: canonical.id, duplicateUserId: duplicate.id });
      }
    }
    if (!pairs.length) continue;
    groups.push({
      normalizedName,
      displayName: members[0].name,
      ambiguous: pairs.length !== 1 || linkedUsers.length > 0,
      users: members.map((user) => ({
        id: user.id,
        name: user.name,
        employeeNo: user.employeeNo,
        department: user.department,
        providers: [...user.providers].sort()
      })),
      pairs
    });
  }
  return groups.sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
}

function findConfirmableCandidate(rows, canonicalUserId, duplicateUserId, expectedName) {
  const expected = normalizeRealName(expectedName);
  if (!expected) return null;
  return buildMergeCandidateGroups(rows).find((group) => group.normalizedName === expected
    && !group.ambiguous
    && group.pairs.length === 1
    && group.pairs[0].canonicalUserId === canonicalUserId
    && group.pairs[0].duplicateUserId === duplicateUserId) || null;
}

async function loadIdentityRows(queryable) {
  const result = await queryable.query(`
    SELECT u.id AS user_id, u.name, u.employee_no, u.department, ui.provider
    FROM users u
    JOIN user_identities ui ON ui.user_id = u.id
    WHERE u.status = 'active'
      AND ui.provider IN ('dingtalk', 'feishu', 'legacy')
    ORDER BY u.created_at, u.id, ui.provider;`);
  return result.rows;
}

async function listMergeCandidates(pool) {
  return buildMergeCandidateGroups(await loadIdentityRows(pool));
}

async function collectMergeSummary(client, duplicateUserId) {
  const result = await client.query(`
    SELECT
      (SELECT count(*) FROM user_identities WHERE user_id = $1)::integer AS identity_count,
      (SELECT count(*) FROM user_roles WHERE user_id = $1)::integer AS role_count,
      (SELECT count(*) FROM exam_assignments WHERE subject_type = 'user' AND subject_id = $1)::integer AS assignment_count,
      (SELECT count(*) FROM retake_permissions WHERE user_id = $1)::integer AS retake_permission_count,
      (SELECT count(*) FROM submissions WHERE user_id = $1)::integer AS submission_count,
      (SELECT count(*) FROM question_banks WHERE owner_id = $1)::integer AS question_bank_owner_count,
      (SELECT count(*) FROM exams WHERE created_by = $1)::integer AS exam_owner_count,
      (SELECT count(*) FROM submissions WHERE grader_id = $1)::integer AS graded_submission_count;`, [duplicateUserId]);
  const row = result.rows[0] || {};
  return Object.fromEntries([
    ["identityCount", row.identity_count],
    ["roleCount", row.role_count],
    ["assignmentCount", row.assignment_count],
    ["retakePermissionCount", row.retake_permission_count],
    ["submissionCount", row.submission_count],
    ["questionBankOwnerCount", row.question_bank_owner_count],
    ["examOwnerCount", row.exam_owner_count],
    ["gradedSubmissionCount", row.graded_submission_count]
  ].map(([key, value]) => [key, Number(value || 0)]));
}

async function mergeRetakePermissions(client, canonicalUserId, duplicateUserId) {
  const result = await client.query(`
    SELECT id, exam_id, remaining_count, granted_at
    FROM retake_permissions
    WHERE user_id = $1
    ORDER BY exam_id
    FOR UPDATE;`, [duplicateUserId]);
  for (const permission of result.rows) {
    const target = await client.query(`
      SELECT id
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

async function mergeUser(client, item, actorUserId = item.canonicalUserId, summary = {}) {
  const {
    canonicalUserId,
    duplicateUserId,
    realName,
    canonicalEmployeeNo,
    duplicateEmployeeNo,
    duplicateDepartment
  } = item;
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
    ON CONFLICT (exam_id, subject_type, subject_id) DO UPDATE
    SET starts_at = CASE
          WHEN exam_assignments.starts_at IS NULL OR EXCLUDED.starts_at IS NULL THEN NULL
          ELSE LEAST(exam_assignments.starts_at, EXCLUDED.starts_at)
        END,
        ends_at = CASE
          WHEN exam_assignments.ends_at IS NULL OR EXCLUDED.ends_at IS NULL THEN NULL
          ELSE GREATEST(exam_assignments.ends_at, EXCLUDED.ends_at)
        END,
        updated_at = CURRENT_TIMESTAMP;`, [canonicalUserId, duplicateUserId]);
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
  ]) await client.query(sql, [canonicalUserId, duplicateUserId]);

  const transferEmployeeNo = !String(canonicalEmployeeNo || "").trim() && Boolean(String(duplicateEmployeeNo || "").trim());
  if (transferEmployeeNo) {
    // The unique employee number still belongs to the retained disabled record until this row is cleared.
    await client.query("UPDATE users SET employee_no = NULL WHERE id = $1;", [duplicateUserId]);
  }
  await client.query(`
    UPDATE users
    SET employee_no = COALESCE(NULLIF(employee_no, ''), NULLIF($2, '')),
        department = COALESCE(NULLIF(department, ''), NULLIF($3, ''))
    WHERE id = $1;`, [canonicalUserId, duplicateEmployeeNo || "", duplicateDepartment || ""]);

  await client.query(`
    INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, before_json, after_json)
    VALUES ($1, $2, 'merge_cross_platform_user', 'user', $3, $4::jsonb, $5::jsonb);`, [
    crypto.randomUUID(), actorUserId, canonicalUserId,
    JSON.stringify({ duplicateUserId }),
    JSON.stringify({
      canonicalUserId,
      realName,
      duplicateUserId,
      reason: "administrator_confirmed_same_name",
      migrated: summary
    })
  ]);
  await client.query("UPDATE users SET status = 'disabled' WHERE id = $1;", [duplicateUserId]);
}

async function mergePlatformUsers(pool, input, actorUserId) {
  const canonicalUserId = String(input?.canonicalUserId || "").trim();
  const duplicateUserId = String(input?.duplicateUserId || "").trim();
  const expectedName = normalizeRealName(input?.expectedName);
  if (!canonicalUserId || !duplicateUserId || canonicalUserId === duplicateUserId) {
    throw new UserMergeError("请选择两个不同的待合并用户");
  }
  if (!expectedName) throw new UserMergeError("缺少待核对的真实姓名");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockUserIdentityMutation(client);
    const result = await client.query(`
      SELECT id, name, employee_no, department, status
      FROM users
      WHERE id = ANY($1::text[])
      ORDER BY id
      FOR UPDATE;`, [[canonicalUserId, duplicateUserId]]);
    if (result.rows.length !== 2 || result.rows.some((row) => row.status !== "active")) {
      throw new UserMergeError("待合并用户不存在或已被处理，请刷新后重试", 409);
    }
    if (result.rows.some((row) => normalizeRealName(row.name) !== expectedName)) {
      throw new UserMergeError("用户姓名已变化，已停止合并，请刷新后重新核对", 409);
    }
    const candidate = findConfirmableCandidate(await loadIdentityRows(client), canonicalUserId, duplicateUserId, expectedName);
    if (!candidate) {
      throw new UserMergeError("同名候选已变化或存在歧义，请刷新后重新核对", 409);
    }
    const providerResult = await client.query(`
      SELECT user_id, array_agg(DISTINCT provider ORDER BY provider) AS providers
      FROM user_identities
      WHERE user_id = ANY($1::text[])
      GROUP BY user_id;`, [[canonicalUserId, duplicateUserId]]);
    const providersByUser = new Map(providerResult.rows.map((row) => [row.user_id, row.providers || []]));
    const canonical = { ...result.rows.find((row) => row.id === canonicalUserId), providers: providersByUser.get(canonicalUserId) || [] };
    const duplicate = { ...result.rows.find((row) => row.id === duplicateUserId), providers: providersByUser.get(duplicateUserId) || [] };
    if (!hasDingtalkIdentity(canonical) || hasFeishuIdentity(canonical)
      || !hasFeishuIdentity(duplicate) || hasDingtalkIdentity(duplicate)) {
      throw new UserMergeError("合并方向必须从飞书候选账号归并到钉钉主账号");
    }

    const summary = await collectMergeSummary(client, duplicateUserId);
    await mergeUser(client, {
      canonicalUserId,
      duplicateUserId,
      realName: canonical.name,
      canonicalEmployeeNo: canonical.employee_no,
      duplicateEmployeeNo: duplicate.employee_no,
      duplicateDepartment: duplicate.department
    }, actorUserId, {
      ...summary,
      employeeNoTransferred: !String(canonical.employee_no || "").trim() && Boolean(String(duplicate.employee_no || "").trim())
    });
    await client.query("COMMIT");
    return { canonicalUserId, duplicateUserId, name: canonical.name, merged: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  buildMergeCandidateGroups,
  listMergeCandidates,
  loadIdentityRows,
  mergePlatformUsers,
  mergeRetakePermissions,
  mergeUser,
  UserMergeError
};
