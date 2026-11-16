// TEST ONLY: an in-memory Jira behind the Tracker interface, for daemon tests. Writes
// change its state, so the daemon sees its own label changes and comments.
import { type Doc, docToPlainText } from '../../src/core/doc.js';
import type {
  LabelChange,
  LabelEvent,
  Person,
  TicketComment,
  TicketRef,
  TicketSnapshot,
  Tracker,
} from '../../src/tracker/tracker.js';
import { ticketFixture } from './fakes.js';

export interface FakeIssue {
  key: string;
  base: TicketSnapshot;
  labels: string[];
  comments: TicketComment[];
  labelEvents: LabelEvent[];
  links: { url: string; title: string }[];
  updated: number;
}

export const LOCKKEEPER: Person = {
  accountId: 'acc-lockkeeper',
  displayName: 'Lockkeeper Bot',
  accountType: 'atlassian',
};

export class FakeJira implements Tracker {
  readonly kind = 'fake-jira';
  readonly issues = new Map<string, FakeIssue>();
  readonly groups = new Map<string, string[]>();
  readonly users: Person[] = [];
  /** Labels changes and other writes, in order, for assertions. */
  readonly log: string[] = [];
  private nextComment = 10_000;
  private nextHistory = 1;
  private clock = 1;

  addIssue(key: string, overrides: Partial<TicketSnapshot> = {}): FakeIssue {
    const base = ticketFixture({
      key,
      url: `https://acme.atlassian.net/browse/${key}`,
      labels: [],
      ...overrides,
    });
    const issue: FakeIssue = {
      key,
      base,
      labels: [...base.labels],
      comments: [],
      labelEvents: [],
      links: [],
      updated: this.clock++,
    };
    this.issues.set(key, issue);
    return issue;
  }

  issue(key: string): FakeIssue {
    const issue = this.issues.get(key);
    if (!issue) throw new Error(`No issue ${key}`);
    return issue;
  }

  addLabel(key: string, label: string, by: Person): void {
    const issue = this.issue(key);
    if (issue.labels.includes(label)) return;
    issue.labels.push(label);
    issue.labelEvents.push({
      label,
      by,
      at: new Date().toISOString(),
      id: `history:${this.nextHistory++}`,
    });
    issue.updated = this.clock++;
  }

  removeLabel(key: string, label: string): void {
    const issue = this.issue(key);
    issue.labels = issue.labels.filter((entry) => entry !== label);
    issue.updated = this.clock++;
  }

  comment(key: string, author: Person, body: string): string {
    const id = String(this.nextComment++);
    this.issue(key).comments.push({ id, author, created: new Date().toISOString(), body });
    return id;
  }

  /** Plain text of every comment, oldest first. */
  texts(key: string): string[] {
    return this.issue(key).comments.map((comment) => comment.body);
  }

  // Tracker -----------------------------------------------------------------

  async whoami(): Promise<Person> {
    return LOCKKEEPER;
  }

  async snapshot(key: string): Promise<TicketSnapshot> {
    const issue = this.issue(key);
    return {
      ...issue.base,
      labels: [...issue.labels],
      comments: issue.comments.filter((comment) => !this.isOwnStatus(comment)),
      capturedAt: new Date().toISOString(),
    };
  }

  /** Understands `key in (...)`, `key = X` and `labels = X`, which is what the daemon sends. */
  async search(query: string, limit = 50): Promise<TicketRef[]> {
    let issues = [...this.issues.values()];
    const keys = /key in \(([^)]*)\)/.exec(query)?.[1] ?? /key = ([A-Z0-9_-]+)/.exec(query)?.[1];
    if (keys) {
      const wanted = keys.split(',').map((key) => key.trim());
      const missing = wanted.find((key) => !this.issues.has(key));
      if (missing) throw new Error(`An issue with key '${missing}' does not exist.`);
      issues = issues.filter((issue) => wanted.includes(issue.key));
    }
    const label = /labels\s*=\s*"?([\w-]+)"?/.exec(query)?.[1];
    if (label) issues = issues.filter((issue) => issue.labels.includes(label));
    return issues
      .sort((a, b) => a.updated - b.updated)
      .slice(0, limit)
      .map((issue) => ({
        key: issue.key,
        labels: [...issue.labels],
        updated: String(issue.updated),
      }));
  }

  async labelAdded(key: string, label: string): Promise<LabelEvent | undefined> {
    return this.issue(key)
      .labelEvents.filter((event) => event.label === label)
      .at(-1);
  }

  async newComments(
    key: string,
    after: { afterId?: string; since: string },
  ): Promise<TicketComment[]> {
    const since = Date.parse(after.since);
    return this.issue(key).comments.filter(
      (comment) =>
        !this.isOwnStatus(comment) &&
        (after.afterId
          ? Number(comment.id) > Number(after.afterId)
          : Date.parse(comment.created) >= since),
    );
  }

  async userGroups(accountId: string): Promise<string[]> {
    return this.groups.get(accountId) ?? [];
  }

  async findUsers(query: string): Promise<Person[]> {
    return this.users.filter((user) => user.email === query || user.displayName === query);
  }

  async postComment(key: string, body: Doc): Promise<string> {
    return this.comment(key, LOCKKEEPER, docToPlainText(body));
  }

  async updateComment(key: string, commentId: string, body: Doc): Promise<void> {
    const comment = this.issue(key).comments.find((entry) => entry.id === commentId);
    if (!comment) throw new Error(`No comment ${commentId} on ${key}`);
    comment.body = docToPlainText(body);
  }

  async updateLabels(key: string, change: LabelChange): Promise<void> {
    const issue = this.issue(key);
    issue.labels = issue.labels.filter((label) => !(change.remove ?? []).includes(label));
    for (const label of change.add ?? [])
      if (!issue.labels.includes(label)) issue.labels.push(label);
    issue.updated = this.clock++;
    this.log.push(
      `${key} labels +[${(change.add ?? []).join(',')}] -[${(change.remove ?? []).join(',')}]`,
    );
  }

  async linkPullRequest(key: string, pr: { url: string; title: string }): Promise<void> {
    const issue = this.issue(key);
    if (!issue.links.some((link) => link.url === pr.url)) issue.links.push(pr);
  }

  async transition(key: string, name: string): Promise<boolean> {
    this.log.push(`${key} transition ${name}`);
    return false;
  }

  ticketUrl(key: string): string {
    return `https://acme.atlassian.net/browse/${key}`;
  }

  private isOwnStatus(comment: TicketComment): boolean {
    return comment.author.accountId === LOCKKEEPER.accountId && /\bLockkeeper\b/.test(comment.body);
  }
}
