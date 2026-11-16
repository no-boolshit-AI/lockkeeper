import type { JiraHistory } from './client.js';

// `toString` is also inherited from Object.prototype, so accept only real strings.
const labelsOf = (value: unknown): string[] =>
  typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];

/** The newest history entry that added `label` to the issue (T2). */
export function findLabelAdded(
  histories: readonly JiraHistory[],
  label: string,
): JiraHistory | undefined {
  for (let index = histories.length - 1; index >= 0; index--) {
    const history = histories[index];
    if (!history) continue;
    for (const item of history.items) {
      if ((item.fieldId ?? item.field) !== 'labels') continue;
      if (labelsOf(item.toString).includes(label) && !labelsOf(item.fromString).includes(label)) {
        return history;
      }
    }
  }
  return undefined;
}

/** Whether Jira comment ID `a` is newer than `b`. IDs grow over time within a site. */
export function isNewerId(a: string, b: string): boolean {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) > BigInt(b);
  return a > b;
}
