"""Verify completed 3-NPC, 60-speech delivery comparison exports."""
import csv
import json
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

if len(sys.argv) != 2:
    raise SystemExit('Usage: python scripts/verify-comparison.py reports/<comparison-folder>')
root = Path(sys.argv[1])
results = []
all_calls = []
thread_sets = []
for mode in ['batched_on_turn', 'per_utterance']:
    folder = root / mode
    detail = json.loads((folder / 'detail.json').read_text(encoding='utf-8'))
    calls, utterances, receipts = (detail[k] for k in ['invocations', 'utterances', 'receipts'])
    by_call = {c['id']: c for c in calls}
    by_utterance = {u['id']: u for u in utterances}
    records = [json.loads(line) for line in (folder / 'records.jsonl').read_text(encoding='utf-8-sig').splitlines()]
    with (folder / 'invocations.csv').open(encoding='utf-8-sig', newline='') as stream:
        csv_calls = list(csv.DictReader(stream))
    raw_calls = [r for r in records if r['type'] == 'invocation']
    assert len(by_call) == len(calls) == len(csv_calls) == len(raw_calls)
    totals = [sum(c['usage']['totalTokens'] for c in source) for source in [calls, raw_calls]]
    totals += [sum(int(c['totalTokens']) for c in csv_calls), detail['summary']['tokens']['totalTokens']]
    assert len(set(totals)) == 1, totals
    counts = Counter(c['kind'] for c in calls)
    assert counts == {'speech': 60, 'evaluation': 6, **({'receive': 120} if mode == 'per_utterance' else {})}
    assert all(c['status'] == 'completed' and c['usageStatus'] == 'reported_cumulative_delta' for c in calls)
    assert all(c['durationMs'] is not None and c['queueMs'] is not None for c in calls)
    assert all(c['usage']['totalTokens'] == c['usage']['inputTokens'] + c['usage']['outputTokens'] for c in calls)
    assert len(utterances) == 60 and [u['speechIndex'] for u in utterances] == list(range(1, 61))
    assert Counter(u['speakerId'] for u in utterances) == {'yoon': 20, 'doha': 20, 'miru': 20}
    assert len(receipts) == len({r['id'] for r in receipts}) == 120
    seen = defaultdict(set)
    sequences = defaultdict(list)
    for c in calls:
        if c['kind'] not in ['speech', 'receive']:
            continue
        request = json.loads(c['input'])
        messages = request['messages'] if c['kind'] == 'speech' else [request['message']]
        if mode == 'per_utterance' and c['kind'] == 'speech':
            assert not messages
        if c['kind'] == 'receive':
            assert json.loads(c['output']) == {'received': True}
        for message in messages:
            assert message['id'] in by_utterance
            assert message['speakerId'] != c['characterId']
            assert message['id'] not in seen[c['characterId']]
            seen[c['characterId']].add(message['id'])
            sequences[c['characterId']].append(message['sequence'])
    assert all(values == sorted(values) for values in sequences.values())
    for u in utterances:
        destinations = [r for r in receipts if r['utteranceId'] == u['id']]
        assert len(destinations) == 2 and all(r['characterId'] != u['speakerId'] for r in destinations)
        if mode == 'per_utterance':
            assert all(r['status'] == 'delivered' for r in destinations)
            assert u['deliveryCompletedAt'] is not None
            if u['speechIndex'] < 60:
                next_call = by_call[utterances[u['speechIndex']]['invocationId']]
                assert all(by_call[r['invocationId']]['completedAt'] <= next_call['startedAt'] for r in destinations)
    assert sum(r['status'] != 'delivered' for r in receipts) == (3 if mode == 'batched_on_turn' else 0)
    for character_id, ids in seen.items():
        assert ids == {r['utteranceId'] for r in receipts if r['characterId'] == character_id and r['status'] == 'delivered'}
    assert [(e['from'], e['to']) for e in detail['evaluations']] == [(i, i + 9) for i in range(1, 61, 10)]
    assert all(e['status'] == 'completed' and not e['contextTruncated'] for e in detail['evaluations'])
    per_thread = defaultdict(list)
    for c in calls:
        per_thread[c['threadId']].append(c)
    for group in per_thread.values():
        ordered = sorted(group, key=lambda c: c['startedAt'])
        assert all(a['completedAt'] <= b['startedAt'] for a, b in zip(ordered, ordered[1:]))
    item_types = Counter(r['params'].get('item', {}).get('type') for r in records if r['type'] == 'raw_event' and r['method'] == 'item/started')
    assert set(item_types) <= {'userMessage', 'agentMessage', 'reasoning'}
    with zipfile.ZipFile(root / (mode + '.zip')) as archive:
        assert archive.testzip() is None
        assert archive.read('records.jsonl') == (folder / 'records.jsonl').read_bytes()
    thread_sets.append(set(per_thread))
    all_calls.extend(calls)
    results.append({'mode': mode, 'calls': dict(counts), 'totalTokens': totals[0], 'pendingReceipts': detail['summary']['pendingReceipts'], 'checks': 'passed'})
assert thread_sets[0].isdisjoint(thread_sets[1])
timeline = sorted([(c['startedAt'], 1) for c in all_calls] + [(c['completedAt'], -1) for c in all_calls])
active = peak = 0
for _, delta in timeline:
    active += delta
    peak = max(peak, active)
assert peak <= 2
result = {'runs': results, 'isolatedThreads': True, 'maxConcurrentCallsObserved': peak, 'csvJsonlSummaryTokensMatch': True, 'zipIntegrity': 'passed', 'deliveryOrderAndBarrier': 'passed', 'duplicateDeliveryCount': 0, 'toolCalls': 0}
(root / 'verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
