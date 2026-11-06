import { renameSync } from 'node:fs';

const retryDelaysMs = [10, 20, 40, 80, 160];
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const defaultOperations = {
  rename: renameSync,
  wait: (ms: number) => { Atomics.wait(waitCell, 0, 0, ms); },
};

// A Windows file-sharing lock can briefly prevent atomic replacement. Retry
// only the local rename, never unlink the old record or resend an API request.
// Keep this bounded (310 ms maximum) because adapter persistence is synchronous.
export function replaceFileSync(source: string, destination: string,
  operations = defaultOperations, platform: NodeJS.Platform = process.platform): void {
  for (let attempt = 0; ; attempt++) {
    try { operations.rename(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt === retryDelaysMs.length) throw error;
      operations.wait(retryDelaysMs[attempt]);
    }
  }
}
