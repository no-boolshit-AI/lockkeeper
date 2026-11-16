import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type InitIo, type InitServices, runInit, writeEnv } from '../../src/cli/init.js';
import { parseConfig } from '../../src/config/load.js';

/** Answers in order, and a log of what was said and opened. */
function scriptedIo(answers: string[], onOpen: (url: string) => Promise<void>) {
  const said: string[] = [];
  const asked: string[] = [];
  const opened: string[] = [];
  const pending: Promise<void>[] = [];
  const io: InitIo = {
    ask: async (question, fallback) => {
      asked.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`No answer scripted for: ${question}`);
      return answer || fallback || '';
    },
    secret: async (question) => io.ask(question),
    say: (line) => said.push(line),
    open: (url) => {
      opened.push(url);
      pending.push(onOpen(url));
    },
  };
  return { io, said, asked, opened, pending };
}

function services(stored: Record<string, string>): InitServices {
  return {
    jira: () => ({
      myself: async () => ({ displayName: 'Lockkeeper Bot' }),
      listProjects: async () => [{ key: 'SHOP', name: 'Shop' }],
    }),
    e2b: () => ({
      hasSecret: async () => false,
      putSecret: async (name, value) => {
        stored[name] = value;
        return 'created';
      },
    }),
    github: () => ({ missingPermissions: async () => [] }),
    // Only GitHub's own API goes through here; the test talks to the local page directly.
    fetch: (async (url: string | URL) => {
      const target = String(url);
      if (target === 'https://api.github.com/users/acme')
        return new Response(JSON.stringify({ type: 'Organization' }));
      if (target === 'https://api.github.com/app-manifests/code-123/conversions')
        return new Response(JSON.stringify({ id: 4242, slug: 'lockkeeper-acme', pem: 'PEM KEY' }));
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
  };
}

describe('lockkeeper init', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('creates the GitHub App through the manifest flow and writes a working config', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lockkeeper-init-'));
    let manifestPage = '';
    const stored: Record<string, string> = {};
    const script = scriptedIo(
      [
        'https://acme.atlassian.net/',
        'bot@acme.com',
        'jira-token',
        'shop',
        'acme/shop',
        '',
        'n',
        '',
        'e2b-key',
        'sk-ant-model-key',
      ],
      async (url) => {
        if (!url.startsWith('http://127.0.0.1')) return;
        // The person's browser: load the page, then GitHub's redirect back.
        manifestPage = await (await fetch(url)).text();
        const state = /state=([0-9a-f]+)/.exec(manifestPage)?.[1];
        await fetch(`${url}callback?code=code-123&state=${state}`);
      },
    );
    await runInit(script.io, services(stored), { dir });
    await Promise.all(script.pending);

    // The page posts a manifest with exactly the permissions from the PRD.
    expect(manifestPage).toContain(
      'action="https://github.com/organizations/acme/settings/apps/new?state=',
    );
    const manifest = JSON.parse(
      (/name="manifest" value="([^"]+)"/.exec(manifestPage)?.[1] ?? '').replace(/&#34;/g, '"'),
    );
    expect(manifest.default_permissions).toEqual({
      metadata: 'read',
      contents: 'write',
      pull_requests: 'write',
      checks: 'read',
      actions: 'read',
      statuses: 'read',
      issues: 'read',
    });
    expect(manifest.public).toBe(false);
    expect(script.opened).toContain('https://github.com/apps/lockkeeper-acme/installations/new');

    const config = parseConfig(readFileSync(join(dir, 'lockkeeper.yml'), 'utf8'));
    expect(config.jira.site).toBe('acme.atlassian.net');
    expect(config.projects.SHOP).toMatchObject({ repo: 'acme/shop', base_branch: 'main' });

    const env = readFileSync(join(dir, '.lockkeeper', '.env'), 'utf8');
    expect(env).toContain('LOCKKEEPER_JIRA_EMAIL=bot@acme.com');
    expect(env).toContain('LOCKKEEPER_GITHUB_APP_ID=4242');
    expect(env).toContain('E2B_API_KEY=e2b-key');
    // The model key went to E2B and nowhere on disk.
    expect(env).not.toContain('sk-ant-model-key');
    expect(stored).toEqual({ 'lockkeeper-anthropic-api-key': 'sk-ant-model-key' });
    const keyFile = join(dir, '.lockkeeper', 'github-app.pem');
    expect(readFileSync(keyFile, 'utf8')).toBe('PEM KEY');
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, '.lockkeeper', '.env')).mode & 0o777).toBe(0o600);
  });

  it('refuses to replace an existing config without --force', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lockkeeper-init-'));
    writeFileSync(join(dir, 'lockkeeper.yml'), 'jira: {}\n');
    const script = scriptedIo([], async () => {});
    await expect(runInit(script.io, services({}), { dir })).rejects.toThrow(/already exists/);
  });

  it('merges values into an existing .env, keeping other lines', () => {
    dir = mkdtempSync(join(tmpdir(), 'lockkeeper-init-'));
    const path = join(dir, '.env');
    writeFileSync(path, '# keep me\nE2B_API_KEY=old\nOTHER=1\n');
    writeEnv(path, { E2B_API_KEY: 'new', LOCKKEEPER_JIRA_EMAIL: 'a@b.c' });
    expect(readFileSync(path, 'utf8')).toBe(
      '# keep me\nE2B_API_KEY=new\nOTHER=1\nLOCKKEEPER_JIRA_EMAIL=a@b.c\n',
    );
  });
});
