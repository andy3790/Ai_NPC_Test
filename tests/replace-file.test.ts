import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { replaceFileSync } from '../src/adapters/replace-file.js';

mkdirSync('.cache', { recursive: true });

test('temporary Windows sharing failures retain the old response until atomic replacement succeeds', () => {
  const root = mkdtempSync(resolve('.cache/replace-file-test-'));
  const oldFile = join(root, 'record.json'), pending = oldFile + '.tmp';
  writeFileSync(oldFile, '{"responseId":"previous"}'); writeFileSync(pending, '{"responseId":"completed"}');
  let attempts = 0; const waits: number[] = [];
  replaceFileSync(pending, oldFile, {
    rename: (from, to) => {
      if (++attempts <= 3) throw Object.assign(new Error('sharing lock'), { code: ['EPERM', 'EACCES', 'EBUSY'][attempts - 1] });
      renameSync(from, to);
    },
    wait: ms => { waits.push(ms); assert.equal(JSON.parse(readFileSync(oldFile, 'utf8')).responseId, 'previous'); },
  }, 'win32');
  assert.equal(attempts, 4); assert.deepEqual(waits, [10, 20, 40]);
  assert.equal(JSON.parse(readFileSync(oldFile, 'utf8')).responseId, 'completed');
});

test('persistent sharing failures are bounded and leave both recovery records intact', () => {
  const root = mkdtempSync(resolve('.cache/replace-file-test-'));
  const oldFile = join(root, 'record.json'), pending = oldFile + '.tmp';
  writeFileSync(oldFile, 'previous'); writeFileSync(pending, 'completed');
  const failure = Object.assign(new Error('still locked'), { code: 'EPERM' });
  let attempts = 0, waitMs = 0;
  assert.throws(() => replaceFileSync(pending, oldFile, {
    rename: () => { attempts++; throw failure; }, wait: ms => { waitMs += ms; },
  }, 'win32'), error => error === failure);
  assert.equal(attempts, 6); assert.equal(waitMs, 310);
  assert.equal(readFileSync(oldFile, 'utf8'), 'previous'); assert.equal(readFileSync(pending, 'utf8'), 'completed');
});

test('non-sharing errors and non-Windows failures propagate immediately', () => {
  for (const [code, platform] of [['ENOENT', 'win32'], ['ENOSPC', 'win32'], ['EPERM', 'linux']] as const) {
    const failure = Object.assign(new Error(code), { code }); let attempts = 0;
    assert.throws(() => replaceFileSync('pending', 'saved', {
      rename: () => { attempts++; throw failure; }, wait: () => assert.fail('Unexpected retry'),
    }, platform), error => error === failure);
    assert.equal(attempts, 1);
  }
});
