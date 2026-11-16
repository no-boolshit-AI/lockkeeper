/**
 * Hidden-text stripping for ticket snapshots (T4).
 *
 * The Jira prompt-injection proofs of concept hid instructions where a human reviewer
 * would not see them but a model would. We remove invisible Unicode (zero-width and
 * bidi controls, tag characters, variation-selector smuggling) and, in the ADF
 * converter, text whose colour makes it unreadable.
 */

/**
 * Code point ranges that render as nothing. Written as numbers on purpose: literal
 * invisible characters in source code would be as hard to review as the attacks.
 */
export const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul fillers
  [0x17b4, 0x17b5], // Khmer inherent vowels
  [0x180b, 0x180f], // Mongolian variation selectors and vowel separator
  [0x200b, 0x200f], // zero-width space, joiners, direction marks
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2060, 0x206f], // word joiner, invisible operators, bidi isolates
  [0x3164, 0x3164], // Hangul filler
  [0xfe00, 0xfe0e], // variation selectors 1-15 (VS16, U+FE0F, is kept for emoji)
  [0xfeff, 0xfeff], // zero-width no-break space
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xe0000, 0xe007f], // tag characters ("ASCII smuggling")
  [0xe0100, 0xe01ef], // variation selector supplement ("emoji smuggling")
];

export function isInvisible(codePoint: number): boolean {
  return INVISIBLE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}

export interface HiddenTextStats {
  invisibleChars: number;
  hiddenSegments: number;
}

export const emptyHiddenTextStats = (): HiddenTextStats => ({
  invisibleChars: 0,
  hiddenSegments: 0,
});

export function stripInvisible(value: string, stats?: HiddenTextStats): string {
  let result = '';
  let removed = 0;
  for (const char of value) {
    if (isInvisible(char.codePointAt(0) as number)) removed += 1;
    else result += char;
  }
  if (stats) stats.invisibleChars += removed;
  return removed === 0 ? value : result;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHexColor(value: unknown): Rgb | undefined {
  if (typeof value !== 'string') return undefined;
  const hex = value.trim().replace(/^#/, '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((char) => char + char)
          .join('')
      : hex.length === 6
        ? hex
        : undefined;
  if (!full || !/^[0-9a-f]{6}$/i.test(full)) return undefined;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

function luminance({ r, g, b }: Rgb): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, from 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/**
 * True when text in `textColor` on `backgroundColor` (default: Jira's white page) is
 * effectively invisible. 1.5:1 is far below anything a person can read comfortably.
 */
export function isHiddenColor(textColor: unknown, backgroundColor?: unknown): boolean {
  const fg = parseHexColor(textColor);
  if (!fg) return false;
  const bg = parseHexColor(backgroundColor) ?? WHITE;
  return contrastRatio(fg, bg) < 1.5;
}
