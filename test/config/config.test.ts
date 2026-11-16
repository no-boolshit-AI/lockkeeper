import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, loadEnvFile, parseConfig } from '../../src/config/load.js';
import { DEFAULT_PROTECTED_PATHS, projectSettings, resolveRepo } from '../../src/config/schema.js';
import { readSecrets, requireSecrets } from '../../src/config/secrets.js';
import { ConfigError } from '../../src/core/errors.js';

const PRD_EXAMPLE = `
jira:
  site: acme.atlassian.net
  trigger: 'labels = agent'
  allow_users: [maria@acme.com, tech-leads]
projects:
  SHOP:
    repo: acme/shop
    base_branch: main
agent:
  use: claude-code
limits:
  cost_usd: 10
  minutes: 45
  fix_rounds: 2
  max_added_lines: 500
repo:
  setup: npm ci
  verify: [npm run lint, npm test]
  protected_paths: ['.github/**', 'CODEOWNERS', 'AGENTS.md']
`;

describe('config', () => {
  it('accepts the example from the PRD and fills in defaults', () => {
    const config = parseConfig(PRD_EXAMPLE);
    expect(config.jira.labels).toEqual({
      trigger: 'agent',
      working: 'agent-working',
      needs_info: 'agent-needs-info',
      in_review: 'agent-in-review',
      failed: 'agent-failed',
    });
    expect(config.limits.turns).toBe(150);
    expect(config.agent.key_injection).toBe('egress');
    expect(config.sandbox.allow_domains).toEqual([]);
    expect(config.repo.setup).toEqual(['npm ci']);
  });

  it('normalises the site and names every bad field', () => {
    expect(
      parseConfig('jira:\n  site: https://acme.atlassian.net/\nprojects:\n  A1:\n    repo: a/b\n')
        .jira.site,
    ).toBe('acme.atlassian.net');
    try {
      parseConfig('jira: {}\nprojects:\n  shop:\n    repo: nope\nlimits:\n  cost_usd: -1\n');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).toContain('jira.site');
      expect(message).toContain('projects.shop');
      expect(message).toContain('limits.cost_usd');
    }
  });

  it('treats empty sections as not set', () => {
    const config = parseConfig(
      'jira:\n  site: a.atlassian.net\ngithub:\nsandbox:\nprojects:\n  A1:\n    repo: a/b\n',
    );
    expect(config.github).toEqual({});
    expect(config.sandbox.provider).toBe('e2b');
  });

  it('rejects invalid YAML clearly', () => {
    expect(() => parseConfig('jira: [')).toThrow(/not valid YAML/);
  });

  it('applies project overrides over the shared repo block', () => {
    const config = parseConfig(
      `${PRD_EXAMPLE}\n`.replace(
        '    base_branch: main',
        '    base_branch: develop\n    verify: [make test]',
      ),
    );
    const settings = projectSettings(config, 'SHOP');
    expect(settings).toMatchObject({
      repo: 'acme/shop',
      baseBranch: 'develop',
      setup: ['npm ci'],
      verify: ['make test'],
    });
    expect(projectSettings(config, 'NOPE')).toBeUndefined();
    const bare = parseConfig('jira:\n  site: a.atlassian.net\nprojects:\n  A1:\n    repo: a/b\n');
    expect(projectSettings(bare, 'A1')).toMatchObject({
      setup: undefined,
      verify: undefined,
      protectedPaths: [...DEFAULT_PROTECTED_PATHS],
    });
  });

  it('resolves the repository from components and labels, or asks', () => {
    const project = parseConfig(
      'jira:\n  site: a.atlassian.net\nprojects:\n  A1:\n    repo: a/default\n    components: { Payments: a/payments }\n    labels: { web: a/web }\n',
    ).projects.A1;
    if (!project) throw new Error('missing project');
    expect(resolveRepo(project, { components: [], labels: [] })).toEqual({ repo: 'a/default' });
    expect(resolveRepo(project, { components: ['Payments'], labels: [] })).toEqual({
      repo: 'a/payments',
    });
    expect(resolveRepo(project, { components: ['Payments'], labels: ['web'] })).toEqual({
      ambiguous: ['a/payments', 'a/web'],
    });
  });
});

describe('loading from disk and the environment', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('resolves relative paths against the config file and loads .lockkeeper/.env without overriding', () => {
    dir = mkdtempSync(join(tmpdir(), 'lockkeeper-config-'));
    writeFileSync(join(dir, 'lockkeeper.yml'), PRD_EXAMPLE);
    mkdirSync(join(dir, '.lockkeeper'));
    writeFileSync(
      join(dir, '.lockkeeper', '.env'),
      'LOCKKEEPER_JIRA_TOKEN=from-file\nE2B_API_KEY=from-file\n',
    );
    const loaded = loadConfig(undefined, dir);
    expect(loaded.config.store.path).toBe(join(dir, '.lockkeeper', 'lockkeeper.db'));
    const env: NodeJS.ProcessEnv = { E2B_API_KEY: 'from-env' };
    loadEnvFile(dir, env);
    expect(env).toEqual({ E2B_API_KEY: 'from-env', LOCKKEEPER_JIRA_TOKEN: 'from-file' });
  });

  it('keeps lockkeeper.example.yml valid', () => {
    const loaded = loadConfig('lockkeeper.example.yml');
    expect(Object.keys(loaded.config.projects)).toEqual(['SHOP']);
    expect(loaded.config.agent.key_injection).toBe('egress');
  });

  it('explains a missing config file', () => {
    expect(() => loadConfig('missing.yml', tmpdir())).toThrow(/No config file/);
  });

  it('reports which credentials are missing and how to set them', () => {
    const config = parseConfig(PRD_EXAMPLE);
    const result = readSecrets(config, {
      LOCKKEEPER_JIRA_TOKEN: 't',
      LOCKKEEPER_GITHUB_PRIVATE_KEY: 'line1\\nline2',
    });
    expect(result.secrets.githubPrivateKey).toBe('line1\nline2');
    expect(result.missing.map((entry) => entry.name)).toEqual([
      'jiraEmail',
      'e2bApiKey',
      'githubAppId',
    ]);
    expect(() => requireSecrets(result, ['jiraEmail'])).toThrow(/LOCKKEEPER_JIRA_EMAIL/);
    expect(requireSecrets(result, ['jiraToken'])).toMatchObject({ jiraToken: 't' });
  });

  it('treats empty variables as unset and resolves key paths against the config folder', () => {
    dir = mkdtempSync(join(tmpdir(), 'lockkeeper-secrets-'));
    mkdirSync(join(dir, '.lockkeeper'));
    writeFileSync(join(dir, '.lockkeeper', 'app.pem'), 'PEM');
    const config = parseConfig(
      `${PRD_EXAMPLE}\n`.replace(
        '  site: acme.atlassian.net',
        '  site: acme.atlassian.net\n  email: bot@acme.com',
      ),
    );
    const result = readSecrets(
      config,
      { LOCKKEEPER_JIRA_EMAIL: '', LOCKKEEPER_GITHUB_PRIVATE_KEY_PATH: '.lockkeeper/app.pem' },
      dir,
    );
    expect(result.secrets.jiraEmail).toBe('bot@acme.com');
    expect(result.secrets.githubPrivateKey).toBe('PEM');
    const missingFile = readSecrets(
      config,
      { LOCKKEEPER_GITHUB_PRIVATE_KEY_PATH: 'nope.pem' },
      dir,
    );
    expect(missingFile.missing.find((entry) => entry.name === 'githubPrivateKey')?.how).toMatch(
      /nope\.pem does not exist/,
    );
  });
});
