import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worldRequestContext } from '../src/core/world-context.js';
import { publicMessage } from '../src/core/prompts.js';
import { initialWorldState } from '../src/core/world.js';
import type { Utterance } from '../src/shared/types.js';
import type { WorldProcess } from '../src/shared/world-schema.js';

test('standalone world rulings keep pending deadlines, closed events and exact action evidence as the history window moves', () => {
  const history: Utterance[] = Array.from({ length: 8 }, (_, i) => ({
    id: 'event-' + i, runId: 'run', sequence: i + 1, speechIndex: null, speakerId: 'world', speakerName: '세계', kind: 'event',
    speech: '관찰 ' + i, action: '', createdAt: '', invocationId: null, deliveryCompletedAt: null, deliveryMs: null,
    worldEvent: { type: 'observation', text: '관찰 ' + i, npcId: null, evidence: null, processId: null, sourceUtteranceId: null,
      virtualSeconds: i, audience: { scope: 'npcs', npcIds: ['mira'], locationIds: [] } },
  }));
  const choice: Utterance = { ...history[0], id: 'choice', sequence: 9, speechIndex: 1, speakerId: 'mira', speakerName: '미라',
    kind: 'speech', speech: '여기요.', action: '손으로 판의 앞을 받친다.', worldEvent: undefined, knownUtteranceIds: ['private-ledger'],
    perception: { locationId: 'landing', virtualSeconds: 8, speechRecipientIds: ['yun'], actionRecipientIds: ['yun'] },
    spatialIntent: { speech: '여기요.', action: '손으로 판의 앞을 받친다.', communication: { mode: 'local', targetNpcIds: [], channelId: null },
      moveToLocationId: null, activityChoice: 'continue' } };
  const due: WorldProcess = { id: 'door', description: '문이 닫힌다.', readyAtSeconds: 24, createdAtSeconds: 0,
    sourceUtteranceId: choice.id, waitingNpcIds: ['mira'], offeredNpcIds: [], status: 'pending', finishedAtSeconds: null, reason: null };
  const state = initialWorldState();
  state.processes = [due, { ...due, id: 'last_mark', status: 'completed', finishedAtSeconds: 8, reason: '눈금이 사라졌다.' }];
  const input = JSON.stringify({ task: 'spatial_resolve', world: '계단참', current: { processes: [due], activities: [{ id: 'board', choice }] },
    changes: [publicMessage(history[7]), publicMessage(choice)] });
  const { scene, tick } = worldRequestContext(input, state, [...history, choice]);
  assert.equal(scene.world, '계단참');
  assert.deepEqual(tick.current.processes, [due]);
  assert.deepEqual(tick.closedProcesses, [{ id: 'last_mark', status: 'completed', finishedAtSeconds: 8, reason: '눈금이 사라졌다.' }]);
  assert.deepEqual(tick.recentResults.map((r: { sequence: number }) => r.sequence), [2, 3, 4, 5, 6, 7]);
  assert.deepEqual(tick.recentResults[0].audience, history[1].worldEvent!.audience);
  assert.equal(tick.changes[0].speech, history[7].speech);
  const evidence = tick.current.activities[0].choice;
  assert.equal(evidence.action, choice.action); assert.equal(evidence.speech, choice.speech);
  assert.deepEqual(evidence.perception, choice.perception); assert.equal(evidence.activityChoice, 'continue');
  assert.equal(evidence.spatialIntent, undefined); assert.equal(evidence.runId, undefined);
  assert.ok(!JSON.stringify(tick).includes('private-ledger'));
});
