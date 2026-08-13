let submissions = [];
let currentId = "";
let currentDetail = null;
let gradeSaveNotice = "";
let showWrongOnly = false;
let adminUsers = [];
let identityMergeCandidates = [];
let currentAdminUserId = "";
let adminQuestions = [];
let adminQuestionBanks = [];
let currentQuestionFilterId = "";
let currentQuestionId = "";
let newQuestionDraft = null;
let questionBankEditorMode = "";
let questionBankBusy = false;
let questionBankNotice = { text: "", type: "" };
let questionImageDraft = null;
let questionImageUploadBusy = false;
let questionOptionImageDraft = null;
let sessionHeartbeatId = 0;
let sessionCheckInFlight = null;
let adminAuthProviders = { dingtalk: true, feishu: false };
let adminExams = [];
let currentAuthoringExamId = "";
let currentExamAuthoring = null;
let examAuthoringBusy = false;
let examSelectionDirty = false;
let examSelectAllRequested = false;
let examBulkScoreDraft = "1";
let examRevisionEditing = false;
let newExamDraft = null;
let backupCatalog = { exams: [], banks: [] };
let backupBusy = false;
let backupAutomation = { automation: null, runs: [] };

function setAdminWorkspace(view) {
  const layout = document.querySelector(".admin-layout");
  if (!layout) return;
  layout.classList.toggle("show-detail", view === "detail");
  if (window.matchMedia("(max-width: 820px)").matches) window.scrollTo({ top: 0, behavior: "auto" });
}

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
    if (res.status === 401) lockAdminSession("登录状态已失效，请重新使用钉钉或飞书登录。");
    throw error;
  }
  return data;
}

function closeOpenAdminDialogs() {
  for (const id of ["adminManagerDialog", "questionManagerDialog", "examAuthoringDialog", "backupManagerDialog"]) {
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
  updateAdminLoginButtons();
  const msg = document.getElementById("loginMsg");
  msg.textContent = message;
  msg.className = "notice error";
}

function updateAdminLoginButtons() {
  document.getElementById("dingtalkAdminLogin").classList.toggle("hidden", !adminAuthProviders.dingtalk);
  document.getElementById("feishuAdminLogin").classList.toggle("hidden", !adminAuthProviders.feishu);
}

function applyAdminAccess(access) {
  document.getElementById("manageAdminsBtn").classList.toggle("hidden", !access.canManageAdmins);
  document.getElementById("manageQuestionsBtn").classList.toggle("hidden", !access.canManageQuestions);
  document.getElementById("manageExamsBtn").classList.toggle("hidden", !access.canManageQuestions);
  document.getElementById("manageBackupsBtn").classList.toggle("hidden", !access.canManageQuestions);
  currentAdminUserId = access.currentUserId || "";
}

function showBackupMessage(message, tone = "") {
  const element = document.getElementById("backupManagerMsg");
  element.textContent = message;
  element.className = `notice${tone ? ` ${tone}` : ""}`;
}

function renderBackupCatalog() {
  const examSelect = document.getElementById("backupExamSelect");
  const bankSelect = document.getElementById("backupQuestionBankSelect");
  examSelect.innerHTML = backupCatalog.exams.length
    ? backupCatalog.exams.map((exam) => `<option value="${esc(exam.id)}">${esc(exam.title || "未命名试卷")}</option>`).join("")
    : `<option value="">暂无可导出的试卷</option>`;
  bankSelect.innerHTML = backupCatalog.banks.length
    ? backupCatalog.banks.map((bank) => `<option value="${esc(bank.id)}">${esc(bank.name || "未命名题库")}</option>`).join("")
    : `<option value="">暂无可导出的题库</option>`;
  document.getElementById("exportExamBackupBtn").disabled = backupBusy || !backupCatalog.exams.length;
  document.getElementById("exportQuestionBankBackupBtn").disabled = backupBusy || !backupCatalog.banks.length;
}

function backupScopeLabel(run) {
  if (run.scopeType === "exam") {
    return backupCatalog.exams.find((item) => item.id === run.scopeId)?.title || run.scopeId;
  }
  return backupCatalog.banks.find((item) => item.id === run.scopeId)?.name || run.scopeId;
}

function renderBackupAutomation() {
  const automation = backupAutomation.automation;
  const meta = document.getElementById("backupAutomationMeta");
  const summary = document.getElementById("backupAutomationSummary");
  const list = document.getElementById("backupRunList");
  const runButton = document.getElementById("runBackupAutomationBtn");
  if (!automation) {
    meta.textContent = "自动备份状态暂不可用";
    summary.innerHTML = "";
    list.innerHTML = `<div class="empty-state">暂无自动备份运行记录</div>`;
    runButton.disabled = true;
    return;
  }
  const storage = automation.storageType === "filesystem" ? "服务器目录" : "PostgreSQL";
  meta.textContent = automation.enabled
    ? `每 ${automation.intervalHours} 小时 · ${storage} · 每个对象保留 ${automation.retentionCount} 份`
    : "未启用；请通过服务器环境变量配置";
  const last = automation.lastSummary;
  summary.innerHTML = `
    <span class="badge ${automation.enabled ? "graded" : "pending"}">${automation.enabled ? "已启用" : "未启用"}</span>
    <span>${automation.running ? "正在运行" : automation.nextRunAt ? `下次 ${fmtTime(automation.nextRunAt)}` : "当前空闲"}</span>
    ${last ? `<span>上次：成功 ${Number(last.succeeded || 0)}，失败 ${Number(last.failed || 0)}${last.cleanupFailed ? `，清理失败 ${Number(last.cleanupFailed)}` : ""}</span>` : ""}
  `;
  runButton.disabled = backupBusy || !automation.enabled || automation.running;
  const runs = backupAutomation.runs || [];
  list.innerHTML = runs.length ? runs.map((run) => `
    <div class="backup-run-row">
      <div class="backup-run-main">
        <strong>${esc(backupScopeLabel(run))}</strong>
        <span class="brand-sub">${run.scopeType === "exam" ? "试卷" : "题库"} · ${fmtTime(run.startedAt)}</span>
        ${run.errorMessage ? `<span class="backup-run-error">${esc(run.errorMessage)}</span>` : ""}
      </div>
      <span class="badge ${run.status === "succeeded" ? "graded" : run.status === "failed" ? "danger" : "pending"}">${run.status === "succeeded" ? "成功" : run.status === "failed" ? "失败" : "运行中"}</span>
      ${run.artifact ? `<button class="btn secondary compact-btn stored-backup-download-btn" type="button" data-artifact-id="${esc(run.artifact.id)}">下载</button>` : ""}
    </div>
  `).join("") : `<div class="empty-state">暂无自动备份运行记录</div>`;
}

async function loadBackupCatalog() {
  const [examData, bankData] = await Promise.all([
    api("/api/admin/exams"),
    api("/api/admin/question-banks")
  ]);
  backupCatalog = {
    exams: examData.exams || [],
    banks: bankData.banks || []
  };
  renderBackupCatalog();
}

async function loadBackupAutomation() {
  backupAutomation = await api("/api/admin/backups/automation");
  renderBackupAutomation();
}

async function openBackupManager() {
  const dialog = document.getElementById("backupManagerDialog");
  dialog.showModal();
  document.getElementById("backupManagerMsg").classList.add("hidden");
  backupCatalog = { exams: [], banks: [] };
  backupAutomation = { automation: null, runs: [] };
  renderBackupCatalog();
  renderBackupAutomation();
  const results = await Promise.allSettled([loadBackupCatalog(), loadBackupAutomation()]);
  renderBackupAutomation();
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) showBackupMessage(failures[0].reason?.message || "备份状态载入失败", "error");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function backupFilenameFromResponse(response, kind) {
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch (_) { /* use fallback */ }
  }
  return plain || `t12-${kind}-backup.t12backup`;
}

async function exportBackup(kind, id) {
  if (backupBusy || !id) return;
  backupBusy = true;
  renderBackupCatalog();
  showBackupMessage("正在生成自包含备份包，请勿关闭页面");
  try {
    const query = new URLSearchParams({ kind, id });
    const response = await fetch(`/api/admin/backups/export?${query.toString()}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) lockAdminSession("登录状态已失效，请重新使用钉钉或飞书登录。");
      throw new Error(data.error || "备份导出失败");
    }
    downloadBlob(await response.blob(), backupFilenameFromResponse(response, kind));
    showBackupMessage("备份包已生成并开始下载。", "success");
  } catch (error) {
    showBackupMessage(error.message || "备份导出失败", "error");
  } finally {
    backupBusy = false;
    renderBackupCatalog();
  }
}

async function importBackup() {
  const input = document.getElementById("backupImportFile");
  const file = input.files?.[0];
  if (backupBusy || !file) return;
  backupBusy = true;
  document.getElementById("importBackupBtn").disabled = true;
  showBackupMessage("正在校验并导入备份包，请勿关闭页面");
  try {
    const form = new FormData();
    form.append("backup", file, file.name);
    const response = await fetch("/api/admin/backups/import", { method: "POST", body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) lockAdminSession("登录状态已失效，请重新使用钉钉或飞书登录。");
      throw new Error(data.error || "备份导入失败");
    }
    const created = [data.questionBank?.name, data.exam?.title].filter(Boolean).join("、");
    showBackupMessage(created ? `导入成功，已创建：${created}` : "导入成功，已创建新的题库或试卷。", "success");
    input.value = "";
    try {
      await loadBackupCatalog();
    } catch (_) {
      showBackupMessage("导入成功，但备份目录刷新失败；重新打开本窗口即可查看新记录。", "success");
    }
  } catch (error) {
    showBackupMessage(error.message || "备份导入失败", "error");
  } finally {
    backupBusy = false;
    document.getElementById("importBackupBtn").disabled = !input.files?.length;
    renderBackupCatalog();
  }
}

async function triggerAutomaticBackup() {
  if (backupBusy || !backupAutomation.automation?.enabled) return;
  backupBusy = true;
  renderBackupCatalog();
  renderBackupAutomation();
  try {
    await api("/api/admin/backups/automation/run", { method: "POST", body: "{}" });
    showBackupMessage("自动备份已启动，可稍后刷新查看每个对象的结果。", "success");
    await loadBackupAutomation();
  } catch (error) {
    showBackupMessage(error.message || "自动备份启动失败", "error");
  } finally {
    backupBusy = false;
    renderBackupCatalog();
    renderBackupAutomation();
  }
}

async function downloadStoredBackup(artifactId) {
  if (backupBusy || !artifactId) return;
  backupBusy = true;
  renderBackupAutomation();
  try {
    const response = await fetch(`/api/admin/backups/artifacts/${encodeURIComponent(artifactId)}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "历史备份下载失败");
    }
    downloadBlob(await response.blob(), backupFilenameFromResponse(response, "stored"));
  } catch (error) {
    showBackupMessage(error.message || "历史备份下载失败", "error");
  } finally {
    backupBusy = false;
    renderBackupAutomation();
  }
}

