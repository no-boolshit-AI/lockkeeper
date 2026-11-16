import { projectSettings } from '../config/schema.js';
import { AlreadyActiveError, errorMessage } from '../core/errors.js';
import { type Logger, prefixedLogger, silentLogger } from '../core/log.js';
import { Authorizer } from '../engine/authorize.js';
import { parseCommand } from '../engine/commands.js';
import { queuedDoc, refusedDoc, stoppedBeforeStartDoc } from '../engine/report.js';
import {
  parseTriggerInfo,
  type RunDeps,
  type RunResult,
  resumeRun,
  type TriggerInfo,
} from '../engine/run.js';
import type { RunRecord, RunState } from '../store/store.js';
import type { LabelEvent, TicketComment, TicketRef } from '../tracker/tracker.js';

export interface DaemonOptions {
  /** Milliseconds between polls of Jira. */
  pollMs: number;
  /** The most tickets one search returns. */
  batchSize?: number;
}

interface RunningRun {
  run: RunRecord;
  cancel: AbortController;
  detach: AbortController;
  done: Promise<void>;
}

const projectOf = (key: string) => key.slice(0, key.lastIndexOf('-'));

/** Runs whose ticket accepts `/agent retry`, and how long after the run it does. */
const RETRYABLE: readonly RunState[] = ['in_review', 'failed', 'cancelled', 'done', 'declined'];
const RETRY_WINDOW_MS = 14 * 24 * 60 * 60_000;

/**
 * The long-running service behind `lockkeeper start` (T1, T2, T6, E7, F3). It polls
 * Jira, so nothing has to reach the machine from outside. Each poll:
 *
 * 1. finds tickets with the trigger label, checks who added it, and claims each one
 *    once or refuses it with a comment;
 * 2. stops runs whose label was removed or that got an `/agent stop` comment;
 * 3. starts queued runs while the parallel-run cap allows.
 *
 * At start it resumes runs a previous process left behind. On stop, its own runs stop
 * where they are, with their sandboxes paused, and resume at the next start.
 */
export class Daemon {
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly authorizer: Authorizer;
  private readonly running = new Map<string, RunningRun>();
  private readonly lastError = new Map<string, string>();
  private stopping = false;
  private lastRetryScan: number | undefined;
  /** Runs whose ticket had none of Lockkeeper's labels at the last poll. */
  private readonly unlabelled = new Set<string>();
  private wake: (() => void) | undefined;

  constructor(
    private readonly deps: RunDeps,
    private readonly options: DaemonOptions,
  ) {
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? Date.now;
    this.authorizer = new Authorizer(deps.tracker, deps.config.jira.allow_users, this.now);
  }

  /** Whether anyone in a configured project may start runs (no allow-list). */
  get openToAll(): boolean {
    return this.authorizer.open;
  }

