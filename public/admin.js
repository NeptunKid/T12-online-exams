let submissions = [];
let currentId = "";
let currentDetail = null;
let gradeSaveNotice = "";
let showWrongOnly = false;
let adminUsers = [];
let currentAdminUserId = "";
let adminQuestions = [];
let currentQuestionExamId = "";
let currentQuestionId = "";
let sessionHeartbeatId = 0;
let sessionCheckInFlight = null;

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function questionText(value) {
  return window.QuestionFormat.formatQuestionText(value);
}

function fmtTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toLocaleString("zh-CN", { hour12: false });
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || "请求失败");
    error.status = res.status;
    if (res.status === 401) lockAdminSession("登录状态已失效，请重新使用钉钉登录。");
    throw error;
  }
  return data;
}

function closeOpenAdminDialogs() {
  for (const id of ["adminManagerDialog", "questionManagerDialog"]) {
    const dialog = document.getElementById(id);
    if (dialog?.open) dialog.close();
  }
}

function lockAdminSession(message) {
  if (sessionHeartbeatId) window.clearInterval(sessionHeartbeatId);
  sessionHeartbeatId = 0;
  closeOpenAdminDialogs();
  document.getElementById("adminPage").classList.add("hidden");
  document.getElementById("loginPage").classList.remove("hidden");
  document.getElementById("dingtalkAdminLogin").classList.remove("hidden");
  const msg = document.getElementById("loginMsg");
  msg.textContent = message;
  msg.className = "notice error";
}

function applyAdminAccess(access) {
  document.getElementById("manageAdminsBtn").classList.toggle("hidden", !access.canManageAdmins);
  document.getElementById("manageQuestionsBtn").classList.toggle("hidden", !access.canManageQuestions);
  currentAdminUserId = access.currentUserId || "";
}

async function verifyAdminSession() {
  if (document.getElementById("adminPage").classList.contains("hidden")) return;
  if (sessionCheckInFlight) return sessionCheckInFlight;
  sessionCheckInFlight = api("/api/admin/check")
    .then(applyAdminAccess)
    .catch((error) => {
      if (error.status === 403) lockAdminSession("当前钉钉账号的后台权限已失效，请重新登录或联系系统管理员。");
    })
    .finally(() => {
      sessionCheckInFlight = null;
    });
  return sessionCheckInFlight;
}

function startAdminSessionMonitoring() {
  if (sessionHeartbeatId) window.clearInterval(sessionHeartbeatId);
  sessionHeartbeatId = window.setInterval(() => {
    if (document.visibilityState === "visible") verifyAdminSession();
  }, 60_000);
}

function renderAdminUsers() {
  const query = document.getElementById("adminUserSearch").value.trim().toLowerCase();
  const users = adminUsers.filter((user) => [user.name, user.employeeNo, user.department]
    .some((value) => String(value || "").toLowerCase().includes(query)));
  const list = document.getElementById("adminUserList");
  list.innerHTML = users.length ? users.map((user) => {
    const isCurrent = user.id === currentAdminUserId;
    return `
      <div class="admin-user-row">
        <div class="admin-user-main">
          <div class="admin-user-name">${esc(user.name || "未命名用户")}${isCurrent ? "（当前账号）" : ""}</div>
          <div class="brand-sub">${esc(user.department || "未填写部门")} · ${esc(user.employeeNo || user.identityHint)}</div>
        </div>
        <span class="badge ${user.isAdmin ? "graded" : "pending"}">${user.isAdmin ? "管理员" : "普通用户"}</span>
        <button class="btn ${user.isAdmin ? "danger" : "primary"} compact-btn admin-role-btn" type="button"
          data-user-id="${esc(user.id)}" data-enabled="${user.isAdmin ? "false" : "true"}" ${user.isAdmin && isCurrent ? "disabled" : ""}>
          ${user.isAdmin && isCurrent ? "当前管理员" : user.isAdmin ? "移除" : "设为管理员"}
        </button>
      </div>`;
  }).join("") : `<div class="empty-state admin-user-empty">暂无匹配用户</div>`;

  for (const button of document.querySelectorAll(".admin-role-btn")) {
    button.addEventListener("click", () => updateAdminRole(button));
  }
}

