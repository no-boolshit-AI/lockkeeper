import { describe, expect, it } from 'vitest';
import { CapExceededError, LockkeeperError } from '../../src/core/errors.js';
import { Authorizer } from '../../src/engine/authorize.js';
import { parseCommand } from '../../src/engine/commands.js';
import { detectCommands } from '../../src/engine/detect.js';
import { allowList } from '../../src/engine/domains.js';
import {
  gitBlobSha1,
  isObjectId,
  parseBlobExport,
  parseNumstat,
  parseRawDiff,
  toChangedFiles,
} from '../../src/engine/git-diff.js';
import {
  buildSystemPrompt,
  matchCriteria,
  parseAgentReport,
  renderTicket,
  stripReport,
} from '../../src/engine/prompts.js';
import { describeFailure } from '../../src/engine/run.js';
import { tail } from '../../src/engine/workspace.js';
import type { Person } from '../../src/tracker/tracker.js';
import { ticketFixture } from '../support/fakes.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const Z = '0'.repeat(40);

describe('git output parsing', () => {
  it('parses raw diffs with modes and statuses', () => {
    const raw = `:000000 100644 ${Z} ${A} A\0new file.txt\0:100644 100755 ${A} ${B} M\0bin/run\0:100644 000000 ${B} ${Z} D\0old.txt\0`;
    expect(parseRawDiff(raw)).toEqual([
      {
        path: 'new file.txt',
        status: 'added',
        oldMode: '000000',
        newMode: '100644',
        oldSha: Z,
        newSha: A,
      },
      {
        path: 'bin/run',
        status: 'modified',
        oldMode: '100644',
        newMode: '100755',
        oldSha: A,
        newSha: B,
      },
      {
        path: 'old.txt',
        status: 'deleted',
        oldMode: '100644',
        newMode: '000000',
        oldSha: B,
        newSha: Z,
      },
    ]);
    expect(() => parseRawDiff(':garbage\0x\0')).toThrow(/Unexpected/);
    expect(() => parseRawDiff(`:100644 100644 abc ${A} M\0x\0`)).toThrow(/Invalid object ID/);
  });

  it('parses numstat, including binaries, and joins it to the raw diff', () => {
    const stats = parseNumstat('3\t1\tsrc/a.ts\0-\t-\tlogo.png\0');
    expect(stats.get('logo.png')).toEqual({ added: null, removed: null });
    const files = toChangedFiles(parseRawDiff(`:100644 100644 ${A} ${B} M\0src/a.ts\0`), stats);
    expect(files[0]).toMatchObject({ path: 'src/a.ts', added: 3, removed: 1, newSha: B });
  });

  it('computes git blob IDs and parses exported blobs', () => {
    const content = new TextEncoder().encode('hello\n');
    expect(gitBlobSha1(content)).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    const exported = parseBlobExport(
      `ce013625030ba8dba906f756967f9e9ca394464a ${Buffer.from(content).toString('base64')}\n`,
    );
    expect(exported.get('ce013625030ba8dba906f756967f9e9ca394464a')).toEqual(content);
    expect(() => parseBlobExport('not-a-sha abc\n')).toThrow();
    expect(isObjectId(A)).toBe(true);
    expect(isObjectId('main')).toBe(false);
  });
});

