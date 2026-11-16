import { LockkeeperError } from '../../core/errors.js';
import type { AdfDoc, AdfNode } from './adf.js';

export class JiraApiError extends LockkeeperError {
  constructor(
    readonly status: number,
    message: string,
    hint?: string,
  ) {
    super(message, hint);
  }
}

export interface JiraUser {
  accountId: string;
  displayName?: string;
  emailAddress?: string;
  accountType?: string;
}

export interface JiraLinkedIssue {
  key: string;
  fields?: { summary?: string; status?: { name?: string } };
}

export interface JiraIssue {
  key: string;
  fields: {
    summary?: string;
    description?: AdfNode | string | null;
    issuetype?: { name?: string };
    status?: { name?: string };
    labels?: string[];
    components?: { name?: string }[];
    priority?: { name?: string } | null;
    reporter?: JiraUser | null;
    assignee?: JiraUser | null;
    project?: { key?: string; name?: string };
    issuelinks?: {
      type?: { inward?: string; outward?: string };
      inwardIssue?: JiraLinkedIssue;
      outwardIssue?: JiraLinkedIssue;
    }[];
    attachment?: { filename?: string; mimeType?: string; size?: number }[];
    [field: string]: unknown;
  };
  /** Field ID to display name, present with `expand=names`. */
  names?: Record<string, string>;
}

export interface JiraComment {
  id: string;
  author?: JiraUser;
  created: string;
  body?: AdfNode | string;
}

export interface JiraTransition {
  id: string;
  name: string;
  to?: { name?: string };
}

export interface JiraClientOptions {
  /** Host name, such as acme.atlassian.net. */
  site: string;
  email: string;
  token: string;
  fetch?: typeof fetch;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

type Query = Record<string, string | number | boolean | undefined>;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A minimal Jira Cloud REST v3 client. It works with classic API tokens on the site
 * URL and with scoped API tokens through the api.atlassian.com gateway, which it
 * switches to on the first 401.
 */
export class JiraClient {
  private base: string;
  private gatewayTried = false;
  private readonly authorization: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: JiraClientOptions) {
    this.base = `https://${options.site}`;
    this.authorization = `Basic ${Buffer.from(`${options.email}:${options.token}`).toString('base64')}`;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get siteUrl(): string {
    return `https://${this.options.site}`;
  }

  async request<T>(
    method: string,
    path: string,
    init: { body?: unknown; query?: Query } = {},
  ): Promise<T> {
    const retries = this.options.retries ?? 3;
    for (let attempt = 0; ; attempt++) {
      const url = new URL(this.base + path);
      for (const [key, value] of Object.entries(init.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      const headers: Record<string, string> = {
        Authorization: this.authorization,
        Accept: 'application/json',
      };
      if (init.body !== undefined) headers['Content-Type'] = 'application/json';
      const requestInit: RequestInit = { method, headers };
      if (init.body !== undefined) requestInit.body = JSON.stringify(init.body);
      const response = await this.fetchImpl(url, requestInit);

      if (response.status === 401 && !this.gatewayTried) {
        this.gatewayTried = true;
        const gateway = await this.gatewayBase();
        if (gateway) {
          this.base = gateway;
          attempt -= 1;
          continue;
        }
      }
      if ((response.status === 429 || response.status === 503) && attempt < retries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const wait =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
        await this.sleep(Math.min(wait, 30_000));
        continue;
      }
      if (!response.ok) throw await this.toError(response, method, path);
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  /** Scoped API tokens only work through api.atlassian.com/ex/jira/{cloudId}. */
  private async gatewayBase(): Promise<string | undefined> {
    try {
      const response = await this.fetchImpl(`${this.siteUrl}/_edge/tenant_info`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { cloudId?: string };
      return body.cloudId ? `https://api.atlassian.com/ex/jira/${body.cloudId}` : undefined;
    } catch {
      return undefined;
    }
  }

  private async toError(response: Response, method: string, path: string): Promise<JiraApiError> {
    let detail = '';
    try {
      const body = (await response.json()) as {
        errorMessages?: string[];
        errors?: Record<string, string>;
      };
      detail = [
        ...(body.errorMessages ?? []),
        ...Object.entries(body.errors ?? {}).map(([k, v]) => `${k}: ${v}`),
      ].join('; ');
    } catch {
      // Not JSON; the status says enough.
    }
    const hints: Record<number, string> = {
      401: 'Check LOCKKEEPER_JIRA_EMAIL and LOCKKEEPER_JIRA_TOKEN. API tokens expire after at most a year.',
      403: 'The Jira account lacks a permission on this project, or the scoped token lacks a scope.',
      404: 'The issue does not exist, or the Jira account cannot see it.',
    };
    return new JiraApiError(
      response.status,
      `Jira ${method} ${path} failed with ${response.status}${detail ? `: ${detail}` : ''}`,
      hints[response.status],
    );
  }

  myself(): Promise<JiraUser> {
    return this.request('GET', '/rest/api/3/myself');
  }

  getIssue(key: string): Promise<JiraIssue> {
    return this.request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}`, {
      query: { fields: '*all', expand: 'names' },
    });
  }

  async getComments(key: string): Promise<JiraComment[]> {
    const comments: JiraComment[] = [];
    for (let startAt = 0; ; ) {
      const page = await this.request<{
        comments: JiraComment[];
        total: number;
        maxResults: number;
      }>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
        query: { startAt, maxResults: 100, orderBy: 'created' },
      });
      comments.push(...page.comments);
      startAt += page.comments.length;
      if (page.comments.length === 0 || startAt >= page.total) return comments;
    }
  }

  async addComment(key: string, body: AdfDoc): Promise<JiraComment> {
    return this.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      body: { body },
    });
  }

  async updateComment(key: string, id: string, body: AdfDoc): Promise<void> {
    await this.request(
      'PUT',
      `/rest/api/3/issue/${encodeURIComponent(key)}/comment/${encodeURIComponent(id)}`,
      {
        body: { body },
      },
    );
  }

  async updateIssue(key: string, body: unknown): Promise<void> {
    await this.request('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`, { body });
  }

  async addRemoteLink(key: string, body: unknown): Promise<void> {
    await this.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`, { body });
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    const result = await this.request<{ transitions: JiraTransition[] }>(
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    );
    return result.transitions;
  }

  async doTransition(key: string, id: string): Promise<void> {
    await this.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      body: { transition: { id } },
    });
  }
}
