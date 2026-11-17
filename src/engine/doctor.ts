import type { AgentAdapter } from '../agent/agent.js';
import { type Config, type ProjectSettings, projectSettings } from '../config/schema.js';
import { errorMessage, LockkeeperError } from '../core/errors.js';
import type { SandboxHandle, SandboxProvider, SecretBinding } from '../sandbox/sandbox.js';
import { CI_PERMISSIONS, type SourceControl } from '../scm/scm.js';
import type { Tracker, TrackerAbility } from '../tracker/tracker.js';
import { detectCommands } from './detect.js';
import { allowList } from './domains.js';
import { resolveCommands } from './environment.js';
import { type ModelKey, templateFor } from './run.js';
import {
  cloneRepo,
  inspectRoot,
  type Layout,
  layoutFor,
  readInstructionFiles,
  runCommands,
  tail,
} from './workspace.js';

/**
 * `lockkeeper doctor` (O1): one command that checks everything a run needs, the way a
 * run does it, and says how to fix each problem: credentials, Jira permissions, the
 * GitHub App and branch rules, then a real sandbox with the clone, setup, the tests on
 * the base branch, the network policy and key injection.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
  log?: string;
}

export interface DoctorDeps {
  config: Config;
  tracker: Tracker;
  scm: SourceControl;
  sandboxes: SandboxProvider;
  agent: AgentAdapter;
  /** How the model key reaches the model API, or why it cannot. */
  modelKey: ModelKey | { problem: string; hint?: string };
  now?: () => number;
}

/** Rule types that can stop the App from creating its branches or commits. */
const BLOCKING_RULES = new Set([
  'creation',
  'update',
  'branch_name_pattern',
  'commit_message_pattern',
  'commit_author_email_pattern',
  'committer_email_pattern',
]);

const ABILITY_WORDS: Record<TrackerAbility, string> = {
  browse: 'see the project',
  comment: 'add comments',
  edit: 'change labels',
  link: 'link pull requests',
  transition: 'move tickets to another status',
};

function listWords(words: string[]): string {
  return words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
}