async function loadAdminUsers() {
  const list = document.getElementById("adminUserList");
  list.innerHTML = `<div class="empty-state admin-user-empty">正在载入用户</div>`;
  const data = await api("/api/admin/users");
  adminUsers = data.users;
  renderAdminUsers();
}

async function openAdminManager() {
  const dialog = document.getElementById("adminManagerDialog");
  const message = document.getElementById("adminManagerMsg");
  message.classList.add("hidden");
  dialog.showModal();
  try {
    await loadAdminUsers();
  } catch (error) {
    message.textContent = error.message || "用户列表载入失败";
    message.className = "notice error";
  }
}

async function updateAdminRole(button) {
  const message = document.getElementById("adminManagerMsg");
  const enabled = button.dataset.enabled === "true";
  button.disabled = true;
  message.textContent = enabled ? "正在授予管理员权限" : "正在移除管理员权限";
  message.className = "notice";
  try {
    await api(`/api/admin/users/${encodeURIComponent(button.dataset.userId)}/admin-role`, {
      method: "PUT",
      body: JSON.stringify({ enabled })
    });
    message.textContent = enabled ? "管理员权限已授予" : "管理员权限已移除";
    message.className = "notice success";
    await loadAdminUsers();
  } catch (error) {
    message.textContent = error.message || "管理员权限更新失败";
    message.className = "notice error";
    button.disabled = false;
  }
}

function renderQuestionList() {
  const query = document.getElementById("questionSearch").value.trim().toLowerCase();
  const filtered = window.QuestionAdminModel.filterQuestionsByExam(adminQuestions, currentQuestionExamId, query);
  const list = document.getElementById("questionList");
  document.getElementById("questionCount").textContent = `当前试卷 ${filtered.length} 道题`;
  list.innerHTML = filtered.length ? filtered.map((question) => `
    <button class="question-list-item ${question.id === currentQuestionId ? "active" : ""}" type="button" data-question-id="${esc(question.id)}">
      <span class="question-list-stem">${questionText(question.stem)}</span>
      <span class="brand-sub">${esc(question.bankName)} · ${typeLabel(question.type)} · ${question.score} 分</span>
    </button>
  `).join("") : `<div class="empty-state admin-user-empty">暂无匹配题目</div>`;
  for (const button of document.querySelectorAll(".question-list-item")) {
    button.addEventListener("click", () => selectQuestion(button.dataset.questionId));
  }
}

function renderQuestionExamFilter() {
  const exams = window.QuestionAdminModel.listQuestionExams(adminQuestions);
  const select = document.getElementById("questionExamFilter");
  select.innerHTML = exams.map((exam) => `<option value="${esc(exam.id)}">${esc(exam.title)}</option>`).join("");
  if (!exams.some((exam) => exam.id === currentQuestionExamId)) currentQuestionExamId = exams[0]?.id || "";
  select.value = currentQuestionExamId;
}

function currentAnswerLabels(question) {
  const answer = Array.isArray(question.answer) ? question.answer : [question.answer];
  return new Set(answer.map((item) => String(item || "").trim().toUpperCase()).filter(Boolean));
}

function answerEditor(question) {
  if (["single", "judge", "multi"].includes(question.type)) {
    const value = window.QuestionAdminModel.choiceAnswerText(question.type, question.answer);
    const placeholder = question.type === "multi" ? "例如 A|B|D" : "例如 A";
    return `<div class="field"><label for="questionAnswerText">参考答案</label><input id="questionAnswerText" type="text" value="${esc(value)}" placeholder="${placeholder}" autocomplete="off"></div>`;
  }
  const answer = Array.isArray(question.answer) ? question.answer.join("\n") : question.answer;
  const label = question.type === "fill" ? "参考答案（每行一个可接受答案）" : "参考答案";
  return `<div class="field"><label for="questionAnswerText">${label}</label><textarea id="questionAnswerText">${esc(answer || "")}</textarea></div>`;
}

