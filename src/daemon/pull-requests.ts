import { projectSettings } from '../config/schema.js';
import { docToMarkdown } from '../core/doc.js';
import { AlreadyActiveError, errorMessage } from '../core/errors.js';
import { stripInvisible } from '../core/hidden-text.js';
import { type Logger, silentLogger } from '../core/log.js';
import { parsePullRequestCommand } from '../engine/commands.js';
import type { FeedbackItem, FollowUpFeedback } from '../engine/prompts.js';
import { closedOutDoc, type Outcome, type RunContext, roundsUsedDoc } from '../engine/report.js';
import { parseTriggerInfo, type RunDeps, type TriggerInfo } from '../engine/run.js';
import { redactSecrets } from '../policy/secrets.js';
import {
  canWrite,
  type PullRequestFeedback,
  type PullRequestStatus,
  type RepoPermission,
} from '../scm/scm.js';
import { isExecuting, type NewRun, type RunRecord } from '../store/store.js';
import type { TicketSnapshot } from '../tracker/tracker.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** How often a pending CI result is asked for again. */
const CI_POLL_MS = MINUTE;
/** After this long without any check reporting, a commit is taken to have no CI. */
const CI_GRACE_MS = 15 * MINUTE;
const PERMISSION_TTL_MS = 10 * MINUTE;

const projectOf = (key: string) => key.slice(0, key.lastIndexOf('-'));

/** The newest pull request feedback a run has acted on: a time, and the IDs seen at it. */
export interface FeedbackCursor {
  at: string;
  ids: string[];
}

export function parseCursor(value: string | null): FeedbackCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as FeedbackCursor;
    if (typeof parsed.at !== 'string' || Number.isNaN(Date.parse(parsed.at))) return undefined;
    return { at: parsed.at, ids: Array.isArray(parsed.ids) ? parsed.ids.map(String) : [] };
  } catch {
    return undefined;
  }
}

/** Move a cursor past these items, so they are never acted on twice. */
export function advanceCursor(
  cursor: FeedbackCursor,
  items: readonly PullRequestFeedback[],
): FeedbackCursor {
  let atMs = Date.parse(cursor.at);
  let ids = [...cursor.ids];
  for (const item of items) {
    const ms = Date.parse(item.createdAt);
    if (ms > atMs) {
      atMs = ms;
      ids = [item.id];
    } else if (ms === atMs && !ids.includes(item.id)) {
      ids.push(item.id);
    }
  }
  return { at: new Date(atMs).toISOString(), ids };
}

/** Text people wrote on GitHub, made safe to hand to the agent as data. */
function cleanText(value: string): string {
  // HTML comments render as nothing on GitHub, so they could hide instructions.
  return stripInvisible(value.replace(/<!--[\s\S]*?-->/g, '')).trim();
}

/** CI output, which can quote anything the code under test printed. */
function cleanCiText(value: string): string {
  return redactSecrets(stripInvisible(value)).text.trim();
}

function describe(item: PullRequestFeedback): string {
  if (item.kind === 'review')
    return item.reviewState === 'changes_requested' ? 'a changes-requested review' : 'a review';
  return item.kind === 'inline' ? 'an inline comment' : 'a comment';
}

/**
 * Reviews with the inline comments that came with them, then any other requests. The
 * agent sees each piece once, attributed to whoever wrote it.
 */
export function toFeedbackItems(
  requests: readonly PullRequestFeedback[],
  all: readonly PullRequestFeedback[],
): FeedbackItem[] {
  const reviews = new Set(requests.filter((item) => item.kind === 'review').map((item) => item.id));
  const items: FeedbackItem[] = [];
  for (const item of requests) {
    if (item.kind === 'inline' && item.reviewId && reviews.has(item.reviewId)) continue;
    const entry: FeedbackItem = {
      id: item.id,
      kind: item.kind,
      author: item.author.login,
      body: cleanText(item.body),
      url: item.url,
      ...(item.reviewState ? { reviewState: item.reviewState } : {}),
      ...(item.path ? { path: item.path } : {}),
      ...(item.line ? { line: item.line } : {}),
    };
    if (item.kind === 'review') {
      const comments = all
        .filter((other) => other.kind === 'inline' && other.reviewId === item.id)
        .map((other) => ({
          body: cleanText(other.body),
          ...(other.path ? { path: other.path } : {}),
          ...(other.line ? { line: other.line } : {}),
        }));
      if (comments.length > 0) entry.comments = comments;
    }
    items.push(entry);
  }
  return items;
}