async function verifyAdminSession() {
  if (document.getElementById("adminPage").classList.contains("hidden")) return;
  if (sessionCheckInFlight) return sessionCheckInFlight;
  sessionCheckInFlight = api("/api/admin/check")
    .then(applyAdminAccess)
    .catch((error) => {
      if (error.status === 403) lockAdminSession("当前账号的后台权限已失效，请重新登录或联系系统管理员。");
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

function providerLabel(provider) {
  return { dingtalk: "钉钉", feishu: "飞书", legacy: "历史钉钉" }[provider] || provider;
}

function mergeCandidateUser(group, userId) {
  return group.users.find((user) => user.id === userId);
}

function mergeUserDescription(user) {
  if (!user) return "未知账号";
  const providers = (user.providers || []).map(providerLabel).join("+");
  return `${providers} · ${user.department || "未填写部门"} · ${user.employeeNo || "未填写工号"}`;
}

function renderMergeCandidates() {
  const list = document.getElementById("identityMergeList");
  if (!identityMergeCandidates.length) {
    list.innerHTML = `<div class="empty-state identity-merge-empty">没有待确认的同名跨平台账号</div>`;
    return;
  }
  list.innerHTML = identityMergeCandidates.map((group) => `
    <div class="identity-merge-group">
      <div class="identity-merge-title">
        <strong>${esc(group.displayName)}</strong>
        ${group.ambiguous ? `<span class="badge pending">存在歧义，必须逐项核对</span>` : `<span class="badge graded">唯一候选</span>`}
      </div>
      ${group.pairs.map((pair) => {
        const canonical = mergeCandidateUser(group, pair.canonicalUserId);
        const duplicate = mergeCandidateUser(group, pair.duplicateUserId);
        const action = group.ambiguous
          ? `<span class="brand-sub">候选存在歧义，暂不支持合并</span>`
          : `<button class="btn danger compact-btn identity-merge-btn" type="button"
              data-name="${esc(group.displayName)}"
              data-canonical-user-id="${esc(pair.canonicalUserId)}"
              data-duplicate-user-id="${esc(pair.duplicateUserId)}">核对并合并</button>`;
        return `<div class="identity-merge-pair">
          <div class="admin-user-main">
            <div><strong>保留：</strong>${esc(mergeUserDescription(canonical))}</div>
            <div><strong>归并：</strong>${esc(mergeUserDescription(duplicate))}</div>
          </div>
          ${action}
        </div>`;
      }).join("")}
    </div>
  `).join("");
  for (const button of document.querySelectorAll(".identity-merge-btn")) {
    button.addEventListener("click", () => mergeIdentityPair(button));
  }
}

async function loadMergeCandidates() {
  const list = document.getElementById("identityMergeList");
  const refreshButton = document.getElementById("refreshMergeCandidatesBtn");
  list.innerHTML = `<div class="empty-state identity-merge-empty">正在检查同名账号</div>`;
  refreshButton.disabled = true;
  try {
    const data = await api("/api/admin/user-merge-candidates");
    identityMergeCandidates = data.candidates || [];
    renderMergeCandidates();
    return true;
  } catch (error) {
    list.innerHTML = `<div class="empty-state identity-merge-empty">候选加载失败，请重新检查</div>`;
    return false;
  } finally {
    refreshButton.disabled = false;
  }
}

async function mergeIdentityPair(button) {
  const group = identityMergeCandidates.find((item) => item.displayName === button.dataset.name
    && item.pairs.some((pair) => pair.canonicalUserId === button.dataset.canonicalUserId
      && pair.duplicateUserId === button.dataset.duplicateUserId));
  if (!group || group.ambiguous) return;
  const canonical = mergeCandidateUser(group, button.dataset.canonicalUserId);
  const duplicate = mergeCandidateUser(group, button.dataset.duplicateUserId);
  const confirmed = window.confirm(
    `确认将“${group.displayName}”的飞书账号归并到钉钉主账号吗？\n\n保留：${mergeUserDescription(canonical)}\n归并：${mergeUserDescription(duplicate)}\n\n题目快照、作答内容和分数保持不变；账号角色、考试授权、答卷归属、考试次数和补考权限将合并。`
  );
  if (!confirmed) return;

  const message = document.getElementById("adminManagerMsg");
  button.disabled = true;
  message.textContent = "正在合并账号，请勿关闭页面";
  message.className = "notice";
  try {
    await api("/api/admin/user-merges", {
      method: "POST",
      body: JSON.stringify({
        canonicalUserId: button.dataset.canonicalUserId,
        duplicateUserId: button.dataset.duplicateUserId,
        expectedName: group.displayName
      })
    });
    message.textContent = "账号已合并；钉钉和飞书登录将使用同一内部用户";
    message.className = "notice success";
    try {
      const [, candidatesLoaded] = await Promise.all([loadAdminUsers(), loadMergeCandidates()]);
      if (!candidatesLoaded) {
        message.textContent = "账号已合并，但候选列表刷新失败；请重新打开管理员设置确认结果";
        message.className = "notice success";
      }
    } catch (_) {
      message.textContent = "账号已合并，但列表刷新失败；请重新打开管理员设置确认结果";
      message.className = "notice success";
    }
  } catch (error) {
    message.textContent = error.message || "账号合并失败";
    message.className = "notice error";
    button.disabled = false;
  }
}

async function openAdminManager() {
  const dialog = document.getElementById("adminManagerDialog");
  const message = document.getElementById("adminManagerMsg");
  message.classList.add("hidden");
  dialog.showModal();
  try {
    await Promise.all([loadAdminUsers(), loadMergeCandidates()]);
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

function examStatusLabel(status) {
  return {
    draft: "草稿",
    published: "已发布",
    scheduled: "已排期",
    paused: "已暂停",
    closed: "已结束",
    archived: "已归档"
  }[status] || status || "未知状态";
}

function examStatusBadge(status) {
  const tone = status === "draft" ? "pending" : "graded";
  return `<span class="badge ${tone}">${esc(examStatusLabel(status))}</span>`;
}

function normalizeAuthoringQuestion(question, selectedIds = new Set()) {
  const id = String(question.id || question.questionId || "");
  const hasPosition = question.position !== null && question.position !== undefined;
  const hasScore = question.score !== null && question.score !== undefined;
  const explicitlySelected = question.selected ?? question.inExam ?? question.assigned;
  return {
    ...question,
    id,
    selected: explicitlySelected === undefined
      ? selectedIds.has(id) || hasPosition || hasScore
      : Boolean(explicitlySelected),
    position: hasPosition ? Number(question.position) : null,
    score: hasScore ? Number(question.score) : null
  };
}

function normalizeExamAuthoring(data) {
  const payload = data.authoring || data;
  const selectedSource = payload.selectedQuestions || payload.examQuestions || [];
  const selectedIds = new Set(selectedSource.map((question) => String(question.id || question.questionId || "")));
  const availableSource = payload.questions || payload.bankQuestions || [];
  const byId = new Map();
  for (const question of availableSource) {
    const normalized = normalizeAuthoringQuestion(question, selectedIds);
    if (normalized.id) byId.set(normalized.id, normalized);
  }
  for (const question of selectedSource) {
    const normalized = normalizeAuthoringQuestion({ ...byId.get(String(question.id || question.questionId || "")), ...question, selected: true }, selectedIds);
    if (normalized.id) byId.set(normalized.id, normalized);
  }
  return {
    exam: payload.exam || data.exam || {},
    banks: payload.banks || payload.questionBanks || data.banks || [],
    questions: Array.from(byId.values())
  };
}

function selectedAuthoringQuestions() {
  if (!currentExamAuthoring) return [];
  return currentExamAuthoring.questions
    .filter((question) => question.selected)
    .sort((left, right) => {
      const leftPosition = Number.isFinite(left.position) ? left.position : Number.MAX_SAFE_INTEGER;
      const rightPosition = Number.isFinite(right.position) ? right.position : Number.MAX_SAFE_INTEGER;
      return leftPosition - rightPosition;
    });
}

function renderExamAuthoringList() {
  const list = document.getElementById("examAuthoringList");
  document.getElementById("examAuthoringCount").textContent = `${adminExams.length} 张试卷`;
  list.innerHTML = adminExams.length ? adminExams.map((exam) => `
    <button class="exam-authoring-list-item ${exam.id === currentAuthoringExamId ? "active" : ""}" type="button" data-exam-id="${esc(exam.id)}">
      <span class="exam-authoring-list-head"><strong>${esc(exam.title || "未命名试卷")}</strong>${examStatusBadge(exam.status)}</span>
      <span class="brand-sub">${esc(exam.questionBankName || "未绑定题库")} · ${Number(exam.questionCount || 0)} 题 · ${Number(exam.totalScore || 0)} 分</span>
    </button>
  `).join("") : `<div class="empty-state admin-user-empty">暂无试卷</div>`;
  for (const button of document.querySelectorAll(".exam-authoring-list-item")) {
    button.addEventListener("click", () => loadExamAuthoring(button.dataset.examId));
  }
}

function examDurationMinutes(exam) {
  return Math.max(1, Math.round(Number(exam.durationSeconds ?? exam.duration ?? 0) / 60));
}

function renderNewExamEditor() {
  const editor = document.getElementById("examAuthoringEditor");
  editor.innerHTML = `
    <form id="newExamForm" class="exam-settings-form">
      <div class="exam-authoring-editor-head">
        <div>
          <div class="question-editor-meta"><span class="badge pending">新试卷</span></div>
          <h3>新增试卷</h3>
        </div>
      </div>
      <section class="exam-authoring-section">
        <div class="exam-settings-grid">
          <div class="field">
            <label for="newExamTitle">试卷名称</label>
            <input id="newExamTitle" maxlength="200" value="${esc(newExamDraft.title)}" required autocomplete="off">
          </div>
          <div class="field">
            <label for="newExamDuration">考试时长（分钟）</label>
            <input id="newExamDuration" type="number" min="1" max="1440" step="1" value="${esc(newExamDraft.durationMinutes)}" required>
          </div>
          <div class="field">
            <label for="newExamPassRate">通过比例（%）</label>
            <input id="newExamPassRate" type="number" min="0" max="100" step="0.01" value="${esc(newExamDraft.passRatePercent)}" required>
          </div>
        </div>
        <div class="question-save-row">
          <button class="btn primary" id="createExamBtn" type="submit" ${examAuthoringBusy ? "disabled" : ""}>创建试卷</button>
          <button class="btn secondary" id="cancelNewExamBtn" type="button" ${examAuthoringBusy ? "disabled" : ""}>取消</button>
        </div>
      </section>
    </form>`;
  document.getElementById("newExamForm").addEventListener("submit", createExam);
  document.getElementById("cancelNewExamBtn").addEventListener("click", cancelNewExam);
}

function authoringQuestionLabel(question, index) {
  const reference = question.externalId ? `${question.externalId} · ` : "";
  const order = question.selected ? `第 ${index + 1} 题 · ` : "";
  const status = question.status === "active" ? "" : " · 题目已归档";
  return `${order}${reference}${typeLabel(question.type)}${status}`;
}

function renderExamAuthoringEditor() {
  const editor = document.getElementById("examAuthoringEditor");
  if (newExamDraft) return renderNewExamEditor();
  if (!currentExamAuthoring?.exam?.id) {
    editor.innerHTML = `<div class="empty-state">请选择一张试卷</div>`;
    return;
  }
  const { exam, banks, questions } = currentExamAuthoring;
  const editable = exam.status === "draft" || examRevisionEditing;
  const selected = selectedAuthoringQuestions();
  const hasArchivedSelection = selected.some((question) => question.status !== "active");
  const selectedIndex = new Map(selected.map((question, index) => [question.id, index]));
  const bankId = exam.questionBankId || exam.question_bank_id || "";
  const visibleBanks = banks.filter((bank) => bank.status !== "archived" || bank.id === bankId);
  const passRate = Number(exam.passRate ?? exam.pass_rate ?? 0);
  const displayQuestions = [...selected, ...questions.filter((question) => !question.selected)];
  editor.innerHTML = `
    <div class="exam-authoring-editor-head">
      <div>
        <div class="question-editor-meta">${examStatusBadge(exam.status)}<span class="brand-sub">版本 ${Number(exam.version || 0)}</span></div>
        <h3>${esc(exam.title || "未命名试卷")}</h3>
      </div>
      <div class="exam-editor-head-actions">
        <button class="btn secondary compact-btn" id="copyExamBtn" type="button" ${examAuthoringBusy ? "disabled" : ""}>复制试卷</button>
        ${editable
          ? `<button class="btn success compact-btn" id="publishExamBtn" type="button" ${examAuthoringBusy ? "disabled" : ""}>${Number(exam.version || 1) > 1 ? "重新发布" : "发布试卷"}</button>`
          : `<button class="btn primary compact-btn" id="startExamRevisionBtn" type="button" ${examAuthoringBusy ? "disabled" : ""}>编辑新版本</button>`}
        ${examRevisionEditing ? `<button class="btn secondary compact-btn" id="cancelExamRevisionBtn" type="button" ${examAuthoringBusy ? "disabled" : ""}>取消编辑</button>` : ""}
      </div>
    </div>
    ${editable ? "" : `<div class="notice">点击“编辑新版本”后进入本地编辑；只有保存实际修改时才会转为草稿，历史答卷保留，修改完成后可重新发布。</div>`}
    <section class="exam-authoring-section">
      <div class="exam-authoring-section-head">
        <div><h3>试卷参数</h3><p class="brand-sub">版本 ${Number(exam.version || 0)}</p></div>
        <div class="exam-score-summary">
          <span><small>总分</small><strong>${Number(exam.totalScore || 0)}</strong></span>
          <span><small>通过分</small><strong>${Number(exam.passScore || 0)}</strong></span>
          <span><small>通过比例</small><strong>${Math.round(passRate * 10000) / 100}%</strong></span>
        </div>
      </div>
      <form id="examSettingsForm" class="exam-settings-grid">
        <div class="field">
          <label for="examTitleInput">试卷名称</label>
          <input id="examTitleInput" maxlength="200" value="${esc(exam.title || "")}" required autocomplete="off" ${editable && !examAuthoringBusy ? "" : "disabled"}>
        </div>
        <div class="field">
          <label for="examDurationInput">考试时长（分钟）</label>
          <input id="examDurationInput" type="number" min="1" max="1440" step="1" value="${examDurationMinutes(exam)}" required ${editable && !examAuthoringBusy ? "" : "disabled"}>
        </div>
        <div class="field">
          <label for="examPassRateInput">通过比例（%）</label>
          <input id="examPassRateInput" type="number" min="0" max="100" step="0.01" value="${Math.round(passRate * 10000) / 100}" required ${editable && !examAuthoringBusy ? "" : "disabled"}>
        </div>
        <button class="btn primary compact-btn exam-settings-save" type="submit" ${editable && !examAuthoringBusy ? "" : "disabled"}>保存参数</button>
      </form>
    </section>
    <section class="exam-authoring-section">
      <div class="exam-authoring-section-head">
        <div><h3>对应题库</h3><p class="brand-sub">一张试卷只能从一个题库选题</p></div>
        <div class="exam-bank-controls">
          <select id="examQuestionBankSelect" aria-label="试卷题库" ${editable && !examAuthoringBusy ? "" : "disabled"}>
            <option value="">请选择题库</option>
            ${visibleBanks.map((bank) => `<option value="${esc(bank.id)}" ${bank.id === bankId ? "selected" : ""} ${bank.status === "archived" ? "disabled" : ""}>${esc(bank.name)}（${Number(bank.questionCount || 0)} 题${bank.status === "archived" ? "·已归档" : ""}）</option>`).join("")}
          </select>
          <button class="btn secondary compact-btn" id="saveExamBankBtn" type="button" ${editable && !examAuthoringBusy ? "" : "disabled"}>绑定题库</button>
        </div>
      </div>
    </section>
    <section class="exam-authoring-section">
      <div class="exam-authoring-section-head">
        <div><h3>试题与分值</h3><p class="brand-sub">已选 ${selected.length} / ${questions.length} 题；勾选保存后再调整顺序和分值</p></div>
        ${editable && bankId ? `<div class="exam-selection-actions">
          <button class="btn secondary compact-btn" id="selectAllExamQuestionsBtn" type="button" ${examAuthoringBusy ? "disabled" : ""}>全选</button>
          <button class="btn secondary compact-btn" id="clearExamQuestionsBtn" type="button" ${examAuthoringBusy ? "disabled" : ""}>清空</button>
          <button class="btn primary compact-btn" id="saveExamQuestionsBtn" type="button" ${examAuthoringBusy || !examSelectionDirty ? "disabled" : ""}>保存选题</button>
        </div>` : ""}
      </div>
      ${hasArchivedSelection ? `<div class="notice error">当前试卷包含已归档题目。请取消勾选并保存选题，之后再调整顺序或分值。</div>` : ""}
      ${editable && selected.length && !examSelectionDirty && !hasArchivedSelection ? `<div class="exam-bulk-score">
        <label for="examBulkScoreInput">全部已选题统一分值</label>
        <input id="examBulkScoreInput" type="number" min="0" step="0.5" value="${esc(examBulkScoreDraft)}">
        <button class="btn secondary compact-btn" id="saveExamBulkScoreBtn" type="button" ${examAuthoringBusy ? "disabled" : ""}>批量设置</button>
      </div>` : ""}
      <div class="exam-question-list">
        ${displayQuestions.length ? displayQuestions.map((question) => {
          const index = selectedIndex.get(question.id);
          const score = question.score === null ? 0 : question.score;
          return `<article class="exam-question-row ${question.selected ? "selected" : ""}" data-question-id="${esc(question.id)}">
            <label class="exam-question-select">
              <input class="exam-question-checkbox" type="checkbox" data-question-id="${esc(question.id)}" ${question.selected ? "checked" : ""} ${editable && !examAuthoringBusy && (question.status === "active" || question.selected) ? "" : "disabled"}>
              <span><strong>${questionText(question.stem || "未填写题干")}</strong><small>${esc(authoringQuestionLabel(question, index ?? 0))}</small></span>
            </label>
            ${question.selected ? `<div class="exam-question-actions">
              <button class="icon-action exam-order-btn" type="button" data-direction="up" data-question-id="${esc(question.id)}" title="上移" aria-label="上移" ${editable && !examAuthoringBusy && !examSelectionDirty && !hasArchivedSelection && index > 0 ? "" : "disabled"}>↑</button>
              <button class="icon-action exam-order-btn" type="button" data-direction="down" data-question-id="${esc(question.id)}" title="下移" aria-label="下移" ${editable && !examAuthoringBusy && !examSelectionDirty && !hasArchivedSelection && index < selected.length - 1 ? "" : "disabled"}>↓</button>
              <label class="exam-question-score"><span>分值</span><input class="exam-question-score-input" type="number" min="0" step="0.5" value="${esc(score)}" ${editable && !examAuthoringBusy && !examSelectionDirty && !hasArchivedSelection ? "" : "disabled"}></label>
              <button class="btn secondary compact-btn save-exam-question-score-btn" type="button" data-question-id="${esc(question.id)}" ${editable && !examAuthoringBusy && !examSelectionDirty && !hasArchivedSelection ? "" : "disabled"}>保存分值</button>
            </div>` : ""}
          </article>`;
        }).join("") : `<div class="empty-state admin-user-empty">${bankId ? "当前题库没有可用题目" : "请先绑定题库"}</div>`}
      </div>
    </section>`;

  document.getElementById("examSettingsForm")?.addEventListener("submit", saveExamSettings);
  document.getElementById("copyExamBtn")?.addEventListener("click", copyExam);
  document.getElementById("startExamRevisionBtn")?.addEventListener("click", startExamRevision);
  document.getElementById("cancelExamRevisionBtn")?.addEventListener("click", cancelExamRevision);
  document.getElementById("publishExamBtn")?.addEventListener("click", publishExam);
  document.getElementById("saveExamBankBtn")?.addEventListener("click", saveExamQuestionBank);
  document.getElementById("selectAllExamQuestionsBtn")?.addEventListener("click", () => setAllExamQuestions(true));
  document.getElementById("clearExamQuestionsBtn")?.addEventListener("click", () => setAllExamQuestions(false));
  document.getElementById("saveExamQuestionsBtn")?.addEventListener("click", saveExamQuestionSelection);
  document.getElementById("saveExamBulkScoreBtn")?.addEventListener("click", saveExamBulkScore);
  for (const checkbox of document.querySelectorAll(".exam-question-checkbox")) {
    checkbox.addEventListener("change", () => toggleExamQuestion(checkbox.dataset.questionId, checkbox.checked));
  }
  for (const button of document.querySelectorAll(".exam-order-btn")) {
    button.addEventListener("click", () => moveExamQuestion(button.dataset.questionId, button.dataset.direction));
  }
  for (const button of document.querySelectorAll(".save-exam-question-score-btn")) {
    button.addEventListener("click", () => saveExamQuestionScore(button));
  }
}

function showExamAuthoringMessage(message, tone = "") {
  const element = document.getElementById("examAuthoringMsg");
  element.textContent = message;
  element.className = `notice${tone ? ` ${tone}` : ""}`;
}

function applyExamMutationResponse(data) {
  const returned = data.authoring ? normalizeExamAuthoring(data) : null;
  if (returned?.exam?.id) currentExamAuthoring = returned;
  const exam = data.exam || data.authoring?.exam || null;
  const version = Number(exam?.version ?? data.version);
  if (currentExamAuthoring?.exam && Number.isFinite(version)) {
    currentExamAuthoring.exam = { ...currentExamAuthoring.exam, ...exam, version };
  }
  if (exam?.id) {
    const bankId = exam.questionBankId || exam.question_bank_id || "";
    const bankName = returned?.banks.find((bank) => bank.id === bankId)?.name;
    adminExams = adminExams.map((item) => item.id === exam.id
      ? { ...item, ...exam, ...(bankName ? { questionBankName: bankName } : {}) }
      : item);
  }
}

async function runExamAuthoringMutation(message, request, successMessage = "已保存；总分和通过分已按最新分值重新计算。") {
  if (examAuthoringBusy || !currentExamAuthoring?.exam?.id) return;
  examAuthoringBusy = true;
  showExamAuthoringMessage(message);
  renderExamAuthoringEditor();
  try {
    const data = await request();
    applyExamMutationResponse(data);
    examSelectionDirty = false;
    examSelectAllRequested = false;
    showExamAuthoringMessage(successMessage, "success");
  } catch (error) {
    showExamAuthoringMessage(error.message || "试卷保存失败", "error");
  } finally {
    examAuthoringBusy = false;
    renderExamAuthoringList();
    renderExamAuthoringEditor();
  }
}

async function loadExamAuthoring(examId, options = {}) {
  if (examSelectionDirty && examId !== currentAuthoringExamId
      && !window.confirm("当前选题尚未保存，确认切换试卷吗？")) return;
  currentAuthoringExamId = examId;
  examRevisionEditing = false;
  currentExamAuthoring = null;
  newExamDraft = null;
  examSelectionDirty = false;
  examSelectAllRequested = false;
  renderExamAuthoringList();
  document.getElementById("examAuthoringEditor").innerHTML = `<div class="empty-state">正在载入试卷</div>`;
  if (!options.preserveMessage) document.getElementById("examAuthoringMsg").classList.add("hidden");
  try {
    const data = await api(`/api/admin/exams/${encodeURIComponent(examId)}/authoring`);
    currentExamAuthoring = normalizeExamAuthoring(data);
    renderExamAuthoringEditor();
  } catch (error) {
    document.getElementById("examAuthoringEditor").innerHTML = `<div class="notice error">${esc(error.message || "试卷载入失败")}</div>`;
  }
}

async function loadAdminExams(options = {}) {
  const list = document.getElementById("examAuthoringList");
  list.innerHTML = `<div class="empty-state admin-user-empty">正在载入试卷</div>`;
  const data = await api("/api/admin/exams");
  adminExams = data.exams || [];
  if (!adminExams.some((exam) => exam.id === currentAuthoringExamId)) currentAuthoringExamId = adminExams[0]?.id || "";
  renderExamAuthoringList();
  if (currentAuthoringExamId) await loadExamAuthoring(currentAuthoringExamId, options);
  else renderExamAuthoringEditor();
}

async function openExamAuthoring() {
  document.getElementById("examAuthoringDialog").showModal();
  document.getElementById("examAuthoringMsg").classList.add("hidden");
  try {
    await loadAdminExams({ preserveMessage: true });
  } catch (error) {
    showExamAuthoringMessage(error.message || "试卷列表载入失败", "error");
  }
}

function startNewExam() {
  if (examAuthoringBusy) return;
  if (examSelectionDirty && !window.confirm("当前选题尚未保存，确认新增试卷吗？")) return;
  currentAuthoringExamId = "";
  currentExamAuthoring = null;
  examSelectionDirty = false;
  examSelectAllRequested = false;
  newExamDraft = { title: "", durationMinutes: 45, passRatePercent: 60 };
  renderExamAuthoringList();
  renderExamAuthoringEditor();
  document.getElementById("newExamTitle")?.focus();
}

async function cancelNewExam() {
  if (examAuthoringBusy) return;
  newExamDraft = null;
  currentAuthoringExamId = adminExams[0]?.id || "";
  renderExamAuthoringList();
  if (currentAuthoringExamId) await loadExamAuthoring(currentAuthoringExamId);
  else renderExamAuthoringEditor();
}

async function createExam(event) {
  event.preventDefault();
  if (examAuthoringBusy || !newExamDraft) return;
  const title = document.getElementById("newExamTitle").value.trim();
  const durationMinutes = Number(document.getElementById("newExamDuration").value);
  const passRatePercent = Number(document.getElementById("newExamPassRate").value);
  if (!title) return showExamAuthoringMessage("请输入试卷名称", "error");
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) {
    return showExamAuthoringMessage("考试时长必须是 1 到 1440 分钟之间的整数", "error");
  }
  if (!Number.isFinite(passRatePercent) || passRatePercent < 0 || passRatePercent > 100) {
    return showExamAuthoringMessage("通过比例必须是 0% 到 100% 之间的数字", "error");
  }
  examAuthoringBusy = true;
  newExamDraft = { title, durationMinutes, passRatePercent };
  showExamAuthoringMessage("正在创建试卷");
  renderExamAuthoringEditor();
  try {
    const data = await api("/api/admin/exams", {
      method: "POST",
      body: JSON.stringify({ title, durationSeconds: durationMinutes * 60, passRate: passRatePercent / 100 })
    });
    const exam = data.exam || data.authoring?.exam;
    if (!exam?.id) throw new Error("服务器没有返回新试卷");
    currentAuthoringExamId = exam.id;
    newExamDraft = null;
    showExamAuthoringMessage("试卷已创建，可继续绑定题库并选择试题。", "success");
    await loadAdminExams({ preserveMessage: true });
  } catch (error) {
    showExamAuthoringMessage(error.message || "试卷创建失败", "error");
  } finally {
    examAuthoringBusy = false;
    renderExamAuthoringList();
    renderExamAuthoringEditor();
  }
}

function saveExamSettings(event) {
  event.preventDefault();
  const exam = currentExamAuthoring?.exam;
  if (!exam) return;
  const title = document.getElementById("examTitleInput").value.trim();
  const durationMinutes = Number(document.getElementById("examDurationInput").value);
  const passRatePercent = Number(document.getElementById("examPassRateInput").value);
  if (!title) return showExamAuthoringMessage("请输入试卷名称", "error");
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) {
    return showExamAuthoringMessage("考试时长必须是 1 到 1440 分钟之间的整数", "error");
  }
  if (!Number.isFinite(passRatePercent) || passRatePercent < 0 || passRatePercent > 100) {
    return showExamAuthoringMessage("通过比例必须是 0% 到 100% 之间的数字", "error");
  }
  runExamAuthoringMutation("正在保存试卷参数", () => api(`/api/admin/exams/${encodeURIComponent(exam.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ revision: examRevisionEditing, version: exam.version, title, durationSeconds: durationMinutes * 60, passRate: passRatePercent / 100 })
  }), "试卷参数已保存，修改记录和版本号已更新。");
}

function startExamRevision() {
  const exam = currentExamAuthoring?.exam;
  if (!exam) return;
  examRevisionEditing = true;
  examSelectionDirty = false;
  showExamAuthoringMessage("已进入本地编辑状态；首次保存时才会创建新版本。", "success");
  renderExamAuthoringEditor();
}

async function cancelExamRevision() {
  const exam = currentExamAuthoring?.exam;
  if (!exam || examAuthoringBusy) return;
  if ((examSelectionDirty || examRevisionEditing) && !window.confirm("取消编辑并放弃尚未保存的修改吗？")) return;
  examRevisionEditing = false;
  examSelectionDirty = false;
  examSelectAllRequested = false;
  await loadExamAuthoring(exam.id, { preserveMessage: true });
  showExamAuthoringMessage("已取消编辑，试卷状态未改变。", "success");
}

async function copyExam() {
  const exam = currentExamAuthoring?.exam;
  if (!exam || examAuthoringBusy) return;
  examAuthoringBusy = true;
  showExamAuthoringMessage("正在复制试卷");
  renderExamAuthoringEditor();
  try {
    const data = await api(`/api/admin/exams/${encodeURIComponent(exam.id)}/copy`, {
      method: "POST",
      body: JSON.stringify({ version: exam.version })
    });
    const copied = data.exam || data.authoring?.exam;
    if (!copied?.id) throw new Error("服务器没有返回试卷副本");
    currentAuthoringExamId = copied.id;
    showExamAuthoringMessage("试卷已复制为新草稿。", "success");
    await loadAdminExams();
  } catch (error) {
    showExamAuthoringMessage(error.message || "试卷复制失败", "error");
  } finally {
    examAuthoringBusy = false;
    renderExamAuthoringEditor();
  }
}

function publishExam() {
  const exam = currentExamAuthoring?.exam;
  if (!exam) return;
  runExamAuthoringMutation("正在发布试卷", () => api(`/api/admin/exams/${encodeURIComponent(exam.id)}/publish`, {
    method: "POST",
    body: JSON.stringify({ version: exam.version })
  }), "试卷已发布，当前版本可供考生作答。");
}

function toggleExamQuestion(questionId, selected) {
  const question = currentExamAuthoring?.questions.find((item) => item.id === questionId);
  if (!question) return;
  question.selected = selected;
  if (selected && question.score === null) question.score = 0;
  question.position = selected ? Number.MAX_SAFE_INTEGER : null;
  selectedAuthoringQuestions().forEach((item, index) => { item.position = index + 1; });
  examSelectionDirty = true;
  examSelectAllRequested = false;
  renderExamAuthoringEditor();
}

function setAllExamQuestions(selected) {
  for (const [index, question] of currentExamAuthoring.questions.entries()) {
    question.selected = selected && question.status === "active";
    question.position = question.selected ? index + 1 : null;
    if (question.selected && question.score === null) question.score = 0;
  }
  examSelectionDirty = true;
  examSelectAllRequested = selected;
  renderExamAuthoringEditor();
}

function saveExamQuestionBank() {
  const questionBankId = document.getElementById("examQuestionBankSelect").value;
  if (!questionBankId) return showExamAuthoringMessage("请选择要绑定的题库", "error");
  const exam = currentExamAuthoring.exam;
  const currentBankId = exam.questionBankId || exam.question_bank_id || "";
  if (questionBankId === currentBankId) return showExamAuthoringMessage("当前试卷已经绑定该题库");
  if (selectedAuthoringQuestions().length) return showExamAuthoringMessage("更换题库前，请先清空并保存当前试卷的选题", "error");
  runExamAuthoringMutation("正在绑定题库", () => api(`/api/admin/exams/${encodeURIComponent(exam.id)}/question-bank`, {
    method: "PUT",
    body: JSON.stringify({ revision: examRevisionEditing, version: exam.version, questionBankId })
  }));
}

function saveExamQuestionSelection() {
  const exam = currentExamAuthoring.exam;
  const questionIds = selectedAuthoringQuestions().map((question) => question.id);
  runExamAuthoringMutation("正在保存选题", () => api(`/api/admin/exams/${encodeURIComponent(exam.id)}/questions`, {
    method: "PUT",
    body: JSON.stringify(examSelectAllRequested
      ? { revision: examRevisionEditing, version: exam.version, selectAll: true }
      : { revision: examRevisionEditing, version: exam.version, questionIds })
  }));
}

function moveExamQuestion(questionId, direction) {
  const selected = selectedAuthoringQuestions();
  const index = selected.findIndex((question) => question.id === questionId);
  const nextIndex = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || nextIndex < 0 || nextIndex >= selected.length) return;
  [selected[index], selected[nextIndex]] = [selected[nextIndex], selected[index]];
  selected.forEach((question, position) => { question.position = position + 1; });
  const exam = currentExamAuthoring.exam;
  runExamAuthoringMutation("正在保存题目顺序", () => api(`/api/admin/exams/${encodeURIComponent(exam.id)}/question-order`, {
    method: "PUT",
    body: JSON.stringify({ revision: examRevisionEditing, version: exam.version, questionIds: selected.map((question) => question.id) })
  }));
}

function saveExamQuestionScore(button) {
  const row = button.closest(".exam-question-row");
  const score = Number(row.querySelector(".exam-question-score-input").value);
  if (!Number.isFinite(score) || score < 0) return showExamAuthoringMessage("分值必须是大于或等于 0 的数字", "error");
  const exam = currentExamAuthoring.exam;
  const questionId = button.dataset.questionId;
  runExamAuthoringMutation("正在保存题目分值", () => api(`/api/admin/exams/${encodeURIComponent(exam.id)}/questions/${encodeURIComponent(questionId)}/score`, {
    method: "PATCH",
    body: JSON.stringify({ revision: examRevisionEditing, version: exam.version, score })
  }));
}

function saveExamBulkScore() {
  const score = Number(document.getElementById("examBulkScoreInput").value);
  if (!Number.isFinite(score) || score < 0) return showExamAuthoringMessage("批量分值必须是大于或等于 0 的数字", "error");
  const exam = currentExamAuthoring.exam;
  examBulkScoreDraft = String(score);
  runExamAuthoringMutation("正在批量设置分值", () => api(`/api/admin/exams/${encodeURIComponent(exam.id)}/question-scores`, {
    method: "PATCH",
    body: JSON.stringify({ revision: examRevisionEditing, version: exam.version, score })
  }));
}

function renderQuestionList() {
  const query = document.getElementById("questionSearch").value.trim().toLowerCase();
  const filtered = window.QuestionAdminModel.filterQuestions(adminQuestions, currentQuestionFilterId, query);
  const list = document.getElementById("questionList");
  document.getElementById("questionCount").textContent = `当前题库 ${filtered.length} 道题`;
  list.innerHTML = filtered.length ? filtered.map((question) => `
    <button class="question-list-item ${question.id === currentQuestionId ? "active" : ""}" type="button" data-question-id="${esc(question.id)}">
      <span class="question-list-stem">${questionText(question.stem)}</span>
      <span class="brand-sub">${esc(question.bankName)} · ${typeLabel(question.type)}</span>
    </button>
  `).join("") : `<div class="empty-state admin-user-empty">暂无匹配题目</div>`;
  for (const button of document.querySelectorAll(".question-list-item")) {
    button.addEventListener("click", () => selectQuestion(button.dataset.questionId));
  }
}

function currentQuestionBank() {
  const bankId = currentQuestionFilterId.startsWith("bank:") ? currentQuestionFilterId.slice(5) : "";
  return adminQuestionBanks.find((bank) => bank.id === bankId) || null;
}

function questionBankStatus(bank) {
  return bank?.status === "archived" ? "已归档" : "启用中";
}

function renderQuestionBankManager() {
  const list = document.getElementById("questionBankList");
  const editor = document.getElementById("questionBankEditor");
  const selected = currentQuestionBank();
  document.getElementById("newQuestionBankBtn").disabled = questionBankBusy;
  list.innerHTML = adminQuestionBanks.length
    ? `<label class="question-bank-select-label" for="questionBankSelect">当前题库</label>
       <select id="questionBankSelect" ${questionBankBusy ? "disabled" : ""}>
         ${adminQuestionBanks.map((bank) => `<option value="${esc(bank.id)}" ${bank.id === selected?.id ? "selected" : ""}>${esc(bank.name || "未命名题库")}</option>`).join("")}
       </select>`
    : `<div class="empty-state question-bank-empty">暂无题库</div>`;
  document.getElementById("questionBankSelect")?.addEventListener("change", (event) => selectQuestionBank(event.target.value));

  const notice = questionBankNotice.text
    ? `<div class="notice ${questionBankNotice.type}">${esc(questionBankNotice.text)}</div>`
    : "";
  if (questionBankEditorMode === "new" || questionBankEditorMode === "edit") {
    const editing = questionBankEditorMode === "edit" ? selected : null;
    editor.innerHTML = `
      <form id="questionBankForm" class="question-bank-form">
        <div class="field">
          <label for="questionBankName">题库名称</label>
          <input id="questionBankName" value="${esc(editing?.name || "")}" maxlength="120" required autocomplete="off">
        </div>
        <div class="field">
          <label for="questionBankDescription">说明</label>
          <textarea id="questionBankDescription" maxlength="1000" placeholder="选填">${esc(editing?.description || "")}</textarea>
        </div>
        <div class="question-bank-form-actions">
          <button class="btn primary compact-btn" type="submit" ${questionBankBusy ? "disabled" : ""}>${editing ? "保存" : "创建题库"}</button>
          <button class="btn secondary compact-btn" id="cancelQuestionBankBtn" type="button" ${questionBankBusy ? "disabled" : ""}>取消</button>
        </div>
        ${notice}
      </form>`;
    document.getElementById("questionBankForm").addEventListener("submit", saveQuestionBank);
    document.getElementById("cancelQuestionBankBtn").addEventListener("click", () => {
      questionBankEditorMode = "";
      questionBankNotice = { text: "", type: "" };
      renderQuestionBankManager();
    });
    return;
  }

  if (!selected) {
    editor.innerHTML = `${notice}<p class="brand-sub">新建题库后即可手动录题。</p>`;
    return;
  }
  const archived = selected.status === "archived";
  editor.innerHTML = `
    <div class="question-bank-summary">
      <div class="question-bank-summary-title">
        <strong>${esc(selected.name || "未命名题库")}</strong>
        <span class="badge ${archived ? "bank-archived" : "bank-active"}">${questionBankStatus(selected)}</span>
      </div>
      <div class="question-bank-stats"><span>题目数 <strong>${Number(selected.questionCount || 0)}</strong></span><span>版本 <strong>${Number(selected.version || 0)}</strong></span><span>关联试卷 <strong>${Number(selected.examCount || 0)}</strong></span></div>
      <p>${esc(selected.description || "暂无说明")}</p>
      ${archived ? `<p class="question-bank-archived-note">已归档题库不可新增题目，恢复后可继续录题。</p>` : ""}
    </div>
    <div class="question-bank-actions">
      <button class="btn secondary compact-btn" id="editQuestionBankBtn" type="button" ${questionBankBusy ? "disabled" : ""}>编辑</button>
      <button class="btn secondary compact-btn" id="copyQuestionBankBtn" type="button" ${questionBankBusy ? "disabled" : ""}>复制</button>
      ${archived
        ? `<button class="btn success compact-btn" id="restoreQuestionBankBtn" type="button" ${questionBankBusy ? "disabled" : ""}>恢复</button>`
        : `<button class="btn danger compact-btn" id="archiveQuestionBankBtn" type="button" ${questionBankBusy ? "disabled" : ""}>归档</button>`}
    </div>
    ${notice}`;
  document.getElementById("editQuestionBankBtn").addEventListener("click", () => {
    questionBankEditorMode = "edit";
    questionBankNotice = { text: "", type: "" };
    renderQuestionBankManager();
  });
  document.getElementById("copyQuestionBankBtn").addEventListener("click", copyQuestionBank);
  document.getElementById(archived ? "restoreQuestionBankBtn" : "archiveQuestionBankBtn")
    .addEventListener("click", archived ? restoreQuestionBank : archiveQuestionBank);
}

function selectQuestionBank(bankId) {
  if (questionBankBusy || questionImageUploadBusy) return;
  currentQuestionFilterId = `bank:${bankId}`;
  currentQuestionId = window.QuestionAdminModel.filterQuestions(adminQuestions, currentQuestionFilterId)[0]?.id || "";
  newQuestionDraft = null;
  questionImageDraft = null;
  questionBankEditorMode = "";
  questionBankNotice = { text: "", type: "" };
  document.getElementById("questionSearch").value = "";
  renderQuestionFilter();
  renderQuestionBankManager();
  renderQuestionList();
  renderQuestionEditor();
}

async function runQuestionBankMutation(action, successText) {
  if (questionBankBusy) return;
  questionBankBusy = true;
  questionBankNotice = { text: "正在处理", type: "" };
  renderQuestionBankManager();
  try {
    const data = await action();
    if (data.bank?.id) currentQuestionFilterId = `bank:${data.bank.id}`;
    questionBankEditorMode = "";
    questionBankNotice = { text: successText, type: "success" };
    await loadQuestions();
  } catch (error) {
    questionBankNotice = { text: error.message || "题库操作失败", type: "error" };
    renderQuestionBankManager();
  } finally {
    questionBankBusy = false;
    renderQuestionFilter();
    renderQuestionBankManager();
  }
}

function saveQuestionBank(event) {
  event.preventDefault();
  const bank = currentQuestionBank();
  const name = document.getElementById("questionBankName").value.trim();
  const description = document.getElementById("questionBankDescription").value.trim();
  if (!name) {
    questionBankNotice = { text: "请填写题库名称", type: "error" };
    return renderQuestionBankManager();
  }
  if (questionBankEditorMode === "edit" && bank) {
    return runQuestionBankMutation(() => api(`/api/admin/question-banks/${encodeURIComponent(bank.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ version: bank.version, name, description })
    }), "题库信息已保存。");
  }
  runQuestionBankMutation(() => api("/api/admin/question-banks", {
    method: "POST",
    body: JSON.stringify({ name, description })
  }), "题库已创建，可以开始录题。");
}

function copyQuestionBank() {
  const bank = currentQuestionBank();
  if (!bank) return;
  runQuestionBankMutation(() => api(`/api/admin/question-banks/${encodeURIComponent(bank.id)}/copy`, {
    method: "POST",
    body: JSON.stringify({ version: bank.version })
  }), "已复制为新的启用题库。");
}

function archiveQuestionBank() {
  const bank = currentQuestionBank();
  if (!bank || !window.confirm(`确认归档题库“${bank.name}”吗？归档后不可新增题目。`)) return;
  runQuestionBankMutation(() => api(`/api/admin/question-banks/${encodeURIComponent(bank.id)}/archive`, {
    method: "POST",
    body: JSON.stringify({ version: bank.version })
  }), "题库已归档。");
}

function restoreQuestionBank() {
  const bank = currentQuestionBank();
  if (!bank) return;
  runQuestionBankMutation(() => api(`/api/admin/question-banks/${encodeURIComponent(bank.id)}/restore`, {
    method: "POST",
    body: JSON.stringify({ version: bank.version })
  }), "题库已恢复，可以继续录题。");
}

function renderQuestionFilter() {
  const filters = window.QuestionAdminModel.listQuestionFilters(adminQuestions, adminQuestionBanks);
  const select = document.getElementById("questionExamFilter");
  select.innerHTML = filters.banks.length
    ? filters.banks.map((bank) => `<option value="${esc(bank.value)}">${esc(bank.name)}</option>`).join("")
    : `<option value="">暂无题库</option>`;
  const values = filters.banks.map((item) => item.value);
  if (!values.includes(currentQuestionFilterId)) currentQuestionFilterId = values[0] || "";
  select.value = currentQuestionFilterId;
  const bank = currentQuestionBank();
  const newQuestionButton = document.getElementById("newQuestionBtn");
  newQuestionButton.disabled = !bank || bank.status === "archived" || questionBankBusy;
  newQuestionButton.title = bank?.status === "archived" ? "已归档题库不可新增题目" : "";
}

function currentAnswerLabels(question) {
  const answer = Array.isArray(question.answer) ? question.answer : [question.answer];
  return new Set(answer.map((item) => String(item || "").trim().toUpperCase()).filter(Boolean));
}

function answerEditor(question) {
  if (["single", "judge", "multi"].includes(question.type)) {
    const selected = currentAnswerLabels(question);
    const options = question.options || [{ label: "A", text: "正确" }, { label: "B", text: "错误" }];
    return `<div class="field"><label>参考答案</label><div id="questionAnswerChoices" class="answer-choice-grid">
      ${options.map((option) => `<label class="answer-choice"><input type="${question.type === "multi" ? "checkbox" : "radio"}" name="questionAnswerChoice" value="${esc(option.label)}" ${selected.has(option.label) ? "checked" : ""}><span>${question.type === "judge" ? (option.label === "A" ? "正确" : "错误") : `${esc(option.label)}. ${esc(option.text || "")}`}</span></label>`).join("")}
    </div></div>`;
  }
  if (question.type === "fill") {
    const rule = window.QuestionAdminModel.normalizeFillRule(question.answer);
    return `<div class="field"><label for="questionAnswerText">参考答案（每行一个空，空内用 | 分隔允许答案）</label><textarea id="questionAnswerText" placeholder="北京|北京市\n中国|中华人民共和国">${esc(rule.blanks.map((blank) => blank.join("|")).join("\n"))}</textarea><label class="inline-check"><input id="fillOrderedInput" type="checkbox" ${rule.ordered ? "checked" : ""}> 是否必须按照指定顺序填写</label></div>`;
  }
  return `<div class="field"><label for="questionAnswerText">参考答案</label><textarea id="questionAnswerText">${esc(question.answer || "")}</textarea></div>`;
}

function questionOptionImage(question, label) {
  if (newQuestionDraft) return newQuestionDraft.options.find((option) => option.label === label)?.image || "";
  if (!questionOptionImageDraft) questionOptionImageDraft = Object.fromEntries((question.options || []).filter((option) => option.image).map((option) => [option.label, option.image]));
  return questionOptionImageDraft[label] || "";
}

function renderQuestionOptionMedia(question, option) {
  const image = questionOptionImage(question, option.label);
  return `<div class="question-option-media"><input class="question-option-image-input" type="file" accept="image/jpeg,image/png,image/webp" data-label="${esc(option.label)}" ${questionImageUploadBusy ? "disabled" : ""}>${image ? `<img class="question-option-image-preview" src="${esc(image)}" alt="选项 ${esc(option.label)} 图片"><button class="icon-action remove-question-option-image-btn" type="button" data-label="${esc(option.label)}" title="移除选项图片" aria-label="移除选项图片">×</button>` : `<span class="brand-sub">可选图片</span>`}</div>`;
}

function bindQuestionOptionImages() {
  for (const input of document.querySelectorAll(".question-option-image-input")) input.addEventListener("change", (event) => uploadQuestionOptionImage(event, input.dataset.label));
  for (const button of document.querySelectorAll(".remove-question-option-image-btn")) button.addEventListener("click", () => {
    const label = button.dataset.label;
    if (newQuestionDraft) {
      const option = newQuestionDraft.options.find((item) => item.label === label);
      if (option) delete option.image;
    } else {
      if (!questionOptionImageDraft) questionOptionImageDraft = {};
      delete questionOptionImageDraft[label];
    }
    if (newQuestionDraft) renderNewQuestionEditor(); else renderQuestionEditor();
  });
}

async function uploadQuestionOptionImage(event, label) {
  const file = event.target.files?.[0];
  if (!file || questionImageUploadBusy) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) return showQuestionImageMessage("只能上传不超过 5MB 的 JPEG、PNG 或 WebP 图片");
  questionImageUploadBusy = true;
  try {
    const data = await api("/api/admin/question-resources", { method: "POST", body: JSON.stringify({ mimeType: file.type, dataUrl: await readFileAsDataUrl(file) }) });
    if (newQuestionDraft) {
      const option = newQuestionDraft.options.find((item) => item.label === label);
      if (option) option.image = data.resource.url;
      renderNewQuestionEditor();
    } else {
      questionOptionImageDraft = { ...(questionOptionImageDraft || {}), [label]: data.resource.url };
      renderQuestionEditor();
    }
  } catch (error) { showQuestionImageMessage(error.message || "选项图片上传失败"); }
  finally { questionImageUploadBusy = false; }
}

