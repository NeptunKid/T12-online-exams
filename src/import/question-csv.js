const CSV_HEADERS = [
  "external_id", "type", "stem", "option_a", "option_b", "option_c", "option_d", "option_e",
  "option_f", "option_g", "option_h", "option_i", "option_j",
  "option_image_a", "option_image_b", "option_image_c", "option_image_d", "option_image_e",
  "option_image_f", "option_image_g", "option_image_h", "option_image_i", "option_image_j",
  "answer", "score",
  "explanation", "tags", "difficulty", "image_urls"
];

const QUESTION_TYPES = new Set(["single", "multi", "judge", "fill", "qa"]);
const OPTION_HEADERS = ["option_a", "option_b", "option_c", "option_d", "option_e", "option_f", "option_g", "option_h", "option_i", "option_j"];
const OPTION_IMAGE_HEADERS = OPTION_HEADERS.map((header) => header.replace("option_", "option_image_"));

function parseCsv(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field === "") {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("CSV 存在未闭合的双引号");
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function issue(row, column, reason, suggestion) {
  return { row, column, reason, suggestion };
}

function trimmed(value) {
  return String(value ?? "").trim();
}

function parseImageUrls(value) {
  return trimmed(value).split("|").map((item) => item.trim()).filter(Boolean);
}

function allowedImageUrl(value, allowedImageHosts, allowedResourceIds = null) {
  if (value.startsWith("resource:")) {
    return /^resource:[A-Za-z0-9_-]+$/.test(value) && (!allowedResourceIds || allowedResourceIds.has(value));
  }
  if (/^\/(?:api\/question-resources\/question_resource_[A-Za-z0-9-]+|question-resources\/[A-Za-z0-9_./-]+)$/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && allowedImageHosts.has(url.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

function previewQuestionCsv(text, options = {}) {
  const rows = parseCsv(text);
  const errors = [];
  if (!rows.length) return { totalRows: 0, skippedRows: 0, validRows: 0, questions: [], errors: [issue(1, "file", "CSV 为空", "使用标准模板填写至少一题")] };

  const headers = rows[0].map(trimmed);
  const headerIndex = new Map(headers.map((header, index) => [header, index]));
  for (const header of CSV_HEADERS) {
    if (!headerIndex.has(header)) errors.push(issue(1, header, "缺少必需列", "从标准模板复制完整表头"));
  }
  if (errors.length) return { totalRows: Math.max(0, rows.length - 1), skippedRows: 0, validRows: 0, questions: [], errors };

  const allowedImageHosts = new Set((options.allowedImageHosts || []).map((host) => String(host).toLowerCase()));
  const allowedResourceIds = options.allowedResourceIds ? new Set(options.allowedResourceIds) : null;
  const seenExternalIds = new Set();
  const questions = [];
  let skippedRows = 0;

  rows.slice(1).forEach((rawRow, offset) => {
    const rowNumber = offset + 2;
    const values = Object.fromEntries(CSV_HEADERS.map((header) => [header, trimmed(rawRow[headerIndex.get(header)])]));
    if (Object.values(values).every((value) => !value)) {
      skippedRows += 1;
      return;
    }

    const rowErrors = [];
    if (!values.external_id) rowErrors.push(issue(rowNumber, "external_id", "题目编号不能为空", "填写题库内唯一编号，例如 extraction-001"));
    else if (seenExternalIds.has(values.external_id)) rowErrors.push(issue(rowNumber, "external_id", "题目编号重复", "在同一题库中使用唯一 external_id"));
    seenExternalIds.add(values.external_id);

    if (!QUESTION_TYPES.has(values.type)) rowErrors.push(issue(rowNumber, "type", "题型不受支持", "仅使用 single、multi、judge 或 qa"));
    if (!values.stem) rowErrors.push(issue(rowNumber, "stem", "题干不能为空", "补充完整题干"));

    const score = Number(values.score);
    if (values.score === "" || !Number.isFinite(score) || score < 0) rowErrors.push(issue(rowNumber, "score", "分数必须是非负数字", "填写 0、2、2.5 等数值"));

    const optionValues = OPTION_HEADERS.map((header) => values[header]);
    const optionImageValues = OPTION_IMAGE_HEADERS.map((header) => values[header]);
    const lastOption = Math.max(optionValues.map(Boolean).lastIndexOf(true), optionImageValues.map(Boolean).lastIndexOf(true));
    const options = lastOption < 0 ? [] : optionValues.slice(0, lastOption + 1).map((label, index) => ({ label: String.fromCharCode(65 + index), text: label }));
    if (lastOption >= 0 && optionValues.slice(0, lastOption + 1).some((value, index) => !value && !optionImageValues[index])) {
      rowErrors.push(issue(rowNumber, "option_a", "选项字母必须连续", "从 A 开始连续填写，不要跳过空选项"));
    }

    const answerParts = values.answer.split("|").map((value) => value.trim()).filter(Boolean);
    const labels = new Set(options.map((option) => option.label));
    if (["single", "judge"].includes(values.type)) {
      if (!options.length) rowErrors.push(issue(rowNumber, "option_a", "该题型必须提供选项", "至少填写 option_a"));
      if (answerParts.length !== 1) rowErrors.push(issue(rowNumber, "answer", "单选或判断题必须有一个答案", "填写一个选项字母，例如 A"));
    }
    if (values.type === "multi") {
      if (!options.length) rowErrors.push(issue(rowNumber, "option_a", "多选题必须提供选项", "至少填写 option_a 和 option_b"));
      if (!answerParts.length) rowErrors.push(issue(rowNumber, "answer", "多选题必须有答案", "用 | 分隔选项字母，例如 A|C"));
    }
    if (["fill", "qa"].includes(values.type) && options.length) rowErrors.push(issue(rowNumber, "option_a", `${values.type === "fill" ? "填空题" : "问答题"}不应包含选项`, "清空 option_a 至 option_f"));
    // 问答题的 answer 是供阅卷人使用的参考答案，不参与自动判分。
    if (values.type === "fill" && answerParts.length === 0) rowErrors.push(issue(rowNumber, "answer", "填空题至少需要一个标准答案", "多个可接受答案用 | 分隔，例如 浓缩咖啡|espresso"));
    if (["single", "multi", "judge"].includes(values.type)) {
      for (const answer of answerParts) {
        if (!labels.has(answer)) rowErrors.push(issue(rowNumber, "answer", `答案 ${answer} 不在选项中`, "确保答案字母存在且使用大写字母"));
      }
    }

    const imageUrls = parseImageUrls(values.image_urls);
    for (const imageUrl of imageUrls) {
      if (!allowedImageUrl(imageUrl, allowedImageHosts, allowedResourceIds)) {
        rowErrors.push(issue(rowNumber, "image_urls", "图片地址不在允许范围", "使用已允许的 HTTPS 域名，或使用 resource:<资源ID>"));
      }
    }
    const optionImages = {};
    OPTION_IMAGE_HEADERS.forEach((header, index) => {
      const value = values[header];
      if (!value) return;
      if (!allowedImageUrl(value, allowedImageHosts, allowedResourceIds)
          || (!value.startsWith("resource:") && !/^\/(?:api\/question-resources\/question_resource_[A-Za-z0-9-]+|question-resources\/[A-Za-z0-9_./-]+)$/.test(value))) {
        rowErrors.push(issue(rowNumber, header, "选项图片必须使用已登记的 resource:<资源ID>", "填写资源清单中的受控资源 ID"));
        return;
      }
      if (index >= options.length) {
        rowErrors.push(issue(rowNumber, header, "选项图片没有对应的文字选项", "先填写对应的 option_a 至 option_j"));
        return;
      }
      optionImages[String.fromCharCode(65 + index)] = value;
    });

    errors.push(...rowErrors);
    if (rowErrors.length) return;
    questions.push({
      externalId: values.external_id,
      type: values.type,
      stem: values.stem,
      options,
      answer: ["multi", "fill"].includes(values.type) ? answerParts : values.type === "qa" ? (values.answer || null) : answerParts[0],
      score,
      explanation: values.explanation,
      tags: values.tags.split("|").map((value) => value.trim()).filter(Boolean),
      difficulty: values.difficulty,
      imageUrls,
      optionImages
    });
  });

  return {
    totalRows: Math.max(0, rows.length - 1),
    skippedRows,
    validRows: questions.length,
    questions,
    errors,
    canCommit: errors.length === 0 && questions.length > 0
  };
}

module.exports = { CSV_HEADERS, parseCsv, previewQuestionCsv };