export interface WatcherControl {
  /** Stop a run that is queued or that this process works on. */
  stop(run: RunRecord, reason: string): Promise<void>;
  warnOnce(key: string, message: string): void;
}

/**
 * Watches the pull requests Lockkeeper opened, so reviewers never leave GitHub:
 *
 * - F2: a merged or closed PR has its sandbox deleted and its ticket closed out; a PR
 *   with no activity for `sandbox.idle_days` loses its paused sandbox.
 * - F1: a changes-requested review, or an `/agent` comment, from someone with write
 *   access starts a follow-up that resumes the paused sandbox and agent session.
 * - Failed CI checks on Lockkeeper's own commit start a CI fix round.
 *
 * It polls, like the rest of the service, and asks GitHub with ETags, so unchanged
 * pull requests cost no rate limit.
 */
export class PullRequestWatcher {
  private readonly log: Logger;
  private readonly now: () => number;
  /** The PR `updatedAt` each run last read feedback at. */
  private readonly seen = new Map<string, string>();
  private readonly ciChecked = new Map<string, number>();
  /** Commits whose CI result needs nothing more from Lockkeeper. */
  private readonly ciDone = new Set<string>();
  private readonly permissions = new Map<string, { permission: RepoPermission; at: number }>();
  private readonly stopsSeen = new Set<string>();

  constructor(
    private readonly deps: RunDeps,
    private readonly control: WatcherControl,
  ) {
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? Date.now;
  }

  async poll(): Promise<void> {
    const { store, scm } = this.deps;
    const byRepo = new Map<string, RunRecord[]>();
    for (const run of store.pullRequestRuns()) {
      byRepo.set(run.repo, [...(byRepo.get(run.repo) ?? []), run]);
    }
    for (const [repo, runs] of byRepo) {
      const statuses = await scm.pullRequestStatuses(
        repo,
        runs.map((run) => run.prNumber as number),
      );
      for (const run of runs) {
        const status = statuses.get(run.prNumber as number);
        if (!status) {
          this.control.warnOnce(
            `pr:${run.id}`,
            `${run.ticketKey}: pull request #${run.prNumber} in ${repo} could not be read.`,
          );
          continue;
        }
        try {
          await this.check(run, status);
        } catch (error) {
          this.control.warnOnce(
            `pr-check:${run.id}:${errorMessage(error)}`,
            `${run.ticketKey}: could not check pull request #${status.number}: ${errorMessage(error)}`,
          );
        }
      }
    }
  }

  private async check(run: RunRecord, status: PullRequestStatus): Promise<void> {
    if (status.state !== 'open') {
      await this.closeOut(run, status);
      return;
    }
    const busy = run.state === 'queued' || isExecuting(run.state);
    // While a run works, only `/agent stop` matters. Other feedback waits for it.
    const seenKey = busy ? `${run.id}:busy` : run.id;
    if (this.seen.get(seenKey) !== status.updatedAt) {
      const started = await this.readFeedback(run, busy);
      this.seen.set(seenKey, status.updatedAt);
      if (started) return;
    }
    if (busy) return;
    await this.checkCi(run, status);
    await this.checkIdle(run, status);
  }

  // -------------------------------------------------------------------------
  // F2: merged, closed and idle pull requests

