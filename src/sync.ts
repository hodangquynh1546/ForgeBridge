import type { Config } from "./config.js";
import { decrypt, encrypt } from "./crypto.js";
import { contentHash, moduleSlug, projectKey, toIssueContent, type SsUsecase, moduleOf } from "./mapper.js";
import { deletedProgress, toProgress, type Progress } from "./progress.js";
import type { ProjectLink, Store } from "./store.js";
import { WorkHubClient, WorkHubError } from "./workhub.js";

export class LinkRequiredError extends Error {
  code = "WORKHUB_LINK_REQUIRED";
}
export class NotFoundError extends Error {
  code = "NOT_FOUND";
}
export class ProjectNotLinkedError extends Error {
  code = "PROJECT_NOT_LINKED";
}

export interface SsMember {
  ssUserId: string;
  email: string;
  role: "owner" | "editor" | "viewer";
}

export interface SyncInput {
  actorSsUserId: string;
  project: { id: string; name: string; description?: string };
  version: { id: string; number?: string };
  usecases: SsUsecase[];
  members?: SsMember[];
}

export interface SyncResult {
  workhub: WorkhubRef;
  created: number;
  updated: number;
  flagged: number;
  unchanged: number;
  provisioned: boolean;
}

export interface WorkhubRef {
  workspaceId: string;
  teamId: string;
  projectId: string;
  projectKey: string;
  url: string;
}

/** Progress changes of one SmartSpec project, to be shown/stored by SmartSpec. */
export interface ProgressBatch {
  ssProjectId: string;
  items: { ssKey: string; kind: "usecase" | "testcase"; progress: Progress }[];
  activeSprint: { name: string; goal: string | null; startDate: string | null; endDate: string | null } | null;
}

export interface TestcaseReport {
  key: string;
  title: string;
  description?: string;
  status: "failed" | "passed" | "blocked" | string;
  test_type?: string;
  severity?: string;
  priority?: string;
  preconditions?: string[];
  steps: { step?: number; action?: string; expected?: string }[];
  expected?: string;
  actual?: string;
  exceptions?: string[];
  environment?: string | null;
  executedAt?: string | null;
  useCaseKeys: string[];
}

const MEMBER_ROLE = { editor: "DEVELOPER", viewer: "STAKEHOLDER" } as const;

/** Computes what to create/update in WorkHub for a SmartSpec snapshot, and reads progress back. SmartSpec owns spec text; WorkHub owns progress. */
export class SyncEngine {
  private chains = new Map<string, Promise<unknown>>();

  constructor(private cfg: Config, private store: Store, private wh: WorkHubClient) {}

  // ---------- account linking ----------

  async linkUser(input: { ssUserId: string; email: string; password: string; register?: boolean; fullName?: string }) {
    const r = await this.wh.connect({ email: input.email, password: input.password, register: input.register, fullName: input.fullName });
    this.store.saveUser({
      ss_user_id: input.ssUserId,
      wh_user_id: r.user.id,
      email: r.user.email,
      full_name: r.user.fullName,
      token_enc: encrypt(r.token, this.cfg.secret),
    });
    const joined = await this.acceptPendingInvitations(input.ssUserId).catch(() => 0);
    return { email: r.user.email, fullName: r.user.fullName, registered: r.registered, projectsJoined: joined };
  }

  userStatus(ssUserId: string) {
    const u = this.store.user(ssUserId);
    return u ? { linked: true as const, email: u.email, fullName: u.full_name } : { linked: false as const };
  }

  private pat(ssUserId: string): string {
    const u = this.store.user(ssUserId);
    if (!u) throw new LinkRequiredError("User has not linked a WorkHub account");
    return decrypt(u.token_enc, this.cfg.secret);
  }

