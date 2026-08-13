(function initializeQuestionAdminModel(root) {
  function listQuestionFilters(_questions, banks) {
    return {
      banks: (banks || []).map((bank) => ({ ...bank, value: `bank:${bank.id}` }))
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
    };
  }

  function filterQuestions(questions, filterValue, query = "") {
    const normalizedQuery = String(query).trim().toLowerCase();
    const [kind, id] = String(filterValue || "").split(":", 2);
    return (questions || []).filter((question) => {
      const included = kind === "bank" && question.bankId === id;
      if (!included) return false;
      if (!normalizedQuery) return true;
      return [question.stem, question.bankName, question.externalId]
        .some((value) => String(value || "").toLowerCase().includes(normalizedQuery));
    });
  }

  function choiceAnswerText(type, answer) {
    if (type === "judge") return String(answer || "A").trim().toUpperCase() === "B" ? "B" : "A";
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

  function parseJudgeAnswer(value) {
    const normalized = String(value ?? "").trim().toLocaleLowerCase();
    if (["a", "true", "yes", "1", "正确", "对"].includes(normalized)) return "A";
    if (["b", "false", "no", "0", "错误", "错"].includes(normalized)) return "B";
    return String(value ?? "").trim().toUpperCase();
  }

  function judgeAnswerText(answer) {
    const normalized = parseJudgeAnswer(answer);
    if (normalized === "A") return "正确";
    if (normalized === "B") return "错误";
    return String(answer ?? "").trim();
  }

  function normalizeFillRule(answer) {
    if (answer && typeof answer === "object" && !Array.isArray(answer)) {
      const blanks = Array.isArray(answer.blanks) ? answer.blanks : [];
      return {
        ordered: answer.ordered !== false,
        blanks: blanks.map((blank) => (Array.isArray(blank) ? blank : [blank]).map((item) => String(item || "").trim()).filter(Boolean))
      };
    }
    const aliases = Array.isArray(answer) ? answer : [answer];
    return { ordered: true, blanks: [aliases.map((item) => String(item || "").trim()).filter(Boolean)] };
  }

  function fillRuleText(answer) {
    return normalizeFillRule(answer).blanks.map((blank) => blank.join("|")).join("\n");
  }

  function parseFillRuleText(value, ordered = true) {
    if (value && typeof value === "object") return normalizeFillRule(value);
    const lines = String(value ?? "").split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      ordered: ordered !== false,
      blanks: lines.map((line) => [...new Set(line.split(/[|｜]/)
        .map((item) => item.trim()).filter(Boolean))])
    };
  }

  const parseFillAnswer = parseFillRuleText;

  const api = {
    choiceAnswerText,
    fillRuleText,
    filterQuestions,
    judgeAnswerText,
    listQuestionFilters,
    parseChoiceAnswer,
    parseFillAnswer,
    parseFillRuleText,
    parseJudgeAnswer,
    normalizeFillRule,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.QuestionAdminModel = api;
}(typeof globalThis === "undefined" ? this : globalThis));
