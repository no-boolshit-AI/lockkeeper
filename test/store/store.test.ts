import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AlreadyActiveError } from '../../src/core/errors.js';
import { type NewRun, Store } from '../../src/store/store.js';

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
    store.createRun(newRun('A-2'));
    store.updateRun(a.id, { state: 'in_review' });
    expect(store.countActiveRuns()).toBe(1);
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
