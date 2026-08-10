(function initializeQuestionAdminModel(root) {
  function listQuestionExams(questions) {
    const exams = new Map();
    for (const question of questions || []) {
      for (const exam of question.exams || []) {
        if (!exams.has(exam.id)) exams.set(exam.id, { id: exam.id, title: exam.title, status: exam.status });
      }
    }
    return [...exams.values()].sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
  }

  function filterQuestionsByExam(questions, examId, query = "") {
    const normalizedQuery = String(query).trim().toLowerCase();
    return (questions || []).filter((question) => {
      const belongsToExam = (question.exams || []).some((exam) => exam.id === examId);
      if (!belongsToExam) return false;
      if (!normalizedQuery) return true;
      return [question.stem, question.bankName, question.externalId]
        .some((value) => String(value || "").toLowerCase().includes(normalizedQuery));
    });
  }

  function listQuestionFilters(questions, banks) {
    return {
      exams: listQuestionExams(questions).map((exam) => ({ ...exam, value: `exam:${exam.id}` })),
      banks: (banks || []).map((bank) => ({ ...bank, value: `bank:${bank.id}` }))
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
    };
  }

  function filterQuestions(questions, filterValue, query = "") {
    const normalizedQuery = String(query).trim().toLowerCase();
    const [kind, id] = String(filterValue || "").split(":", 2);
    return (questions || []).filter((question) => {
      const included = kind === "bank"
        ? question.bankId === id
        : kind === "exam" && (question.exams || []).some((exam) => exam.id === id);
      if (!included) return false;
      if (!normalizedQuery) return true;
      return [question.stem, question.bankName, question.externalId]
        .some((value) => String(value || "").toLowerCase().includes(normalizedQuery));
    });
  }

  function choiceAnswerText(type, answer) {
    if (type === "multi") return (Array.isArray(answer) ? answer : [answer]).filter(Boolean).join("|");
    return String(answer || "");
  }

  function parseChoiceAnswer(type, value) {
    if (type === "multi") {
      return [...new Set(String(value || "").split(/[|,，、\s]+/)
        .map((item) => item.trim().toUpperCase()).filter(Boolean))].sort();
    }
    return String(value || "").trim().toUpperCase();
  }

  const api = {
    choiceAnswerText,
    filterQuestions,
    filterQuestionsByExam,
    listQuestionExams,
    listQuestionFilters,
    parseChoiceAnswer
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.QuestionAdminModel = api;
}(typeof globalThis === "undefined" ? this : globalThis));
