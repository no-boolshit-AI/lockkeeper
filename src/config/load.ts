import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { ConfigError } from '../core/errors.js';
import { type Config, configSchema } from './schema.js';

export interface LoadedConfig {
  config: Config;
  /** Absolute path of the config file. */
  path: string;
  /** Directory relative paths in the config resolve against. */
  dir: string;
}

export const DEFAULT_CONFIG_FILE = 'lockkeeper.yml';

function issueMessage(issue: z.core.$ZodIssue): string {
  // Record keys: show why the key is wrong, not just that it is.
  if (issue.code === 'invalid_key' && issue.issues.length > 0) {
    return issue.issues.map((inner) => inner.message).join('; ');
  }
  if (issue.code === 'invalid_type' && /received undefined$/.test(issue.message))
    return 'is required';
  return issue.message;
}

export function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join('.') || '(root)';
      return `  - ${path}: ${issueMessage(issue)}`;
    })
    .join('\n');
}

/**
 * A YAML key with no value, such as a section whose entries are all commented out,
 * parses as null. In this config null never means anything but "not set".
 */
function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => [key, dropNulls(entry)]),
  );
}

export function parseConfig(source: string, origin = DEFAULT_CONFIG_FILE): Config {
  let raw: unknown;
  try {
    raw = parseYaml(source, { prettyErrors: true });
  } catch (error) {
    throw new ConfigError(`${origin} is not valid YAML: ${(error as Error).message}`);
  }
  const result = configSchema.safeParse(dropNulls(raw ?? {}));
  if (!result.success) {
    throw new ConfigError(
      `${origin} has ${result.error.issues.length === 1 ? 'a problem' : 'problems'}:\n${formatIssues(result.error.issues)}`,
      'Compare it with lockkeeper.example.yml.',
    );
  }
  return result.data;
}

export function loadConfig(path?: string, cwd = process.cwd()): LoadedConfig {
  const file = resolve(cwd, path ?? process.env.LOCKKEEPER_CONFIG ?? DEFAULT_CONFIG_FILE);
  if (!existsSync(file)) {
    throw new ConfigError(
      `No config file at ${file}.`,
      'Copy lockkeeper.example.yml to lockkeeper.yml, or pass --config <path>.',
    );
  }
  const config = parseConfig(readFileSync(file, 'utf8'), file);
  const dir = dirname(file);
  config.store.path = resolvePath(dir, config.store.path);
  if (config.github.private_key_path) {
    config.github.private_key_path = resolvePath(dir, config.github.private_key_path);
  }
  return { config, path: file, dir };
}

function resolvePath(base: string, value: string): string {
  return isAbsolute(value) ? value : resolve(base, value);
}

/**
 * Load `.lockkeeper/.env` next to the config. Variables already set in the environment
 * win, so a deployment can override any of them.
 */
export function loadEnvFile(dir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = resolve(dir, '.lockkeeper', '.env');
  if (!existsSync(file)) return undefined;
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined && value !== undefined) env[key] = value;
  }
  return file;
}
