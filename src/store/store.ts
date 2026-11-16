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
  'readiness',
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
  'declined',
] as const;

export type RunState = (typeof RUN_STATES)[number];

/** States in which a run no longer owns its ticket. */
export const FINISHED_STATES: readonly RunState[] = [
  'done',
  'failed',
  'cancelled',
  'refused',
  'declined',
];

/** States in which a run owns its ticket but waits for a person: answers or a review. */
export const PARKED_STATES: readonly RunState[] = ['needs_info', 'in_review'];

/** States in which a process is working on the run. Only these hold a lease. */
export const EXECUTING_STATES: readonly RunState[] = RUN_STATES.filter(
  (state) =>
    state !== 'queued' && !FINISHED_STATES.includes(state) && !PARKED_STATES.includes(state),
);

export function isExecuting(state: RunState): boolean {
  return EXECUTING_STATES.includes(state);
}

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
  /** When a process first started working on the run. The time limit counts from here. */
  startedAt: string | null;
  /** The agent round in progress: 0 for the first, then one per fix round. */
  round: number | null;
  fixRounds: number | null;
  /** Bytes of the current round's event file already read and logged. */
  agentOffset: number | null;
  /** The process working on the run, and until when its claim holds. */
  owner: string | null;
  leaseUntil: string | null;
  dryRun: boolean;
  /** JSON: who started the run and how, such as the label change that triggered it. */
  triggerInfo: string | null;
  /** The newest ticket comment already checked for `/agent` commands. */
  commentsSeen: string | null;
  /** The run this one continues, after answers or a retry. */
  parentRunId: string | null;
  /** Extra guidance for the agent, from `/agent retry`. */
  hint: string | null;
}

export type NewRun = Pick<
  RunRecord,
  'ticketKey' | 'tracker' | 'repo' | 'baseBranch' | 'workflow' | 'agent'
> &
  Partial<
    Pick<
      RunRecord,
      | 'triggeredBy'
      | 'state'
      | 'owner'
      | 'leaseUntil'
      | 'dryRun'
      | 'triggerInfo'
      | 'commentsSeen'
      | 'parentRunId'
      | 'hint'
      | 'branch'
    >
  >;

export type RunPatch = Partial<
  Omit<RunRecord, 'id' | 'ticketKey' | 'createdAt' | 'updatedAt' | 'dryRun'>
>;

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
  startedAt: 'started_at',
  round: 'round',
  fixRounds: 'fix_rounds',
  agentOffset: 'agent_offset',
  owner: 'owner',
  leaseUntil: 'lease_until',
  dryRun: 'dry_run',
  triggerInfo: 'trigger_info',
  commentsSeen: 'comments_seen',
  parentRunId: 'parent_run_id',
  hint: 'hint',
};

const sqlList = (states: readonly RunState[]) => states.map((state) => `'${state}'`).join(', ');
const finishedList = sqlList(FINISHED_STATES);
const executingList = sqlList(EXECUTING_STATES);

// Migrations are append-only: never edit one that has shipped.
export const MIGRATIONS: readonly string[] = [
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
    WHERE state NOT IN ('done', 'failed', 'cancelled', 'refused');
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
  // M2: runs resume after a restart, under a lease, and remember their trigger.
  `
  ALTER TABLE runs ADD COLUMN started_at TEXT;
  ALTER TABLE runs ADD COLUMN round INTEGER;
  ALTER TABLE runs ADD COLUMN fix_rounds INTEGER;
  ALTER TABLE runs ADD COLUMN agent_offset INTEGER;
  ALTER TABLE runs ADD COLUMN owner TEXT;
  ALTER TABLE runs ADD COLUMN lease_until TEXT;
  ALTER TABLE runs ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN trigger_info TEXT;
  ALTER TABLE runs ADD COLUMN comments_seen TEXT;
  ALTER TABLE runs ADD COLUMN parent_run_id TEXT;
  ALTER TABLE runs ADD COLUMN hint TEXT;
  DROP INDEX runs_one_active_per_ticket;
  CREATE UNIQUE INDEX runs_one_active_per_ticket ON runs (ticket_key)
    WHERE state NOT IN ('done', 'failed', 'cancelled', 'refused', 'declined');
  CREATE INDEX runs_state ON runs (state);
  `,
];

