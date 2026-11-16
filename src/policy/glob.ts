/**
 * Gitignore-style path patterns for protected paths.
 *
 * - A pattern without a slash matches a file or directory name at any depth:
 *   `CODEOWNERS` matches `CODEOWNERS`, `docs/CODEOWNERS` and `.github/CODEOWNERS`.
 * - A pattern with a slash is anchored at the repository root: `.github/**`.
 * - `*` matches within one path segment, `**` across segments, `?` one character.
 * - A pattern that matches a directory also matches everything below it.
 */

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

export function globToRegExp(pattern: string): RegExp {
  let glob = pattern.trim().replace(/^\.\//, '');
  const anchored = glob.replace(/\/$/, '').includes('/');
  glob = glob.replace(/^\//, '').replace(/\/$/, '');

  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        const atSegmentStart = i === 0 || glob[i - 1] === '/';
        const atSegmentEnd = i + 2 === glob.length || glob[i + 2] === '/';
        if (atSegmentStart && atSegmentEnd) {
          if (glob[i + 2] === '/') {
            source += '(?:.*/)?';
            i += 2;
          } else {
            source += '.*';
            i += 1;
          }
          continue;
        }
        source += '[^/]*';
        i += 1;
        continue;
      }
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegex(char);
    }
  }
  const prefix = anchored ? '^' : '^(?:.*/)?';
  return new RegExp(`${prefix}${source}(?:/.*)?$`);
}

export function matchesAny(path: string, patterns: readonly string[]): string | undefined {
  const normalized = path.replace(/^\.\//, '');
  for (const pattern of patterns) {
    if (globToRegExp(pattern).test(normalized)) return pattern;
  }
  return undefined;
}
