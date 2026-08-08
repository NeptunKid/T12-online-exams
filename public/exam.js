let exam = null;
let dashboardData = null;
let startedAt = null;
let timerId = null;
let submitted = false;
let remainingSeconds = 0;
let currentUser = null;
let activeExamId = "default";
let usingPostgresApi = false;

const typeLabels = {
  single: "单选题",
  multi: "多选题",
  judge: "判断题",
  fill: "填空题",
  qa: "问答题"
};

const typeTips = {
  single: "每题只有一个正确答案",
  multi: "漏选得一半分，错选不得分",
  judge: "请选择正确或错误",
  fill: "请输入答案，系统会先自动判分",
  qa: "阅卷人后台评分"
};

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function fmtTime(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? esc(iso) : date.toLocaleString("zh-CN", { hour12: false });
}

function answerDisplay(value) {
  if (Array.isArray(value)) return value.length ? value.join("、") : "未作答";
  return value || "未作答";
}

function getImageSet(q, sourceExam = exam) {
  return sourceExam?.images?.[q.id] || sourceExam?.images?.[String(q.id)] || { stem: [], options: {} };
}

function imageHtml(paths, className = "image-row") {
  if (!paths?.length) return "";
  return `<div class="${className}">${paths.map((src) => `<img src="/${esc(String(src).replace(/^\/+/, ""))}" alt="题目图片" loading="lazy">`).join("")}</div>`;
}

function optionImageHtml(src) {
  return src ? `<img class="option-image" src="/${esc(String(src).replace(/^\/+/, ""))}" alt="选项图片" loading="lazy">` : "";
}

function statusBadge(status) {
  return status === "graded"
    ? `<span class="badge graded">已批阅</span>`
    : `<span class="badge pending">等待阅卷</span>`;
}

function normalizePostgresExam(source) {
  const normalized = { ...source, duration: Number(source.duration) / 60 };
  normalized.questions = (source.questions || []).map((question) => ({
    ...question,
    text: question.text || question.stem || "",
    options: Array.isArray(question.options)
      ? Object.fromEntries(question.options.map((option) => [option.label, option.text || ""]))
      : (question.options || {})
  }));
  normalized.optionImages = Object.fromEntries((source.questions || []).map((question) => [
    question.id,
    Object.fromEntries((question.options || []).filter((option) => option.image).map((option) => [option.label, option.image]))
  ]));
  normalized.images = source.images || {};
  for (const question of normalized.questions) {
    normalized.images[question.id] = normalized.images[question.id] || { stem: [], options: normalized.optionImages[question.id] || {} };
    normalized.images[question.id].options = { ...normalized.images[question.id].options, ...(normalized.optionImages[question.id] || {}) };
  }
  return normalized;
}

async function loadExam(examId = "default") {
  const endpoint = usingPostgresApi && examId !== "default" ? `/api/exams/${encodeURIComponent(examId)}` : "/api/exam";
  const res = await fetch(endpoint);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || "题目载入失败");
  exam = usingPostgresApi && payload.exam ? normalizePostgresExam(payload.exam) : payload;
  if (usingPostgresApi) {
    const assigned = dashboardData?.exams?.find((item) => item.id === examId);
    exam.attempt = assigned?.attempt || { available: true, message: "" };
  }
}

async function loadDashboard() {
  const postgresRes = await fetch("/api/exams/dashboard");
  const postgresPayload = await postgresRes.json().catch(() => ({}));
  if (postgresRes.ok && postgresPayload.source === "postgres") {
    usingPostgresApi = true;
    dashboardData = postgresPayload;
  } else {
    usingPostgresApi = false;
    const legacyRes = await fetch("/api/student/dashboard");
    const legacyPayload = await legacyRes.json().catch(() => ({}));
    if (!legacyRes.ok) throw new Error(legacyPayload.error || postgresPayload.error || "个人记录载入失败");
    dashboardData = legacyPayload;
  }
  renderDashboard();
}

