const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_PATH = path.join(__dirname, "../../public/question-resources/manifest.json");
const UPLOADED_RESOURCE_URL_PATTERN = /^\/api\/question-resources\/(question_resource_[A-Za-z0-9-]+)$/;

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

function mapQuestionImages(images, resources = loadQuestionResourceManifest()) {
  if (!Array.isArray(images)) return [];
  return [...new Set(images.map((image) => {
    if (typeof image !== "string") return "";
    if (/^\/question-resources\/[A-Za-z0-9_./-]+$/.test(image) && !image.includes("..")) return image;
    if (UPLOADED_RESOURCE_URL_PATTERN.test(image)) return image;
    return resourceUrl(image, resources);
  }).filter(Boolean))];
}

function uploadedResourceId(value) {
  return String(value || "").match(UPLOADED_RESOURCE_URL_PATTERN)?.[1] || "";
}

function mapQuestionOptions(options, resources = loadQuestionResourceManifest()) {
  const normalized = Array.isArray(options)
    ? options
    : options && typeof options === "object"
      ? Object.entries(options).map(([label, text]) => ({ label, text }))
      : [];
  return normalized.map((option) => ({
    ...option,
    image: option.image
      ? ((/^\/question-resources\/[A-Za-z0-9_./-]+$/.test(option.image)
        || UPLOADED_RESOURCE_URL_PATTERN.test(option.image)) && !option.image.includes(".."))
        ? option.image
        : resourceUrl(option.image, resources)
      : ""
  }));
}

module.exports = {
  UPLOADED_RESOURCE_URL_PATTERN,
  loadQuestionResourceManifest,
  mapQuestionImages,
  mapQuestionOptions,
  resourceUrl,
  uploadedResourceId
};
