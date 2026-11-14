// Two people on one SmartSpec project: edits by one reach the other in real time; outsiders get nothing.
// Needs the dev stack (SmartSpec :8000). Accounts: A owns, B is invited, X is an outsider.
const path = require("path");
const { io } = require(require.resolve("socket.io-client", { paths: [path.join(__dirname, "../../SmartSpec/frontend"), path.join(__dirname, "../../SmartSpec/backend")] }));
const SS = "http://localhost:8000";
const A = { email: "hodangquynh1546@gmail.com", pass: "15102004Quynh@" };
const B = { email: "hodangquynh1504@gmail.com", pass: "15102004Quynh@" };
const X = { email: "hodangquynh2k4@gmail.com", pass: "15102004Quynh@" };
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("✓", m)) : (fail++, console.log("✗", m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const login = async (u) => { const d = (await j(await fetch(SS + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: u.email, password: u.pass }) }))).data; return { ...u, token: d.accessToken, id: JSON.parse(Buffer.from(d.accessToken.split(".")[1], "base64url")).sub }; };
const api = (u) => (m, p, b) => fetch(SS + p, { method: m, headers: { Authorization: "Bearer " + u.token, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then(j);
const sock = (u, withToken = true) => new Promise((res) => { const s = io(SS, { transports: ["websocket"], auth: withToken ? { token: u.token } : { userId: u.id } }); s.events = []; s.denied = false; s.on("usecase_event", (e) => s.events.push(e)); s.on("join_denied", () => (s.denied = true)); s.on("connect", () => res(s)); });
(async () => {
  const [a, b, x] = [await login(A), await login(B), await login(X)];
  const SA = api(a), SB = api(b);
  const p = (await SA("POST", "/api/projects", { name: "Realtime " + Date.now().toString(36), description: "kiểm thử 2 người", language: "vi-VN" })).data;
  const versionId = p.current_version;
  const inv = await SA("POST", `/api/projects/${p._id}/members/invite`, { email: B.email, role: "editor" });
  ok(inv.status !== "Error" && !inv.message?.toLowerCase().includes("not"), "A invites B as editor " + (inv.message ?? ""));
  const invites = (await SB("GET", "/api/projects/me/invites")).data ?? [];
  const mine = invites.find((i) => String(i.projectId ?? i.project_id ?? i.project?._id) === p._id) ?? invites[0];
  const memberId = mine?.memberId ?? mine?.member_id ?? mine?._id ?? mine?.id;
  const acc = await SB("POST", `/api/projects/${p._id}/members/${memberId}/accept`, { token: mine?.invite_token ?? mine?.inviteToken });
  if (acc.status === "Error") console.log("   invite row:", JSON.stringify(mine).slice(0, 200));
  ok(acc.status !== "Error", "B accepts the invitation " + (acc.message ?? ""));

  const [sa, sb, sx, sanon] = [await sock(a), await sock(b), await sock(x), await sock(x, false)];
  for (const s of [sa, sb, sx, sanon]) s.emit("join_project", p._id);
  await sleep(1200);
  ok(!sa.denied && !sb.denied, "owner and member join the project room");
  ok(sx.denied, "an outsider (other account) is refused");

  // A creates a use case → B sees it live; outsiders see nothing
  const uc = await SA("POST", `/api/usecaseManagement/versions/${versionId}/usecases`, { name: "Realtime UC", description: "d", actor: { name: "Khách" }, goal: "g", business_reason: "r", priority: "high", main_flow: [{ step: 1, actor: "Khách", action: "bấm", expected_result: "ok" }] });
  await sleep(1500);
  ok(sb.events.some((e) => JSON.stringify(e).includes("Realtime UC")), "B receives A's new use case in real time");
  ok(!sx.events.length && !sanon.events.length, "outsiders receive no events");
  // B edits → A sees it
  const ucId = uc.data?._id ?? uc.data?.usecase?._id;
  if (ucId) {
    await SB("PUT", `/api/usecaseManagement/versions/${versionId}/usecases/${ucId}`, { name: "Realtime UC (B sửa)", description: "d", actor: { name: "Khách" }, goal: "g", business_reason: "r", priority: "high", main_flow: [{ step: 1, actor: "Khách", action: "bấm", expected_result: "ok" }] });
    await sleep(1500);
    ok(sa.events.some((e) => JSON.stringify(e).includes("B sửa")), "A receives B's edit in real time");
  } else ok(false, "use case id not returned: " + JSON.stringify(uc).slice(0, 120));
  // A deletes project at the end
  await SA("DELETE", `/api/projects/${p._id}`).catch(() => {});
  [sa, sb, sx, sanon].forEach((s) => s.close());
  console.log(`realtime e2e: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("CRASH", e); process.exit(1); });
