import { createHash } from 'node:crypto';
import type { ChangedFile, ChangeStatus } from '../policy/diff-policy.js';

/**
 * Parsers for `git diff --raw -z` and `git diff --numstat -z` output produced in the
 * sandbox. The output is untrusted: object IDs are validated before they are ever used
 * in a command, and blob contents are checked against them.
 */

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function isObjectId(value: string): boolean {
  return OBJECT_ID.test(value);
}

const STATUS: Record<string, ChangeStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  T: 'typechange',
};

export interface RawEntry {
  path: string;
  status: ChangeStatus;
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
}

/** Parse `git diff --raw -z --no-renames --no-abbrev`. */
export function parseRawDiff(output: string): RawEntry[] {
  const parts = output.split('\0');
  const entries: RawEntry[] = [];
  for (let index = 0; index < parts.length; index++) {
    const meta = parts[index];
    if (!meta) continue;
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMDT])\d*$/.exec(meta.trim());
    if (!match) throw new Error(`Unexpected git diff --raw output: ${meta.slice(0, 80)}`);
    const path = parts[index + 1];
    if (path === undefined || path === '')
      throw new Error('git diff --raw output is missing a path.');
    index += 1;
    const [, oldMode, newMode, oldSha, newSha, status] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (!isObjectId(oldSha) || !isObjectId(newSha))
      throw new Error(`Invalid object ID in git output for ${path}.`);
    entries.push({
      path,
      status: STATUS[status] as ChangeStatus,
      oldMode,
      newMode,
      oldSha,
      newSha,
    });
  }
  return entries;
}

/** Parse `git diff --numstat -z --no-renames`. Binary files report null counts. */
export function parseNumstat(
  output: string,
): Map<string, { added: number | null; removed: number | null }> {
  const stats = new Map<string, { added: number | null; removed: number | null }>();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const match = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(record.replace(/^\n/, ''));
    if (!match) continue;
    const [, added, removed, path] = match as unknown as [string, string, string, string];
    stats.set(path, {
      added: added === '-' ? null : Number(added),
      removed: removed === '-' ? null : Number(removed),
    });
  }
  return stats;
}

export function toChangedFiles(
  raw: RawEntry[],
  numstat: ReturnType<typeof parseNumstat>,
): ChangedFile[] {
  return raw.map((entry) => {
    const stat = numstat.get(entry.path);
    return {
      path: entry.path,
      status: entry.status,
      oldMode: entry.oldMode,
      newMode: entry.newMode,
      newSha: entry.newSha,
      added: stat ? stat.added : 0,
      removed: stat ? stat.removed : 0,
    };
  });
}

/** The object ID git gives a blob, so contents read from the sandbox can be checked. */
export function gitBlobSha1(content: Uint8Array): string {
  const hash = createHash('sha1');
  hash.update(`blob ${content.byteLength}\0`);
  hash.update(content);
  return hash.digest('hex');
}

/** Parse lines of `<object-id> <base64>` produced by the blob export command. */
export function parseBlobExport(output: string): Map<string, Uint8Array> {
  const blobs = new Map<string, Uint8Array>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const space = line.indexOf(' ');
    const sha = space === -1 ? line.trim() : line.slice(0, space);
    const data = space === -1 ? '' : line.slice(space + 1).trim();
    if (!isObjectId(sha)) throw new Error('Unexpected blob export output.');
    blobs.set(sha, new Uint8Array(Buffer.from(data, 'base64')));
  }
  return blobs;
}
