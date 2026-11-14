// End-to-end: design artifacts -> WorkHub documents (Mermaid, ERD+DDL, links, archive), IDE design API, bug status from a test case.

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



  const oid = () => new ObjectId();
  const actor = oid(), uc1 = ucs[0]._id, uc2 = ucs[1]._id;
  await db.collection("usecase_diagrams").insertOne({ project_id: pid, version_id: vid, name: "Tổng quan hệ thống", actors: [{ _id: actor, name: "Khách" }], usecases: [{ _id: uc1, title: "Đăng nhập" }, { _id: uc2, title: "Đặt hàng" }], associations: [{ actor_id: actor, usecase_id: uc1 }], relationships: [{ source: uc2, target: uc1, type: "include" }] });
  const n1 = oid(), n2 = oid(), n3 = oid();
  await db.collection("activity_diagrams").insertOne({ project_id: pid, version_id: vid, name: "Luồng Đăng nhập", lanes: [], nodes: [{ _id: n1, type: "start" }, { _id: n2, type: "action", label: "Nhập email" }, { _id: n3, type: "end" }], edges: [{ from: n1, to: n2 }, { from: n2, to: n3 }] });
  const l1 = oid(), l2 = oid(), f1 = oid();
  const seq = await db.collection("sequence_diagrams").insertOne({ project_id: pid, version_id: vid, name: "Kịch bản Đặt hàng", usecase_ref_id: String(uc2), lifelines: [{ _id: l1, name: "Khách" }, { _id: l2, name: "Server" }], fragments: [{ _id: f1, type: "opt", guard_condition: "Có mã giảm giá" }], messages: [{ source_lifeline_id: l1, target_lifeline_id: l2, order: 1, content: "đặtHàng()", type: "sync" }, { source_lifeline_id: l2, target_lifeline_id: l1, order: 2, content: "ok", type: "reply", fragment_id: f1 }] });
  await db.collection("databases").insertOne({ project_id: pid, version_id: vid, name: "Shop DB", tables: [{ name: "users", columns: [{ name: "id", type: "uuid", is_primary_key: true, nullable: false, related_usecase_ids: [String(uc1)] }] }, { name: "orders", columns: [{ name: "id", type: "uuid", is_primary_key: true, nullable: false }, { name: "user_id", type: "uuid", is_foreign_key: true, references: "users.id" }] }], relationships: [{ from_table: "users", to_table: "orders", type: "one-to-many" }] });
  const tcId = oid();
  await db.collection("testcases").insertOne({ _id: tcId, project_id: pid, version_id: vid, title: "Đăng nhập sai mật khẩu", test_type: "integration", status: "not_executed", severity: "major", priority: "high", source_requirement_ids: [String(uc1)], steps: [{ step_number: 1, action: "x", expected_immediate_result: "y" }] });

  await call(B, "POST", "/api/workhub/link", { email: `wh-${B.email}`, password: "correct-horse-battery", register: true, fullName: "Dev" });
  await call(A, "POST", "/api/workhub/link", { email: `wh-${A.email}`, password: "correct-horse-battery", register: true, fullName: "Owner" });
  const st = await until(async () => { const d = (await call(A, "GET", `/api/workhub/projects/${pid}`)).d.data; return (d.linked && Object.keys(d.items).length === 3) ? d : null; });
  ok(st, "project provisioned");
  const exch = async (t) => (await (await fetch(WH + "/api/integrations/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: t }) })).json());
  const conn = async (u) => (await (await fetch(WH + "/api/integrations/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `wh-${u.email}`, password: "correct-horse-battery" }) })).json()).token;
  const ownerPat = await conn(A); const owner = await exch(ownerPat);
  const whProject = st.workhub.projectId;
  const docs = async () => (await wh(owner.accessToken, "GET", `/api/projects/${whProject}/documents`)).d.items ?? (await wh(owner.accessToken, "GET", `/api/projects/${whProject}/documents`)).d;
  const wanted = ["Đặc tả yêu cầu (SRS)", "Use case diagram: Tổng quan hệ thống", "Activity diagram: Luồng Đăng nhập", "Sequence diagram: Kịch bản Đặt hàng", "Thiết kế CSDL: Shop DB", "Kế hoạch & kết quả kiểm thử"];
  const got = await until(async () => { const d = await docs(); return wanted.every((t) => d.some((x) => x.title === t)) ? d : null; }, 25000);
  ok(got, "6 design documents created in WorkHub: " + (got || await docs()).map((d) => d.title).join(" | "));
  const folders = (await wh(owner.accessToken, "GET", `/api/projects/${whProject}/document-folders`)).d.map((f) => f.name);
  ok(["SmartSpec", "Sơ đồ", "Use case", "Activity", "Sequence", "Cơ sở dữ liệu", "Kiểm thử"].every((n) => folders.includes(n)), "folder tree created: " + folders.join(", "));
  const byTitle = (t) => got.find((d) => d.title === t);
  const seqDoc = (await wh(owner.accessToken, "GET", `/api/documents/${byTitle("Sequence diagram: Kịch bản Đặt hàng").id}`)).d;
  ok(seqDoc.content.includes("sequenceDiagram") && seqDoc.content.includes("opt Có mã giảm giá") && seqDoc.content.includes("P0->>P1: đặtHàng()"), "sequence diagram is valid Mermaid with its opt fragment");
  ok(seqDoc.links.some((l) => l.targetType === "ISSUE"), "sequence document linked to the task of its use case");
  const erd = (await wh(owner.accessToken, "GET", `/api/documents/${byTitle("Thiết kế CSDL: Shop DB").id}`)).d;
  ok(erd.content.includes("erDiagram") && erd.content.includes("users ||--o{ orders") && /CREATE TABLE/i.test(erd.content), "ERD document has erDiagram, relationship and PostgreSQL DDL");
  ok(erd.links.length >= 1, "ERD linked to the use case whose column references it");

  // idempotent: another sync changes nothing
  const v0 = (await wh(owner.accessToken, "GET", `/api/documents/${byTitle("Thiết kế CSDL: Shop DB").id}`)).d.version;
  await call(A, "POST", `/api/workhub/projects/${pid}/sync`);
  ok((await wh(owner.accessToken, "GET", `/api/documents/${byTitle("Thiết kế CSDL: Shop DB").id}`)).d.version === v0, "re-sync creates no new document version");

  // editing the design in SmartSpec (any code path) updates the document through the model hook
  await db.collection("databases").updateOne({ project_id: pid }, { $push: { tables: { name: "payments", columns: [{ name: "id", type: "uuid", is_primary_key: true }] } } });
  await call(A, "POST", `/api/workhub/projects/${pid}/sync`);
  const up = await until(async () => (await wh(owner.accessToken, "GET", `/api/documents/${byTitle("Thiết kế CSDL: Shop DB").id}`)).d.content.includes("payments") && 1, 25000);
  ok(up, "a changed design updates the ERD document (new version)");

  // removing an artifact archives (never deletes) its document
  await db.collection("activity_diagrams").deleteMany({ project_id: pid });
  await call(A, "POST", `/api/workhub/projects/${pid}/sync`);
  const arch = await until(async () => (await wh(owner.accessToken, "GET", `/api/documents/${byTitle("Activity diagram: Luồng Đăng nhập").id}`)).d.status === "ARCHIVED" && 1, 25000);
  ok(arch, "diagram deleted in SmartSpec → WorkHub document archived, not deleted");

  // IDE design endpoint
  const taskKey = st.items[String(uc1)] ? null : null;
  const impl0 = (await db.collection("usecases").findOne({ _id: uc1 })).implementation;
  const designRes = await (await fetch("http://localhost:8090/ide/issues/" + impl0.issue_key + "/design", { headers: { Authorization: "Bearer " + ownerPat } })).json();
  ok(designRes.documents.some((d) => d.scope === "use-case") && designRes.documents.some((d) => d.key === "srs") && designRes.documents.every((d) => d.content), "IDE design endpoint returns the use-case + project documents with content (" + designRes.documents.map((d) => d.key).join(", ") + ")");

  // bug status from the test case
  await call(A, "PUT", `/api/testcases/testcases/${tcId}/execute`, { status: "failed", actual_result: "500" });
  const bug = await until(async () => (await db.collection("testcases").findOne({ _id: tcId })).bug?.issue_key && (await db.collection("testcases").findOne({ _id: tcId })).bug);
  ok(bug, "failed test → bug " + (bug && bug.issue_key));
  const plan = await until(async () => { const c = (await wh(owner.accessToken, "GET", `/api/documents/${byTitle("Kế hoạch & kết quả kiểm thử").id}`)).d.content; return c.includes("lỗi **1**") && c.includes(bug.issue_key) && 1; }, 25000);
  ok(plan, "model hook: executing a test through the app refreshed the test plan document (failed count + bug key)");
  let r = await call(B, "PUT", `/api/workhub/projects/${pid}/testcases/${tcId}/bug-status`, { status: "IN_PROGRESS" });
  ok(r.s === 200 && r.d.data.status === "IN_PROGRESS", "bug moved to IN_PROGRESS from the test case (" + r.s + ")");
  const wi = (await wh(owner.accessToken, "GET", `/api/issues/${bug.issue_id}`)).d.issue;
  ok(wi.status === "IN_PROGRESS", "…WorkHub's bug really is IN_PROGRESS");
  r = await call(A, "PUT", `/api/workhub/projects/${pid}/testcases/${tcId}/bug-status`, { status: "NOPE" });
  ok(r.s === 400, "invalid status refused");
  const V = await mkUser("viewer");
  await db.collection("projects").updateOne({ _id: pid }, { $push: { members: { user_id: V.id, role: "viewer", status: "accepted", invited_by: A.id } } });
  r = await call(V, "PUT", `/api/workhub/projects/${pid}/testcases/${tcId}/bug-status`, { status: "DONE" });
  ok(r.s === 403, "viewer cannot change the bug (" + r.s + ")");
  console.log("\nAll good.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
