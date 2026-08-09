(function initializeQuestionFormat(root) {
  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatQuestionText(value) {
    return escapeHtml(value).replace(
      /【\s*】/g,
      '<span class="blank-placeholder" role="img" aria-label="填空位置">&nbsp;</span>'
    );
  }

  const api = { escapeHtml, formatQuestionText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.QuestionFormat = api;
}(typeof globalThis === "undefined" ? this : globalThis));
