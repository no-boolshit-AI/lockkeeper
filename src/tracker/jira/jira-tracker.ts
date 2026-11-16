import type { Doc } from '../../core/doc.js';
import { emptyHiddenTextStats } from '../../core/hidden-text.js';
import type {
  LabelChange,
  LabelEvent,
  Person,
  TicketComment,
  TicketRef,
  TicketSnapshot,
  Tracker,
  TrackerAbility,
} from '../tracker.js';
import { adfToMarkdown, docToAdf } from './adf.js';
import type { JiraClient } from './client.js';
import { findLabelAdded, isNewerId } from './history.js';
import { buildSnapshot, isOwnStatusComment, toPerson } from './snapshot.js';

const UNKNOWN: Person = { accountId: 'unknown', displayName: 'Unknown' };

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

  async missingAbilities(project: string, abilities: TrackerAbility[]): Promise<TrackerAbility[]> {
    const keys: Record<TrackerAbility, string> = {
      browse: 'BROWSE_PROJECTS',
      comment: 'ADD_COMMENTS',
      edit: 'EDIT_ISSUES',
      link: 'LINK_ISSUES',
      transition: 'TRANSITION_ISSUES',
    };
    const result = await this.client.request<{
      permissions?: Record<string, { havePermission?: boolean }>;
    }>('GET', '/rest/api/3/mypermissions', {
      query: {
        projectKey: project,
        permissions: abilities.map((ability) => keys[ability]).join(','),
      },
    });
    return abilities.filter((ability) => !result.permissions?.[keys[ability]]?.havePermission);
  }

  async search(query: string, limit = 50): Promise<TicketRef[]> {
    const issues = await this.client.search(query, ['labels', 'updated'], limit);
    return issues.map((issue) => ({
      key: issue.key,
      labels: issue.fields.labels ?? [],
      updated: issue.fields.updated ?? '',
    }));
  }

  async labelAdded(key: string, label: string): Promise<LabelEvent | undefined> {
    const history = findLabelAdded(await this.client.getChangelog(key), label);
    if (history) {
      return {
        label,
        by: toPerson(history.author) ?? UNKNOWN,
        at: history.created,
        id: `history:${history.id}`,
      };
    }
    // A label set when the ticket was created has no history entry: its creator added it.
    const issue = await this.client.getIssueFields(key, ['labels', 'creator', 'created']);
    const creator = toPerson(issue.fields.creator);
    if (!creator || !issue.fields.labels?.includes(label)) return undefined;
    return { label, by: creator, at: issue.fields.created ?? '', id: 'created' };
  }

  async newComments(
    key: string,
    after: { afterId?: string; since: string },
  ): Promise<TicketComment[]> {
    const [comments, self] = await Promise.all([this.client.getComments(key), this.whoami()]);
    const since = Date.parse(after.since);
    const stats = emptyHiddenTextStats();
    return comments
      .filter((comment) =>
        after.afterId ? isNewerId(comment.id, after.afterId) : Date.parse(comment.created) >= since,
      )
      .map((comment) => ({
        id: comment.id,
        author: toPerson(comment.author) ?? UNKNOWN,
        created: comment.created,
        body: adfToMarkdown(comment.body, stats),
      }))
      .filter(
        (comment) =>
          comment.body !== '' && !isOwnStatusComment(comment.author.accountId, comment.body, self),
      );
  }

  userGroups(accountId: string): Promise<string[]> {
    return this.client.userGroups(accountId);
  }

  async findUsers(query: string): Promise<Person[]> {
    const users = await this.client.searchUsers(query);
    return users.map(toPerson).filter((person): person is Person => person !== undefined);
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
