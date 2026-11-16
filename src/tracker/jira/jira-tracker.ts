import type { Doc } from '../../core/doc.js';
import type { LabelChange, Person, TicketSnapshot, Tracker } from '../tracker.js';
import { docToAdf } from './adf.js';
import type { JiraClient } from './client.js';
import { buildSnapshot, toPerson } from './snapshot.js';

export interface JiraTrackerOptions {
  site: string;
  acceptanceCriteriaField?: string;
}

/** Jira Cloud behind the Tracker interface. All writes go through the control plane. */
export class JiraTracker implements Tracker {
  readonly kind = 'jira-cloud';
  private self: Person | undefined;

  constructor(
    private readonly client: JiraClient,
    private readonly options: JiraTrackerOptions,
  ) {}

  async whoami(): Promise<Person> {
    if (!this.self) {
      const user = await this.client.myself();
      this.self = toPerson(user) ?? { accountId: user.accountId, displayName: 'Lockkeeper' };
    }
    return this.self;
  }

  async snapshot(key: string): Promise<TicketSnapshot> {
    const [issue, comments, self] = await Promise.all([
      this.client.getIssue(key),
      this.client.getComments(key),
      this.whoami(),
    ]);
    const input: Parameters<typeof buildSnapshot>[0] = {
      issue,
      comments,
      site: this.options.site,
      self,
    };
    if (this.options.acceptanceCriteriaField)
      input.acceptanceCriteriaField = this.options.acceptanceCriteriaField;
    return buildSnapshot(input);
  }

  async postComment(key: string, body: Doc): Promise<string> {
    const comment = await this.client.addComment(key, docToAdf(body));
    return comment.id;
  }

  async updateComment(key: string, commentId: string, body: Doc): Promise<void> {
    await this.client.updateComment(key, commentId, docToAdf(body));
  }

  async updateLabels(key: string, change: LabelChange): Promise<void> {
    const operations = [
      ...(change.remove ?? []).map((label) => ({ remove: label })),
      ...(change.add ?? []).map((label) => ({ add: label })),
    ];
    if (operations.length === 0) return;
    await this.client.updateIssue(key, { update: { labels: operations } });
  }

  async linkPullRequest(key: string, pr: { url: string; title: string }): Promise<void> {
    await this.client.addRemoteLink(key, {
      // The same globalId updates the existing link instead of adding a second one.
      globalId: `lockkeeper:${pr.url}`,
      application: { type: 'com.github', name: 'GitHub' },
      relationship: 'pull request',
      object: {
        url: pr.url,
        title: pr.title,
        icon: { url16x16: 'https://github.com/favicon.ico', title: 'GitHub' },
      },
    });
  }

  async transition(key: string, name: string): Promise<boolean> {
    const wanted = name.trim().toLowerCase();
    const transitions = await this.client.getTransitions(key);
    const match = transitions.find(
      (transition) =>
        transition.name.toLowerCase() === wanted || transition.to?.name?.toLowerCase() === wanted,
    );
    if (!match) return false;
    await this.client.doTransition(key, match.id);
    return true;
  }

  ticketUrl(key: string): string {
    return `https://${this.options.site}/browse/${key}`;
  }
}