function renderDashboard() {
  const { user, exams, submissions } = dashboardData;
  document.getElementById("dashboardUser").textContent = `钉钉账号：${user.name}`;

  document.getElementById("examCatalog").innerHTML = exams.map((item) => {
    const attempt = item.attempt;
    return `
      <article class="exam-catalog-card">
        <div class="catalog-card-head">
          <div><h2>${esc(item.title)}</h2><p class="brand-sub">${esc(item.studyStatus)} · ${item.duration} 分钟 · 满分 ${item.totalScore} 分</p></div>
          <span class="catalog-pass">通过线 ${item.passScore} 分</span>
        </div>
        <div class="catalog-card-bottom">
          <div class="attempt-note ${attempt.available ? "available" : "unavailable"}">${esc(attempt.message)}</div>
          <button class="btn primary start-exam-btn" data-exam-id="${esc(item.id)}" type="button" ${attempt.available ? "" : "disabled"}>开始考核</button>
        </div>
      </article>
    `;
  }).join("");

  document.getElementById("historyList").innerHTML = submissions.length ? submissions.map((item) => {
    const outcome = item.status === "graded"
      ? `<strong class="history-score ${item.pass ? "pass" : "fail"}">${item.totalScore} 分 · ${item.pass ? "通过" : "未通过"}</strong>`
      : `<strong class="history-score">客观题 ${item.objectiveScore} 分</strong>`;
    return `
      <button class="history-card" data-submission-id="${esc(item.id)}" type="button">
        <div class="history-card-main">
          <div><div class="history-title">${esc(item.examTitle)}</div><div class="brand-sub">第 ${item.attemptNo} 次考核 · ${fmtTime(item.submittedAt)}</div></div>
          ${statusBadge(item.status)}
        </div>
        <div class="history-card-bottom"><span>${outcome}</span><span class="history-detail-link">查看结果</span></div>
      </button>
    `;
  }).join("") : `<div class="empty-state compact-empty">尚无考试记录</div>`;

  for (const button of document.querySelectorAll(".start-exam-btn")) {
    button.addEventListener("click", () => startExam(button.dataset.examId));
  }
  for (const button of document.querySelectorAll(".history-card")) {
    button.addEventListener("click", () => showStudentDetail(button.dataset.submissionId));
  }
}

function showOnly(pageId) {
  for (const id of ["loginPage", "dashboardPage", "studentDetailPage", "examPage", "resultPage"]) {
    document.getElementById(id).classList.toggle("hidden", id !== pageId);
  }
}

async function startExam(examId) {
  try {
    activeExamId = examId || "default";
    await loadExam(activeExamId);
    if (!exam.attempt?.available) {
      alert(exam.attempt?.message || "当前无法开始考核");
      return;
    }
    submitted = false;
    startedAt = new Date().toISOString();
    document.getElementById("studentMeta").textContent = currentUser.name;
    document.getElementById("examTitle").textContent = exam.title;
    renderExam();
    showOnly("examPage");
    startTimer();
  } catch (err) {
    alert(err.message || "无法开始考试");
  }
}

async function showStudentDetail(id) {
  showOnly("studentDetailPage");
  const container = document.getElementById("studentDetail");
  container.innerHTML = `<div class="panel detail-loading">正在载入阅卷结果</div>`;
  try {
    const endpoint = usingPostgresApi
      ? `/api/exams/submissions/${encodeURIComponent(id)}`
      : `/api/student/submissions/${encodeURIComponent(id)}`;
    const res = await fetch(endpoint);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "答卷详情载入失败");
    if (usingPostgresApi) renderPostgresStudentDetail(data);
    else renderStudentDetail(data);
  } catch (err) {
    container.innerHTML = `<div class="panel detail-loading">${esc(err.message || "答卷详情载入失败")}</div>`;
  }
}

