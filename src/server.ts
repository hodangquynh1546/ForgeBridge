import express, { type NextFunction, type Request, type Response } from "express";
import type { Config } from "./config.js";
import { hmacHex, safeEqual } from "./crypto.js";
import { LinkRequiredError, NotFoundError, ProjectNotLinkedError, type SyncEngine } from "./sync.js";
import type { Reconciler } from "./reconcile.js";
import { WorkHubError, type WorkHubClient } from "./workhub.js";
import { ideRouter } from "./ide.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SmartSpecClient, buildSmartSpecServer } from "./smartspec-mcp.js";
import { interpretPullRequest, verifyGithubSignature } from "./github.js";
import type { Store } from "./store.js";

export function createServer(cfg: Config, engine: SyncEngine, reconciler: Reconciler, store: Store, wh: WorkHubClient) {
  const app = express();

  // Webhook needs the raw body for the HMAC check, so it is mounted before the JSON parser.
  app.post("/webhooks/workhub", express.raw({ type: "*/*", limit: "256kb" }), async (req, res) => {
    const sig = String(req.header("x-workhub-signature") ?? "").replace(/^sha256=/, "");
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !safeEqual(sig, hmacHex(body, cfg.webhookSecret))) {
      return void res.status(401).json({ code: "BAD_SIGNATURE" });
    }
    const evt = JSON.parse(body.toString("utf8"));
    const ssProjectId = evt.type === "project.changed" ? engine.ssProjectOfWorkhub(String(evt.projectId)) : undefined;
    if (ssProjectId) reconciler.schedule(ssProjectId); // read the real state; the event itself carries no data
    else if (evt.type === "project.changed") reconciler.discover(); // unknown project: maybe created in WorkHub just now
    res.status(204).end();
  });

  // GitHub pull request events: a branch/title with a task key moves that task (opened → review, merged → testing).
  app.post("/webhooks/github", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !verifyGithubSignature(cfg.githubSecret, body, req.header("x-hub-signature-256"))) {
      return void res.status(401).json({ code: "BAD_SIGNATURE" });
    }
    if (req.header("x-github-event") !== "pull_request") return void res.status(204).end();
    const action = interpretPullRequest(JSON.parse(body.toString("utf8")), cfg);
    if (action) {
      const projects = await engine.applyGit(action).catch((e) => { console.warn("github webhook failed:", e?.message ?? e); return []; });
      for (const p of projects) reconciler.schedule(p, 300);
    }
    res.status(204).end();
  });

  app.use(express.json({ limit: "20mb" }));

  // WorkHub changed a password: pass it on to SmartSpec.
  app.post("/identity/smartspec/set-password", async (req, res) => {
    if (!safeEqual(String(req.header("x-integration-key") ?? ""), cfg.webhookSecret)) return void res.status(401).end();
    try {
      await fetch(`${cfg.smartspecApi}/api/integrations/workhub/identity/set-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bridge-Key": cfg.secret },
        body: JSON.stringify({ email: req.body?.email, password: req.body?.password }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* SmartSpec is down: it will adopt the newer password on its next sign-in */ }
    res.status(204).end();
  });

  // One account for both systems. WorkHub asks SmartSpec (here) whether an e-mail/password pair is valid there.
  app.post("/identity/smartspec/verify", async (req, res) => {
    if (!safeEqual(String(req.header("x-integration-key") ?? ""), cfg.webhookSecret)) return void res.status(401).json({ status: "unavailable" });
    try {
      const r = await fetch(`${cfg.smartspecApi}/api/integrations/workhub/identity/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bridge-Key": cfg.secret },
        body: JSON.stringify({ email: req.body?.email, password: req.body?.password }),
        signal: AbortSignal.timeout(5000),
      });
      const d: any = r.ok ? await r.json() : { status: "unavailable" };
      res.json({ status: d.status ?? "unavailable", fullName: d.name, emailVerified: d.emailVerified, passwordChangedAt: d.passwordChangedAt });
    } catch {
      res.json({ status: "unavailable" });
    }
  });

  // SmartSpec MCP over HTTP (stateless): each request carries the caller's own SmartSpec token, so every tool acts with
  // that person's access. Add it with: claude mcp add --transport http smartspec <bridge>/mcp/smartspec --header "Authorization: Bearer ssp_…"
  app.all("/mcp/smartspec", async (req, res) => {
    const token = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token.startsWith("ssp_")) return void res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Cần token SmartSpec (ssp_…) trong header Authorization" }, id: null });
    const server = buildSmartSpecServer(new SmartSpecClient(cfg.smartspecApi, token));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e: any) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: e?.message ?? "MCP error" }, id: null });
    }
  });

  app.get("/health", (_req, res) => void res.json({ ok: true }));

  app.use("/ide", ideRouter(cfg, store, wh));

  // Everything under /v1 is server-to-server from SmartSpec's backend.
  app.use("/v1", (req, res, next) => {
    if (!safeEqual(String(req.header("x-bridge-key") ?? ""), cfg.secret)) return void res.status(401).json({ code: "BAD_BRIDGE_KEY" });
    next();
  });

  const h = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

  // SmartSpec asks whether an e-mail/password pair is valid in WorkHub.
  app.post("/v1/identity/workhub/verify", h(async (req, res) => {
    try {
      const r = await wh.verifyIdentity(String(req.body?.email ?? ""), String(req.body?.password ?? ""));
      res.json({ status: r.status, name: r.fullName, emailVerified: r.emailVerified, passwordChangedAt: r.passwordChangedAt });
    } catch {
      res.json({ status: "unavailable" });
    }
  }));

  // SmartSpec changed a password: pass it on to WorkHub.
  app.post("/v1/identity/workhub/set-password", h(async (req, res) => {
    try { await wh.setIdentityPassword(String(req.body?.email ?? ""), String(req.body?.password ?? "")); } catch { /* WorkHub is down: adopted on next sign-in */ }
    res.status(204).end();
  }));

  app.get("/v1/users/:id", h((req, res) => res.json(engine.userStatus(String(req.params.id)))));

  // "Open WorkHub" from SmartSpec: a URL that signs the browser into WorkHub as the same person, then goes to `next`.
  app.post("/v1/users/:id/sso", h(async (req, res) => {
    const u = store.user(String(req.params.id));
    if (!u) throw new LinkRequiredError("User has not linked a WorkHub account");
    const raw = String(req.body?.next ?? "/workspaces");
    const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/workspaces";
    const ticket = await wh.ssoTicket(u.email);
    res.json({ url: `${cfg.workhubPublic}/sso?ticket=${encodeURIComponent(ticket)}&next=${encodeURIComponent(next)}` });
  }));

  app.post("/v1/users/:id/link", h(async (req, res) => {
    const { email, password, register, fullName } = req.body ?? {};
    if (!email || !password) return void res.status(400).json({ code: "BAD_REQUEST", message: "email and password are required" });
    res.json(await engine.linkUser({ ssUserId: String(req.params.id), email, password, register: !!register, fullName }));
  }));

  app.post("/v1/sync", h(async (req, res) => {
    const b = req.body ?? {};
    if (!b.actorSsUserId || !b.project?.id || !Array.isArray(b.usecases)) {
      return void res.status(400).json({ code: "BAD_REQUEST", message: "actorSsUserId, project and usecases are required" });
    }
    res.json(await engine.sync(b));
  }));

  app.post("/v1/testcases/report", h(async (req, res) => {
    const b = req.body ?? {};
    if (!b.project?.id || !b.testcase?.key || !b.testcase?.title) {
      return void res.status(400).json({ code: "BAD_REQUEST", message: "project.id và testcase.key/title là bắt buộc" });
    }
    res.json(await engine.reportTestcase({ ...b, testcase: { steps: [], useCaseKeys: [], ...b.testcase } }));
  }));

  app.post("/v1/projects/:id/items/:key/status", h(async (req, res) => {
    const { status, actorSsUserId } = req.body ?? {};
    if (!["TO_DO", "IN_PROGRESS", "CODE_REVIEW", "TESTING", "DONE"].includes(status) || !actorSsUserId) {
      return void res.status(400).json({ code: "BAD_REQUEST", message: "status và actorSsUserId là bắt buộc" });
    }
    res.json(await engine.changeStatus(String(req.params.id), String(req.params.key), status, actorSsUserId));
  }));

  app.post("/v1/projects/:id/testcases/:key/status", h(async (req, res) => {
    const { status, actorSsUserId } = req.body ?? {};
    if (!["TO_DO", "IN_PROGRESS", "CODE_REVIEW", "TESTING", "DONE"].includes(status) || !actorSsUserId) {
      return void res.status(400).json({ code: "BAD_REQUEST", message: "status và actorSsUserId là bắt buộc" });
    }
    res.json(await engine.changeStatus(String(req.params.id), String(req.params.key), status, actorSsUserId, "testcase"));
  }));

  app.post("/v1/projects/:id/items/:key/recreate", h(async (req, res) => {
    res.json(await engine.recreate(String(req.params.id), String(req.params.key)));
  }));

  app.post("/v1/projects/:id/pause", h((req, res) => {
    engine.setPaused(String(req.params.id), !!req.body?.paused);
    res.json({ paused: !!req.body?.paused });
  }));
  app.post("/v1/projects/:id/archive", h(async (req, res) => res.json(await engine.archiveProject(String(req.params.id)))));
  app.post("/v1/projects/:id/restore", h(async (req, res) => res.json(await engine.restoreProject(String(req.params.id)))));
  app.delete("/v1/users/:id", h(async (req, res) => res.json(await engine.unlinkUser(String(req.params.id)))));

  app.post("/v1/projects/:id/reconcile", h(async (req, res) => {
    res.json({ changed: await reconciler.run(String(req.params.id), true) });
  }));

  app.get("/v1/projects/:id", h((req, res) => res.json(engine.projectStatus(String(req.params.id)))));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ProjectNotLinkedError) return void res.status(409).json({ code: err.code, message: err.message });
    if (err instanceof NotFoundError) return void res.status(404).json({ code: err.code, message: err.message });
    if (err instanceof LinkRequiredError) return void res.status(428).json({ code: err.code, message: err.message });
    if (err instanceof WorkHubError) {
      const status = err.status === 401 && err.code === "INVALID_CREDENTIALS" ? 401 : err.status >= 500 ? 502 : err.status;
      return void res.status(status).json({ code: err.code, message: err.message, source: "workhub" });
    }
    console.error(err);
    res.status(500).json({ code: "INTERNAL", message: "Bridge error" });
  });

  return app;
}