function renderQuestionEditor() {
  const question = adminQuestions.find((item) => item.id === currentQuestionId);
  const editor = document.getElementById("questionEditor");
  if (!question) {
    editor.innerHTML = `<div class="empty-state">请选择一道题目</div>`;
    return;
  }
  const examNames = question.exams.length ? question.exams.map((exam) => exam.title).join("、") : "尚未用于考试";
  const answerLabels = currentAnswerLabels(question);
  editor.innerHTML = `
    <form id="questionEditorForm" class="question-editor-form">
      <div class="question-editor-meta">
        <span class="badge graded">${esc(question.bankName)}</span>
        <span class="badge pending">${typeLabel(question.type)}</span>
        <span class="brand-sub">版本 ${question.version} · ${question.score} 分</span>
      </div>
      <div class="brand-sub">引用考试：${esc(examNames)}</div>
      <div class="field">
        <label for="questionStem">题干</label>
        <textarea id="questionStem" required>${esc(question.stem)}</textarea>
      </div>
      ${question.options.length ? `
        <div class="field">
          <label>选项</label>
          <div class="question-option-editor">
            ${question.options.map((option) => `
              <div class="question-option-row ${answerLabels.has(option.label) ? "current-answer" : ""}" data-option-label="${esc(option.label)}">
                <div class="question-option-label">${esc(option.label)}.</div>
                <textarea class="question-option-text" data-label="${esc(option.label)}" ${option.hasImage ? "" : "required"}>${esc(option.text)}</textarea>
                ${option.hasImage ? `<span class="brand-sub" style="grid-column:2">保留现有选项图片</span>` : ""}
              </div>
            `).join("")}
          </div>
        </div>` : ""}
      ${answerEditor(question)}
      <div class="field">
        <label for="questionExplanation">题目解析</label>
        <textarea id="questionExplanation">${esc(question.explanation || "")}</textarea>
      </div>
      <div class="question-save-row">
        <button class="btn success" id="saveQuestionBtn" type="submit">保存题目</button>
        <span class="brand-sub" id="questionSaveMsg"></span>
      </div>
    </form>`;
  document.getElementById("questionEditorForm").addEventListener("submit", saveQuestion);
  if (["single", "judge", "multi"].includes(question.type)) {
    document.getElementById("questionAnswerText").addEventListener("input", () => updateChoiceAnswerHighlight(question));
  }
}

function updateChoiceAnswerHighlight(question) {
  const value = document.getElementById("questionAnswerText")?.value || "";
  const parsed = window.QuestionAdminModel.parseChoiceAnswer(question.type, value);
  const labels = new Set(Array.isArray(parsed) ? parsed : [parsed]);
  for (const row of document.querySelectorAll(".question-option-row")) {
    row.classList.toggle("current-answer", labels.has(row.dataset.optionLabel));
  }
}

function selectQuestion(questionId) {
  currentQuestionId = questionId;
  renderQuestionList();
  renderQuestionEditor();
}

async function loadQuestions() {
  document.getElementById("questionList").innerHTML = `<div class="empty-state admin-user-empty">正在载入题目</div>`;
  const data = await api("/api/admin/questions");
  adminQuestions = data.questions;
  renderQuestionExamFilter();
  const examQuestions = window.QuestionAdminModel.filterQuestionsByExam(adminQuestions, currentQuestionExamId);
  if (!examQuestions.some((question) => question.id === currentQuestionId)) currentQuestionId = examQuestions[0]?.id || "";
  renderQuestionList();
  renderQuestionEditor();
}

async function openQuestionManager() {
  const dialog = document.getElementById("questionManagerDialog");
  dialog.showModal();
  try {
    await loadQuestions();
  } catch (error) {
    document.getElementById("questionEditor").innerHTML = `<div class="notice error">${esc(error.message || "题目载入失败")}</div>`;
  }
}

function collectQuestionAnswer(question) {
  if (["single", "judge", "multi"].includes(question.type)) {
    return window.QuestionAdminModel.parseChoiceAnswer(question.type, document.getElementById("questionAnswerText").value);
  }
  const value = document.getElementById("questionAnswerText").value;
  return question.type === "fill" ? value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : value;
}

