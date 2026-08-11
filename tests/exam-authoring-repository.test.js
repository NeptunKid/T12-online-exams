const assert = require("node:assert/strict");
const test = require("node:test");
const {
  bindExamQuestionBank,
  getExamAuthoring,
  listAuthoringExams,
  normalizeQuestionIds,
  normalizeScore,
  reorderExamQuestions,
  setExamQuestions,
  updateAllExamQuestionScores,
  updateExamQuestionScore
} = require("../src/db/exam-authoring-repository");

function createDatabase(overrides = {}) {
  const calls = [];
  const state = {
    exam: {
      id: "exam-1",
      title: "测试试卷",
      status: "draft",
      duration_seconds: "600",
      total_score: "5",
      pass_score: "3",
      pass_rate: "0.600000",
      version: "3",
      question_bank_id: "bank-1",
      question_bank_name: "题库一",
      ...overrides.exam
    },
    selection: overrides.selection || [{ question_id: "q-1", position: 1, score: "5" }],
    questions: overrides.questions || [
      { id: "q-1", external_id: "1", type: "single", stem: "第一题", status: "active" },
      { id: "q-2", external_id: "2", type: "qa", stem: "第二题", status: "active" }
    ]
  };

  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      const compact = sql.replace(/\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(compact)) return { rows: [] };
      if (compact.includes("FOR UPDATE OF e")) return { rows: state.exam ? [{ ...state.exam }] : [] };
      if (compact.includes("FROM exam_questions eq") && compact.includes("SELECT eq.question_id")) {
        return { rows: state.selection.map((item) => ({
          ...item,
          bank_id: state.questions.find((question) => question.id === item.question_id)?.bank_id || state.exam.question_bank_id,
          question_status: state.questions.find((question) => question.id === item.question_id)?.status || "active"
        })) };
      }
      if (compact.includes("FROM question_banks") && compact.includes("FOR SHARE")) {
        return { rows: params[0] === "bank-1" || params[0] === "bank-2" ? [{ id: params[0], name: "可用题库" }] : [] };
      }
      if (compact.startsWith("UPDATE exams SET question_bank_id")) {
        state.exam.question_bank_id = params[1];
        state.exam.question_bank_name = "可用题库";
        return { rows: [] };
      }
      if (compact.includes("WHERE q.id = ANY")) {
        const active = state.questions.filter((question) => params[0].includes(question.id)
          && question.status === "active" && state.exam.question_bank_id === params[1]);
        return { rows: active.map(({ id }) => ({ id })) };
      }
      if (compact.includes("SELECT q.id") && compact.includes("q.status = 'active'") && compact.includes("FOR SHARE")) {
        return { rows: state.questions.filter((question) => question.status === "active").map(({ id }) => ({ id })) };
      }
      if (compact.startsWith("DELETE FROM exam_questions")) {
        state.selection = [];
        return { rows: [] };
      }
      if (compact.startsWith("INSERT INTO exam_questions")) {
        state.selection = params[1].map((questionId, index) => ({
          question_id: questionId,
          position: params[2][index],
          score: params[3][index]
        }));
        return { rows: [] };
      }
      if (compact.startsWith("UPDATE exam_questions SET position = position")) {
        state.selection.forEach((item) => { item.position += params[1]; });
        return { rows: [] };
      }
      if (compact.includes("WITH ORDINALITY AS ordered")) {
        params[1].forEach((id, index) => {
          state.selection.find((item) => item.question_id === id).position = index + 1;
        });
        state.selection.sort((left, right) => left.position - right.position);
        return { rows: [] };
      }
      if (compact.startsWith("UPDATE exam_questions SET score = $3")) {
        const item = state.selection.find((selected) => selected.question_id === params[1]);
        if (!item) return { rows: [] };
        item.score = params[2];
        return { rows: [{ question_id: item.question_id }] };
      }
      if (compact.startsWith("UPDATE exam_questions SET score = $2")) {
        state.selection.forEach((item) => { item.score = params[1]; });
        return { rows: [] };
      }
      if (compact.startsWith("UPDATE exams e") && compact.includes("totals.total_score")) {
        const total = state.selection.reduce((sum, item) => sum + Number(item.score), 0);
        state.exam.total_score = String(total);
        state.exam.pass_score = String(Math.round(total * Number(state.exam.pass_rate) * 100) / 100);
        state.exam.version = String(Number(state.exam.version) + 1);
        return { rows: [{ ...state.exam }] };
      }
      if (compact.startsWith("INSERT INTO audit_logs")) return { rows: [] };
      if (compact.includes("count(eq.question_id)::integer") && compact.includes("WHERE e.id = $1")) {
        return { rows: [{ ...state.exam, question_count: state.selection.length }] };
      }
      if (compact.includes("FROM questions q") && compact.includes("LEFT JOIN exam_questions")) {
        return { rows: state.questions.map((question) => {
          const selected = state.selection.find((item) => item.question_id === question.id);
          return { ...question, position: selected?.position ?? null, score: selected?.score ?? null };
        }) };
      }
      throw new Error(`Unexpected SQL: ${compact}`);
    },
    release() {}
  };
  return { calls, client, pool: { connect: async () => client }, state };
}

