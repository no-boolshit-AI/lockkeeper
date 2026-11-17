import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/agent/claude-code.js';
import { runDemo, SAMPLE_SHA, seedSample } from '../../src/demo/demo.js';
import { commitId, type TreeFile } from '../../src/demo/git-objects.js';
import { SAMPLE_COMMIT, SAMPLE_FILES } from '../../src/demo/sample.js';
import { LocalSandboxProvider, makeBinDir, waitForAgents } from '../support/local-sandbox.js';

/** What git itself makes of these files, with the same author, date and message. */
function gitCommit(root: string, files: readonly TreeFile[]): string {
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  for (const file of files) {
    mkdirSync(dirname(join(repo, file.path)), { recursive: true });
    writeFileSync(join(repo, file.path), file.content);
  }
  writeFileSync(join(root, 'message.txt'), `${SAMPLE_COMMIT.message}\n`);
  const when = `@${SAMPLE_COMMIT.epoch} +0000`;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: SAMPLE_COMMIT.name,
    GIT_AUTHOR_EMAIL: SAMPLE_COMMIT.email,
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_NAME: SAMPLE_COMMIT.name,
    GIT_COMMITTER_EMAIL: SAMPLE_COMMIT.email,
    GIT_COMMITTER_DATE: when,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '-A');
  const tree = git('write-tree');
  return git('commit-tree', tree, '-F', join(root, 'message.txt'));
}

const SUMMARY = [
  'export function cartSummary(items, discountPercent = 0) {',
  '  const count = itemCount(items);',
  "  const noun = count === 1 ? 'item' : 'items';",
  "  return count + ' ' + noun + ' · ' + formatPrice(cartTotal(items, discountPercent));",
  '}',
].join('\n');

const SUMMARY_TEST = [
  "import assert from 'node:assert/strict';",
  "import { test } from 'node:test';",
  "import { cartSummary } from '../src/cart.js';",
  '',
  "test('summarises a cart', () => {",
  "  const coffee = { name: 'Coffee', priceCents: 350, quantity: 2 };",
  "  const bagel = { name: 'Bagel', priceCents: 225, quantity: 1 };",
  "  assert.equal(cartSummary([coffee, bagel]), '3 items · €9.25');",
  "  assert.equal(cartSummary([bagel]), '1 item · €2.25');",
  '});',
  '',
].join('\n');

const REPORT = `Added cartSummary.\n<lockkeeper-report>\n${JSON.stringify({
  summary: 'Added cartSummary to src/cart.js, with tests.',
  criteria: [
    {
      criterion: 'cartSummary of two coffees and a bagel returns "3 items · €9.25"',
      met: true,
      evidence: 'test/summary.test.js',
    },
    { criterion: 'A single item reads "1 item"', met: true, evidence: 'test/summary.test.js' },
    {
      criterion: 'The discount applies, as it does in cartTotal',
      met: true,
      evidence: 'cartSummary calls cartTotal',
    },
    { criterion: 'Tests cover the new function', met: true, evidence: 'test/summary.test.js' },
  ],
  tests: ['test/summary.test.js'],
  risks: [],
})}\n</lockkeeper-report>`;

const READY = `<lockkeeper-readiness>\n${JSON.stringify({
  verdict: 'ready',
  plan: 'Add cartSummary next to cartTotal.',
})}\n</lockkeeper-readiness>`;

describe('lockkeeper demo', () => {
  let root: string | undefined;
  let sandboxes: LocalSandboxProvider | undefined;

  afterEach(async () => {
    if (sandboxes) await waitForAgents(sandboxes.sandboxes);
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
    sandboxes = undefined;
  });

  it('knows the sample commit git will make', () => {
    root = mkdtempSync(join(tmpdir(), 'lockkeeper-demo-'));
    expect(gitCommit(root, SAMPLE_FILES)).toBe(SAMPLE_SHA);
  });

  it('sorts trees the way git does', () => {
    root = mkdtempSync(join(tmpdir(), 'lockkeeper-demo-'));
    // "a.b" sorts before the directory "a", which git compares as "a/".
    const files = [
      { path: 'a.b', content: 'file\n' },
      { path: 'a/z.txt', content: 'nested\n' },
      { path: 'a-b/c.txt', content: 'dash\n' },
      { path: 'B.txt', content: 'capital\n' },
    ];
    expect(commitId(files, SAMPLE_COMMIT)).toBe(gitCommit(root, files));
  });

  it('builds the sample repository in a sandbox', async () => {
    root = mkdtempSync(join(tmpdir(), 'lockkeeper-demo-'));
    sandboxes = new LocalSandboxProvider({ root, binDir: makeBinDir(root) });
    const sandbox = await sandboxes.create({ timeoutMs: 1, metadata: {}, allowDomains: [] });
    const url = await seedSample(sandbox);
    expect(url).toBe(`file://${sandbox.homeDir}/.lockkeeper-sample.git`);
    const head = execFileSync('git', ['rev-parse', 'refs/heads/main'], {
      cwd: `${sandbox.homeDir}/.lockkeeper-sample.git`,
      encoding: 'utf8',
    }).trim();
    expect(head).toBe(SAMPLE_SHA);
  });

  it('runs the sample ticket end to end and shows what it would post', async () => {
    root = mkdtempSync(join(tmpdir(), 'lockkeeper-demo-'));
    const cart = SAMPLE_FILES.find((file) => file.path === 'src/cart.js')?.content ?? '';
    const script = join(root, 'agent-script.json');
    writeFileSync(
      script,
      JSON.stringify({
        rounds: [
          { text: READY },
          {
            writes: {
              'src/cart.js': `import { formatPrice } from './format.js';\n\n${cart}\n${SUMMARY}\n`,
              'test/summary.test.js': SUMMARY_TEST,
            },
            text: REPORT,
          },
        ],
      }),
    );
    sandboxes = new LocalSandboxProvider({
      root,
      binDir: makeBinDir(root),
      env: { FAKE_AGENT_SCRIPT: script },
    });
    const result = await runDemo({
      sandboxes,
      agent: new ClaudeCodeAdapter(),
      modelKey: { mode: 'egress', secretName: 'lk-test-key' },
      pollMs: 20,
    });

    expect(result.outcome).toBe('dry_run');
    if (result.outcome !== 'dry_run') return;
    const { preview } = result;
    expect(preview.title).toBe('DEMO-1: Add a one-line cart summary');
    expect(preview.draftReasons).toEqual([]);
    expect(preview.diff).toContain('+export function cartSummary');
    expect(preview.diff).toContain('+++ b/test/summary.test.js');
    expect(preview.body).toContain('npm test');
    expect(preview.comments.join('\n')).toContain('DEMO-1 · ready for review');
    // The checks ran on the sample's main first, where they pass.
    expect(result.run.state).toBe('done');
    expect(sandboxes.sandboxes[0]?.destroyed).toBe(true);
  });
});