  private async closeOut(run: RunRecord, status: PullRequestStatus): Promise<void> {
    const { store, tracker, config, sandboxes, agent } = this.deps;
    const key = run.ticketKey;
    const merged = status.state === 'merged';
    if (run.state === 'queued' || isExecuting(run.state)) {
      // Nothing can be added to a closed pull request. It is closed out once stopped.
      await this.control.stop(
        run,
        merged ? 'The pull request was merged.' : 'The pull request was closed.',
      );
      return;
    }
    if (run.sandboxId) {
      try {
        await sandboxes.deleteSandbox(run.sandboxId);
      } catch (error) {
        this.control.warnOnce(
          `delete:${run.sandboxId}`,
          `${key}: could not delete sandbox ${run.sandboxId}: ${errorMessage(error)}`,
        );
        return;
      }
    }
    const now = new Date(this.now());
    store.updateRun(
      run.id,
      {
        prState: status.state,
        sandboxId: null,
        ...(run.state === 'in_review' ? { state: 'done', finishedAt: now.toISOString() } : {}),
      },
      now,
    );
    store.appendEvent(run.id, 'pr_closed', { merged, sandboxId: run.sandboxId }, now);
    this.log.step(
      `${key}: pull request #${status.number} was ${merged ? 'merged' : 'closed'}.${run.sandboxId ? ' Its sandbox was deleted.' : ''}`,
    );
    try {
      const ticket = this.snapshotFor(run);
      if (run.statusCommentId && ticket) {
        const ctx: RunContext = {
          ticket,
          runId: run.id,
          agentName: agent.displayName,
          limits: { costUsd: config.limits.cost_usd, minutes: config.limits.minutes },
        };
        await tracker.updateComment(
          key,
          run.statusCommentId,
          closedOutDoc(ctx, this.outcomeFor(run), { merged, url: run.prUrl ?? '' }),
        );
      }
      await tracker.updateLabels(key, { remove: [config.jira.labels.in_review] });
      const transition = config.jira.transitions.merged;
      if (merged && transition && !(await tracker.transition(key, transition))) {
        this.log.warn(`${key}: no "${transition}" transition is available.`);
      }
    } catch (error) {
      this.log.warn(`${key}: could not close out the ticket: ${errorMessage(error)}`);
    }
  }

  private async checkIdle(run: RunRecord, status: PullRequestStatus): Promise<void> {
    const { store, sandboxes, config } = this.deps;
    if (!run.sandboxId || run.state !== 'in_review') return;
    const lastActivity = Math.max(Date.parse(run.updatedAt), Date.parse(status.updatedAt) || 0);
    if (this.now() - lastActivity < config.sandbox.idle_days * DAY) return;
    try {
      await sandboxes.deleteSandbox(run.sandboxId);
    } catch (error) {
      this.control.warnOnce(
        `delete:${run.sandboxId}`,
        `${run.ticketKey}: could not delete sandbox ${run.sandboxId}: ${errorMessage(error)}`,
      );
      return;
    }
    const now = new Date(this.now());
    store.updateRun(run.id, { sandboxId: null }, now);
    store.appendEvent(
      run.id,
      'sandbox_idle',
      { sandboxId: run.sandboxId, idleDays: config.sandbox.idle_days },
      now,
    );
    this.log.step(
      `${run.ticketKey}: deleted the paused sandbox of pull request #${status.number} after ${config.sandbox.idle_days} days without activity. A follow-up would start a fresh one from the branch.`,
    );
  }

  /** The ticket as the pull request's first run captured it. */
  private snapshotFor(run: RunRecord): TicketSnapshot | undefined {
    const { store } = this.deps;
    let current: RunRecord | undefined = run;
    for (let depth = 0; current && depth < 50; depth++) {
      const snapshot = store.latestEvent<TicketSnapshot>(current.id, 'snapshot');
      if (snapshot) return snapshot;
      current = current.parentRunId ? store.getRun(current.parentRunId) : undefined;
    }
    return undefined;
  }

