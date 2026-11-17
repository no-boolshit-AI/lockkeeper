import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { describeEvent, type RunPage, startRunPage } from '../../src/web/run-page.js';

/** A GET with any Host header, which fetch does not allow setting. */
function get(
  url: string,
  host?: string,
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: host ? { host } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('the run page', () => {
  let page: RunPage | undefined;
  let store: Store | undefined;

  afterEach(async () => {
    await page?.close();
    store?.close();
    page = undefined;
    store = undefined;
  });

  function seeded() {
    store = Store.open(':memory:');
    const run = store.createRun({
      ticketKey: 'DEMO-7',
      tracker: 'jira-cloud',
      repo: 'acme/demo',
      baseBranch: 'main',
      workflow: 'feature',
      agent: 'claude-code',
      state: 'implement',
    });
    store.updateRun(run.id, {
      costUsd: 0.42,
      prUrl: 'https://github.com/acme/demo/pull/9',
      prNumber: 9,
    });
    store.appendEvent(run.id, 'state', { state: 'implement', round: 0 });
    store.appendEvent(run.id, 'agent', {
      round: 0,
      type: 'message',
      text: 'I will now <script>alert("hi")</script> the file.',
    });
    store.appendEvent(run.id, 'agent', {
      round: 0,
      type: 'tool_call',
      tool: 'Bash',
      summary: 'npm test',
    });
    store.appendEvent(run.id, 'diff', {
      text: 'diff --git a/x b/x\n+<img src=x onerror=alert(1)>\n-old line\n@@ -1 +1 @@',
    });
    return run;
  }

  it('lists runs and shows one with its log, diff and cost, all escaped', async () => {
    const run = seeded();
    page = await startRunPage({ store: store as Store, token: 'test-token' });
    expect(page.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/test-token\/$/);

    const list = await get(page.url);
    expect(list.status).toBe(200);
    expect(list.body).toContain('DEMO-7');
    expect(list.body).toContain('$0.42');

    const detail = await get(`${page.url}runs/${run.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toContain('Bash: npm test');
    expect(detail.body).toContain('&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt;');
    expect(detail.body).not.toContain('<script>alert');
    expect(detail.body).toContain('<span class="add">+&lt;img src=x onerror=alert(1)&gt;</span>');
    expect(detail.body).not.toContain('<img');
    // Only the page's own script and style run.
    expect(String(detail.headers['content-security-policy'])).toMatch(/script-src 'nonce-/);
    expect(String(detail.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('streams new log lines to the page', async () => {
    const run = seeded();
    page = await startRunPage({ store: store as Store, token: 'test-token' });
    const first = JSON.parse((await get(`${page.url}api/runs/${run.id}`)).body);
    expect(first.live).toBe(true);
    const last = first.lines.at(-1).id as number;
    store?.appendEvent(run.id, 'agent', {
      round: 0,
      type: 'tool_call',
      tool: 'Edit',
      summary: 'src/a.ts',
    });
    const next = JSON.parse((await get(`${page.url}api/runs/${run.id}?after=${last}`)).body);
    expect(next.lines.map((line: { text: string }) => line.text)).toEqual(['Edit: src/a.ts']);
  });

  it('answers nothing without its secret path or under another host name', async () => {
    seeded();
    page = await startRunPage({ store: store as Store, token: 'test-token' });
    const origin = new URL(page.url).origin;
    expect((await get(`${origin}/`)).status).toBe(404);
    expect((await get(`${origin}/api/runs`)).status).toBe(404);
    // DNS rebinding: the right address, but a name someone else controls.
    expect((await get(page.url, 'evil.example:80')).status).toBe(421);
    expect((await get(page.url, `localhost:${new URL(page.url).port}`)).status).toBe(200);
  });

  it('describes the events worth showing in plain words', () => {
    const event = (kind: string, data: unknown) => ({ id: 1, runId: 'r', ts: '', kind, data });
    expect(describeEvent(event('baseline', { failed: ['npm test'] }))).toBe(
      'Checks on the base branch: already failing: npm test',
    );
    expect(
      describeEvent(event('checks', { checks: [{ command: 'npm test', passed: false }] })),
    ).toBe('Checks: ✗ npm test');
    expect(describeEvent(event('agent', { type: 'tool_result', isError: false }))).toBeUndefined();
    expect(describeEvent(event('prompt', { round: 0 }))).toBeUndefined();
  });
});