test("试卷列表和组卷详情映射题库及所选题目", async () => {
  const row = {
    id: "exam-1", title: "测试试卷", status: "draft", duration_seconds: "600",
    total_score: "5", pass_score: "3", pass_rate: "0.6", version: "3",
    question_bank_id: "bank-1", question_bank_name: "题库一", question_count: "1"
  };
  const listed = await listAuthoringExams({ query: async () => ({ rows: [row] }) });
  assert.deepEqual(listed[0], {
    id: "exam-1", title: "测试试卷", status: "draft", duration: 600,
    totalScore: 5, passScore: 3, passRate: 0.6, version: 3,
    questionBankId: "bank-1", questionBankName: "题库一", questionCount: 1
  });

  let call = 0;
  const detail = await getExamAuthoring({ query: async () => (++call === 1
    ? { rows: [row] }
    : { rows: [
      { id: "q-1", external_id: "1", type: "single", stem: "第一题", status: "active", position: "1", score: "5" },
      { id: "q-2", external_id: "2", type: "qa", stem: "第二题", status: "active", position: null, score: null }
    ] }) });
  assert.equal(detail.questions[0].selected, true);
  assert.equal(detail.questions[0].score, 5);
  assert.equal(detail.questions[1].selected, false);
  assert.equal(detail.questions[1].score, null);
});

test("分值和题目列表的输入校验拒绝负数、超精度和重复题目", () => {
  assert.equal(normalizeScore("0.29"), 0.29);
  assert.equal(normalizeScore("2.50"), 2.5);
  assert.throws(() => normalizeScore(-1), /非负数/);
  assert.throws(() => normalizeScore(null), /非负数/);
  assert.throws(() => normalizeScore(false), /非负数/);
  assert.throws(() => normalizeScore("1.001"), /两位小数/);
  assert.throws(() => normalizeQuestionIds(["q-1", "q-1"]), /重复/);
});

test("部分选题仅接受已绑定题库的 active 题目并保留已有分值", async () => {
  const database = createDatabase();
  const detail = await setExamQuestions(database.pool, "exam-1", {
    version: 3,
    questionIds: ["q-2", "q-1"]
  }, "admin-1");
  assert.deepEqual(database.state.selection, [
    { question_id: "q-2", position: 1, score: 0 },
    { question_id: "q-1", position: 2, score: 5 }
  ]);
  assert.equal(detail.totalScore, 5);
  assert.equal(detail.passScore, 3);
  assert.equal(detail.version, 4);
  assert.equal(database.calls.some((call) => call.sql.includes("'exam'")), true);
  assert.equal(database.calls.some((call) => /submissions|submission_questions/.test(call.sql)), false);
  assert.equal(database.calls.at(-1).sql, "COMMIT");
});

test("全选只按题库稳定顺序加入 active 题目", async () => {
  const database = createDatabase({
    questions: [
      { id: "q-2", external_id: "2", type: "qa", stem: "第二题", status: "active" },
      { id: "q-old", external_id: "0", type: "qa", stem: "旧题", status: "archived" },
      { id: "q-1", external_id: "1", type: "single", stem: "第一题", status: "active" }
    ]
  });
  await setExamQuestions(database.pool, "exam-1", { version: 3, selectAll: true }, "admin-1");
  const insert = database.calls.find((call) => call.sql.includes("INSERT INTO exam_questions"));
  assert.deepEqual(insert.params[1], ["q-2", "q-1"]);
  assert.equal(insert.params[1].includes("q-old"), false);
});

test("部分选题发现跨题库或归档题时回滚", async () => {
  const database = createDatabase({
    questions: [{ id: "q-archived", external_id: "1", type: "qa", stem: "旧题", status: "archived" }]
  });
  await assert.rejects(setExamQuestions(database.pool, "exam-1", {
    version: 3,
    questionIds: ["q-archived"]
  }, "admin-1"), /其他题库或已归档/);
  assert.equal(database.calls.at(-1).sql, "ROLLBACK");
  assert.equal(database.calls.some((call) => call.sql.includes("DELETE FROM exam_questions")), false);
});

