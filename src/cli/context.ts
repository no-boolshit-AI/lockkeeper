import { ClaudeCodeAdapter } from '../agent/claude-code.js';
import { type LoadedConfig, loadConfig, loadEnvFile } from '../config/load.js';
import { readSecrets, requireSecrets, type SecretsResult } from '../config/secrets.js';
import { ConfigError } from '../core/errors.js';
import type { Logger } from '../core/log.js';
import type { ModelKey, RunDeps } from '../engine/run.js';
import { E2BProvider } from '../sandbox/e2b/e2b-provider.js';
import { GitHubSourceControl } from '../scm/github/github-scm.js';
import { Store } from '../store/store.js';
import { JiraClient } from '../tracker/jira/client.js';
import { JiraTracker } from '../tracker/jira/jira-tracker.js';

export interface CliContext {
  loaded: LoadedConfig;
  secrets: SecretsResult;
  envFile: string | undefined;
}

export function loadContext(configPath?: string): CliContext {
  const loaded = loadConfig(configPath);
  const envFile = loadEnvFile(loaded.dir);
  return { loaded, secrets: readSecrets(loaded.config, process.env, loaded.dir), envFile };
}

export function openStore(context: CliContext): Store {
  return Store.open(context.loaded.config.store.path);
}

export function makeAgent(context: CliContext): ClaudeCodeAdapter {
  const use = context.loaded.config.agent.use;
  if (use !== 'claude-code') throw new ConfigError(`Unknown agent: ${use}`);
  return new ClaudeCodeAdapter();
}

export function makeE2B(context: CliContext): E2BProvider {
  const { e2bApiKey } = requireSecrets(context.secrets, ['e2bApiKey']);
  const template = context.loaded.config.sandbox.template;
  return new E2BProvider({ apiKey: e2bApiKey, ...(template ? { template } : {}) });
}

export function makeTracker(context: CliContext): JiraTracker {
  const { config } = context.loaded;
  const { jiraEmail, jiraToken } = requireSecrets(context.secrets, ['jiraEmail', 'jiraToken']);
  const client = new JiraClient({ site: config.jira.site, email: jiraEmail, token: jiraToken });
  return new JiraTracker(client, {
    site: config.jira.site,
    ...(config.jira.acceptance_criteria_field
      ? { acceptanceCriteriaField: config.jira.acceptance_criteria_field }
      : {}),
  });
}

export function makeScm(context: CliContext): GitHubSourceControl {
  const { githubAppId, githubPrivateKey } = requireSecrets(context.secrets, [
    'githubAppId',
    'githubPrivateKey',
  ]);
  return new GitHubSourceControl({ appId: githubAppId, privateKey: githubPrivateKey });
}

/** Decide how the model key reaches the model API, failing closed when egress injection is not set up. */
export async function resolveModelKey(
  context: CliContext,
  e2b: E2BProvider,
  agent: ClaudeCodeAdapter,
): Promise<ModelKey> {
  const { config } = context.loaded;
  if (config.agent.key_injection === 'egress') {
    const name = config.agent.secret_name;
    if (!(await e2b.hasSecret(name))) {
      throw new ConfigError(
        `The E2B secret "${name}" does not exist, so the model key cannot be added outside the sandbox.`,
        `Run \`lockkeeper secrets sync\` with ${agent.credential.env} set, or set agent.key_injection: env to pass the key into the sandbox instead.`,
      );
    }
    return { mode: 'egress', secretName: name };
  }
  const value = process.env[agent.credential.env];
  if (!value) {
    throw new ConfigError(`agent.key_injection is env, but ${agent.credential.env} is not set.`);
  }
  return { mode: 'env', value };
}

export async function buildRunDeps(
  context: CliContext,
  log: Logger,
): Promise<{ deps: RunDeps; close: () => void }> {
  const agent = makeAgent(context);
  const sandboxes = makeE2B(context);
  const tracker = makeTracker(context);
  const scm = makeScm(context);
  const modelKey = await resolveModelKey(context, sandboxes, agent);
  const store = openStore(context);
  return {
    deps: { config: context.loaded.config, tracker, scm, sandboxes, agent, store, modelKey, log },
    close: () => store.close(),
  };
}
