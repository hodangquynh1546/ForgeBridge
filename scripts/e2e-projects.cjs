// Projects created/renamed in either system appear in the other. Uses the dev stack (SmartSpec :8000, WorkHub :8080, Bridge :8090).
const SS = "http://localhost:8000", WH = "http://localhost:8080";
const EMAIL = process.env.E2E_EMAIL ?? "hodangquynh1546@gmail.com", PASS = process.env.E2E_PASS ?? "15102004Quynh@";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("✓", m)) : (fail++, console.log("✗", m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const until = async (fn, ms = 40000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(1500); } return null; };
(async () => {
  const ss = (await j(await fetch(SS + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASS }) }))).data.accessToken;
  const wh = (await j(await fetch(WH + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASS }) }))).accessToken;
  const S = (m, p, b) => fetch(SS + p, { method: m, headers: { Authorization: "Bearer " + ss, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then(j);
  const W = (m, p, b) => fetch(WH + p, { method: m, headers: { Authorization: "Bearer " + wh, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then(j);
  const tag = Date.now().toString(36);

  // 1. created in SmartSpec → exists in WorkHub (no analysis needed)
  const created = (await S("POST", "/api/projects", { name: "E2E SS " + tag, description: "tạo ở SmartSpec", language: "vi-VN" })).data;
  const link = await until(async () => { const r = await S("GET", `/api/workhub/projects/${created._id}`); return r.data?.linked ? r.data : null; });
  ok(link, "SmartSpec project gets a WorkHub project at once");
  const whId = link?.workhub.projectId;
  ok(whId && (await W("GET", `/api/projects/${whId}`)).name === "E2E SS " + tag, "WorkHub project has the same name");

  // 2. renamed in SmartSpec → renamed in WorkHub
  await S("PUT", `/api/projects/${created._id}`, { name: "E2E SS renamed " + tag, description: "mô tả mới" });
  ok(await until(async () => (await W("GET", `/api/projects/${whId}`)).name === "E2E SS renamed " + tag), "rename in SmartSpec reaches WorkHub");

  // 3. renamed in WorkHub → renamed in SmartSpec
  const cur = await W("GET", `/api/projects/${whId}`);
  await W("PUT", `/api/projects/${whId}`, { name: "E2E WH renamed " + tag, description: cur.description, startDate: cur.startDate, endDate: cur.endDate, methodology: cur.methodology });
  ok(await until(async () => (await S("GET", `/api/projects/${created._id}`)).data?.project?.name === "E2E WH renamed " + tag || (await S("GET", `/api/projects/${created._id}`)).data?.name === "E2E WH renamed " + tag), "rename in WorkHub reaches SmartSpec");

  // 4. created in WorkHub → exists in SmartSpec
  const wss = (await W("GET", "/api/me/projects"))[0];
  const teamId = wss?.teamId;
  const wp = await W("POST", `/api/teams/${teamId}/projects`, { key: ("W" + tag).toUpperCase().slice(0, 8), name: "E2E WH " + tag, description: "tạo ở WorkHub", methodology: "SCRUM" });
  ok(wp.id, "project created in WorkHub");
  const found = await until(async () => (await S("GET", "/api/projects/myproject")).data?.find((p) => p.name === "E2E WH " + tag));
  ok(found, "project created in WorkHub appears in SmartSpec");
  // 5. archived ("deleted") in WorkHub → trashed in SmartSpec; reopened → restored
  const trashed = async () => (await S("GET", `/api/projects/${created._id}`)).data;
  const isTrashed = async () => { const d = await trashed(); const pr = d?.project ?? d; return !!pr?.status?.is_trashed; };
  await W("PUT", `/api/projects/${whId}/status`, { status: "ARCHIVED" });
  ok(await until(isTrashed), "project archived in WorkHub goes to the SmartSpec trash");
  await W("PUT", `/api/projects/${whId}/status`, { status: "ACTIVE" });
  ok(await until(async () => !(await isTrashed())), "project reopened in WorkHub is restored in SmartSpec");
  // 6. deleted (trashed) in SmartSpec → archived in WorkHub
  await S("DELETE", `/api/projects/${created._id}`);
  ok(await until(async () => (await W("GET", `/api/projects/${whId}`)).status === "ARCHIVED"), "project deleted in SmartSpec is archived in WorkHub");
  console.log(`projects e2e: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("CRASH", e); process.exit(1); });
