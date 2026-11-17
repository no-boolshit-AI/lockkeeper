import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { LockkeeperError } from '../../core/errors.js';
import {
  type BaseRef,
  type BranchHead,
  type BranchRule,
  type CheckFailure,
  type CheckStatus,
  type CloneAccess,
  type CommitInput,
  type CommitResult,
  type PermissionNeeds,
  type PullRequest,
  type PullRequestFeedback,
  type PullRequestInput,
  type PullRequestStatus,
  parseRepo,
  REQUIRED_PERMISSIONS,
  type RepoPermission,
  type SourceControl,
} from '../scm.js';

export interface GitHubOptions {
  appId: string;
  privateKey: string;
  /** For tests and, later, GitHub Enterprise Server. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface RequestErrorLike {
  status?: number;
  message?: string;
}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null
    ? (error as RequestErrorLike).status
    : undefined;
}

interface PullData {
  number: number;
  state: string;
  merged_at?: string | null;
  updated_at: string;
  head: { sha: string };
  draft?: boolean;
}

interface UserData {
  login?: string;
  type?: string;
}

interface CheckRunData {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
  details_url?: string | null;
  app?: { slug?: string } | null;
  output?: {
    title?: string | null;
    summary?: string | null;
    text?: string | null;
    annotations_count?: number;
  };
}

interface StatusData {
  context: string;
  state: string;
  description?: string | null;
  target_url?: string | null;
}

const REVIEW_STATES: Record<string, PullRequestFeedback['reviewState']> = {
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  APPROVED: 'approved',
  DISMISSED: 'dismissed',
};

const ROLES: Record<string, RepoPermission> = {
  admin: 'admin',
  maintain: 'maintain',
  write: 'write',
  push: 'write',
  triage: 'triage',
  read: 'read',
  pull: 'read',
  none: 'none',
};

/** Check conclusions that mean the code is at fault. Cancelled runs are left alone. */
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);

