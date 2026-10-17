import { InvestigationRun, type PipelineDeps } from './investigate.js';

/**
 * In-process job queue. Investigations are persisted with a status, so the
 * queue itself only needs to order work; concurrency is kept low because each
 * investigation runs containers.
 */
export class InvestigationQueue {
  private pending: string[] = [];
  private active = new Set<string>();

  constructor(
    private readonly deps: PipelineDeps,
    private readonly concurrency = 1,
  ) {}

  enqueue(id: string) {
    if (this.pending.includes(id) || this.active.has(id)) return;
    this.pending.push(id);
    this.pump();
  }

  get depth() {
    return this.pending.length + this.active.size;
  }

  position(id: string): number {
    return this.pending.indexOf(id);
  }

  private pump() {
    while (this.active.size < this.concurrency && this.pending.length) {
      const id = this.pending.shift()!;
      this.active.add(id);
      new InvestigationRun(this.deps, id)
        .run()
        .catch(() => undefined)
        .finally(() => {
          this.active.delete(id);
          this.pump();
        });
    }
  }

  /** Resolves when the queue is idle (used by tests and scripts). */
  async drain(pollMs = 200): Promise<void> {
    while (this.depth > 0) await new Promise((r) => setTimeout(r, pollMs));
  }
}
