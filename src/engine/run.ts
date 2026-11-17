import { randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { AgentAdapter, AgentEvent, KeyPlacement } from '../agent/agent.js';
import {
  type Config,
  type ProjectSettings,
  projectSettings,
  resolveRepo,
} from '../config/schema.js';
import { branchName, titleFor, type WorkflowName, workflowFor } from '../core/branch.js';
import { docToMarkdown, docToPlainText } from '../core/doc.js';
import {
  AlreadyActiveError,
  CapExceededError,
  ConfigError,
  LockkeeperError,
  RunCancelledError,
  RunRefusedError,
  StepFailedError,
} from '../core/errors.js';
import { type Logger, silentLogger } from '../core/log.js';
import { checkContents, checkDiff, type PolicyResult } from '../policy/diff-policy.js';
import { redactSecrets } from '../policy/secrets.js';
import {
  type SandboxHandle,
  type SandboxProvider,
  type SecretBinding,
  shellQuote,
} from '../sandbox/sandbox.js';
import type { BaseRef, CommitResult, PullRequest, SourceControl } from '../scm/scm.js';
import {
  isExecuting,
  isFollowUp,
  type RunRecord,
  type RunState,
  type Store,
} from '../store/store.js';
import { RecordingTracker } from '../tracker/recording-tracker.js';
import type { TicketSnapshot, Tracker } from '../tracker/tracker.js';
import { detectCommands } from './detect.js';
import { allowList, GITHUB_DOMAINS, hostsOutside } from './domains.js';
import { type ResolvedCommands, resolveCommands } from './environment.js';
import {
  changedPaths,
  checkoutTestsOnBase,
  type FailingTestProof,
  isTestPath,
  restoreTree,
  saveTree,
  testCommands,
} from './failing-test.js';
import {
  type AgentReport,
  buildFixPrompt,
  buildFollowUpPrompt,
  buildReadinessPrompt,
  buildReadinessSystemPrompt,
  buildSystemPrompt,
  buildTaskPrompt,
  type FollowUpFeedback,
  type InstructionFile,
  matchCriteria,
  parseAgentReport,
  parseReadiness,
  type Readiness,
  stripReport,
} from './prompts.js';
import {
  capPullRequestBody,
  cleanAgentText,
  declinedDoc,
  type FollowUpReply,
  failedDoc,
  finalNoticeDoc,
  followUpFailedDoc,
  followUpNoChangesDoc,
  followUpReplyDoc,
  noChangesDoc,
  type Outcome,
  pickedUpDoc,
  progressDoc,
  pullRequestBodyDoc,
  questionsDoc,
  type RunContext,
  refusedDoc,
  resultDoc,
  waitingDoc,
} from './report.js';
import {
  agentFiles,
  agentStarted,
  type CheckResult,
  type CollectedChanges,
  cloneRepo,
  collectChanges,
  inspectRoot,
  type Layout,
  layoutFor,
  mergeBase,
  newFailures,
  readInstructionFiles,
  resetCheckout,
  runCommands,
  type StopRequest,
  stagedDiff,
  startAgent,
  tail,
  updateCheckout,
  watchAgent,
} from './workspace.js';

/**
 * How the agent's model key reaches the model API.
 * - `egress`: stored as a provider secret and added by the egress proxy. The sandbox
 *   only ever holds a placeholder (E3). The default.
 * - `env`: passed to the agent process's environment. The fallback for providers or
 *   accounts without secret injection, with a warning.
 */
export type ModelKey = { mode: 'egress'; secretName: string } | { mode: 'env'; value: string };

export interface RunDeps {
  config: Config;
  tracker: Tracker;
  scm: SourceControl;
  sandboxes: SandboxProvider;
  agent: AgentAdapter;
  store: Store;
  modelKey: ModelKey;
  log?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How often the agent's event file is polled. */
  pollMs?: number;
}

export interface RunRequest {
  ticketKey: string;
  /** Who started the run, for the audit log: `cli:<user>` or a Jira account. */
  triggeredBy: string;
  /** Run everything, but write nothing to Jira or GitHub. */
  dryRun?: boolean;
  /** Stop the run and report it as stopped. A string reason is shown on the ticket. */
  signal?: AbortSignal;
  /** Stop working but keep the run, so it resumes when Lockkeeper starts again. */
  detach?: AbortSignal;
}

export interface DryRunPreview {
  branch: string;
  title: string;
  body: string;
  comments: string[];
  /** Label changes, links and transitions, one line each. */
  trackerChanges: string[];
  files: { path: string; status: string; added: number | null; removed: number | null }[];
  draftReasons: string[];
  /** The change as a unified diff, read back from the sandbox: untrusted, capped. */
  diff: string;
}

export type RunResult =
  | { outcome: 'pr'; run: RunRecord; pr: PullRequest; draftReasons: string[] }
  | { outcome: 'no_changes'; run: RunRecord }
  | { outcome: 'refused'; run: RunRecord; reason: string }
  | { outcome: 'failed'; run: RunRecord; error: Error }
  | { outcome: 'dry_run'; run: RunRecord; preview: DryRunPreview }
  | { outcome: 'detached'; run: RunRecord }
  | { outcome: 'needs_info'; run: RunRecord; questions: string[] }
  | { outcome: 'declined'; run: RunRecord; reason: string };

const PLACEHOLDER_KEY = 'lockkeeper-key-added-by-egress-proxy';
const MAX_SANDBOX_MS = 60 * 60_000;
const MIN_FIX_ROUND_USD = 0.5;
const MIN_FIX_ROUND_MS = 3 * 60_000;

/** How long a process's claim on a run lasts without renewal. */
export const LEASE_MS = 90_000;

/** This process, as the owner of the runs it works on. */
export const PROCESS_OWNER = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;

/** States in which the sandbox already holds the cloned and set-up repository. */
const PREPARED: ReadonlySet<RunState> = new Set([
  'implement',
  'verify',
  'collect',
  'publish',
  'report',
]);
/** States in which the agent's work is finished and saved as an `implemented` event. */
const IMPLEMENTED: ReadonlySet<RunState> = new Set(['collect', 'publish', 'report']);

/** Thrown inside a run to stop without reporting, leaving it for a later process. */
class RunDetachedError extends Error {}

/** How a run was started, kept as JSON on the run (O2: who triggered it). */
export interface TriggerInfo {
  source: 'label' | 'cli' | 'retry' | 'answers' | 'review' | 'ci';
  by?: { accountId: string; displayName: string };
  label?: string;
  /** The label change that started the run, so it is never acted on twice. */
  eventId?: string;
  at?: string;
}

export function parseTriggerInfo(value: string | null | undefined): TriggerInfo | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as TriggerInfo;
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

interface PromptRecord {
  round: number;
  system?: string;
  prompt: string;
}

/** What the agent rounds produced, saved so a restarted run can publish it. */
interface Work {
  finalText: string;
  report?: AgentReport;
  checks: CheckResult[];
  draftReasons: string[];
  /** Bug fixes: whether the new tests fail without the fix (E5). */
  proof?: FailingTestProof;
  /** Hosts outside the allow-list that the agent's commands named (O2). */
  outsideHosts?: string[];
}

function normalizeKey(input: string): string {
  const key = input.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) throw new ConfigError(`Not a Jira issue key: ${input}`);
  return key;
}

function settingsFor(config: Config, key: string): ProjectSettings {
  const projectKey = key.slice(0, key.lastIndexOf('-'));
  const settings = projectSettings(config, projectKey);
  if (!settings) {
    throw new RunRefusedError(
      `Project ${projectKey} is not configured.`,
      `Add it under projects: in lockkeeper.yml.`,
    );
  }
  return settings;
}

const leaseEnd = (now: number) => new Date(now + LEASE_MS);

function activeHint(run: RunRecord): string {
  switch (run.state) {
    case 'needs_info':
      return `It is waiting for answers on the ticket. Reply \`/agent go\` there, run \`lockkeeper run ${run.ticketKey}\` once the ticket has them, or run \`lockkeeper cancel ${run.ticketKey}\`.`;
    case 'in_review':
      return `Its pull request is in review. Run \`lockkeeper cancel ${run.ticketKey}\` to release the ticket.`;
    case 'queued':
      return 'It is waiting for a free run slot.';
    default:
      return 'Another Lockkeeper process is working on it.';
  }
}

function cancelReason(signal: AbortSignal | undefined): string {
  return typeof signal?.reason === 'string' && signal.reason
    ? signal.reason
    : 'The run was stopped.';
}

/**
 * Turn a ticket into a pull request. If the ticket's run was cut short by a crash or a
 * restart, this picks it up where it stopped instead of starting a second one (T6).
 */
export async function runTicket(deps: RunDeps, request: RunRequest): Promise<RunResult> {
  const key = normalizeKey(request.ticketKey);
  const settings = settingsFor(deps.config, key);
  const nowMs = (deps.now ?? Date.now)();
  const now = new Date(nowMs);
  const active = deps.store.activeRunFor(key);
  if (active?.state === 'needs_info' && !request.dryRun) {
    deps.store.appendEvent(active.id, 'answers', { by: request.triggeredBy, text: '' }, now);
    deps.store.updateRun(active.id, { state: 'queued', startedAt: null }, now);
    if (deps.store.acquireLease(active.id, PROCESS_OWNER, leaseEnd(nowMs), now)) {
      const requeued = deps.store.getRun(active.id) as RunRecord;
      return new TicketRun(deps, { ...request, ticketKey: key }, requeued, settings).execute();
    }
  }
  if (active) {
    const orphaned =
      isExecuting(active.state) &&
      deps.store.acquireLease(active.id, PROCESS_OWNER, leaseEnd(nowMs), now);
    if (!orphaned) throw new AlreadyActiveError(key, active.id, activeHint(active));
    if (!active.dryRun) {
      if (!request.dryRun) {
        return new TicketRun(deps, { ...request, ticketKey: key }, active, settings).execute();
      }
      deps.store.releaseLease(active.id, PROCESS_OWNER);
      throw new AlreadyActiveError(
        key,
        active.id,
        'Its process stopped. Run the same command without --dry-run to continue it.',
      );
    }
    // A dry run keeps its writes in memory, so it cannot resume. Close it and start over.
    deps.store.updateRun(
      active.id,
      {
        state: 'failed',
        error: 'The dry run was interrupted.',
        finishedAt: now.toISOString(),
        owner: null,
        leaseUntil: null,
      },
      now,
    );
  }
  const limits = deps.config.limits;
  const executing = deps.store.countExecutingRuns();
  if (executing >= limits.parallel_runs) {
    throw new CapExceededError(
      'parallel_runs',
      `${executing} runs are already active, the limit for this install (limits.parallel_runs).`,
    );
  }
  if (!request.dryRun) {
    const today = deps.store.countStartedSince(new Date(nowMs - 24 * 60 * 60_000));
    if (today >= limits.runs_per_day) {
      throw new CapExceededError(
        'runs_per_day',
        `${today} runs started in the last 24 hours, the daily limit for this install (limits.runs_per_day).`,
      );
    }
    const open = deps.store.countOpenPullRequests(settings.repo);
    if (open >= limits.open_prs_per_repo) {
      throw new CapExceededError(
        'open_prs_per_repo',
        `${open} Lockkeeper pull ${open === 1 ? 'request is' : 'requests are'} open in ${settings.repo}, the limit (limits.open_prs_per_repo). Merge or close one first.`,
      );
    }
  }
  // T6: claiming the ticket is the first write, and it fails if a run is active.
  const run = deps.store.createRun(
    {
      ticketKey: key,
      tracker: deps.tracker.kind,
      repo: settings.repo,
      baseBranch: settings.baseBranch,
      workflow: 'feature',
      agent: deps.agent.id,
      triggeredBy: request.triggeredBy,
      state: 'snapshot',
      owner: PROCESS_OWNER,
      leaseUntil: leaseEnd(nowMs).toISOString(),
      dryRun: request.dryRun ?? false,
    },
    now,
  );
  return new TicketRun(deps, { ...request, ticketKey: key }, run, settings).execute();
}

