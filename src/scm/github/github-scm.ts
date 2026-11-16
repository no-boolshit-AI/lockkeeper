import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { LockkeeperError } from '../../core/errors.js';
import {
  type BaseRef,
  type CloneAccess,
  type CommitInput,
  type CommitResult,
  type PullRequest,
  type PullRequestInput,
  parseRepo,
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
}
