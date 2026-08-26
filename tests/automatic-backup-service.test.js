const assert = require("node:assert/strict");
const test = require("node:test");
const { createAutomaticBackupService, listBackupScopes } = require("../src/backup/automatic-backup-service");

function packageFor(kind, id) {
  return {
    manifest: { format: "t12-online-exams-backup", formatVersion: 1, kind, exportedAt: "2026-08-11T00:00:00.000Z", counts: { questionBanks: 0, questions: 0, exams: 0, examQuestions: 0, assignments: 0, retakePermissions: 0, resources: 0 }, payloadSha256: "0".repeat(64) },
    questionBanks: [], questions: [], exams: [], examQuestions: [], assignments: [], retakePermissions: [], resources: [], id
  };
}

function setup(options = {}) {
  const calls = [];
  const lockClient = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: options.locked !== false }] };
      return { rows: [{ pg_advisory_unlock: true }] };
    },
    release() { calls.push("release"); }
  };
  const pool = { connect: async () => lockClient };
  let sequence = 0;
  const repository = {
    async createBackupRun(poolValue, input) { calls.push(["create", input]); return { id: `backup_run_${++sequence}` }; },
    async saveBackupArtifact(poolValue, id, input, saveOptions) { calls.push(["save", id, input, saveOptions]); },
    async failBackupRun(poolValue, id, error) { calls.push(["fail", id, error]); },
    async applyBackupRetention(poolValue, input) { calls.push(["retention", input]); return { filesystemKeys: options.prunedKeys || [] }; },
    async failStaleScheduledBackupRuns(poolValue, input) { calls.push(["stale", input]); return options.staleRunIds || []; },
    async getLatestSuccessfulScheduledCycle() { calls.push(["latest-cycle"]); return options.latestCycle || null; },
    async completeScheduledBackupCycle(poolValue, runId) { calls.push(["complete-cycle", runId]); }
  };
  const storage = {
    async save(input) { calls.push(["file-save", input]); return { storageKey: `key/${input.runId}` }; },
    async remove(key) {
      calls.push(["file-remove", key]);
      if (options.failRemove) throw new Error("remove failed");
    },
    async read(key) { return Buffer.from(key); }
  };
  const config = {
    enabled: options.enabled !== false,
    storageType: options.storageType || "database",
    retentionCount: 3,
    intervalMs: options.intervalMs || 1000,
    startDelayMs: 50,
    staleAfterMs: 2 * 60 * 60 * 1000,
    scopeDelayMs: options.scopeDelayMs || 0,
    directory: "/backup"
  };
  const service = createAutomaticBackupService({
    config,
    getPool: () => pool,
    repository,
    filesystemStorage: storage,
    listScopes: async () => options.scopes || [
      { scopeType: "question-bank", scopeId: "bank-1" },
      { scopeType: "exam", scopeId: "exam-1" }
    ],
    exporters: {
      exportQuestionBank: async () => packageFor("question-bank", "bank-1"),
      exportExam: async () => options.failExam ? Promise.reject(new Error("exam failed")) : packageFor("exam", "exam-1")
    },
    now: options.now || (() => new Date("2026-08-11T00:00:00.000Z")),
    timers: options.timers,
    sleep: options.sleep,
    logger: { error() {}, warn() {} }
  });
  return { calls, service };
}

test("自动备份逐一保存题库和试卷、完成运行并应用保留策略", async () => {
  const { calls, service } = setup();
  assert.deepEqual(service.triggerManual("admin-1"), { started: true, triggerType: "manual" });
  const summary = await service.waitForIdle();
  assert.deepEqual(summary, {
    triggerType: "manual", startedAt: "2026-08-11T00:00:00.000Z", completedAt: "2026-08-11T00:00:00.000Z",
    total: 2, succeeded: 2, failed: 0, cleanupFailed: 0
  });
  assert.equal(calls.filter((item) => Array.isArray(item) && item[0] === "save").length, 2);
  assert.ok(calls.filter((item) => Array.isArray(item) && item[0] === "save").every((item) => item[3].completeRun === true));
  assert.ok(calls.some((item) => Array.isArray(item) && item[0] === "retention"));
  assert.ok(calls.includes("release"));
});

test("单个对象失败会记录失败并继续其他备份", async () => {
  const { calls, service } = setup({ failExam: true });
  service.triggerManual("admin-1");
  const summary = await service.waitForIdle();
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 1);
  assert.ok(calls.some((item) => Array.isArray(item) && item[0] === "fail" && item[2] === "exam failed"));
});

