// A use case created in SmartSpec appears as a WorkHub task; undoing it in the preview ("hoàn tác") removes the task again.
// Deletion applies whatever the task state. Uses the dev stack, account hodangquynh1546.
const SS = "http://localhost:8000", WH = "http://localhost:8080";
const E = process.env.E2E_EMAIL ?? "hodangquynh1546@gmail.com", P = process.env.E2E_PASS ?? "15102004Quynh@";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("✓", m)) : (fail++, console.log("✗", m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const until = async (fn, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(1500); } return null; };
(async () => {
  const ss = (await j(await fetch(SS + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: E, password: P }) }))).data.accessToken;
  const wh = (await j(await fetch(WH + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: E, password: P }) }))).accessToken;
  const S = (m, p, b) => fetch(SS + p, { method: m, headers: { Authorization: "Bearer " + ss, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then(j);
  const W = (m, p, b) => fetch(WH + p, { method: m, headers: { Authorization: "Bearer " + wh, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then(j);
  const tag = Date.now().toString(36);
  const fd = new FormData(); fd.append("name", "E2E removal " + tag); fd.append("description", "x"); fd.append("language", "vi-VN");
  const created = (await (await fetch(SS + "/api/projects", { method: "POST", headers: { Authorization: "Bearer " + ss }, body: fd })).json()).data;
  const vid = created.current_version;
  const uc = (name) => ({ name, goal: "g", actor: "Khách", context: { module: "Mod " + tag }, main_flow: [{ step: 1, actor: "Khách", action: "bấm", expected_result: "ok" }] });
  await S("POST", `/api/import/versions/${vid}/usecases`, { usecases: [uc("Giữ lại"), uc("Sẽ hoàn tác"), uc("Đã làm dở")] });
  const link = await until(async () => { const r = await S("GET", `/api/workhub/projects/${created._id}`); return r.data?.linked && Object.keys(r.data.items ?? {}).length >= 3 ? r.data : null; });
  ok(link, "3 use cases become 3 WorkHub tasks");
  const whId = link.workhub.projectId;
  const issues = async () => (await W("GET", `/api/projects/${whId}/issues?size=100`)).items ?? [];
  const titles = async () => (await issues()).map((i) => i.title);
  ok((await titles()).includes("Sẽ hoàn tác"), "task 'Sẽ hoàn tác' exists in WorkHub");

  // someone starts work on "Đã làm dở"
  const started = (await issues()).find((i) => i.title === "Đã làm dở");
  await W("PUT", `/api/issues/${started.id}/status`, { status: "IN_PROGRESS" });
  // ...and it sits in a running sprint (WorkHub itself would refuse to delete it there)
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const sprint = await W("POST", `/api/projects/${whId}/sprints`, { name: "S " + tag, goal: "g", startDate: day(0), endDate: day(7) });
  const added = await W("POST", `/api/sprints/${sprint.id}/issues`, { issueIds: [started.id], includeChildren: false }); if (added.code) console.log("   add to sprint:", JSON.stringify(added).slice(0, 200));
  const st = await W("POST", `/api/sprints/${sprint.id}/start`, {});
  ok(sprint.id && !st.code, "task put in a running sprint " + (st.code ?? ""));

  // undo both creations in the SmartSpec preview
  const pv = (await S("GET", `/api/versions/${vid}/preview`)).data;
  const changes = pv?.changes ?? [];
  for (const name of ["Sẽ hoàn tác", "Đã làm dở"]) {
    const ch = changes.find((c) => (c.after_snapshot?.name ?? "") === name);
    if (!ch) console.log("   no preview change for", name, "have:", changes.map((c) => c.after_snapshot?.name));
    else { const r = await S("POST", `/api/versions/${vid}/change/${ch.change_id}/revert`); if (r.status === "Error") console.log("   revert failed:", name, JSON.stringify(r).slice(0, 160)); }
  }
  ok(await until(async () => !(await titles()).includes("Sẽ hoàn tác")), "undone use case → its untouched task disappears from WorkHub");
  const after = await issues();
  const kept = after.find((i) => i.title === "Đã làm dở");
  ok(!kept, "a task someone already started is deleted too (deleting in SmartSpec needs no WorkHub confirmation)");
  ok(after.find((i) => i.title === "Giữ lại"), "other tasks are unaffected");
  await S("DELETE", `/api/projects/${created._id}`);
  console.log(`removal e2e: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("CRASH", e); process.exit(1); });