/**
 * Continue a run whose process stopped, as after a restart. Returns undefined when the
 * run is not executing or another process holds it.
 */
export async function resumeRun(
  deps: RunDeps,
  runId: string,
  options: Pick<RunRequest, 'signal' | 'detach'> = {},
): Promise<RunResult | undefined> {
  const nowMs = (deps.now ?? Date.now)();
  const now = new Date(nowMs);
  const run = deps.store.getRun(runId);
  if (!run || !(isExecuting(run.state) || run.state === 'queued')) return undefined;
  if (!deps.store.acquireLease(run.id, PROCESS_OWNER, leaseEnd(nowMs), now)) return undefined;
  let settings: ProjectSettings;
  try {
    if (run.dryRun) throw new LockkeeperError('The dry run was interrupted.');
    settings = settingsFor(deps.config, run.ticketKey);
  } catch (error) {
    const updated = deps.store.updateRun(
      run.id,
      {
        state: 'failed',
        error: (error as Error).message,
        finishedAt: now.toISOString(),
        owner: null,
        leaseUntil: null,
      },
      now,
    );
    return { outcome: 'failed', run: updated, error: error as Error };
  }
  const request: RunRequest = {
    ticketKey: run.ticketKey,
    triggeredBy: run.triggeredBy ?? 'unknown',
    ...options,
  };
  return new TicketRun(deps, request, run, settings).execute();
}

class TicketRun {
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly tracker: Tracker;
  private readonly startedAt: number;
  private readonly deadline: number;
  private ticket: TicketSnapshot | undefined;
  private sandbox: SandboxHandle | undefined;
  private layout: Layout | undefined;
  private base: BaseRef | undefined;
  /** The base branch head; for a retry on a PR branch it differs from `base`. */
  private branchBase: BaseRef | undefined;
  private verify: string[] = [];
  private instructions: InstructionFile[] = [];
  private statusCommentId: string | undefined;
  private costUsd: number | undefined;
  private turns: number | undefined;
  private fixRounds: number;
  /** What earlier agent sessions of this run cost, such as the readiness check. */
  private priorCostUsd: number;
  private leaseLost = false;
  /** Review and CI follow-ups add to an open pull request (F1). */
  private readonly followUp: boolean;
  /** The paused sandbox a follow-up took over from the run before it, to resume. */
  private inheritedSandbox: string | undefined;
  /** Round 0 continues the earlier run's agent session instead of starting one. */
  private resumeSession = false;
  /** What the resumed session had cost before this run. The agent's total includes it. */
  private sessionBaseCostUsd = 0;

  constructor(
    private readonly deps: RunDeps,
    private readonly request: RunRequest,
    private run: RunRecord,
    private settings: ProjectSettings,
  ) {
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? Date.now;
    this.tracker = request.dryRun ? new RecordingTracker(deps.tracker) : deps.tracker;
    this.statusCommentId = run.statusCommentId ?? undefined;
    this.costUsd = run.costUsd ?? undefined;
    this.turns = run.turns ?? undefined;
    this.fixRounds = run.fixRounds ?? 0;
    this.priorCostUsd = deps.store
      .events(run.id, { kind: 'readiness' })
      .reduce((sum, event) => sum + ((event.data as { costUsd?: number }).costUsd ?? 0), 0);
    // The time limit counts from the run's first start, including any time it was stopped.
    this.startedAt = run.startedAt ? Date.parse(run.startedAt) : this.now();
    this.deadline = this.startedAt + deps.config.limits.minutes * 60_000;
    this.followUp = isFollowUp(run.kind);
    const session = deps.store.latestEvent<{ resumed?: boolean; baseCostUsd?: number }>(
      run.id,
      'session',
    );
    if (session?.resumed) {
      this.resumeSession = true;
      this.sessionBaseCostUsd = session.baseCostUsd ?? 0;
    }
  }

  async execute(): Promise<RunResult> {
    const renew = setInterval(() => this.renewLease(), LEASE_MS / 3);
    renew.unref?.();
    const onCancel = () => void this.interrupt();
    this.request.signal?.addEventListener('abort', onCancel, { once: true });
    try {
      if (!this.run.startedAt) this.update({ startedAt: new Date(this.startedAt).toISOString() });
      return await this.steps();
    } catch (error) {
      // After a shutdown request, whatever broke is part of shutting down: keep the run.
      const detaching =
        error instanceof RunDetachedError ||
        this.request.detach?.aborted === true ||
        this.leaseLost;
      if (detaching && !this.request.signal?.aborted) return await this.detached();
      return await this.fail(error);
    } finally {
      clearInterval(renew);
      this.request.signal?.removeEventListener('abort', onCancel);
      this.deps.store.releaseLease(this.run.id, PROCESS_OWNER);
    }
  }

  // -------------------------------------------------------------------------
  // The phases. Each one checks what an earlier process already did, so a run
  // resumed after a restart continues instead of repeating published work.

  private async steps(): Promise<RunResult> {
    if (this.run.state === 'queued' || this.run.state === 'snapshot') {
      const early = this.followUp ? await this.beginFollowUp() : await this.begin();
      if (early) return early;
    } else {
      this.restore();
    }
    const early = await this.prepare();
    if (early) return early;
    const work = await this.implementAndVerify();
    if ('outcome' in work) return work;
    return await this.collectAndPublish(work);
  }

  /** Snapshot the ticket (T4), apply the refusal rules (T3, T5) and say so on the ticket. */
  private async begin(): Promise<RunResult | undefined> {
    const { config } = this.deps;
    const key = this.run.ticketKey;
    this.setState('snapshot');
    this.log.step(`Reading ${key}`);
    const ticket = await this.tracker.snapshot(key);
    this.ticket = ticket;
    this.audit('snapshot', ticket);

    const project = config.projects[this.settings.key];
    const repoChoice = project ? resolveRepo(project, ticket) : { repo: this.settings.repo };
    if ('ambiguous' in repoChoice) {
      return this.refuse(
        `The ticket's components and labels point at more than one repository (${repoChoice.ambiguous.join(', ')}).`,
        'Remove the components or labels that do not apply, then label the ticket again.',
      );
    }
    this.settings = projectSettings(config, this.settings.key, repoChoice.repo) ?? this.settings;
    const workflow: WorkflowName = workflowFor(ticket.issueType, ticket.labels);
    this.update({ repo: this.settings.repo, workflow });

    // T3: tickets that external (customer) accounts wrote into are refused by default.
    if (ticket.externalAuthors.length > 0 && !this.settings.allowExternal) {
      return this.refuse(
        'This ticket has text from external (customer) accounts, so Lockkeeper will not hand it to an agent.',
        `To accept such tickets in ${this.settings.key}, set allow_external: true for the project in lockkeeper.yml.`,
      );
    }

    const ctx = this.context();
    if (this.statusCommentId) {
      await this.tracker.updateComment(key, this.statusCommentId, pickedUpDoc(ctx));
    } else {
      this.statusCommentId = await this.tracker.postComment(key, pickedUpDoc(ctx));
      this.update({ statusCommentId: this.statusCommentId });
    }
    // A retry also clears what the earlier run left, such as agent-in-review.
    const labels = config.jira.labels;
    await this.tracker.updateLabels(key, {
      add: [labels.working],
      remove: [labels.trigger, labels.in_review, labels.failed, labels.needs_info],
    });
    this.checkCancelled();
    return undefined;
  }

  /**
   * F1: a follow-up works from the ticket as its first run saw it, and says nothing new
   * in Jira beyond updating the status comment. Its replies go on the pull request.
   */
  private async beginFollowUp(): Promise<RunResult | undefined> {
    const key = this.run.ticketKey;
    this.inheritedSandbox = this.run.sandboxId ?? undefined;
    this.setState('snapshot');
    const parent = this.run.parentRunId;
    const saved = parent
      ? this.deps.store.latestEvent<TicketSnapshot>(parent, 'snapshot')
      : undefined;
    this.log.step(
      `${this.replyInfo().kind === 'ci' ? 'Fixing failed CI checks' : 'Answering review feedback'} on pull request #${this.run.prNumber}`,
    );
    this.ticket = saved ?? (await this.tracker.snapshot(key));
    this.audit('snapshot', this.ticket);
    this.settings =
      projectSettings(this.deps.config, this.settings.key, this.run.repo) ?? this.settings;
    await this.progress(this.context(), this.followUpStep());
    this.checkCancelled();
    return undefined;
  }

  private feedback(): FollowUpFeedback | undefined {
    return this.deps.store.latestEvent<FollowUpFeedback>(this.run.id, 'feedback');
  }

  /** What a follow-up answers, whose it is and which round, for its replies. */
  private replyInfo(): FollowUpReply {
    const feedback = this.feedback();
    const kind = feedback?.kind ?? (this.run.kind === 'ci' ? 'ci' : 'review');
    const rounds = kind === 'ci' ? this.deps.config.ci.fix_rounds : this.settings.review.rounds;
    const round =
      this.run.prNumber === null
        ? 1
        : this.deps.store.countFollowUps(this.run.ticketKey, this.run.prNumber, kind);
    const authors =
      feedback?.kind === 'review' ? [...new Set(feedback.items.map((item) => item.author))] : [];
    const checks = feedback?.kind === 'ci' ? feedback.checks.map((check) => check.name) : [];
    return { kind, round, rounds, authors, ...(checks.length > 0 ? { checks } : {}) };
  }

  private followUpStep(): string {
    const reply = this.replyInfo();
    return reply.kind === 'ci'
      ? `CI fix ${reply.round} of ${reply.rounds}: the agent is fixing the failed CI checks`
      : `follow-up ${reply.round} of ${reply.rounds}: the agent is working on review feedback`;
  }

  /** Load what an earlier process captured, for a run resumed after the snapshot. */
  private restore(): void {
    const ticket = this.deps.store.latestEvent<TicketSnapshot>(this.run.id, 'snapshot');
    if (!ticket) {
      throw new StepFailedError(this.run.state, 'The run has no ticket snapshot to resume from.');
    }
    this.ticket = ticket;
    this.settings =
      projectSettings(this.deps.config, this.settings.key, this.run.repo) ?? this.settings;
    this.log.step(`Resuming ${this.run.ticketKey} in the ${this.run.state} step`);
    this.audit('resumed', { state: this.run.state, round: this.run.round });
  }

