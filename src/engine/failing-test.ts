import { StepFailedError } from '../core/errors.js';
import type { SandboxHandle } from '../sandbox/sandbox.js';
import { shellQuote as q } from '../sandbox/sandbox.js';
import { isObjectId } from './git-diff.js';
import { type Layout, tail } from './workspace.js';

/**
 * E5: a bug fix should come with a test that fails without it. Lockkeeper checks that
 * itself instead of taking the agent's word: it runs the test commands on the base code
 * with only the agent's new and changed tests, and expects a failure.
 */
export type FailingTestProof =
  /** A test command failed on the base code with the new tests: the tests show the bug. */
  | { kind: 'proven'; tests: string[]; command: string; exitCode: number }
  /** The new tests pass without the fix too, so they do not show the bug. */
  | { kind: 'passed_before'; tests: string[]; commands: string[] }
  /** The fix changes no test files. The agent may have said why. */
  | { kind: 'no_test'; reason: string }
  /** The check could not run. */
  | { kind: 'skipped'; reason: string };

const TEST_PATHS = [
  /(^|\/)(tests?|__tests__|specs?)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /_test\.(go|py|rb|exs?)$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /_spec\.rb$/i,
  /Tests?\.(cs|java|kt|swift|php)$/,
];

export function isTestPath(path: string): boolean {
  return TEST_PATHS.some((pattern) => pattern.test(path));
}

/** The verify commands that run tests; all of them when none looks like a test run. */
export function testCommands(verify: readonly string[]): string[] {
  const tests = verify.filter((command) =>
    /\b(test|tests|spec|pytest|jest|vitest|mocha|rspec|phpunit)\b/i.test(command),
  );
  return tests.length > 0 ? tests : [...verify];
}

function checkSha(sha: string): void {
  if (!isObjectId(sha)) throw new Error(`Invalid commit: ${sha}`);
}

/** Paths added or changed since `baseSha`. Deleted files are left out. */
export async function changedPaths(
  sandbox: SandboxHandle,
  layout: Layout,
  baseSha: string,
): Promise<string[]> {
  checkSha(baseSha);
  const result = await sandbox.exec(
    `git add -A && git diff --cached --name-only -z --no-renames --diff-filter=AM ${baseSha}`,
    { cwd: layout.repo, timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0)
    throw new StepFailedError(
      'verify',
      'git could not list the changed files.',
      tail(result.stderr),
    );
  return result.stdout.split('\0').filter(Boolean);
}

/** Commit the working tree as it is, so it can be restored exactly. Returns the commit. */
export async function saveTree(sandbox: SandboxHandle, layout: Layout): Promise<string> {
  const result = await sandbox.exec(
    `git add -A && git commit -q --no-verify --allow-empty -m 'Lockkeeper: the fix, kept while its tests run without it' && git rev-parse HEAD`,
    { cwd: layout.repo, timeoutMs: 120_000 },
  );
  // Read back from the sandbox, so checked before use (rule 4).
  const sha = result.stdout.trim().split('\n').at(-1)?.trim() ?? '';
  if (result.exitCode !== 0 || !isObjectId(sha)) {
    throw new StepFailedError(
      'verify',
      'git could not save the fixed code before testing without the fix.',
      tail(result.stderr || result.stdout),
    );
  }
  return sha;
}

/** The base code with only the given test files from the fix. */
export async function checkoutTestsOnBase(
  sandbox: SandboxHandle,
  layout: Layout,
  baseSha: string,
  fixSha: string,
  tests: readonly string[],
): Promise<boolean> {
  checkSha(baseSha);
  checkSha(fixSha);
  const result = await sandbox.exec(
    `git checkout -q --force --detach ${baseSha} && git checkout -q ${fixSha} -- ${tests.map(q).join(' ')}`,
    { cwd: layout.repo, timeoutMs: 120_000 },
  );
  return result.exitCode === 0;
}

/** Back to the fixed code, without anything the test run left behind. */
export async function restoreTree(
  sandbox: SandboxHandle,
  layout: Layout,
  fixSha: string,
): Promise<void> {
  checkSha(fixSha);
  const result = await sandbox.exec(
    `git checkout -q --force --detach ${fixSha} && git clean -fdq`,
    {
      cwd: layout.repo,
      timeoutMs: 120_000,
    },
  );
  if (result.exitCode !== 0) {
    throw new StepFailedError(
      'verify',
      'Lockkeeper could not put the fixed code back after testing without the fix.',
      tail(result.stderr || result.stdout),
    );
  }
}
