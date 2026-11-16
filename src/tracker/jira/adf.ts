import type { Doc, Inline } from '../../core/doc.js';
import { isSafeHref } from '../../core/doc.js';
import { type HiddenTextStats, isHiddenColor, stripInvisible } from '../../core/hidden-text.js';

/**
 * Atlassian Document Format (ADF) in both directions:
 * - adfToMarkdown turns ticket content into Markdown for the agent, dropping hidden text.
 * - docToAdf renders Lockkeeper's neutral Doc model for Jira Cloud comments.
 */

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
}

export interface AdfDoc extends AdfNode {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

// ---------------------------------------------------------------------------
// ADF -> Markdown

/** Jira's default body text colour, used when only a background colour is set. */
const DEFAULT_TEXT_COLOR = '#172b4d';

function attr(node: AdfNode, name: string): unknown {
  return node.attrs?.[name];
}

function isHiddenTextNode(node: AdfNode): boolean {
  const color = node.marks?.find((mark) => mark.type === 'textColor')?.attrs?.color;
  const background = node.marks?.find((mark) => mark.type === 'backgroundColor')?.attrs?.color;
  if (color === undefined && background === undefined) return false;
  return isHiddenColor(color ?? DEFAULT_TEXT_COLOR, background);
}

function renderText(node: AdfNode, stats: HiddenTextStats): string {
  if (isHiddenTextNode(node)) {
    stats.hiddenSegments += 1;
    return '';
  }
  let value = stripInvisible(node.text ?? '', stats);
  if (value === '') return '';
  const marks = node.marks ?? [];
  const has = (type: string) => marks.some((mark) => mark.type === type);
  if (has('code')) {
    value = `\`${value}\``;
  } else {
    if (has('strong')) value = `**${value}**`;
    if (has('em')) value = `_${value}_`;
    if (has('strike')) value = `~~${value}~~`;
  }
  const href = marks.find((mark) => mark.type === 'link')?.attrs?.href;
  if (typeof href === 'string' && (isSafeHref(href) || href.startsWith('mailto:'))) {
    value = `[${value}](${href})`;
  }
  return value;
}

function renderInlines(nodes: AdfNode[] | undefined, stats: HiddenTextStats): string {
  if (!nodes) return '';
  return nodes.map((node) => renderInline(node, stats)).join('');
}

function renderInline(node: AdfNode, stats: HiddenTextStats): string {
  switch (node.type) {
    case 'text':
      return renderText(node, stats);
    case 'hardBreak':
      return '\n';
    case 'mention': {
      const label = attr(node, 'text');
      return stripInvisible(
        typeof label === 'string' && label ? label : `@${String(attr(node, 'id') ?? 'user')}`,
        stats,
      );
    }
    case 'emoji': {
      const value = attr(node, 'text') ?? attr(node, 'shortName');
      return typeof value === 'string' ? value : '';
    }
    case 'inlineCard': {
      const url = attr(node, 'url');
      return typeof url === 'string' ? `<${url}>` : '';
    }
    case 'date': {
      const timestamp = Number(attr(node, 'timestamp'));
      return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : '';
    }
    case 'status': {
      const value = attr(node, 'text');
      return typeof value === 'string' ? `[${stripInvisible(value, stats)}]` : '';
    }
    case 'mediaInline':
      return '[attachment]';
    case 'placeholder':
    case 'inlineExtension':
      return '';
    default:
      return node.text !== undefined ? renderText(node, stats) : renderInlines(node.content, stats);
  }
}

function indent(value: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return value
    .split('\n')
    .map((line, index) => (index === 0 || line === '' ? line : pad + line))
    .join('\n');
}

function renderListItem(node: AdfNode, marker: string, stats: HiddenTextStats): string {
  const blocks = renderBlocks(node.content, stats);
  const body = blocks.join('\n');
  return `${marker} ${indent(body, marker.length + 1)}`;
}

function renderBlocks(nodes: AdfNode[] | undefined, stats: HiddenTextStats): string[] {
  if (!nodes) return [];
  const out: string[] = [];
  for (const node of nodes) {
    const rendered = renderBlock(node, stats);
    if (rendered !== undefined && rendered.trim() !== '') out.push(rendered);
  }
  return out;
}

function quote(value: string): string {
  return value
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

function tableCell(node: AdfNode, stats: HiddenTextStats): string {
  return renderBlocks(node.content, stats).join(' ').replace(/\n/g, ' ').replace(/\|/g, '\\|');
}

function renderBlock(node: AdfNode, stats: HiddenTextStats): string | undefined {
  switch (node.type) {
    case 'doc':
      return renderBlocks(node.content, stats).join('\n\n');
    case 'paragraph':
      return renderInlines(node.content, stats);
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(attr(node, 'level')) || 1));
      return `${'#'.repeat(level)} ${renderInlines(node.content, stats)}`;
    }
    case 'bulletList':
      return (node.content ?? []).map((item) => renderListItem(item, '-', stats)).join('\n');
    case 'orderedList': {
      const start = Number(attr(node, 'order')) || 1;
      return (node.content ?? [])
        .map((item, index) => renderListItem(item, `${start + index}.`, stats))
        .join('\n');
    }
    case 'taskList':
      return (node.content ?? [])
        .map((item) => {
          if (item.type === 'taskList') return indent(renderBlock(item, stats) ?? '', 2);
          const done = attr(item, 'state') === 'DONE';
          return `- [${done ? 'x' : ' '}] ${renderInlines(item.content, stats)}`;
        })
        .join('\n');
    case 'decisionList':
      return (node.content ?? [])
        .map((item) => `- ${renderInlines(item.content, stats)}`)
        .join('\n');
    case 'codeBlock': {
      const body = stripInvisible(
        (node.content ?? []).map((child) => child.text ?? '').join(''),
        stats,
      );
      const language =
        typeof attr(node, 'language') === 'string' ? String(attr(node, 'language')) : '';
      const fence = body.includes('```') ? '~~~~' : '```';
      return `${fence}${language}\n${body}\n${fence}`;
    }
    case 'blockquote':
      return quote(renderBlocks(node.content, stats).join('\n\n'));
    case 'panel': {
      const type =
        typeof attr(node, 'panelType') === 'string' ? String(attr(node, 'panelType')) : 'info';
      return quote(`**${type}:** ${renderBlocks(node.content, stats).join('\n\n')}`);
    }
    case 'expand':
    case 'nestedExpand': {
      const title =
        typeof attr(node, 'title') === 'string'
          ? stripInvisible(String(attr(node, 'title')), stats)
          : '';
      const body = renderBlocks(node.content, stats).join('\n\n');
      return `**${title || 'Details'}** (collapsed section)\n\n${body}`;
    }
    case 'rule':
      return '---';
    case 'table': {
      const rows = (node.content ?? []).filter((row) => row.type === 'tableRow');
      if (rows.length === 0) return undefined;
      const cells = rows.map((row) => (row.content ?? []).map((cell) => tableCell(cell, stats)));
      const width = Math.max(...cells.map((row) => row.length));
      const pad = (row: string[]) => [...row, ...Array(width - row.length).fill('')];
      const [head, ...body] = cells.map(pad);
      return [
        `| ${(head ?? []).join(' | ')} |`,
        `| ${Array(width).fill('---').join(' | ')} |`,
        ...body.map((row) => `| ${row.join(' | ')} |`),
      ].join('\n');
    }
    case 'mediaSingle':
    case 'mediaGroup':
      return (node.content ?? [])
        .map((child) => renderBlock(child, stats))
        .filter(Boolean)
        .join('\n');
    case 'media': {
      const alt = attr(node, 'alt');
      return `[attachment${typeof alt === 'string' && alt ? `: ${stripInvisible(alt, stats)}` : ''}]`;
    }
    case 'blockCard':
    case 'embedCard': {
      const url = attr(node, 'url');
      return typeof url === 'string' ? `<${url}>` : undefined;
    }
    case 'extension':
    case 'bodiedExtension': {
      const key = attr(node, 'extensionKey');
      const label = `[Jira macro${typeof key === 'string' ? `: ${key}` : ''}]`;
      const body = renderBlocks(node.content, stats).join('\n\n');
      return body ? `${label}\n\n${body}` : label;
    }
    default:
      if (node.content) {
        const inline = node.content.every(
          (child) => child.type === 'text' || child.type === 'hardBreak',
        );
        return inline
          ? renderInlines(node.content, stats)
          : renderBlocks(node.content, stats).join('\n\n');
      }
      return node.text !== undefined ? renderText(node, stats) : undefined;
  }
}

