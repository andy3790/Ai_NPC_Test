import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectPublicationFile } from '../scripts/check-publish.js';

test('publication check detects local output and ignores portable sample content', () => {
  for (const path of ['reports/run/detail.json', 'exports/result.csv', 'custom/npc.sqlite-wal', '.env.local', 'assets/pack.zip', 'data/runtime.json']) {
    assert.ok(inspectPublicationFile(path, Buffer.from('{}')).includes('local_or_generated_file'), path);
  }
  for (const path of ['src/core/engine.ts', '.env.example', 'assets/npc-canon/characters/person.character.json']) {
    assert.deepEqual(inspectPublicationFile(path, Buffer.from('{"model":"mock-model","path":"images/cast.png"}')), []);
  }
});

test('publication check flags credentials and personal paths without returning their values', () => {
  const samples: Array<[string, string]> = [
    ['sk-' + 'a'.repeat(32), 'possible_openai_key'],
    ['ghp_' + 'b'.repeat(30), 'possible_github_token'],
    ['{"access_' + 'token":"synthetic-value"}', 'oauth_token'],
    ['C:' + '\\Users\\' + 'Example\\project', 'personal_absolute_path'],
    ['/home/' + 'example/project', 'personal_absolute_path'],
  ];
  for (const [value, code] of samples) {
    const result = inspectPublicationFile('sample.json', Buffer.from(value));
    assert.ok(result.includes(code));
    assert.ok(!JSON.stringify(result).includes(value));
  }
});

test('publication check requests review for large files and permits ordinary PNG assets', () => {
  assert.deepEqual(inspectPublicationFile('assets/image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])), []);
  assert.ok(inspectPublicationFile('assets/large.png', Buffer.alloc(10 * 1024 * 1024 + 1)).includes('file_over_10_MiB_review_required'));
});
