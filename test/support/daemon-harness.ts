import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../../src/agent/claude-code.js';
import { parseConfig } from '../../src/config/load.js';
import { Daemon } from '../../src/daemon/daemon.js';
import type { RunDeps } from '../../src/engine/run.js';
import { Store } from '../../src/store/store.js';
import type { Person } from '../../src/tracker/tracker.js';
import { FakeJira } from './fake-jira.js';
import { FakeScm, makeRemoteRepo } from './fakes.js';
import { LocalSandboxProvider, makeBinDir } from './local-sandbox.js';

/**
 * TEST ONLY. The whole service against an in-memory Jira, a fake GitHub that commits
 * for real into a local bare repository, a local "sandbox" and a fake `claude`.
 */

export const maria: Person = {
  accountId: 'acc-maria',
  displayName: 'Maria',
  accountType: 'atlassian',
};
export const bob: Person = { accountId: 'acc-bob', displayName: 'Bob', accountType: 'atlassian' };

export const REPORT = `Done.\n<lockkeeper-report>\n${JSON.stringify({
  summary: 'Added hello.txt.',
  criteria: [
    { criterion: 'hello.txt exists', met: true, evidence: 'test -f hello.txt passes' },
    { criterion: 'It says hello', met: true, evidence: 'grep finds hello' },
  ],
  tests: [],
  risks: [],
})}\n</lockkeeper-report>`;

export const ROUND = { writes: { 'hello.txt': 'hello\n' }, text: REPORT };

export function harness(
  options: {
    allowUsers?: string[];
    parallelRuns?: number;
    sleepMs?: number;
    /** Agent steps in order, replacing the default single implementation step. */
    rounds?: object[];
    readiness?: boolean;
    /** Lines added to lockkeeper.yml. */
    config?: string;
    now?: () => number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'lockkeeper-daemon-'));
  const remote = makeRemoteRepo(root, { 'README.md': '# Demo\n' });
  const script = join(root, 'agent-script.json');
  const round = { ...ROUND, sleepMs: options.sleepMs ?? 0 };
  writeFileSync(script, JSON.stringify({ rounds: options.rounds ?? [round] }));
  const sandboxes = new LocalSandboxProvider({
    root,
    binDir: makeBinDir(root),
    env: { FAKE_AGENT_SCRIPT: script },
  });
  const config = parseConfig(`
jira:
  site: acme.atlassian.net
  allow_users: ${JSON.stringify(options.allowUsers ?? [])}
projects:
  DEMO:
    repo: acme/demo
store:
  path: ':memory:'
limits:
  parallel_runs: ${options.parallelRuns ?? 3}
readiness:
  enabled: ${options.readiness ?? false}
repo:
  setup: []
  verify: ['test -f hello.txt', 'grep -q hello hello.txt']
${options.config ?? ''}
`);
  const jira = new FakeJira();
  const scm = new FakeScm(remote.bare, remote.sha);
  const store = Store.open(':memory:');
  const deps: RunDeps = {
    config,
    tracker: jira,
    scm,
    sandboxes,
    agent: new ClaudeCodeAdapter(),
    store,
    modelKey: { mode: 'egress', secretName: 'lk-test-key' },
    pollMs: 20,
    ...(options.now ? { now: options.now } : {}),
  };
  const daemons = [new Daemon(deps, { pollMs: 50 })];
  const daemon = daemons[0] as Daemon;
  const runFor = (key: string) => store.listRuns({ ticketKey: key, limit: 1 })[0];
  const agentStarted = (key: string) => {
    const run = runFor(key);
    return run ? store.events(run.id, { kind: 'agent' }).length > 0 : false;
  };
  /** Replace what the fake agent does on its next invocations. */
  const setAgent = (rounds: object[]) => writeFileSync(script, JSON.stringify({ rounds }));
  return {
    root,
    jira,
    scm,
    store,
    sandboxes,
    deps,
    daemon,
    daemons,
    runFor,
    agentStarted,
    setAgent,
  };
}

export type Harness = ReturnType<typeof harness>;

export async function waitFor(condition: () => boolean, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for a condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
