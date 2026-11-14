import type { Config } from "./config.js";
import { hmacHex, safeEqual } from "./crypto.js";

/** Task keys such as SHOP-12 found in a branch name, title or body. */
export function keysIn(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of String(t ?? "").matchAll(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g)) out.add(m[1]);
  return [...out];
}

export function verifyGithubSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!secret) return false; // refuse to accept unsigned webhooks
  return safeEqual(String(header ?? "").replace(/^sha256=/, ""), hmacHex(body, secret));
}

export interface PrAction {
  keys: string[];
  status: "CODE_REVIEW" | "TESTING" | "IN_PROGRESS" | "DONE" | null;
  comment: string;
}

/**
 * What a pull_request event means for the tasks it mentions: opening it puts them in review, merging sends them to
 * testing (QA confirms before DONE; configurable), closing without merging changes nothing.
 */
export function interpretPullRequest(evt: any, cfg: Pick<Config, "gitMergedStatus">): PrAction | null {
  const pr = evt?.pull_request;
  if (!pr) return null;
  const keys = keysIn(pr.head?.ref, pr.title, pr.body);
  if (!keys.length) return null;
  const link = `[#${pr.number} ${pr.title}](${pr.html_url})`;
  const who = pr.user?.login ? ` bởi ${pr.user.login}` : "";
  if (evt.action === "closed" && pr.merged) return { keys, status: cfg.gitMergedStatus, comment: `🔀 Pull request ${link} đã được merge${who}.` };
  if (["opened", "reopened", "ready_for_review"].includes(evt.action) && !pr.draft) return { keys, status: "CODE_REVIEW", comment: `👀 Pull request ${link} đã mở${who}, task chuyển sang review.` };
  if (evt.action === "converted_to_draft") return { keys, status: "IN_PROGRESS", comment: `✏️ Pull request ${link} chuyển về nháp.` };
  return null;
}
