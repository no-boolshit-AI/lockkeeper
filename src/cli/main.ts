#!/usr/bin/env node
import './warnings.js';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { Command } from 'commander';
import { ClaudeCodeAdapter } from '../agent/claude-code.js';
import { loadEnvFile } from '../config/load.js';
import { projectSettings } from '../config/schema.js';
import { ENV } from '../config/secrets.js';
import { ConfigError, LockkeeperError } from '../core/errors.js';
import { consoleLogger, type Logger } from '../core/log.js';
import { Daemon } from '../daemon/daemon.js';
import { demoConfig, runDemo } from '../demo/demo.js';
import { demoTicket } from '../demo/sample.js';
import { type DoctorCheck, type DoctorDeps, runDoctor } from '../engine/doctor.js';
import { formatCost } from '../engine/report.js';
import { type ModelKey, type RunResult, runTicket } from '../engine/run.js';
import { E2BProvider } from '../sandbox/e2b/e2b-provider.js';
import { GitHubSourceControl } from '../scm/github/github-scm.js';
import { JiraClient } from '../tracker/jira/client.js';
import {
  buildRunDeps,
  loadContext,
  makeAgent,
  makeE2B,
  makeScm,
  makeTracker,
  openStore,
  resolveModelKey,
} from './context.js';
import { runInit } from './init.js';
import { terminalIo } from './terminal-io.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const program = new Command()
  .name('lockkeeper')
  .description(
    'Turn a labelled Jira ticket into a reviewable GitHub pull request, built by a coding agent in a sealed E2B sandbox.',
  )
  .version(pkg.version)
  .option('-c, --config <path>', 'path to lockkeeper.yml')
  .option('-v, --verbose', 'show every agent step');

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Text that came out of a sandbox, made safe for a terminal: no escape sequences or
 * other control characters that could rewrite what is on screen.
 */
function terminalSafe(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters on purpose
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');
}

/** The demo's model key: an E2B secret, stored from ANTHROPIC_API_KEY if it is not there. */
async function demoModelKey(
  e2b: E2BProvider,
  envName: string,
  secretName: string,
  log: Logger,
): Promise<ModelKey> {
  if (await e2b.hasSecret(secretName)) return { mode: 'egress', secretName };
  const value = process.env[envName]?.trim();
  if (!value) {
    throw new ConfigError(
      `Set ${envName} to your model API key.`,
      `The demo stores it as the E2B secret "${secretName}", so E2B adds it to the agent's requests outside the sandbox and the sandbox never sees it.`,
    );
  }
  await e2b.putSecret(secretName, value);
  log.step(
    `Stored your model key as the E2B secret "${secretName}". E2B adds it to the agent's requests outside the sandbox, so the sandbox never sees it.`,
  );
  return { mode: 'egress', secretName };
}

program
  .command('demo')
  .description(
    'Try Lockkeeper on a sample ticket and repository in a real sandbox. Nothing is written to GitHub or Jira',
  )
  .action(async () => {
    const globals = program.opts<{ verbose?: boolean }>();
    const log = consoleLogger({ verbose: Boolean(globals.verbose) });
    loadEnvFile(process.cwd());
    const agent = new ClaudeCodeAdapter();
    const e2bKey = process.env[ENV.e2bApiKey]?.trim();
    if (!e2bKey) {
      throw new ConfigError(
        `Set ${ENV.e2bApiKey} to an E2B API key.`,
        `Create one at https://e2b.dev/dashboard. The demo also needs ${agent.credential.env}.`,
      );
    }
    const config = demoConfig();
    const e2b = new E2BProvider({ apiKey: e2bKey });
    const modelKey = await demoModelKey(e2b, agent.credential.env, config.agent.secret_name, log);
    const ticket = demoTicket();
    out(`Lockkeeper demo: ${ticket.key} "${ticket.summary}", on a small sample shop library.`);
    out('The sandbox and the agent are real. Nothing is written to GitHub or Jira.\n');
    const controller = new AbortController();
    let interrupts = 0;
    const onSignal = () => {
      interrupts += 1;
      if (interrupts > 1) process.exit(130);
      log.warn('Stopping the demo (press Ctrl-C again to quit at once)…');
      controller.abort('The demo was stopped.');
    };
    process.on('SIGINT', onSignal);
    const started = Date.now();
    try {
      const result = await runDemo({
        sandboxes: e2b,
        agent,
        modelKey,
        config,
        log,
        signal: controller.signal,
      });
      printDemo(result, Date.now() - started);
      if (result.outcome !== 'dry_run') process.exitCode = 1;
    } finally {
      process.off('SIGINT', onSignal);
    }
  });