  /** Project invitations that were sent before this person had a WorkHub account are accepted as soon as they link one. */
  private async acceptPendingInvitations(ssUserId: string): Promise<number> {
    const pat = this.pat(ssUserId);
    const known = new Set(this.store.allProjects().map((p) => p.wh_project_id));
    const mine: any[] = await this.wh.call(pat, "GET", "/api/me/invitations");
    let n = 0;
    for (const inv of mine) {
      if (inv.projectId && known.has(inv.projectId)) {
        await this.wh.call(pat, "POST", `/api/me/invitations/${inv.id}/accept`).then(() => n++).catch(() => undefined);
      }
    }
    return n;
  }

  // ---------- project sync (SmartSpec → WorkHub) ----------

  /** One sync per SmartSpec project at a time; the next one starts after the previous finished. */
  sync(input: SyncInput): Promise<SyncResult> {
    return this.serial(input.project.id, () => this.doSync(input));
  }

  private serial<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(projectId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    this.chains.set(projectId, run);
    run.finally(() => {
      if (this.chains.get(projectId) === run) this.chains.delete(projectId);
    }).catch(() => undefined);
    return run;
  }

  private async doSync(input: SyncInput): Promise<SyncResult> {
    const { project } = input;
    this.pat(input.actorSsUserId); // fail fast when the actor has no link
    let link = this.store.project(project.id);
    let provisioned = false;
    if (!link) {
      link = await this.provision(input);
      provisioned = true;
    } else if (!this.store.user(link.owner_ss_user_id)) {
      this.store.setOwner(project.id, input.actorSsUserId); // owner unlinked: the actor takes over
      link = this.store.project(project.id)!;
    }
    const pat = this.pat(link.owner_ss_user_id);
    const pid = link.wh_project_id;
    const stats = { created: 0, updated: 0, flagged: 0, unchanged: 0 };
    const seen = new Set<string>();

    // Modules → epics
    const epicIds = new Map<string, string>();
    for (const name of new Set(input.usecases.filter((u) => u.type !== "epic").map(moduleOf))) {
      const { id, created } = await this.ensureEpic(pat, pid, project.id, name);
      epicIds.set(name, id);
      if (created) stats.created++;
    }

    // Use cases → issues
    for (const uc of input.usecases) {
      seen.add(uc.key);
      const content = toIssueContent(uc);
      const hash = contentHash(content);
      const existing = this.store.entity(project.id, "usecase", uc.key);
      const parentId = content.type === "EPIC" ? null : epicIds.get(content.module) ?? null;
      if (!existing) {
        await this.createUsecaseIssue(pat, pid, project.id, uc, parentId);
        stats.created++;
        continue;
      }
      if (existing.removed) this.store.setRemoved(project.id, "usecase", uc.key, false);
      if (!existing.spec_json) this.store.setSpec(project.id, "usecase", uc.key, uc);
      if (existing.content_hash === hash && !existing.removed) {
        stats.unchanged++;
        continue;
      }
      const progress = existing.progress_json ? (JSON.parse(existing.progress_json) as Progress) : null;
      if (progress?.deleted) {
        stats.unchanged++; // the task was deleted in WorkHub on purpose; recreate only on request
        continue;
      }
      await this.updateIssue(pat, existing.wh_issue_id, content, parentId, input.version.number);
      this.store.upsertEntity({ ...existing, content_hash: hash, removed: 0 });
      this.store.setSpec(project.id, "usecase", uc.key, uc);
      stats.updated++;
    }

    // Use cases that left the spec: flag once, never delete (work may already be done)
    for (const e of this.store.entities(project.id, "usecase")) {
      if (seen.has(e.ss_key) || e.removed) continue;
      await this.wh
        .call(pat, "POST", `/api/issues/${e.wh_issue_id}/comments`, {
          body: `⚠️ Use case này không còn trong đặc tả SmartSpec (phiên bản ${input.version.number ?? input.version.id}). Hãy xác nhận có còn cần làm không.`,
          mentions: [],
        })
        .catch(() => undefined);
      this.store.setRemoved(project.id, "usecase", e.ss_key, true);
      stats.flagged++;
    }

    if (input.members) await this.syncMembers(link, input.members).catch((e) => console.warn("member sync failed:", e?.message ?? e));

    this.store.markSynced(project.id, input.version.number ?? input.version.id);
    this.store.log(project.id, "ss→wh", `v${input.version.number ?? "?"}: +${stats.created} tạo, ${stats.updated} cập nhật, ${stats.flagged} cảnh báo, ${stats.unchanged} giữ nguyên`);
    return { workhub: this.workhubRef(this.store.project(project.id)!), ...stats, provisioned };
  }

