function authoringPayload(detail, banks, assignments = []) {
  const { questions = [], ...exam } = detail;
  return { exam, banks, questions, ...(assignments.length ? { assignments } : {}) };
}

function createAdminExamAuthoringHandler({
  repository,
  listManagedQuestionBanks,
  listExamAssignmentUsers,
  listExamAssignmentDepartments = async () => [],
  getPool,
  readBody,
  json,
  isSameOriginJsonRequest
}) {
  const routes = [
    { method: "GET", pattern: /^\/api\/admin\/exams$/, action: "list" },
    { method: "GET", pattern: /^\/api\/admin\/exam-assignment-users$/, action: "assignmentUsers" },
    { method: "POST", pattern: /^\/api\/admin\/exams$/, action: "create" },
    { method: "GET", pattern: /^\/api\/admin\/exams\/([^/]+)\/authoring$/, action: "detail" },
    { method: "POST", pattern: /^\/api\/admin\/exams\/([^/]+)\/assignments$/, action: "assignmentAdd" },
    { method: "DELETE", pattern: /^\/api\/admin\/exams\/([^/]+)\/assignments\/([^/]+)$/, action: "assignmentRemove" },
    { method: "POST", pattern: /^\/api\/admin\/exams\/([^/]+)\/copy$/, action: "copy" },
    { method: "POST", pattern: /^\/api\/admin\/exams\/([^/]+)\/revision$/, action: "revision" },
    { method: "POST", pattern: /^\/api\/admin\/exams\/([^/]+)\/publish$/, action: "publish" },
    { method: "POST", pattern: /^\/api\/admin\/exams\/([^/]+)\/archive$/, action: "archive" },
    { method: "PATCH", pattern: /^\/api\/admin\/exams\/([^/]+)\/authoring$/, action: "authoring" },
    { method: "PATCH", pattern: /^\/api\/admin\/exams\/([^/]+)$/, action: "settings" },
    { method: "PUT", pattern: /^\/api\/admin\/exams\/([^/]+)\/question-bank$/, action: "bank" },
    { method: "PUT", pattern: /^\/api\/admin\/exams\/([^/]+)\/questions$/, action: "questions" },
    { method: "PUT", pattern: /^\/api\/admin\/exams\/([^/]+)\/question-order$/, action: "order" },
    { method: "PATCH", pattern: /^\/api\/admin\/exams\/([^/]+)\/questions\/([^/]+)\/score$/, action: "score" },
    { method: "PATCH", pattern: /^\/api\/admin\/exams\/([^/]+)\/question-scores$/, action: "scores" }
  ];

  return async function handleAdminExamAuthoring(req, res, pathname, adminAccess) {
    const route = routes.find((candidate) => candidate.method === req.method && candidate.pattern.test(pathname));
    if (!route) return false;
    if (!adminAccess?.canManageQuestions) {
      json(res, 403, { error: "当前账号没有试卷管理权限" });
      return true;
    }

    const pool = getPool();
    if (!pool) {
      json(res, 503, { error: "试卷数据库尚未配置" });
      return true;
    }

    const match = pathname.match(route.pattern);
    const examId = match?.[1] ? decodeURIComponent(match[1]) : "";
    const questionId = match?.[2] ? decodeURIComponent(match[2]) : "";
    try {
      if (route.action === "list") {
        json(res, 200, { exams: await repository.listAuthoringExams(pool) });
        return true;
      }

      if (route.action === "assignmentUsers") {
        json(res, 200, { users: await listExamAssignmentUsers(pool) });
        return true;
      }

      if (route.action === "detail") {
        const [detail, banks, departments] = await Promise.all([
          repository.getExamAuthoring(pool, examId),
          listManagedQuestionBanks(pool),
          listExamAssignmentDepartments(pool)
        ]);
        const assignments = detail && repository.listExamAssignments
          ? await repository.listExamAssignments(pool, examId)
          : [];
        if (!detail) json(res, 404, { error: "未找到试卷" });
        else json(res, 200, { authoring: authoringPayload(detail, banks, assignments), ...(departments.length ? { departments } : {}) });
        return true;
      }

      if (!isSameOriginJsonRequest(req)) {
        json(res, 403, { error: "试卷修改请求来源无效" });
        return true;
      }
      const body = await readBody(req);
      let detail;
      if (route.action === "assignmentAdd") {
        detail = await repository.addExamAssignment(pool, examId, body, adminAccess.userId);
      } else if (route.action === "assignmentRemove") {
        detail = await repository.removeExamAssignment(pool, examId, questionId, body, adminAccess.userId);
      } else if (route.action === "create") {
        detail = await repository.createExam(pool, body, adminAccess.userId);
      } else if (route.action === "copy") {
        detail = await repository.copyExam(pool, examId, body, adminAccess.userId);
      } else if (route.action === "revision") {
        // Entering edit mode is local-only. Keep the legacy route read-only so
        // old clients cannot pause a published exam without saving changes.
        detail = await repository.getExamAuthoring(pool, examId);
      } else if (route.action === "publish") {
        detail = await repository.publishExam(pool, examId, body, adminAccess.userId);
      } else if (route.action === "archive") {
        detail = await repository.archiveExam(pool, examId, body, adminAccess.userId);
      } else if (route.action === "authoring") {
        detail = await repository.saveExamAuthoring(pool, examId, body, adminAccess.userId);
      } else if (route.action === "settings") {
        detail = await repository.updateExamSettings(pool, examId, body, adminAccess.userId);
      } else if (route.action === "bank") {
        detail = await repository.bindExamQuestionBank(pool, examId, {
          ...body,
          bankId: body.questionBankId ?? body.bankId
        }, adminAccess.userId);
      } else if (route.action === "questions") {
        detail = await repository.setExamQuestions(pool, examId, body, adminAccess.userId);
      } else if (route.action === "order") {
        detail = await repository.reorderExamQuestions(pool, examId, body, adminAccess.userId);
      } else if (route.action === "score") {
        detail = await repository.updateExamQuestionScore(pool, examId, questionId, body, adminAccess.userId);
      } else {
        detail = await repository.updateAllExamQuestionScores(pool, examId, body, adminAccess.userId);
      }
      const [banks, departments] = await Promise.all([
        listManagedQuestionBanks(pool),
        listExamAssignmentDepartments(pool)
      ]);
      const assignments = repository.listExamAssignments
        ? await repository.listExamAssignments(pool, examId)
        : [];
      json(res, 200, { authoring: authoringPayload(detail, banks, assignments), ...(departments.length ? { departments } : {}) });
      return true;
    } catch (error) {
      if (Number.isInteger(error?.statusCode)) {
        json(res, error.statusCode, { error: error.message });
      } else if (error?.message === "JSON 格式错误" || error?.message === "请求内容过大") {
        json(res, 400, { error: error.message });
      } else {
        json(res, 503, { error: "试卷组卷服务暂不可用" });
      }
      return true;
    }
  };
}

module.exports = {
  authoringPayload,
  createAdminExamAuthoringHandler
};
