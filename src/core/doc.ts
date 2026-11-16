/**
 * A small, neutral rich-text model for everything Lockkeeper posts.
 *
 * Templates build a Doc; each tracker or source-control client renders it in its own
 * format (ADF for Jira Cloud, Markdown for GitHub). Text is always literal: the
 * renderers escape it, so agent-written text can never smuggle in links, images,
 * HTML or @-mentions. Only templates create links and mentions.
 */

export type Inline =
  | { kind: 'text'; text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string }
  | { kind: 'mention'; id: string; name: string }
  | { kind: 'break' };

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; content: Inline[] }
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'tasks'; items: { done: boolean; content: Inline[] }[] }
  | { kind: 'code'; language?: string; text: string }
  | { kind: 'table'; header: string[]; rows: Inline[][][] }
  | { kind: 'rule' };

export type Doc = Block[];

type InlineInput = Inline | string;

const toInline = (value: InlineInput): Inline =>
  typeof value === 'string' ? { kind: 'text', text: value } : value;

export const text = (value: string): Inline => ({ kind: 'text', text: value });
export const bold = (value: string): Inline => ({ kind: 'text', text: value, bold: true });
export const italic = (value: string): Inline => ({ kind: 'text', text: value, italic: true });
export const code = (value: string): Inline => ({ kind: 'text', text: value, code: true });
export const link = (value: string, href: string): Inline => ({ kind: 'text', text: value, href });
export const mention = (id: string, name: string): Inline => ({ kind: 'mention', id, name });
export const br = (): Inline => ({ kind: 'break' });

export const heading = (level: 1 | 2 | 3, ...content: InlineInput[]): Block => ({
  kind: 'heading',
  level,
  content: content.map(toInline),
});
export const paragraph = (...content: InlineInput[]): Block => ({
  kind: 'paragraph',
  content: content.map(toInline),
});
export const bullets = (...items: (InlineInput | InlineInput[])[]): Block => ({
  kind: 'list',
  ordered: false,
  items: items.map((item) => (Array.isArray(item) ? item.map(toInline) : [toInline(item)])),
});
export const numbered = (...items: (InlineInput | InlineInput[])[]): Block => ({
  kind: 'list',
  ordered: true,
  items: items.map((item) => (Array.isArray(item) ? item.map(toInline) : [toInline(item)])),
});
export const tasks = (...items: { done: boolean; content: InlineInput[] }[]): Block => ({
  kind: 'tasks',
  items: items.map((item) => ({ done: item.done, content: item.content.map(toInline) })),
});
export const codeBlock = (value: string, language?: string): Block =>
  language === undefined ? { kind: 'code', text: value } : { kind: 'code', text: value, language };
export const table = (header: string[], rows: InlineInput[][]): Block => ({
  kind: 'table',
  header,
  rows: rows.map((row) => row.map((cell) => [toInline(cell)])),
});
export const rule = (): Block => ({ kind: 'rule' });

// ---------------------------------------------------------------------------
// Markdown rendering (GitHub-flavoured)

const MARKDOWN_SPECIAL = /[\\`*_{}[\]()#+\-.!|<>~]/g;
/** U+2060, created from its code point so no invisible character sits in the source. */
const WORD_JOINER = String.fromCodePoint(0x2060);

/**
 * Escape text so GitHub renders it literally: no emphasis, links, images, HTML,
 * tables or @-mentions. A word joiner after `@` stops mention and team pings.
 */
export function escapeMarkdown(value: string): string {
  return value
    .replace(MARKDOWN_SPECIAL, (char) => `\\${char}`)
    .replace(/@/g, `@${WORD_JOINER}`)
    .replace(/\r?\n/g, ' ');
}

function inlineToMarkdown(inline: Inline): string {
  switch (inline.kind) {
    case 'break':
      return '  \n';
    case 'mention':
      return escapeMarkdown(`@${inline.name}`);
    case 'text': {
      if (inline.text === '') return '';
      let out: string;
      if (inline.code) {
        const longest = Math.max(0, ...(inline.text.match(/`+/g) ?? []).map((run) => run.length));
        const fence = '`'.repeat(longest + 1);
        const pad = inline.text.startsWith('`') || inline.text.endsWith('`') ? ' ' : '';
        out = `${fence}${pad}${inline.text.replace(/\r?\n/g, ' ')}${pad}${fence}`;
      } else {
        out = escapeMarkdown(inline.text);
        if (inline.bold) out = `**${out}**`;
        if (inline.italic) out = `_${out}_`;
      }
      if (inline.href && isSafeHref(inline.href)) out = `[${out}](<${inline.href}>)`;
      return out;
    }
  }
}

