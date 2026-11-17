import { createHash } from 'node:crypto';

/**
 * Git object IDs computed in the control plane, so `lockkeeper demo` knows the sample
 * repository's commit before the sandbox that holds it exists. The sandbox builds the
 * same commit with git, and the clone checks the two agree.
 */

export interface TreeFile {
  /** A path inside the repository, with forward slashes. */
  path: string;
  content: string;
}

export interface CommitMeta {
  name: string;
  email: string;
  /** Seconds since the epoch, in UTC. */
  epoch: number;
  /** Without the trailing newline git adds. */
  message: string;
}

function hashObject(type: 'blob' | 'tree' | 'commit', body: Buffer): Buffer {
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]))
    .digest();
}

interface Dir {
  files: Map<string, Buffer>;
  dirs: Map<string, Dir>;
}

const newDir = (): Dir => ({ files: new Map(), dirs: new Map() });

function hashTree(dir: Dir): Buffer {
  const entries: { name: string; sortKey: Buffer; mode: string; id: Buffer }[] = [];
  for (const [name, id] of dir.files)
    entries.push({ name, sortKey: Buffer.from(name), mode: '100644', id });
  // Git sorts a directory as if its name ended with a slash.
  for (const [name, sub] of dir.dirs)
    entries.push({ name, sortKey: Buffer.from(`${name}/`), mode: '40000', id: hashTree(sub) });
  entries.sort((a, b) => Buffer.compare(a.sortKey, b.sortKey));
  return hashObject(
    'tree',
    Buffer.concat(
      entries.map((entry) =>
        Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`), entry.id]),
      ),
    ),
  );
}

/** The commit git makes from these files (all mode 100644) with no parent. */
export function commitId(files: readonly TreeFile[], meta: CommitMeta): string {
  const root = newDir();
  for (const file of files) {
    const parts = file.path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = newDir();
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.set(parts.at(-1) as string, hashObject('blob', Buffer.from(file.content, 'utf8')));
  }
  const tree = hashTree(root).toString('hex');
  const who = `${meta.name} <${meta.email}> ${meta.epoch} +0000`;
  const body = `tree ${tree}\nauthor ${who}\ncommitter ${who}\n\n${meta.message}\n`;
  return hashObject('commit', Buffer.from(body, 'utf8')).toString('hex');
}
