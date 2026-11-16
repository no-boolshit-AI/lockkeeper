import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/agent/claude-code.js';
import { parseConfig } from '../../src/config/load.js';
import { Daemon } from '../../src/daemon/daemon.js';
import type { RunDeps } from '../../src/engine/run.js';
import { Store } from '../../src/store/store.js';
import type { Person } from '../../src/tracker/tracker.js';
import { FakeJira } from '../support/fake-jira.js';
import { FakeScm, makeRemoteRepo } from '../support/fakes.js';
import { LocalSandboxProvider, makeBinDir, waitForAgents } from '../support/local-sandbox.js';

const maria: Person = { accountId: 'acc-maria', displayName: 'Maria', accountType: 'atlassian' };
const bob: Person = { accountId: 'acc-bob', displayName: 'Bob', accountType: 'atlassian' };

const REPORT = `Done.\n<lockkeeper-report>\n${JSON.stringify({
  summary: 'Added hello.txt.',
  criteria: [
    { criterion: 'hello.txt exists', met: true, evidence: 'test -f hello.txt passes' },
    { criterion: 'It says hello', met: true, evidence: 'grep finds hello' },
  ],
  tests: [],
  risks: [],
})}\n</lockkeeper-report>`;

const ROUND = { writes: { 'hello.txt': 'hello\n' }, text: REPORT };

function harness(
  options: {
    allowUsers?: string[];
    parallelRuns?: number;
    sleepMs?: number;
    /** Agent steps in order, replacing the default single implementation step. */
    rounds?: object[];
    readiness?: boolean;
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
  };
  const daemons = [new Daemon(deps, { pollMs: 50 })];
  const daemon = daemons[0] as Daemon;
  const runFor = (key: string) => store.listRuns({ ticketKey: key, limit: 1 })[0];
  const agentStarted = (key: string) => {
    const run = runFor(key);
    return run ? store.events(run.id, { kind: 'agent' }).length > 0 : false;
  };
  return { root, jira, scm, store, sandboxes, deps, daemon, daemons, runFor, agentStarted };
}