  private async ensureEpic(pat: string, pid: string, ssProjectId: string, name: string) {
    const key = moduleSlug(name);
    const existing = this.store.entity(ssProjectId, "module", key);
    if (existing) return { id: existing.wh_issue_id, created: false };
    const h = contentHash({ title: name, description: "", acceptanceCriteria: "", priority: "MEDIUM", type: "EPIC", module: name });
    const issue = await this.wh.call(pat, "POST", `/api/projects/${pid}/issues`, {
      type: "EPIC",
      title: name.slice(0, 255),
      description: "_Module từ SmartSpec._",
      externalRef: `smartspec:module/${ssProjectId}/${key}`,
      labels: ["smartspec"],
    });
    this.store.upsertEntity({ ss_project_id: ssProjectId, kind: "module", ss_key: key, wh_issue_id: issue.id, wh_key: issue.key, content_hash: h, wh_status: issue.status });
    return { id: issue.id as string, created: true };
  }

  private async createUsecaseIssue(pat: string, pid: string, ssProjectId: string, uc: SsUsecase, parentId: string | null) {
    const content = toIssueContent(uc);
    const issue = await this.wh.call(pat, "POST", `/api/projects/${pid}/issues`, {
      type: content.type,
      title: content.title,
      description: content.description,
      acceptanceCriteria: content.acceptanceCriteria || null,
      priority: content.priority,
      parentId,
      labels: ["smartspec"],
      externalRef: `smartspec:usecase/${ssProjectId}/${uc.key}`,
    });
    this.store.upsertEntity({ ss_project_id: ssProjectId, kind: "usecase", ss_key: uc.key, wh_issue_id: issue.id, wh_key: issue.key, content_hash: contentHash(content), wh_status: issue.status });
    this.store.setSpec(ssProjectId, "usecase", uc.key, uc);
    this.store.setProgressJson(ssProjectId, uc.key, JSON.stringify(toProgress(issue, this.cfg.workhubPublic)), issue.status, null, null, false);
    return issue;
  }

  private async updateIssue(pat: string, issueId: string, c: ReturnType<typeof toIssueContent>, parentId: string | null, version?: string) {
    const detail = await this.wh.call(pat, "GET", `/api/issues/${issueId}`);
    const cur = detail.issue;
    await this.wh.call(pat, "PUT", `/api/issues/${issueId}`, {
      type: c.type,
      title: c.title,
      description: c.description,
      priority: c.priority,
      refinement: cur.refinement,
      parentId: parentId ?? cur.parent?.id ?? null,
      startDate: cur.startDate,
      dueDate: cur.dueDate,
      storyPoints: cur.storyPoints,
      originalEstimateMinutes: cur.originalEstimateMinutes,
      remainingEstimateMinutes: cur.remainingEstimateMinutes,
      acceptanceCriteria: c.acceptanceCriteria || null,
      labels: cur.labels,
    });
    await this.wh
      .call(pat, "POST", `/api/issues/${issueId}/comments`, {
        body: `🔄 Đặc tả trong SmartSpec đã thay đổi${version ? ` (phiên bản ${version})` : ""}. Mô tả và tiêu chí chấp nhận đã được cập nhật — hãy kiểm tra lại phần đã làm.`,
        mentions: [],
      })
      .catch(() => undefined);
  }

