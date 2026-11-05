import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunRefreshCoordinator } from '../src/web/hooks/run-refresh.js';

type Options = ConstructorParameters<typeof RunRefreshCoordinator>[0];
type Runs = Awaited<ReturnType<Options['listRuns']>>;
type Detail = Awaited<ReturnType<Options['getRun']>>;
type Snapshot = Parameters<Options['onChange']>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const detail = (id: string, version = 1) => ({ run: { id, name: `${id}:v${version}` } } as Detail);
const runs = (version = 1) => ['a', 'b', 'c'].map(id => ({ id, name: `${id}:v${version}` })) as Runs;
const nextTick = () => new Promise<void>(resolve => setImmediate(resolve));

function immediateFixture() {
  const versions = new Map([['a', 1], ['b', 1], ['c', 1]]);
  const calls = { list: 0, details: [] as string[] };
  const snapshots: Snapshot[] = [];
  const coordinator = new RunRefreshCoordinator({
    async listRuns() { calls.list++; return runs(); },
    async getRun(id) { calls.details.push(id); return detail(id, versions.get(id)); },
    onChange(snapshot) { snapshots.push(structuredClone(snapshot)); },
  });
  return { coordinator, calls, versions, snapshots };
}

test('deleted runs leave detail and comparison caches and cannot reappear from stale requests', async () => {
  const pending = deferred<Detail>();
  const coordinator = new RunRefreshCoordinator({
    async listRuns() { return runs(); }, getRun: async () => pending.promise, onChange() {},
  });
  try {
    const selection = coordinator.setSelection('a', ['a']);
    coordinator.forgetRun('a');
    pending.resolve(detail('a')); await selection; await coordinator.refresh();
    assert.equal(coordinator.snapshot.detail, null);
    assert.deepEqual(coordinator.snapshot.compared, []);
    assert.equal(coordinator.snapshot.runs.some(run => run.id === 'a'), false);
    await coordinator.setSelection('a', ['a']);
    assert.equal(coordinator.snapshot.detail, null);
  } finally { coordinator.dispose(); }
});

test('SSE refresh updates only the changed visible run and reuses other comparison details', async () => {
  const { coordinator, calls, versions } = immediateFixture();
  try {
    await coordinator.setSelection('a', ['a', 'b']);
    assert.deepEqual(calls.details.sort(), ['a', 'b'], 'selected and compared copies share one request');
    calls.details.length = 0;
    versions.set('a', 2); versions.set('b', 2);

    await coordinator.refresh('a');
    assert.equal(calls.list, 1);
    assert.deepEqual(calls.details, ['a']);
    assert.equal(coordinator.snapshot.detail?.run.name, 'a:v2');
    assert.deepEqual(coordinator.snapshot.compared.map(value => value.run.name), ['a:v2', 'b:v1']);
  } finally { coordinator.dispose(); }
});

test('a batched SSE notification reads the list once and refreshes only its visible run IDs', async () => {
  const { coordinator, calls, versions } = immediateFixture();
  try {
    await coordinator.setSelection('a', ['b', 'c']);
    calls.details.length = 0;
    for (const id of ['a', 'b', 'c']) versions.set(id, 2);
    await coordinator.refreshRuns(['a', 'b', 'a', 'invisible']);
    assert.equal(calls.list, 1);
    assert.deepEqual(calls.details.sort(), ['a', 'b']);
    assert.equal(coordinator.snapshot.detail?.run.name, 'a:v2');
    assert.deepEqual(coordinator.snapshot.compared.map(value => value.run.name), ['b:v2', 'c:v1']);
  } finally { coordinator.dispose(); }
});

test('raw detail cache retains only selected or compared runs', async () => {
  const { coordinator, calls } = immediateFixture();
  try {
    await coordinator.setSelection('a', ['b']);
    await coordinator.setSelection('c', ['b']);
    await coordinator.setSelection('a', ['b']);
    assert.deepEqual(calls.details, ['a', 'b', 'c', 'a'], 'leaving a evicts its detail while the retained b comparison stays cached');
    await coordinator.setSelection('', []);
    assert.equal(coordinator.snapshot.detail, null);
    assert.deepEqual(coordinator.snapshot.compared, []);
    await coordinator.setSelection('', ['b']);
    assert.deepEqual(calls.details, ['a', 'b', 'c', 'a', 'b'], 'removing a comparison evicts its raw detail too');
  } finally { coordinator.dispose(); }
});

test('SSE refresh for an invisible run skips details and reselecting it loads current data', async () => {
  const { coordinator, calls, versions } = immediateFixture();
  try {
    await coordinator.setSelection('c', []);
    await coordinator.setSelection('a', ['b']);
    calls.details.length = 0;
    versions.set('c', 2);
    await coordinator.refresh('c');
    assert.equal(calls.list, 1);
    assert.deepEqual(calls.details, []);
    assert.equal(coordinator.snapshot.detail?.run.name, 'a:v1');

    await coordinator.setSelection('c', []);
    assert.deepEqual(calls.details, ['c']);
    assert.equal(coordinator.snapshot.detail?.run.name, 'c:v2');
  } finally { coordinator.dispose(); }
});