function renderPostgresStudentDetail(data) {
  const { submission, questions } = data;
  document.getElementById("studentDetailSub").textContent = `${submission.examTitle} · 第 ${submission.attemptNo} 次考核`;
  const container = document.getElementById("studentDetail");
  const questionHtml = (questions || []).map((question) => `
    <article class="student-question-result">
      <div class="student-question-top"><div><span class="num ${esc(question.type)}">${question.no}</span><strong>${esc(question.stem)}</strong></div><span class="result-question-score">${submission.status === "graded" ? `${question.earnedScore} / ${question.score} 分` : "待阅卷"}</span></div>
      <div class="student-long-answer"><span>我的答案</span><div>${esc(answerDisplay(question.submittedAnswer))}</div></div>
    </article>
  `).join("");
  container.innerHTML = `
    <section class="panel student-result-head ${submission.status === "graded" ? (submission.pass ? "passed" : "failed") : "pending-result"}">
      <div><div class="result-kicker">${submission.status === "graded" ? "阅卷已完成" : "答卷已提交"}</div><h1>${submission.totalScore === null ? "等待阅卷" : `${submission.totalScore} 分`}</h1><p class="brand-sub">第 ${submission.attemptNo} 次考核 · 提交时间：${fmtTime(submission.submittedAt)}</p></div>
      <div class="student-result-score"><span>客观题得分</span><strong>${submission.objectiveScore} 分</strong><small>${submission.status === "graded" ? `通过线 ${submission.passScore} 分` : "最终成绩待阅卷"}</small></div>
    </section>
    <section class="student-review-section"><h2>答题记录</h2><div class="student-question-list">${questionHtml}</div></section>
  `;
}

function renderStudentDetail(data) {
  const { submission, exam: detailExam } = data;
  document.getElementById("studentDetailSub").textContent = `${submission.examTitle} · 第 ${submission.attemptNo} 次考核`;
  const container = document.getElementById("studentDetail");

  if (submission.status !== "graded") {
    container.innerHTML = `
      <section class="panel student-result-head pending-result">
        <div><div class="result-kicker">答卷已提交</div><h1>等待阅卷中</h1><p class="brand-sub">阅卷完成后，此处会显示最终成绩、逐题结果与阅卷批注。</p></div>
        <div class="student-result-score"><span>客观题得分</span><strong>${submission.objectiveScore} 分</strong></div>
      </section>
    `;
    return;
  }

  const passed = Boolean(submission.pass);
  const objectiveQuestions = detailExam.questions.filter((q) => q.type !== "qa");
  const qaQuestions = detailExam.questions.filter((q) => q.type === "qa");
  container.innerHTML = `
    <section class="panel student-result-head ${passed ? "passed" : "failed"}">
      <div><div class="result-kicker">阅卷已完成</div><h1>${submission.totalScore} 分</h1><p class="brand-sub">第 ${submission.attemptNo} 次考核 · 阅卷时间：${fmtTime(submission.gradedAt)}</p></div>
      <div class="student-result-score"><span>考核结果</span><strong>${passed ? "通过" : "未通过"}</strong><small>通过线 ${submission.passScore} 分</small></div>
    </section>
    <section class="student-score-summary">
      <div><span>客观题</span><strong>${submission.objectiveScore} 分</strong></div>
      <div><span>问答题</span><strong>${submission.qaScore} 分</strong></div>
      <div><span>阅卷人</span><strong>${esc(submission.graderName || "-")}</strong></div>
    </section>
    <section class="student-review-section">
      <h2>阅卷批注</h2>
      <div class="student-comment">${esc(submission.graderComment || "阅卷人未留下额外批注。")}</div>
    </section>
    <section class="student-review-section">
      <h2>客观题结果</h2>
      <div class="student-question-list">${objectiveQuestions.map((q, index) => renderStudentObjective(q, index + 1, submission, detailExam)).join("")}</div>
    </section>
    <section class="student-review-section">
      <h2>问答题结果</h2>
      <div class="student-question-list">${qaQuestions.map((q, index) => renderStudentQa(q, index + 1, submission, detailExam)).join("")}</div>
    </section>
  `;
}