  /** Sandbox (E1, E2, E3), clone and setup (E6), or reconnect to a prepared sandbox. */
  private async prepare(): Promise<RunResult | undefined> {
    const { config, scm, sandboxes, agent } = this.deps;
    const key = this.run.ticketKey;
    if (this.run.sandboxId && this.run.baseSha && PREPARED.has(this.run.state)) {
      await this.reconnect(this.run.sandboxId, this.run.baseSha);
      return;
    }
    if (this.inheritedSandbox) {
      const inherited = this.inheritedSandbox;
      this.inheritedSandbox = undefined;
      if (await this.resumeFollowUp(inherited)) return;
    }
    // A sandbox from a run cut short while preparing is not trusted: start a new one.
    if (this.run.sandboxId) await this.discardSandbox(this.run.sandboxId);
    // Without the earlier sandbox there is no session to continue: start a new one.
    if (this.followUp && this.run.sessionId) this.update({ sessionId: null });

    this.setState('sandbox');
    const { base, instructionsBase } = await this.startPoint();
    this.base = base;
    this.update({ baseSha: base.sha });
    this.branchBase = instructionsBase;
    this.audit('start_point', { base, instructionsBase });
    if (this.followUp && !this.continuing) {
      throw new StepFailedError(
        'sandbox',
        `The pull request's branch no longer exists, so there is nothing to add to.`,
      );
    }
    const secrets = this.secretBindings();
    if (this.deps.modelKey.mode === 'env') {
      this.log.warn(
        'The model key is passed into the sandbox environment. Run `lockkeeper secrets sync` to have E2B add it outside the sandbox instead.',
      );
    }
    const allowDomains = this.allowDomains();
    this.log.step(`Starting a sandbox on ${sandboxes.displayName}`);
    // A new key per attempt: a retry after a crash reuses the sandbox the crash left
    // unrecorded, and an attempt after a discarded sandbox gets a fresh one.
    const attempt = this.deps.store.events(this.run.id, { kind: 'sandbox' }).length + 1;
    const spec = {
      timeoutMs: this.sandboxTimeout(),
      metadata: {
        lockkeeper_run: this.run.id,
        ticket: key,
        repo: this.settings.repo,
        base: base.sha,
      },
      allowDomains,
      secrets,
      idempotencyKey: `lockkeeper-${this.run.id}-${attempt}`,
      ...(config.sandbox.template ? { template: config.sandbox.template } : {}),
    };
    const sandbox = await sandboxes.create(spec);
    this.sandbox = sandbox;
    const layout = layoutFor(sandbox.homeDir);
    this.layout = layout;
    this.update({ sandboxId: sandbox.id });
    this.audit('sandbox', {
      id: sandbox.id,
      provider: sandboxes.kind,
      allowDomains,
      modelKey: this.deps.modelKey.mode,
      capabilities: sandboxes.capabilities,
    });

    if (config.agent.version) {
      this.log.step(`Installing ${agent.displayName} ${config.agent.version}`);
      const install = await sandbox.exec(agent.installCommand(config.agent.version), {
        asRoot: true,
        timeoutMs: 5 * 60_000,
      });
      if (install.exitCode !== 0) {
        throw new StepFailedError(
          'setup',
          `Installing ${agent.displayName} ${config.agent.version} failed.`,
          tail(install.stdout + install.stderr),
        );
      }
    }
    const version = await sandbox.exec(agent.versionCommand(), { timeoutMs: 60_000 });
    this.audit('agent_version', { output: version.stdout.trim(), exitCode: version.exitCode });
    for (const requirement of agent.requirements(this.keyPlacement())) {
      const check = await sandbox.exec(requirement.check, { timeoutMs: 30_000 });
      if (check.exitCode !== 0) throw new ConfigError(requirement.problem, requirement.hint);
    }
    this.checkCancelled();

    // Clone with a read-only, single-repository, short-lived token (E3).
    this.setState('clone');
    this.log.step(`Cloning ${this.settings.repo} at ${base.sha.slice(0, 12)}`);
    const access = await scm.cloneAccess(this.settings.repo);
    await cloneRepo(
      sandbox,
      layout,
      access,
      base,
      this.stepTimeout(10 * 60_000),
      instructionsBase.sha === base.sha ? undefined : instructionsBase,
    );
    // Rule 5: instruction files come from the base branch, never from an agent's work,
    // including an earlier attempt on the branch a retry continues.
    this.instructions = await readInstructionFiles(sandbox, layout, instructionsBase.sha);
    this.audit(
      'instructions',
      this.instructions.map((file) => ({ path: file.path, bytes: file.content.length })),
    );
    this.checkCancelled();

    // R1: decide whether the ticket can be built before spending on setup and code.
    const verdict = await this.readiness();
    if (verdict) return verdict;

    // Setup (E6)
    this.setState('setup');
    let setup = this.settings.setup ?? [];
    let verify = this.settings.verify ?? [];
    let sources: ResolvedCommands['sources'] = {
      setup: 'lockkeeper.yml',
      verify: 'lockkeeper.yml',
    };
    if (this.settings.setup === undefined || this.settings.verify === undefined) {
      const root = await inspectRoot(sandbox, layout);
      const [devcontainer] = await readInstructionFiles(sandbox, layout, instructionsBase.sha, [
        '.devcontainer/devcontainer.json',
        '.devcontainer.json',
      ]);
      const resolved = resolveCommands({
        configured: { setup: this.settings.setup, verify: this.settings.verify },
        devcontainer: devcontainer?.content,
        agentsMd: this.instructions.find((file) => file.path === 'AGENTS.md')?.content,
        detected: detectCommands(root.files, root.packageJson),
      });
      ({ setup, verify, sources } = resolved);
    }
    this.verify = verify;
    // Saved, not worked out again on resume: by then the agent may have changed the files.
    this.audit('commands', { setup, verify, sources });
    if (sources.setup !== 'lockkeeper.yml' || sources.verify !== 'lockkeeper.yml') {
      this.log.info(`Commands: setup from ${sources.setup}, checks from ${sources.verify}`);
    }
    if (setup.length > 0) {
      this.log.step(`Setting up: ${setup.join(' && ')}`);
      const timeout = this.stepTimeout(config.limits.setup_minutes * 60_000);
      await this.extendSandbox(Math.min(MAX_SANDBOX_MS, timeout + 5 * 60_000));
      const results = await runCommands(sandbox, layout, setup, {
        timeoutMs: timeout,
        stopOnFailure: true,
        now: this.now,
      });
      this.audit('setup', results);
      const failed = results.find((result) => !result.passed);
      if (failed) {
        throw new StepFailedError(
          'setup',
          `Setup failed: \`${failed.command}\` exited with code ${failed.exitCode}.`,
          failed.output,
        );
      }
    }
    await this.runBaseline();
    if (config.sandbox.close_github_after_setup && sandbox.setEgress) {
      // From here on, the agent can reach only the model API and package registries.
      const narrowed = allowDomains.filter((domain) => !GITHUB_DOMAINS.includes(domain));
      await sandbox.setEgress(narrowed, secrets);
      this.audit('egress', { allowDomains: narrowed, reason: 'GitHub closed after setup' });
      this.log.info('GitHub is closed to the sandbox for the rest of the run.');
    }
    this.checkCancelled();
  }

  /**
   * P1: run the checks on the base branch before the agent changes anything, so the
   * agent, the PR and the ticket can tell failures that were already there from new
   * ones. A check that fails either way still gets fix rounds and keeps the PR a draft:
   * one failing command can hide new failures behind old ones. Retries and follow-ups
   * start from a PR branch, whose failures are the agent's own, so they skip this.
   */
  private async runBaseline(): Promise<void> {
    const { config } = this.deps;
    if (!this.settings.baseline || this.continuing || this.verify.length === 0) return;
    const sandbox = this.sandbox as SandboxHandle;
    const layout = this.layout as Layout;
    this.log.step(`Running the checks on ${this.settings.baseBranch} first`);
    await this.progress(
      this.context(),
      `Lockkeeper is running the checks on ${this.settings.baseBranch} before any change`,
    );
    const timeout = this.stepTimeout(config.limits.verify_minutes * 60_000);
    await this.extendSandbox(Math.min(MAX_SANDBOX_MS, timeout + 5 * 60_000));
    const checks = await runCommands(sandbox, layout, this.verify, {
      timeoutMs: timeout,
      stopOnFailure: false,
      now: this.now,
    });
    const failed = checks.filter((check) => !check.passed).map((check) => check.command);
    this.audit('baseline', { checks, failed });
    if (failed.length > 0) {
      this.log.warn(
        `Already failing on ${this.settings.baseBranch}, so not blamed on the agent: ${failed.join(', ')}`,
      );
    }
    this.checkCancelled();
  }

  /** Checks that failed on the base branch before the agent started. */
  private baselineFailures(): Set<string> {
    const saved = this.deps.store.latestEvent<{ failed?: string[] }>(this.run.id, 'baseline');
    return new Set(saved?.failed ?? []);
  }

  /** The model key as an egress secret, when the proxy adds it (E3). */
  private secretBindings(): SecretBinding[] {
    const { agent, modelKey } = this.deps;
    if (modelKey.mode !== 'egress') return [];
    const credential: SecretBinding = {
      name: modelKey.secretName,
      host: agent.credential.host,
      header: agent.credential.header,
    };
    if (agent.credential.prefix) credential.prefix = agent.credential.prefix;
    return [credential];
  }

  private allowDomains(): string[] {
    const { config, agent } = this.deps;
    return allowList({
      agentDomains: [agent.credential.host, ...agent.extraDomains],
      extra: config.sandbox.allow_domains,
      ...(config.sandbox.registries ? { registries: config.sandbox.registries } : {}),
    });
  }