describe('prompts and the agent report', () => {
  it('parses the last report block and ignores malformed ones', () => {
    const text = `Working.\n<lockkeeper-report>{"summary":"old"}</lockkeeper-report>\nMore.\n<lockkeeper-report>\n\`\`\`json\n{"summary":"new","criteria":[{"criterion":"c","met":true,"evidence":"e"}]}\n\`\`\`\n</lockkeeper-report>`;
    expect(parseAgentReport(text)).toEqual({
      summary: 'new',
      criteria: [{ criterion: 'c', met: true, evidence: 'e' }],
      tests: [],
      risks: [],
    });
    expect(parseAgentReport('<lockkeeper-report>{nope</lockkeeper-report>')).toBeUndefined();
    expect(parseAgentReport('no report')).toBeUndefined();
    expect(stripReport(text)).toBe('Working.\n\nMore.');
  });

  it('matches criteria by text, then by position, and requires evidence', () => {
    const report = {
      summary: '',
      tests: [],
      risks: [],
      criteria: [
        { criterion: 'Discount tests still pass', met: true, evidence: '214 passed' },
        { criterion: 'Total rounds half up to 2 decimals', met: true, evidence: '' },
      ],
    };
    expect(
      matchCriteria(['Total rounds half up to 2 decimals', 'Discount tests still pass'], report),
    ).toEqual([
      { criterion: 'Total rounds half up to 2 decimals', met: false, evidence: '' },
      { criterion: 'Discount tests still pass', met: true, evidence: '214 passed' },
    ]);
    expect(
      matchCriteria(['A', 'B'], {
        ...report,
        criteria: [
          { criterion: 'x', met: true, evidence: 'e1' },
          { criterion: 'y', met: true, evidence: 'e2' },
        ],
      })[1],
    ).toMatchObject({ met: true, evidence: 'e2' });
    expect(matchCriteria(['A'], undefined)).toEqual([{ criterion: 'A', met: false, evidence: '' }]);
    expect(matchCriteria([], report)).toHaveLength(2);
  });

  it('renders the ticket with caps and says when criteria are missing', () => {
    const rendered = renderTicket(
      ticketFixture({ description: 'x'.repeat(40_000), acceptanceCriteria: [] }),
    );
    expect(rendered).toContain('cut by Lockkeeper');
    expect(rendered).toContain('lists no acceptance criteria');
  });

  it('tells the agent the rules and the report format', () => {
    const prompt = buildSystemPrompt({
      workflow: 'feature',
      workdir: '/home/user/repo',
      verify: ['npm test'],
      instructions: [],
    });
    expect(prompt).toContain('Do not commit, push or create branches');
    expect(prompt).toContain('`npm test`');
    expect(prompt).toContain('<lockkeeper-report>');
    expect(prompt).not.toContain('bug fix');
  });
});

describe('environment detection', () => {
  it('detects Node projects and their scripts', () => {
    expect(
      detectCommands(['package.json', 'package-lock.json'], {
        scripts: { lint: 'biome check', test: 'vitest' },
      }),
    ).toEqual({
      setup: ['npm ci'],
      verify: ['npm run lint', 'npm run test'],
      source: 'package.json',
    });
    expect(
      detectCommands(['package.json', 'pnpm-lock.yaml'], {
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }).verify,
    ).toEqual([]);
    expect(detectCommands(['package.json'], { packageManager: 'yarn@4.5.0' }).setup[0]).toContain(
      'yarn install --immutable',
    );
  });

  it('detects other stacks and falls back to nothing', () => {
    expect(detectCommands(['go.mod']).verify).toEqual(['go vet ./...', 'go test ./...']);
    expect(detectCommands(['uv.lock', 'pyproject.toml']).setup).toEqual(['uv sync']);
    expect(detectCommands(['README.md'])).toEqual({ setup: [], verify: [], source: 'none' });
  });
});

describe('small helpers', () => {
  it('builds a de-duplicated, lower-case allow-list', () => {
    const domains = allowList({
      agentDomains: ['api.anthropic.com'],
      extra: ['Internal.Example.com', 'github.com'],
      registries: ['registry.npmjs.org'],
    });
    expect(domains).toEqual([
      'api.anthropic.com',
      'github.com',
      'codeload.github.com',
      'objects.githubusercontent.com',
      'registry.npmjs.org',
      'internal.example.com',
    ]);
  });

  it('keeps the end of long logs', () => {
    const log = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n');
    expect(tail(log, 3)).toBe('line 97\nline 98\nline 99');
    expect(tail('x'.repeat(5000), 60, 100)).toHaveLength(101);
  });

  it('describes failures for the ticket without leaking secrets', () => {
    expect(describeFailure(new CapExceededError('cost', 'Spent $10.'))).toBe(
      'Stopped at the cost limit. Spent $10.',
    );
    expect(describeFailure(new LockkeeperError('Clone failed.', 'Check the App.'))).toBe(
      'Clone failed. Check the App.',
    );
    expect(describeFailure(new Error(`boom ghp_${'a'.repeat(36)}`))).toBe(
      'Lockkeeper hit an unexpected error: boom [redacted github-token]',
    );
  });
});

