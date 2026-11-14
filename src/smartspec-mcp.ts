import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Thin client for SmartSpec's REST API, acting as the owner of a personal access token (ssp_…). */
export class SmartSpecClient {
  constructor(private base: string, private token: string) {}

  async call(method: string, path: string, body?: unknown): Promise<any> {
    if (!this.token) throw new Error("Thiếu token SmartSpec (ssp_…). Tạo ở SmartSpec → Kết nối Claude.");
    const res = await fetch(this.base.replace(/\/$/, "") + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const list = Array.isArray(data?.errors) ? "\n- " + data.errors.join("\n- ") : "";
      throw new Error(`${data?.message ?? text.slice(0, 200) ?? `HTTP ${res.status}`}${list}`);
    }
    return data?.data ?? data;
  }
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: String((e as Error).message ?? e) }] });
const json = (v: unknown) => ok("```json\n" + JSON.stringify(v, null, 2) + "\n```");

export const SCHEMA_GUIDE = `# Định dạng dữ liệu SmartSpec

**Quy trình đề xuất:** smartspec_create_project → smartspec_add_usecases → các sơ đồ → smartspec_import_database → smartspec_add_testcases.
Mọi thay đổi vào bản nháp hiện tại; bản đã chốt tự được nhân bản thành bản nháp. Chủ dự án duyệt (approve) sau. Gửi lại cùng \`name\` sẽ **thay thế** (an toàn khi thử lại). Lỗi trả về danh sách vấn đề cụ thể: hãy sửa rồi gửi lại.

## use case (smartspec_add_usecases)
{ name, description, actor: "Khách" | {name}, goal, business_reason, priority: low|medium|high, frequency,
  context: { module: "Tài khoản" }, preconditions: [], 
  main_flow: [{ step: 1, actor, action, expected_result }]   // bắt buộc, ít nhất 1 bước
  alternative_flows: [{ id, at_step, condition, system_response, end_state }],
  exceptions: [{ id, at_step, type, description, system_response }],
  postconditions: [], rules: [{ id, description }], non_functional_constraints: [] }
\`context.module\` nhóm use case thành Epic bên WorkHub.

## database (smartspec_import_database)
{ name, description, tables: [{ name, description, columns: [{ name, type, length, nullable, unique, is_primary_key, is_foreign_key, references: "bảng" | "bảng.cột", related_usecase_ids: [] }] }], relationships?: [{ from_table, to_table, type: one-to-one|one-to-many|many-to-one|many-to-many }] }
Mỗi bảng cần ≥1 khóa chính; tên bảng không trùng và không trùng từ khóa SQL (vd: dùng "customers" thay "user"); khóa ngoại phải trỏ tới bảng có trong danh sách. Không gửi relationships thì tự suy ra từ khóa ngoại.

## use case diagram
{ name, actors: ["Khách"], usecases: ["Đăng nhập"], associations: [{ actor, usecase }], relationships: [{ source, target, type: include|extend|generalization }] }  (dùng tên, không dùng id)

## sequence diagram
{ name, usecase: "tên use case", lifelines: ["Khách","Server"], fragments?: [{ key, type: loop|alt|opt|par|region|else, guard, parent? }],
  messages: [{ from, to, content, type?: sync|async|reply|create|destroy, fragment?: key }] }   // thứ tự = thứ tự mảng; "else" là nhánh của khối alt (parent = key của alt)

## activity diagram
{ name, lanes?: ["Khách","Hệ thống"], nodes: [{ key, type: start|end|action|decision|merge|fork|join|object, label, lane? }], edges: [{ from: key, to: key, condition?, guard? }] }  // cần start, end và edges nối các node

## test case (smartspec_add_testcases)
{ title, description, test_type: integration|api|ui|performance|security, priority: low|medium|high|critical,
  preconditions: [], steps: [{ step_number, action, input_data?, expected_immediate_result }],
  expected_results: { business_level, api_level?: { status_code } }, source_requirement_ids: [id use case] }
Kết quả chạy thật ghi bằng smartspec_record_test_result; test thất bại tự tạo Bug trong WorkHub nếu dự án đã liên kết.`;

const flow = z.object({ step: z.number().optional(), actor: z.string().optional(), action: z.string(), expected_result: z.string().optional() }).passthrough();
const usecase = z.object({
  name: z.string().describe("Tên use case (duy nhất trong phiên bản)"),
  description: z.string().optional(),
  actor: z.union([z.string(), z.object({ name: z.string() }).passthrough()]).optional(),
  goal: z.string().optional(),
  business_reason: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  frequency: z.enum(["low", "medium", "high"]).optional(),
  context: z.object({ module: z.string().optional() }).passthrough().optional(),
  preconditions: z.array(z.string()).optional(),
  main_flow: z.array(flow).min(1),
  alternative_flows: z.array(z.record(z.string(), z.any())).optional(),
  exceptions: z.array(z.record(z.string(), z.any())).optional(),
  postconditions: z.array(z.string()).optional(),
  rules: z.array(z.object({ id: z.string().optional(), description: z.string() }).passthrough()).optional(),
  non_functional_constraints: z.array(z.string()).optional(),
}).passthrough();

