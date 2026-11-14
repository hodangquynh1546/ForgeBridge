import type { Db } from "./db.js";

export interface UserLink {
  ss_user_id: string;
  wh_user_id: string;
  email: string;
  full_name: string | null;
  token_enc: string;
  wh_workspace_id: string | null;
  token_id: string | null;
}
export interface ProjectLink {
  ss_project_id: string;
  owner_ss_user_id: string;
  wh_workspace_id: string;
  wh_team_id: string;
  wh_project_id: string;
  wh_project_key: string;
  last_synced_at: string | null;
  last_version: string | null;
  base_name: string | null;
  base_desc: string | null;
  paused: number;
  archived: number;
  wh_prev_status: string | null;
}
export interface DesignLink {
  ss_project_id: string;
  doc_key: string;
  wh_doc_id: string;
  title: string;
  doc_type: string;
  content_hash: string;
  use_case_keys: string; // JSON string[]
  linked_issues: string; // JSON string[] of WorkHub issue ids already linked
  archived: number;
}

export interface EntityLink {
  ss_project_id: string;
  kind: "module" | "usecase" | "testcase";
  ss_key: string;
  wh_issue_id: string;
  wh_key: string;
  content_hash: string;
  wh_status: string | null;
  wh_assignee: string | null;
  wh_sprint: string | null;
  wh_blocked: number;
  removed: number;
  spec_json: string | null;
  progress_json: string | null;
}

const now = () => new Date().toISOString();

export class Store {
  constructor(public db: Db) {}

  user(ssUserId: string) {
    return this.db.prepare("SELECT * FROM user_links WHERE ss_user_id = ?").get(ssUserId) as unknown as UserLink | undefined;
  }
  saveUser(u: Omit<UserLink, "wh_workspace_id" | "token_id"> & { wh_workspace_id?: string | null; token_id?: string | null }) {
    this.db
      .prepare(
        `INSERT INTO user_links (ss_user_id, wh_user_id, email, full_name, token_enc, wh_workspace_id, created_at, token_id)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(ss_user_id) DO UPDATE SET wh_user_id=excluded.wh_user_id, email=excluded.email,
           full_name=excluded.full_name, token_enc=excluded.token_enc, token_id=excluded.token_id,
           wh_workspace_id=CASE WHEN user_links.wh_user_id = excluded.wh_user_id THEN user_links.wh_workspace_id ELSE NULL END`,
      )
      .run(u.ss_user_id, u.wh_user_id, u.email, u.full_name, u.token_enc, u.wh_workspace_id ?? null, now(), u.token_id ?? null);
  }
  setUserWorkspace(ssUserId: string, workspaceId: string) {
    this.db.prepare("UPDATE user_links SET wh_workspace_id = ? WHERE ss_user_id = ?").run(workspaceId, ssUserId);
  }
  deleteUser(ssUserId: string) {
    this.db.prepare("DELETE FROM user_links WHERE ss_user_id = ?").run(ssUserId);
  }

