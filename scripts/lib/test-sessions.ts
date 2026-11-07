import { appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Adapter } from '../../src/adapters/types.js';
import type { ModelConfig } from '../../src/shared/schema.js';
import type { Engine } from '../../src/core/engine.js';
import { SESSION_CLEANUP_VERSION } from '../../src/core/session-cleanup.js';

// One-shot evaluators have no resume contract. Journal the ID immediately so a
// killed process can be cleaned later without guessing from a thread title.
export class TestSessions {
  private owned = new Set<string>();
  private abort = new AbortController();
  readonly signal = this.abort.signal;
  private interrupt = () => { this.abort.abort(); process.exitCode = 130; };
  constructor(private adapter: Adapter, private root: string) {
    process.once('SIGINT', this.interrupt); process.once('SIGTERM', this.interrupt);
  }
  private record(threadId: string, status: string, error?: string) {
    appendFileSync(join(this.root, 'sessions.jsonl'), JSON.stringify({ version: SESSION_CLEANUP_VERSION, threadId, cwd: this.root, status,
      at: new Date().toISOString(), pid: process.pid, ...(error ? { error } : {}) }) + '\n');
  }
  async create(config: ModelConfig, instructions: string) {
    this.signal.throwIfAborted();
    for (const previous of this.owned) await this.release(previous);
    this.signal.throwIfAborted();
    const id = await this.adapter.createSession(config, instructions, this.root);
    if (this.adapter.deleteSession) { this.owned.add(id); this.record(id, 'created'); }
    return id;
  }
  async release(id: string) {
    if (!this.owned.has(id)) return;
    try {
      const status = await this.adapter.deleteSession!(id, this.root);
      this.record(id, status); this.owned.delete(id);
    } catch (e) { this.record(id, 'pending', String(e)); throw e; }
  }
  async close() {
    const errors: string[] = [];
    try {
      for (const id of this.owned) try { await this.release(id); } catch (e) { errors.push(String(e)); }
    } finally { process.off('SIGINT', this.interrupt); process.off('SIGTERM', this.interrupt); }
    if (errors.length) process.exitCode = 1;
    return errors;
  }
}

// Closing the server means pause/resume. Finishing a stand-alone test means
// stop, including failures; perform that transition before engine.close().
export async function stopTestRuns(engine: Engine) {
  for (const run of engine.store.list('runs')) if (!['completed', 'stopped'].includes(run.status)) await engine.stop(run.id);
  await engine.idle();
}
export const testOwnerKey = (runId: string) => 'codexTestOwner/' + runId;
export function interruptTest(getEngine: () => Engine) {
  // Only claim runs created by this standalone invocation. The change event
  // fires synchronously after insert and before the first session is opened.
  const initial = getEngine();
  const seen = new Set(initial.store.list('runs').map(r => r.id));
  const recordOwner = ({ runId }: { runId: string }) => {
    if (seen.has(runId)) return;
    initial.store.setting(testOwnerKey(runId), { pid: process.pid, root: resolve(initial.dataDir) });
    seen.add(runId);
  };
  if (initial.adapter.name === 'codex') initial.on('change', recordOwner);
  let pending: Promise<void> | undefined;
  const interrupt = () => { process.exitCode = 130; pending ??= stopTestRuns(getEngine()).catch(e => console.error(String(e))); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  return async () => {
    initial.off('change', recordOwner);
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); await pending;
  };
}