export function newRunId(now = Date.now()): string {
  return `${now.toString(36)}-${randomBytes(3).toString('hex')}`;
}

type Row = Record<string, SQLInputValue>;

function toRecord(row: Row): RunRecord {
  const record = {} as Record<string, unknown>;
  for (const [key, column] of Object.entries(COLUMNS)) record[key] = row[column] ?? null;
  record.dryRun = row.dry_run === 1;
  return record as unknown as RunRecord;
}

function toParam(value: unknown): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return (value ?? null) as SQLInputValue;
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
      branch: input.branch ?? null,
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
      startedAt: null,
      round: null,
      fixRounds: null,
      agentOffset: null,
      owner: input.owner ?? null,
      leaseUntil: input.leaseUntil ?? null,
      dryRun: input.dryRun ?? false,
      triggerInfo: input.triggerInfo ?? null,
      commentsSeen: input.commentsSeen ?? null,
      parentRunId: input.parentRunId ?? null,
      hint: input.hint ?? null,
    };
    const columns = Object.values(COLUMNS);
    const params: Row = {};
    for (const [key, column] of Object.entries(COLUMNS)) {
      params[column] = toParam(record[key as keyof RunRecord]);
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

  /** Runs that hold a sandbox or are about to: the ones the parallel-run cap counts (E7). */
  countExecutingRuns(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM runs WHERE state IN (${executingList})`)
      .get() as { n: number };
    return row.n;
  }

  /** Runs in a given state, oldest first. */
  runsInState(state: RunState, limit = 100): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs WHERE state = ? ORDER BY created_at LIMIT ?')
      .all(state, limit) as Row[];
    return rows.map(toRecord);
  }

  /** Every run that still owns its ticket, oldest first. */
  activeRuns(): RunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE state NOT IN (${finishedList}) ORDER BY created_at`)
      .all() as Row[];
    return rows.map(toRecord);
  }

  /** Executing runs whose process stopped renewing its lease, as after a crash or restart. */
  orphanedRuns(now = new Date()): RunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE state IN (${executingList}) AND (lease_until IS NULL OR lease_until < ?) ORDER BY created_at`,
      )
      .all(now.toISOString()) as Row[];
    return rows.map(toRecord);
  }

  /**
   * Take the lease on a run unless another process holds a live one. Atomic, so two
   * processes sharing the file can never both work on one run.
   */
  acquireLease(id: string, owner: string, until: Date, now = new Date()): boolean {
    const result = this.db
      .prepare(
        'UPDATE runs SET owner = ?, lease_until = ?, updated_at = ? WHERE id = ? AND (owner IS NULL OR owner = ? OR lease_until IS NULL OR lease_until < ?)',
      )
      .run(owner, until.toISOString(), now.toISOString(), id, owner, now.toISOString());
    return Number(result.changes) === 1;
  }

  /** Extend this process's lease. False when another process has taken the run over. */
  renewLease(id: string, owner: string, until: Date): boolean {
    const result = this.db
      .prepare('UPDATE runs SET lease_until = ? WHERE id = ? AND owner = ?')
      .run(until.toISOString(), id, owner);
    return Number(result.changes) === 1;
  }

  releaseLease(id: string, owner: string): void {
    this.db
      .prepare('UPDATE runs SET owner = NULL, lease_until = NULL WHERE id = ? AND owner = ?')
      .run(id, owner);
  }

  updateRun(id: string, patch: RunPatch, now = new Date()): RunRecord {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    const sets = entries.map(([key]) => `${COLUMNS[key as keyof RunRecord]} = :${key}`);
    const params: Row = { id, updatedAt: now.toISOString() };
    for (const [key, value] of entries) params[key] = toParam(value);
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

  /** The data of the newest event of one kind, or undefined. */
  latestEvent<T = unknown>(runId: string, kind: string): T | undefined {
    const row = this.db
      .prepare('SELECT data FROM events WHERE run_id = ? AND kind = ? ORDER BY id DESC LIMIT 1')
      .get(runId, kind) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
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