  /**
   * F1: resume the paused sandbox the earlier run left, with its installed dependencies
   * and the agent's session, and bring its checkout to the pull request branch. False
   * when it cannot; a fresh sandbox then continues from the branch.
   */
  private async resumeFollowUp(sandboxId: string): Promise<boolean> {
    const { config, scm, sandboxes, store } = this.deps;
    this.setState('sandbox');
    const { base, instructionsBase } = await this.startPoint();
    this.base = base;
    if (!this.continuing) {
      this.base = undefined;
      await this.discardSandbox(sandboxId);
      return false;
    }
    const allowDomains = this.allowDomains();
    const secrets = this.secretBindings();
    const closeGitHub = config.sandbox.close_github_after_setup;
    try {
      this.log.step(`Resuming sandbox ${sandboxId}`);
      const sandbox = await sandboxes.connect(sandboxId);
      this.sandbox = sandbox;
      const layout = layoutFor(sandbox.homeDir);
      this.layout = layout;
      await this.extendSandbox(this.sandboxTimeout());
      // The earlier run's agent files move aside, so this run's rounds start clean.
      const work = shellQuote(layout.work);
      const earlier = shellQuote(`${layout.work}-earlier`);
      await sandbox.exec(
        `rm -rf ${earlier}; if [ -d ${work} ]; then mv ${work} ${earlier}; fi; mkdir -p ${work}`,
        { timeoutMs: 30_000 },
      );
      if (closeGitHub && sandbox.setEgress) await sandbox.setEgress(allowDomains, secrets);
      const access = await scm.cloneAccess(this.settings.repo);
      await updateCheckout(
        sandbox,
        layout,
        access,
        base,
        instructionsBase,
        this.stepTimeout(10 * 60_000),
      );
      if (closeGitHub && sandbox.setEgress) {
        await sandbox.setEgress(
          allowDomains.filter((domain) => !GITHUB_DOMAINS.includes(domain)),
          secrets,
        );
      }
      // Rule 5: instruction files from the base branch, as for every run.
      this.instructions = await readInstructionFiles(sandbox, layout, instructionsBase.sha);
    } catch (error) {
      this.log.warn(
        `The paused sandbox could not be resumed, so a fresh one continues from the branch. ${(error as Error).message}`,
      );
      this.sandbox = undefined;
      this.layout = undefined;
      this.base = undefined;
      await this.discardSandbox(sandboxId);
      if (this.run.sessionId) this.update({ sessionId: null });
      return false;
    }
    this.branchBase = instructionsBase;
    this.update({ baseSha: base.sha });
    this.audit('start_point', { base, instructionsBase });
    this.audit('sandbox', {
      id: sandboxId,
      provider: sandboxes.kind,
      resumed: true,
      allowDomains,
      modelKey: this.deps.modelKey.mode,
      capabilities: sandboxes.capabilities,
    });
    this.audit(
      'instructions',
      this.instructions.map((file) => ({ path: file.path, bytes: file.content.length })),
    );
    // The commands the first run worked out. Nothing is set up again.
    const parent = this.run.parentRunId;
    const commands = parent
      ? store.latestEvent<{ setup: string[]; verify: string[]; sources: unknown }>(
          parent,
          'commands',
        )
      : undefined;
    this.verify = commands?.verify ?? this.settings.verify ?? [];
    this.audit('commands', commands ?? { setup: [], verify: this.verify, sources: {} });
    if (this.run.sessionId && parent) {
      this.resumeSession = true;
      this.sessionBaseCostUsd = this.sessionCostOf(parent);
      this.audit('session', {
        resumed: true,
        sessionId: this.run.sessionId,
        baseCostUsd: this.sessionBaseCostUsd,
      });
    }
    this.checkCancelled();
    return true;
  }

  /** What an earlier run's agent session had cost in total when that run stopped. */
  private sessionCostOf(runId: string): number {
    const { store } = this.deps;
    const exit = store.latestEvent<{ sessionCostUsd?: number }>(runId, 'agent_exit');
    if (exit?.sessionCostUsd !== undefined) return exit.sessionCostUsd;
    const readiness = store
      .events(runId, { kind: 'readiness' })
      .reduce((sum, event) => sum + ((event.data as { costUsd?: number }).costUsd ?? 0), 0);
    return Math.max(0, (store.getRun(runId)?.costUsd ?? 0) - readiness);
  }

  /**
   * R1: a read-only agent pass that decides whether the ticket can be built as written.
   * It has its own small cap, and anything it changes is thrown away. People who
   * answered its questions or asked for a retry already said go, so it is skipped then.
   */
  private async readiness(): Promise<RunResult | undefined> {
    const { config, agent, modelKey } = this.deps;
    if (!config.readiness.enabled || this.answers() || this.run.parentRunId) return undefined;
    const budget = Math.min(
      config.readiness.cost_usd,
      config.limits.cost_usd - (this.costUsd ?? 0),
    );
    if (budget < 0.01) return undefined;
    const sandbox = this.sandbox as SandboxHandle;
    const layout = this.layout as Layout;
    const base = this.base as BaseRef;
    const ticket = this.ticket as TicketSnapshot;
    const ctx = this.context();
    const started = this.now();
    this.setState('readiness');
    this.log.step('Checking that the ticket is ready to build');
    await this.progress(ctx, 'the agent is checking that the ticket is ready to build');

    const files = agentFiles(layout, 'readiness');
    const system = buildReadinessSystemPrompt({
      workdir: layout.repo,
      instructions: this.instructions,
    });
    const prompt = buildReadinessPrompt(ticket);
    await sandbox.exec(`mkdir -p '${files.dir}'`, { timeoutMs: 30_000 });
    await sandbox.writeFile(files.system, system);
    await sandbox.writeFile(files.prompt, prompt);
    const command = agent.command({
      workdir: layout.repo,
      promptFile: files.prompt,
      systemPromptFile: files.system,
      sessionId: randomUUID(),
      resume: false,
      maxTurns: config.readiness.turns,
      maxBudgetUsd: budget,
      readOnly: true,
      ...(config.agent.model ? { model: config.agent.model } : {}),
    });
    const env = {
      ...agent.environment(this.keyPlacement()),
      [agent.credential.env]: modelKey.mode === 'env' ? modelKey.value : PLACEHOLDER_KEY,
    };
    await startAgent(sandbox, layout, files, command, env);
    this.audit('readiness_start', { system, prompt, command, budgetUsd: budget });
    const watch = await watchAgent(sandbox, files, {
      adapter: agent,
      onEvent: (event) => this.onAgentEvent(event, -1),
      deadline: Math.min(this.deadline, this.now() + config.readiness.minutes * 60_000),
      pollMs: this.deps.pollMs ?? 3_000,
      keepAliveEveryMs: 60_000,
      sandboxTimeoutMs: this.sandboxTimeout(),
      now: this.now,
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      shouldStop: () => this.stopRequest(),
    });
    if (watch.stopped === 'detached') throw new RunDetachedError();
    if (watch.stopped === 'cancelled')
      throw new RunCancelledError(cancelReason(this.request.signal));

    const costUsd = watch.result?.costUsd ?? 0;
    this.priorCostUsd += costUsd;
    this.costUsd = (this.costUsd ?? 0) + costUsd;
    // No verdict (a cap, an error) must not block the ticket: go ahead as if ready.
    const verdict: Readiness | undefined =
      watch.result?.ok && watch.result.text ? parseReadiness(watch.result.text) : undefined;
    this.audit('readiness', {
      verdict: verdict?.verdict ?? 'unclear',
      questions: verdict?.questions ?? [],
      reason: verdict?.reason ?? '',
      plan: verdict?.plan ?? '',
      costUsd,
      stopped: watch.stopped,
      outcome: watch.result?.outcome,
    });
    this.update({ costUsd: this.costUsd });
    // Throw away anything the check changed, so the work starts from a clean checkout.
    await resetCheckout(sandbox, layout, base.sha);
    if (!verdict || verdict.verdict === 'ready') {
      if (!verdict) this.log.warn('The readiness check gave no verdict, so the run goes ahead.');
      return undefined;
    }
    const check = { costUsd, durationMs: this.now() - started };
    return verdict.verdict === 'needs_info'
      ? this.askQuestions(ctx, verdict, check)
      : this.decline(ctx, verdict, check);
  }

  /** R2: ask in the ticket, then wait without a sandbox until someone says go. */
  private async askQuestions(
    ctx: RunContext,
    verdict: Readiness,
    check: { costUsd: number; durationMs: number },
  ): Promise<RunResult> {
    const key = this.run.ticketKey;
    const labels = this.deps.config.jira.labels;
    const questions = verdict.questions.map((question) => cleanAgentText(question, 300));
    const reason = cleanAgentText(verdict.reason, 300);
    if (this.statusCommentId)
      await this.tracker.updateComment(key, this.statusCommentId, waitingDoc(ctx, check));
    await this.tracker.postComment(
      key,
      questionsDoc(ctx, { questions, reason, label: labels.needs_info }),
    );
    await this.tracker.updateLabels(key, { add: [labels.needs_info], remove: [labels.working] });
    await this.sandbox?.destroy();
    this.sandbox = undefined;
    this.log.warn(`${key} needs answers before it can be built.`);
    // A dry run never parks: it only shows what would be asked.
    this.update({
      state: this.request.dryRun ? 'done' : 'needs_info',
      sandboxId: null,
      costUsd: this.costUsd ?? null,
      ...(this.request.dryRun ? { finishedAt: new Date(this.now()).toISOString() } : {}),
    });
    return { outcome: 'needs_info', run: this.run, questions };
  }

  private async decline(
    ctx: RunContext,
    verdict: Readiness,
    check: { costUsd: number; durationMs: number },
  ): Promise<RunResult> {
    const key = this.run.ticketKey;
    const reason = cleanAgentText(verdict.reason || 'The readiness check gave no reason.', 500);
    if (this.statusCommentId)
      await this.tracker.updateComment(
        key,
        this.statusCommentId,
        declinedDoc(ctx, { reason, ...check }),
      );
    await this.tracker.postComment(key, finalNoticeDoc(ctx, { kind: 'declined', reason }));
    await this.tracker.updateLabels(key, { remove: [this.deps.config.jira.labels.working] });
    await this.sandbox?.destroy();
    this.sandbox = undefined;
    this.log.warn(`Declined: ${reason}`);
    this.update({
      state: 'declined',
      error: reason,
      finishedAt: new Date(this.now()).toISOString(),
      costUsd: this.costUsd ?? null,
    });
    return { outcome: 'declined', run: this.run, reason };
  }

  private answers(): { by: string; text: string } | undefined {
    return this.deps.store.latestEvent<{ by: string; text: string }>(this.run.id, 'answers');
  }

  private answersForPrompt(): { answers?: { questions: string[]; text: string; by: string } } {
    const answers = this.answers();
    if (!answers) return {};
    const asked = this.deps.store.latestEvent<{ questions?: string[] }>(this.run.id, 'readiness');
    return {
      answers: { questions: asked?.questions ?? [], text: answers.text, by: answers.by },
    };
  }

  /**
   * Where the agent starts. Normally the base branch. A retry of a run that published
   * continues that run's pull request branch, if it still exists (F3).
   */
  private async startPoint(): Promise<{ base: BaseRef; instructionsBase: BaseRef }> {
    const { scm } = this.deps;
    const baseBranch = await scm.resolveBase(this.settings.repo, this.settings.baseBranch);
    const inherited = this.run.parentRunId ? this.run.branch : null;
    if (inherited) {
      try {
        const head = await scm.resolveBase(this.settings.repo, inherited);
        return { base: head, instructionsBase: baseBranch };
      } catch {
        this.log.warn(
          `Branch ${inherited} no longer exists, so this attempt starts from ${this.settings.baseBranch}.`,
        );
        this.update({ branch: null });
      }
    }
    return { base: baseBranch, instructionsBase: baseBranch };
  }

  /** Whether this run adds to an existing pull request branch instead of starting one. */
  private get continuing(): boolean {
    return this.base !== undefined && this.base.branch !== this.settings.baseBranch;
  }

  private async reconnect(sandboxId: string, baseSha: string): Promise<void> {
    this.log.step(`Reconnecting to sandbox ${sandboxId}`);
    try {
      this.sandbox = await this.deps.sandboxes.connect(sandboxId);
    } catch (error) {
      throw new StepFailedError(
        'sandbox',
        `The run's sandbox (${sandboxId}) is gone, so the run cannot continue. Label the ticket again to start over.`,
        (error as Error).message,
      );
    }
    this.layout = layoutFor(this.sandbox.homeDir);
    const start = this.deps.store.latestEvent<{ base: BaseRef; instructionsBase: BaseRef }>(
      this.run.id,
      'start_point',
    );
    this.base = start?.base ?? { branch: this.run.baseBranch, sha: baseSha };
    this.branchBase = start?.instructionsBase ?? this.base;
    const commands = this.deps.store.latestEvent<{ verify: string[] }>(this.run.id, 'commands');
    this.verify = commands?.verify ?? this.settings.verify ?? [];
    this.instructions = await readInstructionFiles(
      this.sandbox,
      this.layout,
      start?.instructionsBase.sha ?? baseSha,
    );
    const proof = this.deps.store.latestEvent<{ fixSha: string; done?: boolean }>(
      this.run.id,
      'proof_state',
    );
    if (proof && !proof.done) {
      await restoreTree(this.sandbox, this.layout, proof.fixSha);
      this.audit('proof_state', { fixSha: proof.fixSha, done: true });
    }
    await this.extendSandbox(this.sandboxTimeout());
  }

