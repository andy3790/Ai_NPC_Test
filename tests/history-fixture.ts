// Offline fixtures only: all calls use MockAdapter, including provider labels.
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { exampleSpec } from '../src/shared/example.js';
import { exportFiles } from '../src/core/export.js';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function historyFixture(path: string, provider: string, mode: 'batched_on_turn' | 'per_utterance' = 'batched_on_turn') {
  const store = new Store(path), adapter = new MockAdapter(); adapter.name = provider; adapter.delayMs = 1;
  const engine = new Engine(store, adapter, dirname(path));
  try {
    const spec = exampleSpec('mock-model'); spec.name = `이력 검증용 ${provider}`; spec.maxUtterances = 3;
    delete spec.scenario.environment; spec.variants = [{ ...spec.variants[0], deliveryMode: mode }];
    spec.evaluation.interval = 3;
    const { runs } = await engine.create(spec); await engine.idle(); const id = runs[0].id;
    const first = store.list('utterances', id)[0]; store.patch('utterances', first.id, { speech: '용을 소환한다.' });
    store.put('findings', { id: randomUUID(), runId: id, evaluationId: store.list('evaluations', id)[0].id,
      utteranceId: first.id, category: 'world_expansion', severity: 'high', verdict: 'issue',
      quote: '용을 소환', reference: '모의 설정', explanation: '이력 검증용 지적', review: 'unreviewed', note: '' });
    const detail = engine.detail(id), events = store.events(id);
    return { detail, events, files: exportFiles(detail, events) };
  } finally { await engine.close(); store.close(); }
}
