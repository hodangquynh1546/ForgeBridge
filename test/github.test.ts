import test from "node:test";
import assert from "node:assert/strict";
import { hmacHex } from "../src/crypto.js";
import { interpretPullRequest, keysIn, verifyGithubSignature } from "../src/github.js";

const cfg = { gitMergedStatus: "TESTING" as const };
const pr = (over: any = {}) => ({ action: "opened", ...over, pull_request: { number: 7, title: "SHOP-12 Đăng nhập", html_url: "http://x/7", head: { ref: "feature/SHOP-12-dang-nhap" }, body: "fixes ABC-3", user: { login: "an" }, draft: false, merged: false, ...over.pull_request } });

test("finds keys in branch, title and body", () => assert.deepEqual(keysIn("feature/SHOP-12-x", "SHOP-12 và ab-1", "ABC-3"), ["SHOP-12", "ABC-3"]));
test("opened PR → code review, merged → testing, draft ignored", () => {
  assert.equal(interpretPullRequest(pr(), cfg)?.status, "CODE_REVIEW");
  assert.deepEqual(interpretPullRequest(pr(), cfg)?.keys, ["SHOP-12", "ABC-3"]);
  assert.equal(interpretPullRequest(pr({ action: "closed", pull_request: { merged: true } }), cfg)?.status, "TESTING");
  assert.equal(interpretPullRequest(pr({ pull_request: { draft: true } }), cfg), null);
  assert.equal(interpretPullRequest(pr({ action: "closed" }), cfg), null);
});
test("PR without a task key is ignored", () => assert.equal(interpretPullRequest(pr({ pull_request: { title: "tweak", head: { ref: "main" }, body: "" } }), cfg), null));
test("signature check", () => {
  const body = Buffer.from("{}");
  assert.ok(verifyGithubSignature("s", body, "sha256=" + hmacHex(body, "s")));
  assert.ok(!verifyGithubSignature("s", body, "sha256=00"));
  assert.ok(!verifyGithubSignature("", body, "sha256=" + hmacHex(body, "")));
});