const versionId = z.string().describe("Id phiên bản (lấy từ smartspec_get_project)");

/** Builds the SmartSpec MCP server. Every tool acts with the caller's own SmartSpec access (their roles in each project). */
export function buildSmartSpecServer(client: SmartSpecClient): McpServer {
  const server = new McpServer({ name: "smartspec", version: "0.1.0" });
  const run = (fn: () => Promise<any>) => fn().then((v) => (typeof v === "string" ? ok(v) : json(v)), fail);

  server.tool("smartspec_schema", "Đọc định dạng dữ liệu SmartSpec yêu cầu (use case, CSDL, sơ đồ, test case) và quy trình đề xuất. GỌI ĐẦU TIÊN.", {}, async () => ok(SCHEMA_GUIDE));

  server.tool("smartspec_list_projects", "Danh sách dự án SmartSpec của tôi (sở hữu và được chia sẻ), kèm phiên bản hiện tại.", {}, () => run(async () => {
    const [mine, shared] = await Promise.all([client.call("GET", "/api/projects/myproject"), client.call("GET", "/api/projects/shared").catch(() => [])]);
    const row = (p: any, role: string) => ({ projectId: p._id, name: p.name, description: p.description, role, currentVersionId: p.current_version });
    return [...(mine ?? []).map((p: any) => row(p, "owner")), ...(shared ?? []).map((p: any) => row(p, "member"))];
  }));

  server.tool("smartspec_get_project", "Chi tiết một dự án: phiên bản (số, nháp hay đã chốt), phiên bản hiện tại, thành viên.", { projectId: z.string() }, ({ projectId }) => run(async () => {
    const p = await client.call("GET", `/api/projects/${encodeURIComponent(projectId)}`);
    const proj = p.project ?? p;
    return {
      projectId: proj._id ?? projectId, name: proj.name, description: proj.description, language: proj.language, currentVersionId: proj.current_version,
      versions: (p.versions ?? []).map((v: any) => ({ versionId: v._id, number: v.version_number, status: v.status })),
      note: "Ghi vào currentVersionId. Phiên bản đã chốt sẽ tự được nhân bản thành bản nháp khi bạn ghi.",
    };
  }));

  server.tool("smartspec_create_project", "Tạo dự án SmartSpec mới (trống). Trả về projectId và versionId để ghi dữ liệu vào.", {
    name: z.string(), description: z.string().optional(), language: z.enum(["vi-VN", "en-US"]).optional(),
  }, (a) => run(async () => {
    const p = await client.call("POST", "/api/projects", { name: a.name, description: a.description ?? a.name, language: a.language ?? "vi-VN" });
    return { projectId: p._id, versionId: p.current_version, name: p.name };
  }));

  server.tool("smartspec_get_spec", "Đọc toàn bộ đặc tả của một phiên bản: use case, sơ đồ, thiết kế CSDL, test case (tóm tắt). Dùng trước khi sửa hoặc viết code.", {
    projectId: z.string(), versionId: z.string().optional().describe("Mặc định: phiên bản hiện tại"),
  }, ({ projectId, versionId: vid }) => run(async () => {
    const p = await client.call("GET", `/api/projects/${encodeURIComponent(projectId)}`);
    const v = vid ?? (p.project ?? p).current_version;
    const safe = (path: string) => client.call("GET", path).catch(() => null);
    const [ucs, ucd, seq, act, dbs, tcs] = await Promise.all([
      safe(`/api/usecaseManagement/versions/${v}/usecases`), safe(`/api/usecase-diagram/versions/${v}/`), safe(`/api/sequence-diagram/versions/${v}/`),
      safe(`/api/activity-diagrams/${v}`), safe(`/api/databases?versionId=${v}`), safe(`/api/testcases/projects/${projectId}/testcases?versionId=${v}`),
    ]);
    const arr = (x: any) => (Array.isArray(x) ? x : x?.usecases ?? x?.data ?? x?.testcases ?? x?.items ?? []);
    return {
      versionId: v,
      usecases: arr(ucs).map((u: any) => ({ id: u._id, name: u.name, module: u.context?.module, priority: u.priority, actor: u.actor?.name, goal: u.goal, steps: (u.main_flow ?? []).length, implementation: u.implementation?.issue_key ? `${u.implementation.issue_key} ${u.implementation.status}` : undefined })),
      usecaseDiagrams: arr(ucd).map((d: any) => d.name), sequenceDiagrams: arr(seq).map((d: any) => d.name), activityDiagrams: arr(act).map((d: any) => d.name),
      databases: arr(dbs).map((d: any) => ({ name: d.name, tables: (d.tables ?? []).map((t: any) => `${t.name}(${(t.columns ?? []).map((c: any) => c.name).join(",")})`) })),
      testcases: arr(tcs).map((t: any) => ({ id: t._id, title: t.title, status: t.status })),
    };
  }));

  server.tool("smartspec_add_usecases", "Thêm nhiều use case vào phiên bản (trùng tên thì thay thế). Đây là bước phân tích yêu cầu chính. Xem smartspec_schema để biết định dạng.", {
    versionId, usecases: z.array(usecase).min(1).max(60),
  }, (a) => run(() => client.call("POST", `/api/import/versions/${encodeURIComponent(a.versionId)}/usecases`, { usecases: a.usecases })));

  server.tool("smartspec_import_database", "Ghi thiết kế CSDL (bảng, cột, khóa, quan hệ). Trùng tên thì thay thế. Lỗi trả danh sách cần sửa.", {
    versionId, name: z.string(), description: z.string().optional(), tables: z.array(z.record(z.string(), z.any())).min(1), relationships: z.array(z.record(z.string(), z.any())).optional(),
  }, ({ versionId: v, ...body }) => run(() => client.call("POST", `/api/import/versions/${encodeURIComponent(v)}/database`, body)));

  server.tool("smartspec_import_usecase_diagram", "Ghi sơ đồ use case (tác nhân, use case, liên kết, include/extend).", {
    versionId, name: z.string(), actors: z.array(z.any()).min(1), usecases: z.array(z.any()).min(1), associations: z.array(z.record(z.string(), z.any())).optional(), relationships: z.array(z.record(z.string(), z.any())).optional(),
  }, ({ versionId: v, ...body }) => run(() => client.call("POST", `/api/import/versions/${encodeURIComponent(v)}/usecase-diagram`, body)));

  server.tool("smartspec_import_sequence_diagram", "Ghi sơ đồ tuần tự cho một use case (đối tượng, thông điệp theo thứ tự, khối alt/opt/loop).", {
    versionId, name: z.string(), usecase: z.string().optional().describe("Tên use case mà sơ đồ minh hoạ"), description: z.string().optional(),
    lifelines: z.array(z.any()).min(2), fragments: z.array(z.record(z.string(), z.any())).optional(), messages: z.array(z.record(z.string(), z.any())).min(1),
  }, ({ versionId: v, ...body }) => run(() => client.call("POST", `/api/import/versions/${encodeURIComponent(v)}/sequence-diagram`, body)));

  server.tool("smartspec_import_activity_diagram", "Ghi sơ đồ hoạt động (làn bơi, nút, luồng, điều kiện rẽ nhánh).", {
    versionId, name: z.string(), description: z.string().optional(), lanes: z.array(z.any()).optional(), nodes: z.array(z.record(z.string(), z.any())).min(2), edges: z.array(z.record(z.string(), z.any())).min(1),
  }, ({ versionId: v, ...body }) => run(() => client.call("POST", `/api/import/versions/${encodeURIComponent(v)}/activity-diagram`, body)));

  server.tool("smartspec_add_testcases", "Thêm test case (kịch bản kiểm thử) cho phiên bản. Gắn source_requirement_ids = id use case để có độ phủ.", {
    projectId: z.string(), versionId, testCases: z.array(z.record(z.string(), z.any())).min(1).max(100),
  }, (a) => run(() => client.call("POST", `/api/testcases/projects/${encodeURIComponent(a.projectId)}/versions/${encodeURIComponent(a.versionId)}/testcases`, { testCases: a.testCases })));

  server.tool("smartspec_record_test_result", "Ghi kết quả chạy một test case. Test thất bại tự tạo Bug trong WorkHub (nếu dự án đã liên kết).", {
    testCaseId: z.string(), status: z.enum(["passed", "failed", "blocked", "in_progress"]), actual_result: z.string().optional(),
  }, (a) => run(() => client.call("PUT", `/api/testcases/testcases/${encodeURIComponent(a.testCaseId)}/execute`, { status: a.status, actual_result: a.actual_result ?? "" })));

  server.tool("smartspec_approve_version", "CHỈ chủ dự án: duyệt và chốt bản nháp (major = đổi lớn, minor = đổi nhỏ). Chỉ dùng khi người dùng yêu cầu rõ ràng.", {
    versionId, changeType: z.enum(["minor", "major"]), comment: z.string().optional(),
  }, (a) => run(() => client.call("POST", `/api/versions/${encodeURIComponent(a.versionId)}/approve`, { changeType: a.changeType, comment: a.comment ?? "" })));

  return server;
}