function questionImageEditor(images = []) {
  return `<div class="field question-image-field">
    <div class="question-option-toolbar">
      <label for="questionImageInput">题目图片附件</label>
      <span class="brand-sub">${images.length} / 5 张</span>
    </div>
    <input id="questionImageInput" type="file" accept="image/jpeg,image/png,image/webp" multiple
      ${questionImageUploadBusy || images.length >= 5 ? "disabled" : ""}>
    ${images.length ? `<div class="question-image-grid">${images.map((src, index) => `
      <figure class="question-image-item">
        <img src="${esc(src)}" alt="题目图片 ${index + 1}" loading="lazy">
        <button class="icon-action remove-question-image-btn" type="button" data-image-index="${index}"
          title="移除图片" aria-label="移除第 ${index + 1} 张图片" ${questionImageUploadBusy ? "disabled" : ""}>×</button>
      </figure>`).join("")}</div>` : ""}
    <span class="brand-sub" id="questionImageMsg">JPEG、PNG 或 WebP，单张不超过 5MB。上传后还需保存题目。</span>
  </div>`;
}

function bindQuestionImageEditor() {
  document.getElementById("questionImageInput")?.addEventListener("change", uploadQuestionImages);
  for (const button of document.querySelectorAll(".remove-question-image-btn")) {
    button.addEventListener("click", () => removeQuestionImage(Number(button.dataset.imageIndex)));
  }
}

