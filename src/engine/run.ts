import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent } from '../agent/agent.js';
import {
  type Config,
  type ProjectSettings,
  projectSettings,
  resolveRepo,
} from '../config/schema.js';
import { branchName, titleFor, type WorkflowName, workflowFor } from '../core/branch.js';
import { docToMarkdown, docToPlainText } from '../core/doc.js';
import {
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
import type { SandboxHandle, SandboxProvider, SecretBinding } from '../sandbox/sandbox.js';
import type { PullRequest, SourceControl } from '../scm/scm.js';
import type { RunRecord, RunState, Store } from '../store/store.js';
import { RecordingTracker } from '../tracker/recording-tracker.js';
import type { TicketSnapshot, Tracker } from '../tracker/tracker.js';
import { detectCommands } from './detect.js';
import { allowList } from './domains.js';
import {
  type AgentReport,
  buildFixPrompt,
  buildSystemPrompt,
  buildTaskPrompt,
  matchCriteria,
  parseAgentReport,
  stripReport,
} from './prompts.js';
import {
  capPullRequestBody,
  cleanAgentText,
  failedDoc,
  finalNoticeDoc,
  noChangesDoc,
  pickedUpDoc,
  progressDoc,
  pullRequestBodyDoc,
  type RunContext,
  refusedDoc,
  resultDoc,
} from './report.js';
import {
  agentFiles,
  type CheckResult,
  type CollectedChanges,
  cloneRepo,
  collectChanges,
  inspectRoot,
  type Layout,
  layoutFor,
  readInstructionFiles,
  runCommands,
  startAgent,
  tail,
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
  signal?: AbortSignal;
}

export interface DryRunPreview {
  branch: string;
  title: string;
  body: string;
  comments: string[];
  files: { path: string; status: string; added: number | null; removed: number | null }[];
  draftReasons: string[];
}

export type RunResult =
  | { outcome: 'pr'; run: RunRecord; pr: PullRequest; draftReasons: string[] }
  | { outcome: 'no_changes'; run: RunRecord }
  | { outcome: 'refused'; run: RunRecord; reason: string }
  | { outcome: 'failed'; run: RunRecord; error: Error }
  | { outcome: 'dry_run'; run: RunRecord; preview: DryRunPreview };

const PLACEHOLDER_KEY = 'lockkeeper-key-added-by-egress-proxy';
const MAX_SANDBOX_MS = 60 * 60_000;
const MIN_FIX_ROUND_USD = 0.5;
const MIN_FIX_ROUND_MS = 3 * 60_000;

/** Turn a ticket into a pull request: the walking skeleton's whole loop, start to finish. */
export async function runTicket(deps: RunDeps, request: RunRequest): Promise<RunResult> {
  const key = request.ticketKey.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key))
    throw new ConfigError(`Not a Jira issue key: ${request.ticketKey}`);
  const projectKey = key.slice(0, key.lastIndexOf('-'));
  const settings = projectSettings(deps.config, projectKey);
  if (!settings) {
    throw new RunRefusedError(
      `Project ${projectKey} is not configured.`,
      `Add it under projects: in lockkeeper.yml.`,
    );
  }
  const active = deps.store.countActiveRuns();
  if (active >= deps.config.limits.parallel_runs) {
    throw new CapExceededError(
      'parallel_runs',
      `${active} runs are already active, the limit for this install (limits.parallel_runs).`,
    );
  }
  // T6: claiming the ticket is the first write, and it fails if a run is active.
  const run = deps.store.createRun({
    ticketKey: key,
    tracker: deps.tracker.kind,
    repo: settings.repo,
    baseBranch: settings.baseBranch,
    workflow: 'feature',
    agent: deps.agent.id,
    triggeredBy: request.triggeredBy,
    state: 'snapshot',
  });
  return new TicketRun(deps, request, run, settings).execute();
}

class TicketRun {
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly tracker: Tracker;
  private readonly startedAt: number;
  private readonly deadline: number;
  private readonly layoutHome: { layout?: Layout } = {};
  private ticket: TicketSnapshot | undefined;
  private sandbox: SandboxHandle | undefined;
  private statusCommentId: string | undefined;
  private costUsd: number | undefined;
  private turns: number | undefined;
  private fixRounds = 0;

