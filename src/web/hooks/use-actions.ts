import { useState } from 'react';
import { errorMessage } from '../api/client.js';

interface ActionOptions { runId?: string; notice?: string }

export function useActions(refresh: (runId?: string) => Promise<void>, onError: (message: string) => void, onNotice: (message: string) => void) {
  const [pending, setPending] = useState(0);
  const action = async (execute: () => Promise<unknown>, options: ActionOptions = {}): Promise<boolean> => {
    setPending(count => count + 1);
    onError('');
    try {
      await execute();
      if (options.notice) onNotice(options.notice);
      // The mutation succeeded. A slow stream of refreshes must not keep controls busy.
      void Promise.resolve().then(() => refresh(options.runId)).catch(error => {
        onError(`동작은 완료되었지만 화면을 새로 고치지 못했습니다: ${errorMessage(error)}`);
      });
      return true;
    } catch (error) { onError(errorMessage(error)); return false; }
    finally { setPending(count => count - 1); }
  };
  return { action, busy: pending > 0 };
}
