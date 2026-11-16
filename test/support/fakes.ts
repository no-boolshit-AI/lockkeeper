import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseConfig } from '../../src/config/load.js';
import type { Config } from '../../src/config/schema.js';
import type {
  BaseRef,
  BranchHead,
  CloneAccess,
  CommitInput,
  CommitResult,
  PullRequest,
  PullRequestInput,
  SourceControl,
} from '../../src/scm/scm.js';
import { RecordingTracker } from '../../src/tracker/recording-tracker.js';
import type { TicketSnapshot } from '../../src/tracker/tracker.js';

export function ticketFixture(overrides: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return {
    key: 'DEMO-1',
    project: 'DEMO',
    url: 'https://acme.atlassian.net/browse/DEMO-1',
    summary: 'Add a greeting file',
    issueType: 'Story',
    status: 'To Do',
    labels: ['agent'],
    components: [],
    reporter: { accountId: 'acc-maria', displayName: 'Maria', accountType: 'atlassian' },
    description: 'Create hello.txt with a friendly greeting.',
    acceptanceCriteria: ['hello.txt exists', 'It says hello'],
    acceptanceCriteriaSource: 'description',
    comments: [],
    links: [],
    attachments: [],
    externalAuthors: [],
    hiddenText: { invisibleChars: 0, hiddenSegments: 0 },
    capturedAt: '2026-11-16T10:00:00.000Z',
    ...overrides,
  };
}

export function fakeTracker(ticket: TicketSnapshot): RecordingTracker {
  return new RecordingTracker({
    kind: 'fake-jira',
    whoami: async () => ({ accountId: 'acc-lockkeeper', displayName: 'Lockkeeper' }),
    snapshot: async () => ticket,
    ticketUrl: (key) => `https://acme.atlassian.net/browse/${key}`,
  });
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
}

/** A bare repository with one commit on main, as the "remote" the sandbox clones. */
export function makeRemoteRepo(
  root: string,
  files: Record<string, string>,
): { bare: string; sha: string } {
  const work = join(root, 'seed');
  mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), content);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'Initial commit');
  const sha = git(work, 'rev-parse', 'HEAD');
  const bare = join(root, 'remote.git');
  git(root, 'clone', '-q', '--bare', work, bare);
  return { bare, sha };
}

/** Records publishing instead of calling GitHub. Clones come from a local bare repository. */
export class FakeScm implements SourceControl {
  readonly kind = 'fake-github';
  readonly commits: CommitInput[] = [];
  readonly pullRequests: PullRequestInput[] = [];
  readonly existingBranches = new Set<string>();
  /** Head commits by branch, for branches that exist. */
  readonly heads = new Map<string, BranchHead>();
  /** Called before and after each write, so a test can simulate a crash at that point. */
  beforeWrite: ((action: 'commit' | 'pull_request') => void) | undefined;
  afterWrite: ((action: 'commit' | 'pull_request') => void) | undefined;

  constructor(
    private readonly bare: string,
    private readonly baseSha: string,
  ) {}

  async branchHead(_repo: string, branch: string): Promise<BranchHead | undefined> {
    if (!this.existingBranches.has(branch)) return undefined;
    return this.heads.get(branch) ?? { sha: 'f'.repeat(40), message: 'Someone else' };
  }

  async resolveBase(_repo: string, branch: string): Promise<BaseRef> {
    return { branch, sha: this.baseSha };
  }

  async cloneAccess(): Promise<CloneAccess> {
    // A header like the real one, to prove it never lands in .git/config.
    return {
      url: `file://${this.bare}`,
      authHeader: 'Authorization: Basic eC1hY2Nlc3MtdG9rZW46ZmFrZQ==',
    };
  }

  async branchExists(_repo: string, branch: string): Promise<boolean> {
    return this.existingBranches.has(branch);
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    this.beforeWrite?.('commit');
    this.commits.push(input);
    this.existingBranches.add(input.branch);
    const sha = 'c'.repeat(40);
    this.heads.set(input.branch, { sha, message: input.message });
    this.afterWrite?.('commit');
    return { sha, url: 'https://github.com/acme/demo/commit/ccc', verified: true };
  }

  async openPullRequest(input: PullRequestInput): Promise<PullRequest> {
    this.beforeWrite?.('pull_request');
    this.pullRequests.push(input);
    this.afterWrite?.('pull_request');
    return {
      number: 7,
      url: 'https://github.com/acme/demo/pull/7',
      draft: input.draft,
      state: 'open',
    };
  }

  async findPullRequest(_repo: string, head: string): Promise<PullRequest | undefined> {
    const pr = this.pullRequests.find((entry) => entry.head === head);
    return pr
      ? { number: 7, url: 'https://github.com/acme/demo/pull/7', draft: pr.draft, state: 'open' }
      : undefined;
  }
}

export function testConfig(extra = ''): Config {
  return parseConfig(`
jira:
  site: acme.atlassian.net
projects:
  DEMO:
    repo: acme/demo
    base_branch: main
store:
  path: ':memory:'
${extra}
`);
}