  private async provision(input: SyncInput) {
    const u = this.store.user(input.actorSsUserId)!;
    const pat = this.pat(input.actorSsUserId);
    let workspaceId = u.wh_workspace_id;
    if (workspaceId) {
      try {
        await this.wh.call(pat, "GET", `/api/workspaces/${workspaceId}`); // may have been deleted in WorkHub
      } catch (e) {
        if (e instanceof WorkHubError && e.status === 404) workspaceId = null;
        else throw e;
      }
    }
    if (!workspaceId) {
      const ws = await this.wh.call(pat, "POST", "/api/workspaces", {
        name: `SmartSpec · ${u.full_name || u.email}`.slice(0, 100),
        description: "Tạo tự động từ SmartSpec.",
      });
      workspaceId = ws.id as string;
      this.store.setUserWorkspace(u.ss_user_id, workspaceId);
    }
    const team = await this.retryName(input.project.name, (name) =>
      this.wh.call(pat, "POST", `/api/workspaces/${workspaceId}/teams`, { name, description: "Tạo tự động từ SmartSpec." }),
    );
    const baseKey = projectKey(input.project.name);
    let project: any;
    for (let i = 0; i < 20 && !project; i++) {
      const key = i === 0 ? baseKey : baseKey.slice(0, 10 - String(i + 1).length) + (i + 1);
      try {
        project = await this.wh.call(pat, "POST", `/api/teams/${team.id}/projects`, {
          key,
          name: input.project.name.slice(0, 100),
          description: (input.project.description ?? "").slice(0, 2000) || null,
          methodology: "SCRUM",
        });
      } catch (e) {
        if (!(e instanceof WorkHubError && e.status === 409)) throw e;
      }
    }
    if (!project) throw new Error("Could not find a free WorkHub project key");
    this.store.saveProject({
      ss_project_id: input.project.id,
      owner_ss_user_id: input.actorSsUserId,
      wh_workspace_id: workspaceId,
      wh_team_id: team.id,
      wh_project_id: project.id,
      wh_project_key: project.key,
    });
    return this.store.project(input.project.id)!;
  }

  private async retryName<T>(base: string, create: (name: string) => Promise<T>): Promise<T> {
    for (let i = 1; i <= 10; i++) {
      try {
        return await create((i === 1 ? base : `${base} (${i})`).slice(0, 100));
      } catch (e) {
        if (!(e instanceof WorkHubError && e.status === 409)) throw e;
      }
    }
    throw new Error("Could not find a free name in WorkHub");
  }

  // ---------- members (SmartSpec project members → WorkHub project members) ----------

