const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadQuestionResourceManifest, mapQuestionImages, mapQuestionOptions, resourceUrl } = require("../src/resources/question-resources");

test("历史对象格式选项可转换为统一选项数组", () => {
  assert.deepEqual(mapQuestionOptions({ A: "选项 A", B: "选项 B" }, {}), [
    { label: "A", text: "选项 A", image: "" },
    { label: "B", text: "选项 B", image: "" }
  ]);
});

test("答卷快照中已解析的受控图片地址保持可用", () => {
  assert.equal(mapQuestionOptions([
    { label: "A", text: "图片选项", image: "/question-resources/extraction/extraction-17-a.png" }
  ], {})[0].image, "/question-resources/extraction/extraction-17-a.png");
});

test("数据库上传的题目图片 URL 保持为受控 API 路径", () => {
  assert.deepEqual(mapQuestionImages([
    "/api/question-resources/question_resource_123",
    "/api/question-resources/invalid"
  ]), ["/api/question-resources/question_resource_123"]);
});

test("萃取原理图表资源清单包含 17/18 题全部受控图片", () => {
  const resources = loadQuestionResourceManifest();
  assert.equal(Object.keys(resources).filter((id) => id.startsWith("resource:extraction-")).length, 9);
  for (const questionNo of [17, 18]) {
    const count = questionNo === 17 ? 4 : 5;
    for (let index = 0; index < count; index += 1) {
      const id = `resource:extraction-${questionNo}-${String.fromCharCode(97 + index)}`;
      assert.match(resourceUrl(id, resources), new RegExp(`^/question-resources/extraction/extraction-${questionNo}-[a-e]\\.png$`));
      const file = path.join(__dirname, "../public", resourceUrl(id, resources).replace(/^\//, ""));
      const sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      assert.equal(resources[id].sha256, sha);
    }
  }
});

test("咖啡题库的果实结构图和虹吸壶图片使用受控资源", () => {
  const resources = loadQuestionResourceManifest();
  const ids = ["resource:coffee-cherry-structure", "resource:coffee-siphon"];
  assert.deepEqual(mapQuestionImages(ids, resources), [
    "/question-resources/coffee/coffee-cherry-structure.jpeg",
    "/question-resources/coffee/coffee-siphon.jpeg"
  ]);
  for (const id of ids) {
    const file = path.join(__dirname, "../public", resourceUrl(id, resources).replace(/^\//, ""));
    const sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    assert.equal(resources[id].sha256, sha);
  }
});
