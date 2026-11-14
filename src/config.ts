const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8090),
  secret: env.BRIDGE_SECRET ?? "dev-only-bridge-secret-change-me",
  workhubApi: (env.WORKHUB_API_URL ?? "http://localhost:8080").replace(/\/$/, ""),
  workhubPublic: (env.WORKHUB_PUBLIC_URL ?? "http://localhost:5173").replace(/\/$/, ""),
  smartspecApi: (env.SMARTSPEC_API_URL ?? "http://localhost:8000").replace(/\/$/, ""),
  webhookSecret: env.WORKHUB_WEBHOOK_SECRET ?? "dev-only-webhook-secret",
  reconcileMs: Number(env.RECONCILE_SECONDS ?? 300) * 1000,
  githubSecret: env.GITHUB_WEBHOOK_SECRET ?? "",
  gitMergedStatus: (env.GIT_MERGED_STATUS === "DONE" ? "DONE" : "TESTING") as "TESTING" | "DONE",
  dbPath: env.DB_PATH ?? "./data/bridge.db",
};

export type Config = typeof config;
