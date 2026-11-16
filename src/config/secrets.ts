import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { ConfigError } from '../core/errors.js';
import type { Config } from './schema.js';

/**
 * Credentials live in the environment (or `.lockkeeper/.env`), never in lockkeeper.yml.
 * Only the control plane reads them. None of them is passed into a sandbox, except the
 * model key when the sandbox provider has no secret injection (with a warning).
 */
export interface Secrets {
  jiraEmail: string;
  jiraToken: string;
  e2bApiKey: string;
  githubAppId: string;
  githubPrivateKey: string;
}

export const ENV = {
  jiraEmail: 'LOCKKEEPER_JIRA_EMAIL',
  jiraToken: 'LOCKKEEPER_JIRA_TOKEN',
  e2bApiKey: 'E2B_API_KEY',
  githubAppId: 'LOCKKEEPER_GITHUB_APP_ID',
  githubPrivateKey: 'LOCKKEEPER_GITHUB_PRIVATE_KEY',
  githubPrivateKeyPath: 'LOCKKEEPER_GITHUB_PRIVATE_KEY_PATH',
} as const;

export interface SecretsResult {
  secrets: Partial<Secrets>;
  missing: { name: keyof Secrets; how: string }[];
}

/**
 * @param baseDir where relative paths in the environment resolve: the config file's
 *   folder, so `.lockkeeper/github-app.pem` works wherever the command runs.
 */
export function readSecrets(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  baseDir = process.cwd(),
): SecretsResult {
  const secrets: Partial<Secrets> = {};
  const missing: SecretsResult['missing'] = [];
  // An empty `NAME=` line in .env means "not set", so the config fallback still applies.
  const fromEnv = (name: string) => env[name]?.trim() || undefined;

  const jiraEmail = fromEnv(ENV.jiraEmail) ?? config.jira.email;
  if (jiraEmail) secrets.jiraEmail = jiraEmail;
  else missing.push({ name: 'jiraEmail', how: `set ${ENV.jiraEmail} or jira.email` });

  const jiraToken = fromEnv(ENV.jiraToken);
  if (jiraToken) secrets.jiraToken = jiraToken;
  else missing.push({ name: 'jiraToken', how: `set ${ENV.jiraToken} to a Jira API token` });

  const e2bApiKey = fromEnv(ENV.e2bApiKey);
  if (e2bApiKey) secrets.e2bApiKey = e2bApiKey;
  else missing.push({ name: 'e2bApiKey', how: `set ${ENV.e2bApiKey}` });

  const appId = fromEnv(ENV.githubAppId) ?? config.github.app_id?.toString();
  if (appId) secrets.githubAppId = appId;
  else missing.push({ name: 'githubAppId', how: `set ${ENV.githubAppId} or github.app_id` });

  const inlineKey = fromEnv(ENV.githubPrivateKey);
  const envKeyPath = fromEnv(ENV.githubPrivateKeyPath);
  const keyPath = envKeyPath
    ? isAbsolute(envKeyPath)
      ? envKeyPath
      : resolve(baseDir, envKeyPath)
    : config.github.private_key_path;
  if (inlineKey) {
    secrets.githubPrivateKey = inlineKey.replace(/\\n/g, '\n');
  } else if (keyPath && existsSync(keyPath)) {
    secrets.githubPrivateKey = readFileSync(keyPath, 'utf8');
  } else if (keyPath) {
    missing.push({ name: 'githubPrivateKey', how: `the key file ${keyPath} does not exist` });
  } else {
    missing.push({
      name: 'githubPrivateKey',
      how: `set ${ENV.githubPrivateKey}, ${ENV.githubPrivateKeyPath} or github.private_key_path`,
    });
  }

  return { secrets, missing };
}

export function requireSecrets(
  result: SecretsResult,
  names: readonly (keyof Secrets)[],
): Pick<Secrets, (typeof names)[number]> {
  const missing = result.missing.filter((entry) => names.includes(entry.name));
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing credentials:\n${missing.map((entry) => `  - ${entry.name}: ${entry.how}`).join('\n')}`,
      'Put them in the environment or in .lockkeeper/.env next to lockkeeper.yml.',
    );
  }
  return result.secrets as Secrets;
}