function showQuestionImageMessage(message) {
  const element = document.getElementById("questionImageMsg");
  if (element) element.textContent = message;
}

function editingQuestionImages() {
  if (newQuestionDraft) return newQuestionDraft.images || [];
  const question = adminQuestions.find((item) => item.id === currentQuestionId);
  if (!question) return [];
  if (!questionImageDraft) questionImageDraft = [...(question.images || [])];
  return questionImageDraft;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(new Error("图片读取失败")));
    reader.readAsDataURL(file);
  });
}

async function uploadQuestionImages(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length || questionImageUploadBusy) return;
  const images = editingQuestionImages();
  const target = newQuestionDraft
    ? { kind: "new", draft: newQuestionDraft }
    : { kind: "existing", questionId: currentQuestionId };
  const message = document.getElementById("questionImageMsg");
  if (images.length + files.length > 5) {
    message.textContent = "每道题最多上传 5 张图片";
    return;
  }
  const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
  const invalid = files.find((file) => !allowed.has(file.type) || file.size < 1 || file.size > 5 * 1024 * 1024);
  if (invalid) {
    message.textContent = "只能上传单张不超过 5MB 的 JPEG、PNG 或 WebP 图片";
    return;
  }

  questionImageUploadBusy = true;
  message.textContent = "正在上传图片";
  event.target.disabled = true;
  document.getElementById("saveQuestionBtn").disabled = true;
  try {
    for (const file of files) {
      const dataUrl = await readFileAsDataUrl(file);
      const data = await api("/api/admin/question-resources", {
        method: "POST",
        body: JSON.stringify({ mimeType: file.type, dataUrl })
      });
      images.push(data.resource.url);
    }
    const targetStillOpen = target.kind === "new"
      ? newQuestionDraft === target.draft
      : !newQuestionDraft && currentQuestionId === target.questionId;
    if (!targetStillOpen) throw new Error("题目已切换，本次上传未关联到题目");
    if (target.kind === "new") newQuestionDraft.images = images;
    else questionImageDraft = images;
    questionImageUploadBusy = false;
    if (newQuestionDraft) renderNewQuestionEditor();
    else renderQuestionEditor();
    document.getElementById("questionImageMsg").textContent = "图片已上传；保存题目后才会生效。";
  } catch (error) {
    questionImageUploadBusy = false;
    if (newQuestionDraft) renderNewQuestionEditor();
    else renderQuestionEditor();
    document.getElementById("questionImageMsg").textContent = error.message || "图片上传失败";
  }
}