test("有选题时拒绝直接更换题库", async () => {
  const database = createDatabase();
  await assert.rejects(bindExamQuestionBank(database.pool, "exam-1", {
    version: 3,
    bankId: "bank-2"
  }, "admin-1"), /先清空选题/);
  assert.equal(database.calls.at(-1).sql, "ROLLBACK");
});

test("空草稿可以绑定 active 题库并记录审计", async () => {
  const database = createDatabase({
    exam: { question_bank_id: null, question_bank_name: null, total_score: "0", pass_score: "0" },
    selection: []
  });
  const detail = await bindExamQuestionBank(database.pool, "exam-1", {
    version: 3,
    bankId: "bank-2"
  }, "admin-1");
  assert.equal(detail.questionBankId, "bank-2");
  assert.equal(detail.version, 4);
  const audit = database.calls.find((call) => call.sql.includes("INSERT INTO audit_logs"));
  assert.equal(audit.params[2], "bind_exam_question_bank");
  assert.equal(database.calls.at(-1).sql, "COMMIT");
});

test("旧试卷未绑定题库时也拒绝将跨题库选题绑到新题库", async () => {
  const database = createDatabase({
    exam: { question_bank_id: null, question_bank_name: null },
    questions: [{ id: "q-1", external_id: "1", type: "qa", stem: "旧题", status: "active", bank_id: "bank-other" }]
  });
  await assert.rejects(bindExamQuestionBank(database.pool, "exam-1", {
    version: 3,
    bankId: "bank-1"
  }, "admin-1"), /其他题库/);
  assert.equal(database.calls.at(-1).sql, "ROLLBACK");
});

test("排序必须提交当前试卷的完整题目集", async () => {
  const database = createDatabase({
    selection: [
      { question_id: "q-1", position: 1, score: "3" },
      { question_id: "q-2", position: 2, score: "2" }
    ]
  });
  await assert.rejects(reorderExamQuestions(database.pool, "exam-1", {
    version: 3,
    questionIds: ["q-2"]
  }, "admin-1"), /全部题目/);
  assert.equal(database.calls.some((call) => call.sql.includes("position = position +")), false);

  const success = createDatabase({
    selection: [
      { question_id: "q-1", position: 1, score: "3" },
      { question_id: "q-2", position: 2, score: "2" }
    ]
  });
  await reorderExamQuestions(success.pool, "exam-1", {
    version: 3,
    questionIds: ["q-2", "q-1"]
  }, "admin-1");
  assert.deepEqual(success.state.selection.map((item) => item.question_id), ["q-2", "q-1"]);
});

test("单题和全部选题分值修改后重算总分、通过线和版本", async () => {
  const single = createDatabase();
  const singleDetail = await updateExamQuestionScore(single.pool, "exam-1", "q-1", {
    version: 3,
    score: 7.25
  }, "admin-1");
  assert.equal(singleDetail.totalScore, 7.25);
  assert.equal(singleDetail.passScore, 4.35);
  assert.equal(singleDetail.version, 4);

  const bulk = createDatabase({
    selection: [
      { question_id: "q-1", position: 1, score: "3" },
      { question_id: "q-2", position: 2, score: "2" }
    ]
  });
  const bulkDetail = await updateAllExamQuestionScores(bulk.pool, "exam-1", {
    version: 3,
    score: 4
  }, "admin-1");
  assert.equal(bulkDetail.totalScore, 8);
  assert.equal(bulkDetail.passScore, 4.8);
  assert.deepEqual(bulk.state.selection.map((item) => item.score), [4, 4]);
});

test("非草稿和过期版本都在任何写入前被拒绝", async () => {
  const published = createDatabase({ exam: { status: "published" } });
  await assert.rejects(updateAllExamQuestionScores(published.pool, "exam-1", {
    version: 3,
    score: 2
  }, "admin-1"), /只能修改草稿/);
  assert.equal(published.calls.some((call) => call.sql.includes("SET score")), false);

  const stale = createDatabase();
  await assert.rejects(updateExamQuestionScore(stale.pool, "exam-1", "q-1", {
    version: 2,
    score: 2
  }, "admin-1"), /其他管理员/);
  assert.equal(stale.calls.some((call) => call.sql.includes("SET score")), false);
});

test("分值和排序写入拒绝试卷中已归档的题目", async () => {
  const database = createDatabase({
    questions: [{ id: "q-1", external_id: "1", type: "qa", stem: "旧题", status: "archived", bank_id: "bank-1" }]
  });
  await assert.rejects(updateExamQuestionScore(database.pool, "exam-1", "q-1", {
    version: 3,
    score: 2
  }, "admin-1"), /已归档/);
  assert.equal(database.calls.some((call) => call.sql.includes("SET score")), false);
  assert.equal(database.calls.at(-1).sql, "ROLLBACK");
});