/** Ticket text as Markdown with invisible characters and unreadable coloured text removed. */
export function adfToMarkdown(value: unknown, stats: HiddenTextStats): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return stripInvisible(value, stats).trim();
  if (typeof value !== 'object') return '';
  return (renderBlock(value as AdfNode, stats) ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Doc -> ADF

let localIdCounter = 0;
function localId(): string {
  localIdCounter = (localIdCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `lk-${Date.now().toString(36)}-${localIdCounter.toString(36)}`;
}

function inlineToAdf(inline: Inline): AdfNode | undefined {
  switch (inline.kind) {
    case 'break':
      return { type: 'hardBreak' };
    case 'mention':
      return { type: 'mention', attrs: { id: inline.id, text: `@${inline.name}` } };
    case 'text': {
      if (inline.text === '') return undefined;
      const marks: AdfMark[] = [];
      // ADF allows `code` only together with `link`.
      if (inline.code) {
        marks.push({ type: 'code' });
      } else {
        if (inline.bold) marks.push({ type: 'strong' });
        if (inline.italic) marks.push({ type: 'em' });
      }
      if (inline.href && isSafeHref(inline.href))
        marks.push({ type: 'link', attrs: { href: inline.href } });
      const node: AdfNode = { type: 'text', text: inline.text.replace(/\r?\n/g, ' ') };
      if (marks.length > 0) node.marks = marks;
      return node;
    }
  }
}

function inlinesToAdf(content: Inline[]): AdfNode[] {
  return content.map(inlineToAdf).filter((node): node is AdfNode => node !== undefined);
}

function paragraphNode(content: Inline[]): AdfNode {
  const inner = inlinesToAdf(content);
  return inner.length > 0 ? { type: 'paragraph', content: inner } : { type: 'paragraph' };
}

export function docToAdf(doc: Doc): AdfDoc {
  const content: AdfNode[] = [];
  for (const block of doc) {
    switch (block.kind) {
      case 'heading':
        content.push({
          type: 'heading',
          attrs: { level: block.level + 1 },
          content: inlinesToAdf(block.content),
        });
        break;
      case 'paragraph':
        content.push(paragraphNode(block.content));
        break;
      case 'list':
        content.push({
          type: block.ordered ? 'orderedList' : 'bulletList',
          content: block.items.map((item) => ({
            type: 'listItem',
            content: [paragraphNode(item)],
          })),
        });
        break;
      case 'tasks':
        content.push({
          type: 'taskList',
          attrs: { localId: localId() },
          content: block.items.map((item) => ({
            type: 'taskItem',
            attrs: { localId: localId(), state: item.done ? 'DONE' : 'TODO' },
            content: inlinesToAdf(item.content),
          })),
        });
        break;
      case 'code': {
        const node: AdfNode = {
          type: 'codeBlock',
          attrs: block.language ? { language: block.language } : {},
        };
        if (block.text) node.content = [{ type: 'text', text: block.text }];
        content.push(node);
        break;
      }
      case 'table':
        content.push({
          type: 'table',
          attrs: { isNumberColumnEnabled: false, layout: 'default' },
          content: [
            {
              type: 'tableRow',
              content: block.header.map((cell) => ({
                type: 'tableHeader',
                content: [paragraphNode([{ kind: 'text', text: cell }])],
              })),
            },
            ...block.rows.map((row) => ({
              type: 'tableRow',
              content: row.map((cell) => ({ type: 'tableCell', content: [paragraphNode(cell)] })),
            })),
          ],
        });
        break;
      case 'rule':
        content.push({ type: 'rule' });
        break;
    }
  }
  return { type: 'doc', version: 1, content };
}
