const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createAdminBackupHandler, extractMultipartBackup, isSameOriginMultipartRequest } = require("../src/http/admin-backup-handler");
const { readZip } = require("../src/backup/zip-archive");
const { buildBackupPackage } = require("../src/backup/export-package");

function response() {
  return {
    status: null, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
}

function multipart(content, boundary = "t12-boundary") {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="backup"; filename="sample.t12backup"\r\nContent-Type: application/zip\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
}

function setup(overrides = {}) {
  const calls = [];
  const repository = {
    async exportExam() { return buildBackupPackage({ kind: "exam", exams: [{ id: "exam-1", title: "测试试卷", duration_seconds: 60 }] }); },
    async exportQuestionBank() { return null; },
    async importBackupPackage(pool, content, actor) {
      calls.push({ pool, content, actor });
      return { kind: "exam", questionBanks: [{ id: "bank-new", name: "题库" }], exams: [{ id: "exam-new", title: "试卷", status: "draft" }], counts: { questions: 1, resources: 1 } };
    },
    async listRecentBackupRuns() { return []; },
    async getBackupArtifact() { return null; },
    ...overrides.repository
  };
  const json = (res, status, body) => { res.status = status; res.body = body; };
  const pool = Object.hasOwn(overrides, "pool") ? overrides.pool : { name: "pool" };
  return { calls, handler: createAdminBackupHandler({
    repository,
    getPool: () => pool,
    json,
    readBody: overrides.readBody,
    automation: overrides.automation,
    automaticConfig: overrides.automaticConfig,
    isSameOriginJsonRequest: overrides.isSameOriginJsonRequest || (() => false)
  }) };
}

test("试卷导出返回可解析的自包含 ZIP 和安全下载响应头", async () => {
  const { handler } = setup();
  const req = { method: "GET", url: "/api/admin/backups/export?kind=exam&id=exam-1", headers: { host: "exam.test" } };
  const res = response();
  assert.equal(await handler(req, res, "/api/admin/backups/export", { canManageQuestions: true, userId: "u-1" }), true);
  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Type"], "application/vnd.t12.exam-backup+zip");
  assert.match(res.headers["Content-Disposition"], /filename\*=UTF-8''/);
  assert.equal(JSON.parse(readZip(res.body).get("backup.json")).manifest.kind, "exam");
});

test("导入只接受同源 multipart 的单个 backup 文件并映射创建结果", async () => {
  const archive = Buffer.from("archive");
  const boundary = "test-boundary";
  const body = multipart(archive, boundary);
  const { handler, calls } = setup({ readBody: async () => body });
  const req = { method: "POST", url: "/api/admin/backups/import", headers: { host: "exam.test", origin: "https://exam.test", "content-type": `multipart/form-data; boundary=${boundary}` } };
  const res = response();
  await handler(req, res, "/api/admin/backups/import", { canManageQuestions: true, userId: "u-1" });
  assert.equal(res.status, 201);
  assert.equal(res.body.exam.id, "exam-new");
  assert.equal(res.body.questionBank.id, "bank-new");
  assert.deepEqual(calls[0].content, archive);
  assert.equal(calls[0].actor, "u-1");
});

test("multipart 解析拒绝多个字段、错误边界和跨站来源", () => {
  const contentType = "multipart/form-data; boundary=x";
  assert.deepEqual(extractMultipartBackup(multipart(Buffer.from("ok"), "x"), contentType).content, Buffer.from("ok"));
  const two = Buffer.concat([
    Buffer.from('--x\r\nContent-Disposition: form-data; name="backup"; filename="a"\r\n\r\na\r\n'),
    Buffer.from('--x\r\nContent-Disposition: form-data; name="note"\r\n\r\nb\r\n--x--\r\n')
  ]);
  assert.throws(() => extractMultipartBackup(two, contentType), /只能包含一个/);
  assert.throws(() => extractMultipartBackup(Buffer.from("bad"), contentType), /格式无效/);
  assert.equal(isSameOriginMultipartRequest({ headers: { host: "exam.test", origin: "https://evil.test", "content-type": contentType } }), false);
});

test("备份路由执行权限、数据库配置、参数和来源校验", async () => {
  const req = { method: "GET", url: "/api/admin/backups/export?kind=bad&id=x", headers: { host: "exam.test" } };
  let res = response();
  await setup().handler(req, res, "/api/admin/backups/export", { canManageQuestions: false });
  assert.equal(res.status, 403);
  res = response();
  await setup({ pool: null }).handler(req, res, "/api/admin/backups/export", { canManageQuestions: true });
  assert.equal(res.status, 503);
  res = response();
  await setup().handler(req, res, "/api/admin/backups/export", { canManageQuestions: true });
  assert.equal(res.status, 400);
});

test("不属于备份模块的路径返回 false", async () => {
  const { handler } = setup();
  assert.equal(await handler({ method: "GET" }, response(), "/api/admin/questions", {}), false);
});

test("自动备份状态只返回公开配置和受控运行字段", async () => {
  const run = {
    id: "run-1", scopeType: "exam", scopeId: "exam-1", triggerType: "scheduled", status: "succeeded",
    requestedBy: "private-user", startedAt: "start", completedAt: "end", errorMessage: "",
    artifact: { id: "artifact-1", filename: "exam.t12backup", storageKey: "/private/path", sha256: "a".repeat(64), sizeBytes: 12, createdAt: "now" }
  };
  const automation = { status: () => ({ running: false, nextRunAt: null, lastSummary: null }) };
  const { handler } = setup({
    automation,
    automaticConfig: { enabled: true, storageType: "filesystem", intervalHours: 24, retentionCount: 7 },
    repository: { async listRecentBackupRuns() { return [run]; } }
  });
  const res = response();
  await handler({ method: "GET", headers: {} }, res, "/api/admin/backups/automation", { canManageQuestions: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.automation.storageType, "filesystem");
  assert.equal(Object.hasOwn(res.body.runs[0], "requestedBy"), false);
  assert.equal(Object.hasOwn(res.body.runs[0].artifact, "storageKey"), false);
});

test("同源 JSON 可以立即启动自动备份，跨站请求被拒绝", async () => {
  const automation = { triggerManual(actor) { return { started: true, actor }; } };
  let setupResult = setup({ automation, isSameOriginJsonRequest: () => true });
  let res = response();
  await setupResult.handler({ method: "POST", headers: {} }, res, "/api/admin/backups/automation/run", { canManageQuestions: true, userId: "admin-1" });
  assert.equal(res.status, 202);
  assert.equal(res.body.run.actor, "admin-1");
  setupResult = setup({ automation, isSameOriginJsonRequest: () => false });
  res = response();
  await setupResult.handler({ method: "POST", headers: {} }, res, "/api/admin/backups/automation/run", { canManageQuestions: true, userId: "admin-1" });
  assert.equal(res.status, 403);
});

test("历史工件下载支持数据库正文并在响应前复核 SHA-256", async () => {
  const crypto = require("node:crypto");
  const content = Buffer.from("archive");
  const artifact = {
    id: "artifact-1", storageType: "database", filename: "exam.t12backup",
    contentType: "application/zip", content, storageKey: "",
    sizeBytes: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex")
  };
  const automation = { readFilesystemArtifact: async () => { throw new Error("unexpected"); } };
  const { handler } = setup({ automation, repository: { async getBackupArtifact() { return artifact; } } });
  const res = response();
  await handler({ method: "GET", headers: {} }, res, "/api/admin/backups/artifacts/artifact-1", { canManageQuestions: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, content);
  assert.equal(res.headers.ETag, `"${artifact.sha256}"`);
});
