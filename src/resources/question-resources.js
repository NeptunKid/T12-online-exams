const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_PATH = path.join(__dirname, "../../public/question-resources/manifest.json");

function loadQuestionResourceManifest() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    return parsed.resources || {};
  } catch (_) {
    return {};
  }
}

function resourceUrl(resourceId, resources = loadQuestionResourceManifest()) {
  if (typeof resourceId !== "string" || !/^resource:[A-Za-z0-9_-]+$/.test(resourceId)) return "";
  const entry = resources[resourceId];
  return entry?.url || "";
}

function mapQuestionOptions(options, resources = loadQuestionResourceManifest()) {
  return (Array.isArray(options) ? options : []).map((option) => ({
    ...option,
    image: option.image ? resourceUrl(option.image, resources) : ""
  }));
}

module.exports = { loadQuestionResourceManifest, mapQuestionOptions, resourceUrl };
