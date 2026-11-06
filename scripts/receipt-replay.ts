import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { experimentSchema } from '../src/shared/schema.js';
import type { InvocationMetrics, Utterance } from '../src/shared/types.js';
import type { AdapterEvent, TurnRequest, TurnResult } from '../src/adapters/types.js';

const { values } = parseArgs({ options: { out: { type: 'string', default: '.cache/receipt-audit/replay.json' } } });
const reports = [];
for (const example of ['app-final', 'app-round-robin']) {
  const source = 'docs/reviews/harbor-stability-2026-11-07/' + example;
  const jsonl = async <T>(file: string) => (await readFile(source + '/' + file, 'utf8')).trim().split('\n').map(s => JSON.parse(s) as T);
  const beforeCalls = await jsonl<InvocationMetrics>('each/calls.jsonl'), beforeMessages = await jsonl<Utterance>('each/utterances.jsonl');
  const spec = experimentSchema.parse(JSON.parse(await readFile(source + '/config.json', 'utf8')));
  spec.variants = spec.variants.filter(v => v.deliveryMode === 'per_utterance'); spec.repetitions = 1;
  assert.equal(spec.variants.length, 1);
  const queues = new Map(['speech', 'director'].map(kind => [kind, beforeCalls.filter(c => c.kind === kind && c.status === 'completed')]));
  class ReplayAdapter extends MockAdapter {
    override version = 'receipt-replay/1';
    override async models() {
      return [...new Set(beforeCalls.map(c => c.model))].map(id => ({id,name:id,efforts:['low'],defaultEffort:'low',isDefault:false}));
    }
    override async turn(request: TurnRequest, emit: (event: AdapterEvent) => void): Promise<TurnResult> {
      this.requests.push(request); const input = JSON.parse(request.input);
      const kind = input.task === 'speak' ? 'speech' : input.task === 'direct' ? 'director' : input.task;
      const recorded = queues.get(kind)?.shift();
      let output: string;
      if (kind === 'speech' || kind === 'director') { assert.ok(recorded, kind + ' replay exhausted'); output = recorded.output; }
      else if (kind === 'receive') output = JSON.stringify({received:true});
      else if (kind === 'evaluate') output = JSON.stringify({findings:[],summary:'전달 경로 재생용 모의 평가. 품질 평가가 아닙니다.'});
      else throw Error('Unexpected replay task: ' + kind);
      const result: TurnResult = {turnId:randomUUID(),output,status:'completed',inputRetained:true};
      emit({method:'turn/accepted',params:{threadId:request.threadId,turnId:result.turnId}});
      this.results.set(result.turnId,result); return result;
    }
  }
  const adapter = new ReplayAdapter(), store = new Store(':memory:');
  const engine = new Engine(store, adapter, '.cache/history-test-receipt-replay');
  try {
    const {runs:[run]} = await engine.create(spec); await engine.idle(); const after = engine.detail(run.id);
    assert.equal(after.run.status,'completed',after.run.error ?? '');
    assert.equal(after.utterances.length,beforeMessages.length);
    assert.equal(after.summary.speechCount,beforeMessages.filter(u=>u.kind==='speech').length);
    assert.ok([...queues.values()].every(q=>!q.length));
    const normalize = (call: InvocationMetrics, history: Utterance[]) => {
      const sequence = new Map(history.map(u=>[u.id,u.sequence]));
      const input = JSON.parse(call.input), messages = input.messages ?? [input.message];
      return messages.map((message: any) => ({...message,id:sequence.get(message.id),
        ...(message.resolution ? {resolution:{...message.resolution,sourceUtteranceId:sequence.get(message.resolution.sourceUtteranceId)}} : {})}));
    };
    const beforeReceives = beforeCalls.filter(c=>c.kind==='receive'), afterReceives=after.invocations.filter(c=>c.kind==='receive');
    const observers = [];
    for (const character of spec.scenario.characters) {
      const before = beforeReceives.filter(c=>c.characterId===character.id).flatMap(c=>normalize(c,beforeMessages));
      const current = afterReceives.filter(c=>c.characterId===character.id).flatMap(c=>normalize(c,after.utterances));
      assert.deepEqual(current,before,character.id+' lost, reordered or repeated observations');
      assert.equal(new Set(current.map(m=>m.id)).size,current.length);
      observers.push({characterId:character.id,observations:current.length,sha256:createHash('sha256').update(JSON.stringify(current)).digest('hex')});
    }
    const pairs = beforeReceives.map(c=>c.sourceUtteranceId+':'+c.characterId);
    assert.equal(new Set(pairs).size,pairs.length);
    reports.push({source,sourceRunId:beforeCalls[0].runId,status:'passed',speechCount:after.summary.speechCount,
      before:{calls:beforeCalls.length,receiveCalls:beforeReceives.length,duplicateRecipientMessagePairs:0},
      after:{calls:after.invocations.length,receiveCalls:afterReceives.length,receiptRows:after.receipts.length,pendingReceipts:after.summary.pendingReceipts,completionReason:after.run.completionReason},
      observers,kind:'Deterministic engine replay with recorded NPC/director outputs. No API call, token, latency or dialogue-quality measurement.'});
  } finally { await engine.close(); store.close(); }
}
const output=resolve(values.out!); await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify({version:'receipt-replay/1',reports},null,2)+'\n');
console.log(JSON.stringify({output,reports},null,2));
