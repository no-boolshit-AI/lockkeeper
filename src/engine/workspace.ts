import type { AgentAdapter, AgentEvent } from '../agent/agent.js';
import { StepFailedError } from '../core/errors.js';
import type { ChangedFile } from '../policy/diff-policy.js';
import type { SandboxHandle } from '../sandbox/sandbox.js';
import { shellQuote as q } from '../sandbox/sandbox.js';
import type { BaseRef, CloneAccess, FileChange, FileMode } from '../scm/scm.js';
import {
  gitBlobSha1,
  isObjectId,
  parseBlobExport,
  parseNumstat,
  parseRawDiff,
  toChangedFiles,
} from './git-diff.js';
import type { InstructionFile } from './prompts.js';

/**
 * The deterministic steps that run inside the sandbox: clone, setup, start and watch
 * the agent, verify, and package the result. The control plane drives each one and
 * reads exit codes itself, so the agent cannot report its own checks as passed.
 */

export interface Layout {
  home: string;
  repo: string;
  work: string;
}

export const layoutFor = (home: string): Layout => ({
  home,
  repo: `${home}/repo`,
  work: `${home}/.lockkeeper`,
});

/** The last lines of a log, for the ticket and the PR. */
export function tail(text: string, maxLines = 60, maxChars = 4_000): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  let result = lines.slice(-maxLines).join('\n');
  if (result.length > maxChars) result = `…${result.slice(-maxChars)}`;
  return result;
}

export interface CheckResult {
  command: string;
  exitCode: number;
  passed: boolean;
  durationMs: number;
  output: string;
  /** It failed on the base branch too, before the agent changed anything. */
  failedOnBase?: boolean;
}

/** Failures the agent's change caused: not the ones the base branch already had. */
export function newFailures(checks: readonly CheckResult[]): CheckResult[] {
  return checks.filter((check) => !check.passed && !check.failedOnBase);
}

export async function cloneRepo(
  sandbox: SandboxHandle,
  layout: Layout,
  access: CloneAccess,
  base: BaseRef,
  timeoutMs: number,
  /** Another branch to fetch, such as the base branch when continuing a PR branch. */
  also?: BaseRef,
): Promise<void> {
  if (!isObjectId(base.sha)) throw new Error(`Invalid base commit: ${base.sha}`);
  if (also && !isObjectId(also.sha)) throw new Error(`Invalid commit: ${also.sha}`);
  // The token travels in an environment variable and a one-off `git -c` header, so it
  // is never written to .git/config and never appears in the command line.
  const auth = access.authHeader ? '-c http.extraHeader="$LOCKKEEPER_GIT_AUTH" ' : '';
  const script = [
    'set -e',
    `mkdir -p ${q(layout.work)}`,
    `rm -rf ${q(layout.repo)}`,
    `git ${auth}clone --quiet --no-tags --single-branch --branch ${q(base.branch)} ${q(access.url)} ${q(layout.repo)}`,
    `cd ${q(layout.repo)}`,
    ...(also
      ? [
          `git ${auth}fetch --quiet --no-tags origin ${q(`+refs/heads/${also.branch}:refs/remotes/origin/${also.branch}`)}`,
          `git cat-file -e ${also.sha}^{commit}`,
        ]
      : []),
    `git checkout --quiet --detach ${base.sha}`,
    `git config user.name 'Lockkeeper agent'`,
    `git config user.email 'agent@lockkeeper.invalid'`,
    'git rev-parse HEAD',
  ].join('\n');
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (access.authHeader) env.LOCKKEEPER_GIT_AUTH = access.authHeader;
  const result = await sandbox.exec(script, { env, timeoutMs });
  const head = result.stdout.trim().split('\n').at(-1);
  if (result.exitCode !== 0 || head !== base.sha) {
    throw new StepFailedError(
      'clone',
      `Cloning ${access.url} failed (exit ${result.exitCode}).`,
      tail(result.stderr || result.stdout),
    );
  }
}

