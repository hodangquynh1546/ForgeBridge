// End-to-end: a real MCP client (Streamable HTTP) drives SmartSpec through ForgeBridge using a personal token.
// Env: SMARTSPEC_URL (8000), BRIDGE_URL (8095). SmartSpec must run with MAIL_ENABLED=false AUTH_RATE_LIMIT=1000.
(async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const SS = process.env.SMARTSPEC_URL ?? "http://localhost:8000", BR = process.env.BRIDGE_URL ?? "http://localhost:8095";
  let pass = 0, fail = 0;
  const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL", m)); };
  const j = async (r) => r.json().catch(() => ({}));
  const email = `mcp${Date.now()}@example.com`, password = "Passw0rd!123";
  const reg = await j(await fetch(SS + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, confirmPassword: password }) }));
  const access = reg.accessToken ?? reg.data?.accessToken ?? reg.token;
  ok(access, "register " + JSON.stringify(reg).slice(0, 150));
  const tk = await j(await fetch(SS + "/api/tokens", { method: "POST", headers: { Authorization: "Bearer " + access, "Content-Type": "application/json" }, body: JSON.stringify({ name: "claude" }) }));
  const token = tk.token ?? tk.data?.token;
  ok(token?.startsWith("ssp_"), "pat");

  const anon = await fetch(BR + "/mcp/smartspec", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
  ok(anon.status === 401, "no token → 401 got " + anon.status);

  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(BR + "/mcp/smartspec"), { requestInit: { headers: { Authorization: "Bearer " + token } } }));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  ok(tools.length >= 12 && tools.includes("smartspec_add_usecases"), "tools " + tools.length);
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content[0].text; let v = t; const m = t.match(/```json\n([\s\S]*)\n```/); if (m) v = JSON.parse(m[1]); return { err: !!r.isError, v, t }; };

  ok((await call("smartspec_schema")).t.includes("main_flow"), "schema");
  const p = await call("smartspec_create_project", { name: "MCP Shop " + Date.now() });
  ok(!p.err && p.v.versionId, "create project " + p.t);
  const { projectId, versionId } = p.v;

  const bad = await call("smartspec_add_usecases", { versionId, usecases: [{ name: "X", main_flow: [{ action: "" }] }] });
  ok(bad.err && bad.t.includes("action"), "invalid rejected with reason: " + bad.t.slice(0, 160));
  const uc = await call("smartspec_add_usecases", { versionId, usecases: [
    { name: "Đăng nhập", actor: "Khách", goal: "Vào hệ thống", priority: "high", context: { module: "Tài khoản" }, main_flow: [{ step: 1, actor: "Khách", action: "Nhập email và mật khẩu", expected_result: "Hệ thống kiểm tra" }, { step: 2, actor: "Hệ thống", action: "Cấp phiên", expected_result: "Vào trang chủ" }] },
    { name: "Đặt hàng", actor: "Khách", goal: "Mua hàng", context: { module: "Đơn hàng" }, main_flow: [{ step: 1, actor: "Khách", action: "Xác nhận giỏ hàng", expected_result: "Tạo đơn" }] },
  ] });
  ok(!uc.err && uc.v.created?.length === 2, "usecases " + uc.t.slice(0, 200));
  const again = await call("smartspec_add_usecases", { versionId, usecases: [{ name: "Đăng nhập", main_flow: [{ step: 1, actor: "Khách", action: "Đăng nhập lại", expected_result: "OK" }] }] });
  ok(again.v.replaced?.length === 1, "replace " + again.t.slice(0, 200));

  const db = await call("smartspec_import_database", { versionId, name: "Shop DB", tables: [
    { name: "customers", columns: [{ name: "id", type: "uuid", is_primary_key: true }, { name: "email", type: "varchar", length: 255, unique: true }] },
    { name: "orders", columns: [{ name: "id", type: "uuid", is_primary_key: true }, { name: "customer_id", type: "uuid", is_foreign_key: true, references: "customers.id" }] },
  ] });
  ok(!db.err, "database " + db.t.slice(0, 200));
  const ucd = await call("smartspec_import_usecase_diagram", { versionId, name: "Tổng quan", actors: ["Khách"], usecases: ["Đăng nhập", "Đặt hàng"], associations: [{ actor: "Khách", usecase: "Đăng nhập" }, { actor: "Khách", usecase: "Đặt hàng" }] });
  ok(!ucd.err, "ucd " + ucd.t.slice(0, 200));
  const seq = await call("smartspec_import_sequence_diagram", { versionId, name: "Đăng nhập", usecase: "Đăng nhập", lifelines: ["Khách", "Server"], messages: [{ from: "Khách", to: "Server", content: "POST /login" }, { from: "Server", to: "Khách", content: "200", type: "reply" }] });
  ok(!seq.err, "seq " + seq.t.slice(0, 200));
  const act = await call("smartspec_import_activity_diagram", { versionId, name: "Đặt hàng", nodes: [{ key: "s", type: "start", label: "Bắt đầu" }, { key: "a", type: "action", label: "Tạo đơn" }, { key: "e", type: "end", label: "Xong" }], edges: [{ from: "s", to: "a" }, { from: "a", to: "e" }] });
  ok(!act.err, "act " + act.t.slice(0, 200));

  const spec = await call("smartspec_get_spec", { projectId });
  ok(spec.v.usecases?.length === 2 && spec.v.databases?.length >= 1 && spec.v.sequenceDiagrams?.length >= 1, "spec " + JSON.stringify(spec.v).slice(0, 300));
  const list = await call("smartspec_list_projects");
  ok(list.v.some((x) => x.projectId === projectId), "list");

  const tc = await call("smartspec_add_testcases", { projectId, versionId, testCases: [{ title: "Đăng nhập đúng", description: "d", test_type: "integration", priority: "high", preconditions: [], steps: [{ step_number: 1, action: "login", expected_immediate_result: "ok" }], expected_results: { business_level: "vào được" }, source_requirement_ids: [] }] });
  console.log("tc →", tc.t.slice(0, 200));
  ok(!tc.err, "testcases");
  const spec2 = await call("smartspec_get_spec", { projectId });
  const tid = spec2.v.testcases?.[0]?.id;
  if (tid) { const r = await call("smartspec_record_test_result", { testCaseId: tid, status: "passed" }); ok(!r.err, "record " + r.t.slice(0, 150)); }
  else ok(false, "no testcase listed " + JSON.stringify(spec2.v.testcases));

  // other user cannot reach the project
  const e2 = `mcp2${Date.now()}@example.com`;
  const r2 = await j(await fetch(SS + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: e2, password, confirmPassword: password }) }));
  const tk2 = await j(await fetch(SS + "/api/tokens", { method: "POST", headers: { Authorization: "Bearer " + (r2.accessToken ?? r2.data?.accessToken), "Content-Type": "application/json" }, body: JSON.stringify({ name: "x" }) }));
  const t2 = tk2.token ?? tk2.data?.token;
  ok(t2, "second token " + JSON.stringify(tk2).slice(0, 150));
  const c2 = new Client({ name: "e2e2", version: "1" });
  await c2.connect(new StreamableHTTPClientTransport(new URL(BR + "/mcp/smartspec"), { requestInit: { headers: { Authorization: "Bearer " + t2 } } }));
  const r = await c2.callTool({ name: "smartspec_add_usecases", arguments: { versionId, usecases: [{ name: "Hack", main_flow: [{ step: 1, action: "x" }] }] } });
  ok(r.isError, "outsider blocked");
  console.log(`MCP e2e: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("CRASH", e); process.exit(1); });
