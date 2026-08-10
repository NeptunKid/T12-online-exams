const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createDingtalkProvider, createFeishuProvider } = require("./src/auth/oauth-providers");
const { createPostgresPool, isPostgresConfigured } = require("./src/db/postgres-client");
const { createSubmission, getPublishedExam, getStudentDashboard, getStudentSubmission, listPublishedExams, listStudentSubmissions } = require("./src/db/exam-repository");
const { getAdminSubmission, gradeAdminSubmission, grantRetakePermission, listAdminSubmissions } = require("./src/db/admin-submission-repository");
const { createQuestion, listQuestionBanks, listQuestions, updateQuestion } = require("./src/db/question-repository");
const { ensureBootstrapAdmin, getAdminAccess, getIdentityAccess, listAdminUsers, setAdminRole, upsertDingtalkUser, upsertFeishuUser } = require("./src/db/user-repository");

function loadEnvFile() {
  const envPath = process.env.T12_ENV_FILE || path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "127.0.0.1";
const DINGTALK_CLIENT_ID = process.env.DINGTALK_CLIENT_ID || "";
const DINGTALK_CLIENT_SECRET = process.env.DINGTALK_CLIENT_SECRET || "";
const DINGTALK_REDIRECT_URI = process.env.DINGTALK_REDIRECT_URI || "";
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || "";
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || "";
const FEISHU_REDIRECT_URI = process.env.FEISHU_REDIRECT_URI || "";
const GRADER_UNION_IDS = new Set(
  (process.env.DINGTALK_GRADER_UNION_IDS || "").split(",").map((value) => value.trim()).filter(Boolean)
);
const AUTH_STATES = new Map();
const SESSIONS = new Map();
const SESSION_COOKIE = "exam_dingtalk_session";
const OAUTH_STATE_TTL = 10 * 60 * 1000;
const SESSION_TTL = 8 * 60 * 60 * 1000;
const DINGTALK_PROVIDER = createDingtalkProvider({ clientId: DINGTALK_CLIENT_ID, clientSecret: DINGTALK_CLIENT_SECRET, redirectUri: DINGTALK_REDIRECT_URI });
const FEISHU_PROVIDER = createFeishuProvider({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET, redirectUri: FEISHU_REDIRECT_URI });
let POSTGRES_POOL = null;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const EXAM_DATA_PATH = path.join(PUBLIC_DIR, "exam_data.js");
const STORE_PATH = path.join(ROOT, "data", "submissions.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function readExamData() {
  const raw = fs.readFileSync(EXAM_DATA_PATH, "utf8");
  const match = raw.match(/const\s+EXAM_DATA\s*=\s*([\s\S]*?);\s*$/);
  if (!match) throw new Error("无法解析 public/exam_data.js");
  return JSON.parse(match[1]);
}

const examData = readExamData();
const questionsById = new Map(examData.questions.map((q) => [String(q.id), q]));

function attachLegacyExamImages(exam) {
  if (!exam || exam.title !== examData.title) return exam;
  const images = { ...(exam.images || {}) };
  for (const question of exam.questions || []) {
    const legacy = examData.images?.[String(question.sourceId)] || { stem: [], options: {} };
    const current = images[question.id] || question.images || { stem: [], options: {} };
    images[question.id] = {
      stem: [...(current.stem || []), ...(legacy.stem || [])],
      options: { ...(current.options || {}), ...(legacy.options || {}) }
    };
  }
  return { ...exam, images };
}

function attachLegacyStudentImages(detail) {
  if (!detail || detail.submission?.examTitle !== examData.title) return detail;
  return {
    ...detail,
    questions: (detail.questions || []).map((question) => ({
      ...question,
      images: examData.images?.[String(question.sourceId)] || { stem: [], options: {} }
    }))
  };
}

function retakeKey(unionId, examTitle) {
  return `${unionId}:${examTitle}`;
}

function getRetakeState(store, unionId, examTitle) {
  const key = retakeKey(unionId, examTitle);
  const permission = store.retakePermissions?.[key] || {};
  return {
    key,
    remainingExtraAttempts: Math.max(0, Number(permission.remainingExtraAttempts || 0)),
    grantedAt: permission.grantedAt || "",
    grantedBy: permission.grantedBy || ""
  };
}

function getAttemptInfo(store, user) {
  const attempts = store.submissions.filter((item) => item.dingtalkUnionId === user.unionId && item.examTitle === examData.title);
  const latest = attempts[0];
  const retake = getRetakeState(store, user.unionId, examData.title);
  const nextAttempt = attempts.length + 1;
  const awaitingGrade = Boolean(latest && latest.status !== "graded");
  const usesExtraPermission = nextAttempt > 2;
  const available = !awaitingGrade && (nextAttempt <= 2 || retake.remainingExtraAttempts > 0);

  let message = "本次为第1次考核，仅有一次补考机会。";
  if (awaitingGrade) message = "上一份答卷正在阅卷，阅卷完成后才能参加补考。";
  else if (nextAttempt === 2) message = "本次为补考。";
  else if (usesExtraPermission && available) message = `本次为第${nextAttempt - 2}次额外补考。`;
  else if (usesExtraPermission) message = "已完成首次考核和一次免费补考，请联系管理员开放额外补考权限。";

  return {
    attemptNo: nextAttempt,
    completedAttempts: attempts.length,
    available,
    awaitingGrade,
    remainingExtraAttempts: retake.remainingExtraAttempts,
    message
  };
}

function publicExam(attempt) {
  return {
    title: examData.title,
    duration: examData.duration,
    passScore: examData.passScore,
    totalScore: examData.totalScore,
    questions: examData.questions.map(({ answer, explanation, ...q }) => q),
    images: examData.images || {},
    attempt
  };
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (Array.isArray(parsed.submissions)) return parsed;
  } catch (_) {}
  return { submissions: [] };
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, STORE_PATH);
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }).filter((part) => part.length));
}