function renderStudentObjective(q, no, submission, detailExam) {
  const detail = submission.objectiveDetail?.[q.id] || {};
  const correct = detail.correct !== false;
  const score = detail.earned ?? 0;
  const explanation = q.explanation ? `<div class="student-explanation">${esc(q.explanation)}</div>` : "";
  return `
    <article class="student-question-result ${correct ? "correct" : "incorrect"}">
      <div class="student-question-top"><div><span class="num ${esc(q.type)}">${no}</span><strong>${esc(q.text)}</strong></div><span class="result-question-score">${score}/${q.score} 分</span></div>
      ${imageHtml(getImageSet(q, detailExam).stem || [], "student-image-row")}
      <div class="student-answer-grid"><div><span>我的答案</span><strong>${esc(answerDisplay(detail.answer ?? submission.answers?.[q.id]))}</strong></div><div><span>标准答案</span><strong>${esc(answerDisplay(q.answer))}</strong></div></div>
      ${explanation}
    </article>
  `;
}

function renderStudentQa(q, no, submission, detailExam) {
  const score = submission.qaScores?.[q.id] ?? 0;
  return `
    <article class="student-question-result">
      <div class="student-question-top"><div><span class="num qa">${no}</span><strong>${esc(q.text)}</strong></div><span class="result-question-score">${score}/${q.score} 分</span></div>
      ${imageHtml(getImageSet(q, detailExam).stem || [], "student-image-row")}
      <div class="student-long-answer"><span>我的答案</span><div>${esc(submission.answers?.[q.id] || "未作答")}</div></div>
    </article>
  `;
}

function renderExam() {
  const form = document.getElementById("examForm");
  const grouped = exam.questions.reduce((acc, q) => {
    if (!acc[q.type]) acc[q.type] = [];
    acc[q.type].push(q);
    return acc;
  }, {});

  form.innerHTML = ["single", "multi", "judge", "fill", "qa"].map((type) => {
    const questions = grouped[type] || [];
    if (!questions.length) return "";
    return `
      <section>
        <div class="section-title"><h2>${typeLabels[type]}</h2><span>${typeTips[type]}</span></div>
        ${questions.map((q, index) => renderQuestion(q, index + 1)).join("")}
      </section>
    `;
  }).join("");

  form.addEventListener("change", updateProgress);
  form.addEventListener("input", updateProgress);
  updateProgress();
}

function renderQuestion(q, no) {
  const images = getImageSet(q);
  const options = q.options || {};
  const inputName = `q_${q.id}`;
  let answerHtml = "";

  if (["fill", "qa"].includes(q.type)) {
    answerHtml = `<div class="qa-box"><textarea id="answer_${q.id}" name="${inputName}" placeholder="请在此作答"></textarea></div>`;
  } else {
    const inputType = q.type === "multi" ? "checkbox" : "radio";
    const optionKeys = Array.from(new Set([...Object.keys(options), ...Object.keys(images.options || {})])).sort();
    answerHtml = `<div class="options">${optionKeys.map((key) => `
      <label class="option"><input type="${inputType}" name="${inputName}" value="${esc(key)}"><div class="option-content"><span class="option-key">${esc(key)}.</span>${options[key] ? `<span>${esc(options[key])}</span>` : ""}${optionImageHtml(images.options?.[key])}</div></label>
    `).join("")}</div>`;
  }

  return `
    <article class="panel question-card" data-qid="${esc(q.id)}" data-type="${esc(q.type)}">
      <div class="question-head"><span class="num ${esc(q.type)}">${no}</span><div class="question-text">${esc(q.text)}</div><span class="score-tag">${q.score} 分</span></div>
      ${imageHtml(images.stem || [])}
      ${answerHtml}
    </article>
  `;
}

function collectAnswers() {
  const answers = {};
  for (const q of exam.questions) {
    const name = `q_${q.id}`;
    if (q.type === "multi") answers[q.id] = Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map((el) => el.value);
    else if (["fill", "qa"].includes(q.type)) answers[q.id] = document.querySelector(`[name="${name}"]`)?.value.trim() || "";
    else answers[q.id] = document.querySelector(`input[name="${name}"]:checked`)?.value || "";
  }
  return answers;
}

