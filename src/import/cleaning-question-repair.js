function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.entries(value).map(([label, text]) => ({ label, text }));
  return [];
}

function isEmptyAnswer(value) {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

function cleaningResources(question, resources) {
  const prefix = `resource:cleaning-${question.imageNo}-`;
  const ids = Object.keys(resources || {}).filter((id) => id.startsWith(prefix));
  const stem = ids.filter((id) => /^resource:cleaning-\d+-\d+$/.test(id))
    .sort((left, right) => Number(left.split("-").at(-1)) - Number(right.split("-").at(-1)));
  const options = Object.fromEntries(ids.filter((id) => /^resource:cleaning-\d+-[a-j]$/.test(id))
    .sort()
    .map((id) => [id.split("-").at(-1).toUpperCase(), id]));
  return { stem, options };
}

function mergeOptionImages(options, optionImages) {
  const existing = asArray(options).map((option) => ({
    label: String(option.label || "").trim().toUpperCase(),
    text: String(option.text || ""),
    ...(option.image ? { image: option.image } : {})
  })).filter((option) => option.label);
  const byLabel = new Map(existing.map((option) => [option.label, option]));
  for (const [label, image] of Object.entries(optionImages)) {
    const prior = byLabel.get(label);
    byLabel.set(label, { ...(prior || { label, text: "" }), ...(prior?.image ? {} : { image }) });
  }
  return [...byLabel.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function buildCleaningPatch(existing, source, resources) {
  const patch = {};
  if (!String(existing.stem || "").trim()) patch.stem = source.stem;

  const existingOptions = asArray(existing.optionsJson);
  const resourceImages = cleaningResources(source, resources);
  if (!existingOptions.length && source.options.length) patch.optionsJson = source.options;
  if (!existingOptions.length && Object.keys(resourceImages.options).length) {
    patch.optionsJson = mergeOptionImages(patch.optionsJson || source.options, resourceImages.options);
  } else if (existingOptions.length && Object.keys(resourceImages.options).length) {
    const merged = mergeOptionImages(existingOptions, resourceImages.options);
    if (JSON.stringify(merged) !== JSON.stringify(existingOptions)) patch.optionsJson = merged;
  }
  if (isEmptyAnswer(existing.answerJson) && !isEmptyAnswer(source.answer)) patch.answerJson = source.answer;
  if (!String(existing.explanation || "").trim() && String(source.explanation || "").trim()) {
    patch.explanation = source.explanation;
  }
  if (!asArray(existing.imagesJson).length && resourceImages.stem.length) patch.imagesJson = resourceImages.stem;
  return patch;
}

function validateCleaningRows(rows, source) {
  if (!Array.isArray(rows) || rows.length !== source.questions.length) {
    throw new Error(`清洁卫生考试题目数不一致：数据库 ${rows?.length || 0} 题，来源 ${source.questions.length} 题`);
  }
  const sourceIds = new Set(source.questions.map((question) => String(question.legacyExternalId)));
  const rowIds = rows.map((row) => String(row.external_id || ""));
  if (new Set(rowIds).size !== rows.length || rowIds.some((id) => !sourceIds.has(id))) {
    throw new Error("清洁卫生考试题目历史标识不匹配，拒绝修复");
  }
}

module.exports = { asArray, buildCleaningPatch, cleaningResources, isEmptyAnswer, mergeOptionImages, validateCleaningRows };
