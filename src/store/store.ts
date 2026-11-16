import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { AlreadyActiveError } from '../core/errors.js';

/**
 * One SQLite file holds runs and the audit log (O2). It can be rebuilt from Jira,
 * E2B metadata and GitHub, so losing it loses history, not correctness.
 */

export const RUN_STATES = [
  'queued',
  'snapshot',
  'sandbox',
  'clone',
  'setup',
  'implement',
  'verify',
  'collect',
  'publish',
  'report',
  'needs_info',
  'in_review',
  'done',
  'failed',
  'cancelled',
  'refused',
] as const;

export type RunState = (typeof RUN_STATES)[number];

/** States in which a run no longer owns its ticket. */
export const FINISHED_STATES: readonly RunState[] = ['done', 'failed', 'cancelled', 'refused'];

export interface RunRecord {
  id: string;
  ticketKey: string;
  tracker: string;
  repo: string;
  baseBranch: string;
  workflow: string;
  agent: string;
  state: RunState;
  triggeredBy: string | null;
  branch: string | null;
  baseSha: string | null;
  headSha: string | null;
  sandboxId: string | null;
  sessionId: string | null;
  prNumber: number | null;
  prUrl: string | null;
  statusCommentId: string | null;
  costUsd: number | null;
  turns: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export type NewRun = Pick<
  RunRecord,
  'ticketKey' | 'tracker' | 'repo' | 'baseBranch' | 'workflow' | 'agent'
> &
  Partial<Pick<RunRecord, 'triggeredBy' | 'state'>>;

export type RunPatch = Partial<Omit<RunRecord, 'id' | 'ticketKey' | 'createdAt' | 'updatedAt'>>;

export interface AuditEvent {
  id: number;
  runId: string;
  ts: string;
  kind: string;
  data: unknown;
}

const COLUMNS: Record<keyof RunRecord, string> = {
  id: 'id',
  ticketKey: 'ticket_key',
  tracker: 'tracker',
  repo: 'repo',
  baseBranch: 'base_branch',
  workflow: 'workflow',
  agent: 'agent',
  state: 'state',
  triggeredBy: 'triggered_by',
  branch: 'branch',
  baseSha: 'base_sha',
  headSha: 'head_sha',
  sandboxId: 'sandbox_id',
  sessionId: 'session_id',
  prNumber: 'pr_number',
  prUrl: 'pr_url',
  statusCommentId: 'status_comment_id',
  costUsd: 'cost_usd',
  turns: 'turns',
  error: 'error',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  finishedAt: 'finished_at',
};

const finishedList = FINISHED_STATES.map((state) => `'${state}'`).join(', ');

const MIGRATIONS: string[] = [
  `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    ticket_key TEXT NOT NULL,
    tracker TEXT NOT NULL,
    repo TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    workflow TEXT NOT NULL,
    agent TEXT NOT NULL,
    state TEXT NOT NULL,
    triggered_by TEXT,
    branch TEXT,
    base_sha TEXT,
    head_sha TEXT,
    sandbox_id TEXT,
    session_id TEXT,
    pr_number INTEGER,
    pr_url TEXT,
    status_comment_id TEXT,
    cost_usd REAL,
    turns INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  );
  -- T6: at most one run per ticket that has not finished.
  CREATE UNIQUE INDEX runs_one_active_per_ticket ON runs (ticket_key)
    WHERE state NOT IN (${finishedList});
  CREATE INDEX runs_created_at ON runs (created_at);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs (id),
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX events_run_id ON events (run_id, id);
  `,
];

export function newRunId(now = Date.now()): string {
  return `${now.toString(36)}-${randomBytes(3).toString('hex')}`;
}

type Row = Record<string, SQLInputValue>;

function toRecord(row: Row): RunRecord {
  const record = {} as Record<string, unknown>;
  for (const [key, column] of Object.entries(COLUMNS)) record[key] = row[column] ?? null;
  return record as unknown as RunRecord;
}

export class Store {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): Store {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    const store = new Store(db);
    store.migrate();
    return store;
  }

  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    for (let index = version; index < MIGRATIONS.length; index++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[index] as string);
        this.db.exec(`PRAGMA user_version = ${index + 1}`);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  /** Claim the ticket by creating a run. Throws AlreadyActiveError if one is active (T6). */
  createRun(input: NewRun, now = new Date()): RunRecord {
    const timestamp = now.toISOString();
    const record: RunRecord = {
      id: newRunId(now.getTime()),
      ticketKey: input.ticketKey,
      tracker: input.tracker,
      repo: input.repo,
      baseBranch: input.baseBranch,
      workflow: input.workflow,
      agent: input.agent,
      state: input.state ?? 'queued',
      triggeredBy: input.triggeredBy ?? null,
      branch: null,
      baseSha: null,
      headSha: null,
      sandboxId: null,
      sessionId: null,
      prNumber: null,
      prUrl: null,
      statusCommentId: null,
      costUsd: null,
      turns: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: null,
    };
    const columns = Object.values(COLUMNS);
    const params: Row = {};
    for (const [key, column] of Object.entries(COLUMNS)) {
      params[column] = record[key as keyof RunRecord] as SQLInputValue;
    }
    try {
      this.db
        .prepare(
          `INSERT INTO runs (${columns.join(', ')}) VALUES (${columns.map((c) => `:${c}`).join(', ')})`,
        )
        .run(params);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        const active = this.activeRunFor(input.ticketKey);
        throw new AlreadyActiveError(input.ticketKey, active?.id ?? 'unknown');
      }
      throw error;
    }
    return record;
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  activeRunFor(ticketKey: string): RunRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM runs WHERE ticket_key = ? AND state NOT IN (${finishedList}) LIMIT 1`)
      .get(ticketKey) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  countActiveRuns(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs WHERE state NOT IN (${finishedList}, 'in_review', 'needs_info')`,
      )
      .get() as { n: number };
    return row.n;
  }

  updateRun(id: string, patch: RunPatch, now = new Date()): RunRecord {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    const sets = entries.map(([key]) => `${COLUMNS[key as keyof RunRecord]} = :${key}`);
    const params: Row = { id, updatedAt: now.toISOString() };
    for (const [key, value] of entries) params[key] = value as SQLInputValue;
    this.db
      .prepare(`UPDATE runs SET ${[...sets, 'updated_at = :updatedAt'].join(', ')} WHERE id = :id`)
      .run(params);
    const updated = this.getRun(id);
    if (!updated) throw new Error(`Run ${id} does not exist.`);
    return updated;
  }

  listRuns(options: { limit?: number; ticketKey?: string } = {}): RunRecord[] {
    const limit = options.limit ?? 20;
    const rows = options.ticketKey
      ? this.db
          .prepare('SELECT * FROM runs WHERE ticket_key = ? ORDER BY created_at DESC LIMIT ?')
          .all(options.ticketKey, limit)
      : this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(limit);
    return (rows as Row[]).map(toRecord);
  }

  appendEvent(runId: string, kind: string, data: unknown, now = new Date()): void {
    this.db
      .prepare('INSERT INTO events (run_id, ts, kind, data) VALUES (?, ?, ?, ?)')
      .run(runId, now.toISOString(), kind, JSON.stringify(data ?? null));
  }

  events(runId: string, options: { kind?: string; limit?: number } = {}): AuditEvent[] {
    const limit = options.limit ?? 10_000;
    const rows = options.kind
      ? this.db
          .prepare('SELECT * FROM events WHERE run_id = ? AND kind = ? ORDER BY id LIMIT ?')
          .all(runId, options.kind, limit)
      : this.db
          .prepare('SELECT * FROM events WHERE run_id = ? ORDER BY id LIMIT ?')
          .all(runId, limit);
    return (rows as Row[]).map((row) => ({
      id: Number(row.id),
      runId: String(row.run_id),
      ts: String(row.ts),
      kind: String(row.kind),
      data: JSON.parse(String(row.data)),
    }));
  }
}
