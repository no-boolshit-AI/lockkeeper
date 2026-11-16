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

export interface Tracker {
  readonly kind: string;
  /** The account Lockkeeper acts as. Its own comments are left out of snapshots. */
  whoami(): Promise<Person>;
  snapshot(key: string): Promise<TicketSnapshot>;
  postComment(key: string, body: Doc): Promise<string>;
  updateComment(key: string, commentId: string, body: Doc): Promise<void>;
  updateLabels(key: string, change: LabelChange): Promise<void>;
  /** Show the PR on the ticket as a remote link (J2). Idempotent per URL. */
  linkPullRequest(key: string, pr: { url: string; title: string }): Promise<void>;
  /** Apply a workflow transition by name. Returns false when none matches. */
  transition(key: string, name: string): Promise<boolean>;
  ticketUrl(key: string): string;
}