describe('ticket commands', () => {
  it('reads /agent commands at the start of a comment', () => {
    expect(parseCommand('/agent stop')).toEqual({ kind: 'stop' });
    expect(parseCommand('  `/agent stop`  ')).toEqual({ kind: 'stop' });
    expect(parseCommand('/agent cancel please')).toEqual({ kind: 'stop' });
    expect(parseCommand('/agent retry use the v2 API\nand keep the old one')).toEqual({
      kind: 'retry',
      hint: 'use the v2 API\nand keep the old one',
    });
    expect(parseCommand('**/agent go** 1. Euro only. 2. Yes')).toEqual({
      kind: 'go',
      text: '1. Euro only. 2. Yes',
    });
    expect(parseCommand('/agent')).toEqual({ kind: 'unknown', word: '(none)' });
    expect(parseCommand('/agent dance')).toEqual({ kind: 'unknown', word: 'dance' });
  });

  it('ignores text that only mentions a command', () => {
    expect(parseCommand('Please do not /agent stop yet')).toBeUndefined();
    expect(parseCommand('/agentsmith')).toBeUndefined();
    expect(parseCommand('')).toBeUndefined();
  });
});

describe('the allow-list (T2)', () => {
  const maria: Person = { accountId: 'acc-maria', displayName: 'Maria', accountType: 'atlassian' };
  const lookups = {
    userGroups: async (id: string) => (id === 'acc-maria' ? ['Tech-Leads'] : []),
    findUsers: async (query: string) =>
      query === 'bob@acme.com' ? [{ accountId: 'acc-bob', displayName: 'Bob' }] : [],
  };

  it('never takes requests from apps or external accounts', async () => {
    const open = new Authorizer(lookups, []);
    expect(open.open).toBe(true);
    expect(await open.check(maria)).toEqual({ allowed: true });
    const app = await open.check({ accountId: 'x', displayName: 'Bot', accountType: 'app' });
    expect(app).toMatchObject({ allowed: false, reason: expect.stringContaining('an app') });
    const customer = await open.check({
      accountId: 'y',
      displayName: 'Cy',
      accountType: 'customer',
    });
    expect(customer).toMatchObject({ allowed: false, reason: expect.stringContaining('external') });
  });

  it('matches account IDs, email addresses and group names', async () => {
    const byGroup = new Authorizer(lookups, ['tech-leads']);
    expect(await byGroup.check(maria)).toEqual({ allowed: true });
    const bob: Person = { accountId: 'acc-bob', displayName: 'Bob', accountType: 'atlassian' };
    expect(await byGroup.check(bob)).toMatchObject({
      allowed: false,
      reason: "Bob is not on Lockkeeper's allow-list.",
    });
    // Jira often hides email addresses, so the address is looked up.
    expect(await new Authorizer(lookups, ['bob@acme.com']).check(bob)).toEqual({ allowed: true });
    expect(
      await new Authorizer(lookups, ['MARIA@acme.com']).check({
        ...maria,
        email: 'maria@acme.com',
      }),
    ).toEqual({ allowed: true });
    const id = '712020:f4b1e929-369a-4ae6-abfa-7d9baf01ea5d';
    expect(await new Authorizer(lookups, [id]).check({ ...bob, accountId: id })).toEqual({
      allowed: true,
    });
  });
});