function removeQuestionImage(index) {
  const images = editingQuestionImages();
  if (index < 0 || index >= images.length) return;
  images.splice(index, 1);
  if (newQuestionDraft) newQuestionDraft.images = images;
  else questionImageDraft = images;
  if (newQuestionDraft) renderNewQuestionEditor();
  else renderQuestionEditor();
  document.getElementById("questionImageMsg").textContent = "图片已从题目中移除；保存后生效。";
}

function selectedQuestionBankId() {
  if (currentQuestionFilterId.startsWith("bank:")) return currentQuestionFilterId.slice(5);
  const current = window.QuestionAdminModel.filterQuestions(adminQuestions, currentQuestionFilterId)[0];
  return current?.bankId || adminQuestionBanks[0]?.id || "";
}

function defaultNewQuestion(type = "single", bankId = selectedQuestionBankId()) {
  const choiceOptions = ["A", "B", "C", "D"].map((label) => ({ label, text: "" }));
  return {
    bankId,
    externalId: "",
    type,
    stem: "",
    images: [],
    options: type === "judge"
      ? [{ label: "A", text: "正确" }, { label: "B", text: "错误" }]
      : ["single", "multi"].includes(type) ? choiceOptions : [],
    answer: type === "multi" ? ["A"] : type === "fill" ? [] : type === "qa" ? "" : "A",
    explanation: ""
  };
}