function setSessionCookie(res, token, maxAge = SESSION_TTL) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}${secure}`);
}

function getSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  const session = token ? SESSIONS.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) SESSIONS.delete(token);
    return null;
  }
  return { token, ...session };
}

function currentUser(req) {
  const session = getSession(req);
  if (!session) return null;
  const provider = session.provider || "dingtalk";
  return {
    unionId: session.unionId,
    provider,
    providerSubject: session.providerSubject || session.openId || session.unionId,
    name: session.name,
    avatarUrl: session.avatarUrl,
    role: session.roles?.includes("system_admin")
      ? "system_admin"
      : session.roles?.includes("exam_admin")
        ? "exam_admin"
        : session.roles?.includes("grader") || (provider === "dingtalk" && GRADER_UNION_IDS.has(session.unionId))
          ? "grader"
          : "student",
    roles: session.roles || []
  };
}

function publicUser(user) {
  if (!user) return null;
  const { providerSubject, ...safeUser } = user;
  return safeUser;
}

function roleForUnionId(unionId, graderIds = GRADER_UNION_IDS) {
  return graderIds.has(unionId) ? "grader" : "student";
}

function isDingtalkReady() {
  return DINGTALK_PROVIDER.enabled;
}

function isFeishuReady() {
  return FEISHU_PROVIDER.enabled;
}

function getPostgresPool() {
  if (!isPostgresConfigured()) return null;
  if (!POSTGRES_POOL) POSTGRES_POOL = createPostgresPool();
  return POSTGRES_POOL;
}

function validReturnTo(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function cleanExpiredAuth() {
  const now = Date.now();
  for (const [key, item] of AUTH_STATES) if (item.expiresAt < now) AUTH_STATES.delete(key);
  for (const [key, item] of SESSIONS) if (item.expiresAt < now) SESSIONS.delete(key);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("请求内容过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (_) {
        reject(new Error("JSON 格式错误"));
      }
    });
    req.on("error", reject);
  });
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) json(res, 401, { error: "请先登录" });
  return user;
}

async function requireGrader(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  try {
    const access = user.provider === "dingtalk"
      ? await getAdminAccess(getPostgresPool(), user.unionId, GRADER_UNION_IDS)
      : await getIdentityAccess(getPostgresPool(), user.provider, user.providerSubject);
    if (access.canAccess) return { user, ...access };
    json(res, 403, { error: "当前账号没有阅卷权限" });
    return null;
  } catch (_) {
    json(res, 503, { error: "用户权限数据库暂不可用" });
    return null;
  }
}

function healthStatus() {
  return { status: "ok", service: "t12-online-exams" };
}

async function readinessStatus() {
  const pool = getPostgresPool();
  if (!pool) return { status: "not_ready", reason: "database_not_configured" };
  try {
    await pool.query("SELECT 1");
    return { status: "ready", database: "ok" };
  } catch (_) {
    return { status: "not_ready", reason: "database_unavailable" };
  }
}

function sameAnswer(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? [...a].sort() : [];
    const bb = Array.isArray(b) ? [...b].sort() : [];
    return JSON.stringify(aa) === JSON.stringify(bb);
  }
  return String(a || "") === String(b || "");
}

function matchesFillAnswer(actual, expected) {
  const normalizedActual = String(actual ?? "").trim().toLocaleLowerCase();
  if (!normalizedActual) return false;
  const accepted = Array.isArray(expected) ? expected : [expected];
  return accepted.some((item) => normalizedActual === String(item ?? "").trim().toLocaleLowerCase());
}

function gradeObjective(answers) {
  const detail = {};
  const summary = {
    singleRight: 0,
    singleWrong: 0,
    multiRight: 0,
    multiPartial: 0,
    multiWrong: 0,
    judgeRight: 0,
    judgeWrong: 0
  };
  let objectiveScore = 0;

  for (const q of examData.questions) {
    const userAns = answers[String(q.id)] ?? (q.type === "multi" ? [] : "");
    if (q.type === "qa") continue;

    let earned = 0;
    let correct = false;
    if (q.type === "multi") {
      const selected = Array.isArray(userAns) ? [...userAns].sort() : [];
      const answer = Array.isArray(q.answer) ? [...q.answer].sort() : [];
      const hasWrong = selected.some((item) => !answer.includes(item));
      correct = sameAnswer(selected, answer);
      if (correct) {
        earned = q.score;
        summary.multiRight += 1;
      } else if (selected.length > 0 && !hasWrong && selected.length < answer.length) {
        earned = q.score / 2;
        summary.multiPartial += 1;
      } else {
        summary.multiWrong += 1;
      }
    } else {
      correct = q.type === "fill" ? matchesFillAnswer(userAns, q.answer) : sameAnswer(userAns, q.answer);
      earned = correct ? q.score : 0;
      if (q.type === "single") summary[correct ? "singleRight" : "singleWrong"] += 1;
      if (q.type === "judge") summary[correct ? "judgeRight" : "judgeWrong"] += 1;
    }

    objectiveScore += earned;
    detail[q.id] = { answer: userAns, correctAnswer: q.answer, earned, maxScore: q.score, correct };
  }

  return { objectiveScore, objectiveDetail: detail, objectiveSummary: summary };
}

function reviewObjectiveScores(item, input) {
  const objectiveDetail = { ...item.objectiveDetail };
  let objectiveScore = 0;

  for (const q of examData.questions.filter((question) => question.type !== "qa")) {
    const existing = objectiveDetail[q.id] || { answer: item.answers?.[q.id], correctAnswer: q.answer, maxScore: q.score, earned: 0 };
    const raw = input?.[String(q.id)];
    const hasManualScore = raw !== "" && raw !== undefined && raw !== null;
    let score = Number(existing.earned ?? 0);

    // 空值代表沿用自动判分或先前保存的人工分数，不要求阅卷人逐题重填。
    if (hasManualScore) {
      if (!Number.isFinite(Number(raw))) {
        throw new Error(`客观题 ${q.no || q.id} 的分数必须是数字`);
      }
      score = Math.max(0, Math.min(q.score, Number(raw)));
      const automaticEarned = Number(existing.automaticEarned ?? existing.earned ?? 0);
      objectiveDetail[q.id] = {
        ...existing,
        automaticEarned,
        earned: score,
        manuallyAdjusted: score !== automaticEarned
      };
    } else {
      objectiveDetail[q.id] = { ...existing, earned: score };
    }
    objectiveScore += score;
  }

  return { objectiveDetail, objectiveScore };
}

function cleanAnswers(input) {
  const answers = {};
  for (const q of examData.questions) {
    const raw = input?.[String(q.id)];
    if (q.type === "multi") {
      answers[q.id] = Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
    } else {
      answers[q.id] = typeof raw === "string" ? raw.trim() : "";
    }
  }
  return answers;
}

function toListItem(item) {
  return {
    id: item.id,
    studentName: item.studentName,
    studentNo: item.studentNo,
    department: item.department,
    submittedAt: item.submittedAt,
    status: item.status,
    objectiveScore: item.objectiveScore,
    qaScore: item.qaScore,
    totalScore: item.totalScore,
    pass: item.pass,
    passScore: item.passScore ?? examData.passScore,
    attemptNo: item.attemptNo || 1,
    gradedAt: item.gradedAt,
    graderName: item.graderName
  };
}

function toStudentSubmission(item) {
  return {
    id: item.id,
    examTitle: item.examTitle,
    submittedAt: item.submittedAt,
    status: item.status,
    objectiveScore: item.objectiveScore,
    totalScore: item.totalScore,
    pass: item.pass,
    passScore: item.passScore ?? examData.passScore,
    attemptNo: item.attemptNo || 1,
    gradedAt: item.gradedAt,
    graderName: item.graderName,
    graderComment: item.graderComment
  };
}

function toStudentSubmissionDetail(item) {
  const submission = {
    ...toStudentSubmission(item),
    durationSeconds: item.durationSeconds,
    answers: item.answers
  };
  const graded = item.status === "graded";

  if (graded) {
    submission.objectiveDetail = item.objectiveDetail || {};
    submission.qaScores = item.qaScores || {};
    submission.qaScore = item.qaScore;
  }

  return {
    submission,
    exam: {
      title: examData.title,
      totalScore: examData.totalScore,
      passScore: examData.passScore,
      images: examData.images || {},
      questions: examData.questions.map((question) => {
        const { answer, explanation, ...publicQuestion } = question;
        return graded ? { ...publicQuestion, answer, explanation } : publicQuestion;
      })
    }
  };
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/auth/config") {
    return json(res, 200, {
      enabled: isDingtalkReady() || isFeishuReady(),
      loginUrl: "/auth/dingtalk/login?returnTo=/",
      providers: {
        dingtalk: { enabled: isDingtalkReady(), loginUrl: "/auth/dingtalk/login?returnTo=/" },
        feishu: { enabled: isFeishuReady(), loginUrl: "/auth/feishu/login?returnTo=/" }
      }
    });
  }

  if (req.method === "GET" && pathname === "/api/auth/me") {
    return json(res, 200, { user: publicUser(currentUser(req)) });
  }

  if (req.method === "POST" && pathname === "/api/auth/logout") {
    const session = getSession(req);
    if (session) SESSIONS.delete(session.token);
    setSessionCookie(res, "", 0);
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && pathname === "/api/exams") {
    const user = requireUser(req, res);
    if (!user) return;
    const pool = getPostgresPool();
    if (!pool) return json(res, 503, { error: "考试数据库尚未配置" });
    try {
      return json(res, 200, { source: "postgres", exams: await listPublishedExams(pool, user) });
    } catch (_) {
      return json(res, 503, { error: "考试数据库暂不可用" });
    }
  }

  if (req.method === "GET" && pathname === "/api/exams/submissions") {
    const user = requireUser(req, res);
    if (!user) return;
    const pool = getPostgresPool();
    if (!pool) return json(res, 503, { error: "考试数据库尚未配置" });
    try {
      return json(res, 200, { source: "postgres", submissions: await listStudentSubmissions(pool, user) });
    } catch (_) {
      return json(res, 503, { error: "答卷数据库暂不可用" });
    }
  }

  if (req.method === "GET" && pathname === "/api/exams/dashboard") {
    const user = requireUser(req, res);
    if (!user) return;
    const pool = getPostgresPool();
    if (!pool) return json(res, 503, { error: "考试数据库尚未配置" });
    try {
      const dashboard = await getStudentDashboard(pool, user);
      return json(res, 200, { source: "postgres", user: publicUser(user), ...dashboard });
    } catch (_) {
      return json(res, 503, { error: "考试数据库暂不可用" });
    }
  }

  const studentSubmissionMatch = pathname.match(/^\/api\/exams\/submissions\/([^/]+)$/);
  if (req.method === "GET" && studentSubmissionMatch) {
    const user = requireUser(req, res);
    if (!user) return;
    const pool = getPostgresPool();
    if (!pool) return json(res, 503, { error: "考试数据库尚未配置" });
    try {
      const detail = attachLegacyStudentImages(
        await getStudentSubmission(pool, decodeURIComponent(studentSubmissionMatch[1]), user)
      );
      if (!detail) return json(res, 404, { error: "未找到该答卷" });
      return json(res, 200, { source: "postgres", ...detail });
    } catch (_) {
      return json(res, 503, { error: "答卷数据库暂不可用" });
    }
  }

  const submissionMatch = pathname.match(/^\/api\/exams\/([^/]+)\/submissions$/);
  if (req.method === "POST" && submissionMatch) {
    const user = requireUser(req, res);
    if (!user) return;
    const pool = getPostgresPool();
    if (!pool) return json(res, 503, { error: "考试数据库尚未配置" });
    try {
      const body = await readBody(req);
      const submission = await createSubmission(pool, decodeURIComponent(submissionMatch[1]), user, body);
      if (!submission) return json(res, 404, { error: "未找到已授权的已发布考试" });
      return json(res, 201, { source: "postgres", submission });
    } catch (error) {
      const message = error.message === "考试内容已更新，请刷新页面后重新开始考试"
        ? error.message
        : "答卷提交失败";
      return json(res, 400, { error: message });
    }
  }

  const examMatch = pathname.match(/^\/api\/exams\/([^/]+)$/);
  if (req.method === "GET" && examMatch) {
    const user = requireUser(req, res);
    if (!user) return;
    const pool = getPostgresPool();
    if (!pool) return json(res, 503, { error: "考试数据库尚未配置" });
    try {
      const exam = attachLegacyExamImages(await getPublishedExam(pool, decodeURIComponent(examMatch[1]), user));
      if (!exam) return json(res, 404, { error: "未找到已发布考试" });
      return json(res, 200, { source: "postgres", exam });
    } catch (_) {
      return json(res, 503, { error: "考试数据库暂不可用" });
    }
  }

  if (req.method === "GET" && pathname === "/api/student/dashboard") {
    const user = requireUser(req, res);
    if (!user) return;
    const store = readStore();
    const submissions = store.submissions
      .filter((item) => item.dingtalkUnionId === user.unionId)
      .map(toStudentSubmission);
    const attempt = getAttemptInfo(store, user);
    return json(res, 200, {
      user: publicUser(user),
      exams: [{
        id: "default",
        title: examData.title,
        duration: examData.duration,
        totalScore: examData.totalScore,
        passScore: examData.passScore,
        studyStatus: "考核已开放",
        attempt
      }],
      submissions
    });
  }

  const studentDetailMatch = pathname.match(/^\/api\/student\/submissions\/([^/]+)$/);
  if (studentDetailMatch && req.method === "GET") {
    const user = requireUser(req, res);
    if (!user) return;
    const item = readStore().submissions.find((submission) => submission.id === studentDetailMatch[1]);
    if (!item || item.dingtalkUnionId !== user.unionId) return json(res, 404, { error: "未找到该答卷" });
    if (item.examTitle !== examData.title) return json(res, 404, { error: "该考试题库暂未配置" });
    return json(res, 200, toStudentSubmissionDetail(item));
  }

  if (req.method === "GET" && pathname === "/api/exam") {
    const user = requireUser(req, res);
    if (!user) return;
    return json(res, 200, publicExam(getAttemptInfo(readStore(), user)));
  }

  if (req.method === "POST" && pathname === "/api/submissions") {
    try {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);

      const store = readStore();
      const attempt = getAttemptInfo(store, user);
      if (!attempt.available) return json(res, 403, { error: attempt.message, attempt });

      const answers = cleanAnswers(body.answers || {});
      const objective = gradeObjective(answers);
      const qaMaxScore = examData.questions
        .filter((q) => q.type === "qa")
        .reduce((sum, q) => sum + q.score, 0);
      const now = new Date().toISOString();
      const item = {
        id: `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
        examTitle: examData.title,
        studentName: user.name,
        studentNo: "",
        department: "",
        dingtalkUnionId: user.unionId,
        startedAt: body.startedAt || "",
        submittedAt: now,
        durationSeconds: Number(body.durationSeconds || 0),
        answers,
        ...objective,
        qaScores: {},
        qaScore: null,
        qaMaxScore,
        passScore: examData.passScore,
        attemptNo: attempt.attemptNo,
        totalScore: null,
        pass: null,
        status: "pending",
        graderName: "",
        graderComment: "",
        gradedAt: ""
      };
      if (attempt.attemptNo > 2) {
        const permission = store.retakePermissions?.[retakeKey(user.unionId, examData.title)];
        permission.remainingExtraAttempts -= 1;
        permission.usedAt = now;
      }
      store.submissions.unshift(item);
      writeStore(store);
      return json(res, 201, { id: item.id, status: item.status, objectiveScore: item.objectiveScore, attemptNo: item.attemptNo });
    } catch (err) {
      return json(res, 400, { error: err.message || "提交失败" });
    }
  }

  let adminAccess = null;
  if (pathname.startsWith("/api/admin/")) {
    adminAccess = await requireGrader(req, res);
    if (!adminAccess) return;
  }

  if (req.method === "GET" && pathname === "/api/admin/check") {
    return json(res, 200, {
      ok: true,
      canManageAdmins: adminAccess.canManageAdmins,
      canManageQuestions: adminAccess.canManageQuestions,
      currentUserId: adminAccess.userId
    });
  }

  if (req.method === "GET" && pathname === "/api/admin/questions") {
    if (!adminAccess.canManageQuestions) return json(res, 403, { error: "当前账号没有题库维护权限" });
    const pool = getPostgresPool();
    if (!pool) return json(res, 503, { error: "题库数据库尚未配置" });
    try {
      const [questions, banks] = await Promise.all([listQuestions(pool), listQuestionBanks(pool)]);
      return json(res, 200, { questions, banks });
    } catch (_) {
      return json(res, 503, { error: "题库数据库暂不可用" });
    }
  }

  if (req.method === "POST" && pathname === "/api/admin/questions") {
    if (!adminAccess.canManageQuestions) return json(res, 403, { error: "当前账号没有题库维护权限" });
    const pool = getPostgresPool();
    if (!pool) return json(res, 503, { error: "题库数据库尚未配置" });
    try {
      const body = await readBody(req);
      const question = await createQuestion(pool, body, adminAccess.userId);
      return json(res, 201, { question });
    } catch (error) {
      return json(res, 400, { error: error.message || "题目录入失败" });
    }
  }

  const adminQuestionMatch = pathname.match(/^\/api\/admin\/questions\/([^/]+)$/);
  if (adminQuestionMatch && req.method === "PUT") {
    if (!adminAccess.canManageQuestions) return json(res, 403, { error: "当前账号没有题库维护权限" });
    const pool = getPostgresPool();
    if (!pool) return json(res, 503, { error: "题库数据库尚未配置" });
    try {
      const body = await readBody(req);
      const question = await updateQuestion(
        pool,
        decodeURIComponent(adminQuestionMatch[1]),
        body,
        adminAccess.userId
      );
      return json(res, 200, { question });
    } catch (error) {
      return json(res, 400, { error: error.message || "题目保存失败" });
    }
  }

  if (req.method === "GET" && pathname === "/api/admin/users") {
    if (!adminAccess.canManageAdmins) return json(res, 403, { error: "当前账号没有管理员授权权限" });
    const pool = getPostgresPool();
    if (!pool) return json(res, 503, { error: "用户权限数据库尚未配置" });
    try {
      return json(res, 200, { users: await listAdminUsers(pool) });
    } catch (_) {
      return json(res, 503, { error: "用户权限数据库暂不可用" });
    }
  }

  const adminRoleMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/admin-role$/);
  if (adminRoleMatch && req.method === "PUT") {
    if (!adminAccess.canManageAdmins) return json(res, 403, { error: "当前账号没有管理员授权权限" });
    const pool = getPostgresPool();
    if (!pool) return json(res, 503, { error: "用户权限数据库尚未配置" });
    try {
      const body = await readBody(req);
      if (typeof body.enabled !== "boolean") return json(res, 400, { error: "enabled 必须是布尔值" });
      const updated = await setAdminRole(
        pool,
        decodeURIComponent(adminRoleMatch[1]),
        body.enabled,
        adminAccess.userId
      );
      return json(res, 200, { user: updated });
    } catch (error) {
      return json(res, 400, { error: error.message || "管理员权限更新失败" });
    }
  }

  if (req.method === "GET" && pathname === "/api/admin/submissions") {
    const pool = getPostgresPool();
    if (pool) {
      try {
        return json(res, 200, await listAdminSubmissions(pool));
      } catch (_) {
        return json(res, 503, { error: "答卷数据库暂不可用" });
      }
    }
    const store = readStore();
    return json(res, 200, {
      submissions: store.submissions.map(toListItem),
      stats: {
        total: store.submissions.length,
        pending: store.submissions.filter((s) => s.status === "pending").length,
        graded: store.submissions.filter((s) => s.status === "graded").length
      }
    });
  }

  const detailMatch = pathname.match(/^\/api\/admin\/submissions\/([^/]+)$/);
  const retakePermissionMatch = pathname.match(/^\/api\/admin\/submissions\/([^/]+)\/retake-permission$/);
  if (retakePermissionMatch && req.method === "PUT") {
    try {
      const pool = getPostgresPool();
      if (pool) {
        const retake = await grantRetakePermission(
          pool,
          decodeURIComponent(retakePermissionMatch[1]),
          adminAccess.userId
        );
        return json(res, 200, { retake });
      }
      const store = readStore();
      const item = store.submissions.find((submission) => submission.id === retakePermissionMatch[1]);
      if (!item) return json(res, 404, { error: "未找到该答卷" });
      if (!item.dingtalkUnionId) return json(res, 400, { error: "该历史答卷缺少钉钉身份，无法开放补考" });

      store.retakePermissions ||= {};
      const key = retakeKey(item.dingtalkUnionId, item.examTitle);
      const permission = store.retakePermissions[key] || { remainingExtraAttempts: 0 };
      permission.remainingExtraAttempts = Number(permission.remainingExtraAttempts || 0) + 1;
      permission.grantedAt = new Date().toISOString();
      permission.grantedBy = currentUser(req).name;
      store.retakePermissions[key] = permission;
      writeStore(store);
      return json(res, 200, { retake: getRetakeState(store, item.dingtalkUnionId, item.examTitle) });
    } catch (err) {
      return json(res, 400, { error: err.message || "开放补考失败" });
    }
  }

  if (detailMatch && req.method === "GET") {
    const pool = getPostgresPool();
    if (pool) {
      try {
        const detail = await getAdminSubmission(pool, decodeURIComponent(detailMatch[1]));
        if (!detail) return json(res, 404, { error: "未找到该答卷" });
        return json(res, 200, { ...detail, exam: attachLegacyExamImages(detail.exam) });
      } catch (_) {
        return json(res, 503, { error: "答卷数据库暂不可用" });
      }
    }
    const store = readStore();
    const item = store.submissions.find((s) => s.id === detailMatch[1]);
    if (!item) return json(res, 404, { error: "未找到该答卷" });
    return json(res, 200, {
      submission: item,
      exam: examData,
      retake: item.dingtalkUnionId ? getRetakeState(store, item.dingtalkUnionId, item.examTitle) : null
    });
  }

  if (detailMatch && req.method === "PUT") {
    try {
      const body = await readBody(req);
      const pool = getPostgresPool();
      if (pool) {
        const detail = await gradeAdminSubmission(
          pool,
          decodeURIComponent(detailMatch[1]),
          body,
          { userId: adminAccess.userId, name: currentUser(req).name }
        );
        return json(res, 200, { submission: detail.submission });
      }
      const store = readStore();
      const index = store.submissions.findIndex((s) => s.id === detailMatch[1]);
      if (index < 0) return json(res, 404, { error: "未找到该答卷" });
      const item = store.submissions[index];
      const objective = reviewObjectiveScores(item, body.objectiveScores);
      const qaScores = {};
      let qaScore = 0;

      for (const q of examData.questions.filter((q) => q.type === "qa")) {
        const raw = body.qaScores?.[String(q.id)];
        if (raw === "" || raw === undefined || raw === null) {
          return json(res, 400, { error: `请填写问答题 ${q.no || q.id} 的分数` });
        }
        const score = Math.max(0, Math.min(q.score, Number(raw)));
        qaScores[q.id] = score;
        qaScore += score;
      }

      const rawPassScore = body.passScore ?? item.passScore ?? examData.passScore;
      if (rawPassScore === "" || !Number.isFinite(Number(rawPassScore))) {
        return json(res, 400, { error: "请填写有效的通过分数" });
      }
      const passScore = Math.max(0, Math.min(examData.totalScore, Number(rawPassScore)));
      const totalScore = objective.objectiveScore + qaScore;
      store.submissions[index] = {
        ...item,
        objectiveDetail: objective.objectiveDetail,
        objectiveScore: objective.objectiveScore,
        qaScores,
        qaScore,
        totalScore,
        passScore,
        pass: totalScore >= passScore,
        status: "graded",
        graderName: currentUser(req).name,
        graderComment: String(body.graderComment || "").trim(),
        gradedAt: new Date().toISOString()
      };
      writeStore(store);
      return json(res, 200, { submission: store.submissions[index] });
    } catch (err) {
      return json(res, 400, { error: err.message || "保存失败" });
    }
  }

  return json(res, 404, { error: "接口不存在" });
}

