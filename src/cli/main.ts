#!/usr/bin/env node
import './warnings.js';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { Command } from 'commander';
import { projectSettings } from '../config/schema.js';
import { ENV } from '../config/secrets.js';
import { LockkeeperError } from '../core/errors.js';
import { consoleLogger } from '../core/log.js';
import { type RunResult, runTicket } from '../engine/run.js';
import {
  buildRunDeps,
  loadContext,
  makeAgent,
  makeE2B,
  makeScm,
  makeTracker,
  openStore,
} from './context.js';

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
      controller.abort();
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
          `${run.id}  ${run.ticketKey.padEnd(12)} ${run.state.padEnd(10)} ${cost.padEnd(7)} ${run.prUrl ?? run.error ?? ''}`,
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
          const sandbox = await makeE2B(context).connect(run.sandboxId);
          await sandbox.destroy();
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
