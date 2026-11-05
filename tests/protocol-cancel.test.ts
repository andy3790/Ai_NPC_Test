import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter } from '../src/adapters/codex.js';
import type { AdapterEvent, TurnRequest } from '../src/adapters/types.js';

type RpcMessage = { id?: number; method?: string; params?: any; result?: unknown };

// Replace only the process transport. Requests, acknowledgements and notifications
// still pass through the adapter's real RPC bookkeeping and event router.
function fakeProtocol() {
  const adapter = new CodexAdapter('.cache/protocol-cancel-unused');
  adapter.resumeSession = async () => {};
  const wire = adapter as unknown as { send(message: RpcMessage): void; message(message: RpcMessage): void };
  const sent: RpcMessage[] = [], events: AdapterEvent[] = [];
  wire.send = message => {
    sent.push(message);
    if (message.method === 'turn/interrupt') wire.message({ id: message.id, result: {} });
  };
  const request: TurnRequest = {
    threadId: 'fixture-thread', config: { model: 'fixture', effort: 'low' },
    input: '{}', outputSchema: {}, clientMessageId: 'fixture-call', timeoutMs: 60_000,
  };
  return {
    adapter, sent, events,
    async begin(signal?: AbortSignal, overrides: Partial<TurnRequest> = {}) {
      const pending = adapter.turn({ ...request, ...overrides }, event => events.push(event), signal);
      await Promise.resolve();
      return { pending, start: sent.filter(message => message.method === 'turn/start').at(-1)! };
    },
    async accept(start: RpcMessage, turnId = 'fixture-turn') {
      wire.message({ id: start.id, result: { turn: { id: turnId } } });
      await Promise.resolve();
    },
    notify(method: string, turnId = 'fixture-turn', status?: string) {
      wire.message({ method, params: { threadId: request.threadId, turn: { id: turnId, status } } });
    },
    interrupts() { return sent.filter(message => message.method === 'turn/interrupt'); },
  };
}

for (const firstId of ['acknowledgement', 'started notification'] as const) {
  test(`Codex cancellation before ${firstId} interrupts once when the turn ID arrives`, async () => {
    const fixture = fakeProtocol(), controller = new AbortController();
    const { pending, start } = await fixture.begin(controller.signal);
    controller.abort();
    assert.equal(fixture.interrupts().length, 0);

    if (firstId === 'acknowledgement') await fixture.accept(start);
    else fixture.notify('turn/started');
    assert.deepEqual(fixture.interrupts().map(message => message.params), [{ threadId: 'fixture-thread', turnId: 'fixture-turn' }]);

    // Both protocol paths can announce the same turn; only one interrupt is needed.
    if (firstId === 'acknowledgement') fixture.notify('turn/started');
    else await fixture.accept(start);
    fixture.notify('turn/started');
    assert.equal(fixture.interrupts().length, 1);
    fixture.notify('turn/completed', 'fixture-turn', 'interrupted');
    assert.equal((await pending).status, 'cancelled');
  });
}

test('Codex cancellation after acceptance interrupts the accepted turn', async () => {
  const fixture = fakeProtocol(), controller = new AbortController();
  const { pending, start } = await fixture.begin(controller.signal);
  await fixture.accept(start);
  assert.equal(fixture.interrupts().length, 0);
  controller.abort();
  assert.equal(fixture.interrupts().length, 1);
  fixture.notify('turn/completed', 'fixture-turn', 'interrupted');
  assert.equal((await pending).status, 'cancelled');
});

test('Codex cancellation before sending does not start a turn', async () => {
  const fixture = fakeProtocol();
  const { pending } = await fixture.begin(AbortSignal.abort());
  assert.equal((await pending).status, 'cancelled');
  assert.deepEqual(fixture.sent, []);
});

for (const firstId of ['acknowledgement', 'started notification'] as const) {
  test(`Codex retains cancellation for a ${firstId} after the grace period`, async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const fixture = fakeProtocol(), controller = new AbortController();
    const { pending, start } = await fixture.begin(controller.signal);
    controller.abort();
    context.mock.timers.tick(5000);
    assert.equal((await pending).status, 'uncertain');
    if (firstId === 'acknowledgement') await fixture.accept(start);
    else fixture.notify('turn/started');
    assert.equal(fixture.interrupts().length, 1);
    if (firstId === 'acknowledgement') fixture.notify('turn/started');
    else await fixture.accept(start);
    assert.equal(fixture.interrupts().length, 1);
    assert.ok(fixture.events.some(event => event.params.turnId === 'fixture-turn' || event.params.turn?.id === 'fixture-turn'));
  });
}

test('Codex deadline and user cancellation share one interrupt and one grace period', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = fakeProtocol(), controller = new AbortController();
  const { pending, start } = await fixture.begin(controller.signal, { timeoutMs: 1000 });
  context.mock.timers.tick(1000);
  controller.abort();
  await fixture.accept(start);
  assert.equal(fixture.interrupts().length, 1);
  context.mock.timers.tick(5000);
  assert.equal((await pending).status, 'uncertain');
});

test('Codex ignores old started and completed notifications after accepting a new turn', async () => {
  const fixture = fakeProtocol();
  const first = await fixture.begin();
  await fixture.accept(first.start, 'old-turn');
  fixture.notify('turn/completed', 'old-turn', 'completed');
  assert.equal((await first.pending).turnId, 'old-turn');

  const second = await fixture.begin(undefined, { clientMessageId: 'second-call' });
  await fixture.accept(second.start, 'new-turn');
  const eventCount = fixture.events.length;
  fixture.notify('turn/started', 'old-turn');
  fixture.notify('turn/completed', 'old-turn', 'completed');
  assert.equal(fixture.events.length, eventCount);
  fixture.notify('turn/completed', 'new-turn', 'completed');
  assert.equal((await second.pending).turnId, 'new-turn');
});

test('Codex late acknowledgement belongs to its original call, not a newer active turn', async () => {
  const fixture = fakeProtocol(), controller = new AbortController();
  const first = await fixture.begin(controller.signal);
  fixture.notify('turn/started', 'old-turn');
  controller.abort();
  fixture.notify('turn/completed', 'old-turn', 'interrupted');
  assert.equal((await first.pending).status, 'cancelled');

  const second = await fixture.begin(undefined, { clientMessageId: 'second-call' });
  await fixture.accept(second.start, 'new-turn');
  await fixture.accept(first.start, 'old-turn');
  assert.deepEqual(fixture.interrupts().map(message => message.params.turnId), ['old-turn']);
  fixture.notify('turn/completed', 'new-turn', 'completed');
  assert.equal((await second.pending).turnId, 'new-turn');
});
