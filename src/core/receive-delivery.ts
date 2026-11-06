import type { DeliveryReceipt, InvocationMetrics, Utterance } from '../shared/types.js';

export const RECEIVE_DELIVERY_VERSION = 'receive-delivery/2';
export interface ReceiveBatch {
  characterId: string; operationKey: string; receipts: DeliveryReceipt[]; messages: Utterance[];
}

// Only an authored outcome committed together with its originating speech may
// share an acknowledgement. Other events and later speeches keep their barriers.
export function receiveBarriers(history: Utterance[], pending: DeliveryReceipt[], calls: InvocationMetrics[]) {
  const byMessage = new Map<string, DeliveryReceipt[]>();
  for (const receipt of pending) {
    const group = byMessage.get(receipt.utteranceId) ?? [];
    group.push(receipt); byMessage.set(receipt.utteranceId, group);
  }
  const previous = new Map(calls.filter(c => c.kind === 'receive').map(c => [c.operationKey, c]));
  const barriers: { messages: Utterance[]; recipients: ReceiveBatch[][] }[] = [];
  for (let i = 0; i < history.length; i++) {
    const first = history[i], next = history[i + 1], messages = [first];
    if (first.kind === 'speech' && next?.kind === 'event' && next.sequence === first.sequence + 1 && next.resolution?.sourceUtteranceId === first.id) {
      messages.push(next); i++;
    }
    const recipients = new Map<string, DeliveryReceipt[]>();
    for (const message of messages) for (const receipt of byMessage.get(message.id) ?? []) {
      const group = recipients.get(receipt.characterId) ?? [];
      group.push(receipt); recipients.set(receipt.characterId, group);
    }
    if (!recipients.size) continue;
    const batches: ReceiveBatch[][] = [];
    for (const [characterId, queue] of recipients) {
      const ordered: ReceiveBatch[] = [];
      while (queue.length) {
        const operationKey = 'receive:' + queue[0].id, prior = previous.get(operationKey);
        let count = 1;
        if (prior) {
          // A persisted request owns its original membership, including old
          // single-message attempts. Never add new input under a reused key.
          const ids = Array.isArray(prior.metadata.receiptIds) ? prior.metadata.receiptIds : [queue[0].id];
          if (!ids.length || ids.some((id, index) => queue[index]?.id !== id)) throw new Error('저장된 수신 묶음과 미전달 기록이 일치하지 않습니다. 자동 재전송하지 않습니다.');
          count = ids.length;
        } else if (queue.length === 2 && !previous.has('receive:' + queue[1].id)) count = 2;
        const receipts = queue.splice(0, count);
        ordered.push({ characterId, operationKey, receipts, messages: receipts.map(r => messages.find(u => u.id === r.utteranceId)!) });
      }
      batches.push(ordered);
    }
    barriers.push({ messages, recipients: batches });
  }
  return barriers;
}
