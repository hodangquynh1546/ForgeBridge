/** What WorkHub knows about the work on one use case. This is the shape SmartSpec stores and shows. */
export interface Progress {
  issueKey: string;
  issueId: string;
  url: string;
  status: string;
  priority: string | null;
  assignee: { id: string; name: string; avatar: string | null } | null;
  sprint: { name: string; status: string } | null;
  startDate: string | null;
  dueDate: string | null;
  storyPoints: number | null;
  blocked: boolean;
  blockedReason: string | null;
  startedAt: string | null;
  doneAt: string | null;
  childCount: number;
  childDoneCount: number;
  deleted: boolean;
}

export function toProgress(issue: any, publicUrl: string): Progress {
  const avatar = issue.assignee?.avatarUrl ? (String(issue.assignee.avatarUrl).startsWith("http") ? issue.assignee.avatarUrl : publicUrl + issue.assignee.avatarUrl) : null;
  return {
    issueKey: issue.key,
    issueId: issue.id,
    url: `${publicUrl}/issues/${issue.id}`,
    status: issue.status,
    priority: issue.priority ?? null,
    assignee: issue.assignee ? { id: issue.assignee.id, name: issue.assignee.fullName, avatar } : null,
    sprint: issue.sprint ? { name: issue.sprint.name, status: issue.sprint.status } : null,
    startDate: issue.startDate ?? null,
    dueDate: issue.dueDate ?? null,
    storyPoints: issue.storyPoints ?? null,
    blocked: !!issue.blocked,
    blockedReason: issue.blockedReason ?? null,
    startedAt: issue.startedAt ?? null,
    doneAt: issue.doneAt ?? null,
    childCount: issue.childCount ?? 0,
    childDoneCount: issue.childDoneCount ?? 0,
    deleted: false,
  };
}

export const deletedProgress = (issueKey: string, issueId: string, publicUrl: string): Progress => ({
  issueKey, issueId, url: `${publicUrl}/issues/${issueId}`, status: "DELETED", priority: null, assignee: null, sprint: null, startDate: null, dueDate: null,
  storyPoints: null, blocked: false, blockedReason: null, startedAt: null, doneAt: null, childCount: 0, childDoneCount: 0, deleted: true,
});