  constructor(
    private readonly deps: RunDeps,
    private readonly request: RunRequest,
    private run: RunRecord,
    private settings: ProjectSettings,
  ) {
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? Date.now;
    this.tracker = request.dryRun ? new RecordingTracker(deps.tracker) : deps.tracker;
    this.startedAt = this.now();
    this.deadline = this.startedAt + deps.config.limits.minutes * 60_000;
  }

  async execute(): Promise<RunResult> {
    try {
      return await this.steps();
    } catch (error) {
      return await this.fail(error);
    }
  }

  // -------------------------------------------------------------------------

  private async steps(): Promise<RunResult> {
    const { config, scm, sandboxes, agent } = this.deps;
    const key = this.run.ticketKey;

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
    this.statusCommentId = await this.tracker.postComment(key, pickedUpDoc(ctx));
    this.update({ statusCommentId: this.statusCommentId });
    await this.tracker.updateLabels(key, {
      add: [config.jira.labels.working],
      remove: [config.jira.labels.trigger],
    });
    this.checkCancelled();

    // Sandbox (E1, E2, E3)
    this.setState('sandbox');
    const base = await scm.resolveBase(this.settings.repo, this.settings.baseBranch);
    this.update({ baseSha: base.sha });
    const secrets: SecretBinding[] = [];
    if (this.deps.modelKey.mode === 'egress') {
      const credential: SecretBinding = {
        name: this.deps.modelKey.secretName,
        host: agent.credential.host,
        header: agent.credential.header,
      };
      if (agent.credential.prefix) credential.prefix = agent.credential.prefix;
      secrets.push(credential);
    } else {
      this.log.warn(
        'The model key is passed into the sandbox environment. Run `lockkeeper secrets sync` to have E2B add it outside the sandbox instead.',
      );
    }
    const allowDomains = allowList({
      agentDomains: [agent.credential.host, ...agent.extraDomains],
      extra: config.sandbox.allow_domains,
      ...(config.sandbox.registries ? { registries: config.sandbox.registries } : {}),
    });
    this.log.step(`Starting a ${sandboxes.kind} sandbox`);
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
      idempotencyKey: `lockkeeper-${this.run.id}`,
      ...(config.sandbox.template ? { template: config.sandbox.template } : {}),
    };
    const sandbox = await sandboxes.create(spec);
    this.sandbox = sandbox;
    const layout = layoutFor(sandbox.homeDir);
    this.layoutHome.layout = layout;
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
    this.checkCancelled();

    // Clone with a read-only, single-repository, short-lived token (E3).
    this.setState('clone');
    this.log.step(`Cloning ${this.settings.repo} at ${base.sha.slice(0, 12)}`);
    const access = await scm.cloneAccess(this.settings.repo);
    await cloneRepo(sandbox, layout, access, base, this.stepTimeout(10 * 60_000));
    const instructions = await readInstructionFiles(sandbox, layout, base.sha);
    this.audit(
      'instructions',
      instructions.map((file) => ({ path: file.path, bytes: file.content.length })),
    );
    this.checkCancelled();

