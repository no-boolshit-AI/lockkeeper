import type { Doc } from '../core/doc.js';
import type { LabelChange, Person, TicketSnapshot, Tracker } from './tracker.js';

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

  constructor(private readonly inner: Pick<Tracker, 'kind' | 'whoami' | 'snapshot' | 'ticketUrl'>) {
    this.kind = inner.kind;
  }

  whoami(): Promise<Person> {
    return this.inner.whoami();
  }

  snapshot(key: string): Promise<TicketSnapshot> {
    return this.inner.snapshot(key);
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
