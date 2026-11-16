import type { Doc } from '../core/doc.js';
import type { HiddenTextStats } from '../core/hidden-text.js';

/**
 * The tracker interface (P2: keep trigger and reporting behind it). Jira Cloud is the
 * only implementation in v1; Jira Data Center or a Forge remote agent would be others.
 */

export interface Person {
  accountId: string;
  displayName: string;
  email?: string;
  /** Jira: `atlassian` for internal users, `app` for bots, `customer` for external portal users. */
  accountType?: string;
}

export interface TicketComment {
  id: string;
  author: Person;
  created: string;
  /** Markdown with hidden text stripped. */
  body: string;
}

export interface TicketLink {
  relation: string;
  key: string;
  summary: string;
  status?: string;
}

export interface TicketAttachment {
  filename: string;
  mimeType: string;
  size: number;
}

/** The ticket as captured at trigger time (T4). Later edits never change a run in flight. */
export interface TicketSnapshot {
  key: string;
  project: string;
  url: string;
  summary: string;
  issueType: string;
  status: string;
  labels: string[];
  components: string[];
  priority?: string;
  reporter?: Person;
  assignee?: Person;
  /** Markdown with hidden text stripped. */
  description: string;
  acceptanceCriteria: string[];
  acceptanceCriteriaSource: 'field' | 'description' | 'none';
  comments: TicketComment[];
  links: TicketLink[];
  attachments: TicketAttachment[];
  /** Reporter or commenters with external (customer) accounts (T3). */
  externalAuthors: Person[];
  /** What the snapshot stripped, so the run can say so. */
  hiddenText: HiddenTextStats;
  capturedAt: string;
}

export interface LabelChange {
  add?: string[];
  remove?: string[];
}

/** A ticket found by a search, with just enough to decide what to do with it. */
export interface TicketRef {
  key: string;
  labels: string[];
  updated: string;
}

/** Who added a label, and when, from the ticket's history (T2). */
export interface LabelEvent {
  label: string;
  by: Person;
  at: string;
  /** Identifies this change, so the same label change is never acted on twice. */
  id: string;
}

export interface Tracker {
  readonly kind: string;
  /** The account Lockkeeper acts as. Its own comments are left out of snapshots. */
  whoami(): Promise<Person>;
  snapshot(key: string): Promise<TicketSnapshot>;
  /** Tickets matching a query (JQL for Jira), oldest change first (T1). */
  search(query: string, limit?: number): Promise<TicketRef[]>;
  /** The most recent time a label was added to the ticket, or undefined if it never was. */
  labelAdded(key: string, label: string): Promise<LabelEvent | undefined>;
  /**
   * Comments newer than comment `afterId`, or when that is unset, created at or after
   * `since`. Oldest first, hidden text stripped, Lockkeeper's own left out.
   */
  newComments(key: string, after: { afterId?: string; since: string }): Promise<TicketComment[]>;
  /** Names of the groups a user belongs to, for allow-list entries that name a group. */
  userGroups(accountId: string): Promise<string[]>;
  /** Users matching an email address or name. */
  findUsers(query: string): Promise<Person[]>;
  postComment(key: string, body: Doc): Promise<string>;
  updateComment(key: string, commentId: string, body: Doc): Promise<void>;
  updateLabels(key: string, change: LabelChange): Promise<void>;
  /** Show the PR on the ticket as a remote link (J2). Idempotent per URL. */
  linkPullRequest(key: string, pr: { url: string; title: string }): Promise<void>;
  /** Apply a workflow transition by name. Returns false when none matches. */
  transition(key: string, name: string): Promise<boolean>;
  ticketUrl(key: string): string;
}
