import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentInvocation } from '../../src/agent/agent.js';
import { ClaudeCodeAdapter } from '../../src/agent/claude-code.js';
import { CodexAdapter } from '../../src/agent/codex.js';
import { OpenCodeAdapter } from '../../src/agent/opencode.js';
import { CapExceededError } from '../../src/core/errors.js';
import { allowList } from '../../src/engine/domains.js';
import { type RunDeps, runTicket } from '../../src/engine/run.js';
import { Store } from '../../src/store/store.js';
import {
  FakeScm,
  fakeTracker,
  makeRemoteRepo,
  testConfig,
  ticketFixture,
} from '../support/fakes.js';
import { LocalSandboxProvider, makeBinDir, waitForAgents } from '../support/local-sandbox.js';

/**
 * Every agent adapter must pass these, so a run behaves the same whichever agent a team
 * picks: the command is headless and keeps the repository's own settings out, the key
 * never sits in the adapter's environment, and the whole run loop works, fix rounds and
 * all, against a fake of the CLI that prints the CLI's real event format.
 */

interface Case {
  name: string;
  make: () => AgentAdapter;
  /** Fragments the command must contain to keep repository settings and the web out. */
  sealed: string[];
}

const CASES: Case[] = [
  {
    name: 'Claude Code',
    make: () => new ClaudeCodeAdapter(),
    sealed: ['--bare', '--setting-sources user', '--strict-mcp-config', 'WebFetch WebSearch'],
  },
  {
    name: 'Codex CLI',
    make: () => new CodexAdapter({ prices: { input: 1.25, cachedInput: 0.125, output: 10 } }),
    sealed: [
      '--ignore-user-config',
      '--ignore-rules',
      '\'web_search="disabled"\'',
      'project_doc_max_bytes=0',
      'features.hooks=false',
    ],
  },
  {
    name: 'OpenCode',
    make: () => new OpenCodeAdapter({ model: 'anthropic/claude-opus-5-5' }),
    sealed: ['"webfetch":"deny"', '"websearch":"deny"', '--format json'],
  },
];

const invocation = (overrides: Partial<AgentInvocation> = {}): AgentInvocation => ({
  workdir: '/home/user/my repo',
  promptFile: "/home/user/.lockkeeper/agent-0/it's prompt.md",
  systemPromptFile: '/home/user/.lockkeeper/agent-0/system.md',
  sessionId: 'session-123',
  resume: false,
  maxTurns: 40,
  maxBudgetUsd: 2.5,
  model: 'some-model',
  ...overrides,
});

const REPORT = (summary: string) =>
  `Done.\n<lockkeeper-report>\n${JSON.stringify({
    summary,
    criteria: [
      { criterion: 'hello.txt exists', met: true, evidence: 'test -f hello.txt passes' },
      { criterion: 'It says hello', met: true, evidence: 'grep finds hello' },
    ],
    tests: [],
    risks: [],
  })}\n</lockkeeper-report>`;

function harness(adapter: AgentAdapter, rounds: object[], extraConfig = '') {
  const root = mkdtempSync(join(tmpdir(), 'lockkeeper-conformance-'));
  const remote = makeRemoteRepo(root, { 'README.md': '# Demo\n' });
  const script = join(root, 'agent-script.json');
  writeFileSync(script, JSON.stringify({ rounds }));
  const sandboxes = new LocalSandboxProvider({
    root,
    binDir: makeBinDir(root),
    env: { FAKE_AGENT_SCRIPT: script },
  });
  const tracker = fakeTracker(ticketFixture());
  const scm = new FakeScm(remote.bare, remote.sha);
  const store = Store.open(':memory:');
  const deps: RunDeps = {
    config: testConfig(
      `repo:\n  setup: []\n  verify: ['test -f hello.txt', 'grep -q hello hello.txt']\n${extraConfig}`,
    ),
    tracker,
    scm,
    sandboxes,
    agent: adapter,
    store,
    modelKey: { mode: 'egress', secretName: 'lk-test-key' },
    pollMs: 20,
  };
  const call = (index: number) =>
    JSON.parse(
      readFileSync(
        join(sandboxes.sandboxes[0]?.homeDir ?? '', `.fake-agent-call-${index}.json`),
        'utf8',
      ),
    ) as {
      args: string[];
      prompt: string;
      systemPrompt?: string;
      sessionId?: string;
      resumed?: string | null;
    };
  return { root, deps, scm, sandboxes, store, call };
}

