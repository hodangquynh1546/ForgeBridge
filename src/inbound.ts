import type { SsUsecase } from "./mapper.js";

/**
 * Reads a WorkHub story back into SmartSpec use case fields. It understands the layout `toIssueContent` writes
 * (sections in bold, numbered main flow, "- [ ] Bước N: …" acceptance criteria) and also a plain free-text description
 * written by a person in WorkHub (then that text becomes the use case description).
 */
export interface ParsedStory {
  name: string;
  priority: "low" | "medium" | "high";
  description: string;
  actorName?: string;
  goal?: string;
  business_reason?: string;
  preconditions?: string[];
  main_flow?: { step: number; actor?: string; action: string; expected_result?: string }[];
  postconditions?: string[];
  non_functional_constraints?: string[];
  rules?: { id?: string; description: string }[];
}

const FOOTER = /^_Nguồn: SmartSpec/;
const bullets = (block: string) => block.split("\n").slice(1).map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);

export function parseStory(issue: { title: string; description?: string | null; acceptanceCriteria?: string | null; priority?: string }): ParsedStory {
  const text = (issue.description ?? "").replace(/\r\n/g, "\n").trim();
  const blocks = text ? text.split(/\n{2,}/).map((b) => b.trim()).filter((b) => b && !FOOTER.test(b)) : [];
  const out: ParsedStory = {
    name: issue.title.trim(),
    priority: ({ LOW: "low", MEDIUM: "medium", HIGH: "high", CRITICAL: "high" } as const)[(issue.priority ?? "MEDIUM") as "LOW"] ?? "medium",
    description: "",
  };
  const free: string[] = [];
  let sectioned = false;
  for (const b of blocks) {
    let m: RegExpMatchArray | null;
    if ((m = b.match(/^\*\*Tác nhân:\*\*\s*([\s\S]*)$/))) { out.actorName = m[1].trim(); sectioned = true; }
    else if ((m = b.match(/^\*\*Mục tiêu:\*\*\s*([\s\S]*)$/))) { out.goal = m[1].trim(); sectioned = true; }
    else if ((m = b.match(/^\*\*Lý do nghiệp vụ:\*\*\s*([\s\S]*)$/))) { out.business_reason = m[1].trim(); sectioned = true; }
    else if (/^\*\*Điều kiện tiên quyết\*\*/.test(b)) { out.preconditions = bullets(b); sectioned = true; }
    else if (/^\*\*Kết quả sau cùng\*\*/.test(b)) { out.postconditions = bullets(b); sectioned = true; }
    else if (/^\*\*Ràng buộc phi chức năng\*\*/.test(b)) { out.non_functional_constraints = bullets(b); sectioned = true; }
    else if (/^\*\*Luồng chính\*\*/.test(b)) {
      sectioned = true;
      out.main_flow = b.split("\n").slice(1).map((l, i) => {
        const mm = l.match(/^\s*(\d+)\.\s*(?:([^:]{1,60}):\s*)?(.*)$/);
        return mm ? { step: Number(mm[1]), actor: mm[2]?.trim(), action: mm[3].trim() } : { step: i + 1, action: l.trim() };
      }).filter((s) => s.action);
    } else if (!sectioned) free.push(b);
    else free.push(b); // text a person added after the sections
  }
  out.description = free.join("\n\n").trim();
  // acceptance criteria → expected results per step, and rules
  const rules: { id?: string; description: string }[] = [];
  for (const line of (issue.acceptanceCriteria ?? "").replace(/\r\n/g, "\n").split("\n")) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s*-\s*\[[ xX]\]\s*Bước\s*(\d+|\?):\s*(.*)$/)) && out.main_flow) {
      const step = out.main_flow.find((s) => String(s.step) === m![1]);
      if (step) step.expected_result = m[2].trim();
    } else if ((m = line.match(/^\s*-\s*\[[ xX]\]\s*Quy tắc\s*([^:]*):\s*(.*)$/))) {
      rules.push({ id: m[1].trim() || undefined, description: m[2].trim() });
    }
  }
  if (rules.length) out.rules = rules;
  return out;
}

const norm = (s: unknown) => String(s ?? "").replace(/\r\n/g, "\n").trim();
const sameList = (a: unknown[] | undefined, b: unknown[] | undefined) => JSON.stringify((a ?? []).map(norm)) === JSON.stringify((b ?? []).map(norm));

/** Only the fields a person changed in WorkHub (parsed vs what SmartSpec has); empty = nothing to write back. */
export function diffStory(p: ParsedStory, spec: SsUsecase): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  if (norm(p.name) !== norm(spec.name)) d.name = p.name;
  if (p.priority !== (spec.priority ?? "medium")) d.priority = p.priority;
  if (norm(p.description) !== norm(spec.description)) d.description = p.description;
  if (p.actorName !== undefined && norm(p.actorName) !== norm(spec.actor?.name)) d.actorName = p.actorName;
  if (p.goal !== undefined && norm(p.goal) !== norm(spec.goal)) d.goal = p.goal;
  if (p.business_reason !== undefined && norm(p.business_reason) !== norm(spec.business_reason)) d.business_reason = p.business_reason;
  if (p.preconditions && !sameList(p.preconditions, spec.preconditions)) d.preconditions = p.preconditions;
  if (p.postconditions && !sameList(p.postconditions, spec.postconditions)) d.postconditions = p.postconditions;
  if (p.non_functional_constraints && !sameList(p.non_functional_constraints, spec.non_functional_constraints)) d.non_functional_constraints = p.non_functional_constraints;
  if (p.main_flow) {
    const cur = (spec.main_flow ?? []).map((s, i) => `${s.step ?? i + 1}|${norm(s.actor)}|${norm(s.action)}|${norm(s.expected_result)}`);
    const nxt = p.main_flow.map((s) => `${s.step}|${norm(s.actor)}|${norm(s.action)}|${norm(s.expected_result)}`);
    if (JSON.stringify(cur) !== JSON.stringify(nxt)) {
      d.main_flow = p.main_flow.map((s, i) => ({ ...(spec.main_flow?.[i] ?? {}), step: s.step, actor: s.actor ?? spec.main_flow?.[i]?.actor, action: s.action, expected_result: s.expected_result ?? "" }));
    }
  }
  if (p.rules && JSON.stringify(p.rules.map((r) => `${norm(r.id)}|${norm(r.description)}`)) !== JSON.stringify((spec.rules ?? []).map((r) => `${norm(r.id)}|${norm(r.description)}`))) d.rules = p.rules;
  return d;
}
