import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseConfig } from '../../src/config/load.js';
import type { Config } from '../../src/config/schema.js';
import { LockkeeperError } from '../../src/core/errors.js';
import type {
  BaseRef,
  BranchHead,
  CheckStatus,
  CloneAccess,
  CommitInput,
  CommitResult,
  PullRequest,
  PullRequestFeedback,
  PullRequestInput,
  PullRequestStatus,
  RepoPermission,
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
  readonly pullRequests: (PullRequestInput & { number: number; state: string })[] = [];
  readonly updates: { number: number; body?: string; draft?: boolean }[] = [];
  /** Called before and after each write, so a test can simulate a crash at that point. */
  beforeWrite: ((action: 'commit' | 'pull_request') => void) | undefined;
  afterWrite: ((action: 'commit' | 'pull_request') => void) | undefined;
  private nextPr = 7;
  /** What GitHub would say about each pull request beyond what `pullRequests` holds. */
  readonly prStatus = new Map<number, { state: PullRequestStatus['state']; updatedAt: string }>();
  readonly feedback = new Map<number, PullRequestFeedback[]>();
  /** Repository access by GitHub login. Anyone not listed has none. */
  readonly permissions: Record<string, RepoPermission> = {};
  readonly prComments: { number: number; body: string }[] = [];
  readonly acknowledged: string[] = [];
  /** CI results by commit SHA, and the calls that asked for them. */
  readonly checks = new Map<string, CheckStatus>();
  readonly checkCalls: { sha: string; details: boolean }[] = [];
  private stampMs = 0;
  private nextFeedbackId = 100;

  /** Commits land in the bare repository for real, so a later run can clone them. */
  constructor(
    private readonly bare: string,
    private readonly baseSha: string,
  ) {}

  private git(
    args: string[],
    options: { input?: Buffer; env?: Record<string, string> } = {},
  ): string {
    return execFileSync('git', args, {
      env: { ...gitEnv, GIT_DIR: this.bare, ...options.env },
      encoding: 'utf8',
      ...(options.input ? { input: options.input } : {}),
    }).trim();
  }

  private ref(branch: string): string | undefined {
    try {
      return this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    } catch {
      return undefined;
    }
  }

  /** Make a branch exist, as if someone else had pushed it. */
  addBranch(branch: string, message = 'Someone else'): string {
    const tree = this.git(['rev-parse', `${this.baseSha}^{tree}`]);
    const sha = this.git(['commit-tree', tree, '-p', this.baseSha, '-m', message]);
    this.git(['update-ref', `refs/heads/${branch}`, sha]);
    return sha;
  }

  async resolveBase(_repo: string, branch: string): Promise<BaseRef> {
    const sha = this.ref(branch);
    if (!sha) throw new LockkeeperError(`Branch ${branch} does not exist in acme/demo.`);
    return { branch, sha };
  }

  async cloneAccess(): Promise<CloneAccess> {
    // A header like the real one, to prove it never lands in .git/config.
    return {
      url: `file://${this.bare}`,
      authHeader: 'Authorization: Basic eC1hY2Nlc3MtdG9rZW46ZmFrZQ==',
    };
  }

  async branchExists(_repo: string, branch: string): Promise<boolean> {
    return this.ref(branch) !== undefined;
  }

  /** Set to make the App look under-permissioned or blocked by rules. */
  missing: string[] = [];
  /** Missing permissions that only CI fix rounds need. */
  missingCi: string[] = [];
  rules: { type: string }[] = [];

  async missingPermissions(_repo: string, needed?: Record<string, string>): Promise<string[]> {
    return needed && 'checks' in needed ? this.missingCi : this.missing;
  }

  async branchRules(): Promise<{ type: string }[]> {
    return this.rules;
  }

  async branchHead(_repo: string, branch: string): Promise<BranchHead | undefined> {
    const sha = this.ref(branch);
    return sha ? { sha, message: this.git(['log', '-1', '--format=%B', sha]) } : undefined;
  }

  /** Like the Git Data API: blobs, a tree on the parent's tree, a commit, then the ref. */
  async commit(input: CommitInput): Promise<CommitResult> {
    this.beforeWrite?.('commit');
    const env = { GIT_INDEX_FILE: join(this.bare, `index-${this.commits.length}-${Date.now()}`) };
    this.git(['read-tree', input.parentSha], { env });
    for (const change of input.changes) {
      if (change.action === 'delete') {
        this.git(['update-index', '--force-remove', '--', change.path], { env });
        continue;
      }
      const blob = this.git(['hash-object', '-w', '--stdin'], {
        input: Buffer.from(change.content),
      });
      this.git(['update-index', '--add', '--cacheinfo', `${change.mode},${blob},${change.path}`], {
        env,
      });
    }
    const tree = this.git(['write-tree'], { env });
    const sha = this.git(['commit-tree', tree, '-p', input.parentSha, '-m', input.message]);
    const current = this.ref(input.branch);
    // GitHub's rules: creating a branch fails if it exists; updates must fast-forward.
    if (input.createBranch && current) throw new Error(`Reference already exists: ${input.branch}`);
    if (!input.createBranch && current !== input.parentSha)
      throw new Error(`Update is not a fast forward: ${input.branch}`);
    this.git(['update-ref', `refs/heads/${input.branch}`, sha]);
    this.commits.push(input);
    for (const pr of this.pullRequests) if (pr.head === input.branch) this.touch(pr.number);
    this.afterWrite?.('commit');
    return { sha, url: `https://github.com/acme/demo/commit/${sha}`, verified: true };
  }

  private toPr(pr: { number: number; draft: boolean; state: string }): PullRequest {
    return {
      number: pr.number,
      url: `https://github.com/acme/demo/pull/${pr.number}`,
      draft: pr.draft,
      state: pr.state,
    };
  }

  async openPullRequest(input: PullRequestInput): Promise<PullRequest> {
    this.beforeWrite?.('pull_request');
    if (this.pullRequests.some((pr) => pr.head === input.head && pr.state === 'open'))
      throw new Error(`A pull request already exists for ${input.head}.`);
    const pr = { ...input, number: this.nextPr++, state: 'open' };
    this.pullRequests.push(pr);
    this.afterWrite?.('pull_request');
    return this.toPr(pr);
  }

  async findPullRequest(_repo: string, head: string): Promise<PullRequest | undefined> {
    const pr = [...this.pullRequests].reverse().find((entry) => entry.head === head);
    return pr ? this.toPr(pr) : undefined;
  }

  async updatePullRequest(
    _repo: string,
    number: number,
    update: { title?: string; body?: string; draft?: boolean },
  ): Promise<PullRequest> {
    const pr = this.pullRequests.find((entry) => entry.number === number);
    if (!pr) throw new Error(`No pull request ${number}`);
    this.updates.push({ number, ...update });
    this.touch(number);
    if (update.title !== undefined) pr.title = update.title;
    if (update.body !== undefined) pr.body = update.body;
    if (update.draft !== undefined) pr.draft = update.draft;
    return this.toPr(pr);
  }

  /** A strictly increasing timestamp, like GitHub's updated_at after each change. */
  private stamp(): string {
    this.stampMs = Math.max(Date.now(), this.stampMs + 1);
    return new Date(this.stampMs).toISOString();
  }

  private touch(number: number): void {
    const status = this.prStatus.get(number) ?? { state: 'open' as const, updatedAt: '' };
    status.updatedAt = this.stamp();
    this.prStatus.set(number, status);
  }

  /** Merge or close a pull request, as a person would on GitHub. */
  setPrState(number: number, state: PullRequestStatus['state']): void {
    this.touch(number);
    (this.prStatus.get(number) as { state: PullRequestStatus['state'] }).state = state;
    const pr = this.pullRequests.find((entry) => entry.number === number);
    if (pr) pr.state = state === 'open' ? 'open' : 'closed';
  }

  /** Someone reviews or comments on a pull request. */
  addFeedback(
    number: number,
    item: Partial<PullRequestFeedback> & { body: string },
  ): PullRequestFeedback {
    const kind = item.kind ?? 'comment';
    const entry: PullRequestFeedback = {
      id: `${kind}:${this.nextFeedbackId++}`,
      kind,
      author: { login: 'alice', bot: false },
      url: `https://github.com/acme/demo/pull/${number}#feedback`,
      createdAt: new Date().toISOString(),
      ...item,
    };
    this.feedback.set(number, [...(this.feedback.get(number) ?? []), entry]);
    this.touch(number);
    return entry;
  }

  async pullRequestStatuses(
    _repo: string,
    numbers: number[],
  ): Promise<Map<number, PullRequestStatus>> {
    const found = new Map<number, PullRequestStatus>();
    for (const number of numbers) {
      const pr = this.pullRequests.find((entry) => entry.number === number);
      if (!pr) continue;
      const status = this.prStatus.get(number);
      found.set(number, {
        number,
        state: status?.state ?? 'open',
        updatedAt: status?.updatedAt ?? 'initial',
        headSha: this.ref(pr.head) ?? '',
        draft: pr.draft,
      });
    }
    return found;
  }

  async pullRequestFeedback(
    _repo: string,
    number: number,
    since: string,
  ): Promise<PullRequestFeedback[]> {
    const sinceMs = Date.parse(since);
    return (this.feedback.get(number) ?? []).filter(
      (entry) => Date.parse(entry.createdAt) >= sinceMs,
    );
  }

  async repositoryPermission(_repo: string, login: string): Promise<RepoPermission> {
    return this.permissions[login] ?? 'none';
  }

  async commentOnPullRequest(
    _repo: string,
    number: number,
    body: string,
  ): Promise<{ id: string; url: string }> {
    this.prComments.push({ number, body });
    this.touch(number);
    const id = String(this.nextFeedbackId++);
    return { id, url: `https://github.com/acme/demo/pull/${number}#issuecomment-${id}` };
  }

  async acknowledge(_repo: string, feedback: PullRequestFeedback): Promise<void> {
    this.acknowledged.push(feedback.id);
  }

  async checkStatus(
    _repo: string,
    sha: string,
    options: { details?: boolean } = {},
  ): Promise<CheckStatus> {
    this.checkCalls.push({ sha, details: options.details === true });
    const status = this.checks.get(sha) ?? { state: 'none', failures: [] };
    return options.details
      ? status
      : {
          state: status.state,
          failures: status.failures.map(({ details: _details, ...rest }) => rest),
        };
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
${extra.includes('readiness:') ? '' : 'readiness:\n  enabled: false\n'}${extra}
`);
}
