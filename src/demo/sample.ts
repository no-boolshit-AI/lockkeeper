import type { TicketSnapshot } from '../tracker/tracker.js';
import type { CommitMeta, TreeFile } from './git-objects.js';

/**
 * The sample repository and the canned ticket behind `lockkeeper demo`: a tiny shop
 * library with no dependencies, so the demo needs no setup step and no registry.
 */

const lines = (...text: string[]) => `${text.join('\n')}\n`;

export const SAMPLE_FILES: readonly TreeFile[] = [
  { path: '.gitignore', content: lines('node_modules/') },
  {
    path: 'AGENTS.md',
    content: lines(
      '# Working on the demo shop',
      '',
      '- Prices are integer cents inside the library. Public functions return euros.',
      '- Tests use `node:test` and `node:assert/strict`. Put new tests next to the existing ones in `test/`.',
      '- Do not add dependencies.',
      '- Run `npm run lint` and `npm test` before you finish.',
    ),
  },
  {
    path: 'README.md',
    content: lines(
      '# Lockkeeper demo shop',
      '',
      'A tiny shop library that `lockkeeper demo` hands to a coding agent, with a sample ticket.',
      '',
      'It has no dependencies and needs Node 20 or later: `npm test` and `npm run lint`.',
    ),
  },
  {
    path: 'package.json',
    content: lines(
      '{',
      '  "name": "lockkeeper-demo-shop",',
      '  "version": "1.0.0",',
      '  "private": true,',
      '  "type": "module",',
      '  "scripts": {',
      '    "lint": "for file in src/*.js test/*.js; do node --check \\"$file\\" || exit 1; done",',
      '    "test": "node --test"',
      '  },',
      '  "engines": { "node": ">=20" },',
      '  "license": "Apache-2.0"',
      '}',
    ),
  },
  {
    path: 'src/cart.js',
    content: lines(
      '/**',
      ' * Cart totals for the demo shop. Prices are integer cents inside the library;',
      ' * public functions return euros.',
      ' */',
      '',
      '/** @typedef {{ name: string, priceCents: number, quantity: number }} CartItem */',
      '',
      '/**',
      ' * The cart total after an optional percentage discount, in euros.',
      ' * @param {CartItem[]} items',
      ' * @param {number} [discountPercent]',
      ' * @returns {number}',
      ' */',
      'export function cartTotal(items, discountPercent = 0) {',
      '  if (discountPercent < 0 || discountPercent > 100) {',
      "    throw new RangeError('discountPercent must be between 0 and 100');",
      '  }',
      '  let totalCents = 0;',
      '  for (const item of items) {',
      '    const lineCents = item.priceCents * item.quantity * (1 - discountPercent / 100);',
      '    totalCents += Math.floor(lineCents);',
      '  }',
      '  return totalCents / 100;',
      '}',
      '',
      '/**',
      ' * How many items are in the cart.',
      ' * @param {CartItem[]} items',
      ' * @returns {number}',
      ' */',
      'export function itemCount(items) {',
      '  return items.reduce((count, item) => count + item.quantity, 0);',
      '}',
    ),
  },
  {
    path: 'src/format.js',
    content: lines(
      '/**',
      ' * Format an amount in euros for display, such as "€9.25".',
      ' * @param {number} amount',
      ' * @returns {string}',
      ' */',
      'export function formatPrice(amount) {',
      "  return '€' + amount.toFixed(2);",
      '}',
    ),
  },
  {
    path: 'test/cart.test.js',
    content: lines(
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "import { cartTotal, itemCount } from '../src/cart.js';",
      '',
      "const coffee = { name: 'Coffee', priceCents: 350, quantity: 2 };",
      "const bagel = { name: 'Bagel', priceCents: 225, quantity: 1 };",
      '',
      "test('totals a cart without a discount', () => {",
      '  assert.equal(cartTotal([coffee, bagel]), 9.25);',
      '});',
      '',
      "test('applies a percentage discount', () => {",
      '  assert.equal(cartTotal([coffee], 10), 6.3);',
      '});',
      '',
      "test('counts items across lines', () => {",
      '  assert.equal(itemCount([coffee, bagel]), 3);',
      '});',
    ),
  },
];

export const SAMPLE_COMMIT: CommitMeta = {
  name: 'Lockkeeper demo',
  email: 'demo@lockkeeper.invalid',
  epoch: 1_767_225_600,
  message: 'Sample shop library',
};

export const DEMO_KEY = 'DEMO-1';
export const DEMO_SITE = 'demo.example.invalid';
export const DEMO_REPO = 'lockkeeper/demo-shop';

export function demoTicket(now = new Date()): TicketSnapshot {
  return {
    key: DEMO_KEY,
    project: 'DEMO',
    url: `https://${DEMO_SITE}/browse/${DEMO_KEY}`,
    summary: 'Add a one-line cart summary',
    issueType: 'Story',
    status: 'To Do',
    labels: ['agent'],
    components: [],
    reporter: { accountId: 'demo-requester', displayName: 'Maria', accountType: 'atlassian' },
    description: [
      'The shop header needs a short line such as "3 items · €9.25".',
      '',
      'Add `cartSummary(items, discountPercent)` to `src/cart.js`. It returns the number of items and the total after the discount, formatted with `formatPrice` from `src/format.js`. Use "1 item" for a single item and "N items" otherwise.',
    ].join('\n'),
    acceptanceCriteria: [
      'cartSummary of two coffees and a bagel returns "3 items · €9.25"',
      'A single item reads "1 item"',
      'The discount applies, as it does in cartTotal',
      'Tests cover the new function',
    ],
    acceptanceCriteriaSource: 'description',
    comments: [],
    links: [],
    attachments: [],
    externalAuthors: [],
    hiddenText: { invisibleChars: 0, hiddenSegments: 0 },
    capturedAt: now.toISOString(),
  };
}