type Harness = ReturnType<typeof harness>;

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for a condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('the daemon', () => {
  let h: Harness | undefined;

  afterEach(async () => {
    if (!h) return;
    for (const daemon of h.daemons) {
      daemon.stop();
      await daemon.settle();
    }
    // Let any fake agent that is still running finish before its folder goes.
    await waitForAgents(h.sandboxes.sandboxes);
    h.store.close();
    rmSync(h.root, { recursive: true, force: true });
    h = undefined;
  });

  it('picks up a labelled ticket once and opens a pull request', async () => {
    h = harness();
    h.jira.addIssue('DEMO-1');
    h.jira.addLabel('DEMO-1', 'agent', bob);
    await h.daemon.tick();
    await h.daemon.settle();

    const run = h.runFor('DEMO-1');
    expect(run).toMatchObject({ state: 'in_review', triggeredBy: 'jira:Bob' });
    expect(h.scm.pullRequests).toHaveLength(1);
    expect(h.jira.issue('DEMO-1').labels).toEqual(['agent-in-review']);
    // The final comment notifies whoever added the label, not just the reporter.
    expect(h.jira.texts('DEMO-1').at(-1)).toContain('@Bob');
    expect(h.store.latestEvent(run?.id ?? '', 'trigger')).toMatchObject({
      source: 'label',
      by: { displayName: 'Bob' },
    });

    // Later polls never start a second run for the same label change (T6).
    await h.daemon.tick();
    await h.daemon.settle();
    expect(h.store.listRuns({ ticketKey: 'DEMO-1' })).toHaveLength(1);
  });

  it('refuses once when someone not on the allow-list adds the label', async () => {
    h = harness({ allowUsers: ['tech-leads'] });
    h.jira.groups.set('acc-maria', ['tech-leads']);
    h.jira.addIssue('DEMO-1');
    h.jira.addLabel('DEMO-1', 'agent', bob);
    await h.daemon.tick();

    expect(h.sandboxes.sandboxes).toHaveLength(0);
    expect(h.runFor('DEMO-1')?.state).toBe('refused');
    expect(h.jira.texts('DEMO-1')).toEqual([
      expect.stringContaining("Bob is not on Lockkeeper's allow-list."),
    ]);
    expect(h.jira.issue('DEMO-1').labels).toEqual([]);
    await h.daemon.tick();
    expect(h.jira.texts('DEMO-1')).toHaveLength(1);

    // Someone on the list adds it: now it runs.
    h.jira.addLabel('DEMO-1', 'agent', maria);
    await h.daemon.tick();
    await h.daemon.settle();
    expect(h.scm.pullRequests).toHaveLength(1);
  });

  it('never takes requests from apps, even without an allow-list', async () => {
    h = harness();
    h.jira.addIssue('DEMO-1');
    h.jira.addLabel('DEMO-1', 'agent', {
      accountId: 'acc-automation',
      displayName: 'Automation for Jira',
      accountType: 'app',
    });
    await h.daemon.tick();
    expect(h.runFor('DEMO-1')?.state).toBe('refused');
    expect(h.jira.texts('DEMO-1')[0]).toContain('is an app');
    expect(h.sandboxes.sandboxes).toHaveLength(0);
  });

  it('queues runs beyond the parallel-run cap and starts them as slots free up', async () => {
    h = harness({ parallelRuns: 1 });
    h.jira.addIssue('DEMO-1');
    h.jira.addIssue('DEMO-2', { summary: 'Add a second greeting' });
    h.jira.addLabel('DEMO-1', 'agent', maria);
    h.jira.addLabel('DEMO-2', 'agent', maria);
    await h.daemon.tick();

    expect(h.runFor('DEMO-2')?.state).toBe('queued');
    expect(h.jira.texts('DEMO-2')[0]).toContain('DEMO-2 · queued');
    expect(h.jira.issue('DEMO-2').labels).toEqual(['agent-working']);

    // The first run frees its slot and the queued one starts at once.
    await h.daemon.settle();
    expect(h.runFor('DEMO-1')?.state).toBe('in_review');
    expect(h.runFor('DEMO-2')?.state).toBe('in_review');
    expect(h.scm.pullRequests).toHaveLength(2);
    // The queued comment became that run's status comment: still one, now final.
    const status = h.jira.texts('DEMO-2').filter((text) => text.includes('Lockkeeper · DEMO-2'));
    expect(status).toEqual([expect.stringContaining('ready for review')]);
  });

  it('stops a run when someone allowed comments /agent stop, and ignores others', async () => {
    h = harness({ allowUsers: ['tech-leads'], sleepMs: 5_000 });
    h.jira.groups.set('acc-maria', ['tech-leads']);
    h.jira.addIssue('DEMO-1');
    h.jira.addLabel('DEMO-1', 'agent', maria);
    await h.daemon.tick();
    await waitFor(() => Boolean(h?.agentStarted('DEMO-1')));

    h.jira.comment('DEMO-1', bob, '/agent stop');
    await h.daemon.tick();
    expect(h.runFor('DEMO-1')?.state).toBe('implement');

    h.jira.comment('DEMO-1', maria, '/agent stop');
    await h.daemon.tick();
    await h.daemon.settle();
    expect(h.runFor('DEMO-1')?.state).toBe('cancelled');
    expect(h.jira.texts('DEMO-1')[0]).toContain('Maria stopped the run with /agent stop.');
    expect(h.jira.issue('DEMO-1').labels).toEqual([]);
    expect(h.scm.pullRequests).toHaveLength(0);
  });

  it('stops a run when its label is removed', async () => {
    h = harness({ sleepMs: 5_000 });
    h.jira.addIssue('DEMO-1');
    h.jira.addLabel('DEMO-1', 'agent', maria);
    await h.daemon.tick();
    await waitFor(() => Boolean(h?.agentStarted('DEMO-1')));

    h.jira.removeLabel('DEMO-1', 'agent-working');
    await h.daemon.tick();
    await h.daemon.settle();
    expect(h.runFor('DEMO-1')?.state).toBe('cancelled');
    expect(h.jira.texts('DEMO-1')[0]).toContain('label was removed');
  });

  it('stops a queued run before it starts', async () => {
    h = harness({ parallelRuns: 1, sleepMs: 5_000 });
    h.jira.addIssue('DEMO-1');
    h.jira.addIssue('DEMO-2', { summary: 'Add a second greeting' });
    h.jira.addLabel('DEMO-1', 'agent', maria);
    h.jira.addLabel('DEMO-2', 'agent', maria);
    await h.daemon.tick();
    h.jira.comment('DEMO-2', maria, '/agent stop');
    h.jira.comment('DEMO-1', maria, '/agent stop');
    await h.daemon.tick();
    await h.daemon.settle();

    expect(h.runFor('DEMO-2')?.state).toBe('cancelled');
    expect(h.jira.texts('DEMO-2')[0]).toContain('DEMO-2 · stopped');
    expect(h.jira.issue('DEMO-2').labels).toEqual([]);
    expect(h.sandboxes.sandboxes).toHaveLength(1);
  });

  it('starts another attempt on the same pull request when an allowed person comments /agent retry', async () => {
    h = harness({ allowUsers: ['tech-leads'] });
    h.jira.groups.set('acc-maria', ['tech-leads']);
    h.jira.addIssue('DEMO-1');
    h.jira.addLabel('DEMO-1', 'agent', maria);
    await h.daemon.tick();
    await h.daemon.settle();
    const first = h.runFor('DEMO-1');
    expect(first?.state).toBe('in_review');

    // Someone not on the list is ignored.
    h.jira.comment('DEMO-1', bob, '/agent retry do it differently');
    await h.daemon.tick();
    expect(h.runFor('DEMO-1')?.id).toBe(first?.id);

    const round = { writes: { 'hello.txt': 'hello there\n' }, text: REPORT };
    writeFileSync(join(h.root, 'agent-script.json'), JSON.stringify({ rounds: [round] }));
    h.jira.comment('DEMO-1', maria, '/agent retry Make it friendlier.');
    await h.daemon.tick();
    await h.daemon.settle();

    const second = h.runFor('DEMO-1');
    expect(second).toMatchObject({
      state: 'in_review',
      parentRunId: first?.id,
      hint: 'Make it friendlier.',
      branch: first?.branch,
      triggeredBy: 'jira:Maria',
    });
    expect(h.store.getRun(first?.id ?? '')?.state).toBe('done');
    expect(h.scm.pullRequests).toHaveLength(1);
    expect(h.scm.commits.map((commit) => commit.createBranch)).toEqual([true, false]);
    expect(h.scm.updates).toHaveLength(1);
    expect(h.jira.issue('DEMO-1').labels).toEqual(['agent-in-review']);
  });

  it('asks questions, then continues with the answers when someone allowed replies /agent go', async () => {
    const ask = `Read it.\n<lockkeeper-readiness>\n${JSON.stringify({
      verdict: 'needs_info',
      questions: ['Where should the greeting go?'],
      reason: 'The ticket does not say.',
    })}\n</lockkeeper-readiness>`;
    h = harness({ readiness: true, rounds: [{ text: ask }] });
    h.jira.addIssue('DEMO-1');
    h.jira.addLabel('DEMO-1', 'agent', bob);
    await h.daemon.tick();
    await h.daemon.settle();

    expect(h.runFor('DEMO-1')?.state).toBe('needs_info');
    expect(h.jira.issue('DEMO-1').labels).toEqual(['agent-needs-info']);
    // The questions mention whoever added the label.
    expect(h.jira.texts('DEMO-1')[1]).toContain('@Bob');
    expect(h.jira.texts('DEMO-1')[1]).toContain('Where should the greeting go?');
    // Waiting runs hold no sandbox and no run slot.
    expect(h.store.countExecutingRuns()).toBe(0);

    writeFileSync(join(h.root, 'agent-script.json'), JSON.stringify({ rounds: [ROUND] }));
    h.jira.comment('DEMO-1', bob, '/agent go In hello.txt at the root.');
    await h.daemon.tick();
    await h.daemon.settle();

    const run = h.runFor('DEMO-1');
    expect(run?.state).toBe('in_review');
    expect(h.scm.pullRequests).toHaveLength(1);
    expect(h.store.latestEvent(run?.id ?? '', 'answers')).toMatchObject({
      by: 'Bob',
      text: 'In hello.txt at the root.',
    });
  });

  it('cancels a run waiting for answers when its label is removed', async () => {
    const ask = `<lockkeeper-readiness>\n${JSON.stringify({
      verdict: 'needs_info',
      questions: ['Which colour?'],
    })}\n</lockkeeper-readiness>`;
    h = harness({ readiness: true, rounds: [{ text: ask }] });
    h.jira.addIssue('DEMO-1');
    h.jira.addLabel('DEMO-1', 'agent', maria);
    await h.daemon.tick();
    await h.daemon.settle();
    expect(h.runFor('DEMO-1')?.state).toBe('needs_info');

    h.jira.removeLabel('DEMO-1', 'agent-needs-info');
    await h.daemon.tick();
    expect(h.runFor('DEMO-1')?.state).toBe('cancelled');
    expect(h.jira.texts('DEMO-1')[0]).toContain('agent-needs-info label was removed');
  });

  it('resumes the runs a previous process left, and leaves its own to resume', async () => {
    h = harness({ sleepMs: 1_500 });
    h.jira.addIssue('DEMO-1');
    h.jira.addLabel('DEMO-1', 'agent', maria);
    await h.daemon.tick();
    await waitFor(() => Boolean(h?.agentStarted('DEMO-1')));
    h.daemon.stop();
    await h.daemon.settle();
    expect(h.runFor('DEMO-1')).toMatchObject({ state: 'implement', owner: null });

    const next = new Daemon(h.deps, { pollMs: 50 });
    h.daemons.push(next);
    next.resumeOrphans();
    await next.settle();
    expect(h.runFor('DEMO-1')?.state).toBe('in_review');
    expect(h.scm.pullRequests).toHaveLength(1);
    const home = h.sandboxes.sandboxes[0]?.homeDir ?? '';
    expect(existsSync(join(home, '.fake-agent-call-1.json'))).toBe(false);
  });
});

describe('the daemon and the command line', () => {
  it('stops a run when `lockkeeper cancel` marks it cancelled', async () => {
    const h = harness({ sleepMs: 5_000 });
    try {
      h.jira.addIssue('DEMO-1');
      h.jira.addLabel('DEMO-1', 'agent', maria);
      await h.daemon.tick();
      await waitFor(() => h.agentStarted('DEMO-1'));
      const run = h.runFor('DEMO-1');
      // What `lockkeeper cancel` does to the store.
      h.store.updateRun(run?.id ?? '', { state: 'cancelled', error: 'Cancelled from the CLI.' });
      await h.daemon.tick();
      await h.daemon.settle();
      expect(h.runFor('DEMO-1')?.state).toBe('cancelled');
      expect(h.jira.texts('DEMO-1')[0]).toContain('cancelled from the command line');
      expect(h.jira.texts('DEMO-1').join('\n')).not.toContain('failed');
    } finally {
      await waitForAgents(h.sandboxes.sandboxes);
      h.store.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  });
});
