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

export interface SourceControl {
  readonly kind: string;
  resolveBase(repo: string, branch: string): Promise<BaseRef>;
  cloneAccess(repo: string): Promise<CloneAccess>;
  branchExists(repo: string, branch: string): Promise<boolean>;
  commit(input: CommitInput): Promise<CommitResult>;
  openPullRequest(input: PullRequestInput): Promise<PullRequest>;
  findPullRequest(repo: string, head: string): Promise<PullRequest | undefined>;
}
