import { emptyHiddenTextStats, stripInvisible } from '../../core/hidden-text.js';
import { criteriaFromText, extractAcceptanceCriteria } from '../acceptance.js';
import type { Person, TicketLink, TicketSnapshot } from '../tracker.js';
import { adfToMarkdown } from './adf.js';
import type { JiraComment, JiraIssue, JiraUser } from './client.js';

export interface SnapshotInput {
  issue: JiraIssue;
  comments: JiraComment[];
  site: string;
  /** Lockkeeper's own account. Its comments are status updates, not ticket content. */
  self?: Person;
  /** Custom field holding acceptance criteria, by ID or display name. */
  acceptanceCriteriaField?: string;
  now?: Date;
}

export function toPerson(user: JiraUser | null | undefined): Person | undefined {
  if (!user?.accountId) return undefined;
  const person: Person = {
    accountId: user.accountId,
    displayName: stripInvisible(user.displayName ?? user.accountId),
  };
  if (user.emailAddress) person.email = user.emailAddress;
  if (user.accountType) person.accountType = user.accountType;
  return person;
}

function findCriteriaField(issue: JiraIssue, configured?: string): string | undefined {
  const names = issue.names ?? {};
  if (configured) {
    if (configured in issue.fields) return configured;
    const byName = Object.entries(names).find(
      ([, name]) => name.toLowerCase() === configured.toLowerCase(),
    );
    return byName?.[0];
  }
  return Object.entries(names).find(([, name]) => /^acceptance criteria$/i.test(name.trim()))?.[0];
}

/** Capture a Jira issue as Markdown with hidden text stripped (T4). */
export function buildSnapshot(input: SnapshotInput): TicketSnapshot {
  const { issue, site } = input;
  const fields = issue.fields;
  const stats = emptyHiddenTextStats();

  const description = adfToMarkdown(fields.description, stats);

  let acceptanceCriteria: string[] = [];
  let acceptanceCriteriaSource: TicketSnapshot['acceptanceCriteriaSource'] = 'none';
  const criteriaField = findCriteriaField(issue, input.acceptanceCriteriaField);
  if (criteriaField) {
    const value = adfToMarkdown(fields[criteriaField], stats);
    if (value) {
      acceptanceCriteria = criteriaFromText(value);
      acceptanceCriteriaSource = 'field';
    }
  }
  if (acceptanceCriteria.length === 0) {
    acceptanceCriteria = extractAcceptanceCriteria(description);
    if (acceptanceCriteria.length > 0) acceptanceCriteriaSource = 'description';
  }

  const reporter = toPerson(fields.reporter);
  const comments = input.comments
    .filter((comment) => !input.self || comment.author?.accountId !== input.self.accountId)
    .map((comment) => ({
      id: comment.id,
      author: toPerson(comment.author) ?? { accountId: 'unknown', displayName: 'Unknown' },
      created: comment.created,
      body: adfToMarkdown(comment.body, stats),
    }))
    .filter((comment) => comment.body !== '');

  const externalAuthors = new Map<string, Person>();
  for (const person of [reporter, ...comments.map((comment) => comment.author)]) {
    if (person?.accountType === 'customer') externalAuthors.set(person.accountId, person);
  }

  const links: TicketLink[] = [];
  for (const link of fields.issuelinks ?? []) {
    const outward = link.outwardIssue;
    const inward = link.inwardIssue;
    const target = outward ?? inward;
    if (!target?.key) continue;
    const entry: TicketLink = {
      relation: (outward ? link.type?.outward : link.type?.inward) ?? 'relates to',
      key: target.key,
      summary: stripInvisible(target.fields?.summary ?? '', stats),
    };
    if (target.fields?.status?.name) entry.status = target.fields.status.name;
    links.push(entry);
  }

  const snapshot: TicketSnapshot = {
    key: issue.key,
    project: fields.project?.key ?? issue.key.split('-')[0] ?? '',
    url: `https://${site}/browse/${issue.key}`,
    summary: stripInvisible(fields.summary ?? '', stats).trim(),
    issueType: fields.issuetype?.name ?? 'Task',
    status: fields.status?.name ?? 'Unknown',
    labels: fields.labels ?? [],
    components: (fields.components ?? []).map((component) => component.name ?? '').filter(Boolean),
    description,
    acceptanceCriteria,
    acceptanceCriteriaSource,
    comments,
    links,
    attachments: (fields.attachment ?? []).map((attachment) => ({
      filename: stripInvisible(attachment.filename ?? 'attachment', stats),
      mimeType: attachment.mimeType ?? 'application/octet-stream',
      size: attachment.size ?? 0,
    })),
    externalAuthors: [...externalAuthors.values()],
    hiddenText: stats,
    capturedAt: (input.now ?? new Date()).toISOString(),
  };
  if (fields.priority?.name) snapshot.priority = fields.priority.name;
  if (reporter) snapshot.reporter = reporter;
  const assignee = toPerson(fields.assignee);
  if (assignee) snapshot.assignee = assignee;
  return snapshot;
}
