/**
 * The source-control interface (P2: wrap every GitHub call so GitLab and Bitbucket can
 * follow). There is deliberately no merge or approve method (V5), and no way to
 * force-push or delete a branch (V3).
 */

export interface RepoId {
  owner: string;
  name: string;
}

export function parseRepo(slug: string): RepoId {
  const [owner, name, ...rest] = slug.split('/');
  if (!owner || !name || rest.length > 0) throw new Error(`Not a repository slug: ${slug}`);
  return { owner, name };
}

export interface BaseRef {
  branch: string;
  sha: string;
}

/** How a sandbox clones the repository: read-only, one repository, short-lived (E3). */
export interface CloneAccess {
  /** HTTPS URL without credentials. */
  url: string;
  /** Value for git's `http.extraHeader`, passed per command and never written to disk. */
  authHeader?: string;
  expiresAt?: string;
}

export type FileMode = '100644' | '100755' | '120000';

export type FileChange =
  | { path: string; action: 'upsert'; mode: FileMode; content: Uint8Array }
  | { path: string; action: 'delete' };

export interface CommitInput {
  repo: string;
  branch: string;
  /** Parent commit. For a new branch, the base commit the sandbox cloned. */
  parentSha: string;
  message: string;
  changes: FileChange[];
  /** True to create the branch (fails if it exists); false to fast-forward a branch Lockkeeper created. */
  createBranch: boolean;
}

export interface CommitResult {
  sha: string;
  url: string;
  verified: boolean | undefined;
}

export interface PullRequestInput {
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface PullRequest {
  number: number;
  url: string;
  draft: boolean;
  state: string;
}

export interface BranchHead {
  sha: string;
  message: string;
}

/** A repository rule that applies to a branch, such as a ruleset restricting creation. */
export interface BranchRule {
  type: string;
  rulesetId?: number;
}

/** A pull request's state, as the review watcher polls it (F1, F2). */
export interface PullRequestStatus {
  number: number;
  state: 'open' | 'merged' | 'closed';
  /** Changes with every comment, review and push, so unchanged PRs can be skipped. */
  updatedAt: string;
  headSha: string;
  draft: boolean;
}

/** One piece of feedback on a pull request: a review, a comment or an inline comment. */
export interface PullRequestFeedback {
  /** Unique across kinds, such as `review:12`, `comment:34` or `inline:56`. */
  id: string;
  kind: 'review' | 'comment' | 'inline';
  author: { login: string; bot: boolean };
  /** Reviews only. */
  reviewState?: 'changes_requested' | 'commented' | 'approved' | 'dismissed';
  body: string;
  /** Inline comments: where they are, and the review they belong to. */
  path?: string;
  line?: number;
  reviewId?: string;
  url: string;
  createdAt: string;
}

/** A person's access to a repository, from most to least. */
export type RepoPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

export function canWrite(permission: RepoPermission): boolean {
  return permission === 'admin' || permission === 'maintain' || permission === 'write';
}

export interface CheckFailure {
  name: string;
  /** Such as failure or timed_out. */
  conclusion: string;
  url?: string;
  /** Summary, annotations and the end of the log, where requested and available. */
  details?: string;
}

/** The CI result for one commit: checks and commit statuses together. */
export interface CheckStatus {
  /** `none` when nothing reported on the commit; `pending` while anything still runs. */
  state: 'none' | 'pending' | 'success' | 'failure';
  failures: CheckFailure[];
}

export type PermissionNeeds = Record<string, 'read' | 'write'>;

/** What Lockkeeper cannot work without. */
export const REQUIRED_PERMISSIONS: PermissionNeeds = {
  metadata: 'read',
  contents: 'write',
  pull_requests: 'write',
};

/** What CI fix rounds need, to see check results, commit statuses and job logs. */
export const CI_PERMISSIONS: PermissionNeeds = {
  checks: 'read',
  statuses: 'read',
  actions: 'read',
};

export interface SourceControl {
  readonly kind: string;
  /**
   * Permissions from `needed` (by default the required ones) that Lockkeeper lacks on
   * the repository, such as `contents: write`. Throws, with a hint, if it has no access.
   */
  missingPermissions(repo: string, needed?: PermissionNeeds): Promise<string[]>;
  /** The repository rules that would apply to a branch with this name. */
  branchRules(repo: string, branch: string): Promise<BranchRule[]>;
  resolveBase(repo: string, branch: string): Promise<BaseRef>;
  cloneAccess(repo: string): Promise<CloneAccess>;
  branchExists(repo: string, branch: string): Promise<boolean>;
  /** The newest commit on a branch, or undefined if the branch does not exist. */
  branchHead(repo: string, branch: string): Promise<BranchHead | undefined>;
  commit(input: CommitInput): Promise<CommitResult>;
  openPullRequest(input: PullRequestInput): Promise<PullRequest>;
  /** The newest pull request from a branch, open or not. */
  findPullRequest(repo: string, head: string): Promise<PullRequest | undefined>;
  /** Change a pull request's title, body or draft state, as when a retry adds a commit. */
  updatePullRequest(
    repo: string,
    number: number,
    update: { title?: string; body?: string; draft?: boolean },
  ): Promise<PullRequest>;
  /** The current state of these pull requests. Ones that cannot be read are left out. */
  pullRequestStatuses(repo: string, numbers: number[]): Promise<Map<number, PullRequestStatus>>;
  /** Reviews, comments and inline comments created at or after `since`, oldest first. */
  pullRequestFeedback(repo: string, number: number, since: string): Promise<PullRequestFeedback[]>;
  /** What a user may do in the repository. Only writers can ask for follow-ups (F1). */
  repositoryPermission(repo: string, login: string): Promise<RepoPermission>;
  /** Reply on a pull request's conversation. */
  commentOnPullRequest(
    repo: string,
    number: number,
    body: string,
  ): Promise<{ id: string; url: string }>;
  /** Show that feedback was picked up, such as with a reaction. Best effort. */
  acknowledge(repo: string, feedback: PullRequestFeedback): Promise<void>;
  /** CI results for a commit. `details` adds summaries and log ends to failures. */
  checkStatus(repo: string, sha: string, options?: { details?: boolean }): Promise<CheckStatus>;
}
