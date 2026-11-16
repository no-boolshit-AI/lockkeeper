/**
 * Acceptance criteria, pulled from a dedicated field or from a section of the
 * description. Each criterion must be met with evidence in the PR (V4).
 */

const SECTION_TITLE =
  /^(?:acceptance criteria|acceptance criterion|acceptance tests?|definition of done|done when|a\.?c\.?)$/i;

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/;

function headingText(line: string): string | undefined {
  const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
  if (heading?.[1]) return heading[1];
  const boldOnly = /^\*\*(.+?)\*\*:?\s*$/.exec(line.trim());
  if (boldOnly?.[1]) return boldOnly[1];
  return undefined;
}

function cleanTitle(value: string): string {
  return value
    .replace(/[*_`]/g, '')
    .replace(/[:：]\s*$/, '')
    .trim();
}

function isSectionStart(line: string): boolean {
  const heading = headingText(line);
  if (heading !== undefined) return SECTION_TITLE.test(cleanTitle(heading));
  // A plain "Acceptance criteria:" line also opens a section.
  const trimmed = line.trim();
  return /[:：]$/.test(trimmed) && SECTION_TITLE.test(cleanTitle(trimmed));
}

/** Items of the first list in `markdown`, or its non-empty lines when it has no list. */
export function criteriaFromText(markdown: string): string[] {
  const lines = markdown.split('\n');
  const items = lines
    .map((line) => LIST_ITEM.exec(line)?.[1])
    .filter((item): item is string => Boolean(item));
  if (items.length > 0) return items;
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^[-=*_]{3,}$/.test(line) && headingText(line) === undefined);
}

export function extractAcceptanceCriteria(markdown: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex(isSectionStart);
  if (start === -1) return [];
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (headingText(line) !== undefined) break;
    section.push(line);
  }
  return criteriaFromText(section.join('\n'));
}
