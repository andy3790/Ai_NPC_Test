import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { createApp } from '../src/server/app.js';

test('finding PATCH preserves fields omitted by independent note and review edits', async () => {
  const store = new Store(':memory:'), engine = new Engine(store, new MockAdapter(), '.cache/review-test');
  const app = await createApp(engine);
  store.put('findings', { id: 'finding', runId: 'run', evaluationId: 'eval', utteranceId: 'speech',
    category: 'memory', severity: 'low', verdict: 'issue', quote: 'quote', reference: 'reference', explanation: 'explanation',
    review: 'unreviewed', note: '' });
  const patch = (payload: unknown) => app.inject({ method: 'PATCH', url: '/api/findings/finding', payload: payload as object });
  try {
    assert.equal((await patch({ note: '새 메모' })).statusCode, 200);
    assert.equal((await patch({ review: 'confirmed' })).statusCode, 200);
    assert.equal(store.get('findings', 'finding')!.note, '새 메모');
    assert.equal(store.get('findings', 'finding')!.review, 'confirmed');
    assert.equal((await patch({ review: 'dismissed' })).statusCode, 200);
    assert.equal((await patch({ note: '수정 메모' })).statusCode, 200);
    assert.equal(store.get('findings', 'finding')!.review, 'dismissed');
    assert.equal(store.get('findings', 'finding')!.note, '수정 메모');
    for (const invalid of [{}, { review: 'invalid' }, { note: null }, { note: 'x'.repeat(10001) }, { note: 'ok', unexpected: true }]) {
      assert.equal((await patch(invalid)).statusCode, 400);
    }
    assert.equal((await patch({ note: '' })).statusCode, 200);
    assert.equal(store.get('findings', 'finding')!.note, '');
    assert.equal(store.get('findings', 'finding')!.review, 'dismissed');
  } finally { await app.close(); await engine.close(); store.close(); }
});