/**
 * Bring a resumed sandbox's checkout to the head of a pull request branch, as GitHub
 * has it (F1). Ignored files such as installed dependencies stay, which is the point
 * of resuming. Earlier changes were already published, so nothing of value is lost.
 */
export async function updateCheckout(
  sandbox: SandboxHandle,
  layout: Layout,
  access: CloneAccess,
  head: BaseRef,
  also: BaseRef,
  timeoutMs: number,
): Promise<void> {
  if (!isObjectId(head.sha) || !isObjectId(also.sha)) throw new Error('Invalid commit to fetch.');
  const auth = access.authHeader ? '-c http.extraHeader="$LOCKKEEPER_GIT_AUTH" ' : '';
  const refspec = (branch: string) => q(`+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  const script = [
    'set -e',
    `cd ${q(layout.repo)}`,
    `git ${auth}fetch --quiet --no-tags origin ${refspec(head.branch)} ${refspec(also.branch)}`,
    `git cat-file -e ${head.sha}^{commit}`,
    `git cat-file -e ${also.sha}^{commit}`,
    `git checkout --quiet --force --detach ${head.sha}`,
    `git reset --quiet --hard ${head.sha}`,
    'git clean -fdq',
    'git rev-parse HEAD',
  ].join('\n');
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (access.authHeader) env.LOCKKEEPER_GIT_AUTH = access.authHeader;
  const result = await sandbox.exec(script, { env, timeoutMs });
  const sha = result.stdout.trim().split('\n').at(-1);
  if (result.exitCode !== 0 || sha !== head.sha) {
    throw new StepFailedError(
      'clone',
      `Updating the checkout to ${head.branch} failed (exit ${result.exitCode}).`,
      tail(result.stderr || result.stdout),
    );
  }
}

/** Put the checkout back to a commit, removing every change and untracked file. */
export async function resetCheckout(
  sandbox: SandboxHandle,
  layout: Layout,
  sha: string,
): Promise<void> {
  if (!isObjectId(sha)) throw new Error(`Invalid commit: ${sha}`);
  const result = await sandbox.exec(
    `git checkout --quiet --force --detach ${sha} && git reset --quiet --hard ${sha} && git clean -fdxq && git status --porcelain`,
    { cwd: layout.repo, timeoutMs: 60_000 },
  );
  if (result.exitCode !== 0 || result.stdout.trim() !== '') {
    throw new StepFailedError(
      'readiness',
      'Lockkeeper could not undo what the readiness check changed in the checkout.',
      tail(result.stderr || result.stdout),
    );
  }
}

/** The whole change against a commit as a unified diff, for a dry run to show. Capped. */
export async function stagedDiff(
  sandbox: SandboxHandle,
  layout: Layout,
  baseSha: string,
  maxBytes = 200_000,
): Promise<string> {
  if (!isObjectId(baseSha)) throw new Error(`Invalid base commit: ${baseSha}`);
  const result = await sandbox.exec(
    `git add -A && git diff --cached --no-color --no-ext-diff --no-renames ${baseSha} | head -c ${maxBytes}`,
    { cwd: layout.repo, timeoutMs: 120_000 },
  );
  return result.exitCode === 0 ? result.stdout : '';
}

/** Where two commits' histories meet: the point a pull request branch forked from. */
export async function mergeBase(
  sandbox: SandboxHandle,
  layout: Layout,
  a: string,
  b: string,
): Promise<string> {
  if (!isObjectId(a) || !isObjectId(b)) throw new Error('Invalid commit for merge-base.');
  const result = await sandbox.exec(`git merge-base ${a} ${b}`, {
    cwd: layout.repo,
    timeoutMs: 60_000,
  });
  // Read back from the sandbox, so checked before use (rule 4).
  const sha = result.stdout.trim();
  if (result.exitCode !== 0 || !isObjectId(sha)) {
    throw new StepFailedError(
      'collect',
      'git could not find where the branch forked.',
      tail(result.stderr),
    );
  }
  return sha;
}

/** Instruction files as they are on the base commit, never as the agent left them. */
export async function readInstructionFiles(
  sandbox: SandboxHandle,
  layout: Layout,
  baseSha: string,
  paths: readonly string[] = ['AGENTS.md', 'CLAUDE.md'],
): Promise<InstructionFile[]> {
  if (!isObjectId(baseSha)) throw new Error(`Invalid base commit: ${baseSha}`);
  const files: InstructionFile[] = [];
  for (const path of paths) {
    const result = await sandbox.exec(`git show ${q(`${baseSha}:${path}`)}`, {
      cwd: layout.repo,
      timeoutMs: 30_000,
    });
    if (result.exitCode === 0 && result.stdout.trim()) files.push({ path, content: result.stdout });
  }
  return files;
}

export async function inspectRoot(
  sandbox: SandboxHandle,
  layout: Layout,
): Promise<{ files: string[]; packageJson?: Record<string, unknown> }> {
  const listing = await sandbox.exec('ls -A1', { cwd: layout.repo, timeoutMs: 30_000 });
  const files = listing.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!files.includes('package.json')) return { files };
  try {
    const bytes = await sandbox.readFile(`${layout.repo}/package.json`);
    return {
      files,
      packageJson: JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>,
    };
  } catch {
    return { files };
  }
}

/**
 * Run commands in the repository with stdout and stderr merged. Setup stops at the
 * first failure; verification runs every command so the PR can show each result.
 */
export async function runCommands(
  sandbox: SandboxHandle,
  layout: Layout,
  commands: readonly string[],
  options: { timeoutMs: number; stopOnFailure: boolean; now?: () => number },
): Promise<CheckResult[]> {
  const now = options.now ?? Date.now;
  const results: CheckResult[] = [];
  for (const command of commands) {
    const started = now();
    const result = await sandbox.exec(`(\n${command}\n) 2>&1`, {
      cwd: layout.repo,
      timeoutMs: options.timeoutMs,
    });
    const check: CheckResult = {
      command,
      exitCode: result.exitCode,
      passed: result.exitCode === 0,
      durationMs: now() - started,
      output: tail(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`),
    };
    results.push(check);
    if (!check.passed && options.stopOnFailure) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// The agent process