  project(ssProjectId: string) {
    return this.db.prepare("SELECT * FROM project_links WHERE ss_project_id = ?").get(ssProjectId) as unknown as ProjectLink | undefined;
  }
  allUsers() {
    return this.db.prepare("SELECT * FROM user_links").all() as unknown as UserLink[];
  }
  userByEmail(email: string) {
    return this.db.prepare("SELECT * FROM user_links WHERE lower(email) = lower(?)").get(email) as unknown as UserLink | undefined;
  }
  setBase(ssProjectId: string, name: string, desc: string) {
    this.db.prepare("UPDATE project_links SET base_name = ?, base_desc = ? WHERE ss_project_id = ?").run(name, desc, ssProjectId);
  }
  saveProject(p: Omit<ProjectLink, "last_synced_at" | "last_version" | "paused" | "archived" | "wh_prev_status" | "base_name" | "base_desc">) {
    this.db
      .prepare(
        `INSERT INTO project_links (ss_project_id, owner_ss_user_id, wh_workspace_id, wh_team_id, wh_project_id, wh_project_key, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(p.ss_project_id, p.owner_ss_user_id, p.wh_workspace_id, p.wh_team_id, p.wh_project_id, p.wh_project_key, now());
  }
  markSynced(ssProjectId: string, version: string) {
    this.db.prepare("UPDATE project_links SET last_synced_at = ?, last_version = ? WHERE ss_project_id = ?").run(now(), version, ssProjectId);
  }
  setPaused(ssProjectId: string, paused: boolean) {
    this.db.prepare("UPDATE project_links SET paused = ? WHERE ss_project_id = ?").run(paused ? 1 : 0, ssProjectId);
  }
  setArchived(ssProjectId: string, archived: boolean, prevStatus: string | null) {
    this.db.prepare("UPDATE project_links SET archived = ?, wh_prev_status = ? WHERE ss_project_id = ?").run(archived ? 1 : 0, prevStatus, ssProjectId);
  }
  projectsOwnedBy(ssUserId: string) {
    return this.db.prepare("SELECT * FROM project_links WHERE owner_ss_user_id = ?").all(ssUserId) as unknown as ProjectLink[];
  }
  setOwner(ssProjectId: string, ssUserId: string) {
    this.db.prepare("UPDATE project_links SET owner_ss_user_id = ? WHERE ss_project_id = ?").run(ssUserId, ssProjectId);
  }

  entities(ssProjectId: string, kind?: string) {
    return (kind
      ? this.db.prepare("SELECT * FROM entity_links WHERE ss_project_id = ? AND kind = ?").all(ssProjectId, kind)
      : this.db.prepare("SELECT * FROM entity_links WHERE ss_project_id = ?").all(ssProjectId)) as unknown as EntityLink[];
  }
  entity(ssProjectId: string, kind: string, key: string) {
    return this.db
      .prepare("SELECT * FROM entity_links WHERE ss_project_id = ? AND kind = ? AND ss_key = ?")
      .get(ssProjectId, kind, key) as unknown as EntityLink | undefined;
  }
  entityByWhKey(whKey: string) {
    return this.db.prepare("SELECT * FROM entity_links WHERE wh_key = ? AND kind IN ('usecase','testcase') ORDER BY updated_at DESC").get(whKey) as unknown as EntityLink | undefined;
  }
  entityByIssue(issueId: string) {
    return this.db.prepare("SELECT * FROM entity_links WHERE wh_issue_id = ?").get(issueId) as unknown as EntityLink | undefined;
  }
  upsertEntity(e: Pick<EntityLink, "ss_project_id" | "kind" | "ss_key" | "wh_issue_id" | "wh_key" | "content_hash"> & Partial<EntityLink>) {
    this.db
      .prepare(
        `INSERT INTO entity_links (ss_project_id, kind, ss_key, wh_issue_id, wh_key, content_hash, wh_status, wh_assignee, wh_sprint, wh_blocked, removed, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(ss_project_id, kind, ss_key) DO UPDATE SET wh_issue_id=excluded.wh_issue_id, wh_key=excluded.wh_key,
           content_hash=excluded.content_hash, removed=excluded.removed, updated_at=excluded.updated_at`,
      )
      .run(e.ss_project_id, e.kind, e.ss_key, e.wh_issue_id, e.wh_key, e.content_hash, e.wh_status ?? null, e.wh_assignee ?? null,
        e.wh_sprint ?? null, e.wh_blocked ?? 0, e.removed ?? 0, now());
  }
  setProgress(issueId: string, p: { status: string | null; assignee: string | null; sprint: string | null; blocked: boolean }) {
    this.db
      .prepare("UPDATE entity_links SET wh_status=?, wh_assignee=?, wh_sprint=?, wh_blocked=?, updated_at=? WHERE wh_issue_id=?")
      .run(p.status, p.assignee, p.sprint, p.blocked ? 1 : 0, now(), issueId);
  }
  trackedEntities(ssProjectId: string) {
    return this.db.prepare("SELECT kind, ss_key, wh_issue_id, progress_json FROM entity_links WHERE ss_project_id = ? AND kind IN ('usecase','testcase')").all(ssProjectId) as unknown as { kind: "usecase" | "testcase"; ss_key: string; wh_issue_id: string; progress_json: string | null }[];
  }
  setProgressJson(ssProjectId: string, key: string, json: string, status: string | null, assignee: string | null, sprint: string | null, blocked: boolean, kind: "usecase" | "testcase" = "usecase") {
    this.db.prepare("UPDATE entity_links SET progress_json=?, wh_status=?, wh_assignee=?, wh_sprint=?, wh_blocked=?, updated_at=? WHERE ss_project_id=? AND kind=? AND ss_key=?")
      .run(json, status, assignee, sprint, blocked ? 1 : 0, new Date().toISOString(), ssProjectId, kind, key);
  }
  memberLinks(ssProjectId: string) {
    return this.db.prepare("SELECT email, wh_user_id, wh_invitation_id FROM member_links WHERE ss_project_id = ?").all(ssProjectId) as unknown as { email: string; wh_user_id: string | null; wh_invitation_id: string | null }[];
  }
  upsertMemberLink(ssProjectId: string, email: string, whUserId: string | null, invitationId: string | null) {
    this.db.prepare(`INSERT INTO member_links (ss_project_id, email, wh_user_id, wh_invitation_id) VALUES (?,?,?,?)
      ON CONFLICT(ss_project_id, email) DO UPDATE SET wh_user_id=COALESCE(excluded.wh_user_id, member_links.wh_user_id), wh_invitation_id=COALESCE(excluded.wh_invitation_id, member_links.wh_invitation_id)`)
      .run(ssProjectId, email, whUserId, invitationId);
  }
  deleteMemberLink(ssProjectId: string, email: string) {
    this.db.prepare("DELETE FROM member_links WHERE ss_project_id = ? AND email = ?").run(ssProjectId, email);
  }
  projectByWorkhubId(whProjectId: string) {
    return this.db.prepare("SELECT * FROM project_links WHERE wh_project_id = ?").get(whProjectId) as unknown as ProjectLink | undefined;
  }
  allProjects() {
    return this.db.prepare("SELECT * FROM project_links").all() as unknown as ProjectLink[];
  }
  setSpec(ssProjectId: string, kind: string, key: string, spec: unknown) {
    this.db.prepare("UPDATE entity_links SET spec_json=? WHERE ss_project_id=? AND kind=? AND ss_key=?").run(JSON.stringify(spec), ssProjectId, kind, key);
  }
  deleteEntity(ssProjectId: string, kind: string, key: string) {
    this.db.prepare("DELETE FROM entity_links WHERE ss_project_id=? AND kind=? AND ss_key=?").run(ssProjectId, kind, key);
  }
  setRemoved(ssProjectId: string, kind: string, key: string, removed: boolean) {
    this.db.prepare("UPDATE entity_links SET removed=? WHERE ss_project_id=? AND kind=? AND ss_key=?").run(removed ? 1 : 0, ssProjectId, kind, key);
  }

  designLinks(ssProjectId: string) {
    return this.db.prepare("SELECT * FROM design_links WHERE ss_project_id = ?").all(ssProjectId) as unknown as DesignLink[];
  }
  designLink(ssProjectId: string, key: string) {
    return this.db.prepare("SELECT * FROM design_links WHERE ss_project_id = ? AND doc_key = ?").get(ssProjectId, key) as unknown as DesignLink | undefined;
  }
  saveDesignLink(d: Omit<DesignLink, "archived"> & { archived?: number }) {
    this.db.prepare(`INSERT INTO design_links (ss_project_id, doc_key, wh_doc_id, title, doc_type, content_hash, use_case_keys, linked_issues, archived)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(ss_project_id, doc_key) DO UPDATE SET wh_doc_id=excluded.wh_doc_id, title=excluded.title, doc_type=excluded.doc_type,
        content_hash=excluded.content_hash, use_case_keys=excluded.use_case_keys, linked_issues=excluded.linked_issues, archived=excluded.archived`)
      .run(d.ss_project_id, d.doc_key, d.wh_doc_id, d.title, d.doc_type, d.content_hash, d.use_case_keys, d.linked_issues, d.archived ?? 0);
  }
  designLinksForUseCase(ssProjectId: string, useCaseKey: string) {
    return this.designLinks(ssProjectId).filter((d) => !d.archived && (JSON.parse(d.use_case_keys) as string[]).includes(useCaseKey));
  }

  log(ssProjectId: string | null, direction: "ss→wh" | "wh→ss", summary: string) {
    this.db.prepare("INSERT INTO sync_log (at, ss_project_id, direction, summary) VALUES (?,?,?,?)").run(now(), ssProjectId, direction, summary);
  }
  recentLog(ssProjectId: string, limit = 30) {
    return this.db.prepare("SELECT at, direction, summary FROM sync_log WHERE ss_project_id = ? ORDER BY id DESC LIMIT ?").all(ssProjectId, limit);
  }
}