  /**
   * Assignment happens in WorkHub, so everyone on the SmartSpec project must be selectable there. Only people this
   * Bridge added are ever removed or re-roled: anyone added by hand in WorkHub is left alone.
   */
  private async syncMembers(link: ProjectLink, members: SsMember[]) {
    const ownerPat = this.pat(link.owner_ss_user_id);
    const pid = link.wh_project_id;
    const list = async (): Promise<any[]> => this.wh.call(ownerPat, "GET", `/api/projects/${pid}/members`);
    const current = await list();
    const byEmail = new Map(current.map((m) => [String(m.email).toLowerCase(), m]));
    const desired = new Map<string, { m: SsMember; role: string }>();
    for (const m of members) {
      if (m.ssUserId === link.owner_ss_user_id || m.role === "owner") continue;
      const linked = this.store.user(m.ssUserId);
      desired.set((linked?.email ?? m.email).toLowerCase(), { m, role: MEMBER_ROLE[m.role] ?? "DEVELOPER" });
    }
    const tracked = new Map(this.store.memberLinks(link.ss_project_id).map((r) => [r.email, r]));

    // add / re-role
    for (const [email, { m, role }] of desired) {
      const there = byEmail.get(email);
      if (there) {
        if (tracked.has(email)) this.store.upsertMemberLink(link.ss_project_id, email, there.userId, null); // only people we added are ours to manage
        const roles: string[] = there.roles ?? [there.role];
        if (tracked.has(email) && !(roles.length === 1 && roles[0] === role)) {
          await this.wh.call(ownerPat, "PUT", `/api/projects/${pid}/members/${there.userId}`, { roles: [role] }).catch(() => undefined);
          this.store.log(link.ss_project_id, "ss→wh", `Đổi vai trò ${email} → ${role}`);
        }
        continue;
      }
      let invitation: any;
      try {
        invitation = (await this.wh.call(ownerPat, "POST", `/api/projects/${pid}/invitations`, { kind: "EMAIL", email, role })).invitation;
      } catch (e) {
        if (e instanceof WorkHubError && e.status === 409) continue; // already invited
        throw e;
      }
      this.store.upsertMemberLink(link.ss_project_id, email, null, invitation.id);
      if (this.store.user(m.ssUserId)) {
        await this.wh.call(this.pat(m.ssUserId), "POST", `/api/me/invitations/${invitation.id}/accept`).catch(() => undefined);
        this.store.log(link.ss_project_id, "ss→wh", `Thêm ${email} vào dự án WorkHub`);
      } else {
        this.store.log(link.ss_project_id, "ss→wh", `Đã mời ${email} (chưa có tài khoản WorkHub liên kết)`);
      }
    }

    // record WorkHub user ids of people who just joined, so they can be removed later
    const after = await list();
    for (const r of this.store.memberLinks(link.ss_project_id)) {
      if (!r.wh_user_id) {
        const hit = after.find((a) => String(a.email).toLowerCase() === r.email);
        if (hit) this.store.upsertMemberLink(link.ss_project_id, r.email, hit.userId, null);
      }
    }

    // remove people who left the SmartSpec project
    for (const r of this.store.memberLinks(link.ss_project_id)) {
      if (desired.has(r.email)) continue;
      const member = after.find((a) => String(a.email).toLowerCase() === r.email);
      try {
        if (member) await this.wh.call(ownerPat, "DELETE", `/api/projects/${pid}/members/${member.userId}`);
        else if (r.wh_invitation_id) await this.wh.call(ownerPat, "DELETE", `/api/invitations/${r.wh_invitation_id}`);
      } catch (e) {
        if (!(e instanceof WorkHubError && [404, 409].includes(e.status))) throw e;
      }
      this.store.deleteMemberLink(link.ss_project_id, r.email);
      this.store.log(link.ss_project_id, "ss→wh", `Gỡ ${r.email} khỏi dự án WorkHub (đã rời SmartSpec)`);
    }
  }

  // ---------- progress (WorkHub → SmartSpec) ----------

  /** Reads the current state of every linked issue of the project and returns only what changed since last time. */
  pullProject(ssProjectId: string): Promise<ProgressBatch | null> {
    return this.serial(ssProjectId, () => this.doPull(ssProjectId));
  }

  private async doPull(ssProjectId: string): Promise<ProgressBatch | null> {
    const link = this.store.project(ssProjectId);
    if (!link || !this.store.user(link.owner_ss_user_id)) return null;
    const pat = this.pat(link.owner_ss_user_id);
    const byId = new Map<string, any>();
    for (let page = 0, pages = 1; page < pages && page < 50; page++) {
      const res = await this.wh.call(pat, "GET", `/api/projects/${link.wh_project_id}/issues?size=100&page=${page}`);
      pages = res.totalPages ?? 1;
      for (const i of res.items ?? []) byId.set(i.id, i);
    }
    const items: ProgressBatch["items"] = [];
    for (const row of this.store.trackedEntities(ssProjectId)) {
      const e = this.store.entity(ssProjectId, row.kind, row.ss_key)!;
      const issue = byId.get(row.wh_issue_id);
      const progress = issue ? toProgress(issue, this.cfg.workhubPublic) : deletedProgress(e.wh_key, row.wh_issue_id, this.cfg.workhubPublic);
      const json = JSON.stringify(progress);
      if (json === row.progress_json) continue;
      this.store.setProgressJson(ssProjectId, row.ss_key, json, progress.status, progress.assignee?.name ?? null, progress.sprint?.name ?? null, progress.blocked, row.kind);
      items.push({ ssKey: row.ss_key, kind: row.kind, progress });
      this.store.log(ssProjectId, "wh→ss", progress.deleted ? `${e.wh_key} đã bị xoá ở WorkHub` : `${e.wh_key}${row.kind === "testcase" ? " (bug)" : ""} → ${progress.status}${progress.assignee ? ` (${progress.assignee.name})` : ""}`);
    }
    const sprints: any[] = await this.wh.call(pat, "GET", `/api/projects/${link.wh_project_id}/sprints?status=ACTIVE`).catch(() => []);
    const active = Array.isArray(sprints) ? sprints.find((s) => s.status === "ACTIVE") : null;
    return {
      ssProjectId,
      items,
      activeSprint: active ? { name: active.name, goal: active.goal ?? null, startDate: active.startDate ?? null, endDate: active.endDate ?? null } : null,
    };
  }

