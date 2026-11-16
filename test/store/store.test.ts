import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AlreadyActiveError } from '../../src/core/errors.js';
import { MIGRATIONS, type NewRun, Store } from '../../src/store/store.js';

const newRun = (ticketKey = 'SHOP-1'): NewRun => ({
  ticketKey,
  tracker: 'jira-cloud',
  repo: 'acme/shop',
  baseBranch: 'main',
  workflow: 'feature',
  agent: 'claude-code',
  triggeredBy: 'cli:test',
});

describe('the store', () => {
  let store: Store | undefined;
  let dir: string | undefined;

  afterEach(() => {
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    store = undefined;
    dir = undefined;
  });

  it('creates, updates and lists runs', () => {
    store = Store.open(':memory:');
    const run = store.createRun(newRun());
    expect(run).toMatchObject({ ticketKey: 'SHOP-1', state: 'queued', prUrl: null });
    const updated = store.updateRun(run.id, {
      state: 'in_review',
      prUrl: 'https://github.com/acme/shop/pull/1',
      costUsd: 1.5,
    });
    expect(updated).toMatchObject({
      state: 'in_review',
      prUrl: 'https://github.com/acme/shop/pull/1',
      costUsd: 1.5,
    });
    expect(store.listRuns().map((entry) => entry.id)).toEqual([run.id]);
    expect(store.getRun('nope')).toBeUndefined();
  });

  it('allows one active run per ticket (T6) and frees the ticket when the run finishes', () => {
    store = Store.open(':memory:');
    const first = store.createRun(newRun());
    expect(() => store?.createRun(newRun())).toThrow(AlreadyActiveError);
    store.createRun(newRun('SHOP-2'));
    store.updateRun(first.id, { state: 'failed' });
    expect(store.createRun(newRun()).id).not.toBe(first.id);
    expect(store.activeRunFor('SHOP-1')?.state).toBe('queued');
  });

  it('counts only runs that hold a sandbox slot', () => {
    store = Store.open(':memory:');
    const a = store.createRun(newRun('A-1'));
    const b = store.createRun(newRun('A-2'));
    store.createRun(newRun('A-3'));
    expect(store.countExecutingRuns()).toBe(0);
    store.updateRun(a.id, { state: 'implement' });
    store.updateRun(b.id, { state: 'in_review' });
    expect(store.countExecutingRuns()).toBe(1);
    expect(store.runsInState('queued').map((run) => run.ticketKey)).toEqual(['A-3']);
    expect(store.activeRuns()).toHaveLength(3);
  });

  it('lets one process at a time hold a run, and frees runs whose process stopped', () => {
    store = Store.open(':memory:');
    const t0 = new Date('2026-11-16T10:00:00Z');
    const later = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
    const run = store.createRun({ ...newRun(), state: 'implement' }, t0);
    expect(store.orphanedRuns(t0).map((entry) => entry.id)).toEqual([run.id]);

    expect(store.acquireLease(run.id, 'a', later(90), t0)).toBe(true);
    expect(store.acquireLease(run.id, 'b', later(100), later(10))).toBe(false);
    expect(store.orphanedRuns(later(10))).toEqual([]);
    expect(store.renewLease(run.id, 'b', later(200))).toBe(false);
    expect(store.renewLease(run.id, 'a', later(120))).toBe(true);

    // Process a stops renewing; after the lease ends, process b may take over.
    expect(store.orphanedRuns(later(130)).map((entry) => entry.id)).toEqual([run.id]);
    expect(store.acquireLease(run.id, 'b', later(220), later(130))).toBe(true);
    expect(store.getRun(run.id)?.owner).toBe('b');
    store.releaseLease(run.id, 'a');
    expect(store.getRun(run.id)?.owner).toBe('b');
    store.releaseLease(run.id, 'b');
    expect(store.getRun(run.id)).toMatchObject({ owner: null, leaseUntil: null });

    // Parked and finished runs are never orphans.
    store.updateRun(run.id, { state: 'in_review' });
    expect(store.orphanedRuns(later(500))).toEqual([]);
  });

  it('finds the newest event of a kind', () => {
    store = Store.open(':memory:');
    const run = store.createRun(newRun());
    expect(store.latestEvent(run.id, 'prompt')).toBeUndefined();
    store.appendEvent(run.id, 'prompt', { round: 0 });
    store.appendEvent(run.id, 'prompt', { round: 1 });
    expect(store.latestEvent(run.id, 'prompt')).toEqual({ round: 1 });
  });

  it('upgrades a database from the first schema without losing runs', () => {
    dir = mkdtempSync(join(tmpdir(), 'lockkeeper-store-'));
    const path = join(dir, 'old.db');
    const db = new DatabaseSync(path);
    db.exec(MIGRATIONS[0] as string);
    db.exec('PRAGMA user_version = 1');
    db.exec(
      `INSERT INTO runs (id, ticket_key, tracker, repo, base_branch, workflow, agent, state, created_at, updated_at)
       VALUES ('old-1', 'SHOP-9', 'jira-cloud', 'acme/shop', 'main', 'feature', 'claude-code', 'in_review', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    );
    db.close();
    store = Store.open(path);
    expect(store.getRun('old-1')).toMatchObject({ state: 'in_review', dryRun: false, round: null });
    // The upgraded index still allows one active run per ticket.
    expect(() => store?.createRun(newRun('SHOP-9'))).toThrow(AlreadyActiveError);
    store.updateRun('old-1', { state: 'declined' });
    expect(store.createRun(newRun('SHOP-9')).ticketKey).toBe('SHOP-9');
  });

  it('keeps an ordered audit log per run', () => {
    store = Store.open(':memory:');
    const run = store.createRun(newRun());
    store.appendEvent(run.id, 'snapshot', { key: 'SHOP-1' });
    store.appendEvent(run.id, 'agent', { type: 'tool_call', tool: 'Bash' });
    expect(store.events(run.id).map((event) => [event.kind, event.data])).toEqual([
      ['snapshot', { key: 'SHOP-1' }],
      ['agent', { type: 'tool_call', tool: 'Bash' }],
    ]);
    expect(store.events(run.id, { kind: 'agent' })).toHaveLength(1);
  });

  it('persists to a file and migrates once', () => {
    dir = mkdtempSync(join(tmpdir(), 'lockkeeper-store-'));
    const path = join(dir, 'nested', 'lockkeeper.db');
    store = Store.open(path);
    const run = store.createRun(newRun());
    store.close();
    store = Store.open(path);
    expect(store.getRun(run.id)?.ticketKey).toBe('SHOP-1');
  });
});
