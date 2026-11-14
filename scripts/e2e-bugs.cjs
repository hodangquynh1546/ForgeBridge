// End-to-end: failed test case -> Bug (reopen/comment), member removal, robustness. Same prerequisites as e2e-full.cjs.

const R = "../../SmartSpec/backend/node_modules/";
const { MongoClient, ObjectId } = require(R + "mongodb");
const jwt = require(R + "jsonwebtoken");
const API = "http://localhost:8000", WH = "http://localhost:8080";
const ok = (c, m) => { if (!c) { console.error("✗ " + m); process.exit(1); } console.log("✓ " + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return null; await sleep(400); } };
(async () => {
  const db = (await MongoClient.connect("mongodb://localhost:27017/smartspec_e2e?directConnection=true")).db();
  const mkUser = async (n) => { const id = new ObjectId(); const email = `${n}-${id.toString().slice(-5)}@example.com`; await db.collection("users").insertOne({ _id: id, email, name: n, status: "ACTIVE" }); return { id, email, H: { Authorization: "Bearer " + jwt.sign({ sub: String(id) }, "secret_jwt_access_key", { expiresIn: "1h" }), "Content-Type": "application/json" } }; };
  const call = async (u, m, p, b) => { const r = await fetch(API + p, { method: m, headers: u.H, body: b && JSON.stringify(b) }); const t = await r.text(); let d; try { d = JSON.parse(t) } catch { d = t } return { s: r.status, d }; };
  const wh = async (tok, m, p, b) => { const r = await fetch(WH + p, { method: m, headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: b && JSON.stringify(b) }); const t = await r.text(); return { s: r.status, d: t ? JSON.parse(t) : null }; };
  const A = await mkUser("owner"), B = await mkUser("dev");
  const pid = new ObjectId(), vid = new ObjectId();
  await db.collection("projects").insertOne({ _id: pid, name: "Hệ thống E2E", description: "demo", language: "vi-VN", owner_id: A.id, members: [{ user_id: B.id, role: "editor", status: "accepted", invited_by: A.id }], status: { is_trashed: false } });
  await db.collection("versions").insertOne({ _id: vid, project_id: pid, version_major: 1, version_minor: 0, version_number: "1.0", created_by: A.id, created_at: new Date(), status: "completed", stage: "completed", progress: 100, version_temporary: true });
  const mk = (name, mod) => ({ _id: new ObjectId(), project_id: pid, version_id: vid, name, description: name, type: "use_case", status: "active", priority: "high", goal: "g", context: { module: mod }, actor: { id: "a", name: "Khách" }, main_flow: [{ step: 1, actor: "K", action: "x", expected_result: "ok" }], audit: { created_by: A.id } });
  const ucs = [mk("Đăng nhập", "Tài khoản"), mk("Đặt hàng", "Đơn hàng"), mk("Thanh toán", "Đơn hàng")];
  await db.collection("usecases").insertMany(ucs);
  const impl = async (i) => (await db.collection("usecases").findOne({ _id: ucs[i]._id })).implementation;


  await call(B, "POST", "/api/workhub/link", { email: `wh-${B.email}`, password: "correct-horse-battery", register: true, fullName: "Dev" });
  await call(A, "POST", "/api/workhub/link", { email: `wh-${A.email}`, password: "correct-horse-battery", register: true, fullName: "Owner" });
  const st = await until(async () => { const d = (await call(A, "GET", `/api/workhub/projects/${pid}`)).d.data; return (d.linked && Object.keys(d.items).length === 3) ? d : null; });
  ok(st, "project provisioned in WorkHub");
  const tokOf = async (u) => (await (await fetch(WH + "/api/integrations/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `wh-${u.email}`, password: "correct-horse-battery" }) })).json()).token;
  const exch = async (t) => (await (await fetch(WH + "/api/integrations/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: t }) })).json());
  const owner = await exch(await tokOf(A));
  const whProject = st.workhub.projectId;
  const members = async () => (await wh(owner.accessToken, "GET", `/api/projects/${whProject}/members`)).d;
  ok(await until(async () => (await members()).length === 2), "member synced to WorkHub");

  // ---- test case -> bug ----
  const tcId = new ObjectId();
  await db.collection("testcases").insertOne({ _id: tcId, project_id: pid, version_id: vid, title: "Đăng nhập sai mật khẩu", description: "Kiểm tra khoá tài khoản", test_type: "integration", status: "not_executed", severity: "major", priority: "high", source_requirement_ids: [String(ucs[0]._id)], steps: [{ step_number: 1, action: "Nhập sai mật khẩu 5 lần", expected_immediate_result: "Tài khoản bị khoá" }], expected_results: { business_level: "Khoá 15 phút" } });
  const tc = async () => db.collection("testcases").findOne({ _id: tcId });
  let r = await call(A, "PUT", `/api/testcases/testcases/${tcId}/execute`, { status: "failed", actual_result: "Server trả 500" });
  ok(r.s === 200, "test case executed as failed (" + r.s + ")");
  const bug = await until(async () => (await tc()).bug?.issue_key && (await tc()).bug);
  ok(bug, "failed test case → bug created: " + (bug && bug.issue_key));
  const bi = (await wh(owner.accessToken, "GET", `/api/issues/${bug.issue_id}`)).d.issue;
  ok(bi.type === "BUG" && bi.priority === "HIGH" && bi.externalRef.startsWith("smartspec:testcase/") && bi.parent?.title === "Tài khoản", "bug is BUG/HIGH, linked to the use case's module epic, description has steps: " + (bi.description.includes("Nhập sai mật khẩu") && bi.description.includes("Server trả 500")));
  const cm = async () => (await wh(owner.accessToken, "GET", `/api/issues/${bug.issue_id}/comments`)).d.length;
  const c0 = await cm();
  await call(A, "PUT", `/api/testcases/testcases/${tcId}/execute`, { status: "failed", actual_result: "vẫn 500" });
  ok(await until(async () => (await cm()) > c0), "second failure comments on the same bug instead of duplicating");
  ok((await db.collection("testcases").countDocuments({ project_id: pid, "bug.issue_key": bug.issue_key })) === 1, "still one bug");

  await wh(owner.accessToken, "PUT", `/api/issues/${bug.issue_id}/status`, { status: "DONE" });
  ok(await until(async () => (await tc()).bug.status === "DONE"), "bug DONE in WorkHub mirrored on the test case");
  await call(A, "PUT", `/api/testcases/testcases/${tcId}/execute`, { status: "failed", actual_result: "lại lỗi" });
  ok(await until(async () => (await tc()).bug.status === "TO_DO"), "failing again reopens the DONE bug");
  const c1 = await cm();
  await call(A, "PUT", `/api/testcases/testcases/${tcId}/execute`, { status: "passed", actual_result: "ok" });
  ok(await until(async () => (await cm()) > c1), "pass is noted on the bug (comment added)");

  // board shows the open bug on its use case
  const board = (await call(A, "GET", `/api/workhub/projects/${pid}/board`)).d.data;
  ok(board.items.find((i) => i.name === "Đăng nhập").bugs.length === 1, "board lists the bug under its use case");

  // ---- robustness: a newer empty completed version must not hide the spec ----
  await db.collection("versions").insertOne({ _id: new ObjectId(), project_id: pid, version_major: 2, version_minor: 0, version_number: "2.0", created_by: A.id, created_at: new Date(Date.now() + 60000), status: "completed", stage: "completed", progress: 100, version_temporary: true });
  const b2 = (await call(A, "GET", `/api/workhub/projects/${pid}/board`)).d.data;
  ok(b2.summary.total === 3, "empty newer version does not hide the use cases");

  // ---- member removal ----
  const extra = await mkUser("manual");
  const extraTok = await exch(await (async () => { const rr = await (await fetch(WH + "/api/integrations/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `wh-manual-${extra.email}`, password: "correct-horse-battery", register: true, fullName: "Manual" }) })).json(); return rr.token; })());
  const inv = await wh(owner.accessToken, "POST", `/api/projects/${whProject}/invitations`, { kind: "EMAIL", email: `wh-manual-${extra.email}`, role: "DEVELOPER" });
  await wh(extraTok.accessToken, "POST", `/api/me/invitations/${inv.d.invitation.id}/accept`);
  ok((await members()).length === 3, "a member added by hand in WorkHub exists");
  await db.collection("projects").updateOne({ _id: pid }, { $pull: { members: { user_id: B.id } } });
  await call(A, "PUT", `/api/usecaseManagement/versions/${vid}/usecases/${ucs[1]._id}`, { name: "Đặt hàng (sửa)", goal: "x", context: { module: "Đơn hàng" } });
  ok(await until(async () => { const m = await members(); return m.length === 2 && !m.some((x) => x.email.startsWith("wh-dev")); }, 25000), "member who left SmartSpec was removed from WorkHub");
  ok((await members()).some((x) => x.email.startsWith("wh-manual")), "…while the member added by hand stays");
  console.log("\nAll good.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