  private async discardSandbox(sandboxId: string): Promise<void> {
    try {
      await this.deps.sandboxes.deleteSandbox(sandboxId);
    } catch (error) {
      this.log.debug(`Could not delete sandbox ${sandboxId}: ${(error as Error).message}`);
    }
    this.audit('sandbox_discarded', { id: sandboxId });
    this.update({ sandboxId: null });
  }

  /** Implement, verify, fix (E4, E5, V1). Resumes in the round where it stopped. */
  private async implementAndVerify(): Promise<Work | RunResult> {
    if (IMPLEMENTED.has(this.run.state)) {
      const saved = this.deps.store.latestEvent<Work>(this.run.id, 'implemented');
      if (!saved) {
        throw new StepFailedError(
          this.run.state,
          'The run has no saved agent result to resume from.',
        );
      }
      return saved;
    }
    const { config, agent } = this.deps;
    const key = this.run.ticketKey;
    const ticket = this.ticket as TicketSnapshot;
    const sandbox = this.sandbox as SandboxHandle;
    const layout = this.layout as Layout;
    const base = this.base as BaseRef;
    const verify = this.verify;
    const workflow = this.run.workflow as WorkflowName;
    const ctx = this.context();

    let sessionId = this.run.sessionId;
    if (!sessionId) {
      sessionId = randomUUID();
      this.update({ sessionId });
    }
    const prompts = this.deps.store
      .events(this.run.id, { kind: 'prompt' })
      .map((event) => event.data as PromptRecord);
    const promptFor = (round: number) => prompts.filter((entry) => entry.round === round).at(-1);
    const system =
      promptFor(0)?.system ??
      buildSystemPrompt({
        workflow,
        workdir: layout.repo,
        verify,
        instructions: this.instructions,
        ...(this.continuing ? { branch: base.branch } : {}),
      });

    // On resume, start in the round that was running, with what earlier rounds produced.
    const resuming = this.run.state === 'implement' || this.run.state === 'verify';
    const firstRound = resuming ? (this.run.round ?? 0) : 0;
    const verifyFirst = this.run.state === 'verify';
    let report: AgentReport | undefined;
    let finalText = '';
    for (const event of this.deps.store.events(this.run.id, { kind: 'agent_exit' })) {
      const exit = event.data as { round: number; text?: string };
      const done = exit.round < firstRound || (verifyFirst && exit.round === firstRound);
      if (done && exit.text) {
        finalText = exit.text;
        report = parseAgentReport(exit.text) ?? report;
      }
    }

    let checks: CheckResult[] = [];
    const draftReasons: string[] = [];
    for (let round = firstRound; ; round++) {
      if (!(verifyFirst && round === firstRound)) {
        let prompt = promptFor(round)?.prompt;
        if (prompt === undefined) {
          if (round > 0) {
            throw new StepFailedError('implement', `The prompt for fix round ${round} is missing.`);
          }
          prompt = this.followUp
            ? this.followUpPrompt(ticket)
            : buildTaskPrompt(ticket, workflow, {
                ...(this.run.hint ? { hint: this.run.hint } : {}),
                earlierAttempt: this.continuing,
                ...this.answersForPrompt(),
              });
          this.audit('prompt', { round: 0, system, prompt });
        }
        this.setState('implement', { round });
        await this.progress(
          ctx,
          round > 0
            ? `fix round ${round}: the agent is fixing failed checks`
            : this.followUp
              ? this.followUpStep()
              : 'the agent is implementing the ticket',
        );
        this.log.step(
          round > 0
            ? `Fix round ${round}`
            : this.followUp
              ? `${agent.displayName} is working on the ${this.run.kind === 'ci' ? 'failed CI checks' : 'review feedback'}`
              : `${agent.displayName} is implementing ${key}`,
        );
        let text: string;
        try {
          text = await this.runAgent(round, { system, prompt, sessionId });
        } catch (error) {
          // A cap hit during a fix round keeps the work: it is published as a draft.
          if (round > 0 && error instanceof CapExceededError) {
            draftReasons.push(`Fix round ${round} stopped at the ${error.cap} limit.`);
            break;
          }
          throw error;
        }
        finalText = text;
        report = parseAgentReport(text) ?? report;

        if (round === 0 && !(await this.hasChanges(sandbox, layout, base.sha))) {
          if (this.followUp) return this.followUpNoChanges(ctx, finalText);
          return this.noChanges(ctx, cleanAgentText(stripReport(finalText), 1_500));
        }
      }

      await this.progress(ctx, 'Lockkeeper is running the checks');
      if (verify.length === 0) break;
      this.log.step(`Verifying: ${verify.join(', ')}`);
      const timeout = this.stepTimeout(config.limits.verify_minutes * 60_000);
      await this.extendSandbox(Math.min(MAX_SANDBOX_MS, timeout + 5 * 60_000));
      checks = await runCommands(sandbox, layout, verify, {
        timeoutMs: timeout,
        stopOnFailure: false,
        now: this.now,
      });
      const onBase = this.baselineFailures();
      for (const check of checks) {
        if (!check.passed && onBase.has(check.command)) check.failedOnBase = true;
      }
      this.audit('checks', { round, checks });
      const failures = checks.filter((check) => !check.passed);
      for (const check of checks) {
        this.log.info(
          `${check.passed ? '✓' : '✗'} ${check.command}${check.failedOnBase ? ' (fails on the base branch too)' : ''}`,
        );
      }
      if (failures.length === 0) break;
      if (round >= config.limits.fix_rounds) break;
      const budgetLeft = config.limits.cost_usd - (this.costUsd ?? 0);
      if (budgetLeft < MIN_FIX_ROUND_USD || this.deadline - this.now() < MIN_FIX_ROUND_MS) {
        draftReasons.push(
          'No fix round was started: too little of the cost or time limit was left.',
        );
        break;
      }
      this.fixRounds = round + 1;
      const next: PromptRecord = {
        round: round + 1,
        prompt: buildFixPrompt(
          failures.map((failure) => ({
            command: failure.command,
            exitCode: failure.exitCode,
            output: failure.output,
            ...(failure.failedOnBase ? { failedOnBase: true } : {}),
          })),
        ),
      };
      this.audit('prompt', next);
      prompts.push(next);
      this.update({ fixRounds: this.fixRounds });
    }
    let proof: FailingTestProof | undefined;
    if (workflow === 'bugfix' && newFailures(checks).length === 0) {
      proof = await this.proveFailingTest(ctx, report);
    }
    const outsideHosts = this.outsideHosts();
    this.checkCancelled();
    const work: Work = {
      finalText,
      ...(report ? { report } : {}),
      checks,
      draftReasons,
      ...(proof ? { proof } : {}),
      ...(outsideHosts.length > 0 ? { outsideHosts } : {}),
    };
    this.audit('implemented', work);
    this.setState('collect');
    return work;
  }

  private followUpPrompt(ticket: TicketSnapshot): string {
    const feedback = this.feedback();
    if (!feedback) {
      throw new StepFailedError('implement', 'The follow-up has no saved feedback to work on.');
    }
    return buildFollowUpPrompt({ ticket, feedback, resumed: this.resumeSession });
  }

  /**
   * E5: run the test commands on the base code with only the agent's new and changed
   * tests, and expect a failure. The fixed code is saved first and always put back.
   */
  private async proveFailingTest(
    ctx: RunContext,
    report: AgentReport | undefined,
  ): Promise<FailingTestProof> {
    const sandbox = this.sandbox as SandboxHandle;
    const layout = this.layout as Layout;
    const base = this.base as BaseRef;
    const commands = testCommands(this.verify);
    const tests = (await changedPaths(sandbox, layout, base.sha)).filter(isTestPath);
    const brokenOnBase = commands.filter((command) => this.baselineFailures().has(command));
    let proof: FailingTestProof;
    if (brokenOnBase.length > 0) {
      // A test command that already fails on the base branch cannot show a new failure.
      proof = {
        kind: 'skipped',
        reason: `${brokenOnBase.join(', ')} already fails on the base branch.`,
      };
    } else if (tests.length === 0) {
      proof = {
        kind: 'no_test',
        reason: cleanAgentText(report?.no_failing_test_reason ?? '', 300),
      };
    } else if (commands.length === 0) {
      proof = { kind: 'skipped', reason: 'No test command is configured or detected.' };
    } else {
      this.log.step('Checking that the new tests fail without the fix');
      await this.progress(ctx, 'Lockkeeper is checking that the new tests fail without the fix');
      const fixSha = await saveTree(sandbox, layout);
      this.audit('proof_state', { fixSha });
      try {
        if (!(await checkoutTestsOnBase(sandbox, layout, base.sha, fixSha, tests))) {
          proof = {
            kind: 'skipped',
            reason: 'git could not combine the base code with the new tests.',
          };
        } else {
          const results = await runCommands(sandbox, layout, commands, {
            timeoutMs: this.stepTimeout(this.deps.config.limits.verify_minutes * 60_000),
            stopOnFailure: false,
            now: this.now,
          });
          this.audit('proof_checks', results);
          const failed = results.find((result) => !result.passed);
          proof = failed
            ? { kind: 'proven', tests, command: failed.command, exitCode: failed.exitCode }
            : { kind: 'passed_before', tests, commands };
        }
      } finally {
        await restoreTree(sandbox, layout, fixSha);
        this.audit('proof_state', { fixSha, done: true });
      }
    }
    this.audit('proof', proof);
    return proof;
  }

  /** O2: hosts outside the allow-list that the agent's commands named, from the audit log. */
  private outsideHosts(): string[] {
    const { store } = this.deps;
    const egress =
      store.latestEvent<{ allowDomains?: string[] }>(this.run.id, 'egress') ??
      store.latestEvent<{ allowDomains?: string[] }>(this.run.id, 'sandbox');
    const commands = store
      .events(this.run.id, { kind: 'agent' })
      .map((event) => event.data as { type?: string; summary?: string })
      .filter((data) => data.type === 'tool_call' && typeof data.summary === 'string')
      .map((data) => data.summary as string);
    const hosts = hostsOutside(commands, egress?.allowDomains ?? []);
    if (hosts.length > 0) {
      this.audit('outside_hosts', { hosts });
      this.log.warn(`The agent named hosts outside the allow-list: ${hosts.join(', ')}`);
    }
    return hosts;
  }