function isAnswered(q, answers) {
  const value = answers[q.id];
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function updateProgress() {
  if (!exam) return;
  const answers = collectAnswers();
  const answered = exam.questions.filter((q) => isAnswered(q, answers)).length;
  document.getElementById("progressText").textContent = `已答 ${answered} / ${exam.questions.length}`;
  document.getElementById("progressFill").style.width = `${Math.round((answered / exam.questions.length) * 100)}%`;
  document.getElementById("submitSummary").textContent = answered === exam.questions.length ? "已完成全部题目" : `还有 ${exam.questions.length - answered} 题未答`;
  for (const card of document.querySelectorAll(".question-card")) {
    const q = exam.questions.find((item) => String(item.id) === card.dataset.qid);
    card.classList.toggle("answered", q ? isAnswered(q, answers) : false);
  }
}

function startTimer() {
  clearInterval(timerId);
  remainingSeconds = exam.duration * 60;
  updateTimer();
  timerId = setInterval(() => {
    if (submitted) return;
    remainingSeconds -= 1;
    updateTimer();
    if (remainingSeconds <= 0) submitExam(true);
  }, 1000);
}

function updateTimer() {
  const safe = Math.max(0, remainingSeconds);
  document.getElementById("timer").textContent = `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
  document.getElementById("timer").classList.toggle("warn", safe <= 300);
}

async function submitExam(force = false) {
  if (submitted) return;
  const answers = collectAnswers();
  const unanswered = exam.questions.filter((q) => !isAnswered(q, answers)).length;
  if (!force && unanswered > 0 && !confirm(`还有 ${unanswered} 题未答，确认交卷？`)) return;
  if (!force && !confirm("确认提交本次试卷？")) return;

  submitted = true;
  clearInterval(timerId);
  document.getElementById("submitBtn").disabled = true;
  try {
    const endpoint = usingPostgresApi && activeExamId !== "default"
      ? `/api/exams/${encodeURIComponent(activeExamId)}/submissions`
      : "/api/submissions";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startedAt, durationSeconds: Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)), answers })
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || "提交失败");
    showResult(result.submission || result);
  } catch (err) {
    submitted = false;
    document.getElementById("submitBtn").disabled = false;
    alert(err.message || "提交失败，请稍后重试。");
  }
}

function showResult(result) {
  document.getElementById("resultScore").textContent = `${result.objectiveScore} 分`;
  document.getElementById("resultText").textContent = "答卷已提交，最终成绩将在阅卷完成后确认。";
  showOnly("resultPage");
}

async function returnToDashboard() {
  clearInterval(timerId);
  showOnly("dashboardPage");
  try {
    await loadDashboard();
  } catch (err) {
    alert(err.message || "个人记录刷新失败");
  }
}

async function logout() {
  await fetch("/api/auth/logout", { method: "POST" });
  location.reload();
}

async function initialize() {
  const [authRes, meRes] = await Promise.all([fetch("/api/auth/config"), fetch("/api/auth/me")]);
  const auth = await authRes.json();
  const me = await meRes.json();
  if (!auth.enabled) {
    document.getElementById("loginSub").textContent = "钉钉登录尚未配置，请联系系统管理员。";
    document.getElementById("dingtalkLogin").classList.add("hidden");
    return;
  }
  if (!me.user) return;
  currentUser = me.user;
  await returnToDashboard();
}

document.getElementById("submitBtn").addEventListener("click", () => submitExam(false));
document.getElementById("resultBackBtn").addEventListener("click", returnToDashboard);
document.getElementById("backToDashboardBtn").addEventListener("click", returnToDashboard);
document.getElementById("dashboardRefreshBtn").addEventListener("click", loadDashboard);
document.getElementById("studentLogoutBtn").addEventListener("click", logout);

initialize().catch((err) => {
  document.getElementById("startMessage").textContent = err.message || "载入失败";
  document.getElementById("startMessage").classList.remove("hidden");
});
