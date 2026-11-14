// Use cases created/edited in WorkHub appear/update in SmartSpec; members removed in WorkHub leave the SmartSpec project.
const SS = "http://localhost:8000", WH = "http://localhost:8080";
const A = { e: "hodangquynh1546@gmail.com", p: "15102004Quynh@" }, B = { e: "hodangquynh1504@gmail.com", p: "15102004Quynh@" };
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("✓", m)) : (fail++, console.log("✗", m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const until = async (fn, ms = 90000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(2000); } return null; };
const post = (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(j);
(async () => {
  const ss = (await post(SS + "/api/auth/login", { email: A.e, password: A.p })).data.accessToken;
  const ssB = (await post(SS + "/api/auth/login", { email: B.e, password: B.p })).data.accessToken;
  const wh = (await post(WH + "/api/auth/login", { email: A.e, password: A.p })).accessToken;
  const S = (m, p, b, t = ss) => fetch(SS + p, { method: m, headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then(j);
  const W = (m, p, b) => fetch(WH + p, { method: m, headers: { Authorization: "Bearer " + wh, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then(j);
  const tag = Date.now().toString(36);
  const fd = new FormData(); fd.append("name", "E2E inbound " + tag); fd.append("description", "x"); fd.append("language", "vi-VN");
  const created = (await (await fetch(SS + "/api/projects", { method: "POST", headers: { Authorization: "Bearer " + ss }, body: fd })).json()).data;
  const pid = created._id;
  const curVersion = async () => { const d = (await S("GET", `/api/projects/${pid}`)).data; return (d.project ?? d).current_version; };
  const ucs = async () => { const r = await S("GET", `/api/usecaseManagement/versions/${await curVersion()}/usecases`); return r.data ?? []; };
  await S("POST", `/api/import/versions/${await curVersion()}/usecases`, { usecases: [{ name: "Từ SmartSpec", goal: "g", actor: "Khách", main_flow: [{ step: 1, actor: "Khách", action: "bấm", expected_result: "ok" }] }] });
  const link = await until(async () => { const r = await S("GET", `/api/workhub/projects/${pid}`); return r.data?.linked && Object.keys(r.data.items ?? {}).length >= 1 ? r.data : null; });
  ok(link, "SmartSpec use case becomes a WorkHub story");
  const whId = link.workhub.projectId;

  // 1. story created in WorkHub → use case in SmartSpec
  const story = await W("POST", `/api/projects/${whId}/issues`, {
    type: "USER_STORY", title: "Tạo ở WorkHub " + tag, priority: "HIGH",
    description: "Mô tả tự do của người dùng\n\n**Mục tiêu:** Đạt được X\n\n**Luồng chính**\n1. Khách: Bấm nút\n2. Hệ thống: Trả lời",
    acceptanceCriteria: "- [ ] Bước 1: thấy form",
  });
  ok(story.id, "story created in WorkHub");
  const found = await until(async () => (await ucs()).find((u) => u.name === "Tạo ở WorkHub " + tag));
  ok(found, "story created in WorkHub appears as a SmartSpec use case");
  if (found) {
    ok(found.priority === "high", "priority carried over (high)");
    ok(found.goal === "Đạt được X", "goal parsed from the description");
    ok((found.main_flow ?? []).length === 2 && found.main_flow[0].expected_result === "thấy form", "main flow and expected result parsed");
  }
  // 2. edited in WorkHub → updated in SmartSpec
  const detail = (await W("GET", `/api/issues/${story.id}`)).issue;
  await W("PUT", `/api/issues/${story.id}`, { type: detail.type, title: "Đã đổi tên ở WH " + tag, description: detail.description.replace("Đạt được X", "Đạt được Y"), priority: "LOW", refinement: detail.refinement, parentId: detail.parent?.id ?? null, startDate: detail.startDate, dueDate: detail.dueDate, storyPoints: detail.storyPoints, originalEstimateMinutes: detail.originalEstimateMinutes, remainingEstimateMinutes: detail.remainingEstimateMinutes, acceptanceCriteria: detail.acceptanceCriteria, labels: detail.labels });
  const edited = await until(async () => (await ucs()).find((u) => u.name === "Đã đổi tên ở WH " + tag && u.goal === "Đạt được Y" && u.priority === "low"));
  ok(edited, "edit in WorkHub (title, goal, priority) updates the SmartSpec use case");
  // 3. member removed in WorkHub → leaves SmartSpec project
  const inv = await S("POST", `/api/projects/${pid}/members/invite`, { email: B.e, role: "editor" });
  const mine = ((await S("GET", "/api/projects/me/invites", null, ssB)).data ?? []).find((i) => String(i.projectId ?? i.project_id) === pid) ?? ((await S("GET", "/api/projects/me/invites", null, ssB)).data ?? [])[0];
  await S("POST", `/api/projects/${pid}/members/${mine?.memberId ?? mine?._id ?? mine?.id}/accept`, { token: mine?.invite_token ?? mine?.inviteToken }, ssB);
  const bIn = await until(async () => (await W("GET", `/api/projects/${whId}/members`)).find((m) => m.email === B.e));
  ok(bIn, "member added in SmartSpec joins the WorkHub project");
  if (bIn) {
    await W("DELETE", `/api/projects/${whId}/members/${bIn.userId}`);
    const gone = await until(async () => { const d = (await S("GET", `/api/projects/${pid}`)).data; const p = d.project ?? d; return !(p.members ?? []).some((m) => m.status === "accepted" && JSON.stringify(m).includes(String(B.e)) || false) && (p.members ?? []).filter((m) => m.status === "accepted").length === 1; });
    ok(gone, "member removed in WorkHub is removed from the SmartSpec project");
  }
  await S("DELETE", `/api/projects/${pid}`);
  console.log(`inbound e2e: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("CRASH", e); process.exit(1); });