  /** Package and check the result (V2), then publish it. */
  private async collectAndPublish(work: Work): Promise<RunResult> {
    const { config } = this.deps;
    const ticket = this.ticket as TicketSnapshot;
    const ctx = this.context();
    const sandbox = this.sandbox as SandboxHandle;
    const layout = this.layout as Layout;
    const base = this.base as BaseRef;

    this.log.step('Collecting and checking the changes');
    // What this run adds, which is what it commits.
    const collected = await collectChanges(sandbox, layout, base.sha);
    // What reviewers see. On a retry that is the whole pull request since it forked,
    // so a protected file an earlier attempt changed still keeps the PR a draft.
    let reviewed = collected;
    if (this.continuing && this.branchBase) {
      const forkPoint = await mergeBase(sandbox, layout, this.branchBase.sha, base.sha);
      reviewed = await collectChanges(sandbox, layout, forkPoint);
    }
    const policy = checkContents(
      reviewed.contents,
      checkDiff(reviewed.files, {
        protectedPaths: this.settings.protectedPaths,
        maxAddedLines: config.limits.max_added_lines,
        maxChangedFiles: config.limits.max_changed_files,
      }),
    );
    this.audit('policy', { files: reviewed.files, findings: policy.findings });
    if (collected.files.length === 0) {
      if (this.followUp) return this.followUpNoChanges(ctx, work.finalText);
      return this.noChanges(ctx, cleanAgentText(stripReport(work.finalText), 1_500));
    }
    if (policy.blocked) {
      const blocking = policy.findings.filter((finding) => finding.severity === 'block');
      throw new StepFailedError(
        'collect',
        `Lockkeeper will not publish this change: ${blocking.map((finding) => `${finding.message}${finding.paths ? ` (${finding.paths.join(', ')})` : ''}`).join(' ')}`,
      );
    }

    const report = work.report;
    const summary = cleanAgentText(report?.summary || stripReport(work.finalText), 1_500);
    const reply = cleanAgentText(report?.reply || summary, 1_500);
    const risks = (report?.risks ?? [])
      .slice(0, 10)
      .map((risk) => cleanAgentText(risk, 300))
      .filter(Boolean);
    if (work.outsideHosts && work.outsideHosts.length > 0) {
      risks.unshift(
        `The agent's commands named hosts outside the sandbox's allow-list, which the sandbox blocks: ${work.outsideHosts.slice(0, 10).join(', ')}. If the ticket did not call for this, check it for instructions aimed at the agent.`,
      );
    }
    const criteria = matchCriteria(ticket.acceptanceCriteria, report).map((criterion) => ({
      criterion: cleanAgentText(criterion.criterion, 300),
      met: criterion.met,
      evidence: cleanAgentText(criterion.evidence, 300),
    }));
    const draftReasons = [
      ...this.draftReasons(work.checks, this.verify, policy, criteria, ticket),
      ...work.draftReasons,
    ];
    if (work.proof?.kind === 'passed_before')
      draftReasons.push('The new tests pass without the fix too, so they do not show the bug.');
    if (work.proof?.kind === 'no_test' && !work.proof.reason)
      draftReasons.push(
        'The bug fix adds no test that fails without it, and the agent gave no reason.',
      );

    return this.publish({
      ctx,
      workflow: this.run.workflow as WorkflowName,
      base,
      collected,
      policy,
      summary,
      risks,
      criteria,
      checks: work.checks,
      draftReasons,
      reviewedFiles: reviewed.files.length,
      reply,
      ...(work.proof ? { proof: work.proof } : {}),
    });
  }

  // -------------------------------------------------------------------------

  private draftReasons(
    checks: CheckResult[],
    verify: string[],
    policy: PolicyResult,
    criteria: { met: boolean }[],
    ticket: TicketSnapshot,
  ): string[] {
    const reasons: string[] = [];
    const failed = checks.filter((check) => !check.passed);
    if (failed.length > 0) {
      const named = failed.map((check) =>
        check.failedOnBase ? `${check.command} (it fails on the base branch too)` : check.command,
      );
      reasons.push(`Checks failed: ${named.join(', ')}.`);
    }
    if (verify.length === 0)
      reasons.push('No lint or test commands ran, so nothing verified the change.');
    for (const finding of policy.findings.filter((entry) => entry.severity === 'draft'))
      reasons.push(finding.message);
    const unmet = criteria.filter((criterion) => !criterion.met).length;
    if (ticket.acceptanceCriteria.length > 0 && unmet > 0) {
      reasons.push(`${unmet} of ${criteria.length} acceptance criteria have no evidence.`);
    }
    return reasons;
  }

  private async publish(input: {
    ctx: RunContext;
    workflow: WorkflowName;
    base: { sha: string };
    collected: CollectedChanges;
    policy: PolicyResult;
    summary: string;
    risks: string[];
    criteria: { criterion: string; met: boolean; evidence: string }[];
    checks: CheckResult[];
    draftReasons: string[];
    /** Files the pull request changes in total, which a retry's commit may not all touch. */
    reviewedFiles: number;
    /** Follow-ups: what changed this time, for the reply on the pull request. */
    reply: string;
    proof?: FailingTestProof;
  }): Promise<RunResult> {
    const { config, scm } = this.deps;
    const { ctx, collected, policy } = input;
    const key = this.run.ticketKey;
    const ticket = ctx.ticket;
    const dryRun = this.request.dryRun === true;

    if (this.run.state !== 'report') {
      this.setState('publish');
      await this.progress(ctx, 'Lockkeeper is opening the pull request');
    }
    const title = titleFor(key, ticket.summary);
    const durationMs = this.now() - this.startedAt;
    const body = capPullRequestBody(
      docToMarkdown(
        pullRequestBodyDoc({
          ctx,
          summary: input.summary,
          addedLines: policy.addedLines,
          removedLines: policy.removedLines,
          fileCount: input.reviewedFiles,
          criteria: input.criteria,
          checks: input.checks,
          findings: policy.findings,
          risks: input.risks,
          draftReasons: input.draftReasons,
          costUsd: this.costUsd,
          durationMs,
          fixRounds: this.fixRounds,
          ...(input.proof ? { proof: input.proof } : {}),
          ...this.pullRequestTotal(),
        }),
      ),
    );
    const draft = input.draftReasons.length > 0;
    const wantedBranch = branchName(input.workflow, key, ticket.summary);

    let pr: PullRequest = { url: '(dry run: no pull request)', number: 0, draft, state: 'none' };
    let branch = this.run.branch;
    if (dryRun) {
      branch = await this.availableBranch(wantedBranch);
    } else {
      // V3, T6: a run resumed after a crash finds its own branch, commit and PR instead
      // of making new ones. A branch counts as its own only if the head commit says so.
      let headSha = this.run.headSha;
      let createBranch = true;
      if (!headSha && branch) {
        const head = await scm.branchHead(this.settings.repo, branch);
        if (head?.message.includes(`Lockkeeper-Run: ${this.run.id}`)) {
          headSha = head.sha;
          this.update({ headSha });
        } else if (head && head.sha === input.base.sha) {
          // A retry adds a commit on top of the branch it cloned (fast-forward only, V3).
          createBranch = false;
        } else if (head && this.continuing) {
          throw branchMovedError(branch);
        } else if (head) {
          branch = null;
        }
      }
      if (!headSha) {
        branch ??= await this.availableBranch(wantedBranch);
        this.update({ branch });
        // V3: commits and the PR are created here, under the App identity, never in the sandbox.
        // A follow-up's commit says what it answered; the PR title keeps the ticket's.
        const subject = this.followUp
          ? `${key}: ${this.run.kind === 'ci' ? 'fix failed CI checks' : 'address review feedback'}`
          : title;
        const body = this.followUp ? input.reply : input.summary;
        const message = `${subject}\n\n${body}\n\nTicket: ${ticket.url}\nLockkeeper-Run: ${this.run.id}\nAgent: ${this.deps.agent.displayName}\n`;
        let commit: CommitResult;
        try {
          commit = await scm.commit({
            repo: this.settings.repo,
            branch,
            parentSha: input.base.sha,
            message,
            changes: collected.changes,
            createBranch,
          });
        } catch (error) {
          // Someone pushed between the check above and the commit: say so plainly.
          const moved =
            !createBranch &&
            (await scm.branchHead(this.settings.repo, branch).catch(() => undefined));
          if (moved && moved.sha !== input.base.sha) throw branchMovedError(branch);
          throw error;
        }
        this.update({ headSha: commit.sha });
        this.audit('commit', {
          sha: commit.sha,
          url: commit.url,
          verified: commit.verified,
          branch,
          paths: collected.files.map((file) => file.path),
        });
        this.log.step(`Committed ${commit.sha.slice(0, 12)} to ${branch}`);
      }
      const head = branch as string;
      // The run's own record says whether it already opened or updated the PR. A
      // follow-up inherits the PR's number, but still has to bring its body up to date.
      const handled = this.deps.store.latestEvent<PullRequest>(this.run.id, 'pull_request');
      if (handled) {
        pr = { url: handled.url, number: handled.number, draft, state: 'open' };
      } else {
        const existing = await scm.findPullRequest(this.settings.repo, head);
        if (existing?.state === 'open') {
          // A retry, a follow-up, or a restart after opening it: bring the open PR up to date.
          pr = await scm.updatePullRequest(this.settings.repo, existing.number, { body, draft });
          this.log.step(`Updated pull request ${pr.url}`);
        } else {
          pr = await scm.openPullRequest({
            repo: this.settings.repo,
            head,
            base: this.settings.baseBranch,
            title,
            body,
            draft,
          });
          this.log.step(`Opened ${pr.draft || draft ? 'draft ' : ''}pull request ${pr.url}`);
        }
        this.update({ prNumber: pr.number, prUrl: pr.url, prState: 'open' });
        this.audit('pull_request', pr);
      }
    }
    const branchShown = branch as string;

    // J1, J2. A dry run makes the same calls, and the recording tracker keeps them.
    if (this.run.state !== 'report') this.setState('report');
    const outcome = {
      pr: { url: pr.url, number: pr.number, draft },
      branch: branchShown,
      criteria: input.criteria,
      checks: input.checks,
      draftReasons: input.draftReasons,
      summary: input.summary,
      costUsd: this.costUsd,
      durationMs: this.now() - this.startedAt,
      fixRounds: this.fixRounds,
    };
    // Saved so the status comment can be closed out on merge (F2) or restored later.
    this.audit('outcome', outcome);
    if (this.statusCommentId)
      await this.tracker.updateComment(key, this.statusCommentId, resultDoc(ctx, outcome));
    if (this.followUp) {
      // F1: reviewers stay in GitHub, so a follow-up answers on the pull request.
      if (!dryRun && !this.deps.store.latestEvent(this.run.id, 'pr_reply')) {
        const commit = this.deps.store.latestEvent<{ sha: string; url: string }>(
          this.run.id,
          'commit',
        );
        const reply = docToMarkdown(
          followUpReplyDoc(ctx, {
            ...this.replyInfo(),
            commit: commit ?? { sha: this.run.headSha ?? '', url: pr.url },
            summary: input.reply,
            verify: input.checks,
            draftReasons: input.draftReasons,
            costUsd: this.costUsd,
            durationMs: this.now() - this.startedAt,
            fixRounds: this.fixRounds,
          }),
        );
        const posted = await scm.commentOnPullRequest(this.settings.repo, pr.number, reply);
        this.audit('pr_reply', posted);
      }
    } else if (!this.deps.store.latestEvent(this.run.id, 'final_notice')) {
      const commentId = await this.tracker.postComment(
        key,
        finalNoticeDoc(ctx, { kind: 'pr', url: pr.url, draft }),
      );
      this.audit('final_notice', { commentId });
    }
    await this.tracker.linkPullRequest(key, { url: pr.url, title });
    await this.tracker.updateLabels(key, {
      add: [config.jira.labels.in_review],
      remove: [config.jira.labels.working],
    });
    const transition = config.jira.transitions.in_review;
    if (!this.followUp && transition && !(await this.tracker.transition(key, transition))) {
      this.log.warn(`No "${transition}" transition is available on ${key}.`);
    }

    if (dryRun) {
      const diff =
        this.sandbox && this.layout
          ? redactSecrets(await stagedDiff(this.sandbox, this.layout, input.base.sha)).text
          : '';
      await this.sandbox?.destroy();
      this.sandbox = undefined;
      this.update({
        state: 'done',
        finishedAt: new Date(this.now()).toISOString(),
        costUsd: this.costUsd ?? null,
        turns: this.turns ?? null,
      });
      const recorder = this.tracker as RecordingTracker;
      return {
        outcome: 'dry_run',
        run: this.run,
        preview: {
          branch: branchShown,
          title,
          body,
          comments: recorder.comments().map((comment) => docToPlainText(comment.body)),
          trackerChanges: recorder.changes(),
          files: collected.files.map((file) => ({
            path: file.path,
            status: file.status,
            added: file.added,
            removed: file.removed,
          })),
          draftReasons: input.draftReasons,
          diff,
        },
      };
    }

    await this.park();
    this.update({
      state: 'in_review',
      costUsd: this.costUsd ?? null,
      turns: this.turns ?? null,
      prState: 'open',
      // Feedback older than this run's pull request is not for it (F1).
      prSeen:
        this.run.prSeen ?? JSON.stringify({ at: new Date(this.now()).toISOString(), ids: [] }),
    });
    return { outcome: 'pr', run: this.run, pr, draftReasons: input.draftReasons };
  }

