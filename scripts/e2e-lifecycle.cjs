// End-to-end: managed (read-only) documents, pause/resume, trash/restore, unlink. Same prerequisites as e2e-full.cjs.

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
  await db.collection("projects").insertOne({ _id: pid, name: "Hệ thống E2E", description: "demo", language: "vi-VN", owner_id: A.id, members: [{ user_id: A.id, role: "owner", status: "accepted", invited_by: A.id }, { user_id: B.id, role: "editor", status: "accepted", invited_by: A.id }], status: { is_trashed: false } });
  await db.collection("versions").insertOne({ _id: vid, project_id: pid, version_major: 1, version_minor: 0, version_number: "1.0", created_by: A.id, created_at: new Date(), status: "completed", stage: "completed", progress: 100, version_temporary: true });
  const mk = (name, mod) => ({ _id: new ObjectId(), project_id: pid, version_id: vid, name, description: name, type: "use_case", status: "active", priority: "high", goal: "g", context: { module: mod }, actor: { id: "a", name: "Khách" }, main_flow: [{ step: 1, actor: "K", action: "x", expected_result: "ok" }], audit: { created_by: A.id } });
  const ucs = [mk("Đăng nhập", "Tài khoản"), mk("Đặt hàng", "Đơn hàng"), mk("Thanh toán", "Đơn hàng")];
  await db.collection("usecases").insertMany(ucs);
  const impl = async (i) => (await db.collection("usecases").findOne({ _id: ucs[i]._id })).implementation;




  const crypto = require("crypto");
  const actor = new ObjectId();
  await db.collection("usecase_diagrams").insertOne({ project_id: pid, version_id: vid, name: "Tổng quan", actors: [{ _id: actor, name: "Khách" }], usecases: [{ _id: ucs[0]._id, title: "Đăng nhập" }], associations: [], relationships: [] });
  await call(B, "POST", "/api/workhub/link", { email: `wh-${B.email}`, password: "correct-horse-battery", register: true, fullName: "Dev" });
  await call(A, "POST", "/api/workhub/link", { email: `wh-${A.email}`, password: "correct-horse-battery", register: true, fullName: "Owner" });
  const st = await until(async () => { const d = (await call(A, "GET", `/api/workhub/projects/${pid}`)).d.data; return (d.linked && Object.keys(d.items).length === 3) ? d : null; });
  ok(st, "project provisioned");
  const whProject = st.workhub.projectId;
  const conn = async (u) => (await (await fetch(WH + "/api/integrations/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `wh-${u.email}`, password: "correct-horse-battery" }) })).json());
  const exch = async (t) => (await (await fetch(WH + "/api/integrations/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: t }) })).json());
  const owner = await exch((await conn(A)).token);
  const projectStatus = async () => (await wh(owner.accessToken, "GET", `/api/projects/${whProject}`)).d.status;

  // ---------- managed documents ----------
  const docs = async () => { const r = (await wh(owner.accessToken, "GET", `/api/projects/${whProject}/documents`)).d; return r.items ?? r; };
  const srs = await until(async () => (await docs()).find((d) => d.title === "Đặc tả yêu cầu (SRS)"), 25000);
  ok(srs && srs.managed === true, "design documents created by the integration are flagged managed");
  const detail = (await wh(owner.accessToken, "GET", `/api/documents/${srs.id}`)).d;
  ok(detail.canEdit === false && detail.canDelete === false && detail.externalRef.startsWith("smartspec:design/"), "a person sees it as read-only (canEdit/canDelete false)");
  let r = await wh(owner.accessToken, "PUT", `/api/documents/${srs.id}`, { title: "hack", type: "SRS", content: "hand edit", baseVersion: detail.version });
  ok(r.s === 403, "hand-editing a managed document is refused (" + r.s + ")");
  r = await wh(owner.accessToken, "POST", `/api/documents/${srs.id}/archive`);
  ok(r.s === 403, "archiving it by hand is refused (" + r.s + ")");
  const v0 = detail.version;
  await call(A, "POST", `/api/workhub/projects/${pid}/sync`);
  ok((await wh(owner.accessToken, "GET", `/api/documents/${srs.id}`)).d.version === v0, "sync is idempotent for managed documents");
  const plain = await wh(owner.accessToken, "POST", `/api/projects/${whProject}/documents`, { title: "Ghi chú tay", type: "OTHER", content: "a" });
  ok(plain.s === 201 && plain.d.managed === false && plain.d.canEdit === true, "ordinary documents stay editable");

  // ---------- pause / resume ----------
  const issueOf = async (i) => (await db.collection("usecases").findOne({ _id: ucs[i]._id })).implementation.issue_id;
  const issueTitle = async (i) => (await wh(owner.accessToken, "GET", `/api/issues/${await issueOf(i)}`)).d.issue.title;
  r = await call(B, "PUT", `/api/workhub/projects/${pid}/paused`, { paused: true });
  ok(r.s === 403, "only the owner can pause (" + r.s + ")");
  r = await call(A, "PUT", `/api/workhub/projects/${pid}/paused`, { paused: true });
  ok(r.s === 200 && (await call(A, "GET", `/api/workhub/projects/${pid}`)).d.data.paused === true, "owner pauses syncing");
  await call(A, "PUT", `/api/usecaseManagement/versions/${vid}/usecases/${ucs[1]._id}`, { name: "Đặt hàng (đổi lúc tạm dừng)", goal: "x", context: { module: "Đơn hàng" } });
  await sleep(11000);
  ok((await issueTitle(1)) === "Đặt hàng", "while paused, spec changes do not reach WorkHub");
  await wh(owner.accessToken, "PUT", `/api/issues/${await issueOf(0)}/status`, { status: "IN_PROGRESS" });
  await sleep(2500);
  ok((await db.collection("usecases").findOne({ _id: ucs[0]._id })).implementation.status === "TO_DO", "…and WorkHub progress does not reach SmartSpec either");
  r = await call(A, "PUT", `/api/workhub/projects/${pid}/paused`, { paused: false });
  ok(await until(async () => (await issueTitle(1)) === "Đặt hàng (đổi lúc tạm dừng)", 25000), "resume: the pending spec change is applied");
  ok(await until(async () => (await db.collection("usecases").findOne({ _id: ucs[0]._id })).implementation.status === "IN_PROGRESS", 25000), "resume: pending WorkHub progress is mirrored");

  // ---------- trash / restore ----------
  const before = await projectStatus();
  r = await call(A, "DELETE", `/api/projects/${pid}`);
  ok(r.s === 200 || r.s === 204, "project moved to the SmartSpec trash (" + r.s + ")");
  ok(await until(async () => (await projectStatus()) === "ARCHIVED", 15000), "WorkHub project becomes ARCHIVED (read-only)");
  const ro = await wh(owner.accessToken, "POST", `/api/projects/${whProject}/issues`, { type: "TASK", title: "x" });
  ok(ro.s === 409, "archived WorkHub project refuses writes (" + ro.s + ")");
  r = await call(A, "POST", `/api/projects/${pid}/restore`);
  ok(r.s === 200, "restored from the trash (" + r.s + ")");
  ok(await until(async () => (await projectStatus()) === before, 15000), "WorkHub project gets its previous status back: " + before);
  await call(A, "PUT", `/api/usecaseManagement/versions/${vid}/usecases/${ucs[2]._id}`, { name: "Thanh toán (sau khôi phục)", goal: "x", context: { module: "Đơn hàng" } });
  ok(await until(async () => (await issueTitle(2)) === "Thanh toán (sau khôi phục)", 25000), "syncing continues after restore");

  // ---------- unlink ----------
  const sq = new (require("node:sqlite").DatabaseSync)("/tmp/claude-501/bridge-e2e.db");
  const row = sq.prepare("select token_enc, token_id from user_links where email = ?").get(`wh-${A.email}`);
  const key = crypto.createHash("sha256").update("dev-only-bridge-secret-change-me").digest();
  const raw = Buffer.from(row.token_enc, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12)); d.setAuthTag(raw.subarray(12, 28));
  const pat = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString();
  ok((await fetch(WH + "/api/integrations/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: pat }) })).status === 200, "the Bridge's token works before unlinking");
  r = await call(A, "DELETE", "/api/workhub/link");
  ok(r.s === 200 && r.d.data.unlinked === true, "unlink succeeds");
  ok((await call(A, "GET", "/api/workhub/status")).d.data.linked === false, "user shows as not linked");
  ok((await fetch(WH + "/api/integrations/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: pat }) })).status === 401, "the integration token was revoked in WorkHub");
  ok((await db.collection("usecases").findOne({ _id: ucs[0]._id })).implementation.issue_key, "tasks and their keys stay in SmartSpec (nothing was deleted)");
  console.log("\nAll good.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
