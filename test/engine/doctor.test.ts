import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/agent/claude-code.js';
import { parseConfig } from '../../src/config/load.js';
import { type DoctorCheck, type DoctorDeps, runDoctor } from '../../src/engine/doctor.js';
import { FakeJira } from '../support/fake-jira.js';
import { FakeScm, makeRemoteRepo } from '../support/fakes.js';
import { LocalSandboxProvider, makeBinDir } from '../support/local-sandbox.js';

function setup(options: { verify?: string; files?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lockkeeper-doctor-'));
  const remote = makeRemoteRepo(root, options.files ?? { 'README.md': '# Demo\n' });
  const jira = new FakeJira();
  const scm = new FakeScm(remote.bare, remote.sha);
  const sandboxes = new LocalSandboxProvider({ root, binDir: makeBinDir(root) });
  const config = parseConfig(`
jira:
  site: acme.atlassian.net
projects:
  DEMO:
    repo: acme/demo
repo:
  setup: ['true']
  verify: [${JSON.stringify(options.verify ?? 'test -f README.md')}]
`);
  const deps: DoctorDeps = {
    config,
    tracker: jira,
    scm,
    sandboxes,
    agent: new ClaudeCodeAdapter(),
    modelKey: { mode: 'egress', secretName: 'lk-key' },
  };
  return { root, jira, scm, sandboxes, deps };
}

const byName = (checks: DoctorCheck[]) => new Map(checks.map((check) => [check.name, check]));

describe('lockkeeper doctor', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('passes a healthy setup and skips what the sandbox provider cannot do', async () => {
    const s = setup();
    root = s.root;
    const seen: string[] = [];
    const checks = await runDoctor(s.deps, { onCheck: (check) => seen.push(check.name) });

    expect(checks.filter((check) => check.status === 'fail' || check.status === 'warn')).toEqual(
      [],
    );
    expect(seen).toEqual([
      'Jira account',
      'Jira project DEMO',
      'GitHub acme/demo',
      'Branch rules in acme/demo',
      'Model key',
      'Sandbox for acme/demo',
      'Claude Code',
      'Clone',
      'Setup',
      'Checks on main',
      'Network policy',
      'Key injection',
    ]);
    expect(byName(checks).get('Network policy')?.status).toBe('skip');
    expect(byName(checks).get('Checks on main')?.detail).toContain('test -f README.md pass');
    expect(s.sandboxes.sandboxes[0]?.destroyed).toBe(true);
  });

  it('names missing permissions and blocking branch rules, each with a fix', async () => {
    const s = setup();
    root = s.root;
    s.jira.lacking = ['comment', 'link'];
    s.scm.rules = [{ type: 'creation' }, { type: 'non_fast_forward' }];
    const checks = byName(await runDoctor(s.deps));

    expect(checks.get('Jira project DEMO')).toMatchObject({
      status: 'fail',
      detail: 'the Jira account cannot add comments or link pull requests',
      fix: expect.stringContaining("DEMO's permission scheme"),
    });
    expect(checks.get('Branch rules in acme/demo')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('creation (feature/*), creation (bugfix/*)'),
      fix: expect.stringContaining('bypass actor'),
    });
  });

  it('stops at the repository when the App lacks permissions', async () => {
    const s = setup();
    root = s.root;
    s.scm.missing = ['pull_requests: write'];
    const checks = byName(await runDoctor(s.deps));
    expect(checks.get('GitHub acme/demo')).toMatchObject({
      status: 'fail',
      detail: 'the GitHub App lacks pull_requests: write',
    });
    expect(checks.has('Sandbox for acme/demo')).toBe(false);
  });

  it('warns, with the log, when the checks already fail on the base branch', async () => {
    const s = setup({ verify: 'echo "2 tests failed" && false' });
    root = s.root;
    const check = byName(await runDoctor(s.deps)).get('Checks on main');
    expect(check).toMatchObject({ status: 'warn', fix: expect.stringContaining('drafts') });
    expect(check?.log).toContain('2 tests failed');
  });

  it('reports a model key that cannot be used', async () => {
    const s = setup();
    root = s.root;
    s.deps.modelKey = {
      problem: 'The E2B secret "lk-key" does not exist.',
      hint: 'Run `lockkeeper secrets sync`.',
    };
    const check = byName(await runDoctor(s.deps)).get('Model key');
    expect(check).toEqual({
      name: 'Model key',
      status: 'fail',
      detail: 'The E2B secret "lk-key" does not exist.',
      fix: 'Run `lockkeeper secrets sync`.',
    });
  });
});