  /** Every linked project, used by the periodic reconciliation. */
  linkedProjectIds() {
    return this.store.allProjects().map((p) => p.ss_project_id);
  }

  ssProjectOfWorkhub(whProjectId: string) {
    return this.store.projectByWorkhubId(whProjectId)?.ss_project_id;
  }

  /**
   * Changing status in SmartSpec goes through WorkHub, which stays the owner of the data (and of the history). The
   * acting person's own link is used when they have one and are a member, otherwise the project owner's.
   */
  async changeStatus(ssProjectId: string, ssKey: string, status: string, actorSsUserId: string): Promise<Progress> {
    const link = this.store.project(ssProjectId);
    const e = this.store.entity(ssProjectId, "usecase", ssKey);
    if (!link || !e) throw new NotFoundError("Use case chưa có task trong WorkHub");
    const tokens: string[] = [];
    if (this.store.user(actorSsUserId)) tokens.push(this.pat(actorSsUserId));
    tokens.push(this.pat(link.owner_ss_user_id));
    let lastError: unknown;
    for (const pat of tokens) {
      try {
        const issue = await this.wh.call(pat, "PUT", `/api/issues/${e.wh_issue_id}/status`, { status });
        const progress = toProgress(issue, this.cfg.workhubPublic);
        this.store.setProgressJson(ssProjectId, ssKey, JSON.stringify(progress), progress.status, progress.assignee?.name ?? null, progress.sprint?.name ?? null, progress.blocked);
        this.store.log(ssProjectId, "ss→wh", `${e.wh_key} → ${status} (đổi từ SmartSpec)`);
        return progress;
      } catch (err) {
        lastError = err;
        if (!(err instanceof WorkHubError && (err.status === 403 || err.status === 404))) throw err;
      }
    }
    throw lastError;
  }

  /** A pull request mentioned these task keys: move them and leave a trace. Unknown keys (not from SmartSpec) are ignored. */
  async applyGit(action: { keys: string[]; status: "CODE_REVIEW" | "TESTING" | "IN_PROGRESS" | "DONE" | null; comment: string }): Promise<string[]> {
    const touched: string[] = [];
    for (const key of action.keys) {
      const e = this.store.entityByWhKey(key);
      const link = e && this.store.project(e.ss_project_id);
      if (!e || !link) continue;
      const pat = this.pat(link.owner_ss_user_id);
      const prog = e.progress_json ? (JSON.parse(e.progress_json) as Progress) : null;
      if (prog?.deleted) continue;
      // never pull a finished task backwards because of a PR event
      if (action.status && prog?.status !== "DONE") {
        await this.wh.call(pat, "PUT", `/api/issues/${e.wh_issue_id}/status`, { status: action.status }).catch((err) => console.warn("git status:", err?.message ?? err));
      }
      await this.wh.call(pat, "POST", `/api/issues/${e.wh_issue_id}/comments`, { body: action.comment, mentions: [] }).catch(() => undefined);
      this.store.log(e.ss_project_id, "wh→ss", `${key}: PR → ${action.status ?? "ghi chú"}`);
      touched.push(e.ss_project_id);
    }
    return [...new Set(touched)];
  }