    // Setup (E6)
    this.setState('setup');
    let setup = this.settings.setup;
    let verify = this.settings.verify;
    if (setup === undefined || verify === undefined) {
      const root = await inspectRoot(sandbox, layout);
      const detected = detectCommands(root.files, root.packageJson);
      setup ??= detected.setup;
      verify ??= detected.verify;
      this.audit('detected_commands', detected);
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
    this.checkCancelled();

    // Implement, verify, fix (E4, E5, V1)
    const sessionId = randomUUID();
    this.update({ sessionId, workflow });
    const system = buildSystemPrompt({ workflow, workdir: layout.repo, verify, instructions });
    let prompt = buildTaskPrompt(ticket, workflow);
    this.audit('prompt', { round: 0, system, prompt });

    let report: AgentReport | undefined;
    let finalText = '';
    let checks: CheckResult[] = [];
    const draftReasons: string[] = [];
    for (let round = 0; ; round++) {
      this.setState('implement');
      await this.progress(
        ctx,
        round === 0
          ? 'the agent is implementing the ticket'
          : `fix round ${round}: the agent is fixing failed checks`,
      );
      this.log.step(
        round === 0 ? `${agent.displayName} is implementing ${key}` : `Fix round ${round}`,
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
        return this.noChanges(ctx, cleanAgentText(stripReport(finalText), 1_500));
      }

      this.setState('verify');
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
      this.audit('checks', { round, checks });
      const failures = checks.filter((check) => !check.passed);
      for (const check of checks) this.log.info(`${check.passed ? '✓' : '✗'} ${check.command}`);
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
      prompt = buildFixPrompt(
        failures.map((failure) => ({
          command: failure.command,
          exitCode: failure.exitCode,
          output: failure.output,
        })),
      );
      this.audit('prompt', { round: round + 1, prompt });
    }
    this.checkCancelled();

    // Package and check the result (V2)
    this.setState('collect');
    this.log.step('Collecting and checking the changes');
    const collected = await collectChanges(sandbox, layout, base.sha);
    const policy = checkContents(
      collected.contents,
      checkDiff(collected.files, {
        protectedPaths: this.settings.protectedPaths,
        maxAddedLines: config.limits.max_added_lines,
        maxChangedFiles: config.limits.max_changed_files,
      }),
    );
    this.audit('policy', { files: collected.files, findings: policy.findings });
    if (collected.files.length === 0)
      return this.noChanges(ctx, cleanAgentText(stripReport(finalText), 1_500));
    if (policy.blocked) {
      const blocking = policy.findings.filter((finding) => finding.severity === 'block');
      throw new StepFailedError(
        'collect',
        `Lockkeeper will not publish this change: ${blocking.map((finding) => `${finding.message}${finding.paths ? ` (${finding.paths.join(', ')})` : ''}`).join(' ')}`,
      );
    }

    const summary = cleanAgentText(report?.summary || stripReport(finalText), 1_500);
    const risks = (report?.risks ?? [])
      .slice(0, 10)
      .map((risk) => cleanAgentText(risk, 300))
      .filter(Boolean);
    const criteria = matchCriteria(ticket.acceptanceCriteria, report).map((criterion) => ({
      criterion: cleanAgentText(criterion.criterion, 300),
      met: criterion.met,
      evidence: cleanAgentText(criterion.evidence, 300),
    }));
    draftReasons.unshift(...this.draftReasons(checks, verify, policy, criteria, ticket));

    return this.publish({
      ctx,
      workflow,
      base,
      collected,
      policy,
      summary,
      risks,
      criteria,
      checks,
      draftReasons,
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
    if (failed.length > 0)
      reasons.push(`Checks failed: ${failed.map((check) => check.command).join(', ')}.`);
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
  }): Promise<RunResult> {
    const { config, scm } = this.deps;
    const { ctx, collected, policy } = input;
    const key = this.run.ticketKey;
    const ticket = ctx.ticket;

    this.setState('publish');
    await this.progress(ctx, 'Lockkeeper is opening the pull request');
    const branch = await this.availableBranch(branchName(input.workflow, key, ticket.summary));
    const title = titleFor(key, ticket.summary);
    const durationMs = this.now() - this.startedAt;
    const body = capPullRequestBody(
      docToMarkdown(
        pullRequestBodyDoc({
          ctx,
          summary: input.summary,
          addedLines: policy.addedLines,
          removedLines: policy.removedLines,
          fileCount: collected.files.length,
          criteria: input.criteria,
          checks: input.checks,
          findings: policy.findings,
          risks: input.risks,
          draftReasons: input.draftReasons,
          costUsd: this.costUsd,
          durationMs,
          fixRounds: this.fixRounds,
        }),
      ),
    );
    const draft = input.draftReasons.length > 0;

    if (this.request.dryRun) {
      const outcome = {
        pr: { url: '(dry run: no pull request)', number: 0, draft },
        branch,
        criteria: input.criteria,
        checks: input.checks,
        draftReasons: input.draftReasons,
        summary: input.summary,
        costUsd: this.costUsd,
        durationMs,
        fixRounds: this.fixRounds,
      };
      if (this.statusCommentId)
        await this.tracker.updateComment(key, this.statusCommentId, resultDoc(ctx, outcome));
      await this.sandbox?.destroy();
      this.sandbox = undefined;
      this.update({
        state: 'done',
        finishedAt: new Date(this.now()).toISOString(),
        costUsd: this.costUsd ?? null,
      });
      return {
        outcome: 'dry_run',
        run: this.run,
        preview: {
          branch,
          title,
          body,
          comments: (this.tracker as RecordingTracker)
            .comments()
            .map((comment) => docToPlainText(comment.body)),
          files: collected.files.map((file) => ({
            path: file.path,
            status: file.status,
            added: file.added,
            removed: file.removed,
          })),
          draftReasons: input.draftReasons,
        },
      };
    }

    // V3: commits and the PR are created here, under the App identity, never in the sandbox.
    const message = `${title}\n\n${input.summary}\n\nTicket: ${ticket.url}\nLockkeeper-Run: ${this.run.id}\nAgent: ${this.deps.agent.displayName}\n`;
    const commit = await scm.commit({
      repo: this.settings.repo,
      branch,
      parentSha: input.base.sha,
      message,
      changes: collected.changes,
      createBranch: true,
    });
    this.update({ branch, headSha: commit.sha });
    this.audit('commit', {
      sha: commit.sha,
      url: commit.url,
      verified: commit.verified,
      branch,
      paths: collected.files.map((file) => file.path),
    });
    this.log.step(`Committed ${commit.sha.slice(0, 12)} to ${branch}`);

    const pr = await scm.openPullRequest({
      repo: this.settings.repo,
      head: branch,
      base: this.settings.baseBranch,
      title,
      body,
      draft,
    });
    this.update({ prNumber: pr.number, prUrl: pr.url });
    this.audit('pull_request', pr);
    this.log.step(`Opened ${pr.draft || draft ? 'draft ' : ''}pull request ${pr.url}`);

    // J1, J2
    this.setState('report');
    const outcome = {
      pr: { url: pr.url, number: pr.number, draft },
      branch,
      criteria: input.criteria,
      checks: input.checks,
      draftReasons: input.draftReasons,
      summary: input.summary,
      costUsd: this.costUsd,
      durationMs: this.now() - this.startedAt,
      fixRounds: this.fixRounds,
    };
    if (this.statusCommentId)
      await this.tracker.updateComment(key, this.statusCommentId, resultDoc(ctx, outcome));
    await this.tracker.postComment(key, finalNoticeDoc(ctx, { kind: 'pr', url: pr.url, draft }));
    await this.tracker.linkPullRequest(key, { url: pr.url, title });
    await this.tracker.updateLabels(key, {
      add: [config.jira.labels.in_review],
      remove: [config.jira.labels.working],
    });
    const transition = config.jira.transitions.in_review;
    if (transition && !(await this.tracker.transition(key, transition))) {
      this.log.warn(`No "${transition}" transition is available on ${key}.`);
    }

    // F2: park the sandbox while the PR is in review.
    if (this.sandbox) {
      if (this.deps.sandboxes.capabilities.pause) await this.sandbox.pause();
      else await this.sandbox.destroy();
    }
    this.update({ state: 'in_review', costUsd: this.costUsd ?? null, turns: this.turns ?? null });
    return { outcome: 'pr', run: this.run, pr, draftReasons: input.draftReasons };
  }

  // -------------------------------------------------------------------------

  private async runAgent(
    round: number,
    input: { system: string; prompt: string; sessionId: string },
  ): Promise<string> {
    const { config, agent, modelKey } = this.deps;
    const sandbox = this.sandbox as SandboxHandle;
    const layout = this.layoutHome.layout as Layout;
    const files = agentFiles(layout, round);
    await sandbox.exec(`mkdir -p '${files.dir}'`, { timeoutMs: 30_000 });
    await sandbox.writeFile(files.system, input.system);
    await sandbox.writeFile(files.prompt, input.prompt);
    const budget = Math.max(0.01, config.limits.cost_usd - (this.costUsd ?? 0));
    const invocation = {
      workdir: layout.repo,
      promptFile: files.prompt,
      systemPromptFile: files.system,
      sessionId: input.sessionId,
      resume: round > 0,
      maxTurns: config.limits.turns,
      maxBudgetUsd: budget,
      ...(config.agent.model ? { model: config.agent.model } : {}),
    };
    const command = agent.command(invocation);
    const env = {
      ...agent.environment(),
      [agent.credential.env]: modelKey.mode === 'env' ? modelKey.value : PLACEHOLDER_KEY,
    };
    await this.extendSandbox(this.sandboxTimeout());
    await startAgent(sandbox, layout, files, command, env);
    this.audit('agent_start', { round, command, budgetUsd: budget });

    const watch = await watchAgent(sandbox, files, {
      adapter: agent,
      onEvent: (event) => this.onAgentEvent(event),
      deadline: this.deadline,
      pollMs: this.deps.pollMs ?? 3_000,
      keepAliveEveryMs: 60_000,
      sandboxTimeoutMs: this.sandboxTimeout(),
      now: this.now,
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      shouldStop: () => this.request.signal?.aborted ?? false,
    });
    this.audit('agent_exit', {
      round,
      stopped: watch.stopped,
      exitCode: watch.exitCode,
      outcome: watch.result?.outcome,
      stderr: tail(watch.stderr, 30),
    });
    if (watch.result?.costUsd !== undefined) this.costUsd = watch.result.costUsd;
    if (watch.result?.turns !== undefined)
      this.turns = Math.max(this.turns ?? 0, watch.result.turns);

    if (watch.stopped === 'cancelled')
      throw new RunCancelledError('The run was stopped before the agent finished.');
    if (watch.stopped === 'deadline') {
      throw new CapExceededError(
        'minutes',
        `The run reached its time limit of ${config.limits.minutes} minutes.`,
      );
    }
    const result = watch.result;
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
    return result.text;
  }

  private onAgentEvent(event: AgentEvent): void {
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
    this.audit('agent', stored);
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
    });
    return { outcome: 'no_changes', run: this.run };
  }

  private async refuse(reason: string, hint?: string): Promise<RunResult> {
    const ticket = this.ticket as TicketSnapshot;
    this.audit('refused', { reason });
    this.log.warn(`Refused: ${reason}`);
    try {
      await this.tracker.postComment(this.run.ticketKey, refusedDoc({ ticket }, reason, hint));
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

  private async fail(error: unknown): Promise<RunResult> {
    const err = error instanceof Error ? error : new Error(String(error));
    const state: RunState = err instanceof RunCancelledError ? 'cancelled' : 'failed';
    const reason = describeFailure(err);
    const logTail = err instanceof StepFailedError ? err.logTail : undefined;
    this.audit('error', {
      name: err.name,
      message: err.message,
      ...(err instanceof LockkeeperError && err.hint ? { hint: err.hint } : {}),
      ...(err instanceof CapExceededError ? { cap: err.cap } : {}),
      ...(err instanceof StepFailedError ? { step: err.step, logTail } : {}),
    });

    if (this.ticket && this.statusCommentId) {
      const ctx = this.context();
      const key = this.run.ticketKey;
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
        await this.tracker.postComment(key, finalNoticeDoc(ctx, { kind: 'failed', reason }));
        await this.tracker.updateLabels(key, {
          add: [this.deps.config.jira.labels.failed],
          remove: [this.deps.config.jira.labels.working],
        });
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
    });
    return { outcome: 'failed', run: this.run, error: err };
  }

  // -------------------------------------------------------------------------

  private context(): RunContext {
    return {
      ticket: this.ticket as TicketSnapshot,
      runId: this.run.id,
      agentName: this.deps.agent.displayName,
      limits: {
        costUsd: this.deps.config.limits.cost_usd,
        minutes: this.deps.config.limits.minutes,
      },
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

  private checkCancelled(): void {
    if (this.request.signal?.aborted)
      throw new RunCancelledError('The run was stopped from the command line.');
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

  private setState(state: RunState): void {
    this.update({ state });
    this.audit('state', { state });
  }

  private update(patch: Parameters<Store['updateRun']>[1]): void {
    this.run = this.deps.store.updateRun(this.run.id, patch, new Date(this.now()));
  }

  private audit(kind: string, data: unknown): void {
    this.deps.store.appendEvent(this.run.id, kind, data, new Date(this.now()));
  }
}

export function describeFailure(error: Error): string {
  if (error instanceof CapExceededError)
    return `Stopped at the ${error.cap.replace('_', ' ')} limit. ${error.message}`;
  if (error instanceof LockkeeperError)
    return redactSecrets(`${error.message}${error.hint ? ` ${error.hint}` : ''}`).text;
  return redactSecrets(`Lockkeeper hit an unexpected error: ${error.message}`).text;
}
