// Full end-to-end check across the 4 services (Mongo+Redis, SmartSpec :8000, WorkHub :8080 with webhook, Bridge :8090).
// Run from ForgeBridge/: node scripts/e2e-full.cjs   (see README "Bật cả hệ thống")

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

  // dev (member) links first, then owner; owner's link triggers auto provisioning + member sync
  let r = await call(B, "POST", "/api/workhub/link", { email: `wh-${B.email}`, password: "correct-horse-battery", register: true, fullName: "Dev" });
  ok(r.s === 200, "member links a WorkHub account");
  r = await call(A, "POST", "/api/workhub/link", { email: `wh-${A.email}`, password: "correct-horse-battery", register: true, fullName: "Owner" });
  ok(r.s === 200, "owner links → auto-provision queued");
  const st = await until(async () => { const d = (await call(A, "GET", `/api/workhub/projects/${pid}`)).d.data; return (d.linked && Object.keys(d.items).length === 3) ? d : null; });
  ok(st, "WorkHub workspace/team/project + 3 issues created automatically");
  const first = await until(async () => (await impl(0))?.issue_key && (await impl(0))); ok(first && first.status === "TO_DO", "implementation mirrored on use case: " + first.issue_key);

  const ownerTok = (await (await fetch(WH + "/api/integrations/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `wh-${A.email}`, password: "correct-horse-battery" }) })).json()).token;
  const exch = async (t) => (await (await fetch(WH + "/api/integrations/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: t }) })).json());
  const owner = await exch(ownerTok);
  const whProject = st.workhub.projectId;
  const members = await until(async () => { const m = (await wh(owner.accessToken, "GET", `/api/projects/${whProject}/members`)).d; return m.length === 2 && m; }, 20000);
  ok(members, "SmartSpec member was added to the WorkHub project (assignable): " + (members || []).map((m) => m.fullName).join(", "));

  // assignment is done in WorkHub; SmartSpec mirrors it
  const issueId = first.issue_id;
  const devUser = members.find((m) => m.email.startsWith("wh-dev"));
  await wh(owner.accessToken, "PUT", `/api/issues/${issueId}/assignee`, { assigneeId: devUser.userId });
  let m1 = await until(async () => (await impl(0)).assignee === "Dev" && (await impl(0)));
  ok(m1, "assignee set in WorkHub appears on the SmartSpec use case");
  await wh(owner.accessToken, "PUT", `/api/issues/${issueId}/status`, { status: "IN_PROGRESS" });
  ok(await until(async () => (await impl(0)).status === "IN_PROGRESS"), "WorkHub → IN_PROGRESS mirrored in SmartSpec");
  await wh(owner.accessToken, "PUT", `/api/issues/${issueId}/status`, { status: "DONE" });
  const done = await until(async () => (await impl(0)).status === "DONE" && (await impl(0)));
  ok(done && done.done_at, "WorkHub → DONE mirrored in SmartSpec (done_at set)");

  // SmartSpec → WorkHub
  r = await call(B, "PUT", `/api/workhub/projects/${pid}/usecases/${ucs[1]._id}/status`, { status: "TESTING" });
  ok(r.s === 200 && r.d.data.status === "TESTING", "status changed in SmartSpec returns the mirrored task");
  const wi = (await wh(owner.accessToken, "GET", `/api/issues/${(await impl(1)).issue_id}`)).d.issue;
  ok(wi.status === "TESTING", "…and WorkHub's issue really is TESTING");

  // board summary
  const board = (await call(A, "GET", `/api/workhub/projects/${pid}/board`)).d.data;
  ok(board.summary.total === 3 && board.summary.counts.DONE === 1 && board.summary.percentDone === 33, "board summary: 1/3 done = 33% (" + JSON.stringify(board.modules.map((x) => [x.name, x.percentDone])) + ")");

  // delete in WorkHub -> flagged, then recreate
  const d1 = await wh(owner.accessToken, "DELETE", `/api/issues/${(await impl(2)).issue_id}`);
  ok(d1.s === 204 || d1.s === 200, "issue deleted in WorkHub (" + d1.s + ")");
  ok(await until(async () => (await impl(2)).deleted === true), "deletion mirrored: use case shows 'task đã xoá'");
  r = await call(A, "POST", `/api/workhub/projects/${pid}/usecases/${ucs[2]._id}/recreate`);
  ok(r.s === 200 && r.d.data.issue_key && !r.d.data.deleted, "task recreated from the spec: " + r.d.data.issue_key);

  // viewer cannot change status
  const V = await mkUser("viewer");
  await db.collection("projects").updateOne({ _id: pid }, { $push: { members: { user_id: V.id, role: "viewer", status: "accepted", invited_by: A.id } } });
  r = await call(V, "PUT", `/api/workhub/projects/${pid}/usecases/${ucs[0]._id}/status`, { status: "TO_DO" });
  ok(r.s === 403, "viewer is refused (" + r.s + ")");

  // reconcile heals a missed webhook: change status behind the outbox's back via a direct DB-less path = just wait for sweep
  await wh(owner.accessToken, "PUT", `/api/issues/${issueId}/status`, { status: "TESTING" });
  ok(await until(async () => (await impl(0)).status === "TESTING"), "later change still arrives");
  console.log("\nAll good.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
