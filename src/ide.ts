import { Router, type NextFunction, type Request, type Response } from "express";
import type { Store } from "./store.js";
import { WorkHubClient, WorkHubError } from "./workhub.js";
import type { Config } from "./config.js";

const OPEN = ["TO_DO", "IN_PROGRESS", "CODE_REVIEW", "TESTING"];
const KEY = /^[A-Za-z][A-Za-z0-9]{1,9}-\d+$/;

/** Endpoints for the VS Code extension and the MCP server. The bearer token is the user's WorkHub integration token. */
export function ideRouter(cfg: Config, store: Store, wh: WorkHubClient) {
  const r = Router();

  r.use(async (req: Request, res: Response, next: NextFunction) => {
    const pat = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!pat.startsWith("whk_")) return void res.status(401).json({ code: "NO_TOKEN", message: "Cần token tích hợp WorkHub (whk_…)" });
    try {
      (req as any).pat = pat;
      (req as any).me = await wh.identify(pat);
      next();
    } catch (e) {
      next(e);
    }
  });

  const h = (fn: (req: Request, res: Response, pat: string, me: { id: string }) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, (req as any).pat, (req as any).me).catch(next);

  const slim = (i: any, project: any) => ({
    key: i.key, title: i.title, type: i.type, status: i.status, priority: i.priority, blocked: i.blocked, dueDate: i.dueDate,
    sprint: i.sprint?.name ?? null, project: project.name, projectKey: project.key,
    url: `${cfg.workhubPublic}/issues/${i.id}`, specLinked: !!store.entityByIssue(i.id),
  });

  r.get("/tasks", h(async (_req, res, pat, me) => {
    const projects: any[] = await wh.call(pat, "GET", "/api/me/projects");
    const lists = await Promise.all(projects.map(async (p) => {
      const q = OPEN.map((s) => `status=${s}`).join("&");
      const page = await wh.call(pat, "GET", `/api/projects/${p.id}/issues?assigneeId=${me.id}&${q}&size=100`).catch(() => ({ content: [] }));
      return (page.content ?? page.items ?? []).map((i: any) => slim(i, p));
    }));
    res.json(lists.flat());
  }));

  /** Finds an issue by its key (e.g. SHOP-12) among the projects the caller can see. */
  async function find(pat: string, key: string) {
    if (!KEY.test(key)) throw new WorkHubError(400, "BAD_KEY", "Mã task không hợp lệ (ví dụ SHOP-12)");
    const [prefix, num] = key.toUpperCase().split("-");
    const projects: any[] = await wh.call(pat, "GET", "/api/me/projects");
    const project = projects.find((p) => p.key === prefix);
    if (!project) throw new WorkHubError(404, "ISSUE_NOT_FOUND", `Không thấy dự án ${prefix}`);
    for (let page = 0; page < 20; page++) {
      const res = await wh.call(pat, "GET", `/api/projects/${project.id}/issues?size=200&page=${page}`);
      const items: any[] = res.content ?? res.items ?? [];
      const hit = items.find((i) => i.number === Number(num));
      if (hit) return { issue: hit, project };
      if (items.length < 200) break;
    }
    throw new WorkHubError(404, "ISSUE_NOT_FOUND", `Không thấy ${key}`);
  }

  r.get("/issues/:key", h(async (req, res, pat) => {
    const { issue, project } = await find(pat, String(req.params.key));
    const detail = await wh.call(pat, "GET", `/api/issues/${issue.id}`);
    const link = store.entityByIssue(issue.id);
    res.json({
      ...slim(detail.issue, project),
      description: detail.issue.description,
      acceptanceCriteria: detail.issue.acceptanceCriteria,
      assignee: detail.issue.assignee?.fullName ?? null,
      checklist: detail.checklist,
      epic: detail.issue.epic ? { key: detail.issue.epic.key, title: detail.issue.epic.title } : null,
      spec: link?.spec_json ? JSON.parse(link.spec_json) : null,
      specRemoved: !!link?.removed,
    });
  }));

  r.put("/issues/:key/status", h(async (req, res, pat) => {
    const status = String(req.body?.status ?? "");
    if (!["TO_DO", "IN_PROGRESS", "CODE_REVIEW", "TESTING", "DONE"].includes(status)) return void res.status(400).json({ code: "BAD_STATUS", message: "Trạng thái không hợp lệ" });
    const { issue } = await find(pat, String(req.params.key));
    await wh.call(pat, "PUT", `/api/issues/${issue.id}/status`, { status });
    res.json({ key: issue.key, status });
  }));

  r.post("/issues/:key/comments", h(async (req, res, pat) => {
    const body = String(req.body?.body ?? "").trim();
    if (!body) return void res.status(400).json({ code: "BAD_REQUEST", message: "Thiếu nội dung" });
    const { issue } = await find(pat, String(req.params.key));
    await wh.call(pat, "POST", `/api/issues/${issue.id}/comments`, { body, mentions: [] });
    res.status(201).json({ key: issue.key });
  }));

  return r;
}