  /** F2: park the sandbox while the PR is in review, so a follow-up can resume it. */
  private async park(): Promise<void> {
    if (!this.sandbox) return;
    if (this.deps.sandboxes.capabilities.pause) await this.sandbox.pause();
    else {
      await this.sandbox.destroy();
      this.sandbox = undefined;
      this.update({ sandboxId: null });
    }
  }

  /** What every run on this pull request cost, for its body. */
  private pullRequestTotal(): { total?: { costUsd: number; runs: number } } {
    const number = this.run.prNumber;
    if (number === null) return {};
    const others = this.deps.store
      .listRuns({ ticketKey: this.run.ticketKey, limit: 200 })
      .filter((run) => run.prNumber === number && run.id !== this.run.id);
    if (others.length === 0) return {};
    const costUsd = others.reduce((sum, run) => sum + (run.costUsd ?? 0), this.costUsd ?? 0);
    return { total: { costUsd, runs: others.length + 1 } };
  }

  /** The newest saved result of this ticket's pull request, for its status comment. */
  private latestOutcome(): Outcome | undefined {
    for (const run of this.deps.store.listRuns({ ticketKey: this.run.ticketKey, limit: 50 })) {
      const outcome = this.deps.store.latestEvent<Outcome>(run.id, 'outcome');
      if (outcome) return outcome;
    }
    return undefined;
  }

  /** Put the pull request's result back on the status comment after a follow-up. */
  private async restoreStatus(ctx: RunContext, note?: string): Promise<void> {
    const outcome = this.latestOutcome();
    if (!this.statusCommentId || !outcome) return;
    try {
      await this.tracker.updateComment(
        this.run.ticketKey,
        this.statusCommentId,
        resultDoc(ctx, outcome, note ? { note } : {}),
      );
    } catch (error) {
      this.log.warn(`Could not update the status comment: ${(error as Error).message}`);
    }
  }

  /** A follow-up that changed nothing answers on the pull request and waits again. */
  private async followUpNoChanges(ctx: RunContext, finalText: string): Promise<RunResult> {
    const report = parseAgentReport(finalText);
    const message = cleanAgentText(
      report?.reply || report?.summary || stripReport(finalText),
      1_500,
    );
    const number = this.run.prNumber;
    if (
      !this.request.dryRun &&
      number !== null &&
      !this.deps.store.latestEvent(this.run.id, 'pr_reply')
    ) {
      const reply = docToMarkdown(
        followUpNoChangesDoc(ctx, {
          ...this.replyInfo(),
          message,
          costUsd: this.costUsd,
          durationMs: this.now() - this.startedAt,
          fixRounds: this.fixRounds,
        }),
      );
      const posted = await this.deps.scm.commentOnPullRequest(this.settings.repo, number, reply);
      this.audit('pr_reply', posted);
    }
    await this.restoreStatus(ctx);
    await this.park();
    this.log.step('The agent changed nothing and answered on the pull request.');
    this.update({
      state: 'in_review',
      headSha: this.base?.sha ?? null,
      costUsd: this.costUsd ?? null,
      turns: this.turns ?? null,
      prState: 'open',
    });
    return { outcome: 'no_changes', run: this.run };
  }

  // -------------------------------------------------------------------------

  /** Start the round's agent, or reattach to it if an earlier process started it. */
  private async runAgent(
    round: number,
    input: { system: string; prompt: string; sessionId: string },
  ): Promise<string> {
    const { config, agent, modelKey } = this.deps;
    const sandbox = this.sandbox as SandboxHandle;
    const layout = this.layout as Layout;
    const files = agentFiles(layout, round);
    const started = await agentStarted(sandbox, files);
    const skipBytes = started ? (this.run.agentOffset ?? 0) : 0;
    if (started) {
      this.log.step(`Reattaching to ${agent.displayName}`);
      this.audit('agent_reattach', { round, offset: skipBytes });
    } else {
      // Each round gets what is left of the run's caps.
      const budget = config.limits.cost_usd - (this.costUsd ?? 0);
      const turnsLeft = config.limits.turns - (this.turns ?? 0);
      if (budget < 0.01)
        throw new CapExceededError(
          'cost',
          `The run reached its cost limit of $${config.limits.cost_usd}.`,
        );
      if (turnsLeft < 1)
        throw new CapExceededError(
          'turns',
          `The agent reached its limit of ${config.limits.turns} turns.`,
        );
      await sandbox.exec(`mkdir -p '${files.dir}'`, { timeoutMs: 30_000 });
      await sandbox.writeFile(files.system, input.system);
      await sandbox.writeFile(files.prompt, input.prompt);
      const invocation = {
        workdir: layout.repo,
        promptFile: files.prompt,
        systemPromptFile: files.system,
        sessionId: input.sessionId,
        // Fix rounds continue the session; so does a follow-up in its resumed sandbox.
        resume: round > 0 || this.resumeSession,
        maxTurns: turnsLeft,
        maxBudgetUsd: budget,
        ...(config.agent.model ? { model: config.agent.model } : {}),
      };
      const command = agent.command(invocation);
      const env = {
        ...agent.environment(this.keyPlacement()),
        [agent.credential.env]: modelKey.mode === 'env' ? modelKey.value : PLACEHOLDER_KEY,
      };
      await this.extendSandbox(this.sandboxTimeout());
      await startAgent(sandbox, layout, files, command, env);
      this.update({ agentOffset: 0 });
      this.audit('agent_start', { round, command, budgetUsd: budget });
    }

    let saved = skipBytes;
    const watch = await watchAgent(sandbox, files, {
      adapter: agent,
      onEvent: (event) => this.onAgentEvent(event, round),
      deadline: this.deadline,
      pollMs: this.deps.pollMs ?? 3_000,
      keepAliveEveryMs: 60_000,
      sandboxTimeoutMs: this.sandboxTimeout(),
      skipBytes,
      onProgress: (offset) => {
        if (offset <= saved) return;
        saved = offset;
        this.update({ agentOffset: offset });
      },
      now: this.now,
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      shouldStop: () => this.stopRequest(),
    });
    if (watch.stopped === 'detached') throw new RunDetachedError();
    const result = watch.result;
    // Cost is the session total so far; turns are this round's only (see AgentEvent). A
    // resumed session's total includes what earlier runs spent, which they already count.
    if (result?.costUsd !== undefined)
      this.costUsd = this.priorCostUsd + Math.max(0, result.costUsd - this.sessionBaseCostUsd);
    if (result?.turns !== undefined) this.turns = (this.turns ?? 0) + result.turns;
    this.audit('agent_exit', {
      round,
      stopped: watch.stopped,
      exitCode: watch.exitCode,
      outcome: result?.outcome,
      ...(result?.costUsd !== undefined ? { sessionCostUsd: result.costUsd } : {}),
      stderr: tail(watch.stderr, 30),
      ...(result?.text ? { text: result.text.slice(0, 50_000) } : {}),
    });

    if (watch.stopped === 'cancelled')
      throw new RunCancelledError(cancelReason(this.request.signal));
    if (watch.stopped === 'deadline') {
      throw new CapExceededError(
        'minutes',
        `The run reached its time limit of ${config.limits.minutes} minutes.`,
      );
    }
    if (result?.cap === 'cost')
      throw new CapExceededError(
        'cost',
        `The run reached its cost limit of $${config.limits.cost_usd}.`,
      );
    if (result?.cap === 'turns')
      throw new CapExceededError(
        'turns',
        `The agent reached its limit of ${config.limits.turns} turns.`,
      );
    if (!result) {
      throw new StepFailedError(
        'implement',
        `${agent.displayName} exited with code ${watch.exitCode} without a result.`,
        tail(watch.stderr, 40),
      );
    }
    if (!result.ok) {
      const detail = [...(result.errors ?? []), tail(watch.stderr, 20)].filter(Boolean).join('\n');
      throw new StepFailedError(
        'implement',
        `${agent.displayName} stopped with an error (${result.outcome}).`,
        detail,
      );
    }
    // Leave the implement state in the same write as the round's cost and turns, so a
    // restart never counts them twice.
    this.update({
      state: 'verify',
      costUsd: this.costUsd ?? null,
      turns: this.turns ?? null,
      agentOffset: null,
    });
    this.audit('state', { state: 'verify', round });
    return result.text;
  }

  private onAgentEvent(event: AgentEvent, round: number): void {
    switch (event.type) {
      case 'session':
        this.log.info(`Agent session ${event.sessionId}${event.model ? ` (${event.model})` : ''}`);
        break;
      case 'tool_call':
        this.log.debug(`${event.tool}: ${event.summary}`);
        break;
      case 'message':
        this.log.debug(event.text.length > 300 ? `${event.text.slice(0, 299)}…` : event.text);
        break;
      case 'retry':
        this.log.warn(`Model API retry ${event.attempt}${event.error ? `: ${event.error}` : ''}`);
        break;
      case 'result':
        this.log.info(
          `Agent finished: ${event.outcome}${event.costUsd !== undefined ? `, $${event.costUsd.toFixed(2)}` : ''}`,
        );
        break;
      default:
        break;
    }
    // O2: what the agent read, ran and changed. Messages are capped, not dropped.
    const stored =
      event.type === 'message' && event.text.length > 2_000
        ? { ...event, text: `${event.text.slice(0, 2_000)}…` }
        : event;
    this.audit('agent', { round, ...stored });
  }