export interface AgentFiles {
  dir: string;
  prompt: string;
  system: string;
  events: string;
  stderr: string;
  exit: string;
  pid: string;
}

/** Files for one agent invocation: a fix round's number, or a named pass such as `readiness`. */
export function agentFiles(layout: Layout, round: number | string): AgentFiles {
  const dir = `${layout.work}/agent-${round}`;
  return {
    dir,
    prompt: `${dir}/prompt.md`,
    system: `${dir}/system.md`,
    events: `${dir}/events.jsonl`,
    stderr: `${dir}/stderr.log`,
    exit: `${dir}/exit_code`,
    pid: `${dir}/session.pid`,
  };
}

/**
 * Start the agent in its own session, as a background command that writes its event
 * stream to a file. Streams can drop; the file survives, and a restarted control
 * plane can pick it up again by sandbox ID.
 */
export async function startAgent(
  sandbox: SandboxHandle,
  layout: Layout,
  files: AgentFiles,
  command: string,
  env: Record<string, string>,
): Promise<void> {
  const inner = [
    `echo $$ > ${q(files.pid)}`,
    `${command} > ${q(files.events)} 2> ${q(files.stderr)}`,
    `echo $? > ${q(files.exit)}`,
  ].join('\n');
  await sandbox.spawn(`setsid bash -c ${q(inner)}`, { cwd: layout.repo, env });
}

/**
 * Kill the agent and anything it started in its session. The session leader also leads
 * its process group, so the `kill` builtin works even where procps (pkill) is missing.
 */