test('reconnect and empty-run notifications refresh all selected and compared details', async () => {
  for (const runId of [undefined, '']) {
    const { coordinator, calls, versions } = immediateFixture();
    try {
      await coordinator.setSelection('a', ['a', 'b']);
      calls.details.length = 0;
      versions.set('a', 2); versions.set('b', 2);
      await coordinator.refresh(runId);
      assert.equal(calls.list, 1);
      assert.deepEqual(calls.details.sort(), ['a', 'b']);
      assert.equal(coordinator.snapshot.detail?.run.name, 'a:v2');
      assert.deepEqual(coordinator.snapshot.compared.map(value => value.run.name), ['a:v2', 'b:v2']);
    } finally { coordinator.dispose(); }
  }
});

test('a failed list or detail fetch releases its in-flight slot for a later refresh', async () => {
  for (const failedSource of ['list', 'detail']) {
    let fail = false, listCalls = 0, detailCalls = 0;
    const coordinator = new RunRefreshCoordinator({
      async listRuns() {
        listCalls++;
        if (fail && failedSource === 'list') throw new Error('fixture list failure');
        return runs(2);
      },
      async getRun(id) {
        detailCalls++;
        if (fail && failedSource === 'detail') throw new Error('fixture detail failure');
        return detail(id, detailCalls);
      },
      onChange() {},
    });
    try {
      await coordinator.setSelection('a', []);
      fail = true;
      await assert.rejects(coordinator.refresh('a'), /fixture .* failure/);
      await nextTick();
      fail = false;
      await coordinator.refresh('a');
      assert.equal(listCalls, 2);
      assert.equal(detailCalls, 3);
      assert.equal(coordinator.snapshot.detail?.run.name, 'a:v3');
      assert.equal(coordinator.snapshot.runs[0].name, 'a:v2');
    } finally { coordinator.dispose(); }
  }
});

test('in-flight SSE bursts coalesce requests while completed responses keep the screen progressing', async () => {
  const pendingLists: ReturnType<typeof deferred<Runs>>[] = [];
  const pendingDetails: ReturnType<typeof deferred<Detail>>[] = [];
  const snapshots: Snapshot[] = [];
  let delayed = false;
  const coordinator = new RunRefreshCoordinator({
    listRuns() { const pending = deferred<Runs>(); pendingLists.push(pending); return pending.promise; },
    getRun(id) {
      assert.equal(id, 'a');
      if (!delayed) return Promise.resolve(detail(id));
      const pending = deferred<Detail>(); pendingDetails.push(pending); return pending.promise;
    },
    onChange(snapshot) { snapshots.push(structuredClone(snapshot)); },
  });
  try {
    await coordinator.setSelection('a', ['a']);
    snapshots.length = 0; delayed = true;
    const first = coordinator.refresh('a');
    await nextTick();
    assert.equal(pendingLists.length, 1);
    assert.equal(pendingDetails.length, 1);
    const duplicates = [coordinator.refresh('a'), coordinator.refresh('a'), coordinator.refresh('a')];
    await nextTick();
    assert.equal(pendingLists.length, 1, 'only one list request can be in flight');
    assert.equal(pendingDetails.length, 1, 'only one request per run can be in flight');

    pendingLists[0].resolve(runs(2)); pendingDetails[0].resolve(detail('a', 2));
    await nextTick();
    assert.equal(pendingLists.length, 2, 'the burst schedules one follow-up list request');
    assert.equal(pendingDetails.length, 2, 'the burst schedules one follow-up detail request');
    assert.equal(coordinator.snapshot.detail?.run.name, 'a:v2', 'ongoing invalidations must not starve visible progress');
    assert.equal(coordinator.snapshot.runs[0].name, 'a:v2');

    const laterEvent = coordinator.refresh('a');
    await nextTick();
    assert.equal(pendingLists.length, 2);
    assert.equal(pendingDetails.length, 2);
    pendingLists[1].resolve(runs(3)); pendingDetails[1].resolve(detail('a', 3));
    await nextTick();
    assert.equal(coordinator.snapshot.detail?.run.name, 'a:v3');
    assert.equal(coordinator.snapshot.runs[0].name, 'a:v3');
    assert.equal(pendingLists.length, 3);
    assert.equal(pendingDetails.length, 3);
    pendingLists[2].resolve(runs(4)); pendingDetails[2].resolve(detail('a', 4));
    await Promise.all([first, ...duplicates, laterEvent]);
    assert.equal(coordinator.snapshot.detail?.run.name, 'a:v4');
    assert.equal(coordinator.snapshot.runs[0].name, 'a:v4');
    assert.equal(pendingLists.length, 3);
    assert.equal(pendingDetails.length, 3);
    const progress = snapshots.flatMap(snapshot => snapshot.detail && snapshot.detail.run.name !== 'a:v1' ? [snapshot.detail.run.name] : []);
    assert.deepEqual([...new Set(progress)], ['a:v2', 'a:v3', 'a:v4']);
  } finally { coordinator.dispose(); }
});

