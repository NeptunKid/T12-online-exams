const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ensureAssignmentsForActiveDingtalkUsers,
  parseArgs
} = require("../scripts/import-question-banks");

test("parseArgs supports assigning all active DingTalk users", () => {
  const args = parseArgs(["--all-active-dingtalk-users", "--publish"]);
  assert.equal(args.allActiveDingtalkUsers, true);
  assert.equal(args.publish, true);
  assert.equal(args.unionId, "");
});

test("parseArgs requires exactly one assignment mode", () => {
  assert.throws(() => parseArgs([]), /--union-id 或 --all-active-dingtalk-users/);
  assert.throws(
    () => parseArgs(["--union-id", "private-id", "--all-active-dingtalk-users"]),
    /不能同时使用/
  );
});

test("active DingTalk users receive every imported exam idempotently", async () => {
  const inserts = [];
  const client = {
    async query(sql, params) {
      if (sql.includes("SELECT DISTINCT u.id")) return { rows: [{ id: "user-a" }, { id: "user-b" }] };
      if (sql.includes("INSERT INTO exam_assignments")) {
        assert.match(sql, /ON CONFLICT \(exam_id, subject_type, subject_id\) DO NOTHING/);
        inserts.push(params);
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const exams = [{ examId: "exam-one" }, { examId: "exam-two" }, { examId: "exam-three" }];

  const userIds = await ensureAssignmentsForActiveDingtalkUsers(client, exams);

  assert.deepEqual(userIds, ["user-a", "user-b"]);
  assert.equal(inserts.length, 6);
  assert.deepEqual(new Set(inserts.map((params) => `${params[1]}:${params[2]}`)).size, 6);
});

test("bulk assignment aborts when no active DingTalk user exists", async () => {
  const client = { query: async () => ({ rows: [] }) };
  await assert.rejects(
    ensureAssignmentsForActiveDingtalkUsers(client, [{ examId: "exam-one" }]),
    /没有找到已登录且状态为 active 的钉钉用户/
  );
});
