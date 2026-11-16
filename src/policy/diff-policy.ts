import { matchesAny } from './glob.js';
import { findSecrets } from './secrets.js';

/**
 * The control plane's checkpoint before anything reaches GitHub (V2). It runs on data
 * extracted from the sandbox, which it treats as untrusted.
 */

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'typechange';

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  oldMode: string;
  newMode: string;
  /** Object ID of the new content, as reported by git in the sandbox. */
  newSha: string;
  /** Null for binary files. */
  added: number | null;
  removed: number | null;
}

export type Severity = 'block' | 'draft' | 'note';

export interface PolicyFinding {
  severity: Severity;
  code:
    | 'unsafe-path'
    | 'submodule'
    | 'file-too-large'
    | 'protected-path'
    | 'too-many-lines'
    | 'too-many-files'
    | 'secret-in-diff'
    | 'binary-file'
    | 'symlink'
    | 'no-changes';
  message: string;
  paths?: string[];
}

export interface PolicyOptions {
  protectedPaths: readonly string[];
  maxAddedLines: number;
  maxChangedFiles: number;
}

export interface PolicyResult {
  findings: PolicyFinding[];
  /** Something we refuse to publish at all. */
  blocked: boolean;
  /** Publish, but as a draft with the reasons listed. */
  keepDraft: boolean;
  addedLines: number;
  removedLines: number;
}

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function isSafePath(path: string): boolean {
  if (!path || path.length > 4096) return false;
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  const segments = path.split('/');
  return segments.every(
    (segment) =>
      segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git',
  );
}

export function checkDiff(files: readonly ChangedFile[], options: PolicyOptions): PolicyResult {
  const findings: PolicyFinding[] = [];
  const addedLines = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const removedLines = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);

  if (files.length === 0) {
    findings.push({ severity: 'block', code: 'no-changes', message: 'The agent made no changes.' });
  }

  const unsafe = files.filter((file) => !isSafePath(file.path)).map((file) => file.path);
  if (unsafe.length > 0) {
    findings.push({
      severity: 'block',
      code: 'unsafe-path',
      message: 'Paths outside the repository or inside .git.',
      paths: unsafe,
    });
  }

  const submodules = files
    .filter((file) => file.newMode === '160000' || file.oldMode === '160000')
    .map((file) => file.path);
  if (submodules.length > 0) {
    findings.push({
      severity: 'block',
      code: 'submodule',
      message: 'Submodule changes cannot be published.',
      paths: submodules,
    });
  }

  const protectedHits = files
    .filter((file) => matchesAny(file.path, options.protectedPaths))
    .map((file) => file.path);
  if (protectedHits.length > 0) {
    findings.push({
      severity: 'draft',
      code: 'protected-path',
      message: 'Protected paths changed. A person must review these before the PR is marked ready.',
      paths: protectedHits,
    });
  }

  if (addedLines > options.maxAddedLines) {
    findings.push({
      severity: 'draft',
      code: 'too-many-lines',
      message: `${addedLines} lines added, above the limit of ${options.maxAddedLines}.`,
    });
  }

  if (files.length > options.maxChangedFiles) {
    findings.push({
      severity: 'draft',
      code: 'too-many-files',
      message: `${files.length} files changed, above the limit of ${options.maxChangedFiles}.`,
    });
  }

  const binary = files
    .filter((file) => file.status !== 'deleted' && file.added === null)
    .map((file) => file.path);
  if (binary.length > 0) {
    findings.push({
      severity: 'note',
      code: 'binary-file',
      message: 'Binary files changed.',
      paths: binary,
    });
  }

  const symlinks = files.filter((file) => file.newMode === '120000').map((file) => file.path);
  if (symlinks.length > 0) {
    findings.push({
      severity: 'note',
      code: 'symlink',
      message: 'Symbolic links added or changed.',
      paths: symlinks,
    });
  }

  return summarize(findings, addedLines, removedLines);
}

/** Add findings that need file contents: size limits and secrets in added content. */
export function checkContents(
  contents: ReadonlyMap<string, Uint8Array>,
  result: PolicyResult,
  maxFileBytes = MAX_FILE_BYTES,
): PolicyResult {
  const findings = [...result.findings];
  const tooLarge = [...contents]
    .filter(([, bytes]) => bytes.byteLength > maxFileBytes)
    .map(([path]) => path);
  if (tooLarge.length > 0) {
    findings.push({
      severity: 'block',
      code: 'file-too-large',
      message: `Files larger than ${Math.round(maxFileBytes / 1024 / 1024)} MB.`,
      paths: tooLarge,
    });
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const withSecrets: string[] = [];
  const kinds = new Set<string>();
  for (const [path, bytes] of contents) {
    if (bytes.byteLength > maxFileBytes) continue;
    const found = findSecrets(decoder.decode(bytes));
    if (found.length > 0) {
      withSecrets.push(path);
      for (const finding of found) kinds.add(finding.description);
    }
  }
  if (withSecrets.length > 0) {
    findings.push({
      severity: 'draft',
      code: 'secret-in-diff',
      message: `Possible secrets in changed files (${[...kinds].join(', ')}).`,
      paths: withSecrets,
    });
  }
  return summarize(findings, result.addedLines, result.removedLines);
}

function summarize(
  findings: PolicyFinding[],
  addedLines: number,
  removedLines: number,
): PolicyResult {
  return {
    findings,
    blocked: findings.some((finding) => finding.severity === 'block'),
    keepDraft: findings.some((finding) => finding.severity !== 'note'),
    addedLines,
    removedLines,
  };
}