  private outcomeFor(run: RunRecord): Outcome | undefined {
    const { store } = this.deps;
    for (const other of store.listRuns({ ticketKey: run.ticketKey, limit: 50 })) {
      const outcome = store.latestEvent<Outcome>(other.id, 'outcome');
      if (outcome) return outcome;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // F1: review feedback

  /** Act on new feedback. True when it started a follow-up. */
  private async readFeedback(run: RunRecord, busy: boolean): Promise<boolean> {
    const { store, scm, config } = this.deps;
    const key = run.ticketKey;
    const repo = run.repo;
    const number = run.prNumber as number;
    const cursor = parseCursor(run.prSeen) ?? { at: run.finishedAt ?? run.updatedAt, ids: [] };
    const fresh = (await scm.pullRequestFeedback(repo, number, cursor.at)).filter(
      (item) => !cursor.ids.includes(item.id),
    );
    if (fresh.length === 0) return false;
    const people = fresh.filter((item) => !item.author.bot);
    const settings = projectSettings(config, projectOf(key), repo);
    const changesRequested = settings?.review.changesRequested ?? config.review.changes_requested;

    const requests: PullRequestFeedback[] = [];
    let stop: PullRequestFeedback | undefined;
    for (const item of people) {
      const command = parsePullRequestCommand(item.body);
      const changes =
        item.kind === 'review' && item.reviewState === 'changes_requested' && changesRequested;
      if (!command && !changes) continue;
      if (!canWrite(await this.permission(repo, item.author.login))) {
        this.log.warn(
          `${key}: ignored ${describe(item)} from ${item.author.login}, who has no write access to ${repo}.`,
        );
        continue;
      }
      if (command?.kind === 'stop') stop = item;
      else requests.push(item);
    }

    if (busy) {
      if (stop && !this.stopsSeen.has(stop.id)) {
        this.stopsSeen.add(stop.id);
        await this.control.stop(
          run,
          `${stop.author.login} stopped the run with /agent stop on the pull request.`,
        );
      }
      return false;
    }

    const next = advanceCursor(cursor, fresh);
    const keepCursor = () =>
      store.updateRun(run.id, { prSeen: JSON.stringify(next) }, new Date(this.now()));
    if (requests.length === 0) {
      keepCursor();
      return false;
    }
    const rounds = settings?.review.rounds ?? config.review.rounds;
    if (!config.review.enabled || rounds === 0) {
      this.log.info(`${key}: review follow-ups are turned off, so the feedback is left to people.`);
      keepCursor();
      return false;
    }
    const used = store.countFollowUps(key, number, 'review');
    if (used >= rounds) {
      await scm.commentOnPullRequest(
        repo,
        number,
        docToMarkdown(roundsUsedDoc({ kind: 'review', rounds })),
      );
      this.log.warn(
        `${key}: new feedback on pull request #${number}, but all ${rounds} follow-up rounds are used.`,
      );
      keepCursor();
      return false;
    }
    const first = requests[0] as PullRequestFeedback;
    const trigger: TriggerInfo = {
      source: 'review',
      at: first.createdAt,
      eventId: first.id,
      by: { accountId: `github:${first.author.login}`, displayName: first.author.login },
    };
    const feedback: FollowUpFeedback = { kind: 'review', items: toFeedbackItems(requests, people) };
    const created = await this.startFollowUp(run, feedback, next, trigger);
    if (!created) return false;
    for (const item of requests) await scm.acknowledge(repo, item);
    const authors = [...new Set(requests.map((item) => item.author.login))].join(', ');
    this.log.step(
      `${key}: ${authors} asked for changes on pull request #${number}. Starting follow-up ${used + 1} of ${rounds}.`,
    );
    return true;
  }

  private async permission(repo: string, login: string): Promise<RepoPermission> {
    const cacheKey = `${repo}:${login}`;
    const cached = this.permissions.get(cacheKey);
    if (cached && this.now() - cached.at < PERMISSION_TTL_MS) return cached.permission;
    const permission = await this.deps.scm.repositoryPermission(repo, login);
    this.permissions.set(cacheKey, { permission, at: this.now() });
    return permission;
  }

  /**
   * Create the follow-up run. It takes over the paused sandbox and the agent session
   * when the run before it parked them, and the ticket's status comment either way.
   */
  private async startFollowUp(
    previous: RunRecord,
    feedback: FollowUpFeedback,
    cursor: FeedbackCursor,
    trigger: TriggerInfo,
  ): Promise<RunRecord | undefined> {
    const { store, agent, sandboxes } = this.deps;
    const now = new Date(this.now());
    const parked = previous.state === 'in_review';
    const takeOver = parked && previous.sandboxId !== null && previous.agent === agent.id;
    const input: NewRun = {
      ticketKey: previous.ticketKey,
      tracker: previous.tracker,
      repo: previous.repo,
      baseBranch: previous.baseBranch,
      workflow: previous.workflow,
      agent: agent.id,
      triggeredBy: `github:${trigger.by?.displayName ?? 'ci'}`,
      triggerInfo: JSON.stringify(trigger),
      state: 'queued',
      kind: feedback.kind,
      parentRunId: previous.id,
      prNumber: previous.prNumber,
      prUrl: previous.prUrl,
      prState: 'open',
      prSeen: JSON.stringify(cursor),
      ...(previous.branch ? { branch: previous.branch } : {}),
      ...(previous.statusCommentId ? { statusCommentId: previous.statusCommentId } : {}),
      ...(previous.commentsSeen ? { commentsSeen: previous.commentsSeen } : {}),
      ...(takeOver ? { sandboxId: previous.sandboxId, sessionId: previous.sessionId } : {}),
    };
    try {
      const run = parked
        ? store.supersede(
            previous.id,
            { state: 'done', finishedAt: now.toISOString(), sandboxId: null },
            input,
            now,
          )
        : store.createRun(input, now);
      store.appendEvent(run.id, 'trigger', trigger, now);
      store.appendEvent(run.id, 'feedback', feedback, now);
      if (parked) store.appendEvent(previous.id, 'superseded', { by: run.id }, now);
      // A sandbox the follow-up cannot use, as after a change of agent, goes now.
      if (parked && previous.sandboxId && !takeOver) {
        await sandboxes.deleteSandbox(previous.sandboxId).catch(() => false);
      }
      return run;
    } catch (error) {
      if (error instanceof AlreadyActiveError) return undefined;
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // CI fix rounds

  private async checkCi(run: RunRecord, status: PullRequestStatus): Promise<void> {
    const { config, store, scm } = this.deps;
    const sha = status.headSha;
    if (config.ci.fix_rounds === 0 || run.state !== 'in_review') return;
    if (!run.headSha || sha !== run.headSha || this.ciDone.has(sha)) return;
    // Only Lockkeeper's own commit: CI on a commit someone else pushed is theirs.
    if (store.latestEvent<{ sha: string }>(run.id, 'commit')?.sha !== sha) {
      this.ciDone.add(sha);
      return;
    }
    if (this.now() - (this.ciChecked.get(sha) ?? 0) < CI_POLL_MS) return;
    this.ciChecked.set(sha, this.now());
    const checks = await scm.checkStatus(run.repo, sha);
    if (checks.state === 'pending') return;
    if (checks.state === 'none') {
      if (this.now() - Date.parse(run.updatedAt) > CI_GRACE_MS) this.ciDone.add(sha);
      return;
    }
    this.ciDone.add(sha);
    if (checks.state === 'success') return;

    const key = run.ticketKey;
    const number = run.prNumber as number;
    // A check that also fails on the base branch is not this pull request's doing.
    const base = await scm.resolveBase(run.repo, run.baseBranch);
    const onBase = await scm.checkStatus(run.repo, base.sha);
    const failing = checks.failures.filter(
      (failure) => !onBase.failures.some((other) => other.name === failure.name),
    );
    if (failing.length === 0) {
      this.log.info(
        `${key}: CI failed on pull request #${number}, but the same checks fail on ${run.baseBranch}, so there is no CI fix round.`,
      );
      return;
    }
    const eventId = `ci:${sha}`;
    const handled = store
      .listRuns({ ticketKey: key, limit: 50 })
      .some((other) => parseTriggerInfo(other.triggerInfo)?.eventId === eventId);
    if (handled) return;
    const rounds = config.ci.fix_rounds;
    const used = store.countFollowUps(key, number, 'ci');
    if (used >= rounds) {
      if (store.latestEvent<{ sha: string }>(run.id, 'ci_limit')?.sha !== sha) {
        await scm.commentOnPullRequest(
          run.repo,
          number,
          docToMarkdown(roundsUsedDoc({ kind: 'ci', rounds })),
        );
        store.appendEvent(run.id, 'ci_limit', { sha }, new Date(this.now()));
      }
      return;
    }
    const names = new Set(failing.map((failure) => failure.name));
    const detailed = await scm.checkStatus(run.repo, sha, { details: true });
    const failed = detailed.failures
      .filter((failure) => names.has(failure.name))
      .map((failure) => ({
        name: failure.name,
        conclusion: failure.conclusion,
        ...(failure.url ? { url: failure.url } : {}),
        details: cleanCiText(failure.details ?? ''),
      }));
    const trigger: TriggerInfo = {
      source: 'ci',
      at: new Date(this.now()).toISOString(),
      eventId,
      by: { accountId: 'github:ci', displayName: 'CI' },
    };
    const cursor = parseCursor(run.prSeen) ?? { at: run.finishedAt ?? run.updatedAt, ids: [] };
    const created = await this.startFollowUp(
      run,
      { kind: 'ci', sha, checks: failed },
      cursor,
      trigger,
    );
    if (created) {
      this.log.step(
        `${key}: CI failed on pull request #${number} (${[...names].join(', ')}). Starting CI fix ${used + 1} of ${rounds}.`,
      );
    }
  }
}