describe.each(CASES)('the $name adapter', ({ make, sealed }) => {
  let root: string | undefined;
  let sandboxes: LocalSandboxProvider | undefined;

  afterEach(async () => {
    if (sandboxes) await waitForAgents(sandboxes.sandboxes);
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
    sandboxes = undefined;
  });

  it('builds a headless command that keeps repository settings and the web out', () => {
    const command = make().command(invocation());
    for (const fragment of sealed) expect(command).toContain(fragment);
    // The prompt comes from Lockkeeper's file, quoted for the shell.
    expect(command).toContain(`'/home/user/.lockkeeper/agent-0/it'"'"'s prompt.md'`);
    expect(command).toContain('some-model');
  });

  it('continues a session by its ID', () => {
    const adapter = make();
    const fresh = adapter.command(invocation());
    const resumed = adapter.command(invocation({ resume: true }));
    expect(resumed).toContain('session-123');
    expect(resumed).not.toBe(fresh);
  });

  it('keeps the model key out of its own environment, and names where it goes', () => {
    const adapter = make();
    for (const keyInEnvironment of [true, false]) {
      const env = adapter.environment({ keyInEnvironment });
      expect(Object.keys(env)).not.toContain(adapter.credential.env);
      expect(Object.values(env).join(' ')).not.toMatch(/sk-|key-/i);
    }
    expect(adapter.credential.header).toMatch(/^[a-z-]+$/);
    expect(allowList({ agentDomains: [adapter.credential.host], extra: [] })).toContain(
      adapter.credential.host,
    );
  });

  it('reads a CLI that prints nothing useful without crashing', () => {
    const parser = make().parser();
    expect(parser.parse('')).toEqual([]);
    expect(parser.parse('not json')).toEqual([{ type: 'unparsed', line: 'not json' }]);
  });

  it('takes a ticket to a pull request, resuming its own session for a fix round', async () => {
    const adapter = make();
    const h = harness(adapter, [
      { writes: { 'hello.txt': 'hi\n' }, text: REPORT('Added hello.txt.') },
      { writes: { 'hello.txt': 'hello\n' }, text: REPORT('Fixed the greeting.') },
    ]);
    root = h.root;
    sandboxes = h.sandboxes;
    const result = await runTicket(h.deps, { ticketKey: 'DEMO-1', triggeredBy: 'test' });

    expect(result.outcome).toBe('pr');
    expect(h.scm.pullRequests).toHaveLength(1);
    expect(h.scm.pullRequests[0]?.draft).toBe(false);
    const run = h.store.listRuns()[0];
    expect(run?.fixRounds).toBe(1);
    expect(run?.costUsd).toBeGreaterThan(0);
    // The fix round continued the session the first invocation reported.
    const first = h.call(0);
    const second = h.call(1);
    const reported = first.sessionId ?? run?.sessionId;
    expect(run?.sessionId).toBe(reported);
    expect(second.args.join(' ')).toContain(reported as string);
    expect(second.prompt).toContain('Lockkeeper ran the checks after you stopped');
    // A new session gets Lockkeeper's instructions, as a system prompt or in its prompt.
    expect(`${first.systemPrompt ?? ''}${first.prompt}`).toContain('implementation agent');
    expect(second.prompt).not.toContain('implementation agent');
  });

  it('reports a failed agent as a failed run', async () => {
    const h = harness(make(), [{ text: 'It broke.', subtype: 'error_during_execution' }]);
    root = h.root;
    sandboxes = h.sandboxes;
    const result = await runTicket(h.deps, { ticketKey: 'DEMO-1', triggeredBy: 'test' });
    expect(result.outcome).toBe('failed');
    expect(h.scm.pullRequests).toHaveLength(0);
  });
});

describe('caps the control plane enforces', () => {
  let root: string | undefined;
  let sandboxes: LocalSandboxProvider | undefined;

  afterEach(async () => {
    if (sandboxes) await waitForAgents(sandboxes.sandboxes);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('stops an OpenCode run as soon as its reported cost passes the cap', async () => {
    const h = harness(
      new OpenCodeAdapter({ model: 'anthropic/claude-opus-5-5' }),
      [{ writes: { 'hello.txt': 'hello\n' }, costUsd: 0.75, sleepMs: 20_000, text: 'Done.' }],
      'limits:\n  cost_usd: 0.5\n',
    );
    root = h.root;
    sandboxes = h.sandboxes;
    const started = Date.now();
    const result = await runTicket(h.deps, { ticketKey: 'DEMO-1', triggeredBy: 'test' });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.error).toBeInstanceOf(CapExceededError);
    expect(result.run.costUsd).toBeCloseTo(0.75, 5);
  });

  it('turns Codex token counts into a cost with the configured prices', () => {
    const parser = new CodexAdapter({
      prices: { input: 1, cachedInput: 0.1, output: 10 },
    }).parser();
    parser.parse(JSON.stringify({ type: 'thread.started', thread_id: 't-1' }));
    parser.parse(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'm', type: 'agent_message', text: 'Hi' },
      }),
    );
    const [result] = parser.parse(
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 1_000_000, cached_input_tokens: 500_000, output_tokens: 100_000 },
      }),
    ) as Extract<AgentEvent, { type: 'result' }>[];
    // 0.5M fresh input at $1, 0.5M cached at $0.10 and 0.1M output at $10.
    expect(result?.costUsd).toBeCloseTo(0.5 + 0.05 + 1, 6);
    expect(result).toMatchObject({ ok: true, text: 'Hi', sessionId: 't-1' });
    // Without prices, Codex runs report no cost rather than a wrong one.
    const plain = new CodexAdapter().parser();
    const [unpriced] = plain.parse(JSON.stringify({ type: 'turn.completed', usage: {} }));
    expect(unpriced).not.toHaveProperty('costUsd');
  });

  it('refuses an OpenCode provider whose key it cannot keep outside the sandbox', () => {
    expect(() => new OpenCodeAdapter({ model: 'ollama/llama4' })).toThrow(/ollama/);
  });
});