  /** Resume what a previous process left, then poll until `stop()`. */
  async run(): Promise<void> {
    this.resumeOrphans();
    while (!this.stopping) {
      await this.tick();
      if (this.stopping) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.options.pollMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
    await this.settle();
  }

  /** Stop polling. Runs in progress stop where they are and resume at the next start. */
  stop(): void {
    this.stopping = true;
    for (const entry of this.running.values()) entry.detach.abort();
    this.wake?.();
  }

  /** Wait until every run this process started has finished or stopped. */
  async settle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running.values()].map((entry) => entry.done));
    }
  }

  /** One poll. Each part fails on its own, so a Jira hiccup never stops the others. */
  async tick(): Promise<void> {
    await this.guard('looking for labelled tickets', () => this.pickUp());
    await this.guard('checking active runs', () => this.watch());
    await this.guard('checking for retries', () => this.watchRetries());
    await this.guard('starting queued runs', () => this.startQueued());
  }

  /** Continue runs whose process stopped, as after a crash or restart. */
  resumeOrphans(): void {
    for (const run of this.deps.store.orphanedRuns(new Date(this.now()))) {
      if (this.running.has(run.id)) continue;
      this.log.step(
        `${run.ticketKey}: resuming run ${run.id}, which stopped in the ${run.state} step`,
      );
      this.launch(run);
    }
  }

  // -------------------------------------------------------------------------

  /** T1, T2, T6: claim each newly labelled ticket once, if the right person labelled it. */
  private async pickUp(): Promise<void> {
    const { config, tracker, store } = this.deps;
    const label = config.jira.labels.trigger;
    const projects = Object.keys(config.projects)
      .map((key) => `"${key}"`)
      .join(', ');
    const refs = await tracker.search(
      `(${config.jira.trigger}) AND project in (${projects}) ORDER BY updated ASC`,
      this.options.batchSize ?? 50,
    );
    for (const ref of refs) {
      if (this.stopping) return;
      if (!ref.labels.includes(label)) {
        this.warnOnce(
          `no-label:${ref.key}`,
          `${ref.key} matches jira.trigger but has no "${label}" label, so Lockkeeper cannot tell who asked for it. Make jira.trigger require the label.`,
        );
        continue;
      }
      if (store.activeRunFor(ref.key)) continue;
      const event = await tracker.labelAdded(ref.key, label);
      if (!event) continue;
      // The same label change never starts a second run or a second refusal.
      const last = store.listRuns({ ticketKey: ref.key, limit: 1 })[0];
      if (last && parseTriggerInfo(last.triggerInfo)?.eventId === event.id) continue;
      const verdict = await this.authorizer.check(event.by);
      if (verdict.allowed) this.claim(ref.key, event);
      else await this.refuse(ref.key, event, verdict.reason, verdict.hint);
    }
  }

  private trigger(event: LabelEvent): TriggerInfo {
    return {
      source: 'label',
      label: event.label,
      eventId: event.id,
      at: event.at,
      by: { accountId: event.by.accountId, displayName: event.by.displayName },
    };
  }

  private claim(key: string, event: LabelEvent): void {
    const { store, tracker, config, agent } = this.deps;
    const settings = projectSettings(config, projectOf(key));
    if (!settings) return;
    const trigger = this.trigger(event);
    const now = new Date(this.now());
    try {
      const run = store.createRun(
        {
          ticketKey: key,
          tracker: tracker.kind,
          repo: settings.repo,
          baseBranch: settings.baseBranch,
          workflow: 'feature',
          agent: agent.id,
          triggeredBy: `jira:${event.by.displayName}`,
          triggerInfo: JSON.stringify(trigger),
          state: 'queued',
        },
        now,
      );
      store.appendEvent(run.id, 'trigger', trigger, now);
      this.log.step(`${key}: ${event.by.displayName} added the ${event.label} label`);
    } catch (error) {
      if (!(error instanceof AlreadyActiveError)) throw error;
    }
  }

  private async refuse(
    key: string,
    event: LabelEvent,
    reason: string,
    hint: string,
  ): Promise<void> {
    const { store, tracker, config, agent } = this.deps;
    const settings = projectSettings(config, projectOf(key));
    if (!settings) return;
    const now = new Date(this.now());
    const run = store.createRun(
      {
        ticketKey: key,
        tracker: tracker.kind,
        repo: settings.repo,
        baseBranch: settings.baseBranch,
        workflow: 'feature',
        agent: agent.id,
        triggeredBy: `jira:${event.by.displayName}`,
        triggerInfo: JSON.stringify(this.trigger(event)),
        state: 'refused',
      },
      now,
    );
    store.updateRun(run.id, { error: reason, finishedAt: now.toISOString() }, now);
    store.appendEvent(run.id, 'refused', { reason, by: event.by }, now);
    this.log.warn(`${key}: not started. ${reason}`);
    await tracker.postComment(key, refusedDoc(key, reason, hint));
    await tracker.updateLabels(key, { remove: [config.jira.labels.trigger] });
  }

  /** F3: stop runs whose label was removed, and act on `/agent` comments. */
  private async watch(): Promise<void> {
    const { store, config } = this.deps;
    const labels = config.jira.labels;
    // `lockkeeper cancel` only marks the run in the store; stop it here, so the run
    // itself reports the stop instead of failing on its deleted sandbox.
    for (const entry of this.running.values()) {
      if (store.getRun(entry.run.id)?.state === 'cancelled' && !entry.cancel.signal.aborted)
        entry.cancel.abort('The run was cancelled from the command line.');
    }
    const runs = store.activeRuns().filter((run) => run.state !== 'in_review');
    if (runs.length === 0) return;
    const current = await this.currentLabels([...new Set(runs.map((run) => run.ticketKey))]);
    for (const run of runs) {
      if (this.stopping) return;
      const ticketLabels = current.get(run.ticketKey);
      const ours = [labels.trigger, labels.working, labels.needs_info, labels.in_review];
      const labelled =
        ticketLabels === undefined || ticketLabels.some((label) => ours.includes(label));
      // A run swaps its own labels as it finishes, and Jira's search can lag behind: only
      // a label missing on two polls in a row stops a run, and never while it publishes.
      if (labelled || run.state === 'publish' || run.state === 'report') {
        this.unlabelled.delete(run.id);
      } else if (!this.unlabelled.has(run.id)) {
        this.unlabelled.add(run.id);
      } else {
        this.unlabelled.delete(run.id);
        const removed = run.state === 'needs_info' ? labels.needs_info : labels.working;
        await this.stopRun(run, `The ${removed} label was removed, so Lockkeeper stopped.`);
        continue;
      }
      await this.readCommands(run);
    }
  }

  /** Each ticket's labels now. A ticket that cannot be read is left out, not stopped. */
  private async currentLabels(keys: string[]): Promise<Map<string, string[]>> {
    const refs = await this.findTickets(keys);
    return new Map(refs.map((ref) => [ref.key, ref.labels]));
  }

  /** These tickets, narrowed by an optional JQL clause. Unreadable ones are left out. */
  private async findTickets(keys: string[], clause = ''): Promise<TicketRef[]> {
    const { tracker } = this.deps;
    const extra = clause ? ` AND ${clause}` : '';
    try {
      return await tracker.search(`key in (${keys.join(', ')})${extra}`, keys.length);
    } catch {
      // Jira rejects the whole query if one ticket was deleted or moved: ask one by one.
      const found: TicketRef[] = [];
      for (const key of keys) {
        try {
          found.push(...(await tracker.search(`key = ${key}${extra}`, 1)));
        } catch (error) {
          this.warnOnce(`read:${key}`, `Could not read ${key}: ${errorMessage(error)}`);
        }
      }
      return found;
    }
  }

  /**
   * F3: `/agent retry <hint>` on a ticket whose latest run finished or is in review
   * starts a new run. Only tickets changed since the last look are read.
   */
  private async watchRetries(): Promise<void> {
    const { store } = this.deps;
    const runs = store
      .latestRuns(new Date(this.now() - RETRY_WINDOW_MS), RETRYABLE)
      .filter((run) => !this.running.has(run.id));
    if (runs.length === 0) return;
    const started = this.now();
    const minutes =
      this.lastRetryScan === undefined
        ? RETRY_WINDOW_MS / 60_000
        : Math.ceil((started - this.lastRetryScan) / 60_000) + 1;
    const changed = new Set(
      (
        await this.findTickets(
          [...new Set(runs.map((run) => run.ticketKey))],
          `updated >= -${minutes}m`,
        )
      ).map((ref) => ref.key),
    );
    for (const run of runs) {
      if (this.stopping) return;
      if (changed.has(run.ticketKey)) await this.readRetry(run);
    }
    this.lastRetryScan = started;
  }

  private async readRetry(run: RunRecord): Promise<void> {
    const { store, tracker } = this.deps;
    const comments = await tracker.newComments(run.ticketKey, {
      ...(run.commentsSeen ? { afterId: run.commentsSeen } : {}),
      since: run.finishedAt ?? run.updatedAt,
    });
    const newest = comments.at(-1)?.id;
    if (!newest) return;
    store.updateRun(run.id, { commentsSeen: newest });
    for (const comment of comments) {
      const command = parseCommand(comment.body);
      if (command?.kind !== 'retry') continue;
      const verdict = await this.authorizer.check(comment.author);
      if (!verdict.allowed) {
        this.log.warn(
          `${run.ticketKey}: ignored /agent retry from ${comment.author.displayName}. ${verdict.reason}`,
        );
        continue;
      }
      await this.retry(run, comment, command.hint);
      return;
    }
  }

  private async retry(previous: RunRecord, comment: TicketComment, hint: string): Promise<void> {
    const { store, config, tracker, agent, sandboxes } = this.deps;
    const settings = projectSettings(config, projectOf(previous.ticketKey));
    if (!settings) return;
    const now = new Date(this.now());
    if (previous.state === 'in_review') {
      // The new run takes over the ticket and the pull request.
      store.updateRun(previous.id, { state: 'done', finishedAt: now.toISOString() }, now);
      store.appendEvent(previous.id, 'superseded', { by: comment.author.displayName }, now);
      if (previous.sandboxId) {
        try {
          await (await sandboxes.connect(previous.sandboxId)).destroy();
        } catch (error) {
          this.log.debug(`Could not delete sandbox ${previous.sandboxId}: ${errorMessage(error)}`);
        }
      }
    }
    // The ticket's latest run that published continues on its branch, even when a retry
    // since then was stopped before it committed. Otherwise the attempt starts afresh.
    const published = store
      .listRuns({ ticketKey: previous.ticketKey, limit: 20 })
      .find((run) => run.headSha && run.branch);
    const branch = published?.branch ?? null;
    const trigger: TriggerInfo = {
      source: 'retry',
      at: comment.created,
      eventId: `comment:${comment.id}`,
      by: { accountId: comment.author.accountId, displayName: comment.author.displayName },
    };
    try {
      const run = store.createRun(
        {
          ticketKey: previous.ticketKey,
          tracker: tracker.kind,
          repo: previous.repo,
          baseBranch: settings.baseBranch,
          workflow: previous.workflow,
          agent: agent.id,
          triggeredBy: `jira:${comment.author.displayName}`,
          triggerInfo: JSON.stringify(trigger),
          state: 'queued',
          parentRunId: previous.id,
          commentsSeen: comment.id,
          ...(hint ? { hint } : {}),
          ...(branch ? { branch } : {}),
        },
        now,
      );
      store.appendEvent(run.id, 'trigger', trigger, now);
      this.log.step(
        `${previous.ticketKey}: ${comment.author.displayName} asked for another attempt${branch ? ` on ${branch}` : ''}`,
      );
    } catch (error) {
      if (!(error instanceof AlreadyActiveError)) throw error;
    }
  }

  private async readCommands(run: RunRecord): Promise<void> {
    const { store, tracker } = this.deps;
    const comments = await tracker.newComments(run.ticketKey, {
      ...(run.commentsSeen ? { afterId: run.commentsSeen } : {}),
      since: run.createdAt,
    });
    const newest = comments.at(-1)?.id;
    if (!newest) return;
    store.updateRun(run.id, { commentsSeen: newest });
    for (const comment of comments) {
      const command = parseCommand(comment.body);
      if (!command || command.kind === 'unknown') continue;
      const verdict = await this.authorizer.check(comment.author);
      if (!verdict.allowed) {
        this.log.warn(
          `${run.ticketKey}: ignored /agent ${command.kind} from ${comment.author.displayName}. ${verdict.reason}`,
        );
        continue;
      }
      if (command.kind === 'stop') {
        await this.stopRun(run, `${comment.author.displayName} stopped the run with /agent stop.`);
        return;
      }
      if (command.kind === 'go' && run.state === 'needs_info') {
        // R2: continue with the answers. The time limit starts again from here.
        const now = new Date(this.now());
        store.appendEvent(
          run.id,
          'answers',
          { by: comment.author.displayName, text: command.text, commentId: comment.id },
          now,
        );
        store.updateRun(run.id, { state: 'queued', startedAt: null }, now);
        this.log.step(`${run.ticketKey}: ${comment.author.displayName} answered with /agent go`);
        return;
      }
    }
  }

  private async stopRun(run: RunRecord, reason: string): Promise<void> {
    const mine = this.running.get(run.id);
    if (mine) {
      // The run itself reports the stop on the ticket and deletes its sandbox.
      this.log.warn(`${run.ticketKey}: ${reason}`);
      mine.cancel.abort(reason);
      return;
    }
    // A run held by another process is left to it.
    if (run.state !== 'queued' && run.state !== 'needs_info') return;
    const { store, tracker, config } = this.deps;
    const labels = config.jira.labels;
    const now = new Date(this.now());
    store.updateRun(
      run.id,
      { state: 'cancelled', error: reason, finishedAt: now.toISOString() },
      now,
    );
    store.appendEvent(run.id, 'cancelled', { reason }, now);
    this.log.warn(`${run.ticketKey}: ${reason}`);
    if (run.statusCommentId) {
      await tracker.updateComment(
        run.ticketKey,
        run.statusCommentId,
        stoppedBeforeStartDoc(run.ticketKey, reason, run.id),
      );
    }
    await tracker.updateLabels(run.ticketKey, {
      remove: [labels.trigger, labels.working, labels.needs_info],
    });
  }

  /** E7: start queued runs while slots are free; tell the others they are queued (T1). */
  private async startQueued(): Promise<void> {
    const { store, config, tracker, agent } = this.deps;
    for (const run of store.runsInState('queued')) {
      if (this.stopping) return;
      if (this.running.has(run.id)) continue;
      if (store.countExecutingRuns() < config.limits.parallel_runs) {
        this.launch(run);
        continue;
      }
      if (run.statusCommentId) continue;
      const commentId = await tracker.postComment(
        run.ticketKey,
        queuedDoc({
          key: run.ticketKey,
          runId: run.id,
          slots: config.limits.parallel_runs,
          agentName: agent.displayName,
          limits: { costUsd: config.limits.cost_usd, minutes: config.limits.minutes },
        }),
      );
      store.updateRun(run.id, { statusCommentId: commentId });
      await tracker.updateLabels(run.ticketKey, {
        add: [config.jira.labels.working],
        remove: [config.jira.labels.trigger],
      });
    }
  }

  private launch(run: RunRecord): void {
    const cancel = new AbortController();
    const detach = new AbortController();
    const deps: RunDeps = { ...this.deps, log: prefixedLogger(this.log, run.ticketKey) };
    // resumeRun claims the run synchronously, before its first await, so the
    // parallel-run count is right for the next queued run.
    const done = resumeRun(deps, run.id, { signal: cancel.signal, detach: detach.signal })
      .then((result) => this.finished(run, result))
      .catch((error) => this.log.error(`${run.ticketKey}: ${errorMessage(error)}`))
      .finally(() => {
        this.running.delete(run.id);
        // A slot is free: start the next queued run now rather than at the next poll.
        if (!this.stopping) void this.guard('starting queued runs', () => this.startQueued());
      });
    this.running.set(run.id, { run, cancel, detach, done });
  }

  private finished(run: RunRecord, result: RunResult | undefined): void {
    if (!result) return;
    const key = run.ticketKey;
    switch (result.outcome) {
      case 'pr':
        this.log.step(
          `${key}: ${result.draftReasons.length > 0 ? 'draft ' : ''}PR ${result.pr.url}`,
        );
        break;
      case 'no_changes':
        this.log.step(`${key}: finished without changes`);
        break;
      case 'refused':
        this.log.warn(`${key}: not started. ${result.reason}`);
        break;
      case 'failed':
        this.log.warn(
          `${key}: ${result.run.state === 'cancelled' ? 'stopped' : 'failed'}. ${result.error.message}`,
        );
        break;
      case 'needs_info':
        this.log.step(`${key}: asked ${result.questions.length} questions on the ticket`);
        break;
      case 'declined':
        this.log.warn(`${key}: declined. ${result.reason}`);
        break;
      case 'detached':
        break;
      case 'dry_run':
        break;
    }
  }

  /** Run one part of a poll, logging a failure once until it changes or recovers. */
  private async guard(what: string, part: () => Promise<void>): Promise<void> {
    try {
      await part();
      this.lastError.delete(what);
    } catch (error) {
      const message = `Error while ${what}: ${errorMessage(error)}`;
      if (this.lastError.get(what) !== message) this.log.warn(message);
      this.lastError.set(what, message);
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.lastError.has(key)) return;
    this.lastError.set(key, message);
    this.log.warn(message);
  }
}