export async function stopAgent(sandbox: SandboxHandle, files: AgentFiles): Promise<void> {
  await sandbox.exec(
    `sid=$(cat ${q(files.pid)} 2>/dev/null); case "$sid" in ''|0|*[!0-9]*) ;; *) kill -KILL -- "-$sid" 2>/dev/null; pkill -KILL -s "$sid" 2>/dev/null ;; esac; true`,
    { timeoutMs: 30_000 },
  );
}

/** Whether this round's agent was started: its session file exists. */
export async function agentStarted(sandbox: SandboxHandle, files: AgentFiles): Promise<boolean> {
  const check = await sandbox.exec(`test -s ${q(files.pid)}`, { timeoutMs: 30_000 });
  return check.exitCode === 0;
}

type ResultEvent = Extract<AgentEvent, { type: 'result' }>;

/** `cancel` stops the agent. `detach` leaves it running for a later process to pick up. */
export type StopRequest = boolean | 'cancel' | 'detach';

export interface WatchOptions {
  adapter: AgentAdapter;
  onEvent: (event: AgentEvent) => void;
  /** Epoch milliseconds after which the agent is stopped (E7). */
  deadline: number;
  pollMs: number;
  keepAliveEveryMs: number;
  sandboxTimeoutMs: number;
  /**
   * Bytes of the event file a previous process already passed to `onEvent`. They are
   * read again, to find a result that was missed, but not passed on twice.
   */
  skipBytes?: number;
  /** Called with the bytes read so far, so a restarted process can carry on from there. */
  onProgress?: (offset: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  shouldStop?: () => StopRequest | Promise<StopRequest>;
}

export interface WatchResult {
  stopped: 'exited' | 'deadline' | 'cancelled' | 'detached';
  exitCode: number | null;
  result: ResultEvent | undefined;
  stderr: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function watchAgent(
  sandbox: SandboxHandle,
  files: AgentFiles,
  options: WatchOptions,
): Promise<WatchResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const skip = options.skipBytes ?? 0;
  let offset = 0;
  let lastKeepAlive = now();
  let result: ResultEvent | undefined;

  const consume = (text: string, start: number) => {
    let position = start;
    for (const line of text.split('\n')) {
      const end = position + Buffer.byteLength(line, 'utf8') + 1;
      for (const event of options.adapter.parseLine(line)) {
        if (event.type === 'result') result = event;
        if (end > skip) options.onEvent(event);
      }
      position = end;
    }
  };
  const finish = async (
    stopped: WatchResult['stopped'],
    exitCode: number | null,
  ): Promise<WatchResult> => {
    const stderr = await sandbox.exec(`tail -c 4000 ${q(files.stderr)} 2>/dev/null; true`, {
      timeoutMs: 30_000,
    });
    return { stopped, exitCode, result, stderr: stderr.stdout };
  };

  for (;;) {
    // Read the exit code first: once it exists, the event file is complete.
    const poll = await sandbox.exec(
      `printf '%s\\n' "$(cat ${q(files.exit)} 2>/dev/null)"; tail -c +${offset + 1} ${q(files.events)} 2>/dev/null; true`,
      { timeoutMs: 60_000 },
    );
    const firstNewline = poll.stdout.indexOf('\n');
    const exitText = poll.stdout.slice(0, firstNewline === -1 ? undefined : firstNewline).trim();
    const data = firstNewline === -1 ? '' : poll.stdout.slice(firstNewline + 1);
    const lastNewline = data.lastIndexOf('\n');
    if (lastNewline >= 0) {
      const complete = data.slice(0, lastNewline + 1);
      consume(complete, offset);
      offset += Buffer.byteLength(complete, 'utf8');
      options.onProgress?.(offset);
    }
    if (exitText !== '') {
      consume(data.slice(lastNewline + 1), offset);
      await stopAgent(sandbox, files);
      const code = Number.parseInt(exitText, 10);
      return finish('exited', Number.isNaN(code) ? null : code);
    }
    if (now() >= options.deadline) {
      await stopAgent(sandbox, files);
      return finish('deadline', null);
    }
    const stop = await options.shouldStop?.();
    if (stop === 'detach') return { stopped: 'detached', exitCode: null, result, stderr: '' };
    if (stop === true || stop === 'cancel') {
      await stopAgent(sandbox, files);
      return finish('cancelled', null);
    }
    if (now() - lastKeepAlive >= options.keepAliveEveryMs) {
      lastKeepAlive = now();
      // Best effort: the timeout set at creation already covers the run's deadline.
      await sandbox.keepAlive(options.sandboxTimeoutMs).catch(() => undefined);
    }
    await sleep(options.pollMs);
  }
}

// ---------------------------------------------------------------------------
// Packaging the result

export interface CollectedChanges {
  files: ChangedFile[];
  changes: FileChange[];
  /** New contents by path, for the content checks. */
  contents: Map<string, Uint8Array>;
}

const PUBLISHABLE_MODES = new Set<string>(['100644', '100755', '120000']);

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    chunks.push(items.slice(index, index + size));
  return chunks;
}