async function saveQuestion(event) {
  event.preventDefault();
  const question = adminQuestions.find((item) => item.id === currentQuestionId);
  if (!question) return;
  const button = document.getElementById("saveQuestionBtn");
  const message = document.getElementById("questionSaveMsg");
  button.disabled = true;
  message.textContent = "正在保存";
  const options = Array.from(document.querySelectorAll(".question-option-text")).map((input) => ({
    label: input.dataset.label,
    text: input.value
  }));
  try {
    const data = await api(`/api/admin/questions/${encodeURIComponent(question.id)}`, {
      method: "PUT",
      body: JSON.stringify({
        version: question.version,
        stem: document.getElementById("questionStem").value,
        options,
        answer: collectQuestionAnswer(question),
        explanation: document.getElementById("questionExplanation").value
      })
    });
    adminQuestions = adminQuestions.map((item) => item.id === data.question.id ? data.question : item);
    renderQuestionList();
    renderQuestionEditor();
    document.getElementById("questionSaveMsg").textContent = "已保存到题库，历史答卷不受影响。";
  } catch (error) {
    message.textContent = error.message || "题目保存失败";
    button.disabled = false;
  }
}

function badge(status) {
  return status === "graded"
    ? `<span class="badge graded">已批阅</span>`
    : `<span class="badge pending">待批阅</span>`;
}

function typeLabel(type) {
  return { single: "单选题", multi: "多选题", judge: "判断题", fill: "填空题", qa: "问答题" }[type] || type;
}

function answerDisplay(value) {
  if (Array.isArray(value)) return value.length ? value.join("、") : "未作答";
  return value || "未作答";
}

function getImageSet(exam, q) {
  return exam.images?.[q.id] || exam.images?.[String(q.id)] || { stem: [], options: {} };
}

function reviewImages(paths) {
  if (!paths?.length) return "";
  return `<div class="review-image-row">${paths.map((src) => `<img src="/${esc(src)}" alt="题目图片" loading="lazy">`).join("")}</div>`;
}

function renderList() {
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const status = document.getElementById("statusFilter").value;
  const list = submissions.filter((item) => {
    const hit = [item.studentName, item.examTitle]
      .some((value) => String(value || "").toLowerCase().includes(query));
    return hit && (status === "all" || item.status === status);
  });

  document.getElementById("submissionList").innerHTML = list.length ? list.map((item) => `
    <button class="submission-item ${item.id === currentId ? "active" : ""}" type="button" data-id="${esc(item.id)}">
      <div class="submission-line">
        <span class="submission-name">${esc(item.studentName || "未命名")}</span>
        ${badge(item.status)}
      </div>
      <div class="brand-sub">${esc(item.examTitle || "未命名考试")} · 第 ${item.attemptNo || 1} 次考核</div>
      <div class="submission-line" style="margin-top:6px">
        <span class="brand-sub">${fmtTime(item.submittedAt)}</span>
        <strong>${item.totalScore ?? item.objectiveScore} 分</strong>
      </div>
    </button>
  `).join("") : `<div class="empty-state" style="min-height:160px">暂无匹配答卷</div>`;

  for (const button of document.querySelectorAll(".submission-item")) {
    button.addEventListener("click", () => loadDetail(button.dataset.id));
  }
}

async function loadList() {
  const data = await api("/api/admin/submissions");
  submissions = data.submissions;
  document.getElementById("statTotal").textContent = data.stats.total;
  document.getElementById("statPending").textContent = data.stats.pending;
  document.getElementById("statGraded").textContent = data.stats.graded;
  renderList();
}

function renderOptionReview(q, detail, images) {
  const selected = new Set(Array.isArray(detail.answer) ? detail.answer : [detail.answer].filter(Boolean));
  const keys = Array.from(new Set([...Object.keys(q.options || {}), ...Object.keys(images.options || {})])).sort();
  if (!keys.length) return `<div class="answer-box">考生答案：${esc(answerDisplay(detail.answer))}</div>`;

  return `<div class="review-options">${keys.map((key) => `
    <div class="review-option ${selected.has(key) ? "selected" : ""}">
      <strong>${esc(key)}.</strong>
      ${q.options?.[key] ? `<span>${esc(q.options[key])}</span>` : ""}
      ${images.options?.[key] ? `<img src="/${esc(images.options[key])}" alt="选项 ${esc(key)} 图片" loading="lazy">` : ""}
      ${selected.has(key) ? `<span class="selected-mark">考生已选</span>` : ""}
    </div>
  `).join("")}</div>`;
}