function serveStatic(req, res, pathname) {
  if (pathname === "/") pathname = "/exam.html";
  if (pathname === "/admin") pathname = "/admin.html";
  if (pathname === "/exam_data.js") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const resolved = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const extension = path.extname(resolved).toLowerCase();
    const headers = { "Content-Type": MIME[extension] || "application/octet-stream" };
    if ([".html", ".css", ".js"].includes(extension)) {
      headers["Cache-Control"] = "no-store, max-age=0";
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

function handleOAuthLogin(res, url, provider, label) {
  if (!provider.enabled) return json(res, 503, { error: `${label}登录尚未配置，请联系系统管理员。` });
  cleanExpiredAuth();
  const state = crypto.randomBytes(24).toString("hex");
  AUTH_STATES.set(state, {
    provider: provider.name,
    returnTo: validReturnTo(url.searchParams.get("returnTo")),
    expiresAt: Date.now() + OAUTH_STATE_TTL
  });
  res.writeHead(302, { Location: provider.getAuthorizationUrl(state) });
  res.end();
}

async function handleOAuthCallback(res, url, provider, label) {
  cleanExpiredAuth();
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const pending = state ? AUTH_STATES.get(state) : null;
  if (!code || !pending || pending.provider !== provider.name) {
    return json(res, 400, { error: `${label}登录校验失败，请重新发起登录。` });
  }
  AUTH_STATES.delete(state);
  try {
    const user = await provider.exchangeCode(code);
    let roles = [];
    const pool = getPostgresPool();
    if (pool) {
      try {
        const userId = provider.name === "dingtalk"
          ? await upsertDingtalkUser(pool, user)
          : await upsertFeishuUser(pool, user);
        if (provider.name === "dingtalk" && GRADER_UNION_IDS.has(user.unionId)) {
          await ensureBootstrapAdmin(pool, userId);
        }
        roles = provider.name === "dingtalk"
          ? (await getAdminAccess(pool, user.unionId, GRADER_UNION_IDS)).roles
          : (await getIdentityAccess(pool, provider.name, user.providerSubject)).roles;
      } catch (_) {
        throw new Error("用户权限数据库暂不可用");
      }
    }
    const token = crypto.randomBytes(32).toString("hex");
    SESSIONS.set(token, { ...user, roles, expiresAt: Date.now() + SESSION_TTL });
    setSessionCookie(res, token);
    res.writeHead(302, { Location: pending.returnTo });
    res.end();
  } catch (err) {
    json(res, 502, { error: err.message || `${label}登录失败` });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/healthz") {
    json(res, 200, healthStatus());
  } else if (req.method === "GET" && url.pathname === "/readyz") {
    readinessStatus().then((status) => json(res, status.status === "ready" ? 200 : 503, status));
  } else if (url.pathname === "/auth/dingtalk/login") {
    handleOAuthLogin(res, url, DINGTALK_PROVIDER, "钉钉");
  } else if (url.pathname === "/auth/dingtalk/callback") {
    handleOAuthCallback(res, url, DINGTALK_PROVIDER, "钉钉");
  } else if (url.pathname === "/auth/feishu/login") {
    handleOAuthLogin(res, url, FEISHU_PROVIDER, "飞书");
  } else if (url.pathname === "/auth/feishu/callback") {
    handleOAuthCallback(res, url, FEISHU_PROVIDER, "飞书");
  } else if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url.pathname).catch((err) => json(res, 500, { error: err.message || "服务器错误" }));
  } else {
    serveStatic(req, res, url.pathname);
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`考试后台追踪系统已启动: http://${HOST}:${PORT}`);
    console.log(`管理员后台: http://${HOST}:${PORT}/admin`);
  });
}

module.exports = {
  examData,
  sameAnswer,
  gradeObjective,
  reviewObjectiveScores,
  validReturnTo,
  getAttemptInfo,
  roleForUnionId,
  healthStatus,
  readinessStatus,
  matchesFillAnswer,
  publicUser
};
