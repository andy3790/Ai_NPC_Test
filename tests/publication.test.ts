import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inspectPublicationFile } from '../scripts/check-publish.js';

const sampleId = 'resp_' + 'ab12'.repeat(12) + 'cd';

test('publication check detects local output and ignores portable sample content', () => {
  for (const path of ['reports/run/detail.json', 'exports/result.csv', 'outputs/review/transcript.txt', 'outputs/review/evidence.json', 'custom/npc.sqlite-wal', '.env.local', 'assets/pack.zip', 'data/runtime.json']) {
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

test('publication check finds provider response IDs in filenames, request chains and free text', () => {
  for (const text of [
    JSON.stringify({ body: { previous_response_id: sampleId } }),
    JSON.stringify({ turnId: sampleId }),
    'Reference: /v1/responses/' + sampleId,
  ]) {
    assert.deepEqual(inspectPublicationFile('review.txt', Buffer.from(text)), ['provider_response_id']);
  }
  assert.deepEqual(inspectPublicationFile(sampleId + '.md', Buffer.alloc(0)), ['provider_response_id']);
  assert.deepEqual(inspectPublicationFile('image.png', Buffer.from('\0' + sampleId)), ['provider_response_id']);
  assert.deepEqual(inspectPublicationFile('calls.jsonl', Buffer.from('{"turnId":"review-turn-1","previous_response_id":null,"promptVersion":"npc-lab/10"}')), []);
});

test('pre-commit checks the actual Git index, masks IDs and permits a clean staged copy', t => {
  const temp = resolve(tmpdir());
  const repo = mkdtempSync(join(temp, 'npc-publication-'));
  t.after(() => {
    assert.equal(dirname(repo), temp);
    rmSync(repo, { recursive: true, force: true });
  });
  const git = (...args: string[]) => spawnSync('git', [
    '--git-dir=.git', '--work-tree=.', '-c', 'core.hooksPath=.githooks', '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args,
  ], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: join(repo, '.git/index') } });
  assert.equal(git('init', '--quiet').status, 0);
  for (const dir of ['scripts', '.githooks']) mkdirSync(join(repo, dir));
  for (const file of ['scripts/check-publish.ts', '.githooks/pre-commit']) {
    copyFileSync(new URL('../' + file, import.meta.url), join(repo, file));
  }
  chmodSync(join(repo, '.githooks/pre-commit'), 0o755);
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}');

  const review = join(repo, 'review.jsonl');
  const namedWithId = join(repo, sampleId + '.txt');
  const clean = '{"turnId":"review-turn-1"}\n', original = JSON.stringify({ turnId: sampleId }) + '\n';
  writeFileSync(review, original);
  writeFileSync(namedWithId, '');
  assert.equal(git('add', '-A').status, 0);
  writeFileSync(review, clean);
  rmSync(namedWithId);
  const blocked = git('commit', '-m', 'First review');
  const output = blocked.stdout + blocked.stderr;
  assert.equal(blocked.status, 1);
  assert.ok(output.includes('review.jsonl') && output.includes('[response-id].txt'));
  assert.ok(!output.includes(sampleId));
  assert.notEqual(git('rev-parse', '--verify', 'HEAD').status, 0);

  assert.equal(git('add', '-A').status, 0);
  writeFileSync(review, original);
  assert.equal(git('commit', '-m', 'Public review').status, 0);
  assert.ok(git('show', 'HEAD:review.jsonl').stdout === clean);
  const head = git('rev-parse', 'HEAD').stdout;
  assert.equal(git('commit', '-am', 'Include working copy').status, 1);
  assert.equal(git('rev-parse', 'HEAD').stdout, head);
});