export async function runDoctor(
  deps: DoctorDeps,
  options: { projects?: string[]; onCheck?: (check: DoctorCheck) => void } = {},
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck): DoctorCheck => {
    checks.push(check);
    options.onCheck?.(check);
    return check;
  };
  const attempt = async (
    name: string,
    run: () => Promise<Omit<DoctorCheck, 'name'>>,
  ): Promise<DoctorCheck> => {
    try {
      return add({ name, ...(await run()) });
    } catch (error) {
      const fix = error instanceof LockkeeperError && error.hint ? { fix: error.hint } : {};
      return add({ name, status: 'fail', detail: errorMessage(error), ...fix });
    }
  };
  const { config, tracker, scm } = deps;

  const jira = await attempt('Jira account', async () => {
    const me = await tracker.whoami();
    return { status: 'ok', detail: `signed in as ${me.displayName}` };
  });

  const keys = options.projects ?? Object.keys(config.projects);
  const repos = new Map<string, ProjectSettings>();
  for (const key of keys) {
    const settings = projectSettings(config, key);
    if (!settings) {
      add({
        name: `Project ${key}`,
        status: 'fail',
        detail: 'not in lockkeeper.yml',
        fix: 'Add it under projects:.',
      });
      continue;
    }
    if (jira.status === 'ok') {
      await attempt(`Jira project ${key}`, async () => {
        const needed: TrackerAbility[] = ['browse', 'comment', 'edit', 'link'];
        if (config.jira.transitions.in_review) needed.push('transition');
        const missing = await tracker.missingAbilities(key, needed);
        return missing.length === 0
          ? { status: 'ok', detail: 'can read tickets, comment, change labels and link PRs' }
          : {
              status: 'fail',
              detail: `the Jira account cannot ${listWords(missing.map((ability) => ABILITY_WORDS[ability]))}`,
              fix: `Grant those permissions in ${key}'s permission scheme, or use an account that has them.`,
            };
      });
    }
    const repo = await attempt(`GitHub ${settings.repo}`, async () => {
      const missing = await scm.missingPermissions(settings.repo);
      if (missing.length > 0) {
        return {
          status: 'fail',
          detail: `the GitHub App lacks ${missing.join(', ')}`,
          fix: 'Add the permissions in the App settings, then accept them on the installation.',
        };
      }
      const base = await scm.resolveBase(settings.repo, settings.baseBranch);
      return {
        status: 'ok',
        detail: `the App is installed; ${settings.baseBranch} is at ${base.sha.slice(0, 12)}`,
      };
    });
    if (repo.status !== 'ok') continue;
    if (config.ci.fix_rounds > 0) {
      await attempt(`CI access in ${settings.repo}`, async () => {
        const missing = await scm.missingPermissions(settings.repo, CI_PERMISSIONS);
        return missing.length === 0
          ? { status: 'ok', detail: 'can read checks, commit statuses and job logs' }
          : {
              status: 'warn',
              detail: `CI fix rounds need ${missing.join(', ')}`,
              fix: 'Add them in the GitHub App settings and accept them on the installation, or set ci.fix_rounds: 0.',
            };
      });
    }
    await attempt(`Branch rules in ${settings.repo}`, async () => {
      const found = new Set<string>();
      for (const workflow of ['feature', 'bugfix']) {
        const rules = await scm.branchRules(settings.repo, `${workflow}/${key}-1-doctor`);
        for (const rule of rules)
          if (BLOCKING_RULES.has(rule.type)) found.add(`${rule.type} (${workflow}/*)`);
      }
      return found.size === 0
        ? { status: 'ok', detail: 'no rule blocks the branches Lockkeeper creates' }
        : {
            status: 'fail',
            detail: `these rules may block Lockkeeper's branches: ${[...found].join(', ')}`,
            fix: 'Add the GitHub App as a bypass actor in those rulesets, or exclude feature/** and bugfix/**.',
          };
    });
    if (!repos.has(settings.repo)) repos.set(settings.repo, settings);
  }

  const key = deps.modelKey;
  if ('problem' in key) {
    add({
      name: 'Model key',
      status: 'fail',
      detail: key.problem,
      ...(key.hint ? { fix: key.hint } : {}),
    });
  } else if (key.mode === 'egress') {
    add({
      name: 'Model key',
      status: 'ok',
      detail: `stored as the E2B secret "${key.secretName}"`,
    });
  } else {
    add({
      name: 'Model key',
      status: 'warn',
      detail: 'passed into the sandbox environment (agent.key_injection: env)',
      fix: 'Run `lockkeeper secrets sync` and set agent.key_injection: egress, so the key never enters a sandbox.',
    });
  }

  for (const settings of repos.values()) {
    await sandboxChecks(deps, settings, add);
  }
  return checks;
}