function printDemo(result: RunResult, durationMs: number): void {
  out();
  if (result.outcome !== 'dry_run') {
    printResult(result);
    return;
  }
  const { preview } = result;
  const rule = (title: string) =>
    out(`\n── ${title} ${'─'.repeat(Math.max(4, 60 - title.length))}\n`);
  rule('The change');
  out(terminalSafe(preview.diff).trimEnd() || '(no diff)');
  rule('The pull request it would open');
  out(`Title: ${preview.title}`);
  out(
    preview.draftReasons.length > 0
      ? `As a draft, because: ${preview.draftReasons.join(' ')}`
      : 'Ready for review.',
  );
  out();
  out(preview.body.trimEnd());
  rule('What it would post on the Jira ticket');
  for (const comment of preview.comments) out(`${comment.trimEnd()}\n`);
  const seconds = Math.round(durationMs / 1000);
  out(
    `Done in ${Math.floor(seconds / 60)} min ${seconds % 60} s for ${formatCost(result.run.costUsd ?? undefined)} of model use.`,
  );
  out('Next: `lockkeeper init` connects your Jira and GitHub. Then label a ticket.');
}

program
  .command('run')
  .description('Run one ticket now: snapshot, sandbox, agent, checks, pull request, ticket report')
  .argument('<ticket>', 'Jira issue key, such as SHOP-123')
  .option(
    '--dry-run',
    'do everything except write to Jira or GitHub, and print what would be posted',
  )
  .action(async (ticket: string, options: { dryRun?: boolean }) => {
    const globals = program.opts<{ config?: string; verbose?: boolean }>();
    const log = consoleLogger({ verbose: Boolean(globals.verbose) });
    const context = loadContext(globals.config);
    const { deps, close } = await buildRunDeps(context, log);
    const controller = new AbortController();
    let interrupts = 0;
    const onSignal = () => {
      interrupts += 1;
      if (interrupts > 1) process.exit(130);
      log.warn('Stopping the run (press Ctrl-C again to quit at once)…');
      controller.abort('The run was stopped from the command line.');
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    try {
      const result = await runTicket(deps, {
        ticketKey: ticket,
        triggeredBy: `cli:${userInfo().username}`,
        signal: controller.signal,
        ...(options.dryRun ? { dryRun: true } : {}),
      });
      printResult(result);
      if (result.outcome === 'failed') process.exitCode = 1;
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      close();
    }
  });

program
  .command('start')
  .description('Watch Jira for labelled tickets and run them, until stopped with Ctrl-C')
  .action(async () => {
    const globals = program.opts<{ config?: string; verbose?: boolean }>();
    const log = consoleLogger({ verbose: Boolean(globals.verbose) });
    const context = loadContext(globals.config);
    const { config } = context.loaded;
    const { deps, close } = await buildRunDeps(context, log);
    const daemon = new Daemon(deps, { pollMs: config.jira.poll_seconds * 1000 });
    log.step(
      `Watching ${Object.keys(config.projects).join(', ')} for the "${config.jira.labels.trigger}" label every ${config.jira.poll_seconds} s. Press Ctrl-C to stop.`,
    );
    if (daemon.openToAll) {
      log.warn(
        'jira.allow_users is empty, so any internal Jira user in these projects can start a run.',
      );
    }
    let interrupts = 0;
    const onSignal = () => {
      interrupts += 1;
      if (interrupts > 1) process.exit(130);
      log.warn(
        'Stopping. Runs in progress pause and continue at the next start (press Ctrl-C again to quit at once)…',
      );
      daemon.stop();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    try {
      await daemon.run();
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      close();
    }
  });

function printResult(result: RunResult): void {
  out();
  switch (result.outcome) {
    case 'pr':
      out(`Pull request: ${result.pr.url}${result.draftReasons.length > 0 ? ' (draft)' : ''}`);
      for (const reason of result.draftReasons) out(`  draft because: ${reason}`);
      break;
    case 'no_changes':
      out('The agent made no changes. See the ticket for its explanation.');
      break;
    case 'refused':
      out(`Not started: ${result.reason}`);
      break;
    case 'needs_info':
      out('The readiness check asked questions on the ticket:');
      for (const [index, question] of result.questions.entries())
        out(`  ${index + 1}. ${question}`);
      out(
        result.run.state === 'needs_info'
          ? 'Reply `/agent go` there with the answers, or run this command again once the ticket has them.'
          : 'This was a dry run, so nothing was posted.',
      );
      break;
    case 'declined':
      out(`Declined by the readiness check: ${result.reason}`);
      break;
    case 'detached':
      out(
        `Stopped in the ${result.run.state} step. Run the same command again to continue where it left off.`,
      );
      break;
    case 'failed': {
      const hint =
        result.error instanceof LockkeeperError && result.error.hint
          ? `\n  ${result.error.hint}`
          : '';
      out(`Run failed: ${result.error.message}${hint}`);
      break;
    }
    case 'dry_run': {
      const { preview } = result;
      out(`Dry run. Nothing was written to Jira or GitHub.\n`);
      out(`Branch: ${preview.branch}`);
      out(`Title:  ${preview.title}`);
      out(`Files:`);
      for (const file of preview.files) {
        out(
          `  ${file.status.padEnd(10)} ${file.path} (+${file.added ?? 'bin'} -${file.removed ?? 'bin'})`,
        );
      }
      for (const reason of preview.draftReasons) out(`Draft because: ${reason}`);
      out('\n--- Pull request body ---\n');
      out(preview.body);
      out('--- Jira comments ---\n');
      for (const comment of preview.comments) out(`${comment}\n`);
      if (preview.trackerChanges.length > 0) {
        out('--- Other Jira changes ---\n');
        for (const change of preview.trackerChanges) out(`  ${change}`);
        out();
      }
      break;
    }
  }
  out(`Run ${result.run.id} · state ${result.run.state}`);
}

program
  .command('check')
  .description(
    'Validate lockkeeper.yml and the credentials; with --live, also call Jira, GitHub and E2B',
  )
  .option('--live', 'check access to Jira, each repository and the E2B secret')
  .action(async (options: { live?: boolean }) => {
    const globals = program.opts<{ config?: string }>();
    const context = loadContext(globals.config);
    const { config } = context.loaded;
    out(`Config:   ${context.loaded.path}`);
    if (context.envFile) out(`Env file: ${context.envFile}`);
    out(`Jira:     ${config.jira.site} (trigger label "${config.jira.labels.trigger}")`);
    for (const key of Object.keys(config.projects)) {
      const settings = projectSettings(config, key);
      if (settings) out(`Project:  ${key} -> ${settings.repo} (${settings.baseBranch})`);
    }
    out(
      `Agent:    ${config.agent.use}, model key via ${config.agent.key_injection === 'egress' ? `E2B secret "${config.agent.secret_name}"` : 'sandbox environment'}`,
    );
    out(
      `Limits:   $${config.limits.cost_usd}, ${config.limits.minutes} min, ${config.limits.fix_rounds} fix rounds, ${config.limits.max_added_lines} added lines`,
    );
    let problems = 0;
    for (const missing of context.secrets.missing) {
      problems += 1;
      out(`✗ Missing ${missing.name}: ${missing.how}`);
    }
    if (config.agent.key_injection === 'env' && !process.env.ANTHROPIC_API_KEY) {
      problems += 1;
      out('✗ Missing ANTHROPIC_API_KEY (agent.key_injection is env)');
    }
    if (options.live && problems === 0) {
      problems += await liveChecks(context);
    }
    out(
      problems === 0
        ? '\nAll checks passed.'
        : `\n${problems} problem${problems === 1 ? '' : 's'} found.`,
    );
    if (problems > 0) process.exitCode = 1;
  });

async function liveChecks(context: ReturnType<typeof loadContext>): Promise<number> {
  const { config } = context.loaded;
  let problems = 0;
  const attempt = async (label: string, check: () => Promise<string>) => {
    try {
      out(`✓ ${label}: ${await check()}`);
    } catch (error) {
      problems += 1;
      const hint = error instanceof LockkeeperError && error.hint ? ` ${error.hint}` : '';
      out(`✗ ${label}: ${(error as Error).message}${hint}`);
    }
  };
  const tracker = makeTracker(context);
  await attempt('Jira', async () => {
    const me = await tracker.whoami();
    return `signed in as ${me.displayName}${me.accountType ? ` (${me.accountType})` : ''}`;
  });
  const scm = makeScm(context);
  for (const key of Object.keys(config.projects)) {
    const settings = projectSettings(config, key);
    if (!settings) continue;
    await attempt(`GitHub ${settings.repo}`, async () => {
      const base = await scm.resolveBase(settings.repo, settings.baseBranch);
      await scm.cloneAccess(settings.repo);
      return `${settings.baseBranch} at ${base.sha.slice(0, 12)}, read-only clone token issued`;
    });
  }
  const e2b = makeE2B(context);
  if (config.agent.key_injection === 'egress') {
    await attempt('E2B secret', async () => {
      if (!(await e2b.hasSecret(config.agent.secret_name))) {
        throw new LockkeeperError(
          `"${config.agent.secret_name}" does not exist.`,
          'Run `lockkeeper secrets sync`.',
        );
      }
      return `"${config.agent.secret_name}" exists`;
    });
  }
  return problems;
}

program
  .command('init')
  .description('Set up Lockkeeper step by step: Jira, a GitHub App, E2B and the model key')
  .option('--force', 'replace an existing lockkeeper.yml')
  .action(async (options: { force?: boolean }) => {
    await runInit(
      terminalIo(),
      {
        jira: (site, email, token) => new JiraClient({ site, email, token }),
        e2b: (apiKey) => new E2BProvider({ apiKey }),
        github: (appId, privateKey) => new GitHubSourceControl({ appId, privateKey }),
        fetch,
      },
      { dir: process.cwd(), ...(options.force ? { force: true } : {}) },
    );
  });

program
  .command('doctor')
  .description(
    'Check everything a run needs: credentials, permissions, a sandbox, the clone, setup, tests, the network policy and key injection',
  )
  .option('-p, --project <key>', 'check only this Jira project')
  .action(async (options: { project?: string }) => {
    const globals = program.opts<{ config?: string }>();
    const context = loadContext(globals.config);
    if (context.secrets.missing.length > 0) {
      for (const missing of context.secrets.missing)
        out(`✗ Missing ${missing.name}: ${missing.how}`);
      process.exitCode = 1;
      return;
    }
    const agent = makeAgent(context);
    const sandboxes = makeE2B(context);
    let modelKey: DoctorDeps['modelKey'];
    try {
      modelKey = await resolveModelKey(context, sandboxes, agent);
    } catch (error) {
      const hint = error instanceof LockkeeperError && error.hint ? { hint: error.hint } : {};
      modelKey = { problem: (error as Error).message, ...hint };
    }
    out(
      'Checking Lockkeeper. This starts a sandbox and runs setup and checks on the base branch.\n',
    );
    const checks = await runDoctor(
      {
        config: context.loaded.config,
        tracker: makeTracker(context),
        scm: makeScm(context),
        sandboxes,
        agent,
        modelKey,
      },
      {
        ...(options.project ? { projects: [options.project.toUpperCase()] } : {}),
        onCheck: printCheck,
      },
    );
    const failed = checks.filter((check) => check.status === 'fail').length;
    const warned = checks.filter((check) => check.status === 'warn').length;
    out(
      failed + warned === 0
        ? '\nEverything a run needs works.'
        : `\n${failed} problem${failed === 1 ? '' : 's'}, ${warned} warning${warned === 1 ? '' : 's'}.`,
    );
    if (failed > 0) process.exitCode = 1;
  });

function printCheck(check: DoctorCheck): void {
  const mark = { ok: '✓', warn: '!', fail: '✗', skip: '-' }[check.status];
  out(`${mark} ${check.name}: ${check.detail}`);
  if (check.fix) out(`  Fix: ${check.fix}`);
  if (check.log) for (const line of check.log.split('\n')) out(`    ${line}`);
}

const secrets = program
  .command('secrets')
  .description('Manage the secrets E2B adds outside the sandbox');

secrets
  .command('sync')
  .description(
    'Store the model key from the environment as an E2B secret, so it never enters a sandbox',
  )
  .action(async () => {
    const globals = program.opts<{ config?: string }>();
    const context = loadContext(globals.config);
    const agent = makeAgent(context);
    const value = process.env[agent.credential.env];
    if (!value)
      throw new LockkeeperError(
        `${agent.credential.env} is not set.`,
        'Set it in the environment or in .lockkeeper/.env.',
      );
    const e2b = makeE2B(context);
    const name = context.loaded.config.agent.secret_name;
    const action = await e2b.putSecret(name, value);
    out(`${action === 'created' ? 'Created' : 'Updated'} the E2B secret "${name}".`);
    out(
      `Runs now add it to requests for ${agent.credential.host} at E2B's egress proxy. The sandbox never sees it.`,
    );
  });

program
  .command('runs')
  .description('List recent runs, or show one run and its audit log')
  .argument('[run]', 'a run ID to show in full')
  .option('-n, --limit <n>', 'how many runs to list', '20')
  .action((runId: string | undefined, options: { limit: string }) => {
    const globals = program.opts<{ config?: string }>();
    const store = openStore(loadContext(globals.config));
    try {
      if (runId) {
        const run = store.getRun(runId);
        if (!run) throw new LockkeeperError(`No run ${runId}.`);
        for (const [field, value] of Object.entries(run))
          if (value !== null) out(`${field.padEnd(16)} ${value}`);
        out('\nAudit log:');
        for (const event of store.events(runId)) {
          const data = JSON.stringify(event.data);
          out(
            `  ${event.ts}  ${event.kind.padEnd(18)} ${data.length > 160 ? `${data.slice(0, 159)}…` : data}`,
          );
        }
        return;
      }
      const runs = store.listRuns({ limit: Number(options.limit) || 20 });
      if (runs.length === 0) out('No runs yet.');
      for (const run of runs) {
        const cost = run.costUsd === null ? '' : `$${run.costUsd.toFixed(2)}`;
        out(
          `${run.id}  ${run.ticketKey.padEnd(12)} ${run.kind.padEnd(7)} ${run.state.padEnd(10)} ${cost.padEnd(7)} ${run.prUrl ?? run.error ?? ''}`,
        );
      }
    } finally {
      store.close();
    }
  });

program
  .command('cancel')
  .description("Cancel a ticket's active run and delete its sandbox")
  .argument('<ticket>', 'Jira issue key')
  .action(async (ticket: string) => {
    const globals = program.opts<{ config?: string }>();
    const context = loadContext(globals.config);
    const store = openStore(context);
    try {
      const run = store.activeRunFor(ticket.toUpperCase());
      if (!run) {
        out(`${ticket} has no active run.`);
        return;
      }
      if (run.sandboxId) {
        try {
          // Deleted by ID, so a paused sandbox is not resumed just to be deleted.
          await makeE2B(context).deleteSandbox(run.sandboxId);
          store.updateRun(run.id, { sandboxId: null });
          out(`Deleted sandbox ${run.sandboxId}.`);
        } catch (error) {
          out(`Could not delete sandbox ${run.sandboxId}: ${(error as Error).message}`);
        }
      }
      store.updateRun(run.id, {
        state: 'cancelled',
        finishedAt: new Date().toISOString(),
        error: 'Cancelled from the CLI.',
      });
      store.appendEvent(run.id, 'cancelled', { by: `cli:${userInfo().username}` });
      out(`Cancelled run ${run.id}. Its pull request, if any, stays open.`);
    } finally {
      store.close();
    }
  });

program.addHelpText(
  'after',
  `
Credentials come from the environment or .lockkeeper/.env next to lockkeeper.yml:
  ${ENV.jiraEmail}, ${ENV.jiraToken}, ${ENV.e2bApiKey},
  ${ENV.githubAppId}, ${ENV.githubPrivateKey} or ${ENV.githubPrivateKeyPath},
  ANTHROPIC_API_KEY (only for \`secrets sync\`, or with agent.key_injection: env)`,
);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const err = error as Error;
  process.stderr.write(`✗ ${err.message}\n`);
  if (error instanceof LockkeeperError && error.hint) process.stderr.write(`  ${error.hint}\n`);
  if (!(error instanceof LockkeeperError) && process.env.LOCKKEEPER_DEBUG)
    process.stderr.write(`${err.stack}\n`);
  process.exitCode = 1;
}
