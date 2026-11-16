import { describe, expect, it } from 'vitest';
import { DEFAULT_PROTECTED_PATHS } from '../../src/config/schema.js';
import {
  type ChangedFile,
  checkContents,
  checkDiff,
  isSafePath,
} from '../../src/policy/diff-policy.js';
import { globToRegExp, matchesAny } from '../../src/policy/glob.js';
import { findSecrets, redactSecrets, sanitizeAgentText } from '../../src/policy/secrets.js';

const file = (path: string, overrides: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: 'modified',
  oldMode: '100644',
  newMode: '100644',
  newSha: 'a'.repeat(40),
  added: 1,
  removed: 0,
  ...overrides,
});

const options = {
  protectedPaths: DEFAULT_PROTECTED_PATHS,
  maxAddedLines: 500,
  maxChangedFiles: 60,
};

describe('protected path globs', () => {
  it('matches names without a slash at any depth', () => {
    expect(matchesAny('CODEOWNERS', ['CODEOWNERS'])).toBe('CODEOWNERS');
    expect(matchesAny('docs/CODEOWNERS', ['CODEOWNERS'])).toBe('CODEOWNERS');
    expect(matchesAny('packages/api/AGENTS.md', ['AGENTS.md'])).toBe('AGENTS.md');
    expect(matchesAny('src/codeowners.ts', ['CODEOWNERS'])).toBeUndefined();
  });

  it('anchors patterns with a slash and supports ** and *', () => {
    expect(matchesAny('.github/workflows/ci.yml', ['.github/**'])).toBeDefined();
    expect(matchesAny('src/.github/x', ['.github/**'])).toBeUndefined();
    expect(globToRegExp('src/**/*.sql').test('src/a/b/c.sql')).toBe(true);
    expect(globToRegExp('src/**/*.sql').test('src/c.sql')).toBe(true);
    expect(globToRegExp('src/*.sql').test('src/a/c.sql')).toBe(false);
    expect(matchesAny('.claude/settings.json', ['.claude/**'])).toBeDefined();
  });

  it('treats a directory pattern as covering its contents', () => {
    expect(matchesAny('.devcontainer/devcontainer.json', ['.devcontainer'])).toBeDefined();
  });
});

describe('secret scanning', () => {
  it('finds common credential formats', () => {
    const text = [
      `ghp_${'a'.repeat(36)}`,
      `sk-ant-api03-${'b'.repeat(30)}`,
      'AKIAABCDEFGHIJKLMNOP',
      'https://user:hunter22@example.com/repo.git',
      '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    ].join('\n');
    expect(findSecrets(text).map((finding) => finding.id)).toEqual(
      expect.arrayContaining([
        'github-token',
        'anthropic-key',
        'aws-access-key',
        'credential-url',
        'private-key',
      ]),
    );
    expect(findSecrets('nothing to see here, sk-short')).toEqual([]);
  });

  it('redacts and caps agent text', () => {
    const { text, findings } = redactSecrets(`token ghs_${'c'.repeat(36)} here`);
    expect(text).toBe('token [redacted github-token] here');
    expect(findings).toHaveLength(1);
    const long = sanitizeAgentText(`a${'\u{7}'}b ${'x'.repeat(50)}`, 20);
    expect(long.text).toHaveLength(20);
    expect(long.text.startsWith('ab ')).toBe(true);
    expect(long.truncated).toBe(true);
  });
});

describe('the diff policy', () => {
  it('passes an ordinary change', () => {
    const result = checkDiff([file('src/cart.ts', { added: 30, removed: 4 })], options);
    expect(result).toMatchObject({
      blocked: false,
      keepDraft: false,
      addedLines: 30,
      removedLines: 4,
    });
  });

  it('keeps protected paths, big diffs and many files in draft', () => {
    expect(checkDiff([file('.github/workflows/ci.yml')], options).keepDraft).toBe(true);
    expect(checkDiff([file('src/a.ts', { added: 501 })], options).findings[0]?.code).toBe(
      'too-many-lines',
    );
    const many = Array.from({ length: 61 }, (_, index) => file(`src/f${index}.ts`));
    expect(checkDiff(many, options).findings.map((finding) => finding.code)).toContain(
      'too-many-files',
    );
  });

  it('blocks submodules, unsafe paths and empty diffs', () => {
    expect(checkDiff([file('vendor/lib', { newMode: '160000' })], options).blocked).toBe(true);
    expect(checkDiff([file('../escape.txt')], options).blocked).toBe(true);
    expect(checkDiff([file('.git/hooks/pre-commit')], options).blocked).toBe(true);
    expect(checkDiff([], options).blocked).toBe(true);
  });

  it('notes binaries and symlinks without blocking', () => {
    const result = checkDiff(
      [file('logo.png', { added: null, removed: null }), file('link', { newMode: '120000' })],
      options,
    );
    expect(result.blocked).toBe(false);
    expect(result.keepDraft).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(['binary-file', 'symlink']);
  });

  it('flags secrets in changed files and blocks oversized files', () => {
    const base = checkDiff([file('config.ts')], options);
    const withSecret = checkContents(
      new Map([['config.ts', new TextEncoder().encode(`const key = "sk-ant-${'z'.repeat(30)}";`)]]),
      base,
    );
    expect(withSecret.keepDraft).toBe(true);
    expect(withSecret.findings.at(-1)?.code).toBe('secret-in-diff');
    const big = checkContents(new Map([['big.bin', new Uint8Array(11)]]), base, 10);
    expect(big.blocked).toBe(true);
  });

  it('validates paths', () => {
    expect(isSafePath('src/a.ts')).toBe(true);
    for (const bad of ['', '/etc/passwd', 'a/../b', 'a//b', 'a\\b', './a', 'x/.GIT/config'])
      expect(isSafePath(bad)).toBe(false);
  });
});
