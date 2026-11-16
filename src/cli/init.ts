import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { LockkeeperError } from '../core/errors.js';

/**
 * `lockkeeper init` (O1): a guided setup that checks each credential as it goes and
 * ends with a working lockkeeper.yml. The GitHub App is created through GitHub's
 * manifest flow, so nobody has to copy permissions by hand. The model key goes
 * straight into E2B's secret store and is never written to disk.
 */

export interface InitIo {
  ask(question: string, fallback?: string): Promise<string>;
  /** Like ask, without echoing what is typed. */
  secret(question: string): Promise<string>;
  say(line: string): void;
  /** Try to open a URL in the browser. Printing it is enough when that fails. */
  open(url: string): void;
}

export interface InitServices {
  jira(
    site: string,
    email: string,
    token: string,
  ): {
    myself(): Promise<{ displayName?: string; accountType?: string }>;
    listProjects(): Promise<{ key: string; name: string }[]>;
  };
  e2b(apiKey: string): {
    hasSecret(name: string): Promise<boolean>;
    putSecret(name: string, value: string): Promise<'created' | 'updated'>;
  };
  /** Checks an App's access to a repository: the permissions it lacks. */
  github(
    appId: string,
    privateKey: string,
  ): { missingPermissions(repo: string): Promise<string[]> };
  fetch: typeof fetch;
}

export interface InitOptions {
  /** Where lockkeeper.yml and .lockkeeper/ go. */
  dir: string;
  force?: boolean;
  /** Port for the manifest flow's callback; 0 picks a free one. */
  port?: number;
}

const SECRET_NAME = 'lockkeeper-anthropic-api-key';
const PERMISSIONS = {
  metadata: 'read',
  contents: 'write',
  pull_requests: 'write',
  checks: 'read',
  actions: 'read',
  statuses: 'read',
  issues: 'read',
};

