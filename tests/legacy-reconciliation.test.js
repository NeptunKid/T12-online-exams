const assert = require("node:assert/strict");
const test = require("node:test");
const { compareSnapshots, compareSubmissions, expectedSnapshots, expectedSubmissions } = require("../scripts/verify-legacy-import");

const normalized = {
  examData: { passScore: 60 },
  questions: [{ id: "q1", legacySourceKey: "q1", type: "single", stem: "题目", answer: "A", score: 100 }],
  rows: [{ id: "legacy-1", status: "graded", attemptNo: 1, objectiveScore: 100, qaScore: 0, totalScore: 100, passScore: 60, pass: true, answers: { q1: "A" }, objectiveDetail: { q1: { earned: 100 } } }]
};

test("历史答卷对账比较 ID、状态和分数", () => {
  const expected = expectedSubmissions(normalized);
  compareSubmissions(expected, [{ id: "legacy-1", status: "graded", attemptNo: 1, objectiveScore: 100, qaScore: 0, totalScore: 100, passScore: 60, pass: true }]);
  assert.throws(() => compareSubmissions(expected, [{ id: "legacy-1", status: "pending", attemptNo: 1, objectiveScore: 100, qaScore: 0, totalScore: 100, passScore: 60, pass: true }]), /status 不一致/);
});

test("历史答卷对账比较逐题作答、得分和快照", () => {
  const expected = expectedSnapshots(normalized);
  compareSnapshots(expected, [{ submissionId: "legacy-1", position: 1, answer: "A", earnedScore: 100, automaticScore: 100, manuallyAdjusted: false, snapshot: normalized.questions[0] }]);
  assert.throws(() => compareSnapshots(expected, [{ submissionId: "legacy-1", position: 1, answer: "B", earnedScore: 100, automaticScore: 100, manuallyAdjusted: false, snapshot: normalized.questions[0] }]), /answer 不一致/);
});