function objectiveAnswerStatus(detail) {
  if (detail.correct === true) return "correct";
  if (detail.correct === false) {
    const automaticScore = Number(detail.automaticEarned ?? detail.earned ?? 0);
    return automaticScore > 0 ? "partial" : "incorrect";
  }
  return "incorrect";
}

function objectiveAnswerLabel(status) {
  return { correct: "回答正确", partial: "部分正确", incorrect: "回答错误" }[status];
}

function renderObjectiveReview(submission, exam) {
  const allQuestions = exam.questions.filter((q) => q.type !== "qa");
  const wrongCount = allQuestions.filter((q) => objectiveAnswerStatus(submission.objectiveDetail?.[q.id] || {}) !== "correct").length;
  const questions = allQuestions
    .map((q, index) => ({ q, index }))
    .filter(({ q }) => !showWrongOnly || objectiveAnswerStatus(submission.objectiveDetail?.[q.id] || {}) !== "correct");
  return `
    <section class="review-section">
      <div class="review-section-head">
        <div><h2>客观题批阅</h2><p>可在每题得分框中调整，保存时会重新计算总分。</p></div>
        <div class="objective-review-tools"><strong>当前客观题：${submission.objectiveScore} 分</strong><button class="btn secondary compact-btn" id="wrongOnlyBtn" type="button">${showWrongOnly ? "查看全部题目" : `仅看错题 (${wrongCount})`}</button></div>
      </div>
      <div class="objective-review">
        ${questions.map(({ q, index }) => {
          const detail = submission.objectiveDetail?.[q.id] || {};
          const images = getImageSet(exam, q);
          const automatic = detail.automaticEarned ?? detail.earned ?? 0;
          const status = objectiveAnswerStatus(detail);
          return `
            <article class="objective-review-card ${status !== "correct" ? "answer-incorrect" : "answer-correct"}">
              <div class="question-head review-question-head">
                <span class="num ${esc(q.type)}">${q.no || index + 1}</span>
                <div><div class="question-text">${questionText(q.text)}</div><div class="brand-sub">${typeLabel(q.type)} · 满分 ${q.score} 分</div></div>
                <span class="review-answer-status ${status}">${objectiveAnswerLabel(status)}</span>
              </div>
              ${reviewImages(images.stem || [])}
              <div class="meta-label">考生作答</div>
              ${renderOptionReview(q, detail, images)}
              <div class="reference-box"><strong>标准答案：</strong>${esc(answerDisplay(q.answer))} <span class="brand-sub">自动判分：${automatic} 分</span></div>
              <div class="score-input-row">
                <div class="field">
                  <label for="objective_${q.id}">本题得分</label>
                  <input id="objective_${q.id}" data-qid="${esc(q.id)}" class="objective-score" type="number" min="0" max="${q.score}" step="0.5" value="${detail.earned ?? 0}">
                </div>
                <div class="brand-sub">可输入 0 到 ${q.score} 分；修改后会覆盖自动判分。</div>
              </div>
            </article>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderQaReview(submission, exam) {
  const qa = exam.questions.filter((q) => q.type === "qa");
  return `
    <section class="review-section">
      <div class="review-section-head"><div><h2>问答题批阅</h2><p>请为每道问答题填写分数。</p></div></div>
      <div class="qa-review">
        ${qa.map((q, index) => `
          <article class="qa-review-card">
            <h3>${index + 1}. ${questionText(q.text)} <span class="brand-sub">满分 ${q.score} 分</span></h3>
            ${reviewImages(getImageSet(exam, q).stem || [])}
            <div class="meta-label">考生答案</div>
            <div class="answer-box">${esc(submission.answers?.[q.id] || "未作答")}</div>
            <div class="reference-box"><strong>参考答案：</strong>${esc(q.answer || q.explanation || "未提供")}</div>
            <div class="score-input-row">
              <div class="field">
                <label for="qa_${q.id}">本题得分</label>
                <input id="qa_${q.id}" data-qid="${esc(q.id)}" class="qa-score" type="number" min="0" max="${q.score}" step="0.5" value="${submission.qaScores?.[q.id] ?? ""}">
              </div>
              <div class="brand-sub">请填写 0 到 ${q.score} 之间的分数。</div>
            </div>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderGradeResult(submission) {
  if (submission.status !== "graded") return "";
  const passed = Boolean(submission.pass);
  return `
    <section class="grade-result ${passed ? "passed" : "failed"}">
      <div><div class="result-kicker">批阅已完成</div><strong>${submission.totalScore} 分</strong></div>
      <div><div class="result-outcome">${passed ? "通过" : "未通过"}</div><span>通过线 ${submission.passScore ?? "-"} 分</span></div>
    </section>
  `;
}

function renderRetakeControl(submission, retake) {
  if (!submission.dingtalkUnionId) return "";
  const remaining = retake?.remainingExtraAttempts || 0;
  return `
    <section class="retake-control">
      <div><strong>补考权限</strong><div class="brand-sub">当前为第 ${submission.attemptNo || 1} 次考核；已额外开放 ${remaining} 次。</div></div>
      <button class="btn secondary" id="grantRetakeBtn" type="button">允许再补考一次</button>
      <span class="brand-sub" id="retakeMsg"></span>
    </section>
  `;
}

function renderDetail() {
  const { submission, exam, retake } = currentDetail;
  const qaMax = exam.questions.filter((q) => q.type === "qa").reduce((sum, q) => sum + q.score, 0);
  const totalText = submission.totalScore === null ? "待批阅" : `${submission.totalScore} 分`;

  document.getElementById("detailPanel").innerHTML = `
    <div class="submission-line">
      <div><h1>${esc(submission.studentName || "未命名")}</h1><p class="brand-sub">${esc(submission.examTitle)} · ${fmtTime(submission.submittedAt)}</p></div>
      ${badge(submission.status)}
    </div>
    ${renderGradeResult(submission)}
    <div class="detail-head">
      <div class="meta-item"><div class="meta-label">考核次数</div><div class="meta-value">第 ${submission.attemptNo || 1} 次</div></div>
      <div class="meta-item"><div class="meta-label">提交时间</div><div class="meta-value detail-time">${fmtTime(submission.submittedAt)}</div></div>
      <div class="meta-item"><div class="meta-label">答题用时</div><div class="meta-value">${Math.ceil((submission.durationSeconds || 0) / 60)} 分钟</div></div>
      <div class="meta-item"><div class="meta-label">客观题</div><div class="meta-value">${submission.objectiveScore} 分</div></div>
      <div class="meta-item"><div class="meta-label">通过线</div><div class="meta-value">${submission.passScore ?? exam.passScore} 分</div></div>
      <div class="meta-item"><div class="meta-label">总成绩</div><div class="meta-value">${esc(totalText)}</div></div>
    </div>
    ${renderRetakeControl(submission, retake)}
    ${renderObjectiveReview(submission, exam)}
    ${renderQaReview(submission, exam)}
    <section class="review-save-area">
      <div class="form-grid">
        <div class="field"><label>阅卷人</label><input value="${esc(submission.graderName || "当前钉钉登录账号")}" disabled></div>
        <div class="field"><label for="passScore">通过分数</label><input id="passScore" type="number" min="0" max="${exam.totalScore}" step="0.5" value="${submission.passScore ?? exam.passScore}"></div>
        <div class="field"><label>问答题满分</label><input value="${qaMax} 分" disabled></div>
        <div class="field full"><label for="graderComment">阅卷备注</label><textarea id="graderComment">${esc(submission.graderComment || "")}</textarea></div>
      </div>
      <div class="btn-row" style="margin-top:14px">
        <button class="btn success" id="saveGradeBtn" type="button">保存阅卷成绩</button>
        <span class="brand-sub" id="saveMsg">${gradeSaveNotice || (submission.gradedAt ? `上次保存：${fmtTime(submission.gradedAt)}` : "")}</span>
      </div>
    </section>
  `;

  document.getElementById("saveGradeBtn").addEventListener("click", saveGrade);
  const wrongOnlyButton = document.getElementById("wrongOnlyBtn");
  if (wrongOnlyButton) wrongOnlyButton.addEventListener("click", () => {
    showWrongOnly = !showWrongOnly;
    renderDetail();
  });
  const grantButton = document.getElementById("grantRetakeBtn");
  if (grantButton) grantButton.addEventListener("click", grantRetake);
}

async function loadDetail(id) {
  currentId = id;
  gradeSaveNotice = "";
  showWrongOnly = false;
  renderList();
  document.getElementById("detailPanel").innerHTML = `<div class="empty-state">正在载入答卷</div>`;
  currentDetail = await api(`/api/admin/submissions/${encodeURIComponent(id)}`);
  renderDetail();
}

async function saveGrade() {
  if (!currentDetail) return;
  const qaScores = {};
  const objectiveScores = {};
  for (const input of document.querySelectorAll(".qa-score")) qaScores[input.dataset.qid] = input.value;
  for (const input of document.querySelectorAll(".objective-score")) objectiveScores[input.dataset.qid] = input.value;

  const saveMsg = document.getElementById("saveMsg");
  saveMsg.textContent = "正在保存";
  try {
    const data = await api(`/api/admin/submissions/${encodeURIComponent(currentId)}`, {
      method: "PUT",
      body: JSON.stringify({
        objectiveScores,
        qaScores,
        passScore: document.getElementById("passScore").value,
        graderComment: document.getElementById("graderComment").value
      })
    });
    currentDetail.submission = data.submission;
    gradeSaveNotice = `已完成批阅：${data.submission.totalScore} 分，${data.submission.pass ? "通过考核" : "未通过考核"}。`;
    await loadList();
    renderDetail();
  } catch (err) {
    saveMsg.textContent = err.message || "保存失败";
  }
}

async function grantRetake() {
  const button = document.getElementById("grantRetakeBtn");
  const message = document.getElementById("retakeMsg");
  button.disabled = true;
  message.textContent = "正在开放";
  try {
    const data = await api(`/api/admin/submissions/${encodeURIComponent(currentId)}/retake-permission`, { method: "PUT" });
    currentDetail.retake = data.retake;
    gradeSaveNotice = `已额外开放 1 次补考，当前剩余 ${data.retake.remainingExtraAttempts} 次。`;
    renderDetail();
  } catch (err) {
    message.textContent = err.message || "开放补考失败";
    button.disabled = false;
  }
}

async function initializeAdmin() {
  const msg = document.getElementById("loginMsg");
  msg.classList.add("hidden");
  try {
    const [configRes, meRes] = await Promise.all([fetch("/api/auth/config"), fetch("/api/auth/me")]);
    const config = await configRes.json();
    const me = await meRes.json();
    if (!config.enabled) {
      document.getElementById("dingtalkAdminLogin").classList.add("hidden");
      msg.textContent = "钉钉登录尚未配置，请联系系统管理员。";
      msg.classList.remove("hidden");
      return;
    }
    if (!me.user) return;
    const access = await api("/api/admin/check");
    applyAdminAccess(access);
    document.getElementById("loginPage").classList.add("hidden");
    document.getElementById("adminPage").classList.remove("hidden");
    await loadList();
    startAdminSessionMonitoring();
  } catch (err) {
    msg.textContent = err.message || "当前钉钉账号没有阅卷权限。";
    msg.className = "notice error";
  }
}

document.getElementById("refreshBtn").addEventListener("click", loadList);
document.getElementById("manageAdminsBtn").addEventListener("click", openAdminManager);
document.getElementById("manageQuestionsBtn").addEventListener("click", openQuestionManager);
document.getElementById("closeAdminManagerBtn").addEventListener("click", () => {
  document.getElementById("adminManagerDialog").close();
});
document.getElementById("closeQuestionManagerBtn").addEventListener("click", () => {
  document.getElementById("questionManagerDialog").close();
});
document.getElementById("adminUserSearch").addEventListener("input", renderAdminUsers);
document.getElementById("questionSearch").addEventListener("input", renderQuestionList);
document.getElementById("questionExamFilter").addEventListener("change", (event) => {
  currentQuestionExamId = event.target.value;
  const examQuestions = window.QuestionAdminModel.filterQuestionsByExam(adminQuestions, currentQuestionExamId);
  currentQuestionId = examQuestions[0]?.id || "";
  document.getElementById("questionSearch").value = "";
  renderQuestionList();
  renderQuestionEditor();
});
document.getElementById("logoutBtn").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  location.reload();
});
document.getElementById("searchInput").addEventListener("input", renderList);
document.getElementById("statusFilter").addEventListener("change", renderList);
window.addEventListener("pageshow", verifyAdminSession);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") verifyAdminSession();
});
initializeAdmin();
