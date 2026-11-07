import { join } from 'node:path';
import type { Adapter } from '../adapters/types.js';
import type { InvocationMetrics, Run } from '../shared/types.js';
import { Store } from './store.js';

export const SESSION_CLEANUP_VERSION = 'codex-session-cleanup/2';

// A terminal run cannot resume. A director call is independently disposable:
// its next attempt always starts a fresh thread, unlike NPC/world/judge calls.
export function disposableSessions(run: Run, calls: InvocationMetrics[]): string[] {
  if (run.adapter !== 'codex') return [];
  const all = new Set([...Object.values(run.sessions), ...Object.values(run.helperSessions)].map(s => s.threadId));
  const byThread = new Map<string, InvocationMetrics[]>();
  for (const call of calls) {
    all.add(call.threadId);
    const list = byThread.get(call.threadId) ?? []; list.push(call); byThread.set(call.threadId, list);
  }
  const terminal = ['completed', 'stopped'].includes(run.status);
  const freshHelpers = new Set(Object.entries(run.helperSessions).filter(([key]) => key === 'director' || key.startsWith('spatial-director-')).map(([, s]) => s.threadId));
  return [...all].filter(threadId => {
    if (['deleted', 'missing'].includes(run.sessionCleanup?.[threadId]?.status ?? '')) return false;
    if (terminal) return true;
    const history = byThread.get(threadId);
    return history?.length ? history.every(c => c.kind === 'director' && ['completed', 'failed', 'cancelled'].includes(c.status)) : freshHelpers.has(threadId);
  });
}

export class SessionCleanup {
  private pending = new Map<string, Promise<void>>();
  constructor(private store: Store, private adapter: Adapter, private dataDir: string) {}
  async beforeReplacement(id: string, threadId: string) {
    if (this.adapter.name !== 'codex' || !this.adapter.deleteSession) return;
    await this.run(id, threadId);
    const state = this.store.get('runs', id)?.sessionCleanup?.[threadId];
    if (state?.status === 'deleted' || state?.status === 'missing') return;
    throw new Error('이전 Codex 진행자 세션의 정리가 끝나면 재개할 수 있습니다. ' + (state?.error ?? '호출 상태 확인 필요'));
  }
  async run(id: string, onlyThreadId?: string) {
    if (!this.adapter.deleteSession || this.adapter.name !== 'codex') return;
    const run = this.store.get('runs', id);
    if (!run || run.adapter !== this.adapter.name) return;
    if (onlyThreadId && ['deleted', 'missing'].includes(run.sessionCleanup?.[onlyThreadId]?.status ?? '')) return;
    const candidates = disposableSessions(run, this.store.list('invocations', id));
    for (const threadId of candidates) {
      if (onlyThreadId && threadId !== onlyThreadId) continue;
      let pending = this.pending.get(threadId);
      if (!pending) {
        pending = this.remove(id, threadId).finally(() => this.pending.delete(threadId));
        this.pending.set(threadId, pending);
      }
      await pending;
    }
  }
  private async remove(id: string, threadId: string) {
    const at = new Date().toISOString();
    let record: NonNullable<Run['sessionCleanup']>[string];
    try {
      record = { status: await this.adapter.deleteSession!(threadId, join(this.dataDir, 'sessions', id)), at };
    } catch (error) {
      record = { status: 'pending', at, error: error instanceof Error ? error.message : String(error) };
    }
    // A failed cleanup must never change a completed dialogue into a failed one,
    // nor discard its retry evidence. Startup/shutdown/next replacement retries.
    const run = this.store.get('runs', id)!;
    this.store.patch('runs', id, { sessionCleanup: { ...run.sessionCleanup, [threadId]: record } });
    this.store.event(id, null, 'session/cleanup', { version: SESSION_CLEANUP_VERSION, threadId, ...record });
  }
}