test("文件系统存储写入受控键并删除保留策略淘汰的文件", async () => {
  const { calls, service } = setup({ storageType: "filesystem", prunedKeys: ["old/file.t12backup"], scopes: [{ scopeType: "exam", scopeId: "exam-1" }] });
  service.triggerManual("admin-1");
  await service.waitForIdle();
  const saved = calls.find((item) => Array.isArray(item) && item[0] === "save")[2];
  assert.equal(saved.storageType, "filesystem");
  assert.equal(saved.content, undefined);
  assert.ok(calls.some((item) => Array.isArray(item) && item[0] === "file-remove" && item[1] === "old/file.t12backup"));
});

test("过期文件清理失败会记录计数但不否定已完成的备份", async () => {
  const { service } = setup({
    storageType: "filesystem", prunedKeys: ["old/file.t12backup"], failRemove: true,
    scopes: [{ scopeType: "exam", scopeId: "exam-1" }]
  });
  service.triggerManual("admin-1");
  const summary = await service.waitForIdle();
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.cleanupFailed, 1);
});

test("禁用、重复运行和跨实例锁均阻止启动", async () => {
  assert.throws(() => setup({ enabled: false }).service.triggerManual("admin-1"), /尚未启用/);
  const locked = setup({ locked: false }).service;
  locked.triggerManual("admin-1");
  await assert.rejects(locked.waitForIdle(), /其他实例/);
});

test("备份范围列表稳定包含所有题库和试卷", async () => {
  const pool = { async query(sql) {
    if (sql.includes("question_banks")) return { rows: [{ id: "b-1", label: "题库" }] };
    return { rows: [{ id: "e-1", label: "试卷" }] };
  } };
  assert.deepEqual(await listBackupScopes(pool), [
    { scopeType: "question-bank", scopeId: "b-1", label: "题库" },
    { scopeType: "exam", scopeId: "e-1", label: "试卷" }
  ]);
});

test("服务重启后的定时检查在最近成功周期尚未到期时跳过全量备份", async () => {
  const scheduled = [];
  const timers = {
    setTimeout(callback, delay) {
      const handle = { unref() {} };
      scheduled.push({ callback, delay, handle });
      return handle;
    },
    clearTimeout() {}
  };
  const { calls, service } = setup({
    timers,
    intervalMs: 60 * 60 * 1000,
    now: () => new Date("2026-08-11T01:00:00.000Z"),
    latestCycle: { id: "cycle-1", completedAt: "2026-08-11T00:30:00.000Z" }
  });
  service.start();
  const initialCheck = scheduled.shift();
  assert.equal(initialCheck.delay, 50);
  initialCheck.callback();
  await new Promise((resolve) => setImmediate(resolve));
  const summary = await service.waitForIdle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(summary.skipped, true);
  assert.equal(summary.reason, "scheduled-backup-not-due");
  assert.equal(calls.filter((item) => Array.isArray(item) && item[0] === "create").length, 0);
  assert.ok(calls.some((item) => Array.isArray(item) && item[0] === "latest-cycle"));
  assert.equal(scheduled.at(-1).delay, 30 * 60 * 1000);
});

test("定时备份收敛过期运行、记录成功周期并按对象节流", async () => {
  const scheduled = [];
  const pauses = [];
  const timers = {
    setTimeout(callback, delay) {
      const handle = { unref() {} };
      scheduled.push({ callback, delay, handle });
      return handle;
    },
    clearTimeout() {}
  };
  const { calls, service } = setup({
    timers,
    scopeDelayMs: 25,
    staleRunIds: ["stale-1"],
    sleep: async (milliseconds) => { pauses.push(milliseconds); }
  });
  service.start();
  scheduled.shift().callback();
  await new Promise((resolve) => setImmediate(resolve));
  const summary = await service.waitForIdle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(summary.succeeded, 2);
  assert.deepEqual(pauses, [25]);
  assert.ok(calls.some((item) => Array.isArray(item) && item[0] === "stale"));
  assert.ok(calls.some((item) => Array.isArray(item) && item[0] === "complete-cycle"));
  const created = calls.filter((item) => Array.isArray(item) && item[0] === "create");
  assert.deepEqual(created[0][1], { scopeType: "system", scopeId: "", triggerType: "scheduled", requestedBy: null });
});
