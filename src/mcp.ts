#!/usr/bin/env -S npx tsx
// MCP server: lets Claude Code / Copilot read the task + its SmartSpec specification and update progress.
// Config (env): FORGE_BRIDGE_URL (default http://localhost:8090), FORGE_TOKEN (WorkHub integration token, whk_…).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.FORGE_BRIDGE_URL ?? "http://localhost:8090").replace(/\/$/, "");
const TOKEN = process.env.FORGE_TOKEN ?? "";

async function api(method: string, path: string, body?: unknown) {
  if (!TOKEN) throw new Error("FORGE_TOKEN is not set (WorkHub integration token, starts with whk_)");
  const res = await fetch(BASE + "/ide" + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
  return data;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: String((e as Error).message ?? e) }] });

export function specToMarkdown(uc: any): string {
  if (!uc) return "_(task này không gắn với use case SmartSpec)_";
  const out: string[] = [`### Đặc tả SmartSpec: ${uc.name}`];
  if (uc.actor?.name) out.push(`**Tác nhân:** ${uc.actor.name}`);
  if (uc.goal) out.push(`**Mục tiêu:** ${uc.goal}`);
  if (uc.business_reason) out.push(`**Lý do nghiệp vụ:** ${uc.business_reason}`);
  const list = (title: string, items?: string[]) => items?.length && out.push(`**${title}**\n${items.map((x) => `- ${x}`).join("\n")}`);
  list("Điều kiện tiên quyết", uc.preconditions);
  if (uc.main_flow?.length) out.push("**Luồng chính**\n" + uc.main_flow.map((s: any, i: number) => `${s.step ?? i + 1}. ${s.actor ?? ""}: ${s.action ?? ""}${s.expected_result ? ` → ${s.expected_result}` : ""}`).join("\n"));
  if (uc.alternative_flows?.length) out.push("**Luồng thay thế**\n" + uc.alternative_flows.map((a: any) => `- (bước ${a.at_step}) ${a.condition} → ${a.system_response}`).join("\n"));
  if (uc.exceptions?.length) out.push("**Ngoại lệ**\n" + uc.exceptions.map((e: any) => `- (bước ${e.at_step}) ${e.type}: ${e.description} → ${e.system_response}`).join("\n"));
  if (uc.rules?.length) out.push("**Quy tắc**\n" + uc.rules.map((r: any) => `- ${r.id ?? ""} ${r.description}`).join("\n"));
  list("Kết quả sau cùng", uc.postconditions);
  list("Ràng buộc phi chức năng", uc.non_functional_constraints);
  return out.join("\n\n");
}

const server = new McpServer({ name: "forge", version: "0.1.0" });

server.tool("forge_my_tasks", "Danh sách task WorkHub đang mở được giao cho tôi (kèm mã task, trạng thái, có đặc tả SmartSpec hay không).", {}, async () => {
  try {
    const tasks = await api("GET", "/tasks");
    return text(tasks.length ? tasks.map((t: any) => `- ${t.key} [${t.status}] ${t.title} (${t.project}${t.specLinked ? ", có đặc tả" : ""})`).join("\n") : "Không có task nào đang mở.");
  } catch (e) { return fail(e); }
});

server.tool("forge_get_task", "Đọc một task WorkHub cùng đặc tả SmartSpec gốc (luồng chính, quy tắc, tiêu chí chấp nhận). Gọi trước khi viết code cho task.", { key: z.string().describe("Mã task, ví dụ SHOP-12") }, async ({ key }) => {
  try {
    const t = await api("GET", `/issues/${encodeURIComponent(key)}`);
    const parts = [`# ${t.key}: ${t.title}`, `Trạng thái: ${t.status} · Ưu tiên: ${t.priority} · Dự án: ${t.project}${t.epic ? ` · Epic: ${t.epic.title}` : ""}${t.assignee ? ` · Người làm: ${t.assignee}` : ""}`];
    if (t.specRemoved) parts.push("⚠️ Use case này đã bị xoá khỏi đặc tả SmartSpec, hãy xác nhận với PO trước khi làm tiếp.");
    if (t.description) parts.push(t.description);
    if (t.acceptanceCriteria) parts.push("## Tiêu chí chấp nhận\n" + t.acceptanceCriteria);
    parts.push(specToMarkdown(t.spec));
    return text(parts.join("\n\n"));
  } catch (e) { return fail(e); }
});

server.tool("forge_set_status", "Đổi trạng thái task trong WorkHub (đồng bộ ngược về SmartSpec).", { key: z.string(), status: z.enum(["TO_DO", "IN_PROGRESS", "CODE_REVIEW", "TESTING", "DONE"]) }, async ({ key, status }) => {
  try { await api("PUT", `/issues/${encodeURIComponent(key)}/status`, { status }); return text(`${key} → ${status}`); } catch (e) { return fail(e); }
});

server.tool("forge_comment", "Thêm bình luận vào task (ví dụ tóm tắt thay đổi, link PR).", { key: z.string(), body: z.string() }, async ({ key, body }) => {
  try { await api("POST", `/issues/${encodeURIComponent(key)}/comments`, { body }); return text(`Đã bình luận vào ${key}`); } catch (e) { return fail(e); }
});

await server.connect(new StdioServerTransport());
