import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInvisible } from '../../src/core/hidden-text.js';

/**
 * Invisible characters in source code hide what the code does from reviewers, which is
 * the same trick the ticket-injection attacks use. Keep them out of this repository.
 */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe('source hygiene', () => {
  it('has no invisible or bidi control characters in source or docs', () => {
    const offenders: string[] = [];
    for (const file of [...files('src'), ...files('test'), ...files('docs')]) {
      const text = readFileSync(file, 'utf8');
      let line = 1;
      for (const char of text) {
        if (char === '\n') line += 1;
        if (isInvisible(char.codePointAt(0) as number)) offenders.push(`${file}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
