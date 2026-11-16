export type WorkflowName = 'feature' | 'bugfix';

const BUG_TYPES = new Set(['bug', 'defect', 'incident', 'problem']);

/**
 * Pick the workflow from the issue type (E5). A `workflow:<name>` label overrides it,
 * for example `workflow:bugfix` on a task that is really a bug.
 */
export function workflowFor(issueType: string, labels: readonly string[] = []): WorkflowName {
  for (const label of labels) {
    const match = /^workflow[:-](feature|bugfix)$/i.exec(label);
    if (match?.[1]) return match[1].toLowerCase() as WorkflowName;
  }
  return BUG_TYPES.has(issueType.trim().toLowerCase()) ? 'bugfix' : 'feature';
}

/** Words that leave a shortened slug unfinished, as in `off-by-a-cent-with`. */
const DANGLING_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

/** Lowercase ASCII words joined by hyphens, cut at a word boundary. */
export function slugify(text: string, maxLength = 40): string {
  const words = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const kept: string[] = [];
  let length = 0;
  for (const word of words) {
    const next = kept.length === 0 ? word.length : length + 1 + word.length;
    if (next > maxLength) {
      if (kept.length === 0) return word.slice(0, maxLength);
      while (kept.length > 1 && DANGLING_WORDS.has(kept.at(-1) ?? '')) kept.pop();
      break;
    }
    kept.push(word);
    length = next;
  }
  return kept.join('-');
}

/** `bugfix/KEY-123-short-title` for bugs and `feature/KEY-123-short-title` otherwise. */
export function branchName(workflow: WorkflowName, ticketKey: string, summary: string): string {
  const slug = slugify(summary);
  return slug ? `${workflow}/${ticketKey}-${slug}` : `${workflow}/${ticketKey}`;
}

/** Commit subjects and PR titles carry the ticket key and stay short. */
export function titleFor(ticketKey: string, summary: string, maxLength = 72): string {
  const clean = summary.replace(/\s+/g, ' ').trim();
  const title = `${ticketKey}: ${clean}`;
  return title.length <= maxLength ? title : `${title.slice(0, maxLength - 1).trimEnd()}…`;
}