async function sandboxChecks(
  deps: DoctorDeps,
  settings: ProjectSettings,
  add: (check: DoctorCheck) => DoctorCheck,
): Promise<void> {
  const { config, scm, sandboxes, agent } = deps;
  const now = deps.now ?? Date.now;
  const key = 'problem' in deps.modelKey ? undefined : deps.modelKey;
  const where = settings.repo;
  const secrets: SecretBinding[] =
    key?.mode === 'egress'
      ? [{ name: key.secretName, host: agent.credential.host, header: agent.credential.header }]
      : [];
  const allowDomains = allowList({
    agentDomains: [agent.credential.host, ...agent.extraDomains],
    extra: config.sandbox.allow_domains,
    ...(config.sandbox.registries ? { registries: config.sandbox.registries } : {}),
  });

  const started = now();
  let sandbox: SandboxHandle;
  try {
    sandbox = await sandboxes.create({
      timeoutMs: 20 * 60_000,
      metadata: { lockkeeper: 'doctor', repo: where },
      allowDomains,
      secrets,
      ...templateFor(config, agent),
    });
  } catch (error) {
    add({ name: `Sandbox for ${where}`, status: 'fail', detail: errorMessage(error) });
    return;
  }
  add({
    name: `Sandbox for ${where}`,
    status: 'ok',
    detail: `started on ${sandboxes.displayName} in ${((now() - started) / 1000).toFixed(1)} s`,
  });

  try {
    const layout = layoutFor(sandbox.homeDir);
    const version = await sandbox.exec(agent.versionCommand(), { timeoutMs: 60_000 });
    add(
      version.exitCode === 0
        ? { name: agent.displayName, status: 'ok', detail: version.stdout.trim() }
        : {
            name: agent.displayName,
            status: 'fail',
            detail: 'it is not installed in the sandbox template',
            fix: `Use E2B's "${agent.defaultTemplate ?? 'claude'}" template, or set agent.version to install a pinned version.`,
          },
    );
    for (const requirement of agent.requirements({ keyInEnvironment: key?.mode === 'env' })) {
      const check = await sandbox.exec(requirement.check, { timeoutMs: 30_000 });
      if (check.exitCode !== 0)
        add({
          name: 'Sandbox requirement',
          status: 'fail',
          detail: requirement.problem,
          fix: requirement.hint,
        });
    }

    const base = await scm.resolveBase(where, settings.baseBranch);
    try {
      await cloneRepo(sandbox, layout, await scm.cloneAccess(where), base, 10 * 60_000);
      add({ name: 'Clone', status: 'ok', detail: `read-only clone of ${settings.baseBranch}` });
    } catch (error) {
      add({ name: 'Clone', status: 'fail', detail: errorMessage(error) });
      return;
    }

    const root = await inspectRoot(sandbox, layout);
    const instructions = await readInstructionFiles(sandbox, layout, base.sha);
    const [devcontainer] = await readInstructionFiles(sandbox, layout, base.sha, [
      '.devcontainer/devcontainer.json',
      '.devcontainer.json',
    ]);
    const commands = resolveCommands({
      configured: { setup: settings.setup, verify: settings.verify },
      devcontainer: devcontainer?.content,
      agentsMd: instructions.find((file) => file.path === 'AGENTS.md')?.content,
      detected: detectCommands(root.files, root.packageJson),
    });

    if (commands.setup.length === 0) {
      add({ name: 'Setup', status: 'ok', detail: 'nothing to run' });
    } else {
      const results = await runCommands(sandbox, layout, commands.setup, {
        timeoutMs: config.limits.setup_minutes * 60_000,
        stopOnFailure: true,
        now,
      });
      const failed = results.find((result) => !result.passed);
      add(
        failed
          ? {
              name: 'Setup',
              status: 'fail',
              detail: `\`${failed.command}\` exited with code ${failed.exitCode} (from ${commands.sources.setup})`,
              fix: 'Fix the command, or set repo.setup in lockkeeper.yml.',
              log: tail(failed.output, 20),
            }
          : {
              name: 'Setup',
              status: 'ok',
              detail: `${commands.setup.join(' && ')} (from ${commands.sources.setup})`,
            },
      );
      if (failed) return;
    }

    if (commands.verify.length === 0) {
      add({
        name: `Checks on ${settings.baseBranch}`,
        status: 'warn',
        detail: 'no lint or test commands are configured or found',
        fix: 'Set repo.verify in lockkeeper.yml, or name the commands in AGENTS.md. Without checks, every PR stays a draft.',
      });
    } else {
      const results = await runCommands(sandbox, layout, commands.verify, {
        timeoutMs: config.limits.verify_minutes * 60_000,
        stopOnFailure: false,
        now,
      });
      const failed = results.filter((result) => !result.passed);
      add(
        failed.length > 0
          ? {
              name: `Checks on ${settings.baseBranch}`,
              status: 'warn',
              detail: `${failed.map((result) => `\`${result.command}\``).join(', ')} already fail(s) before any change`,
              fix: "Lockkeeper's PRs stay drafts while checks fail. Fix them on the base branch, or change repo.verify.",
              log: tail(failed[0]?.output ?? '', 20),
            }
          : {
              name: `Checks on ${settings.baseBranch}`,
              status: 'ok',
              detail: `${commands.verify.join(', ')} pass (from ${commands.sources.verify})`,
            },
      );
    }

    await networkChecks(deps, sandbox, layout, allowDomains, add);
  } finally {
    await sandbox.destroy().catch(() => undefined);
  }
}

async function httpCode(
  sandbox: SandboxHandle,
  url: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const flags = Object.entries(headers)
    .map(([name, value]) => `-H '${name}: ${value}'`)
    .join(' ');
  const result = await sandbox.exec(
    `curl -s -o /dev/null -w '%{http_code}' -m 15 ${flags} '${url}'`,
    { timeoutMs: 60_000 },
  );
  return Number.parseInt(result.stdout.trim(), 10) || 0;
}

async function networkChecks(
  deps: DoctorDeps,
  sandbox: SandboxHandle,
  _layout: Layout,
  allowDomains: string[],
  add: (check: DoctorCheck) => DoctorCheck,
): Promise<void> {
  const { sandboxes, agent } = deps;
  if (!sandboxes.capabilities.egressAllowList) {
    add({
      name: 'Network policy',
      status: 'skip',
      detail: `${sandboxes.displayName} has no egress policy`,
    });
  } else {
    const allowed = allowDomains.find((domain) => domain.startsWith('registry.')) ?? 'github.com';
    const reachable = await httpCode(sandbox, `https://${allowed}/`);
    const blocked = await httpCode(sandbox, 'https://example.com/');
    if (blocked !== 0) {
      add({
        name: 'Network policy',
        status: 'fail',
        detail: 'the sandbox reached example.com, which is not on the allow-list',
        fix: "Check sandbox.allow_domains in lockkeeper.yml and E2B's network settings.",
      });
    } else if (reachable === 0) {
      add({
        name: 'Network policy',
        status: 'warn',
        detail: `the sandbox could not reach ${allowed}, which is on the allow-list`,
        fix: 'Check that E2B allows outbound traffic for this account.',
      });
    } else {
      add({
        name: 'Network policy',
        status: 'ok',
        detail: `${allowed} works; example.com is blocked`,
      });
    }
  }

  const key = 'problem' in deps.modelKey ? undefined : deps.modelKey;
  const probe = agent.credential.probe;
  if (key?.mode !== 'egress' || !probe) return;
  if (!sandboxes.capabilities.secretInjection) {
    add({
      name: 'Key injection',
      status: 'skip',
      detail: `${sandboxes.displayName} cannot add secrets`,
    });
    return;
  }
  // A wrong key on purpose: the egress proxy replaces it with the real one.
  const code = await httpCode(sandbox, probe.url, {
    ...probe.headers,
    [agent.credential.header]: 'lockkeeper-doctor-wrong-key',
  });
  if (code >= 200 && code < 300) {
    add({
      name: 'Key injection',
      status: 'ok',
      detail: 'E2B adds the model key outside the sandbox',
    });
  } else if (code === 401 || code === 403) {
    add({
      name: 'Key injection',
      status: 'fail',
      detail: `the model API refused the key E2B added (HTTP ${code})`,
      fix: 'Run `lockkeeper secrets sync` with a valid key.',
    });
  } else {
    add({
      name: 'Key injection',
      status: 'warn',
      detail: `the model API answered HTTP ${code || 'nothing'}`,
      fix: 'Try again; if it persists, check the model provider status.',
    });
  }
}