function capText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[… cut]`;
}

function toStatus(pr: PullData): PullRequestStatus {
  return {
    number: pr.number,
    state: pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
    updatedAt: pr.updated_at,
    headSha: pr.head.sha,
    draft: Boolean(pr.draft),
  };
}

function authorOf(user: UserData | null | undefined): PullRequestFeedback['author'] {
  return { login: user?.login ?? 'ghost', bot: user?.type === 'Bot' };
}

/** The end of a GitHub Actions job log, without colour codes and timestamps. */
export function logTail(log: string, maxLines = 120, maxChars = 6_000): string {
  const lines = log
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing terminal colour codes
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ''));
  const tailText = lines.slice(-maxLines).join('\n').trim();
  return tailText.length > maxChars ? `…${tailText.slice(-maxChars)}` : tailText;
}

/**
 * GitHub behind the SourceControl interface, acting as a GitHub App.
 *
 * Publishing happens here, in the control plane, never in the sandbox (V3): blobs, a
 * tree and a commit through the Git Data API, then a branch ref and a PR. Commits made
 * this way without custom author or committer are signed by GitHub and show as verified.
 */
export class GitHubSourceControl implements SourceControl {
  readonly kind = 'github';
  private readonly appClient: Octokit;
  private readonly installationIds = new Map<string, number>();
  private readonly clients = new Map<number, Octokit>();
  private appSlug: string | undefined;
  /** ETags of polled resources: GitHub answers an unchanged one with a free 304. */
  private readonly etags = new Map<string, { etag: string; data: unknown }>();

  constructor(private readonly options: GitHubOptions) {
    this.appClient = this.octokit({ appId: options.appId, privateKey: options.privateKey });
  }

  private octokit(auth: Record<string, unknown>): Octokit {
    return new Octokit({
      authStrategy: createAppAuth,
      auth,
      userAgent: 'lockkeeper',
      // Octokit prints every failed request. Lockkeeper handles those and explains them.
      log: { debug: () => {}, info: () => {}, warn: console.warn, error: () => {} },
      ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
      ...(this.options.fetch ? { request: { fetch: this.options.fetch } } : {}),
    });
  }

  private async installUrl(): Promise<string> {
    if (!this.appSlug) {
      try {
        const { data } = await this.appClient.rest.apps.getAuthenticated();
        this.appSlug = data?.slug;
      } catch {
        // Fall through to the generic hint.
      }
    }
    return this.appSlug
      ? `https://github.com/apps/${this.appSlug}/installations/new`
      : 'the GitHub App settings page';
  }

  private async installationId(repo: string): Promise<number> {
    const { owner, name } = parseRepo(repo);
    const cached = this.installationIds.get(repo);
    if (cached) return cached;
    try {
      const { data } = await this.appClient.rest.apps.getRepoInstallation({ owner, repo: name });
      this.installationIds.set(repo, data.id);
      return data.id;
    } catch (error) {
      if (statusOf(error) === 404) {
        throw new LockkeeperError(
          `The GitHub App is not installed on ${repo}, or cannot see it.`,
          `Install it on the repository from ${await this.installUrl()}.`,
          { cause: error },
        );
      }
      if (statusOf(error) === 401) {
        throw new LockkeeperError(
          'GitHub rejected the App credentials.',
          'Check LOCKKEEPER_GITHUB_APP_ID and the private key. Keys are revoked when deleted in the App settings.',
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async client(repo: string): Promise<Octokit> {
    const installationId = await this.installationId(repo);
    let client = this.clients.get(installationId);
    if (!client) {
      client = this.octokit({
        appId: this.options.appId,
        privateKey: this.options.privateKey,
        installationId,
      });
      this.clients.set(installationId, client);
    }
    return client;
  }

  async resolveBase(repo: string, branch: string): Promise<BaseRef> {
    const { owner, name } = parseRepo(repo);
    const client = await this.client(repo);
    try {
      const { data } = await client.rest.git.getRef({ owner, repo: name, ref: `heads/${branch}` });
      return { branch, sha: data.object.sha };
    } catch (error) {
      if (statusOf(error) === 404) {
        throw new LockkeeperError(
          `Branch ${branch} does not exist in ${repo}.`,
          'Check base_branch in lockkeeper.yml.',
          {
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  /**
   * A token limited to reading this one repository, valid for at most an hour (E3).
   * It is handed to git as a per-command header so it is never written to .git/config.
   */
  async cloneAccess(repo: string): Promise<CloneAccess> {
    const { owner, name } = parseRepo(repo);
    const installationId = await this.installationId(repo);
    const result = (await this.appClient.auth({
      type: 'installation',
      installationId,
      repositoryNames: [name],
      permissions: { contents: 'read' },
      refresh: true,
    })) as { token: string; expiresAt: string };
    const basic = Buffer.from(`x-access-token:${result.token}`).toString('base64');
    return {
      url: `https://github.com/${owner}/${name}.git`,
      authHeader: `Authorization: Basic ${basic}`,
      expiresAt: result.expiresAt,
    };
  }

  async branchExists(repo: string, branch: string): Promise<boolean> {
    const { owner, name } = parseRepo(repo);
    const client = await this.client(repo);
    try {
      await client.rest.git.getRef({ owner, repo: name, ref: `heads/${branch}` });
      return true;
    } catch (error) {
      if (statusOf(error) === 404) return false;
      throw error;
    }
  }

  async missingPermissions(
    repo: string,
    needed: PermissionNeeds = REQUIRED_PERMISSIONS,
  ): Promise<string[]> {
    const { owner, name } = parseRepo(repo);
    await this.installationId(repo);
    const { data } = await this.appClient.rest.apps.getRepoInstallation({ owner, repo: name });
    const granted = (data.permissions ?? {}) as Record<string, string | undefined>;
    return Object.entries(needed)
      .filter(([permission, level]) => {
        const has = granted[permission];
        return level === 'write' ? has !== 'write' && has !== 'admin' : has === undefined;
      })
      .map(([permission, level]) => `${permission}: ${level}`);
  }

  async branchRules(repo: string, branch: string): Promise<BranchRule[]> {
    const { owner, name } = parseRepo(repo);
    const client = await this.client(repo);
    const { data } = await client.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', {
      owner,
      repo: name,
      branch,
    });
    return (data as { type: string; ruleset_id?: number }[]).map((rule) => ({
      type: rule.type,
      ...(rule.ruleset_id ? { rulesetId: rule.ruleset_id } : {}),
    }));
  }

  async branchHead(repo: string, branch: string): Promise<BranchHead | undefined> {
    const { owner, name } = parseRepo(repo);
    const client = await this.client(repo);
    try {
      const { data: ref } = await client.rest.git.getRef({
        owner,
        repo: name,
        ref: `heads/${branch}`,
      });
      const { data: commit } = await client.rest.git.getCommit({
        owner,
        repo: name,
        commit_sha: ref.object.sha,
      });
      return { sha: commit.sha, message: commit.message };
    } catch (error) {
      if (statusOf(error) === 404) return undefined;
      throw error;
    }
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    const { owner, name } = parseRepo(input.repo);
    const client = await this.client(input.repo);
    const { data: parent } = await client.rest.git.getCommit({
      owner,
      repo: name,
      commit_sha: input.parentSha,
    });

    const tree: {
      path: string;
      mode: '100644' | '100755' | '120000';
      type: 'blob';
      sha: string | null;
    }[] = [];
    for (const change of input.changes) {
      if (change.action === 'delete') {
        tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
        continue;
      }
      const { data: blob } = await client.rest.git.createBlob({
        owner,
        repo: name,
        content: Buffer.from(change.content).toString('base64'),
        encoding: 'base64',
      });
      tree.push({ path: change.path, mode: change.mode, type: 'blob', sha: blob.sha });
    }

    const { data: newTree } = await client.rest.git.createTree({
      owner,
      repo: name,
      base_tree: parent.tree.sha,
      tree,
    });
    // No author or committer: GitHub then signs the commit as the App, and it shows as verified.
    const { data: commit } = await client.rest.git.createCommit({
      owner,
      repo: name,
      message: input.message,
      tree: newTree.sha,
      parents: [input.parentSha],
    });

    if (input.createBranch) {
      await client.rest.git.createRef({
        owner,
        repo: name,
        ref: `refs/heads/${input.branch}`,
        sha: commit.sha,
      });
    } else {
      // Fast-forward only: Lockkeeper never force-pushes (V3).
      await client.rest.git.updateRef({
        owner,
        repo: name,
        ref: `heads/${input.branch}`,
        sha: commit.sha,
        force: false,
      });
    }
    return { sha: commit.sha, url: commit.html_url, verified: commit.verification?.verified };
  }

  async openPullRequest(input: PullRequestInput): Promise<PullRequest> {
    const { owner, name } = parseRepo(input.repo);
    const client = await this.client(input.repo);
    const create = (draft: boolean, title: string) =>
      client.rest.pulls.create({
        owner,
        repo: name,
        head: input.head,
        base: input.base,
        title,
        body: input.body,
        draft,
        maintainer_can_modify: false,
      });
    try {
      const { data } = await create(input.draft, input.title);
      return {
        number: data.number,
        url: data.html_url,
        draft: Boolean(data.draft),
        state: data.state,
      };
    } catch (error) {
      // Private repositories on free plans have no draft PRs. Say so in the title instead.
      const message = (error as RequestErrorLike).message ?? '';
      if (input.draft && statusOf(error) === 422 && /draft/i.test(message)) {
        const { data } = await create(false, `[Draft] ${input.title}`);
        return { number: data.number, url: data.html_url, draft: false, state: data.state };
      }
      throw error;
    }
  }

  async updatePullRequest(
    repo: string,
    number: number,
    update: { title?: string; body?: string; draft?: boolean },
  ): Promise<PullRequest> {
    const { owner, name } = parseRepo(repo);
    const client = await this.client(repo);
    const { data } = await client.rest.pulls.update({
      owner,
      repo: name,
      pull_number: number,
      ...(update.title !== undefined ? { title: update.title } : {}),
      ...(update.body !== undefined ? { body: update.body } : {}),
    });
    let draft = Boolean(data.draft);
    if (update.draft !== undefined && update.draft !== draft) {
      // The REST API cannot change a pull request's draft state; GraphQL can.
      const mutation = update.draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
      try {
        await client.graphql(
          `mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { clientMutationId } }`,
          { id: data.node_id },
        );
        draft = update.draft;
      } catch {
        // Repositories without draft pull requests keep their state; the body says why.
      }
    }
    return { number: data.number, url: data.html_url, draft, state: data.state };
  }

  async findPullRequest(repo: string, head: string): Promise<PullRequest | undefined> {
    const { owner, name } = parseRepo(repo);
    const client = await this.client(repo);
    const { data } = await client.rest.pulls.list({
      owner,
      repo: name,
      head: `${owner}:${head}`,
      state: 'all',
      per_page: 5,
    });
    const pr = data[0];
    return pr
      ? { number: pr.number, url: pr.html_url, draft: Boolean(pr.draft), state: pr.state }
      : undefined;
  }

  /**
   * A polled GET that sends the last ETag. Unchanged answers come back as 304, which
   * does not count against GitHub's rate limit.
   */
  private async conditionalGet<T>(
    client: Octokit,
    route: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const key = `${route} ${JSON.stringify(params)}`;
    const cached = this.etags.get(key);
    const request = client.request as unknown as (
      route: string,
      params: Record<string, unknown>,
    ) => Promise<{ data: unknown; headers: Record<string, string | undefined> }>;
    try {
      const response = await request(route, {
        ...params,
        ...(cached ? { headers: { 'if-none-match': cached.etag } } : {}),
      });
      const etag = response.headers.etag;
      if (etag) {
        this.etags.delete(key);
        this.etags.set(key, { etag, data: response.data });
        if (this.etags.size > 1_000) {
          const oldest = this.etags.keys().next().value;
          if (oldest !== undefined) this.etags.delete(oldest);
        }
      }
      return response.data as T;
    } catch (error) {
      if (statusOf(error) === 304 && cached) return cached.data as T;
      throw error;
    }
  }

  async pullRequestStatuses(
    repo: string,
    numbers: number[],
  ): Promise<Map<number, PullRequestStatus>> {
    const { owner, name } = parseRepo(repo);
    const client = await this.client(repo);
    const found = new Map<number, PullRequestStatus>();
    for (const number of new Set(numbers)) {
      try {
        const pr = await this.conditionalGet<PullData>(
          client,
          'GET /repos/{owner}/{repo}/pulls/{pull_number}',
          { owner, repo: name, pull_number: number },
        );
        found.set(number, toStatus(pr));
      } catch (error) {
        if (statusOf(error) !== 404) throw error;
      }
    }
    return found;
  }

  async pullRequestFeedback(
    repo: string,
    number: number,
    since: string,
  ): Promise<PullRequestFeedback[]> {
    const { owner, name } = parseRepo(repo);
    const client = await this.client(repo);
    const sinceMs = Date.parse(since);
    // Edits bring old comments back into `since` results: only new ones count.
    const isNew = (iso: string | null | undefined): iso is string =>
      typeof iso === 'string' && Date.parse(iso) >= sinceMs;
    const feedback: PullRequestFeedback[] = [];

    const reviews = await client.paginate(client.rest.pulls.listReviews, {
      owner,
      repo: name,
      pull_number: number,
      per_page: 100,
    });
    for (const review of reviews) {
      const state = REVIEW_STATES[review.state];
      if (!state || !isNew(review.submitted_at)) continue;
      feedback.push({
        id: `review:${review.id}`,
        kind: 'review',
        author: authorOf(review.user),
        reviewState: state,
        body: review.body ?? '',
        url: review.html_url,
        createdAt: review.submitted_at,
      });
    }
    const inline = await client.paginate(client.rest.pulls.listReviewComments, {
      owner,
      repo: name,
      pull_number: number,
      since,
      per_page: 100,
    });
    for (const comment of inline) {
      if (!isNew(comment.created_at)) continue;
      const line = comment.line ?? comment.original_line;
      feedback.push({
        id: `inline:${comment.id}`,
        kind: 'inline',
        author: authorOf(comment.user),
        body: comment.body,
        path: comment.path,
        ...(typeof line === 'number' ? { line } : {}),
        ...(comment.pull_request_review_id
          ? { reviewId: `review:${comment.pull_request_review_id}` }
          : {}),
        url: comment.html_url,
        createdAt: comment.created_at,
      });
    }
    const comments = await client.paginate(client.rest.issues.listComments, {
      owner,
      repo: name,
      issue_number: number,
      since,
      per_page: 100,
    });
    for (const comment of comments) {
      if (!isNew(comment.created_at)) continue;
      feedback.push({
        id: `comment:${comment.id}`,
        kind: 'comment',
        author: authorOf(comment.user),
        body: comment.body ?? '',
        url: comment.html_url,
        createdAt: comment.created_at,
      });
    }
    return feedback.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async repositoryPermission(repo: string, login: string): Promise<RepoPermission> {
    const { owner, name } = parseRepo(repo);
    const client = await this.client(repo);
    try {
      const { data } = await client.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo: name,
        username: login,
      });
      const role = (data as { role_name?: string }).role_name ?? data.permission;
      return ROLES[role] ?? 'none';
    } catch (error) {
      if (statusOf(error) === 404) return 'none';
      throw error;
    }
  }

  async commentOnPullRequest(
    repo: string,
    number: number,
    body: string,
  ): Promise<{ id: string; url: string }> {
    const { owner, name } = parseRepo(repo);
    const client = await this.client(repo);
    const { data } = await client.rest.issues.createComment({
      owner,
      repo: name,
      issue_number: number,
      body,
    });
    return { id: String(data.id), url: data.html_url };
  }

  async acknowledge(repo: string, feedback: PullRequestFeedback): Promise<void> {
    const { owner, name } = parseRepo(repo);
    const id = Number(feedback.id.slice(feedback.id.indexOf(':') + 1));
    if (!Number.isSafeInteger(id)) return;
    try {
      const client = await this.client(repo);
      if (feedback.kind === 'comment') {
        await client.rest.reactions.createForIssueComment({
          owner,
          repo: name,
          comment_id: id,
          content: 'eyes',
        });
      } else if (feedback.kind === 'inline') {
        await client.rest.reactions.createForPullRequestReviewComment({
          owner,
          repo: name,
          comment_id: id,
          content: 'eyes',
        });
      }
      // Reviews take no reactions; the reply comes when the follow-up finishes.
    } catch {
      // Best effort: a missing reaction changes nothing about the run.
    }
  }

  async checkStatus(
    repo: string,
    sha: string,
    options: { details?: boolean } = {},
  ): Promise<CheckStatus> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Not a commit SHA: ${sha}`);
    const { owner, name } = parseRepo(repo);
    const client = await this.client(repo);
    const runs = await this.conditionalGet<{ check_runs: CheckRunData[] }>(
      client,
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
      { owner, repo: name, ref: sha, per_page: 100, filter: 'latest' },
    );
    const combined = await this.conditionalGet<{ statuses: StatusData[] }>(
      client,
      'GET /repos/{owner}/{repo}/commits/{ref}/status',
      { owner, repo: name, ref: sha, per_page: 100 },
    );
    let pending = false;
    const failures: { failure: CheckFailure; run?: CheckRunData }[] = [];
    for (const run of runs.check_runs) {
      if (run.status !== 'completed') {
        pending = true;
        continue;
      }
      if (run.conclusion && FAILED_CONCLUSIONS.has(run.conclusion)) {
        const url = run.html_url ?? run.details_url;
        failures.push({
          failure: { name: run.name, conclusion: run.conclusion, ...(url ? { url } : {}) },
          run,
        });
      }
    }
    for (const status of combined.statuses) {
      if (status.state === 'pending') pending = true;
      else if (status.state === 'failure' || status.state === 'error') {
        failures.push({
          failure: {
            name: status.context,
            conclusion: status.state,
            ...(status.target_url ? { url: status.target_url } : {}),
            details: status.description ?? '',
          },
        });
      }
    }
    const reported = runs.check_runs.length + combined.statuses.length;
    const state: CheckStatus['state'] =
      reported === 0 ? 'none' : pending ? 'pending' : failures.length > 0 ? 'failure' : 'success';
    if (options.details && state === 'failure') {
      for (const entry of failures) {
        if (entry.run)
          entry.failure.details = await this.checkRunDetails(client, owner, name, entry.run);
      }
    }
    return { state, failures: failures.map((entry) => entry.failure) };
  }

  /** What a failed check says: its summary, annotations and, for Actions, the log's end. */
  private async checkRunDetails(
    client: Octokit,
    owner: string,
    repo: string,
    run: CheckRunData,
  ): Promise<string> {
    const parts: string[] = [];
    if (run.output?.title) parts.push(run.output.title);
    if (run.output?.summary) parts.push(capText(run.output.summary, 2_000));
    if (run.output?.text) parts.push(capText(run.output.text, 2_000));
    try {
      if (run.output?.annotations_count) {
        const { data } = await client.rest.checks.listAnnotations({
          owner,
          repo,
          check_run_id: run.id,
          per_page: 30,
        });
        const lines = data.map(
          (annotation) =>
            `${annotation.path}:${annotation.start_line}: ${annotation.annotation_level}: ${annotation.message ?? ''}`,
        );
        if (lines.length > 0) parts.push(lines.join('\n'));
      }
      if (run.app?.slug === 'github-actions') {
        // For Actions, a check run's ID is its job's ID. GitHub redirects to the log.
        const response = await client.rest.actions.downloadJobLogsForWorkflowRun({
          owner,
          repo,
          job_id: run.id,
        });
        const log = typeof response.data === 'string' ? response.data : '';
        if (log) parts.push(`End of the job log:\n${logTail(log)}`);
      }
    } catch {
      // Details are a help, not a requirement: the check's name and result still count.
    }
    return capText(parts.join('\n\n'), 8_000);
  }
}