  private async hasChanges(
    sandbox: SandboxHandle,
    layout: Layout,
    baseSha: string,
  ): Promise<boolean> {
    const status = await sandbox.exec(
      `git status --porcelain=v1 --untracked-files=all | head -n 1; git rev-parse HEAD`,
      {
        cwd: layout.repo,
        timeoutMs: 60_000,
      },
    );
    const lines = status.stdout.trim().split('\n');
    const head = lines.at(-1)?.trim();
    return lines.length > 1 || (head !== undefined && head !== baseSha);
  }

  private async availableBranch(wanted: string): Promise<string> {
    // V3: never write to a branch Lockkeeper did not create in this run.
    for (let attempt = 1; attempt <= 20; attempt++) {
      const name = attempt === 1 ? wanted : `${wanted}-${attempt}`;
      if (!(await this.deps.scm.branchExists(this.settings.repo, name))) return name;
    }
    throw new StepFailedError('publish', `Branches ${wanted} to ${wanted}-20 all exist already.`);
  }

  private async noChanges(ctx: RunContext, message: string): Promise<RunResult> {
    const key = this.run.ticketKey;
    const outcome = {
      message,
      costUsd: this.costUsd,
      durationMs: this.now() - this.startedAt,
      fixRounds: this.fixRounds,
    };
    if (this.statusCommentId)
      await this.tracker.updateComment(key, this.statusCommentId, noChangesDoc(ctx, outcome));
    await this.tracker.postComment(key, finalNoticeDoc(ctx, { kind: 'no_changes' }));
    await this.tracker.updateLabels(key, {
      add: [this.deps.config.jira.labels.needs_info],
      remove: [this.deps.config.jira.labels.working],
    });
    await this.sandbox?.destroy();
    this.sandbox = undefined;
    this.log.warn('The agent made no changes.');
    this.update({
      state: 'done',
      finishedAt: new Date(this.now()).toISOString(),
      costUsd: this.costUsd ?? null,
      turns: this.turns ?? null,
    });
    return { outcome: 'no_changes', run: this.run };
  }

  private async refuse(reason: string, hint?: string): Promise<RunResult> {
    const key = this.run.ticketKey;
    this.audit('refused', { reason });
    this.log.warn(`Refused: ${reason}`);
    try {
      await this.tracker.postComment(key, refusedDoc(key, reason, hint));
      // Clear the label, so the ticket shows plainly that nothing is running.
      await this.tracker.updateLabels(key, { remove: [this.deps.config.jira.labels.trigger] });
    } catch (error) {
      this.log.warn(`Could not comment on ${this.run.ticketKey}: ${(error as Error).message}`);
    }
    this.update({
      state: 'refused',
      error: reason,
      finishedAt: new Date(this.now()).toISOString(),
    });
    return { outcome: 'refused', run: this.run, reason };
  }

  /** Leave the run for a later process. The sandbox is paused, so it costs nothing meanwhile. */
  private async detached(): Promise<RunResult> {
    this.audit('detached', { state: this.run.state, leaseLost: this.leaseLost });
    if (!this.leaseLost && this.sandbox && this.deps.sandboxes.capabilities.pause) {
      try {
        await this.sandbox.pause();
      } catch (error) {
        this.log.debug(`Could not pause sandbox ${this.sandbox.id}: ${(error as Error).message}`);
      }
    }
    this.log.warn(
      `Run ${this.run.id} stopped in the ${this.run.state} step. It continues when Lockkeeper starts again.`,
    );
    return { outcome: 'detached', run: this.run };
  }

  private async fail(error: unknown): Promise<RunResult> {
    let err = error instanceof Error ? error : new Error(String(error));
    // Once stopped, whatever broke next is part of stopping, not a failure.
    const cancelled = err instanceof RunCancelledError || this.request.signal?.aborted === true;
    if (cancelled && !(err instanceof RunCancelledError))
      err = new RunCancelledError(cancelReason(this.request.signal));
    const state: RunState = cancelled ? 'cancelled' : 'failed';
    const reason = describeFailure(err);
    const logTail = err instanceof StepFailedError ? err.logTail : undefined;
    this.audit('error', {
      name: err.name,
      message: err.message,
      ...(err instanceof LockkeeperError && err.hint ? { hint: err.hint } : {}),
      ...(err instanceof CapExceededError ? { cap: err.cap } : {}),
      ...(err instanceof StepFailedError ? { step: err.step, logTail } : {}),
    });

    if (this.followUp && this.ticket) {
      await this.followUpFailed(reason, cancelled);
    } else if (this.ticket && this.statusCommentId) {
      const ctx = this.context();
      const key = this.run.ticketKey;
      const labels = this.deps.config.jira.labels;
      try {
        await this.tracker.updateComment(
          key,
          this.statusCommentId,
          failedDoc(ctx, {
            reason,
            ...(logTail ? { logTail: redactSecrets(logTail).text } : {}),
            costUsd: this.costUsd,
            durationMs: this.now() - this.startedAt,
          }),
        );
        // Whoever stopped the run knows. Only a failure needs a notification.
        if (!cancelled) {
          await this.tracker.postComment(key, finalNoticeDoc(ctx, { kind: 'failed', reason }));
        }
        await this.tracker.updateLabels(
          key,
          cancelled
            ? { remove: [labels.working, labels.trigger] }
            : { add: [labels.failed], remove: [labels.working] },
        );
      } catch (reportError) {
        this.log.warn(`Could not report the failure on ${key}: ${(reportError as Error).message}`);
      }
    }
    if (this.sandbox) {
      try {
        await this.sandbox.destroy();
      } catch (destroyError) {
        this.log.warn(
          `Could not delete sandbox ${this.sandbox.id}: ${(destroyError as Error).message}`,
        );
      }
    }
    this.update({
      state,
      error: err.message,
      finishedAt: new Date(this.now()).toISOString(),
      costUsd: this.costUsd ?? null,
      turns: this.turns ?? null,
    });
    return { outcome: 'failed', run: this.run, error: err };
  }

  /**
   * A follow-up that failed leaves the pull request as it was: it says so on the PR,
   * and the ticket's status comment shows the PR's result again with a note.
   */
  private async followUpFailed(reason: string, cancelled: boolean): Promise<void> {
    const ctx = this.context();
    const reply = this.replyInfo();
    const what = reply.kind === 'ci' ? 'CI fix' : 'follow-up';
    await this.restoreStatus(
      ctx,
      `A ${what} on the pull request ${cancelled ? 'was stopped' : 'stopped'}: ${reason}`,
    );
    const number = this.run.prNumber;
    if (this.request.dryRun || number === null) return;
    try {
      await this.deps.scm.commentOnPullRequest(
        this.settings.repo,
        number,
        docToMarkdown(followUpFailedDoc(ctx, { ...reply, reason, cancelled })),
      );
    } catch (error) {
      this.log.warn(`Could not reply on the pull request: ${(error as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------

  private context(): RunContext {
    const trigger = parseTriggerInfo(this.run.triggerInfo);
    // A follow-up's trigger is a GitHub user, who has no Jira account to mention.
    const by = trigger?.source === 'review' || trigger?.source === 'ci' ? undefined : trigger?.by;
    return {
      ticket: this.ticket as TicketSnapshot,
      runId: this.run.id,
      agentName: this.deps.agent.displayName,
      limits: {
        costUsd: this.deps.config.limits.cost_usd,
        minutes: this.deps.config.limits.minutes,
      },
      ...(by ? { requester: { accountId: by.accountId, displayName: by.displayName } } : {}),
    };
  }

  private async progress(ctx: RunContext, step: string): Promise<void> {
    if (!this.statusCommentId) return;
    try {
      await this.tracker.updateComment(
        this.run.ticketKey,
        this.statusCommentId,
        progressDoc(ctx, step),
      );
    } catch (error) {
      // Progress updates are best effort; the final result is not.
      this.log.warn(`Could not update the status comment: ${(error as Error).message}`);
    }
  }

  private stopRequest(): StopRequest {
    if (this.request.signal?.aborted) return 'cancel';
    if (this.request.detach?.aborted || this.leaseLost) return 'detach';
    return false;
  }

  private checkCancelled(): void {
    if (this.request.signal?.aborted)
      throw new RunCancelledError(cancelReason(this.request.signal));
    if (this.request.detach?.aborted || this.leaseLost) throw new RunDetachedError();
  }

  /**
   * Stop sandbox work at once when the run is cancelled, so a stop takes effect within
   * seconds even in the middle of a long setup command (F3).
   */
  private async interrupt(): Promise<void> {
    const sandbox = this.sandbox;
    if (!sandbox) return;
    try {
      await sandbox.destroy();
      if (this.sandbox === sandbox) this.sandbox = undefined;
    } catch (error) {
      this.log.debug(`Could not delete the sandbox: ${(error as Error).message}`);
    }
  }

  private renewLease(): void {
    try {
      const held = this.deps.store.renewLease(this.run.id, PROCESS_OWNER, leaseEnd(this.now()));
      if (!held && !this.leaseLost) {
        this.leaseLost = true;
        this.log.warn(`Another Lockkeeper process took over run ${this.run.id}. Stopping here.`);
      }
    } catch (error) {
      this.log.debug(`Could not renew the lease: ${(error as Error).message}`);
    }
  }

  private keyPlacement(): KeyPlacement {
    return { keyInEnvironment: this.deps.modelKey.mode === 'env' };
  }

  /**
   * Push the sandbox's expiry out before a long step. Best effort: the timeout set at
   * creation already covers the run, and plans cap continuous runtime differently.
   */
  private async extendSandbox(timeoutMs: number): Promise<void> {
    try {
      await this.sandbox?.keepAlive(timeoutMs);
    } catch (error) {
      this.log.debug(`Could not extend the sandbox timeout: ${(error as Error).message}`);
    }
  }

  /** Time left in the run, capped at `max`. */
  private stepTimeout(max: number): number {
    return Math.max(60_000, Math.min(max, this.deadline - this.now()));
  }

  /** The sandbox lives until shortly after the run's own deadline, within E2B's one-hour limit. */
  private sandboxTimeout(): number {
    return Math.min(MAX_SANDBOX_MS, Math.max(5 * 60_000, this.deadline - this.now() + 10 * 60_000));
  }

  private setState(state: RunState, extra: { round?: number } = {}): void {
    this.update({ state, ...extra });
    this.audit('state', { state, ...extra });
  }

  private update(patch: Parameters<Store['updateRun']>[1]): void {
    this.run = this.deps.store.updateRun(this.run.id, patch, new Date(this.now()));
  }

  private audit(kind: string, data: unknown): void {
    this.deps.store.appendEvent(this.run.id, kind, data, new Date(this.now()));
  }
}

function branchMovedError(branch: string): StepFailedError {
  return new StepFailedError(
    'publish',
    `Someone pushed to ${branch} while the agent worked, so Lockkeeper did not add to it. Comment /agent retry to try again on top of the new commits.`,
  );
}

export function describeFailure(error: Error): string {
  if (error instanceof CapExceededError)
    return `Stopped at the ${error.cap.replace('_', ' ')} limit. ${error.message}`;
  if (error instanceof LockkeeperError)
    return redactSecrets(`${error.message}${error.hint ? ` ${error.hint}` : ''}`).text;
  return redactSecrets(`Lockkeeper hit an unexpected error: ${error.message}`).text;
}
