import { describe, expect, it } from 'vitest';
import { branchName, slugify, titleFor, workflowFor } from '../../src/core/branch.js';
import {
  bold,
  bullets,
  code,
  codeBlock,
  docToMarkdown,
  escapeMarkdown,
  link,
  mention,
  paragraph,
  table,
} from '../../src/core/doc.js';
import {
  contrastRatio,
  emptyHiddenTextStats,
  isHiddenColor,
  parseHexColor,
  stripInvisible,
} from '../../src/core/hidden-text.js';

const cp = (...points: number[]) => String.fromCodePoint(...points);

describe('branch names and workflows', () => {
  it('picks bugfix for bugs and feature for everything else', () => {
    expect(workflowFor('Bug')).toBe('bugfix');
    expect(workflowFor('Defect')).toBe('bugfix');
    expect(workflowFor('Story')).toBe('feature');
    expect(workflowFor('Task')).toBe('feature');
  });

  it('lets a workflow label override the issue type', () => {
    expect(workflowFor('Task', ['agent', 'workflow:bugfix'])).toBe('bugfix');
    expect(workflowFor('Bug', ['workflow-feature'])).toBe('feature');
  });

  it('builds branch names from the type, key and a short slug', () => {
    expect(branchName('bugfix', 'PROJ-482', 'Cart total rounding is wrong!')).toBe(
      'bugfix/PROJ-482-cart-total-rounding-is-wrong',
    );
    expect(branchName('feature', 'SHOP-1', 'Crème brûlée & café support')).toBe(
      'feature/SHOP-1-creme-brulee-cafe-support',
    );
    expect(branchName('feature', 'SHOP-2', '!!!')).toBe('feature/SHOP-2');
  });

  it('cuts slugs at a word boundary', () => {
    expect(slugify('one two three four five six seven eight nine ten eleven', 20)).toBe(
      'one-two-three-four',
    );
    expect(slugify('Supercalifragilisticexpialidocious', 10)).toBe('supercalif');
    // From the first live run: a cut slug no longer ends on a connecting word.
    expect(slugify('Cart total is off by a cent with discounts')).toBe(
      'cart-total-is-off-by-a-cent',
    );
    expect(slugify('Sign in with')).toBe('sign-in-with');
  });

  it('keeps titles short and keyed', () => {
    expect(titleFor('A-1', 'Fix it')).toBe('A-1: Fix it');
    expect(titleFor('A-1', 'x'.repeat(100)).length).toBe(72);
  });
});

describe('the document model', () => {
  it('escapes markdown so agent text cannot add links, images, html or pings', () => {
    const escaped = escapeMarkdown(
      '![img](https://evil.example/?d=secret) <b>hi</b> @acme/team *bold*',
    );
    expect(escaped).not.toContain('![');
    expect(escaped).toContain('\\!\\[img\\]');
    expect(escaped).toContain('\\<b\\>');
    expect(escaped).toContain(`@${cp(0x2060)}acme`);
    expect(escaped).toContain('\\*bold\\*');
  });

  it('renders only http links, from templates', () => {
    const md = docToMarkdown([
      paragraph(
        link('PR', 'https://github.com/a/b/pull/1'),
        ' ',
        link('bad', 'javascript:alert(1)'),
      ),
    ]);
    expect(md).toContain('[PR](<https://github.com/a/b/pull/1>)');
    expect(md).not.toContain('javascript:');
  });

  it('chooses a fence longer than any backtick run in code', () => {
    const md = docToMarkdown([codeBlock('a ``` b ```` c')]);
    expect(md.startsWith('`````\n')).toBe(true);
    expect(docToMarkdown([paragraph(code('x`y'))])).toContain('``x`y``');
  });

  it('renders tables, lists, bold and neutralised mentions', () => {
    const md = docToMarkdown([
      paragraph(bold('Status'), ': ok'),
      bullets('one', 'two'),
      table(['Criterion', 'Evidence'], [['a|b', 'test']]),
      paragraph(mention('acc-1', 'Maria')),
    ]);
    expect(md).toContain('**Status**: ok');
    expect(md).toContain('- one\n- two');
    expect(md).toContain('| a\\|b | test |');
    expect(md).toContain(`@${cp(0x2060)}Maria`);
  });
});

describe('hidden text', () => {
  it('strips zero-width, bidi, tag and variation-selector characters and counts them', () => {
    const stats = emptyHiddenTextStats();
    const smuggled = `Fix${cp(0x200b)} the${cp(0x202e)} bug${cp(0xe0049, 0xe0067)}${cp(0xe0100)}`;
    expect(stripInvisible(smuggled, stats)).toBe('Fix the bug');
    expect(stats.invisibleChars).toBe(5);
  });

  it('keeps emoji presentation selectors and ordinary text', () => {
    const heart = `${cp(0x2764, 0xfe0f)} ok`;
    expect(stripInvisible(heart)).toBe(heart);
  });

  it('detects unreadable colours', () => {
    expect(parseHexColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor('nope')).toBeUndefined();
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 0);
    expect(isHiddenColor('#ffffff')).toBe(true);
    expect(isHiddenColor('#fefefe', '#ffffff')).toBe(true);
    expect(isHiddenColor('#ff5630', '#ff5630')).toBe(true);
    expect(isHiddenColor('#172b4d')).toBe(false);
    expect(isHiddenColor('#ff5630')).toBe(false);
  });
});

describe('Markdown emphasis', () => {
  it('keeps spaces outside bold and italic markers, as CommonMark requires', () => {
    // From the live test: "**Failing test first: **" showed its asterisks on GitHub.
    expect(docToMarkdown([paragraph(bold('Failing test first: '), 'without the fix')])).toBe(
      '**Failing test first:** without the fix\n',
    );
    expect(docToMarkdown([paragraph('a', { kind: 'text', text: ' b ', italic: true }, 'c')])).toBe(
      'a _b_ c\n',
    );
  });
});