test('rapid selected-run changes discard a late response from both the screen and detail cache', async () => {
  const pending = new Map<string, ReturnType<typeof deferred<Detail>>>();
  const snapshots: Snapshot[] = [];
  const coordinator = new RunRefreshCoordinator({
    async listRuns() { return runs(); },
    getRun(id) { const value = deferred<Detail>(); pending.set(id, value); return value.promise; },
    onChange(snapshot) { snapshots.push(structuredClone(snapshot)); },
  });
  try {
    const first = coordinator.setSelection('a', []);
    await nextTick();
    const second = coordinator.setSelection('b', []);
    await nextTick();
    pending.get('b')!.resolve(detail('b'));
    await second;
    const checkpoint = snapshots.length;
    pending.get('a')!.resolve(detail('a'));
    await first;
    assert.equal(coordinator.snapshot.detail?.run.id, 'b');
    assert.ok(snapshots.slice(checkpoint).every(snapshot => snapshot.detail?.run.id !== 'a'));

    const discarded = pending.get('a');
    const reselected = coordinator.setSelection('a', []);
    await nextTick();
    const beforeReload = coordinator.snapshot;
    assert.equal(beforeReload.detail, null, 'the discarded response cannot reappear when selecting a again');
    assert.notEqual(pending.get('a'), discarded, 'selecting a again starts a fresh detail request');
    pending.get('a')!.resolve(detail('a', 2));
    await reselected;
    assert.equal(coordinator.snapshot.detail?.run.name, 'a:v2');
  } finally { coordinator.dispose(); }
});

test('an invalidated in-flight detail does not fetch again after leaving the visible selection', async () => {
  const pending = new Map<string, ReturnType<typeof deferred<Detail>>>();
  const calls: string[] = [];
  const coordinator = new RunRefreshCoordinator({
    async listRuns() { return runs(); },
    getRun(id) { calls.push(id); const value = deferred<Detail>(); pending.set(id, value); return value.promise; },
    onChange() {},
  });
  try {
    const first = coordinator.setSelection('a', []);
    await nextTick();
    const second = coordinator.setSelection('b', []);
    await nextTick();
    await coordinator.refresh('a');
    pending.get('b')!.resolve(detail('b'));
    await second;
    pending.get('a')!.resolve(detail('a'));
    await first;
    assert.deepEqual(calls, ['a', 'b'], 'the hidden a run must not trigger an automatic follow-up detail request');
    assert.equal(coordinator.snapshot.detail?.run.id, 'b');

    const reselected = coordinator.setSelection('a', []);
    await nextTick();
    assert.deepEqual(calls, ['a', 'b', 'a'], 'the invalidated a cache must be refreshed when visible again');
    pending.get('a')!.resolve(detail('a', 2));
    await reselected;
    assert.equal(coordinator.snapshot.detail?.run.name, 'a:v2');
  } finally { coordinator.dispose(); }
});

test('comparison selection and order stay current when requests finish in reverse order', async () => {
  const pending = new Map<string, ReturnType<typeof deferred<Detail>>>();
  const calls: string[] = [];
  const coordinator = new RunRefreshCoordinator({
    async listRuns() { return runs(); },
    getRun(id) { calls.push(id); const value = deferred<Detail>(); pending.set(id, value); return value.promise; },
    onChange() {},
  });
  try {
    const first = coordinator.setSelection('', ['a', 'b']);
    await nextTick();
    const second = coordinator.setSelection('', ['c', 'b']);
    await nextTick();
    assert.deepEqual(calls.sort(), ['a', 'b', 'c'], 'the retained b comparison shares its in-flight request');
    pending.get('b')!.resolve(detail('b')); pending.get('c')!.resolve(detail('c'));
    await second;
    assert.deepEqual(coordinator.snapshot.compared.map(value => value.run.id), ['c', 'b']);
    pending.get('a')!.resolve(detail('a'));
    await first;
    assert.deepEqual(coordinator.snapshot.compared.map(value => value.run.id), ['c', 'b']);

    await coordinator.setSelection('', ['b', 'c']);
    assert.deepEqual(coordinator.snapshot.compared.map(value => value.run.id), ['b', 'c']);
    assert.equal(calls.length, 3, 'reordering cached comparisons needs no new requests');
  } finally { coordinator.dispose(); }
});

test('disposing a refresh coordinator prevents pending requests from publishing', async () => {
  const pending = deferred<Detail>();
  let notifications = 0;
  const coordinator = new RunRefreshCoordinator({
    async listRuns() { return runs(); }, getRun() { return pending.promise; },
    onChange() { notifications++; },
  });
  const selection = coordinator.setSelection('a', []);
  await nextTick();
  coordinator.dispose();
  const before = notifications;
  pending.resolve(detail('a'));
  await selection;
  assert.equal(notifications, before);
});
