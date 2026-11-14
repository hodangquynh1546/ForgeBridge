import type { Config } from "./config.js";

export class WorkHubError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

type Access = { token: string; exp: number; user: { id: string; email: string; fullName: string } };

/** Thin client for WorkHub's REST API; acts as a user through a long-lived integration token. */
export class WorkHubClient {
  private cache = new Map<string, Access>();

  constructor(private cfg: Pick<Config, "workhubApi">) {}

  private async raw(method: string, path: string, body?: unknown, bearer?: string): Promise<any> {
    const res = await fetch(this.cfg.workhubApi + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) {
      throw new WorkHubError(res.status, data?.code ?? `HTTP_${res.status}`, data?.detail ?? data?.title ?? text.slice(0, 200));
    }
    return data;
  }

  /** Signs in (or registers) with e-mail and password and returns a long-lived integration token. */
  connect(input: { email: string; password: string; register?: boolean; fullName?: string }) {
    return this.raw("POST", "/api/integrations/connect", { ...input, tokenName: "ForgeBridge" }) as Promise<{
      token: string;
      user: { id: string; email: string; fullName: string };
      registered: boolean;
    }>;
  }

  /** Who owns this integration token (throws WorkHubError 401 when it is invalid or revoked). */
  async identify(pat: string) {
    await this.access(pat);
    return this.cache.get(pat)!.user;
  }

  private async access(pat: string): Promise<string> {
    const hit = this.cache.get(pat);
    if (hit && hit.exp > Date.now() + 30_000) return hit.token;
    const r = await this.raw("POST", "/api/integrations/token", { token: pat });
    this.cache.set(pat, { token: r.accessToken, exp: Date.now() + r.expiresIn * 1000, user: r.user });
    return r.accessToken;
  }

  async call(pat: string, method: string, path: string, body?: unknown): Promise<any> {
    try {
      return await this.raw(method, path, body, await this.access(pat));
    } catch (e) {
      if (e instanceof WorkHubError && e.status === 401) {
        this.cache.delete(pat); // access token expired early: exchange once more
        return this.raw(method, path, body, await this.access(pat));
      }
      throw e;
    }
  }
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