export async function runInit(
  io: InitIo,
  services: InitServices,
  options: InitOptions,
): Promise<void> {
  const configPath = join(options.dir, 'lockkeeper.yml');
  if (existsSync(configPath) && !options.force) {
    throw new LockkeeperError(
      `${configPath} already exists.`,
      'Run `lockkeeper doctor` to check it, or `lockkeeper init --force` to start over.',
    );
  }
  const env: Record<string, string> = {};

  // Jira
  io.say('Jira: Lockkeeper reads tickets and comments as one Jira account.');
  const site = (await io.ask('Jira site, such as acme.atlassian.net'))
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  const email = (await io.ask('Email of the Jira account Lockkeeper uses')).trim();
  io.say('Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens');
  const token = (await io.secret('Jira API token')).trim();
  const jira = services.jira(site, email, token);
  const me = await jira.myself().catch((error: Error) => {
    throw new LockkeeperError(
      `Jira did not accept those details: ${error.message}`,
      'Check the site, email and token.',
    );
  });
  io.say(`✓ Signed in to Jira as ${me.displayName ?? email}.`);
  env.LOCKKEEPER_JIRA_EMAIL = email;
  env.LOCKKEEPER_JIRA_TOKEN = token;

  const available = await jira.listProjects();
  if (available.length > 0)
    io.say(
      `Projects: ${available.map((project) => `${project.key} (${project.name})`).join(', ')}`,
    );
  const keys = (await io.ask('Project keys Lockkeeper should work in, separated by commas'))
    .split(',')
    .map((key) => key.trim().toUpperCase())
    .filter(Boolean);
  if (keys.length === 0) throw new LockkeeperError('At least one project is needed.');
  const projects: { key: string; repo: string; base: string }[] = [];
  for (const key of keys) {
    const repo = (await io.ask(`GitHub repository for ${key}, as owner/name`)).trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
      throw new LockkeeperError(`Not a repository: ${repo}`, 'Use owner/name, such as acme/shop.');
    const base = (await io.ask(`Base branch in ${repo}`, 'main')).trim() || 'main';
    projects.push({ key, repo, base });
  }

  // GitHub App
  io.say('\nGitHub: Lockkeeper acts as a GitHub App with seven repository permissions.');
  const owner = (projects[0]?.repo ?? '').split('/')[0] ?? '';
  const existing = (await io.ask('Do you already have a GitHub App for Lockkeeper? (y/N)', 'n'))
    .trim()
    .toLowerCase();
  let appId: string;
  let privateKey: string;
  let slug: string | undefined;
  const keyPath = join(options.dir, '.lockkeeper', 'github-app.pem');
  if (existing.startsWith('y')) {
    appId = (await io.ask('App ID')).trim();
    const path = (await io.ask('Path to its private key (.pem)')).trim();
    privateKey = readFileSync(path, 'utf8');
  } else {
    const app = await createGitHubApp(io, services.fetch, { owner, port: options.port ?? 0 });
    appId = String(app.id);
    privateKey = app.pem;
    slug = app.slug;
    io.say(`✓ Created the GitHub App ${app.slug}.`);
  }
  mkdirSync(join(options.dir, '.lockkeeper'), { recursive: true });
  writeFileSync(keyPath, privateKey, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  env.LOCKKEEPER_GITHUB_APP_ID = appId;
  env.LOCKKEEPER_GITHUB_PRIVATE_KEY_PATH = '.lockkeeper/github-app.pem';
  if (slug) {
    const install = `https://github.com/apps/${slug}/installations/new`;
    io.say(`Install it on ${projects.map((project) => project.repo).join(', ')}: ${install}`);
    io.say('Choose "Only select repositories" and pick just those.');
    io.open(install);
    await io.ask('Press Enter once it is installed');
  }
  const github = services.github(appId, privateKey);
  for (const project of projects) {
    try {
      const missing = await github.missingPermissions(project.repo);
      io.say(
        missing.length === 0
          ? `✓ The App can work in ${project.repo}.`
          : `! The App lacks ${missing.join(', ')} on ${project.repo}. Accept the permissions on the installation.`,
      );
    } catch (error) {
      io.say(
        `! ${(error as Error).message} ${error instanceof LockkeeperError && error.hint ? error.hint : ''}`.trim(),
      );
    }
  }

  // E2B and the model key
  io.say('\nE2B: each run gets its own sandbox. Create an API key at https://e2b.dev/dashboard');
  const e2bKey = (await io.secret('E2B API key')).trim();
  const e2b = services.e2b(e2bKey);
  await e2b.hasSecret(SECRET_NAME).catch((error: Error) => {
    throw new LockkeeperError(
      `E2B did not accept the key: ${error.message}`,
      'Copy the key again from the E2B dashboard.',
    );
  });
  io.say('✓ E2B accepted the key.');
  env.E2B_API_KEY = e2bKey;
  io.say(
    "\nAnthropic: the key goes into E2B's secret store and never into a sandbox or onto disk.",
  );
  const modelKey = (await io.secret('Anthropic API key')).trim();
  if (modelKey) {
    await e2b.putSecret(SECRET_NAME, modelKey);
    io.say(`✓ Stored as the E2B secret ${SECRET_NAME}.`);
  } else {
    io.say(
      '! Skipped. Run `lockkeeper secrets sync` with ANTHROPIC_API_KEY set before the first run.',
    );
  }

  writeEnv(join(options.dir, '.lockkeeper', '.env'), env);
  writeFileSync(configPath, configYaml(site, projects));
  io.say(`\n✓ Wrote ${configPath} and .lockkeeper/.env (readable only by you).`);
  io.say(
    'Next: `lockkeeper doctor` checks everything with a real sandbox, then `lockkeeper start`.',
  );
}

/** Merge values into .lockkeeper/.env, keeping other lines, readable only by the owner. */
export function writeEnv(path: string, values: Record<string, string>): void {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  const seen = new Set<string>();
  const updated = lines.map((line) => {
    const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];
    if (!key || !(key in values)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });
  while (updated.length > 0 && updated.at(-1)?.trim() === '') updated.pop();
  for (const [key, value] of Object.entries(values))
    if (!seen.has(key)) updated.push(`${key}=${value}`);
  const text = `${updated.join('\n')}\n`;
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function configYaml(
  site: string,
  projects: { key: string; repo: string; base: string }[],
): string {
  const blocks = projects
    .map(
      (project) => `  ${project.key}:\n    repo: ${project.repo}\n    base_branch: ${project.base}`,
    )
    .join('\n');
  return `# Written by lockkeeper init. See lockkeeper.example.yml for every setting.
jira:
  site: ${site}
  trigger: "labels = agent"
  # Who may start or stop runs: emails, account IDs or group names. Empty means anyone
  # in your Jira organisation.
  allow_users: []

projects:
${blocks}

agent:
  use: claude-code
  key_injection: egress

limits:
  cost_usd: 10
  minutes: 45
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * GitHub's manifest flow: a page on 127.0.0.1 posts the App's manifest to GitHub, the
 * person clicks Create, and GitHub sends a one-time code back to the page's callback.
 * The code is exchanged for the App's ID and private key.
 */
export async function createGitHubApp(
  io: InitIo,
  fetchImpl: typeof fetch,
  input: { owner: string; port: number },
): Promise<{ id: number; slug: string; pem: string }> {
  const ownerInfo = await fetchImpl(
    `https://api.github.com/users/${encodeURIComponent(input.owner)}`,
    {
      headers: { Accept: 'application/vnd.github+json' },
    },
  );
  const ownerType = ownerInfo.ok ? ((await ownerInfo.json()) as { type?: string }).type : undefined;
  const state = randomBytes(16).toString('hex');
  let resolveCode: (code: string) => void = () => {};
  const codePromise = new Promise<string>((resolve) => {
    resolveCode = resolve;
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      if (url.searchParams.get('state') !== state || !code) {
        response
          .writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end('This link is not from this setup.');
        return;
      }
      response
        .writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('The GitHub App is created. You can close this tab and go back to the terminal.');
      resolveCode(code);
      return;
    }
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : input.port;
    const manifest = {
      name: `Lockkeeper ${input.owner}`.slice(0, 34),
      url: 'https://github.com/no-boolshit-AI/lockkeeper',
      redirect_url: `http://127.0.0.1:${port}/callback`,
      public: false,
      default_permissions: PERMISSIONS,
      default_events: [],
    };
    const action =
      ownerType === 'Organization'
        ? `https://github.com/organizations/${encodeURIComponent(input.owner)}/settings/apps/new?state=${state}`
        : `https://github.com/settings/apps/new?state=${state}`;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html>
<meta charset="utf-8"><title>Create the Lockkeeper GitHub App</title>
<p>Sending you to GitHub to create the Lockkeeper App…</p>
<form id="manifest" method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Continue to GitHub</button></form>
<script>document.getElementById('manifest').submit();</script>`);
  });
  await new Promise<void>((resolve) => server.listen(input.port, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : input.port;
    const start = `http://127.0.0.1:${port}/`;
    io.say(
      `Open ${start} to create the App. GitHub asks you to confirm, then sends you back here.`,
    );
    io.open(start);
    const code = await codePromise;
    const conversion = await fetchImpl(
      `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
      {
        method: 'POST',
        headers: { Accept: 'application/vnd.github+json' },
      },
    );
    if (!conversion.ok) {
      throw new LockkeeperError(
        `GitHub did not finish creating the App (HTTP ${conversion.status}).`,
        'Run `lockkeeper init` again. The code from GitHub is valid for one hour.',
      );
    }
    const app = (await conversion.json()) as { id: number; slug: string; pem: string };
    return { id: app.id, slug: app.slug, pem: app.pem };
  } finally {
    server.close();
  }
}
