import type { ProgressBatch, SyncEngine } from "./sync.js";

export type Notifier = (b: ProgressBatch) => Promise<void>;

/**
 * Pulls WorkHub's real state into SmartSpec. Triggered by webhooks (debounced, so a burst of changes is one read) and
 * by a periodic sweep that repairs anything a lost webhook, a restart or a manual database edit left behind.
 */
export class Reconciler {
  private timers = new Map<string, NodeJS.Timeout>();
  private lastSprint = new Map<string, string>();
  private sweep?: NodeJS.Timeout;
  private discoverTimer?: NodeJS.Timeout;

  constructor(private engine: SyncEngine, private notify: Notifier, private log: (m: string) => void = console.warn) {}

  schedule(ssProjectId: string, delayMs = 600) {
    clearTimeout(this.timers.get(ssProjectId));
    this.timers.set(ssProjectId, setTimeout(() => {
      this.timers.delete(ssProjectId);
      this.run(ssProjectId).catch((e) => this.log(`reconcile ${ssProjectId} failed: ${e?.message ?? e}`));
    }, delayMs));
  }

  /** Reads the project now and tells SmartSpec what changed. Returns the number of changed use cases. */
  async run(ssProjectId: string, force = false): Promise<number> {
    await this.engine.syncProjectMeta(ssProjectId).catch((e) => this.log(`meta ${ssProjectId} failed: ${e?.message ?? e}`));
    await this.engine.pullSpec(ssProjectId).catch((e) => this.log(`spec ${ssProjectId} failed: ${e?.message ?? e}`));
    const batch = await this.engine.pullProject(ssProjectId);
    if (!batch) return 0;
    const sprintJson = JSON.stringify(batch.activeSprint);
    const sprintChanged = this.lastSprint.get(ssProjectId) !== sprintJson;
    this.lastSprint.set(ssProjectId, sprintJson);
    if (batch.items.length || sprintChanged || force) await this.notify(batch);
    return batch.items.length;
  }

  /** A project we do not know yet changed in WorkHub: maybe a person just created it there. */
  discover(delayMs = 2_500) {
    clearTimeout(this.discoverTimer);
    this.discoverTimer = setTimeout(() => {
      this.engine.discoverProjects().then((n) => { if (n) for (const id of this.engine.linkedProjectIds()) this.schedule(id, 0); }).catch((e) => this.log(`discover failed: ${e?.message ?? e}`));
    }, delayMs);
  }

  start(everyMs: number) {
    const all = () => {
      this.discover(0);
      for (const id of this.engine.linkedProjectIds()) this.schedule(id, 0);
    };
    setTimeout(all, 5_000);
    this.sweep = setInterval(all, everyMs);
    this.sweep.unref();
  }

  stop() {
    clearInterval(this.sweep);
    for (const t of this.timers.values()) clearTimeout(t);
  }
}