  /** Creates the task again from the last known spec (after it was deleted in WorkHub). */
  async recreate(ssProjectId: string, ssKey: string): Promise<Progress> {
    return this.serial(ssProjectId, async () => {
      const link = this.store.project(ssProjectId);
      const e = this.store.entity(ssProjectId, "usecase", ssKey);
      if (!link || !e?.spec_json) throw new NotFoundError("Không có đặc tả để tạo lại task");
      const uc = JSON.parse(e.spec_json) as SsUsecase;
      const pat = this.pat(link.owner_ss_user_id);
      const epic = await this.ensureEpic(pat, link.wh_project_id, ssProjectId, moduleOf(uc));
      const issue = await this.createUsecaseIssue(pat, link.wh_project_id, ssProjectId, uc, uc.type === "epic" ? null : epic.id);
      this.store.log(ssProjectId, "ss→wh", `Tạo lại task ${issue.key}`);
      return toProgress(issue, this.cfg.workhubPublic);
    });
  }

  // ---------- test cases → bugs ----------

  /** Runs `fn` with the actor's token, falling back to the owner's when the actor has no link or no access. */
  private async asActor<T>(ssProjectId: string, actor: string | undefined, fn: (pat: string) => Promise<T>): Promise<T> {
    const link = this.store.project(ssProjectId)!;
    const tokens: string[] = [];
    if (actor && this.store.user(actor)) tokens.push(this.pat(actor));
    tokens.push(this.pat(link.owner_ss_user_id));
    let last: unknown;
    for (const pat of tokens) {
      try {
        return await fn(pat);
      } catch (e) {
        last = e;
        if (!(e instanceof WorkHubError && (e.status === 403 || e.status === 404))) throw e;
      }
    }
    throw last;
  }

  /** A test case was executed in SmartSpec: failures become Bugs; a later pass is noted on the bug. */
  reportTestcase(input: { actorSsUserId?: string; project: { id: string }; testcase: TestcaseReport }): Promise<{ action: string; progress: Progress | null }> {
    return this.serial(input.project.id, async () => {
      const id = input.project.id;
      const link = this.store.project(id);
      if (!link) throw new ProjectNotLinkedError("Dự án chưa được đồng bộ sang WorkHub");
      const tc = input.testcase;
      const existing = this.store.entity(id, "testcase", tc.key);
      const prev = existing?.progress_json ? (JSON.parse(existing.progress_json) as Progress) : null;
      const alive = !!existing && !prev?.deleted;
      const actor = input.actorSsUserId;

      if (tc.status === "failed") {
        if (!alive) {
          const progress = await this.asActor(id, actor, (pat) => this.createBug(pat, link, tc));
          return { action: "created", progress };
        }
        const note = `❌ Test case chạy lại vẫn thất bại${tc.executedAt ? ` (${tc.executedAt})` : ""}.${tc.actual ? `\n\nKết quả thực tế: ${tc.actual}` : ""}`;
        if (prev!.status === "DONE") {
          await this.asActor(id, actor, async (pat) => {
            await this.wh.call(pat, "PUT", `/api/issues/${existing!.wh_issue_id}/status`, { status: "TO_DO" });
            await this.wh.call(pat, "POST", `/api/issues/${existing!.wh_issue_id}/comments`, { body: `🔁 Mở lại bug: ${note}`, mentions: [] });
          });
          this.store.log(id, "ss→wh", `${existing!.wh_key} mở lại (test case lại thất bại)`);
          return { action: "reopened", progress: prev };
        }
        await this.asActor(id, actor, (pat) => this.wh.call(pat, "POST", `/api/issues/${existing!.wh_issue_id}/comments`, { body: note, mentions: [] }));
        return { action: "commented", progress: prev };
      }
      if (tc.status === "passed" && alive && prev!.status !== "DONE") {
        await this.asActor(id, actor, (pat) => this.wh.call(pat, "POST", `/api/issues/${existing!.wh_issue_id}/comments`, { body: `✅ Test case đã đạt ở lần chạy mới${tc.executedAt ? ` (${tc.executedAt})` : ""}. Có thể đóng bug nếu đã xác nhận.`, mentions: [] }));
        return { action: "passed-note", progress: prev };
      }
      return { action: "none", progress: prev };
    });
  }