/**
 * Everything the agent changed relative to the base commit, including any commits it
 * made. Blob contents are checked against their object IDs, so what is published is
 * exactly what git listed.
 */
export async function collectChanges(
  sandbox: SandboxHandle,
  layout: Layout,
  baseSha: string,
): Promise<CollectedChanges> {
  if (!isObjectId(baseSha)) throw new Error(`Invalid base commit: ${baseSha}`);
  const options = { cwd: layout.repo, timeoutMs: 180_000 };
  const raw = await sandbox.exec(
    `git add -A && git diff --cached --raw -z --no-renames --no-abbrev ${baseSha}`,
    options,
  );
  if (raw.exitCode !== 0)
    throw new StepFailedError('collect', 'git could not list the changes.', tail(raw.stderr));
  const numstat = await sandbox.exec(
    `git diff --cached --numstat -z --no-renames ${baseSha}`,
    options,
  );
  if (numstat.exitCode !== 0)
    throw new StepFailedError('collect', 'git could not count the changes.', tail(numstat.stderr));

  const entries = parseRawDiff(raw.stdout);
  const files = toChangedFiles(entries, parseNumstat(numstat.stdout));

  const wanted = [
    ...new Set(
      entries
        .filter((entry) => entry.status !== 'deleted' && PUBLISHABLE_MODES.has(entry.newMode))
        .map((entry) => entry.newSha),
    ),
  ];
  const blobs = new Map<string, Uint8Array>();
  for (const batch of chunk(wanted, 25)) {
    const script = `for sha in ${batch.join(' ')}; do printf '%s ' "$sha"; git cat-file blob "$sha" | base64 | tr -d '\\n'; printf '\\n'; done`;
    const exported = await sandbox.exec(script, options);
    if (exported.exitCode !== 0)
      throw new StepFailedError(
        'collect',
        'git could not export changed files.',
        tail(exported.stderr),
      );
    for (const [sha, bytes] of parseBlobExport(exported.stdout)) {
      if (sha.length === 40 && gitBlobSha1(bytes) !== sha) {
        throw new StepFailedError(
          'collect',
          `A changed file did not match its git object ID (${sha}).`,
        );
      }
      blobs.set(sha, bytes);
    }
  }

  const changes: FileChange[] = [];
  const contents = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (entry.status === 'deleted') {
      changes.push({ path: entry.path, action: 'delete' });
      continue;
    }
    if (!PUBLISHABLE_MODES.has(entry.newMode)) continue; // Submodules: the diff policy blocks them.
    const content = blobs.get(entry.newSha);
    if (!content) throw new StepFailedError('collect', `Missing content for ${entry.path}.`);
    changes.push({ path: entry.path, action: 'upsert', mode: entry.newMode as FileMode, content });
    contents.set(entry.path, content);
  }
  return { files, changes, contents };
}
