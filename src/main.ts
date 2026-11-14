import { config } from "./config.js";
import { openDb } from "./db.js";
import { Reconciler } from "./reconcile.js";
import { createServer } from "./server.js";
import { Store } from "./store.js";
import { SyncEngine, type ProgressBatch } from "./sync.js";
import { WorkHubClient } from "./workhub.js";

const store = new Store(openDb(config.dbPath));
const wh = new WorkHubClient(config);
const engine = new SyncEngine(config, store, wh);

/** Tells SmartSpec about progress made in WorkHub so it can show it next to the use case. */
async function notifySmartSpec(batch: ProgressBatch) {
  const res = await fetch(`${config.smartspecApi}/api/integrations/workhub/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bridge-Key": config.secret },
    body: JSON.stringify(batch),
  });
  if (!res.ok) throw new Error(`SmartSpec answered ${res.status}`);
}

const reconciler = new Reconciler(engine, notifySmartSpec);
createServer(config, engine, reconciler, store, wh).listen(config.port, () => {
  console.log(`ForgeBridge listening on :${config.port} (WorkHub ${config.workhubApi}, SmartSpec ${config.smartspecApi})`);
  reconciler.start(config.reconcileMs);
});
