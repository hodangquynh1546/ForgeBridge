import test from "node:test";
import assert from "node:assert/strict";
import { contentHash, moduleSlug, projectKey, toIssueContent } from "../src/mapper.js";

const uc = { key: "k", name: "Đăng nhập", priority: "high" as const, goal: "Vào hệ thống", context: { module: "Tài khoản" }, main_flow: [{ step: 1, actor: "Khách", action: "Nhập email", expected_result: "Form hợp lệ" }], rules: [{ id: "R1", description: "Khoá sau 5 lần sai" }] };

test("maps priority, type and acceptance criteria", () => {
  const c = toIssueContent(uc);
  assert.equal(c.priority, "HIGH");
  assert.equal(c.type, "USER_STORY");
  assert.match(c.acceptanceCriteria, /Bước 1: Form hợp lệ/);
  assert.match(c.acceptanceCriteria, /R1: Khoá sau 5 lần sai/);
});
test("hash changes with content, not with key", () => {
  const a = contentHash(toIssueContent(uc));
  assert.equal(a, contentHash(toIssueContent({ ...uc, key: "other" })));
  assert.notEqual(a, contentHash(toIssueContent({ ...uc, goal: "khác" })));
});
test("project key is 2-10 alphanumerics starting with a letter", () => {
  for (const n of ["Shop Online", "Cửa hàng", "123 abc", "X", "Hệ thống quản lý bán hàng trực tuyến"]) {
    assert.match(projectKey(n), /^[A-Z][A-Z0-9]{1,9}$/, n);
  }
  assert.equal(projectKey("Shop Online"), "SO");
});
test("module slug strips accents", () => assert.equal(moduleSlug("Đơn hàng"), "don-hang"));
test("long text is clipped to WorkHub limits", () => {
  const c = toIssueContent({ ...uc, description: "x".repeat(20000), name: "n".repeat(400) });
  assert.ok(c.description.length <= 10000 && c.title.length <= 255);
});
