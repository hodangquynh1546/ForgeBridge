import { sha256 } from "./crypto.js";

export interface SsUsecase {
  key: string; // stable across versions (lineage), not the per-version Mongo id
  name: string;
  type?: "use_case" | "epic" | "feature";
  description?: string;
  goal?: string;
  business_reason?: string;
  priority?: "low" | "medium" | "high";
  actor?: { name?: string } | null;
  context?: { module?: string } | null;
  preconditions?: string[];
  main_flow?: { step?: number; actor?: string; action?: string; expected_result?: string }[];
  alternative_flows?: { id?: string; at_step?: number; condition?: string; system_response?: string; end_state?: string }[];
  exceptions?: { id?: string; at_step?: number; type?: string; description?: string; system_response?: string }[];
  postconditions?: string[];
  rules?: { id?: string; description?: string }[];
  non_functional_constraints?: string[];
}

export interface IssueContent {
  title: string;
  description: string;
  acceptanceCriteria: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  type: "EPIC" | "FEATURE" | "USER_STORY";
  module: string;
}

const MAX_TEXT = 10_000;
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");
const list = (items: (string | undefined)[], bullet = "-") =>
  items.filter((x): x is string => !!x && x.trim() !== "").map((x) => `${bullet} ${x.trim()}`);

export function moduleOf(uc: SsUsecase): string {
  return (uc.context?.module ?? "").trim() || "Chung";
}

export function moduleSlug(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "chung";
}

/** Turns a SmartSpec use case into WorkHub issue fields. The text is a deterministic function of the use case. */
export function toIssueContent(uc: SsUsecase): IssueContent {
  const d: string[] = [];
  if (uc.description?.trim()) d.push(uc.description.trim());
  if (uc.actor?.name) d.push(`**Tác nhân:** ${uc.actor.name}`);
  if (uc.goal?.trim()) d.push(`**Mục tiêu:** ${uc.goal.trim()}`);
  if (uc.business_reason?.trim()) d.push(`**Lý do nghiệp vụ:** ${uc.business_reason.trim()}`);
  const pre = list(uc.preconditions ?? []);
  if (pre.length) d.push("**Điều kiện tiên quyết**\n" + pre.join("\n"));
  const flow = (uc.main_flow ?? []).map((s, i) => `${s.step ?? i + 1}. ${[s.actor, s.action].filter(Boolean).join(": ")}`.trim());
  if (flow.length) d.push("**Luồng chính**\n" + flow.join("\n"));
  const post = list(uc.postconditions ?? []);
  if (post.length) d.push("**Kết quả sau cùng**\n" + post.join("\n"));
  const nfr = list(uc.non_functional_constraints ?? []);
  if (nfr.length) d.push("**Ràng buộc phi chức năng**\n" + nfr.join("\n"));
  d.push("_Nguồn: SmartSpec — đặc tả được đồng bộ tự động, hãy sửa nội dung gốc ở SmartSpec._");

  const ac: string[] = [];
  for (const s of uc.main_flow ?? []) {
    if (s.expected_result?.trim()) ac.push(`- [ ] Bước ${s.step ?? "?"}: ${s.expected_result.trim()}`);
  }
  for (const r of uc.rules ?? []) {
    if (r.description?.trim()) ac.push(`- [ ] Quy tắc ${r.id ?? ""}: ${r.description.trim()}`.replace("  ", " "));
  }
  for (const a of uc.alternative_flows ?? []) {
    ac.push(`- [ ] Nếu ${(a.condition ?? "").trim()} (bước ${a.at_step ?? "?"}) → ${(a.system_response ?? "").trim()}`);
  }
  for (const e of uc.exceptions ?? []) {
    ac.push(`- [ ] Ngoại lệ ${(e.type ?? "").trim()}: ${(e.description ?? "").trim()} → ${(e.system_response ?? "").trim()}`);
  }

  const priority = ({ low: "LOW", medium: "MEDIUM", high: "HIGH" } as const)[uc.priority ?? "medium"] ?? "MEDIUM";
  const type = uc.type === "epic" ? "EPIC" : uc.type === "feature" ? "FEATURE" : "USER_STORY";
  return {
    title: clip(uc.name.trim(), 255),
    description: clip(d.join("\n\n"), MAX_TEXT),
    acceptanceCriteria: clip(ac.join("\n"), MAX_TEXT),
    priority,
    type,
    module: moduleOf(uc),
  };
}

export function contentHash(c: IssueContent): string {
  return sha256(JSON.stringify([c.title, c.description, c.acceptanceCriteria, c.priority, c.type, c.module]));
}

/** 2–10 letters/digits starting with a letter, upper-case. */
export function projectKey(name: string): string {
  const ascii = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d");
  const words = ascii.split(/[^A-Za-z0-9]+/).filter(Boolean);
  let key = words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "");
  key = key.replace(/^[^A-Za-z]+/, "").toUpperCase();
  if (key.length < 2) key = (words.join("").replace(/^[^A-Za-z]+/, "").toUpperCase() + "PRJ").slice(0, 4);
  return key.slice(0, 10);
}