  private async createBug(pat: string, link: ProjectLink, tc: TestcaseReport): Promise<Progress> {
    const id = link.ss_project_id;
    const related = tc.useCaseKeys.map((k) => this.store.entity(id, "usecase", k)).filter((e): e is NonNullable<typeof e> => !!e);
    let parentId: string | null = null;
    const first = related[0]?.spec_json ? (JSON.parse(related[0].spec_json) as SsUsecase) : null;
    if (first) parentId = (await this.ensureEpic(pat, link.wh_project_id, id, moduleOf(first))).id;
    const steps = tc.steps.map((s) => `${s.step}. ${s.action}${s.expected ? ` → ${s.expected}` : ""}`);
    const body = [
      `Test case **${tc.title}** thất bại${tc.test_type ? ` (${tc.test_type})` : ""}.`,
      related.length ? `**Use case liên quan:** ${related.map((e) => e.wh_key).join(", ")}` : "",
      tc.description ?? "",
      tc.preconditions?.length ? "**Điều kiện tiên quyết**\n" + tc.preconditions.map((x) => `- ${x}`).join("\n") : "",
      steps.length ? "**Các bước**\n" + steps.join("\n") : "",
      tc.expected ? `**Kỳ vọng:** ${tc.expected}` : "",
      tc.actual ? `**Thực tế:** ${tc.actual}` : "",
      tc.exceptions?.length ? "**Lỗi ghi nhận**\n" + tc.exceptions.map((x) => `- ${x}`).join("\n") : "",
      tc.environment ? `Môi trường: ${tc.environment}` : "",
      "_Tạo tự động từ SmartSpec khi test case thất bại._",
    ].filter(Boolean).join("\n\n").slice(0, 10_000);
    const priority = tc.severity === "critical" ? "CRITICAL" : tc.severity === "major" || tc.priority === "critical" || tc.priority === "high" ? "HIGH" : "MEDIUM";
    const issue = await this.wh.call(pat, "POST", `/api/projects/${link.wh_project_id}/issues`, {
      type: "BUG",
      title: `[Test] ${tc.title}`.slice(0, 255),
      description: body,
      priority,
      parentId,
      labels: ["smartspec", "test-failed"],
      externalRef: `smartspec:testcase/${id}/${tc.key}`,
    });
    const progress = toProgress(issue, this.cfg.workhubPublic);
    this.store.upsertEntity({ ss_project_id: id, kind: "testcase", ss_key: tc.key, wh_issue_id: issue.id, wh_key: issue.key, content_hash: "", wh_status: issue.status });
    this.store.setProgressJson(id, tc.key, JSON.stringify(progress), progress.status, null, null, false, "testcase");
    this.store.log(id, "ss→wh", `Test case "${tc.title}" thất bại → bug ${issue.key}`);
    return progress;
  }

  // ---------- reads for the SmartSpec UI ----------

  private workhubRef(l: { wh_workspace_id: string; wh_team_id: string; wh_project_id: string; wh_project_key: string }): WorkhubRef {
    return {
      workspaceId: l.wh_workspace_id,
      teamId: l.wh_team_id,
      projectId: l.wh_project_id,
      projectKey: l.wh_project_key,
      url: `${this.cfg.workhubPublic}/projects/${l.wh_project_id}`,
    };
  }

  projectStatus(ssProjectId: string) {
    const l = this.store.project(ssProjectId);
    if (!l) return { linked: false as const };
    const items: Record<string, { removed: boolean; progress: Progress | null }> = {};
    for (const e of this.store.entities(ssProjectId, "usecase")) {
      items[e.ss_key] = { removed: !!e.removed, progress: e.progress_json ? (JSON.parse(e.progress_json) as Progress) : null };
    }
    return {
      linked: true as const,
      workhub: this.workhubRef(l),
      lastSyncedAt: l.last_synced_at,
      lastVersion: l.last_version,
      items,
      log: this.store.recentLog(ssProjectId, 10),
    };
  }
}