function renderNewQuestionEditor() {
  const draft = newQuestionDraft;
  const editor = document.getElementById("questionEditor");
  const optionTypes = ["single", "multi", "judge"].includes(draft.type);
  const answer = draft.type === "fill" ? window.QuestionAdminModel.fillRuleText(draft.answer) : draft.answer;
  editor.innerHTML = `
    <form id="newQuestionForm" class="question-editor-form">
      <div class="question-editor-meta">
        <span class="badge pending">新题目</span>
        <span class="brand-sub">保存后进入题库，但不会自动加入任何试卷</span>
      </div>
      <div class="notice">新题只供后续组卷使用，不会改变已发布考试、已有答卷或判分。</div>
      <div class="question-create-grid">
        <div class="field">
          <label for="newQuestionBank">题库</label>
          <select id="newQuestionBank" required>${adminQuestionBanks.filter((bank) => bank.status !== "archived").map((bank) => `<option value="${esc(bank.id)}" ${bank.id === draft.bankId ? "selected" : ""}>${esc(bank.name)}</option>`).join("")}</select>
        </div>
        <div class="field">
          <label for="newQuestionType">题型</label>
          <select id="newQuestionType">
            ${Object.entries({ single: "单选题", multi: "多选题", judge: "判断题", fill: "填空题", qa: "问答题" }).map(([value, label]) => `<option value="${value}" ${value === draft.type ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label for="newQuestionExternalId">题目编号（可选）</label>
          <input id="newQuestionExternalId" value="${esc(draft.externalId)}" autocomplete="off">
        </div>
      </div>
      <div class="field">
        <label for="questionStem">题干</label>
        <textarea id="questionStem" required>${esc(draft.stem)}</textarea>
      </div>
      ${questionImageEditor(draft.images)}
      ${optionTypes ? `
        <div class="field">
          <div class="question-option-toolbar">
            <label>选项</label>
            ${draft.type !== "judge" ? `<button class="icon-action" id="addQuestionOptionBtn" type="button" title="添加选项" aria-label="添加选项" ${draft.options.length >= 10 ? "disabled" : ""}>+</button>` : ""}
          </div>
          <div class="question-option-editor">
            ${draft.options.map((option, index) => `
              <div class="question-option-row" data-option-label="${esc(option.label)}">
                <div class="question-option-label">${esc(option.label)}.</div>
                <textarea class="new-question-option-text" data-label="${esc(option.label)}" ${option.image ? "" : "required"} ${draft.type === "judge" ? "readonly" : ""}>${esc(option.text)}</textarea>
                ${renderQuestionOptionMedia(draft, option)}
                ${draft.type !== "judge" ? `<button class="icon-action remove-option-btn" type="button" data-index="${index}" title="删除选项" aria-label="删除选项" ${draft.options.length <= 2 ? "disabled" : ""}>−</button>` : ""}
              </div>`).join("")}
          </div>
        </div>` : ""}
      ${answerEditor({ type: draft.type, answer: draft.answer, options: draft.options })}
      <div class="field">
        <label for="questionExplanation">题目解析</label>
        <textarea id="questionExplanation">${esc(draft.explanation)}</textarea>
      </div>
      <div class="question-save-row">
        <button class="btn success" id="saveQuestionBtn" type="submit" ${questionImageUploadBusy ? "disabled" : ""}>保存到题库</button>
        <button class="btn secondary" id="cancelNewQuestionBtn" type="button">取消</button>
        <span class="brand-sub" id="questionSaveMsg"></span>
      </div>
    </form>`;
  document.getElementById("newQuestionForm").addEventListener("submit", saveNewQuestion);
  document.getElementById("cancelNewQuestionBtn").addEventListener("click", cancelNewQuestion);
  document.getElementById("newQuestionType").addEventListener("change", changeNewQuestionType);
  document.getElementById("addQuestionOptionBtn")?.addEventListener("click", addNewQuestionOption);
  for (const button of document.querySelectorAll(".remove-option-btn")) {
    button.addEventListener("click", () => removeNewQuestionOption(Number(button.dataset.index)));
  }
  bindQuestionImageEditor();
  bindQuestionOptionImages();
}

function readNewQuestionDraft() {
  if (!newQuestionDraft || !document.getElementById("newQuestionForm")) return;
  const answerText = document.getElementById("questionAnswerText")?.value || "";
  const selectedAnswers = Array.from(document.querySelectorAll("input[name=questionAnswerChoice]:checked")).map((input) => input.value);
  newQuestionDraft = {
    ...newQuestionDraft,
    bankId: document.getElementById("newQuestionBank").value,
    externalId: document.getElementById("newQuestionExternalId").value,
    type: document.getElementById("newQuestionType").value,
    stem: document.getElementById("questionStem").value,
    options: Array.from(document.querySelectorAll(".new-question-option-text")).map((input) => ({
      label: input.dataset.label,
      text: input.value,
      ...(newQuestionDraft.options.find((option) => option.label === input.dataset.label)?.image ? { image: newQuestionDraft.options.find((option) => option.label === input.dataset.label).image } : {})
    })),
    answer: ["single", "multi", "judge"].includes(newQuestionDraft.type)
      ? (newQuestionDraft.type === "multi" ? selectedAnswers : (selectedAnswers[0] || "A"))
      : newQuestionDraft.type === "fill"
        ? { ordered: document.getElementById("fillOrderedInput")?.checked !== false, blanks: answerText.split(/\r?\n/).map((line) => line.split("|").map((item) => item.trim()).filter(Boolean)).filter((blank) => blank.length) }
        : answerText,
    explanation: document.getElementById("questionExplanation").value
  };
}

function startNewQuestion() {
  if (questionImageUploadBusy) return;
  const bank = currentQuestionBank();
  if (!bank || bank.status === "archived") {
    document.getElementById("questionEditor").innerHTML = `<div class="notice error">当前题库已归档或不可用，请选择启用题库或先恢复题库。</div>`;
    return;
  }
  currentQuestionId = "";
  questionImageDraft = null;
  newQuestionDraft = defaultNewQuestion();
  renderQuestionList();
  renderNewQuestionEditor();
}

function cancelNewQuestion() {
  if (questionImageUploadBusy) return;
  newQuestionDraft = null;
  questionImageDraft = null;
  const filtered = window.QuestionAdminModel.filterQuestions(adminQuestions, currentQuestionFilterId);
  currentQuestionId = filtered[0]?.id || "";
  renderQuestionList();
  renderQuestionEditor();
}

function changeNewQuestionType(event) {
  if (questionImageUploadBusy) {
    event.target.value = newQuestionDraft.type;
    return;
  }
  readNewQuestionDraft();
  const bankId = newQuestionDraft.bankId;
  const preserved = {
    stem: newQuestionDraft.stem,
    images: newQuestionDraft.images,
    externalId: newQuestionDraft.externalId,
    explanation: newQuestionDraft.explanation
  };
  newQuestionDraft = { ...defaultNewQuestion(event.target.value, bankId), ...preserved };
  renderNewQuestionEditor();
}

function addNewQuestionOption() {
  readNewQuestionDraft();
  if (newQuestionDraft.options.length >= 10) return;
  const label = String.fromCharCode(65 + newQuestionDraft.options.length);
  newQuestionDraft.options.push({ label, text: "" });
  renderNewQuestionEditor();
}

function removeNewQuestionOption(index) {
  readNewQuestionDraft();
  if (newQuestionDraft.options.length <= 2) return;
  newQuestionDraft.options.splice(index, 1);
  newQuestionDraft.options = newQuestionDraft.options.map((option, optionIndex) => ({ ...option, label: String.fromCharCode(65 + optionIndex) }));
  renderNewQuestionEditor();
}

function renderQuestionEditor() {
  if (newQuestionDraft) return renderNewQuestionEditor();
  const question = adminQuestions.find((item) => item.id === currentQuestionId);
  const editor = document.getElementById("questionEditor");
  if (!question) {
    editor.innerHTML = `<div class="empty-state">请选择一道题目</div>`;
    return;
  }
  const examNames = question.exams.length ? question.exams.map((exam) => exam.title).join("、") : "尚未用于考试";
  const images = editingQuestionImages();
  const answerLabels = currentAnswerLabels(question);
  editor.innerHTML = `
    <form id="questionEditorForm" class="question-editor-form">
      <div class="question-editor-meta">
        <span class="badge graded">${esc(question.bankName)}</span>
        <span class="badge pending">${typeLabel(question.type)}</span>
        <span class="brand-sub">版本 ${question.version}</span>
      </div>
      <div class="brand-sub">引用考试：${esc(examNames)}</div>
      <div class="notice">保存会更新后续考生看到的题目版本；已提交答卷及其原有判分不会改变。重新阅卷时，管理员可在答卷中逐题选择是否采用本次修改。</div>
      <div class="field">
        <label for="questionStem">题干</label>
        <textarea id="questionStem" required>${esc(question.stem)}</textarea>
      </div>
      ${questionImageEditor(images)}
      ${question.options.length ? `
        <div class="field">
          <label>选项</label>
          <div class="question-option-editor">
            ${question.options.map((option) => `
              <div class="question-option-row ${answerLabels.has(option.label) ? "current-answer" : ""}" data-option-label="${esc(option.label)}">
                <div class="question-option-label">${esc(option.label)}.</div>
                <textarea class="question-option-text" data-label="${esc(option.label)}" ${option.hasImage ? "" : "required"}>${esc(option.text)}</textarea>
                ${renderQuestionOptionMedia(question, option)}
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
        <button class="btn success" id="saveQuestionBtn" type="submit" ${questionImageUploadBusy ? "disabled" : ""}>保存题目</button>
        <span class="brand-sub" id="questionSaveMsg"></span>
      </div>
    </form>`;
  document.getElementById("questionEditorForm").addEventListener("submit", saveQuestion);
  bindQuestionImageEditor();
  bindQuestionOptionImages();
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
  if (questionImageUploadBusy) return;
  newQuestionDraft = null;
  questionImageDraft = null;
  questionOptionImageDraft = null;
  currentQuestionId = questionId;
  renderQuestionList();
  renderQuestionEditor();
}

async function loadQuestions() {
  document.getElementById("questionList").innerHTML = `<div class="empty-state admin-user-empty">正在载入题目</div>`;
  const [questionData, bankData] = await Promise.all([
    api("/api/admin/questions"),
    api("/api/admin/question-banks")
  ]);
  adminQuestions = questionData.questions || [];
  questionImageDraft = null;
  questionOptionImageDraft = null;
  adminQuestionBanks = bankData.banks || [];
  renderQuestionFilter();
  renderQuestionBankManager();
  const filtered = window.QuestionAdminModel.filterQuestions(adminQuestions, currentQuestionFilterId);
  if (!filtered.some((question) => question.id === currentQuestionId)) currentQuestionId = filtered[0]?.id || "";
  renderQuestionList();
  renderQuestionEditor();
}

async function saveNewQuestion(event) {
  event.preventDefault();
  readNewQuestionDraft();
  const button = document.getElementById("saveQuestionBtn");
  const message = document.getElementById("questionSaveMsg");
  button.disabled = true;
  message.textContent = "正在保存";
  try {
    const data = await api("/api/admin/questions", {
      method: "POST",
      body: JSON.stringify(newQuestionDraft)
    });
    adminQuestions.push(data.question);
    const bank = adminQuestionBanks.find((item) => item.id === data.question.bankId);
    if (bank) bank.questionCount += 1;
    newQuestionDraft = null;
    currentQuestionId = data.question.id;
    currentQuestionFilterId = `bank:${data.question.bankId}`;
    renderQuestionFilter();
    renderQuestionBankManager();
    renderQuestionList();
    renderQuestionEditor();
    document.getElementById("questionSaveMsg").textContent = "已保存到题库，尚未加入试卷。";
  } catch (error) {
    message.textContent = error.message || "题目录入失败";
    button.disabled = false;
  }
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
    const selected = Array.from(document.querySelectorAll("input[name=questionAnswerChoice]:checked")).map((input) => input.value);
    return question.type === "multi" ? selected : (selected[0] || "A");
  }
  const value = document.getElementById("questionAnswerText")?.value || "";
  if (question.type === "fill") {
    return { ordered: document.getElementById("fillOrderedInput")?.checked !== false, blanks: value.split(/\r?\n/).map((line) => line.split("|").map((item) => item.trim()).filter(Boolean)).filter((blank) => blank.length) };
  }
  return value;
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
    text: input.value,
    ...(questionOptionImage(question, input.dataset.label) ? { image: questionOptionImage(question, input.dataset.label) } : {})
  }));
  try {
    const data = await api(`/api/admin/questions/${encodeURIComponent(question.id)}`, {
      method: "PUT",
      body: JSON.stringify({
        version: question.version,
        stem: document.getElementById("questionStem").value,
        images: questionImageDraft || question.images || [],
        options,
        answer: collectQuestionAnswer(question),
        explanation: document.getElementById("questionExplanation").value
      })
    });
    adminQuestions = adminQuestions.map((item) => item.id === data.question.id ? data.question : item);
    questionImageDraft = null;
    questionOptionImageDraft = null;
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
  return `<div class="review-image-row">${paths.map((src) => `<img src="/${esc(String(src).replace(/^\/+/, ""))}" alt="题目图片" loading="lazy">`).join("")}</div>`;
}

function updateStatusFilterButtons(status) {
  for (const button of document.querySelectorAll(".stat-filter")) {
    button.setAttribute("aria-pressed", String(button.dataset.statusFilter === status));
  }
}

function setStatusFilter(status) {
  const select = document.getElementById("statusFilter");
  const supported = Array.from(select.options).some((option) => option.value === status);
  if (!supported) return;
  select.value = status;
  renderList();
}

function renderList() {
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const status = document.getElementById("statusFilter").value;
  updateStatusFilterButtons(status);
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
      ${images.options?.[key] ? `<img src="/${esc(String(images.options[key]).replace(/^\/+/, ""))}" alt="选项 ${esc(key)} 图片" loading="lazy">` : ""}
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

function questionVersionNotice(question) {
  if (question.referenceStatus === "deleted" || question.referenceStatus === "unavailable") {
    return `<div class="question-version-notice deleted"><strong>题库版本提示：</strong>该题已在题库中删除或无法找到，将继续按考生交卷时的题目与答案阅卷。</div>`;
  }
  if (question.referenceStatus !== "modified") return "";
  const currentAnswer = answerDisplay(question.current?.answer || question.current?.explanation || "未提供");
  return `
    <div class="question-version-notice modified">
      <strong>题库版本提示：</strong>题库已修改${question.changedFields?.length ? `（${esc(question.changedFields.join("、"))}）` : ""}；默认仍使用交卷时快照，不影响已产生的答卷和原自动判分。
      <label class="use-current-question"><input class="use-current-question-input" type="checkbox" data-qid="${esc(question.id)}" ${question.reviewSource === "current" ? "checked" : ""}> 采用当前题库内容重新阅卷</label>
      <span class="brand-sub">当前标准答案：${esc(currentAnswer)}。客观题采用后会按当前标准答案重新自动判分并覆盖该题手动分；问答题供人工按当前参考内容评分。</span>
    </div>`;
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
              ${questionVersionNotice(q)}
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
            ${questionVersionNotice(q)}
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
    <div class="admin-detail-mobile-nav">
      <button class="btn secondary" id="backToSubmissionsBtn" type="button">返回答卷列表</button>
    </div>
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
  document.getElementById("backToSubmissionsBtn").addEventListener("click", () => setAdminWorkspace("list"));
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
  setAdminWorkspace("detail");
  renderList();
  document.getElementById("detailPanel").innerHTML = `<div class="empty-state">正在载入答卷</div>`;
  currentDetail = await api(`/api/admin/submissions/${encodeURIComponent(id)}`);
  renderDetail();
}

async function saveGrade() {
  if (!currentDetail) return;
  const qaScores = {};
  const objectiveScores = {};
  const useCurrentQuestionIds = [];
  for (const input of document.querySelectorAll(".qa-score")) qaScores[input.dataset.qid] = input.value;
  for (const input of document.querySelectorAll(".objective-score")) objectiveScores[input.dataset.qid] = input.value;
  for (const input of document.querySelectorAll(".use-current-question-input:checked")) useCurrentQuestionIds.push(input.dataset.qid);

  const saveMsg = document.getElementById("saveMsg");
  saveMsg.textContent = "正在保存";
  try {
    const data = await api(`/api/admin/submissions/${encodeURIComponent(currentId)}`, {
      method: "PUT",
      body: JSON.stringify({
        objectiveScores,
        qaScores,
        useCurrentQuestionIds,
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
    adminAuthProviders = {
      dingtalk: config.providers?.dingtalk?.enabled ?? config.enabled,
      feishu: Boolean(config.providers?.feishu?.enabled)
    };
    updateAdminLoginButtons();
    if (!config.enabled) {
      msg.textContent = "管理员登录服务尚未配置，请联系系统管理员。";
      msg.classList.remove("hidden");
      return;
    }
    if (!me.user) return;
    const access = await api("/api/admin/check");
    applyAdminAccess(access);
    document.getElementById("loginPage").classList.add("hidden");
    document.getElementById("adminPage").classList.remove("hidden");
    setAdminWorkspace("list");
    await loadList();
    startAdminSessionMonitoring();
  } catch (err) {
    msg.textContent = err.message || "当前账号没有阅卷权限。";
    msg.className = "notice error";
  }
}

document.getElementById("refreshBtn").addEventListener("click", loadList);
document.getElementById("manageAdminsBtn").addEventListener("click", openAdminManager);
document.getElementById("manageExamsBtn").addEventListener("click", openExamAuthoring);
document.getElementById("manageQuestionsBtn").addEventListener("click", openQuestionManager);
document.getElementById("manageBackupsBtn").addEventListener("click", openBackupManager);
document.getElementById("newQuestionBtn").addEventListener("click", startNewQuestion);
document.getElementById("newQuestionBankBtn").addEventListener("click", () => {
  if (questionBankBusy) return;
  questionBankEditorMode = "new";
  questionBankNotice = { text: "", type: "" };
  renderQuestionBankManager();
});
document.getElementById("newExamBtn").addEventListener("click", startNewExam);
document.getElementById("closeAdminManagerBtn").addEventListener("click", () => {
  document.getElementById("adminManagerDialog").close();
});
document.getElementById("closeBackupManagerBtn").addEventListener("click", () => {
  if (!backupBusy) document.getElementById("backupManagerDialog").close();
});
document.getElementById("backupManagerDialog").addEventListener("cancel", (event) => {
  if (backupBusy) event.preventDefault();
});
document.getElementById("exportExamBackupBtn").addEventListener("click", () => {
  exportBackup("exam", document.getElementById("backupExamSelect").value);
});
document.getElementById("exportQuestionBankBackupBtn").addEventListener("click", () => {
  exportBackup("question-bank", document.getElementById("backupQuestionBankSelect").value);
});
document.getElementById("backupImportFile").addEventListener("change", (event) => {
  document.getElementById("importBackupBtn").disabled = backupBusy || !event.target.files?.length;
});
document.getElementById("importBackupBtn").addEventListener("click", importBackup);
document.getElementById("refreshBackupAutomationBtn").addEventListener("click", async () => {
  try { await loadBackupAutomation(); } catch (error) { showBackupMessage(error.message || "自动备份状态刷新失败", "error"); }
});
document.getElementById("runBackupAutomationBtn").addEventListener("click", triggerAutomaticBackup);
document.getElementById("backupRunList").addEventListener("click", (event) => {
  const button = event.target.closest(".stored-backup-download-btn");
  if (button) downloadStoredBackup(button.dataset.artifactId);
});
document.getElementById("closeQuestionManagerBtn").addEventListener("click", () => {
  if (questionImageUploadBusy) {
    document.getElementById("questionImageMsg").textContent = "图片正在上传，完成前不能关闭";
    return;
  }
  document.getElementById("questionManagerDialog").close();
});
document.getElementById("questionManagerDialog").addEventListener("cancel", (event) => {
  if (questionImageUploadBusy) event.preventDefault();
});
document.getElementById("closeExamAuthoringBtn").addEventListener("click", () => {
  if (examSelectionDirty && !window.confirm("当前选题尚未保存，确认关闭吗？")) return;
  examSelectionDirty = false;
  examSelectAllRequested = false;
  newExamDraft = null;
  document.getElementById("examAuthoringDialog").close();
});
document.getElementById("examAuthoringDialog").addEventListener("cancel", (event) => {
  if (examSelectionDirty && !window.confirm("当前选题尚未保存，确认关闭吗？")) {
    event.preventDefault();
    return;
  }
  examSelectionDirty = false;
  examSelectAllRequested = false;
  newExamDraft = null;
});
document.getElementById("adminUserSearch").addEventListener("input", renderAdminUsers);
document.getElementById("refreshMergeCandidatesBtn").addEventListener("click", loadMergeCandidates);
document.getElementById("questionSearch").addEventListener("input", renderQuestionList);
document.getElementById("questionExamFilter").addEventListener("change", (event) => {
  if (questionImageUploadBusy) {
    event.target.value = currentQuestionFilterId;
    return;
  }
  currentQuestionFilterId = event.target.value;
  newQuestionDraft = null;
  questionImageDraft = null;
  const filtered = window.QuestionAdminModel.filterQuestions(adminQuestions, currentQuestionFilterId);
  currentQuestionId = filtered[0]?.id || "";
  document.getElementById("questionSearch").value = "";
  renderQuestionList();
  questionBankEditorMode = "";
  questionBankNotice = { text: "", type: "" };
  renderQuestionBankManager();
  renderQuestionEditor();
});
document.getElementById("logoutBtn").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  location.reload();
});
document.getElementById("searchInput").addEventListener("input", renderList);
document.getElementById("statusFilter").addEventListener("change", renderList);
for (const button of document.querySelectorAll(".stat-filter")) {
  button.addEventListener("click", () => setStatusFilter(button.dataset.statusFilter));
}
window.addEventListener("pageshow", verifyAdminSession);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") verifyAdminSession();
});
initializeAdmin();
