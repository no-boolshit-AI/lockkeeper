import type { Person, Tracker } from '../tracker/tracker.js';

export type Verdict = { allowed: true } | { allowed: false; reason: string; hint: string };

/** Atlassian account IDs: a 24-digit hex ID, or a number, a colon and a UUID. */
const ACCOUNT_ID = /^(?:[0-9a-f]{24}|\d+:[0-9a-f-]{36})$/i;
const EMAIL_TTL_MS = 10 * 60_000;

/**
 * Decides who may start or steer a run (T2). Only people in the Jira organisation
 * count: never apps or external (customer) accounts. With an allow-list, a person must
 * match an entry by account ID, email address or group name. Without one, any internal
 * user in a configured project may.
 */
export class Authorizer {
  private readonly accountIds = new Set<string>();
  private readonly emails: string[] = [];
  private readonly groups: string[] = [];
  private readonly resolved = new Map<string, { ids: Set<string>; at: number }>();

  constructor(
    private readonly tracker: Pick<Tracker, 'userGroups' | 'findUsers'>,
    entries: readonly string[],
    private readonly now: () => number = Date.now,
  ) {
    for (const raw of entries) {
      const entry = raw.trim();
      if (!entry) continue;
      if (ACCOUNT_ID.test(entry)) this.accountIds.add(entry);
      else if (entry.includes('@')) this.emails.push(entry.toLowerCase());
      else this.groups.push(entry.toLowerCase());
    }
  }

  get open(): boolean {
    return this.accountIds.size === 0 && this.emails.length === 0 && this.groups.length === 0;
  }

  async check(person: Person): Promise<Verdict> {
    if (person.accountType && person.accountType !== 'atlassian') {
      const what = person.accountType === 'app' ? 'an app' : 'an external (customer) account';
      return {
        allowed: false,
        reason: `${person.displayName} is ${what}, and Lockkeeper only takes requests from people in your Jira organisation.`,
        hint: 'Ask a team member to add the label.',
      };
    }
    if (this.open || this.accountIds.has(person.accountId)) return { allowed: true };
    if (person.email && this.emails.includes(person.email.toLowerCase())) return { allowed: true };
    for (const email of this.emails) {
      if ((await this.idsFor(email)).has(person.accountId)) return { allowed: true };
    }
    if (this.groups.length > 0) {
      const groups = await this.tracker.userGroups(person.accountId);
      if (groups.some((group) => this.groups.includes(group.toLowerCase())))
        return { allowed: true };
    }
    return {
      allowed: false,
      reason: `${person.displayName} is not on Lockkeeper's allow-list.`,
      hint: 'Ask someone on the list to add the label, or add them to jira.allow_users in lockkeeper.yml.',
    };
  }

  /** Account IDs for an email address. Jira often hides other users' addresses. */
  private async idsFor(email: string): Promise<Set<string>> {
    const cached = this.resolved.get(email);
    if (cached && this.now() - cached.at < EMAIL_TTL_MS) return cached.ids;
    const users = await this.tracker.findUsers(email);
    const exact = users.filter((user) => user.email?.toLowerCase() === email);
    const matches = exact.length > 0 ? exact : users.length === 1 && !users[0]?.email ? users : [];
    const ids = new Set(matches.map((user) => user.accountId));
    this.resolved.set(email, { ids, at: this.now() });
    return ids;
  }
}