function inlinesToMarkdown(content: Inline[]): string {
  return content.map(inlineToMarkdown).join('');
}

/** Only http(s) links are rendered, and never with characters that could break out. */
export function isSafeHref(href: string): boolean {
  return /^https?:\/\/[^\s<>"]+$/i.test(href);
}

export function docToMarkdown(doc: Doc): string {
  const blocks: string[] = [];
  for (const block of doc) {
    switch (block.kind) {
      case 'heading':
        blocks.push(`${'#'.repeat(block.level + 1)} ${inlinesToMarkdown(block.content)}`);
        break;
      case 'paragraph':
        blocks.push(inlinesToMarkdown(block.content));
        break;
      case 'list':
        blocks.push(
          block.items
            .map(
              (item, index) =>
                `${block.ordered ? `${index + 1}.` : '-'} ${inlinesToMarkdown(item)}`,
            )
            .join('\n'),
        );
        break;
      case 'tasks':
        blocks.push(
          block.items
            .map((item) => `- [${item.done ? 'x' : ' '}] ${inlinesToMarkdown(item.content)}`)
            .join('\n'),
        );
        break;
      case 'code': {
        const longest = Math.max(2, ...(block.text.match(/`+/g) ?? []).map((run) => run.length));
        const fence = '`'.repeat(longest + 1);
        const language = (block.language ?? '').replace(/[^\w+-]/g, '');
        blocks.push(`${fence}${language}\n${block.text}\n${fence}`);
        break;
      }
      case 'table': {
        const header = `| ${block.header.map(escapeMarkdown).join(' | ')} |`;
        const divider = `| ${block.header.map(() => '---').join(' | ')} |`;
        const rows = block.rows.map((row) => `| ${row.map(inlinesToMarkdown).join(' | ')} |`);
        blocks.push([header, divider, ...rows].join('\n'));
        break;
      }
      case 'rule':
        blocks.push('---');
        break;
    }
  }
  return `${blocks.join('\n\n')}\n`;
}

/** Plain text, for logs and the CLI preview. */
export function docToPlainText(doc: Doc): string {
  const inlinePlain = (content: Inline[]): string =>
    content
      .map((inline) =>
        inline.kind === 'text' ? inline.text : inline.kind === 'mention' ? `@${inline.name}` : '\n',
      )
      .join('');
  const lines: string[] = [];
  for (const block of doc) {
    switch (block.kind) {
      case 'heading':
      case 'paragraph':
        lines.push(inlinePlain(block.content), '');
        break;
      case 'list':
        block.items.forEach((item, index) => {
          lines.push(`${block.ordered ? `${index + 1}.` : '-'} ${inlinePlain(item)}`);
        });
        lines.push('');
        break;
      case 'tasks':
        for (const item of block.items) {
          lines.push(`[${item.done ? 'x' : ' '}] ${inlinePlain(item.content)}`);
        }
        lines.push('');
        break;
      case 'code':
        lines.push(block.text, '');
        break;
      case 'table':
        lines.push(block.header.join(' | '));
        for (const row of block.rows) lines.push(row.map(inlinePlain).join(' | '));
        lines.push('');
        break;
      case 'rule':
        lines.push('---', '');
        break;
    }
  }
  return `${lines.join('\n').trim()}\n`;
}
