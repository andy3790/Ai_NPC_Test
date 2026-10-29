import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateDirectory = /(^|\/)(node_modules|dist|data|reports|exports|\.cache|\.codex|\.qa-runtime|test-results|playwright-report)(\/|$)/i;
const privateFile = /(^|\/)(auth|credentials)\.json$|\.(?:db|sqlite3?)(?:-.*)?$|\.(?:zip|pem|key|log)$/i;
const imageFile = /\.(?:png|jpe?g|gif|webp|ico)$/i;
const checks: Array<[string, RegExp]> = [
  ['possible_openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/],
  ['possible_github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['possible_aws_key', /\bAKIA[A-Z0-9]{16}\b/],
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._-]{24,}/],
  ['oauth_token', /"(?:access_token|refresh_token|id_token)"\s*:\s*"[^"\s]+"/],
  ['personal_absolute_path', /[A-Za-z]:[\\/]+Users[\\/]+[^\s"'<>\\/]+|\/(?:Users|home)\/[^\s"'<>/]+/],
];

// Return codes only: never print a matched credential or the surrounding text.
export function inspectPublicationFile(path: string, content: Buffer): string[] {
  const reasons: string[] = [];
  const env = path.split('/').at(-1)!;
  if (privateDirectory.test(path) || privateFile.test(path) ||
    (env.startsWith('.env') && !['.env.example', '.env.sample'].includes(env))) reasons.push('local_or_generated_file');
  if (content.length > 10 * 1024 * 1024) reasons.push('file_over_10_MiB_review_required');
  if (!imageFile.test(path)) {
    const text = content.toString('utf8');
    for (const [code, pattern] of checks) if (pattern.test(text)) reasons.push(code);
  }
  return reasons;
}

export async function checkPublication() {
  // Before git init, use a temporary index to apply this project's real .gitignore.
  // With an existing repo, include tracked files even when they are now ignored.
  const cache = join(root, '.cache');
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(join(cache, 'publish-index-'));
  try {
    const gitDir = join(temporary, 'index.git');
    const hasRepository = existsSync(join(root, '.git'));
    if (!hasRepository) execFileSync('git', ['init', '--bare', '--quiet', gitDir], { cwd: root, stdio: 'pipe' });
    const options = hasRepository ? [] : [`--git-dir=${gitDir}`, `--work-tree=${root}`];
    const files = [...new Set(execFileSync('git', [
      ...options, '-c', `core.excludesFile=${join(temporary, 'no-global-ignore')}`,
      'ls-files', '--cached', '--others', '--exclude-standard', '-z',
    ], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean))].sort();
    const entries: Array<{ path: string; bytes: number; sha256: string }> = [];
    const issues: Array<{ path: string; reasons: string[] }> = [];
    for (const file of files) {
      const absolute = join(root, file);
      if (!existsSync(absolute) || !(await stat(absolute)).isFile()) continue;
      const content = await readFile(absolute);
      const reasons = inspectPublicationFile(file, content);
      if (reasons.length) issues.push({ path: file, reasons });
      entries.push({ path: file, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
    }
    const report = {
      checkedAt: new Date().toISOString(), status: issues.length ? 'failed' : 'passed',
      scope: 'Current working-tree candidates; pattern scan of text and file checks. No archive, image metadata or Git history scan.',
      files: entries.length, bytes: entries.reduce((n, f) => n + f.bytes, 0), issues, entries,
    };
    await mkdir(join(root, '.cache'), { recursive: true });
    await writeFile(join(root, '.cache/publication-manifest.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, files: report.files, MiB: +(report.bytes / 1024 / 1024).toFixed(2), issues, manifest: '.cache/publication-manifest.json' }, null, 2));
    if (issues.length) process.exitCode = 1;
    return report;
  } finally {
    if (dirname(resolve(temporary)) !== cache || !basename(temporary).startsWith('publish-index-')) {
      throw new Error('Unexpected temporary directory; refusing cleanup.');
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkPublication().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
