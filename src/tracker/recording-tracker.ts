import type { Doc } from '../core/doc.js';
import type {
  LabelChange,
  LabelEvent,
  Person,
  TicketComment,
  TicketRef,
  TicketSnapshot,
  Tracker,
} from './tracker.js';

/** The reads a recording tracker passes through. Only the first four are required. */
export type TrackerReads = Pick<Tracker, 'kind' | 'whoami' | 'snapshot' | 'ticketUrl'> &
  Partial<Pick<Tracker, 'search' | 'labelAdded' | 'newComments' | 'userGroups' | 'findUsers'>>;

export type TrackerWrite =
  | { action: 'postComment'; key: string; commentId: string; body: Doc }
  | { action: 'updateComment'; key: string; commentId: string; body: Doc }
  | { action: 'updateLabels'; key: string; change: LabelChange }
  | { action: 'linkPullRequest'; key: string; pr: { url: string; title: string } }
  | { action: 'transition'; key: string; name: string };

/**
 * Reads from the real tracker, records writes instead of making them. Used by
 * `run --dry-run` to show what would be posted, and by tests.
 */
export class RecordingTracker implements Tracker {
  readonly kind: string;
  readonly writes: TrackerWrite[] = [];
  private counter = 0;

  constructor(private readonly inner: TrackerReads) {
    this.kind = inner.kind;
  }

  whoami(): Promise<Person> {
    return this.inner.whoami();
  }

  snapshot(key: string): Promise<TicketSnapshot> {
    return this.inner.snapshot(key);
  }

  search(query: string, limit?: number): Promise<TicketRef[]> {
    return this.read('search').call(this.inner, query, limit);
  }

  labelAdded(key: string, label: string): Promise<LabelEvent | undefined> {
    return this.read('labelAdded').call(this.inner, key, label);
  }

  newComments(key: string, after: { afterId?: string; since: string }): Promise<TicketComment[]> {
    return this.read('newComments').call(this.inner, key, after);
  }

  userGroups(accountId: string): Promise<string[]> {
    return this.read('userGroups').call(this.inner, accountId);
  }

  findUsers(query: string): Promise<Person[]> {
    return this.read('findUsers').call(this.inner, query);
  }

  private read<K extends 'search' | 'labelAdded' | 'newComments' | 'userGroups' | 'findUsers'>(
    name: K,
  ): NonNullable<TrackerReads[K]> {
    const method = this.inner[name];
    if (!method) throw new Error(`The tracker behind this recording cannot ${name}.`);
    return method as NonNullable<TrackerReads[K]>;
  }

  async postComment(key: string, body: Doc): Promise<string> {
    this.counter += 1;
    const commentId = `recorded-${this.counter}`;
    this.writes.push({ action: 'postComment', key, commentId, body });
    return commentId;
  }

  async updateComment(key: string, commentId: string, body: Doc): Promise<void> {
    this.writes.push({ action: 'updateComment', key, commentId, body });
  }

  async updateLabels(key: string, change: LabelChange): Promise<void> {
    this.writes.push({ action: 'updateLabels', key, change });
  }

  async linkPullRequest(key: string, pr: { url: string; title: string }): Promise<void> {
    this.writes.push({ action: 'linkPullRequest', key, pr });
  }

  async transition(key: string, name: string): Promise<boolean> {
    this.writes.push({ action: 'transition', key, name });
    return true;
  }

  ticketUrl(key: string): string {
    return this.inner.ticketUrl(key);
  }

  /** Every write except comments, one line each, in order. */
  changes(): string[] {
    return this.writes.flatMap((write) => {
      switch (write.action) {
        case 'updateLabels': {
          const parts = [
            write.change.add?.length ? `add ${write.change.add.join(', ')}` : '',
            write.change.remove?.length ? `remove ${write.change.remove.join(', ')}` : '',
          ].filter(Boolean);
          return parts.length > 0 ? [`Labels on ${write.key}: ${parts.join('; ')}`] : [];
        }
        case 'linkPullRequest':
          return [`Link ${write.key} to ${write.pr.url}`];
        case 'transition':
          return [`Move ${write.key} to "${write.name}"`];
        default:
          return [];
      }
    });
  }

  /** The latest version of each comment, in the order they were first posted. */
  comments(): { commentId: string; body: Doc }[] {
    const latest = new Map<string, Doc>();
    for (const write of this.writes) {
      if (write.action === 'postComment' || write.action === 'updateComment')
        latest.set(write.commentId, write.body);
    }
    return [...latest].map(([commentId, body]) => ({ commentId, body }));
  }
}
